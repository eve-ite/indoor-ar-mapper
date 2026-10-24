// Bring-up 3: HC-SR04 ultrasonic + IR obstacle module over serial (115200), 5 times a second.
// Hold a hand at 15 cm and 50 cm and check the readings; wave something in front of the IR
// module and turn its trimmer until it trips at the distance you want.
// CHECK FIRST: the ECHO line goes through the voltage divider in WIRING.md. 5 V on an S3 pin
// can damage it.
#include "../car/config.h"

void setup() {
  Serial.begin(115200);
  pinMode(US_TRIG, OUTPUT);
  digitalWrite(US_TRIG, LOW);
  pinMode(US_ECHO, INPUT);
  pinMode(IR_PIN, INPUT_PULLUP);
}

void loop() {
  static uint32_t last = 0;
  if (millis() - last < 200) return;
  last = millis();
  digitalWrite(US_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG, LOW);
  // Blocking is fine in a bring-up sketch (no steppers running here).
  unsigned long us = pulseIn(US_ECHO, HIGH, US_TIMEOUT_US);
  bool ir = digitalRead(IR_PIN) == (IR_ACTIVE_LOW ? LOW : HIGH);
  if (us == 0) {
    Serial.printf("ultrasonic: no echo (nothing within ~4 m, or wiring)   IR: %s\n", ir ? "BLOCKED" : "clear");
  } else {
    float m = us * 343.0e-6f / 2.0f;
    Serial.printf("ultrasonic: %6.1f cm %s   IR: %s\n", m * 100, m < BLOCK_DIST_M ? "(would block forward)" : "",
                  ir ? "BLOCKED" : "clear");
  }
}
