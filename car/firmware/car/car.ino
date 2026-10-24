// Indoor AR Mapper car firmware (M3): differential stepper car driven by JSON commands.
// Board: ESP32-S3 (N16R8). Libraries: AccelStepper, ArduinoJson 7, WebSockets (Links2004, WIFI mode).
// Pins and tunables: config.h (wiring source of truth: car/WIRING.md). WiFi/server: secrets.h.
//
// Control link (config.h CONTROL_LINK):
//   LINK_BLE  (primary)   BLE peripheral "mapper-car", Nordic-UART-style service (ble_link.h);
//                         the teleop page connects directly with Web Bluetooth.
//   LINK_WIFI (secondary) WebSocket client to the server's /car (wss:// tunnel or ws:// LAN).
// Same JSON messages either way; over BLE each is a '\n'-terminated line, chunked to the MTU.
//
// Two cores, so the radio can never make the steppers stutter:
//   core 1, loop():   steppers (runSpeed every pass), ultrasonic, IR, deadman, safety. No delay().
//   core 0, netTask:  BLE or WiFi/WebSocket, JSON in/out, 10 Hz telemetry, MPU6050, serial
//                     config and logging.
// They share two small structs under a spinlock.
//
// Protocol:
//   in   {"type":"drive","v":-1..1,"w":-1..1,"seq":n}      v forward +, w turn left +
//   out  {"type":"telemetry","dist_cm","ir_blocked","left_steps","right_steps",
//         "yaw_rate","rssi","uptime_ms","blocked","seq"}
// Safety: no command for DEADMAN_MS -> stop + coils off; link loss -> immediate stop;
// forward refused under BLOCK_DIST_M (with hysteresis) or with no ultrasonic reading;
// reverse and turning always allowed.

#include <AccelStepper.h>
#include <ArduinoJson.h>
#include <Preferences.h>
#include <WebSocketsClient.h>
#include <WiFi.h>
#include <Wire.h>

#include "ble_link.h"
#include "config.h"
#include "secrets.h"

// ---------------------------------------------------------------- shared state (both cores)
struct Command {
  float v = 0, w = 0;
  uint32_t ms = 0;  // millis() when received
  uint32_t seq = 0;
  bool fresh = false;  // false until the first command after (re)connecting
};
enum StopReason : uint8_t { STOP_NONE, STOP_COMMAND, STOP_DEADMAN, STOP_LINK, STOP_BLOCKED };
struct Sensors {
  float dist_m = NAN;  // NAN = no valid reading
  bool ir = false;
  bool blocked = false;
  bool moving = false;
  int32_t left_steps = 0, right_steps = 0;  // + = forward on both sides
  uint32_t stops = 0;                       // increments on every moving -> stopped transition
  StopReason stopReason = STOP_NONE;
  uint32_t stopMs = 0, stopCmdMs = 0;  // when it stopped, and when the last command had arrived
};
static portMUX_TYPE shareMux = portMUX_INITIALIZER_UNLOCKED;
static Command sharedCmd;
static Sensors sharedSensors;
static volatile bool linkUp = false;
static BleLink ble;

void startNetwork();

// ---------------------------------------------------------------- core 1: motion + sensors
// HALF4WIRE with the IN1, IN3, IN2, IN4 order is the usual 28BYJ-48 / ULN2003 wiring.
static AccelStepper leftMotor(AccelStepper::HALF4WIRE, LEFT_IN1, LEFT_IN3, LEFT_IN2, LEFT_IN4);
static AccelStepper rightMotor(AccelStepper::HALF4WIRE, RIGHT_IN1, RIGHT_IN3, RIGHT_IN2, RIGHT_IN4);
static float leftRate = 0, rightRate = 0;  // current step rates, + = forward
static bool coilsOn = false;
static bool wasMoving = false;

// Ultrasonic, interrupt-timed so loop() never waits for the echo.
static volatile uint32_t echoRiseUs = 0, echoPulseUs = 0;
static volatile bool echoReady = false;
static uint32_t lastPingMs = 0, lastGoodDistMs = 0;
static float distM = NAN;
static bool nearSomething = false;

void IRAM_ATTR onEcho() {
  uint32_t now = micros();
  if (digitalRead(US_ECHO)) {
    echoRiseUs = now;
  } else {
    echoPulseUs = now - echoRiseUs;
    echoReady = true;
  }
}

static void updateUltrasonic(uint32_t nowMs) {
  if (echoReady) {
    echoReady = false;
    uint32_t us = echoPulseUs;
    if (us > 100 && us < US_TIMEOUT_US) {
      distM = us * 343.0e-6f / 2.0f;  // speed of sound ~343 m/s, there and back
      lastGoodDistMs = nowMs;
    }
  }
  if (nowMs - lastPingMs >= US_PERIOD_MS) {
    lastPingMs = nowMs;
    // 10 us trigger pulse. This is the only busy-wait in loop(); at <=1000 steps/s a step is
    // >= 1000 us apart, so 10 us can't make the steppers miss a beat.
    digitalWrite(US_TRIG, HIGH);
    delayMicroseconds(10);
    digitalWrite(US_TRIG, LOW);
  }
  if (nowMs - lastGoodDistMs > US_FAULT_MS) distM = NAN;
}

static void setCoils(bool on) {
  if (on == coilsOn) return;
  coilsOn = on;
  if (on) {
    leftMotor.enableOutputs();
    rightMotor.enableOutputs();
  } else {
    leftMotor.disableOutputs();  // all IN pins low: no holding current, no heat, saves the battery
    rightMotor.disableOutputs();
  }
}

// Speed up gradually (the 28BYJ-48 stalls on a sudden jump to full speed), but slow down and
// stop instantly: at these speeds there is no momentum to worry about, and stops must be quick.
static float approach(float cur, float target, float maxDelta) {
  if (cur != 0 && (cur > 0) != (target > 0)) return 0;  // reversing: stop first, then ramp the other way
  if (fabsf(target) <= fabsf(cur)) return target;
  return cur + constrain(target - cur, -maxDelta, maxDelta);
}

void setup() {
  Serial.begin(115200);
  pinMode(US_TRIG, OUTPUT);
  digitalWrite(US_TRIG, LOW);
  pinMode(US_ECHO, INPUT);
  pinMode(IR_PIN, INPUT_PULLUP);
  attachInterrupt(digitalPinToInterrupt(US_ECHO), onEcho, CHANGE);

  for (AccelStepper* m : {&leftMotor, &rightMotor}) {
    m->setMaxSpeed(MAX_STEP_RATE);
    m->setSpeed(0);
  }
  coilsOn = true;  // AccelStepper starts with outputs enabled; turn them off until we drive
  setCoils(false);

  // BLE is set up here (core 1), like the working echo sketch, not inside the network task:
  // started from core 0 the car advertised with no UART service in its GATT table.
  if (CONTROL_LINK == LINK_BLE) ble.begin(BLE_NAME);
  startNetwork();
}

void loop() {
  static uint32_t lastUs = micros();
  uint32_t nowUs = micros();
  float dt = (nowUs - lastUs) * 1e-6f;
  lastUs = nowUs;
  uint32_t nowMs = millis();

  updateUltrasonic(nowMs);
  bool ir = digitalRead(IR_PIN) == (IR_ACTIVE_LOW ? LOW : HIGH);

  Command cmd;
  portENTER_CRITICAL(&shareMux);
  cmd = sharedCmd;
  portEXIT_CRITICAL(&shareMux);

  // Deadman and link loss: zero the command.
  bool link = linkUp && cmd.fresh;
  bool expired = nowMs - cmd.ms > DEADMAN_MS;
  float v = cmd.v, w = cmd.w;
  if (!link || expired) v = w = 0;

  // Forward safety stop with hysteresis (otherwise a reading hovering at the threshold lets the
  // car creep forward on every "clear" sample).
  if (!isnan(distM)) {
    if (distM < BLOCK_DIST_M) nearSomething = true;
    else if (distM > BLOCK_DIST_M + BLOCK_HYST_M) nearSomething = false;
  }
  bool blockForward = nearSomething || (US_FAULT_BLOCKS_FORWARD && isnan(distM)) || (IR_BLOCKS_FORWARD && ir);
  bool blocked = v > 0 && blockForward;
  if (blocked) v = 0;  // turning and reverse stay allowed

  // Differential mix, scaled so neither wheel exceeds MAX_STEP_RATE.
  float l = v - w, r = v + w;
  float k = fmaxf(1.0f, fmaxf(fabsf(l), fabsf(r)));
  float lt = MAX_STEP_RATE * l / k, rt = MAX_STEP_RATE * r / k;
  leftRate = approach(leftRate, lt, ACCEL_STEPS * dt);
  rightRate = approach(rightRate, rt, ACCEL_STEPS * dt);

  bool moving = leftRate != 0 || rightRate != 0;
  setCoils(moving);
  // runSpeed() (not run()): this is velocity control, so we set a speed and step at it; run()
  // chases a target position with its own accel profile. Called every pass, never blocks.
  leftMotor.setSpeed(LEFT_DIR * leftRate);
  rightMotor.setSpeed(RIGHT_DIR * rightRate);
  if (moving) {
    leftMotor.runSpeed();
    rightMotor.runSpeed();
  }

  portENTER_CRITICAL(&shareMux);
  sharedSensors.dist_m = distM;
  sharedSensors.ir = ir;
  sharedSensors.blocked = blocked;
  sharedSensors.moving = moving;
  sharedSensors.left_steps = LEFT_DIR * leftMotor.currentPosition();
  sharedSensors.right_steps = RIGHT_DIR * rightMotor.currentPosition();
  if (wasMoving && !moving) {  // record why we stopped; the network core logs it
    sharedSensors.stops++;
    sharedSensors.stopReason = !link ? STOP_LINK : expired ? STOP_DEADMAN : blocked ? STOP_BLOCKED : STOP_COMMAND;
    sharedSensors.stopMs = nowMs;
    sharedSensors.stopCmdMs = cmd.ms;
  }
  portEXIT_CRITICAL(&shareMux);
  wasMoving = moving;
}

// ---------------------------------------------------------------- core 0: network
static WebSocketsClient ws;
static Preferences prefs;
static String cfgSsid, cfgPass, cfgHost;
static uint16_t cfgPort;
static bool cfgTls;
static bool mpuOk = false;

static void stopCommand() {
  portENTER_CRITICAL(&shareMux);
  sharedCmd.v = sharedCmd.w = 0;
  sharedCmd.fresh = false;
  portEXIT_CRITICAL(&shareMux);
}

// One JSON message from either link.
static void handleMessage(const char* text, size_t length) {
  JsonDocument doc;
  if (deserializeJson(doc, text, length)) return;
  if (doc["type"] != "drive") return;
  float v = constrain(doc["v"] | 0.0f, -1.0f, 1.0f);
  float w = constrain(doc["w"] | 0.0f, -1.0f, 1.0f);
  if (isnan(v) || isnan(w)) v = w = 0;
  uint32_t seq = doc["seq"] | 0;
  uint32_t now = millis();
  portENTER_CRITICAL(&shareMux);
  sharedCmd.v = v;
  sharedCmd.w = w;
  sharedCmd.seq = seq;
  sharedCmd.ms = now;
  sharedCmd.fresh = true;
  portEXIT_CRITICAL(&shareMux);
  if (LOG_DRIVE_COMMANDS) Serial.printf("%8lu [drive] seq=%lu v=%+.2f w=%+.2f\n", (unsigned long)now, (unsigned long)seq, v, w);
}

static void onWsEvent(WStype_t type, uint8_t* payload, size_t length) {
  switch (type) {
    case WStype_CONNECTED:
      linkUp = true;
      Serial.printf("%8lu [ws] connected to %s\n", millis(), cfgHost.c_str());
      break;
    case WStype_DISCONNECTED:
      linkUp = false;  // loop() stops on the next pass
      stopCommand();
      Serial.printf("%8lu [ws] disconnected\n", millis());
      break;
    case WStype_TEXT:
      handleMessage((const char*)payload, length);
      break;
    default:
      break;
  }
}

// MPU6050 gyro Z -> yaw rate (rad/s), raw registers so no extra library is needed.
static bool mpuWrite(uint8_t reg, uint8_t val) {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(reg);
  Wire.write(val);
  return Wire.endTransmission() == 0;
}

static bool mpuInit() {
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  Wire.setTimeOut(5);
  if (!mpuWrite(0x6B, 0x00)) return false;  // PWR_MGMT_1: wake up
  mpuWrite(0x1B, 0x00);                     // GYRO_CONFIG: +-250 deg/s -> 131 LSB per deg/s
  return true;
}

static float mpuYawRate() {
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x47);  // GYRO_ZOUT_H
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(MPU_ADDR, 2) != 2) return NAN;
  int16_t raw = (Wire.read() << 8) | Wire.read();
  return raw / 131.0f * DEG_TO_RAD;
}

static void sendTelemetry() {
  Sensors s;
  uint32_t seq;
  portENTER_CRITICAL(&shareMux);
  s = sharedSensors;
  seq = sharedCmd.seq;
  portEXIT_CRITICAL(&shareMux);

  JsonDocument doc;
  doc["type"] = "telemetry";
  if (isnan(s.dist_m)) doc["dist_cm"] = nullptr;
  else doc["dist_cm"] = roundf(s.dist_m * 1000.0f) / 10.0f;
  doc["ir_blocked"] = s.ir;
  doc["left_steps"] = s.left_steps;
  doc["right_steps"] = s.right_steps;
  float yaw = mpuOk ? mpuYawRate() : NAN;
  if (isnan(yaw)) doc["yaw_rate"] = nullptr;
  else doc["yaw_rate"] = yaw;
  if (CONTROL_LINK == LINK_WIFI) doc["rssi"] = WiFi.RSSI();
  else doc["rssi"] = nullptr;  // no cheap RSSI for a BLE peripheral connection
  doc["uptime_ms"] = millis();
  doc["blocked"] = s.blocked;
  doc["seq"] = seq;
  String out;
  serializeJson(doc, out);
  if (CONTROL_LINK == LINK_BLE) ble.sendLine(out);
  else ws.sendTXT(out);
}

static const char* reasonName(StopReason r) {
  switch (r) {
    case STOP_COMMAND: return "stop command";
    case STOP_DEADMAN: return "DEADMAN (no command)";
    case STOP_LINK: return "LINK LOST";
    case STOP_BLOCKED: return "forward blocked";
    default: return "?";
  }
}

// Log motion state changes from the motor core (printed here so loop() never waits on serial).
static void logStops() {
  static uint32_t seenStops = 0;
  static bool seenMoving = false;
  Sensors s;
  portENTER_CRITICAL(&shareMux);
  s = sharedSensors;
  portEXIT_CRITICAL(&shareMux);
  if (s.moving && !seenMoving) Serial.printf("%8lu [motion] moving\n", millis());
  seenMoving = s.moving;
  if (s.stops != seenStops) {
    seenStops = s.stops;
    Serial.printf("%8lu [motion] stopped: %s, %lu ms after the last command\n", (unsigned long)s.stopMs,
                  reasonName(s.stopReason), (unsigned long)(s.stopMs - s.stopCmdMs));
  }
}

static void connectServer() {
  ws.disconnect();
  if (cfgTls) {
    // No CA pinned: the quick-tunnel hostname changes on every restart. Hackathon trade-off.
    ws.beginSSL(cfgHost.c_str(), cfgPort, SERVER_PATH);
  } else {
    ws.begin(cfgHost.c_str(), cfgPort, SERVER_PATH);
  }
  ws.onEvent(onWsEvent);
  ws.setReconnectInterval(2000);
  ws.enableHeartbeat(5000, 2000, 2);  // ping every 5 s, drop the link after 2 missed pongs
}

static void loadConfig() {
  prefs.begin("car", false);
  cfgSsid = prefs.getString("ssid", WIFI_SSID);
  cfgPass = prefs.getString("pass", WIFI_PASS);
  cfgHost = prefs.getString("host", SERVER_HOST);
  cfgPort = prefs.getUShort("port", SERVER_PORT);
  cfgTls = prefs.getBool("tls", SERVER_TLS);
}

static void printConfig() {
  if (CONTROL_LINK == LINK_BLE) {
    Serial.printf("link BLE \"%s\"  central %s\n", BLE_NAME, ble.connected() ? "CONNECTED" : "none (advertising)");
    return;
  }
  Serial.printf("link WIFI \"%s\"  server %s://%s:%u%s  ws %s  wifi %s rssi %d\n", cfgSsid.c_str(), cfgTls ? "wss" : "ws",
                cfgHost.c_str(), cfgPort, SERVER_PATH, linkUp ? "UP" : "down",
                WiFi.isConnected() ? WiFi.localIP().toString().c_str() : "down", WiFi.RSSI());
}

// Serial commands (115200 baud, newline-terminated). Saved to flash, applied immediately.
static void handleSerialLine(String line) {
  line.trim();
  int sp = line.indexOf(' ');
  String cmd = sp < 0 ? line : line.substring(0, sp);
  String arg = sp < 0 ? "" : line.substring(sp + 1);
  arg.trim();
  bool wifi = CONTROL_LINK == LINK_WIFI;
  if (cmd == "host" && arg.length()) {
    cfgHost = arg;
    prefs.putString("host", arg);
    if (wifi) connectServer();
  } else if (cmd == "port" && arg.length()) {
    cfgPort = arg.toInt();
    prefs.putUShort("port", cfgPort);
    if (wifi) connectServer();
  } else if (cmd == "tls" && arg.length()) {
    cfgTls = arg.toInt() != 0;
    prefs.putBool("tls", cfgTls);
    if (wifi) connectServer();
  } else if (cmd == "wifi" && arg.length()) {
    int s2 = arg.indexOf(' ');
    cfgSsid = s2 < 0 ? arg : arg.substring(0, s2);
    cfgPass = s2 < 0 ? "" : arg.substring(s2 + 1);
    prefs.putString("ssid", cfgSsid);
    prefs.putString("pass", cfgPass);
    if (wifi) {
      WiFi.disconnect();
      WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
    }
  } else if (cmd == "reset") {
    prefs.clear();
    ESP.restart();
  } else if (cmd == "reboot") {
    ESP.restart();
  } else if (cmd != "show") {
    Serial.println("commands: show | host <name> | port <n> | tls <0|1> | wifi <ssid> <pass> | reset | reboot"
                   "  (host/port/tls/wifi apply in WIFI mode)");
  }
  printConfig();
}

static void netTask(void*) {
  loadConfig();
  mpuOk = mpuInit();
  Serial.printf("[car] MPU6050 %s\n", mpuOk ? "found" : "not found (yaw_rate = null)");
  if (CONTROL_LINK == LINK_BLE) {
    Serial.printf("[car] BLE link, advertising as \"%s\"\n", BLE_NAME);
  } else {
    WiFi.mode(WIFI_STA);
    WiFi.setAutoReconnect(true);
    WiFi.begin(cfgSsid.c_str(), cfgPass.c_str());
    connectServer();
  }
  printConfig();

  String line;
  uint32_t lastTelemetry = 0;
  bool bleWasUp = false;
  for (;;) {
    if (CONTROL_LINK == LINK_BLE) {
      bool up = ble.connected();
      if (up != bleWasUp) {
        bleWasUp = up;
        if (!up) stopCommand();  // central gone: stop now, don't wait for the deadman
        linkUp = up;
        Serial.printf("%8lu [ble] central %s\n", millis(), up ? "connected" : "disconnected");
      }
      String msg;
      while (ble.readLine(msg)) handleMessage(msg.c_str(), msg.length());
    } else {
      ws.loop();  // may block during (re)connect / TLS handshake; only this core waits
    }
    uint32_t now = millis();
    if (linkUp && now - lastTelemetry >= 1000 / TELEMETRY_HZ) {
      lastTelemetry = now;
      sendTelemetry();
    }
    logStops();
    while (Serial.available()) {
      char c = Serial.read();
      if (c == '\n' || c == '\r') {
        if (line.length()) handleSerialLine(line);
        line = "";
      } else if (line.length() < 200) {
        line += c;
      }
    }
    vTaskDelay(1);  // yield ~1 ms so the idle task (watchdog) runs; this is core 0, not the motor loop
  }
}

void startNetwork() {
  xTaskCreatePinnedToCore(netTask, "net", 12288, nullptr, 1, nullptr, NET_CORE);
}
