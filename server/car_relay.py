"""M3 car relay: browsers drive the car over WebSockets through this server.

  /car    the ESP32 (or car/mock_car.py) connects here; sends telemetry, receives drive commands
  /drive  teleop browsers connect here; send drive commands, receive telemetry + car status
  /teleop the teleop page (car/teleop/)

Drive commands are latest-command-wins: if the car link is slow, older commands are dropped,
never queued. Safety lives on the car (300 ms deadman, ultrasonic forward block); the server
only adds a courtesy stop when the browser that last drove disconnects.

On venue wifi the car dials *out* to the cloudflared tunnel (wss://<tunnel>/car), so no LAN
reachability or hotspot is needed. Plain ws://<laptop-ip>:8000/car works on a home network.
"""

import asyncio
import json
import math
import time
from pathlib import Path

from fastapi import APIRouter, FastAPI, WebSocket, WebSocketDisconnect
from fastapi.staticfiles import StaticFiles

router = APIRouter()


def _clamp(x, lo=-1.0, hi=1.0) -> float:
    try:
        x = float(x)
    except (TypeError, ValueError):
        return 0.0
    if not math.isfinite(x):
        return 0.0
    return max(lo, min(hi, x))


class Relay:
    def __init__(self) -> None:
        self.car: WebSocket | None = None
        self.drivers: set[WebSocket] = set()
        self.latest: dict | None = None  # newest drive command not yet sent to the car
        self.wake = asyncio.Event()
        self.last_driver: WebSocket | None = None
        self.seq = 0

    async def broadcast(self, msg: dict) -> None:
        text = json.dumps(msg)
        dead = []
        for d in list(self.drivers):
            try:
                await d.send_text(text)
            except Exception:
                dead.append(d)
        for d in dead:
            self.drivers.discard(d)

    def queue_drive(self, v: float, w: float, seq: int | None = None) -> None:
        self.seq += 1
        self.latest = {"type": "drive", "v": v, "w": w, "seq": self.seq if seq is None else seq}
        self.wake.set()

    async def car_sender(self, car: WebSocket) -> None:
        while self.car is car:
            await self.wake.wait()
            self.wake.clear()
            cmd, self.latest = self.latest, None
            if cmd is not None and self.car is car:
                await car.send_text(json.dumps(cmd))

    def status(self) -> dict:
        return {"type": "car_status", "connected": self.car is not None, "server_time": time.time()}


relay = Relay()


@router.websocket("/car")
async def car_endpoint(ws: WebSocket):
    await ws.accept()
    old, relay.car = relay.car, ws
    if old is not None:  # a reconnecting car replaces a stale connection
        try:
            await old.close(code=4000, reason="replaced by a new car connection")
        except Exception:
            pass
    relay.latest = None
    sender = asyncio.create_task(relay.car_sender(ws))
    await relay.broadcast(relay.status())
    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "telemetry":
                await relay.broadcast(msg)
    except WebSocketDisconnect:
        pass
    finally:
        sender.cancel()
        if relay.car is ws:
            relay.car = None
            relay.wake.set()
            await relay.broadcast(relay.status())


@router.websocket("/drive")
async def drive_endpoint(ws: WebSocket):
    await ws.accept()
    relay.drivers.add(ws)
    await ws.send_text(json.dumps(relay.status()))
    try:
        while True:
            text = await ws.receive_text()
            try:
                msg = json.loads(text)
            except json.JSONDecodeError:
                continue
            if isinstance(msg, dict) and msg.get("type") == "set" and relay.car is not None:
                # Live tuning (e.g. max_step_rate): forwarded as-is; the car clamps the values.
                await relay.car.send_text(json.dumps(msg))
                continue
            if not isinstance(msg, dict) or msg.get("type") != "drive":
                continue
            relay.last_driver = ws
            seq = msg.get("seq")
            relay.queue_drive(_clamp(msg.get("v")), _clamp(msg.get("w")), seq if isinstance(seq, int) else None)
    except WebSocketDisconnect:
        pass
    finally:
        relay.drivers.discard(ws)
        # Courtesy stop: the browser that was driving went away (the car's deadman is the real guard).
        if relay.last_driver is ws:
            relay.last_driver = None
            relay.queue_drive(0.0, 0.0)


def install(app: FastAPI, root: Path) -> None:
    """Add the car routes. Must run before the catch-all static mount at "/"."""
    app.include_router(router)
    app.mount("/teleop", StaticFiles(directory=root / "car" / "teleop", html=True), name="teleop")
