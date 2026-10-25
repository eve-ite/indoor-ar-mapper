// Bring-up 1: spin each stepper one wheel turn forward, then back. Left first, then right.
// Watch that each wheel turns the way the car should drive "forward" on the forward leg;
// if not, flip LEFT_DIR / RIGHT_DIR in ../car/config.h. Serial monitor at 115200.
// If a motor just buzzes/vibrates: IN pin order or wiring is off, or the supply is too weak.
#include <AccelStepper.h>

#include "../car/config.h"

AccelStepper left(STEP_INTERFACE, LEFT_IN1, LEFT_IN3, LEFT_IN2, LEFT_IN4);
AccelStepper right(STEP_INTERFACE, RIGHT_IN1, RIGHT_IN3, RIGHT_IN2, RIGHT_IN4);

AccelStepper* motors[] = {&left, &right};
const int dirs[] = {LEFT_DIR, RIGHT_DIR};
const char* names[] = {"LEFT", "RIGHT"};
int phase = 0;  // motor = phase / 2, forward on even phases

void startPhase() {
  int m = (phase / 2) % 2;
  bool fwd = phase % 2 == 0;
  long target = (fwd ? 1 : 0) * dirs[m] * STEPS_PER_REV;
  motors[m]->enableOutputs();
  motors[m]->moveTo(target);
  Serial.printf("%s wheel %s (to %ld steps)\n", names[m], fwd ? "FORWARD one turn" : "back", target);
}

void setup() {
  Serial.begin(115200);
  for (auto* m : motors) {
    m->setMaxSpeed(MAX_STEP_RATE);
    m->setAcceleration(ACCEL_STEPS / 2);
    m->disableOutputs();
  }
  startPhase();
}

void loop() {
  int m = (phase / 2) % 2;
  motors[m]->run();  // non-blocking: one step at most per call
  if (motors[m]->distanceToGo() == 0) {
    motors[m]->disableOutputs();
    phase++;
    startPhase();
  }
}
