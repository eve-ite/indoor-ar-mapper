# Car wiring (ESP32-S3-DevKitC-1 N16R8)

**This file is the single source of truth for the wiring.** `firmware/car/config.h` mirrors the
pin map below; if you ever change a pin, change it here *and* there, and nowhere else.

Pin numbers are **GPIO numbers** as printed on the DevKitC-1 silkscreen.

## Pin map

All signal pins are on the **J1 header** (the side with 3V3, RST and 5V). The header positions
count from the 3V3 end (pin 1) and follow the Espressif DevKitC-1 layout. Clones occasionally
differ, so go by the silkscreen labels if they disagree.

| Part | Signal | GPIO | J1 pos | Notes |
|---|---|---|---|---|
| Left ULN2003 | IN1 | 4 | 4 | 3.3 V logic drives the ULN2003 inputs fine |
| Left ULN2003 | IN2 | 5 | 5 | |
| Left ULN2003 | IN3 | 6 | 6 | |
| Left ULN2003 | IN4 | 7 | 7 | |
| Right ULN2003 | IN1 | 15 | 8 | directions set on the real car: `LEFT_DIR -1`, `RIGHT_DIR -1` |
| Right ULN2003 | IN2 | 16 | 9 | |
| Right ULN2003 | IN3 | 17 | 10 | |
| Right ULN2003 | IN4 | 18 | 11 | |
| MPU6050 (GY-521) | SDA | 8 | 12 | module VCC from **3V3** (its I²C pull-ups go to its VCC) |
| MPU6050 (GY-521) | SCL | 9 | 15 | ⚠ J1 pos 13–14 between SDA and SCL are GPIO 3 and 46: skip them |
| HC-SR04 | TRIG | 10 | 16 | direct; 3.3 V triggers it |
| HC-SR04 | ECHO | 11 | 17 | **through the 1k/2k divider below, never direct** |
| IR module | OUT | 12 | 18 | module VCC from **3V3** so OUT swings 0–3.3 V |

Checked against this board: every pin above is broken out, and none is a strapping, USB, UART,
flash, PSRAM or LED pin. The pins left free on purpose are:

| GPIO | Why it's off-limits |
|---|---|
| 0, 3, 45, 46 | strapping (boot mode, JTAG source, flash voltage) |
| 19, 20 | native USB D− / D+ |
| 26–32 | SPI flash |
| 33–37 | octal PSRAM (the "R8") |
| 38, 48 | RGB LED (v1.1 / v1.0 boards) |
| 39–42 | JTAG (usable, kept free for debugging) |
| 43, 44 | UART0 (the USB-serial "COM" port / serial monitor) |

## Power

Two 5 V feeds, one shared ground:

- **ESP32:** powered through **its own USB-C port** from the power bank. Nothing goes on its "5V"
  pin.
- **Motor rail:** a separate 5 V feed, e.g. the power bank's second port via a USB breakout, or a
  second bank. It powers both ULN2003 boards and the HC-SR04.

```
power bank port A ── USB-C cable ──────────────► ESP32-S3 USB port  (logic power only)

power bank port B 5V ──► motor rail + ──┬── left  ULN2003 "+"
                                        ├── right ULN2003 "+"
                                        ├── HC-SR04 VCC
                                        └── 470 µF electrolytic (+) ─┐
                motor rail − (GND) ─────┬── left  ULN2003 "−"        │
                                        ├── right ULN2003 "−"        │
                                        ├── HC-SR04 GND              │
                                        ├── capacitor (−) ───────────┘
                                        └── ESP32-S3 GND pin ◄── the common-ground wire

ESP32-S3 3V3 ─────────────────────────────────► IR VCC, MPU6050 VCC
ESP32-S3 GND ─────────────────────────────────► IR GND, MPU6050 GND
```

- **Common ground is mandatory.** Run a real wire from an ESP32 **GND** pin to the motor rail −.
  Don't rely on the two USB cables going back to the same bank. The ULN2003 inputs and the
  HC-SR04 echo are referenced to the ESP32's ground. Without that wire, the motors twitch, don't
  move, or the echo reads garbage.
- **The HC-SR04 runs on the motor rail's 5 V** (it needs 5 V). Its ECHO still goes to the ESP32
  only through the divider. The ESP32's "5V" pin isn't used as a supply in this layout.
- **Bulk capacitor:** about 470 µF (anything 220–1000 µF, ≥ 10 V) across the motor rail, close
  to the ULN2003 boards. It soaks up the coil switching spikes. Mind the polarity: the stripe is −.
- **Current:**
  - Motor rail: each 28BYJ-48 draws roughly 150–250 mA while energized, so use a port rated
    **≥ 1 A**. The firmware switches the coils off whenever the car is stopped.
  - ESP32 port: ~100 mA, with WiFi peaks around 300 mA.
  - Some power banks switch a port off when it draws very little. The ESP32's draw is usually
    enough to keep its port awake. If the motor port sleeps while the car is idle, that's
    harmless: it wakes when the coils draw current again, or plug the motors into the port that
    stays on.
- **Flashing:** unplug the ESP32's USB from the bank and plug it into the laptop. The motor rail
  can stay on its bank, and you can keep the ground wire too, since there's still only one 5 V
  source per rail.
- **Fitted jumpers:** keep the jumper on each ULN2003 board (it connects the motor supply).

## HC-SR04 echo divider (5 V → 3.3 V)

The echo pin swings to 5 V and the ESP32-S3 is **not 5 V tolerant**.

```
HC-SR04 ECHO ──[ 1 kΩ ]──┬──► GPIO 11
                         │
                      [ 2 kΩ ]
                         │
                        GND
```

5 V × 2k / (1k + 2k) = **3.33 V**. No 2 kΩ? Use two 1 kΩ in series (or 10k/20k, same ratio).
Check it with a multimeter before connecting GPIO 11: unplug the sensor, put 5 V on the "ECHO"
end of the divider, and the middle node should read about 3.3 V.

## Bring-up order

Do one step at a time, and only move on once it works. Each sketch lives in `firmware/`.

1. **ESP32 alone on the laptop's USB.** Flash `bringup_i2c` with nothing wired; it should
   print "No MPU6050…". That proves the board settings and upload work.
2. **MPU6050.** Wire 3V3/GND/SDA(8)/SCL(9), avoiding J1 pos 13–14, then rerun `bringup_i2c`.
   You should see a device at 0x68 and changing gyro numbers when you rotate it.
3. **Motor rail + ground.** Build the rail with the capacitor and run the common-ground wire to
   the ESP32. Measure ~5 V between rail + and the ESP32's GND pin.
4. **Ultrasonic + IR.** Build and **meter-check the divider first**, then wire the HC-SR04
   (VCC on the motor rail) and the IR module (3V3). Flash `bringup_sensors`, check a hand at
   15 cm and at 50 cm, and tune the IR trimmer.
5. **One motor.** Wire the left ULN2003 (rail + IN 4–7), with the wheel off the ground. Flash
   `bringup_stepper`: the left wheel turns one revolution "forward", then back. If it only buzzes,
   re-check the IN1–IN4 order. Then wire the right one (IN 15–18) and watch it do the same. If a
   wheel goes backwards on the "forward" leg, flip its `*_DIR` in `config.h`.
6. **Full firmware over Bluetooth, wheels still in the air.**
   - Flash `car`. It's in BLE mode by default (`CONTROL_LINK LINK_BLE`). `secrets.h` only needs
     to exist, copied from the example; nothing in it is used in BLE mode.
   - On the laptop, start the server (`cd server && uv run uvicorn main:app --port 8000`). It
     only serves the page: no tunnel or WiFi involved.
   - Open `http://localhost:8000/teleop/` in **Chrome or Edge** (not Brave), click **Connect
     Bluetooth**, and pick **mapper-car**.
   - Drive, and check:
     - STOP, letting go of the keys and closing the tab all stop it.
     - A hand under 15 cm in front blocks forward.
     - The ultrasonic box shows a distance, or "clear (>4 m)". If it says **NO ECHO**, the sensor
       is miswired and forward has no obstacle protection.
   - The WiFi flow (`secrets.h` + tunnel) is only for `CONTROL_LINK LINK_WIFI`. The venue WiFi
     is 5/6 GHz only, so BLE is the venue link.
7. **On the floor**, phone mounted, ESP32 back on its power bank port. `MAX_STEP_RATE` starts at
   **400** half-steps/s (~2 cm/s): on the bench, 200 works and 800 skips. Use the teleop speed
   slider to go slower. Raise `MAX_STEP_RATE` in `config.h` only in small steps, and only if
   the wheels don't skip with the full weight on them.
