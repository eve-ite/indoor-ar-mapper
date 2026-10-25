# Car (M3): keyboard teleop

```
PRIMARY (Bluetooth LE, no wifi/server/hotspot):
laptop Chrome /teleop ◄──Web Bluetooth (NUS-style UART)──► ESP32-S3 car "mapper-car"

SECONDARY (CONTROL_LINK = LINK_WIFI in config.h):
laptop browser /teleop ──ws──► server /drive ──relay──► server /car ◄──wss── ESP32-S3 car
```

**Drive over Bluetooth:**
1. Open `http://localhost:8000/teleop/` in **Chrome or Edge**. Brave disables Web Bluetooth,
   and Web Bluetooth needs localhost or https, so `file://` won't work.
2. Click **Connect Bluetooth** and pick **mapper-car**.

The server only serves the page; driving doesn't go through it.

**BLE protocol:**
- **Service:** `6e400001-b5a3-f393-e0a9-e50e24dcca9e`. The page writes to RX `…0002` and the car
  notifies on TX `…0003`.
- **Messages:** the same JSON as below, each one a `\n`-terminated line, split into MTU-sized
  pieces and re-joined at the newline.
- The car serves one central at a time and advertises again as soon as it's free.

**Behaviour seen on the real board:**
- Commands arrive at 20 Hz.
- Telemetry comes back at 10 Hz.
- The deadman stops the car **301 ms** after the last command.
- When a page closes or disconnects, Windows keeps the BLE link open for about 3 s, so the
  **deadman** is what stops the car within 300 ms, not the disconnect event.

- `firmware/car/`: car firmware (ESP32-S3 N16R8). Pins and tunables in `config.h`.
- `firmware/bringup_*`: one-job test sketches for wiring things up (see `WIRING.md`).
- `teleop/`: the `/teleop` page (WASD/arrows, touch joystick, STOP, live telemetry).
- `mock_car.py`: a fake car that speaks the same protocol, for testing with no hardware.
- `tests/`: end-to-end tests (server + mock + scripted/headless-browser driver).
- Server side: `server/car_relay.py` (the `/car` and `/drive` WebSockets).

**Safety lives on the car:**
- If no command arrives for 300 ms, it stops and switches the coils off.
- If the link drops (BLE central or WebSocket), it stops as soon as it notices.
- Forward is refused while the ultrasonic reads under 15 cm (and until it reads over 18 cm again).
- Reverse and turning always work.

The teleop page also sends stops on key release, window blur, tab hidden and page close.

## WiFi mode (secondary; set `CONTROL_LINK LINK_WIFI` in config.h)

The car joins the venue wifi as an ordinary client and **dials out** to the laptop's cloudflared
tunnel: `wss://<random>.trycloudflare.com/car`. This works through client isolation and doesn't
need a hotspot. On a home network it can also use plain `ws://<laptop-ip>:8000/car`.

Quick-tunnel URLs change every time cloudflared restarts. Update the car **without reflashing**
over the serial monitor (115200 baud, newline):

```
host abc-def.trycloudflare.com      # then it reconnects
show                                # wifi + server + link status
port 443 | tls 1                    # tunnel (default)
port 8000 | tls 0                   # LAN
wifi <ssid> <password>
reset                               # back to secrets.h defaults
```

Settings are saved to flash. WPA2-Enterprise (eduroam-style) networks aren't supported yet. If
the venue only has those, ask the organizers for a device/IoT network.

## Flash the firmware (Arduino IDE 2)

1. **Board support:** File → Preferences → *Additional boards manager URLs*: add
   `https://espressif.github.io/arduino-esp32/package_esp32_index.json`. Then in Boards Manager,
   install **esp32 by Espressif Systems**.
2. **Libraries (Library Manager):**
   - **AccelStepper** (Mike McCauley)
   - **WebSockets** (Markus Sattler / Links2004)
   - **ArduinoJson** (Benoit Blanchon, v7)
3. Open `car/firmware/car/car.ino`. Copy `secrets.example.h` to `secrets.h` in the same folder
   and fill in the wifi details and the tunnel host. `secrets.h` is gitignored.
4. **Tools menu:**
   - Board **ESP32S3 Dev Module**
   - Flash Size **16MB (128Mb)**
   - PSRAM **OPI PSRAM**
   - Partition Scheme **16M Flash (3MB APP/9.9MB FATFS)** (TLS + WiFi make the app ~1.1 MB; the default 1.2 MB app slot is 84% full)
   - **Which USB port:**
     - **"COM"/"UART" port (CH343):** USB CDC On Boot **Disabled**.
     - **Native "USB" port:** USB CDC On Boot **Enabled**, or `Serial` goes to the UART pins and
       you see nothing.
   - **Our board right now:** its COM/UART port stopped enumerating (2026-10-24), so it runs on
     the **native port, COM12, CDC On Boot Enabled**. If an upload there fails, hold BOOT, tap
     RST, release BOOT, then retry.
5. Upload, then open the Serial Monitor at **115200**. You should see the MPU6050 status, the
   link, then `advertising as "mapper-car"` (BLE) or `[ws] connected` (WiFi). Type `show` for
   the current status.

Command line (what the repo was checked with):

```sh
# native USB port (current board)
arduino-cli compile --upload -p COM12 --fqbn esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB,CDCOnBoot=cdc car/firmware/car
# COM/UART (CH343) port
arduino-cli compile --upload -p COM11 --fqbn esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB car/firmware/car
```

## Run it

```sh
cd server && uv run uvicorn main:app --port 8000          # terminal 1
cloudflared tunnel --url http://localhost:8000 --protocol http2 --no-autoupdate   # terminal 2
```

Then open `http://localhost:8000/teleop/` on the laptop (or `<tunnel>/teleop/` on a phone).

**Controls:**
- Drive: W/S or ↑/↓ forward/back, A/D or ←/→ turn left/right.
- Stop: space or the STOP button.
- The slider caps the speed.

**Status pills:** they show whether the server and the car are connected, and "car silent" means
telemetry has stopped arriving.

## Dev tools (board on COM12 = native USB now; COM11 = the CH343 port)

```sh
uv run --with pyserial car/tools/serial_tail.py COM12 --seconds 10 --send show  # serial log (on native USB, --reset re-enumerates)
uv run --with bleak car/tools/ble_services.py                                # GATT table
uv run --with bleak car/tools/ble_probe.py echo                              # with bringup_ble_echo
uv run --with bleak car/tools/ble_probe.py drive --end silent|disconnect     # deadman tests
```

- **`bringup_hello`** prints chip info.
- **`bringup_ble_echo`** echoes lines back. Pair it with `/teleop/ble-test.html` in Chrome.

Only one program can open the board's COM port at a time (close the Arduino serial monitor first). If the
car stops advertising after a test, a central is still holding it: close other BLE pages, or
reset the board with `--reset`.

## Without hardware

```sh
python car/mock_car.py --url ws://localhost:8000/car [--wall 0.5]
```

It simulates the car in a room, with a wall `--wall` meters ahead, and prints stop/move/blocked
events.

Tests (each starts its own server on 8790/8791 plus the mock):

```sh
server/.venv/Scripts/python car/tests/test_car.py     # relay, deadman, forward block, server kill
node car/tests/teleop_e2e.mjs                         # real page in headless Chrome, real keys
```

## Protocol

| Direction | Message |
|---|---|
| browser → server → car | `{"type":"drive","v":-1..1,"w":-1..1,"seq":n}`: v forward +, w turn left + |
| car → server → browsers | `{"type":"telemetry","dist_cm","ir_blocked","left_steps","right_steps","yaw_rate","rssi","uptime_ms","blocked","seq"}` |
| server → browsers | `{"type":"car_status","connected":bool}` |

- **Units:** `dist_cm` is in cm (null when there's no valid echo) and `yaw_rate` is in rad/s
  (null without the MPU6050).
- **Steps:** step counts are half-steps, positive = forward. At 4096 per wheel turn, they double
  as odometry.
- **Drive commands are latest-wins:** the relay never queues them, so a laggy link can't replay
  old commands.

**Speed:** the 28BYJ-48 is slow. The default `MAX_STEP_RATE 900` half-steps/s with 65 mm wheels
is about 4.5 cm/s. Above ~1000 it skips steps at 5 V.
