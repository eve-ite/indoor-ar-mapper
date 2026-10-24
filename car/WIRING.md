# Car wiring (ESP32-S3-DevKitC-1 N16R8)

Pin numbers are **GPIO numbers** as printed on the DevKitC-1 silkscreen. They all live in
`firmware/car/config.h`; change them there, nowhere else.

## Pin map

| Part | Signal | ESP32-S3 GPIO | Notes |
|---|---|---|---|
| Left ULN2003 | IN1 / IN2 / IN3 / IN4 | 4 / 5 / 6 / 7 | 3.3 V logic drives the ULN2003 fine |
| Right ULN2003 | IN1 / IN2 / IN3 / IN4 | 15 / 16 / 17 / 18 | mounted mirrored: `RIGHT_DIR -1` |
| HC-SR04 | TRIG | 10 | direct; 3.3 V triggers it |
| HC-SR04 | ECHO | 11 | **through the divider below, never direct** |
| IR module | OUT | 12 | power the module from **3V3** so OUT is 3.3 V |
| MPU6050 (GY-521) | SDA / SCL | 8 / 9 | power from **3V3** (its pull-ups go to its VCC) |

Kept free on purpose: 0, 3, 45, 46 (strapping), 19/20 (USB), 26–32 (flash), 33–37 (octal PSRAM,
the "R8"), 38/48 (RGB LED), 39–42 (JTAG), 43/44 (UART0, the serial monitor).

## Power

One 5 V USB power bank feeds a breadboard 5 V rail:

```
power bank USB 5V ──┬── breadboard + rail ──┬── ESP32-S3 "5V" pin
                    │                       ├── left ULN2003  "+" (5-12V)
                    │                       ├── right ULN2003 "+" (5-12V)
                    │                       └── HC-SR04 VCC
power bank GND  ────┴── breadboard - rail ──┬── ESP32-S3 GND
                                            ├── both ULN2003 "-"
                                            ├── HC-SR04 GND, IR GND, MPU6050 GND
ESP32-S3 3V3 ───────────────────────────────┴── IR VCC, MPU6050 VCC   (3V3, not 5V)
```

- **Common ground:** every GND (power bank, ESP32, both ULN2003 boards, all sensors) is tied
  together on the breadboard − rail. Without it, the ULN2003 inputs and the HC-SR04 echo have no
  shared reference, and the motors twitch randomly or not at all.
- **Current:** each 28BYJ-48 draws roughly 150–250 mA while energized, and WiFi peaks add
  ~300 mA, so use a power bank port rated **≥ 2 A**. The firmware switches the coils off whenever
  the car is stopped (`disableOutputs()`), which saves most of that.
- **Flashing over USB:** unplug the power bank's 5 V from the ESP32 "5V" pin while the laptop's
  USB cable is in, so two 5 V sources don't fight (you can leave the motor boards on the bank).
- Leave the jumper on each ULN2003 board fitted (it connects the motor supply).

## HC-SR04 echo divider (5 V → 3.3 V)

The echo pin swings to 5 V and the ESP32-S3 is **not 5 V tolerant**.

```
HC-SR04 ECHO ──[ 1 kΩ ]──┬──► GPIO 11
                         │
                      [ 2 kΩ ]
                         │
                        GND
```

5 V × 2k / (1k + 2k) = **3.33 V**. Any 1 : 2 pair works (10k/20k too); 1k/1.8k gives 3.2 V.
No 2k? Use two 1k in series. Check with a multimeter: put 5 V on the "ECHO" end of the divider
(with the sensor unplugged) and the middle node should read about 3.3 V.

## Bring-up order

Do one step at a time, and only move on once it works. Each sketch lives in `firmware/`.

1. **ESP32 alone on USB.** Flash `bringup_i2c` with nothing wired; it should print
   "No MPU6050…". That proves the board settings and upload work.
2. **MPU6050.** Wire 3V3/GND/SDA/SCL and rerun `bringup_i2c`. You should see a device at 0x68
   and changing gyro numbers when you rotate it.
3. **Ultrasonic + IR.** Build the divider and check it with the meter **first**, then wire the
   HC-SR04 and IR module. Flash `bringup_sensors`, then check a hand at 15 cm and at 50 cm, and
   tune the IR trimmer.
4. **One motor.** Wire the left ULN2003 to the 5 V rail and its IN pins, with the wheel off the
   ground. Flash `bringup_stepper`: the left wheel turns one revolution "forward", then back. If it
   only buzzes, re-check IN1–IN4. Then wire the right one and watch it do the same. If a wheel
   goes backwards on the "forward" leg, flip its `*_DIR` in `config.h`.
5. **Full firmware, wheels still in the air.** Create `secrets.h`, flash `car`, start the server
   (and tunnel), open `/teleop`, and drive. Check that STOP, letting go of the keys and closing
   the tab all stop it, and that a hand under 15 cm in front blocks forward.
6. **On the floor**, phone mounted, at a low speed (use the teleop speed slider). Raise
   `MAX_STEP_RATE` in `config.h` only if the wheels don't skip.
