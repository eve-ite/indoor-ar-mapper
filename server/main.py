"""Indoor AR Mapper server: scan uploads + static phone/viewer pages.

Run from server/:  uv run uvicorn main:app --port 8000
Phone access (no hotspot, venue wifi):  cloudflared tunnel --url http://localhost:8000 --protocol http2
"""

import json
import re
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, RedirectResponse
from fastapi.staticfiles import StaticFiles

ROOT = Path(__file__).resolve().parent.parent
WEB_DIR = ROOT / "web"
SCANS_DIR = ROOT / "scans"
SCANS_DIR.mkdir(exist_ok=True)

MAX_UPLOAD_BYTES = 200 * 1024 * 1024
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")

app = FastAPI(title="Indoor AR Mapper")

import maps  # noqa: E402  (maps of locations: /api/maps)

maps.init(SCANS_DIR)
app.include_router(maps.router)

# Lets the static pages live on another host later (GitHub/Cloudflare Pages).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def summarize(path: Path) -> dict:
    header, frames, points, keyframes = None, 0, 0, 0
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue  # truncated tail line from a crash
            if obj.get("type") == "header":
                header = obj
            elif obj.get("type") == "frame":
                frames += 1
                points += len(obj.get("pts") or []) + len(obj.get("dpts") or [])
            elif obj.get("type") == "keyframe":
                keyframes += 1
    return {
        "id": path.stem,
        "created": (header or {}).get("created"),
        "device": (header or {}).get("device"),
        # scan chaining: this scan started where `continues` ended (same floor mark)
        # simulated = made by tools/make_synthetic.py (device "synthetic"), not a phone
        "simulated": bool((header or {}).get("simulated")) or (header or {}).get("device") == "synthetic",
        "continues": (header or {}).get("continues"),
        "chain": (header or {}).get("chain"),
        "frames": frames,
        "points": points,
        "keyframes": keyframes,
        "bytes": path.stat().st_size,
    }


@app.post("/api/scans")
async def upload_scan(request: Request):
    body = await request.body()
    if len(body) > MAX_UPLOAD_BYTES:
        raise HTTPException(413, "scan too large")
    text = body.decode("utf-8", errors="replace")
    first, _, _ = text.partition("\n")
    try:
        header = json.loads(first)
    except json.JSONDecodeError:
        raise HTTPException(400, "first line is not JSON")
    if header.get("type") != "header":
        raise HTTPException(400, "first line must be a header")
    session_id = str(header.get("session_id", ""))
    if not SAFE_ID.match(session_id):
        raise HTTPException(400, "bad session_id")
    path = SCANS_DIR / f"{session_id}.jsonl"
    path.write_bytes(body)  # bytes, so Windows doesn't rewrite \n -> \r\n; a retried upload overwrites
    return summarize(path)


@app.get("/api/scans")
def list_scans():
    files = sorted(SCANS_DIR.glob("*.jsonl"), key=lambda p: p.stat().st_mtime, reverse=True)
    return [summarize(p) for p in files]


@app.get("/api/scans/{scan_id}")
def get_scan(scan_id: str):
    if not SAFE_ID.match(scan_id):
        raise HTTPException(400, "bad id")
    path = SCANS_DIR / f"{scan_id}.jsonl"
    if not path.exists():
        raise HTTPException(404, "no such scan")
    return FileResponse(path, media_type="application/x-ndjson")


# ---- labels added in the viewer: scans/<id>_labels.json, in that scan's (chain root's) coordinates ----
@app.get("/api/scans/{scan_id}/labels")
def get_labels(scan_id: str):
    if not SAFE_ID.match(scan_id):
        raise HTTPException(400, "bad id")
    path = SCANS_DIR / f"{scan_id}_labels.json"
    return json.loads(path.read_text(encoding="utf-8")) if path.exists() else []


@app.put("/api/scans/{scan_id}/labels")
async def put_labels(scan_id: str, request: Request):
    if not SAFE_ID.match(scan_id):
        raise HTTPException(400, "bad id")
    try:
        labels = json.loads(await request.body())
    except json.JSONDecodeError:
        raise HTTPException(400, "not JSON")
    ok = isinstance(labels, list) and len(labels) <= 500 and all(
        isinstance(l, dict) and isinstance(l.get("name"), str) and 0 < len(l["name"]) <= 80
        and isinstance(l.get("p"), list) and len(l["p"]) == 3 and all(isinstance(v, (int, float)) for v in l["p"])
        for l in labels
    )
    if not ok:
        raise HTTPException(400, "expected [{name, p:[x,y,z]}]")
    (SCANS_DIR / f"{scan_id}_labels.json").write_text(json.dumps(labels), encoding="utf-8")
    return {"saved": len(labels)}
# ---- camera keyframes (textures branch): scans/<id>_kf/kf_0000.jpg, one PUT per photo ----
SAFE_KF = re.compile(r"^kf_\d{4,6}\.(jpg|png)$")


def kf_dir(scan_id: str) -> Path:
    if not SAFE_ID.match(scan_id):
        raise HTTPException(400, "bad id")
    return SCANS_DIR / f"{scan_id}_kf"


@app.put("/api/scans/{scan_id}/kf/{name}")
async def put_keyframe(scan_id: str, name: str, request: Request):
    if not SAFE_KF.match(name):
        raise HTTPException(400, "bad keyframe name")
    body = await request.body()
    if len(body) > 10 * 1024 * 1024:
        raise HTTPException(413, "photo too large")
    folder = kf_dir(scan_id)
    folder.mkdir(exist_ok=True)
    (folder / name).write_bytes(body)  # idempotent: re-sends overwrite
    return {"saved": name, "bytes": len(body)}


@app.get("/api/scans/{scan_id}/kf")
def list_keyframes(scan_id: str):
    folder = kf_dir(scan_id)
    return sorted(p.name for p in folder.glob("kf_*")) if folder.exists() else []


@app.get("/api/scans/{scan_id}/kf/{name}")
def get_keyframe(scan_id: str, name: str):
    if not SAFE_KF.match(name):
        raise HTTPException(400, "bad keyframe name")
    path = kf_dir(scan_id) / name
    if not path.exists():
        raise HTTPException(404, "no such photo")
    return FileResponse(path, media_type="image/png" if name.endswith(".png") else "image/jpeg")


def pose_matrix(p, q):
    """Camera-to-world 4x4, row-major, from position + quaternion [x, y, z, w]."""
    x, y, z, w = q
    return [
        [1 - 2 * (y * y + z * z), 2 * (x * y - w * z), 2 * (x * z + w * y), p[0]],
        [2 * (x * y + w * z), 1 - 2 * (x * x + z * z), 2 * (y * z - w * x), p[1]],
        [2 * (x * z - w * y), 2 * (y * z + w * x), 1 - 2 * (x * x + y * y), p[2]],
        [0.0, 0.0, 0.0, 1.0],
    ]


@app.get("/api/scans/{scan_id}/nerfstudio.zip")
def export_nerfstudio(scan_id: str):
    """nerfstudio-style transforms.json + images/ for Gaussian splatting on a laptop GPU.

    WebXR view poses are camera-to-world with the camera looking down -Z and +Y up, which is the
    OpenGL/Blender convention transforms.json uses, so matrices go in as-is (only transposed to
    row-major). World is local-floor (Y up); nerfstudio re-orients/centres on load.
    """
    import io
    import zipfile

    from fastapi.responses import Response

    path = SCANS_DIR / f"{scan_id}.jsonl"
    folder = kf_dir(scan_id)
    if not path.exists():
        raise HTTPException(404, "no such scan")
    frames = []
    with path.open(encoding="utf-8") as f:
        for line in f:
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            if obj.get("type") != "keyframe" or not (folder / obj.get("img", "")).exists():
                continue
            k = obj["intrinsics"]
            frames.append({
                "file_path": f"images/{obj['img']}",
                "transform_matrix": pose_matrix(obj["p"], obj["q"]),
                "fl_x": k["fx"], "fl_y": k["fy"], "cx": k["cx"], "cy": k["cy"], "w": int(k["w"]), "h": int(k["h"]),
            })
    if not frames:
        raise HTTPException(404, "scan has no uploaded keyframes")
    first = frames[0]
    transforms = {
        "camera_model": "OPENCV",
        **{k: first[k] for k in ("fl_x", "fl_y", "cx", "cy", "w", "h")},
        "k1": 0.0, "k2": 0.0, "p1": 0.0, "p2": 0.0,
        "frames": frames,
    }
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_STORED) as z:  # JPEGs don't compress further
        z.writestr("transforms.json", json.dumps(transforms, indent=1))
        for fr in frames:
            z.write(folder / fr["file_path"].split("/", 1)[1], fr["file_path"])
    return Response(
        buf.getvalue(),
        media_type="application/zip",
        headers={"Content-Disposition": f'attachment; filename="{scan_id}_nerfstudio.zip"'},
    )


CAMTEST_DIR = SCANS_DIR / "camtest"
SAFE_FILE = re.compile(r"^[A-Za-z0-9_-]{1,64}\.(json|jpg)$")


@app.put("/api/camtest/{run_id}/{name}")
async def put_camtest(run_id: str, name: str, request: Request):
    """Textures exploration: /camtest/ page results (report.json + keyframe JPEGs)."""
    if not SAFE_ID.match(run_id) or not SAFE_FILE.match(name):
        raise HTTPException(400, "bad name")
    body = await request.body()
    if len(body) > 20 * 1024 * 1024:
        raise HTTPException(413, "too large")
    folder = CAMTEST_DIR / run_id
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_bytes(body)
    return {"saved": f"{run_id}/{name}", "bytes": len(body)}


# M3: car relay (/car, /drive WebSockets) and the /teleop page; see car_relay.py.
from car_relay import install as install_car  # noqa: E402

install_car(app, ROOT)


@app.get("/")
def index():
    return RedirectResponse("/scan/")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
