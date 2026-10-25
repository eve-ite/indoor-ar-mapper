// Bring-up 1b: stepper wiring diagnosis, using the LEDs on each ULN2003 board (A=IN1 .. D=IN4).
// Serial monitor at 115200 says what should be happening; compare with the LEDs.
//   Phase 1 (12 s): each IN pin ON alone for 1.5 s: LEFT IN1..IN4, then RIGHT IN1..IN4.
//                   The matching LED (A, B, C, D) on the matching board must light, one at a time.
//   Phase 2 (8 s):  LEFT motor, slow half-step spin (~100 steps/s) with a hand-written sequence.
//   Phase 3 (8 s):  RIGHT motor, same.
// No AccelStepper here, so it also rules out the library's pin ordering.
#include "../car/config.h"

const int LEFT_PINS[4] = {LEFT_IN1, LEFT_IN2, LEFT_IN3, LEFT_IN4};
const int RIGHT_PINS[4] = {RIGHT_IN1, RIGHT_IN2, RIGHT_IN3, RIGHT_IN4};
// 28BYJ-48 half-step sequence on IN1..IN4.
const uint8_t SEQ[8] = {0b1000, 0b1100, 0b0100, 0b0110, 0b0010, 0b0011, 0b0001, 0b1001};

void allOff() {
  for (int i = 0; i < 4; i++) {
    digitalWrite(LEFT_PINS[i], LOW);
    digitalWrite(RIGHT_PINS[i], LOW);
  }
}

void apply(const int* pins, uint8_t bits) {
  for (int i = 0; i < 4; i++) digitalWrite(pins[i], (bits >> (3 - i)) & 1);
}

void setup() {
  Serial.begin(115200);
  for (int i = 0; i < 4; i++) {
    pinMode(LEFT_PINS[i], OUTPUT);
    pinMode(RIGHT_PINS[i], OUTPUT);
  }
  allOff();
}

void spin(const char* name, const int* pins, uint32_t ms) {
  Serial.printf("%s motor: slow spin for %lu s (LEDs should chase A-B-C-D)\n", name, (unsigned long)(ms / 1000));
  uint32_t t0 = millis();
  int k = 0;
  while (millis() - t0 < ms) {
    apply(pins, SEQ[k]);
    k = (k + 1) % 8;
    delay(10);  // ~100 half-steps/s: slow and strong
  }
  allOff();
}

void loop() {
  Serial.println("--- phase 1: one IN pin at a time");
  const char* names[2] = {"LEFT", "RIGHT"};
  const int* pins[2] = {LEFT_PINS, RIGHT_PINS};
  for (int m = 0; m < 2; m++) {
    for (int i = 0; i < 4; i++) {
      allOff();
      digitalWrite(pins[m][i], HIGH);
      Serial.printf("%s board: IN%d (GPIO %d) ON -> LED %c only\n", names[m], i + 1, pins[m][i], 'A' + i);
      delay(1500);
    }
  }
  allOff();
  Serial.println("--- phase 2/3: slow spins");
  spin("LEFT", LEFT_PINS, 8000);
  delay(1000);
  spin("RIGHT", RIGHT_PINS, 8000);
  delay(2000);
}
