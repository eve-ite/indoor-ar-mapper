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

# Lets the static pages live on another host later (GitHub/Cloudflare Pages).
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


def summarize(path: Path) -> dict:
    header, frames, points = None, 0, 0
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
    return {
        "id": path.stem,
        "created": (header or {}).get("created"),
        "device": (header or {}).get("device"),
        # scan chaining: this scan started where `continues` ended (same floor mark)
        "continues": (header or {}).get("continues"),
        "chain": (header or {}).get("chain"),
        "frames": frames,
        "points": points,
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


# M3: WebSocket relay for car drive commands goes here (ESP32 dials out to the tunnel via wss://).


@app.get("/")
def index():
    return RedirectResponse("/scan/")


app.mount("/", StaticFiles(directory=WEB_DIR, html=True), name="web")
