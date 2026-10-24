"""List the GATT services/characteristics the car exposes (debugging BLE).

  uv run --with bleak car/tools/ble_services.py
"""

import asyncio

from bleak import BleakClient, BleakScanner


async def main():
    dev = await BleakScanner.find_device_by_name("mapper-car", timeout=10)
    if not dev:
        raise SystemExit("mapper-car not found")
    async with BleakClient(dev, winrt={"use_cached_services": False}) as c:
        print(f"connected {dev.address} mtu {c.mtu_size}")
        for s in c.services:
            print(f"service {s.uuid}  {s.description}")
            for ch in s.characteristics:
                print(f"   char {ch.uuid}  {','.join(ch.properties)}  handle {ch.handle}")


asyncio.run(main())
