"""Maps: a map is one location, made of one or more scans.

Where maps come from (merged in GET /api/maps):
  1. the scan app: each scan's header has "map": {"id", "name"} (picked on the phone)
  2. legacy chains: scans linked by "continues" but without a map -> id "chain-<root>"
  3. the viewer: scans/maps.json holds maps made by grouping scans, plus renames of any map

A map's scans are placed by the viewer (web/common/chain.js mergeMap): a scan continuing another
in the map starts at that scan's end pose; any other scan started on the map's start marker.
"""

import json
import re
import secrets
from datetime import datetime, timezone
from pathlib import Path

from fastapi import APIRouter, HTTPException, Request

router = APIRouter()
SAFE_ID = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
SCANS_DIR: Path = Path(".")  # set by main.py


def init(scans_dir: Path):
    global SCANS_DIR
    SCANS_DIR = scans_dir


def _registry_path() -> Path:
    return SCANS_DIR / "maps.json"


def _load_registry() -> list:
    p = _registry_path()
    try:
        data = json.loads(p.read_text(encoding="utf-8")) if p.exists() else []
        return data if isinstance(data, list) else []
    except (json.JSONDecodeError, OSError):
        return []


def _save_registry(reg: list):
    _registry_path().write_text(json.dumps(reg, indent=1), encoding="utf-8")


def _headers() -> dict:
    """session id -> header (first JSONL line) for every scan file."""
    out = {}
    for p in SCANS_DIR.glob("*.jsonl"):
        try:
            with p.open(encoding="utf-8") as f:
                h = json.loads(f.readline())
            if h.get("type") == "header":
                out[p.stem] = h
        except (json.JSONDecodeError, OSError):
            continue
    return out


def _simulated(h: dict) -> bool:
    return bool(h.get("simulated")) or h.get("device") == "synthetic"


def list_maps() -> list:
    headers = _headers()
    maps: dict = {}

    def entry(mid, name, source):
        return maps.setdefault(mid, {"id": mid, "name": name, "scans": [], "links": {}, "source": source})

    # 1. maps declared by the scan app
    for sid, h in headers.items():
        m = h.get("map")
        if isinstance(m, dict) and SAFE_ID.match(str(m.get("id", ""))):
            entry(m["id"], str(m.get("name") or m["id"])[:80], "app")["scans"].append(sid)

    # 2. legacy chains: follow "continues" back to the root
    def root_of(sid):
        seen = set()
        while headers.get(sid, {}).get("continues") in headers and sid not in seen:
            seen.add(sid)
            sid = headers[sid]["continues"]
        return sid

    has_child = {h.get("continues") for h in headers.values()}
    for sid, h in headers.items():
        if h.get("map") or not (h.get("continues") or sid in has_child):
            continue
        root = root_of(sid)
        entry(f"chain-{root}", f"Chain {root}", "chain")["scans"].append(sid)

    # 3. viewer-made maps and renames
    for r in _load_registry():
        mid = r.get("id")
        if not isinstance(mid, str) or not SAFE_ID.match(mid):
            continue
        if r.get("scans") is not None:
            e = entry(mid, r.get("name") or mid, "viewer")
            # the viewer's list, plus later scans that name this map themselves (e.g. nav walks)
            own = [s for s, h in headers.items() if isinstance(h.get("map"), dict) and h["map"].get("id") == mid]
            e["scans"] = [s for s in r["scans"] if s in headers] + own
            e["links"] = {k: v for k, v in (r.get("links") or {}).items() if k in headers and v in headers}
        elif mid in maps and r.get("name"):
            maps[mid]["name"] = r["name"]  # rename of an app/chain map
        if mid in maps and r.get("name"):
            maps[mid]["name"] = r["name"]

    out = []
    for m in maps.values():
        m["scans"] = sorted(set(m["scans"]), key=lambda s: headers[s].get("created") or "")
        if not m["scans"]:
            continue
        m["simulated"] = all(_simulated(headers[s]) for s in m["scans"])
        m["updated"] = max(headers[s].get("created") or "" for s in m["scans"])
        out.append(m)
    return sorted(out, key=lambda m: m["updated"], reverse=True)


@router.get("/api/maps")
def get_maps():
    return list_maps()


def _check_scans(scans) -> list:
    headers = _headers()
    if not isinstance(scans, list) or not scans or len(scans) > 200:
        raise HTTPException(400, "scans must be a non-empty list")
    if not all(isinstance(s, str) and s in headers for s in scans):
        raise HTTPException(400, "unknown scan id")
    return scans


@router.post("/api/maps")
async def create_map(request: Request):
    """Group existing scans into a map: {name, scans: [ids, oldest first], chain_in_order: bool}.
    chain_in_order links each scan to the previous one (they were scanned end-to-start)."""
    body = await _json(request)
    name = str(body.get("name") or "").strip()[:80]
    if not name:
        raise HTTPException(400, "name required")
    scans = _check_scans(body.get("scans"))
    links = {scans[k]: scans[k - 1] for k in range(1, len(scans))} if body.get("chain_in_order") else {}
    mid = "m-" + secrets.token_hex(4)
    reg = _load_registry()
    reg.append({"id": mid, "name": name, "scans": scans, "links": links, "created": datetime.now(timezone.utc).isoformat()})
    _save_registry(reg)
    return {"id": mid}


@router.put("/api/maps/{map_id}")
async def update_map(map_id: str, request: Request):
    """Rename any map ({name}), or change a viewer map's scans/links."""
    if not SAFE_ID.match(map_id):
        raise HTTPException(400, "bad id")
    body = await _json(request)
    reg = _load_registry()
    r = next((x for x in reg if x.get("id") == map_id), None)
    if r is None:
        r = {"id": map_id}
        reg.append(r)
    if "name" in body:
        name = str(body["name"] or "").strip()[:80]
        if not name:
            raise HTTPException(400, "name required")
        r["name"] = name
    if "scans" in body:
        r["scans"] = _check_scans(body["scans"])
    if "links" in body:
        if not isinstance(body["links"], dict):
            raise HTTPException(400, "links must be an object")
        r["links"] = {str(k): str(v) for k, v in body["links"].items()}
    _save_registry(reg)
    return {"id": map_id}


async def _json(request: Request) -> dict:
    try:
        body = json.loads(await request.body())
    except json.JSONDecodeError:
        raise HTTPException(400, "not JSON")
    if not isinstance(body, dict):
        raise HTTPException(400, "expected an object")
    return body
