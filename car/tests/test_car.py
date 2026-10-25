"""End-to-end checks for M3 with no hardware: real server + mock car + a scripted driver.

  server/.venv/Scripts/python car/tests/test_car.py      (from the repo root)

Covers the "done when" list: the mock moves under drive commands, it stops within ~300 ms when
the driving browser closes, freezes, or the server is killed, the forward block under 15 cm
holds (reverse/turn still allowed), the browser hears about car disconnects, and M1/M2 pages
still load.
"""

import asyncio
import json
import os
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

import websockets

ROOT = Path(__file__).resolve().parents[2]
PY = sys.executable
PORT = int(os.environ.get("CAR_TEST_PORT", "8790"))
HTTP = f"http://127.0.0.1:{PORT}"
WS = f"ws://127.0.0.1:{PORT}"
STOP_BUDGET_S = 0.35  # 300 ms deadman + sim tick + scheduling slack

results: list[tuple[str, bool, str]] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    results.append((name, ok, detail))
    print(f"{'PASS' if ok else 'FAIL'}  {name}  {detail}", flush=True)


class Proc:
    """Subprocess whose stdout JSON event lines are collected with arrival times."""

    def __init__(self, args, cwd=ROOT):
        self.p = subprocess.Popen(args, cwd=cwd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1)
        self.events: list[dict] = []
        threading.Thread(target=self._read, daemon=True).start()

    def _read(self):
        for line in self.p.stdout:
            line = line.strip()
            if line.startswith("{"):
                try:
                    self.events.append(json.loads(line))
                except json.JSONDecodeError:
                    pass

    def first(self, event: str, after: float, timeout: float = 3.0) -> dict | None:
        end = time.time() + timeout
        while time.time() < end:
            for e in self.events:
                if e.get("event") == event and e["t"] >= after:
                    return e
            time.sleep(0.01)
        return None

    def kill(self):
        self.p.kill()
        self.p.wait()


def start_server() -> Proc:
    srv = Proc([PY, "-m", "uvicorn", "main:app", "--port", str(PORT), "--log-level", "warning"], cwd=ROOT / "server")
    for _ in range(100):
        try:
            urllib.request.urlopen(f"{HTTP}/api/scans", timeout=1)
            return srv
        except Exception:
            time.sleep(0.1)
    raise RuntimeError("server did not start")


def start_mock(wall: float) -> Proc:
    mock = Proc([PY, str(ROOT / "car" / "mock_car.py"), "--url", f"{WS}/car", "--wall", str(wall)])
    if not mock.first("connected", 0, timeout=10):
        raise RuntimeError("mock car did not connect")
    return mock


class Driver:
    """A scripted teleop browser on /drive that records telemetry and car status."""

    def __init__(self):
        self.telemetry: list[dict] = []
        self.status: list[dict] = []
        self.seq = 0

    async def open(self):
        self.ws = await websockets.connect(f"{WS}/drive")
        self.reader = asyncio.create_task(self._read())
        return self

    async def _read(self):
        try:
            async for text in self.ws:
                msg = json.loads(text)
                (self.telemetry if msg.get("type") == "telemetry" else self.status).append(msg)
        except websockets.exceptions.ConnectionClosed:
            pass

    async def drive(self, v: float, w: float, seconds: float, hz: float = 20):
        end = time.time() + seconds
        while time.time() < end:
            self.seq += 1
            await self.ws.send(json.dumps({"type": "drive", "v": v, "w": w, "seq": self.seq}))
            await asyncio.sleep(1 / hz)

    def last(self) -> dict:
        return self.telemetry[-1]


async def run():
    srv = start_server()
    mock = None
    try:
        # M1/M2 untouched, teleop served.
        for path in ["/scan/", "/viewer/", "/api/scans", "/teleop/"]:
            code = urllib.request.urlopen(HTTP + path, timeout=3).status
            check(f"GET {path}", code == 200, str(code))

        mock = start_mock(wall=1.0)
        d = await Driver().open()
        await asyncio.sleep(0.3)
        check("driver told car is connected", any(s.get("connected") for s in d.status))

        # 1. Moves under drive commands.
        await asyncio.sleep(0.2)
        before = d.last()
        await d.drive(1.0, 0.0, 1.0)
        await asyncio.sleep(0.15)
        after = d.last()
        dl, dr = after["left_steps"] - before["left_steps"], after["right_steps"] - before["right_steps"]
        check("drive forward moves both wheels", dl > 250 and dr > 250, f"left +{dl} right +{dr} steps")
        await d.drive(0.0, 1.0, 0.5)
        await asyncio.sleep(0.15)
        t = d.last()
        check("turning moves wheels opposite ways", t["mock"]["theta"] > 0.02, f"theta {t['mock']['theta']} rad")

        # 2. Driving browser closes -> stop.
        await d.drive(1.0, 0.0, 0.5)
        t_close = time.time()
        await d.ws.close()
        stop = mock.first("stop", t_close)
        lat = stop["t"] - t_close if stop else None
        check("tab closed -> car stops", stop is not None and lat < STOP_BUDGET_S, f"{lat * 1000:.0f} ms ({stop and stop['reason']})" if stop else "no stop")

        # 3. Browser freezes (socket open, nothing sent) -> deadman.
        d = await Driver().open()
        await d.drive(1.0, 0.0, 0.5)
        t_last = time.time()
        stop = mock.first("stop", t_last)
        lat = stop["t"] - t_last if stop else None
        check(
            "frozen browser -> deadman stop",
            stop is not None and stop["reason"] == "deadman" and lat < STOP_BUDGET_S,
            f"{lat * 1000:.0f} ms ({stop['reason']})" if stop else "no stop",
        )

        # 4. Car disconnects -> browser is told.
        n = len(d.status)
        mock.kill()
        await asyncio.sleep(0.5)
        check("car disconnect reported to browser", any(s.get("connected") is False for s in d.status[n:]))

        # 5. Forward block under 15 cm, reverse and turning still allowed.
        mock = start_mock(wall=0.22)  # ~2 cm/s at MAX_STEP_RATE 400: reaches 15 cm in ~3.5 s
        await asyncio.sleep(0.5)
        t0 = time.time()
        await d.drive(1.0, 0.0, 5.0)
        blocked = mock.first("blocked", t0, timeout=0.1)
        dists = [m["dist_cm"] for m in d.telemetry if m.get("uptime_ms") is not None][-30:]
        check("forward blocked near 15 cm", blocked is not None and min(dists) >= 13.5, f"min {min(dists)} cm, blocked at {blocked and blocked['dist_m']} m")
        x_blocked = d.last()["mock"]["x"]
        await d.drive(1.0, 0.0, 1.0)
        check("still blocked while holding forward", abs(d.last()["mock"]["x"] - x_blocked) < 0.005, f"dx {d.last()['mock']['x'] - x_blocked:.4f} m")
        d_before = d.last()["dist_cm"]
        await d.drive(-1.0, 0.0, 1.0)
        await asyncio.sleep(0.15)
        check("reverse allowed when blocked", d.last()["dist_cm"] > d_before + 1, f"{d_before} -> {d.last()['dist_cm']} cm")
        await d.drive(1.0, 0.0, 1.5)  # back up to the wall
        th = d.last()["mock"]["theta"]
        await d.drive(0.0, 1.0, 1.0)
        await asyncio.sleep(0.15)
        check("turning allowed when blocked", abs(d.last()["mock"]["theta"] - th) > 0.05, f"theta {th} -> {d.last()['mock']['theta']}")

        # 6. Server killed mid-drive -> car stops.
        drive = asyncio.create_task(d.drive(1.0, 0.0, 10.0))
        await asyncio.sleep(0.5)
        # Turn away from the wall first so it is actually moving when the server dies.
        drive.cancel()
        await d.drive(0.0, 1.0, 1.5)
        drive = asyncio.create_task(d.drive(0.3, 0.6, 10.0))
        await asyncio.sleep(0.5)
        t_kill = time.time()
        srv.kill()
        drive.cancel()
        stop = mock.first("stop", t_kill)
        lat = stop["t"] - t_kill if stop else None
        check("server killed -> car stops", stop is not None and lat < STOP_BUDGET_S, f"{lat * 1000:.0f} ms ({stop['reason']})" if stop else "no stop")
    finally:
        for p in (mock, srv):
            if p and p.p.poll() is None:
                p.kill()

    failed = [r for r in results if not r[1]]
    print(f"\n{len(results) - len(failed)}/{len(results)} passed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(asyncio.run(run()))
