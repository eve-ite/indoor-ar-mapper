"""Print a serial port for N seconds (or forever), with timestamps. Optional lines to send.

  uv run --with pyserial car/tools/serial_tail.py COM11 [--seconds 5] [--send "show"]

Opening the port toggles DTR/RTS on some USB-serial chips, which resets the ESP32; this script
holds both low so it attaches without rebooting the board (use --reset to reboot on purpose).
"""

import argparse
import sys
import time

import serial


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("port")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--seconds", type=float, default=0, help="0 = until Ctrl+C")
    ap.add_argument("--send", action="append", default=[], help="line to send after opening")
    ap.add_argument("--reset", action="store_true", help="pulse RTS to reboot the board first")
    args = ap.parse_args()

    s = serial.Serial()
    s.port, s.baudrate, s.timeout = args.port, args.baud, 0.1
    s.dtr = s.rts = False
    s.open()
    if args.reset:
        s.rts = True
        time.sleep(0.1)
        s.rts = False
    t0 = time.time()
    for line in args.send:
        s.write((line + "\n").encode())
    buf = b""
    try:
        while not args.seconds or time.time() - t0 < args.seconds:
            buf += s.read(4096)
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                print(f"{time.time() - t0:7.3f}  {line.decode(errors='replace').rstrip()}", flush=True)
    except KeyboardInterrupt:
        pass
    finally:
        s.close()


if __name__ == "__main__":
    sys.exit(main())
