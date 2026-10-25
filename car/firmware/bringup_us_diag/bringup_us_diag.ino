// Bring-up 3b: HC-SR04 electrical diagnosis (115200). Per ping it reports what ECHO did:
//   idle=LOW  rise after ~0.4 ms  pulse N us     -> healthy (distance = N * 0.0343 / 2 cm)
//   idle=LOW  NO RISE                            -> sensor not powered (VCC/GND), TRIG not reaching it,
//                                                   or ECHO not reaching GPIO (divider/wire)
//   idle=HIGH                                    -> ECHO stuck high: divider wired wrong / short to 3V3/5V
//   pulse > 25000 us                             -> healthy, nothing in range
#include "../car/config.h"

void setup() {
  Serial.begin(115200);
  pinMode(US_TRIG, OUTPUT);
  digitalWrite(US_TRIG, LOW);
  // Internal pull-down: a floating pin (broken wire, divider not reaching GND) then reads LOW, so
  // "stuck HIGH" really means something is driving GPIO 11 high.
  pinMode(US_ECHO, INPUT_PULLDOWN);
}

void loop() {
  static uint32_t last = 0;
  if (millis() - last < 250) return;
  last = millis();
  // Wiring check: with no internal pull, only the divider's 2k to GND holds GPIO 11 low.
  // nopull=HIGH means GPIO 11 isn't connected to the divider (floating).
  pinMode(US_ECHO, INPUT);
  delayMicroseconds(500);
  int nopull = digitalRead(US_ECHO);
  pinMode(US_ECHO, INPUT_PULLDOWN);
  delayMicroseconds(100);
  Serial.printf("nopull=%s  ", nopull ? "HIGH(floating?)" : "LOW(divider ok)");
  int idle = digitalRead(US_ECHO);
  digitalWrite(US_TRIG, HIGH);
  delayMicroseconds(10);
  digitalWrite(US_TRIG, LOW);
  uint32_t t0 = micros();
  // Wait up to 5 ms for ECHO to go high (the HC-SR04 raises it ~0.25-0.5 ms after TRIG).
  while (!digitalRead(US_ECHO) && micros() - t0 < 5000) {}
  uint32_t riseUs = micros() - t0;
  if (!digitalRead(US_ECHO)) {
    Serial.printf("idle=%s  NO RISE within 5 ms\n", idle ? "HIGH" : "LOW");
    return;
  }
  uint32_t t1 = micros();
  while (digitalRead(US_ECHO) && micros() - t1 < 60000) {}
  uint32_t pulse = micros() - t1;
  Serial.printf("idle=%s  rise after %lu us  pulse %lu us  -> %s\n", idle ? "HIGH" : "LOW", (unsigned long)riseUs,
                (unsigned long)pulse,
                pulse >= 60000 ? "stuck HIGH" : pulse > 25000 ? "nothing in range" : String(pulse * 0.0343f / 2, 1).c_str());
}
