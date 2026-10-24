"""Mock car: pretends to be the ESP32 so the server and teleop UI can be tested with no hardware.

Same protocol and safety logic as car/firmware/car/car.ino:
  - connects to /car, auto-reconnects
  - drive {"type":"drive","v":-1..1,"w":-1..1,"seq":n} -> differential step rates
  - deadman: no command for 300 ms -> stop (and "coils off")
  - forward blocked while the ultrasonic reads < 15 cm; reverse and turning still allowed
  - telemetry at 10 Hz
It simulates a car in a rectangular room, so the ultrasonic distance changes as it drives.
State changes are printed to stdout as JSON lines ({"event": ...}) so tests can time stops
even when the server is gone.

  python car/mock_car.py [--url ws://localhost:8000/car] [--wall 0.30]
"""

import argparse
import asyncio
import json
import math
import random
import sys
import time

import websockets

# Mirrors car/firmware/car/config.h. SI units internally.
STEPS_PER_REV = 4096  # 28BYJ-48 in half-step mode (gearbox ~1:64)
WHEEL_DIAMETER_M = 0.065
TRACK_WIDTH_M = 0.12
MAX_STEP_RATE = 900.0  # steps/s; the 28BYJ-48 skips steps much above ~1000 half-steps/s at 5 V
DEADMAN_S = 0.300
BLOCK_DIST_M = 0.15
BLOCK_HYST_M = 0.03  # stay blocked until the reading is back above 18 cm
IR_RANGE_M = 0.10
TELEMETRY_HZ = 10
SIM_HZ = 100

M_PER_STEP = math.pi * WHEEL_DIAMETER_M / STEPS_PER_REV


def emit(event: str, **kw) -> None:
    print(json.dumps({"event": event, "t": time.time(), **kw}), flush=True)


class Car:
    def __init__(self, wall_ahead: float) -> None:
        # Room: x in [-1, wall_ahead], y in [-1, 1]; the car starts at the origin facing +x.
        self.room = (-1.0, wall_ahead, -1.0, 1.0)
        self.x = self.y = self.theta = 0.0
        self.left_steps = self.right_steps = 0.0
        self.left_rate = self.right_rate = 0.0  # steps/s, + = forward
        self.v = self.w = 0.0
        self.last_cmd = -math.inf
        self.enabled = False
        self.moving = False
        self.blocked = False
        self.near = False  # something within the block distance (with hysteresis)
        self.yaw_rate = 0.0
        self.t0 = time.monotonic()

    def ultrasonic(self) -> float:
        """Distance (m) along the heading to the room walls, with a little noise."""
        x0, x1, y0, y1 = self.room
        c, s = math.cos(self.theta), math.sin(self.theta)
        ts = []
        if c > 1e-9:
            ts.append((x1 - self.x) / c)
        if c < -1e-9:
            ts.append((x0 - self.x) / c)
        if s > 1e-9:
            ts.append((y1 - self.y) / s)
        if s < -1e-9:
            ts.append((y0 - self.y) / s)
        d = min(t for t in ts if t >= 0) if ts else 4.0
        return max(0.02, min(4.0, d + random.gauss(0, 0.003)))

    def command(self, v: float, w: float) -> None:
        self.v, self.w = max(-1.0, min(1.0, v)), max(-1.0, min(1.0, w))
        self.last_cmd = time.monotonic()

    def stop(self, reason: str) -> None:
        self.v = self.w = 0.0
        self.last_cmd = -math.inf
        if self.moving or self.enabled:
            emit("stop", reason=reason)
        self.left_rate = self.right_rate = 0.0
        self.moving = False
        self.enabled = False  # disableOutputs(): coils off

    def step(self, dt: float) -> None:
        if self.enabled and time.monotonic() - self.last_cmd > DEADMAN_S:
            self.stop("deadman")
        dist = self.ultrasonic()
        v = self.v
        # Hysteresis: a noisy reading hovering at 15 cm would otherwise toggle the block and let
        # the car creep forward a bit on every "clear" sample.
        if dist < BLOCK_DIST_M:
            self.near = True
        elif dist > BLOCK_DIST_M + BLOCK_HYST_M:
            self.near = False
        blocked = v > 0 and self.near
        if blocked != self.blocked:
            emit("blocked" if blocked else "unblocked", dist_m=round(dist, 3))
        self.blocked = blocked
        if blocked:
            v = 0.0  # forward blocked; turning and reverse still allowed
        # Differential mix, scaled so neither wheel exceeds 1.
        left, right = v - self.w, v + self.w
        k = max(1.0, abs(left), abs(right))
        self.left_rate, self.right_rate = MAX_STEP_RATE * left / k, MAX_STEP_RATE * right / k
        moving = abs(self.left_rate) > 0 or abs(self.right_rate) > 0
        if moving and not self.enabled:
            self.enabled = True
        if moving != self.moving:
            emit("move" if moving else "halt", v=self.v, w=self.w)
            self.moving = moving
        # Kinematics.
        dl, dr = self.left_rate * dt, self.right_rate * dt
        self.left_steps += dl
        self.right_steps += dr
        sl, sr = dl * M_PER_STEP, dr * M_PER_STEP
        dtheta = (sr - sl) / TRACK_WIDTH_M
        self.yaw_rate = dtheta / dt if dt else 0.0
        ds = (sl + sr) / 2
        self.x += ds * math.cos(self.theta + dtheta / 2)
        self.y += ds * math.sin(self.theta + dtheta / 2)
        self.theta = (self.theta + dtheta + math.pi) % (2 * math.pi) - math.pi

    def telemetry(self) -> dict:
        return {
            "type": "telemetry",
            "dist_cm": round(self.ultrasonic() * 100, 1),
            "ir_blocked": self.ultrasonic() < IR_RANGE_M,
            "left_steps": int(self.left_steps),
            "right_steps": int(self.right_steps),
            "yaw_rate": round(self.yaw_rate, 4),
            "rssi": -55,
            "uptime_ms": int((time.monotonic() - self.t0) * 1000),
            "blocked": self.blocked,
            "mock": {"x": round(self.x, 4), "y": round(self.y, 4), "theta": round(self.theta, 4), "moving": self.moving},
        }


async def simulate(car: Car) -> None:
    dt = 1 / SIM_HZ
    last = time.monotonic()
    while True:
        await asyncio.sleep(dt)
        now = time.monotonic()
        car.step(now - last)
        last = now


async def session(car: Car, url: str) -> None:
    async with websockets.connect(url, open_timeout=5, ping_interval=5, ping_timeout=5) as ws:
        emit("connected", url=url)

        async def send_telemetry():
            while True:
                await ws.send(json.dumps(car.telemetry()))
                await asyncio.sleep(1 / TELEMETRY_HZ)

        sender = asyncio.create_task(send_telemetry())
        try:
            async for text in ws:
                try:
                    msg = json.loads(text)
                except json.JSONDecodeError:
                    continue
                if msg.get("type") == "drive":
                    v, w = float(msg.get("v", 0)), float(msg.get("w", 0))
                    if v == 0 and w == 0:
                        car.stop("command")
                    else:
                        car.command(v, w)
        finally:
            sender.cancel()


async def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--url", default="ws://localhost:8000/car")
    ap.add_argument("--wall", type=float, default=1.0, help="distance (m) from start to the wall ahead")
    args = ap.parse_args()
    car = Car(args.wall)
    asyncio.create_task(simulate(car))
    while True:
        try:
            await session(car, args.url)
        except (OSError, websockets.exceptions.WebSocketException, asyncio.TimeoutError) as e:
            emit("disconnected", error=type(e).__name__)
        # Link gone: stop now rather than waiting for the deadman.
        car.stop("disconnect")
        await asyncio.sleep(1.0)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        sys.exit(0)
