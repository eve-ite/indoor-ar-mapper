"""Talk to the car's BLE UART from this computer (no browser): echo test, or drive test.

  uv run --with bleak car/tools/ble_probe.py echo
  uv run --with bleak car/tools/ble_probe.py drive [--seconds 2]

Lines are newline-terminated and chunked to the MTU, exactly like teleop.js does.
"""

import argparse
import asyncio
import json
import sys
import time

from bleak import BleakClient, BleakScanner

NAME = "mapper-car"
RX = "6e400002-b5a3-f393-e0a9-e50e24dcca9e"  # we write
TX = "6e400003-b5a3-f393-e0a9-e50e24dcca9e"  # car notifies


class Link:
    def __init__(self, client: BleakClient):
        self.c = client
        self.buf = ""
        self.lines: asyncio.Queue[tuple[float, str]] = asyncio.Queue()
        self.chunk = max(20, min(244, client.mtu_size - 3))

    def _on_notify(self, _, data: bytearray):
        self.buf += data.decode(errors="replace")
        while "\n" in self.buf:
            line, self.buf = self.buf.split("\n", 1)
            self.lines.put_nowait((time.perf_counter(), line))

    async def start(self):
        await self.c.start_notify(TX, self._on_notify)

    async def send(self, line: str):
        data = (line + "\n").encode()
        for i in range(0, len(data), self.chunk):
            await self.c.write_gatt_char(RX, data[i : i + self.chunk], response=True)


async def connect() -> BleakClient:
    print(f"scanning for {NAME} ...", flush=True)
    dev = await BleakScanner.find_device_by_name(NAME, timeout=10)
    if not dev:
        sys.exit(f"FAIL: {NAME} not found (powered? already connected to another central?)")
    client = BleakClient(dev)
    await client.connect()
    print(f"connected to {dev.address}, mtu {client.mtu_size}", flush=True)
    return client


async def echo_test(link: Link) -> bool:
    ok = True
    for msg in ["hello car", "x" * 300, json.dumps({"type": "drive", "v": 0.5, "w": -0.25, "seq": 1})]:
        t0 = time.perf_counter()
        await link.send(msg)
        try:
            t1, back = await asyncio.wait_for(link.lines.get(), 3)
        except asyncio.TimeoutError:
            print(f"FAIL  no echo for {len(msg)}-byte line")
            ok = False
            continue
        good = back == msg
        ok &= good
        print(f"{'PASS' if good else 'FAIL'}  {len(msg):4d} bytes round trip {1000 * (t1 - t0):6.1f} ms")
    return ok


async def drive_test(link: Link, seconds: float) -> bool:
    """Drive forward at 20 Hz, then go silent and watch telemetry; then disconnect."""
    tel: list[dict] = []

    async def reader():
        while True:
            _, line = await link.lines.get()
            try:
                m = json.loads(line)
            except json.JSONDecodeError:
                continue
            if m.get("type") == "telemetry":
                tel.append(m)

    r = asyncio.create_task(reader())
    await asyncio.sleep(1.0)
    print(f"telemetry before driving: {len(tel)} messages, last: {tel[-1] if tel else None}")
    seq = 0
    end = time.time() + seconds
    while time.time() < end:
        seq += 1
        await link.send(json.dumps({"type": "drive", "v": 0.6, "w": 0.0, "seq": seq}))
        await asyncio.sleep(0.05)
    t_last = time.time()
    print(f"sent {seq} drive commands; going silent (deadman should fire ~300 ms after the last one)")
    await asyncio.sleep(1.0)
    r.cancel()
    moved = [m for m in tel if m.get("left_steps")]
    print(f"telemetry total {len(tel)}; last: {tel[-1] if tel else None}")
    return bool(tel)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["echo", "drive"])
    ap.add_argument("--seconds", type=float, default=2.0)
    args = ap.parse_args()
    client = await connect()
    link = Link(client)
    await link.start()
    try:
        ok = await (echo_test(link) if args.mode == "echo" else drive_test(link, args.seconds))
    finally:
        await client.disconnect()
        print("disconnected", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
