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
        self.fast = False  # write without response (what teleop does) once set

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
            await self.c.write_gatt_char(RX, data[i : i + self.chunk], response=not self.fast)


async def connect() -> BleakClient:
    print(f"scanning for {NAME} ...", flush=True)
    dev = await BleakScanner.find_device_by_name(NAME, timeout=20)
    if not dev:
        sys.exit(f"FAIL: {NAME} not found (powered? already connected to another central?)")
    # Fresh service discovery: Windows caches GATT tables per address, and a reflashed board can
    # look like the old firmware until it re-reads them.
    client = BleakClient(dev, winrt={"use_cached_services": False})
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


async def drive_test(link: Link, seconds: float, v: float, w: float, end: str) -> bool:
    """Drive at 20 Hz, then either go silent (deadman) or drop the connection mid-drive."""
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
    link.fast = True
    await asyncio.sleep(1.0)
    print(f"telemetry before driving: {len(tel)} messages, last: {tel[-1] if tel else None}")
    seq = 0
    deadline = time.time() + seconds
    while time.time() < deadline:
        seq += 1
        await link.send(json.dumps({"type": "drive", "v": v, "w": w, "seq": seq}))
        await asyncio.sleep(0.05)
    mid = tel[-1] if tel else None
    if end == "disconnect":
        print(f"sent {seq} drive commands; disconnecting mid-drive (car should stop at once)")
        r.cancel()
        print(f"telemetry total {len(tel)}; while driving: {mid}")
        return bool(tel)
    print(f"sent {seq} drive commands; going silent (deadman should fire ~300 ms after the last one)")
    await asyncio.sleep(1.0)
    r.cancel()
    print(f"telemetry total {len(tel)}; while driving: {mid}")
    print(f"after going silent: {tel[-1] if tel else None}")
    return bool(tel)


async def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["echo", "drive"])
    ap.add_argument("--seconds", type=float, default=2.0)
    ap.add_argument("--v", type=float, default=0.0, help="forward (blocked without an ultrasonic reading)")
    ap.add_argument("--w", type=float, default=0.6, help="turn left +")
    ap.add_argument("--end", choices=["silent", "disconnect"], default="silent")
    args = ap.parse_args()
    client = await connect()
    link = Link(client)
    try:
        await link.start()
        if args.mode == "echo":
            ok = await echo_test(link)
        else:
            ok = await drive_test(link, args.seconds, args.v, args.w, args.end)
    finally:
        await client.disconnect()
        print("disconnected", flush=True)
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main()))
