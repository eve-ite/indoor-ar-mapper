// All pins and tunables for the car, in one place. The wiring source of truth is car/WIRING.md:
// the pin numbers here must match it. Board: ESP32-S3-DevKitC-1 N16R8
// (16 MB quad flash, 8 MB *octal* PSRAM). SI units unless the name says otherwise.
//
// GPIOs NOT used, on purpose:
//   0, 3, 45, 46   strapping pins (boot mode / JTAG source / flash voltage)
//   19, 20         native USB D-/D+
//   26-32          SPI flash
//   33-37          octal PSRAM (the "R8" part); 35-37 are wired to the PSRAM die
//   38, 48         onboard RGB LED (GPIO48 on DevKitC-1 v1.0, GPIO38 on v1.1)
//   39-42          JTAG (usable, but kept free for debugging)
//   43, 44         UART0 TX/RX (USB-serial bridge on the "COM" port)
// The S3 has no input-only pins (unlike the original ESP32), so everything below is bidirectional.
#pragma once

// ---- Steppers: 2x 28BYJ-48 on ULN2003 boards (IN1..IN4 each) ----
#define LEFT_IN1 4
#define LEFT_IN2 5
#define LEFT_IN3 6
#define LEFT_IN4 7
#define RIGHT_IN1 15
#define RIGHT_IN2 16
#define RIGHT_IN3 17
#define RIGHT_IN4 18

// Set on the real car with bringup_stepper (2026-10-25): both -1 for our wiring/mounting. Flip these
// (+1 / -1) if a wheel drives backwards during bring-up.
#define LEFT_DIR (-1)
#define RIGHT_DIR (-1)

// ---- HC-SR04 ultrasonic (VCC on the 5 V motor rail). ECHO is 5 V: 1k/2k divider, see WIRING.md ----
#define US_TRIG 10
#define US_ECHO 11

// ---- IR obstacle module (digital out; power it from 3V3 so its output is 3.3 V) ----
#define IR_PIN 12
#define IR_ACTIVE_LOW true  // most modules pull OUT low when they see something

// ---- MPU6050 on I2C (optional; yaw rate telemetry). 8/9 are the S3's default I2C pins ----
#define I2C_SDA 8
#define I2C_SCL 9
#define MPU_ADDR 0x68  // 0x69 if AD0 is tied high

// ---- Drive ----
// 28BYJ-48: ~1:64 gearbox, 4096 half-steps per output revolution (nominal; real ~4076).
// It skips steps / stalls if pushed much above ~1000 half-steps/s at 5 V, and torque drops
// fast with speed. Raise MAX_STEP_RATE only after testing on the floor with the phone on board.
#define STEPS_PER_REV 4096
// Bench test on our motors: 200 half-steps/s works, 800 skips. Start at 400 and only raise it
// after a floor test with the phone mounted.
#define MAX_STEP_RATE 400.0f  // half-steps/s at |v|+|w| = 1  (~0.02 m/s with 65 mm wheels)
#define ACCEL_STEPS 1000.0f   // half-steps/s^2 when speeding up (0 -> 400 in 0.4 s); stops are immediate
#define WHEEL_DIAMETER_M 0.065f
#define TRACK_WIDTH_M 0.12f

// ---- Safety ----
#define DEADMAN_MS 300            // no drive command for this long -> stop, coils off
#define BLOCK_DIST_M 0.15f        // forward blocked when the ultrasonic reads closer than this
#define BLOCK_HYST_M 0.03f        // ...and stays blocked until it reads farther than BLOCK+HYST
// Ultrasonic states (reported as telemetry "us"):
//   "ok"       a distance in range: forward blocked under BLOCK_DIST_M
//   "clear"    echo timed out / HC-SR04's long "nothing in range" pulse: treated as clear
//   "no_echo"  no echo pulse at all for US_FAULT_MS (sensor unplugged/miswired)
// Trade-off: with US_FAULT_BLOCKS_FORWARD false, an unplugged sensor means forward has NO
// obstacle protection (teleop shows a warning). Set it true to refuse forward in that case.
#define US_FAULT_MS 500
#define US_FAULT_BLOCKS_FORWARD false
#define IR_BLOCKS_FORWARD false   // set true to also block forward while the IR sees something

// ---- Timing ----
#define US_PERIOD_MS 60       // HC-SR04 needs >= 60 ms between pings to avoid echoes
#define US_TIMEOUT_US 26000   // ~4.5 m round trip; longer = no echo
#define TELEMETRY_HZ 10
#define NET_CORE 0            // WiFi/WebSocket/JSON task runs here; loop() (steppers) runs on core 1

// ---- Control link ----
// BLE (primary): the car is a Nordic-UART-style BLE peripheral; the teleop page connects to it
// directly with Web Bluetooth. No wifi, no server, no hotspot needed.
// WIFI (secondary): WebSocket client to the server (/car), host/port/TLS from secrets.h.
#define LINK_BLE 1
#define LINK_WIFI 2
#define CONTROL_LINK LINK_BLE
#define BLE_NAME "mapper-car"
#define LOG_DRIVE_COMMANDS true  // print every received drive command on serial (115200)

// ---- Server path for WIFI mode (host/port/TLS come from secrets.h, overridable over serial) ----
#define SERVER_PATH "/car"
