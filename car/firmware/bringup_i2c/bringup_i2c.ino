// Bring-up 2: I2C scan, then MPU6050 readout. Serial monitor at 115200.
// Expect a device at 0x68 (0x69 if AD0 is high). Lie the board flat: accel Z ~ +1 g, gyro ~ 0.
// Rotate it about the vertical axis: gyro Z (= yaw rate) should swing positive turning left.
#include <Wire.h>

#include "../car/config.h"

bool found = false;

void setup() {
  Serial.begin(115200);
  uint32_t t0 = millis();
  while (!Serial && millis() - t0 < 2000) {}
  Wire.begin(I2C_SDA, I2C_SCL, 400000);
  Wire.setTimeOut(5);
  Serial.printf("I2C scan on SDA=%d SCL=%d\n", I2C_SDA, I2C_SCL);
  for (uint8_t a = 1; a < 127; a++) {
    Wire.beginTransmission(a);
    if (Wire.endTransmission() == 0) {
      Serial.printf("  device at 0x%02X%s\n", a, a == MPU_ADDR ? "  <- MPU6050" : "");
      if (a == MPU_ADDR) found = true;
    }
  }
  if (!found) {
    Serial.println("No MPU6050 at MPU_ADDR. Check 3V3/GND, SDA/SCL swapped, AD0 level.");
    return;
  }
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x75);  // WHO_AM_I
  Wire.endTransmission(false);
  Wire.requestFrom(MPU_ADDR, 1);
  Serial.printf("WHO_AM_I = 0x%02X (0x68 genuine; 0x70/0x72/0x98 are common clones, still fine)\n", Wire.read());
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x6B);
  Wire.write(0x00);  // wake up
  Wire.endTransmission();
}

void loop() {
  static uint32_t last = 0;
  if (!found || millis() - last < 200) return;
  last = millis();
  Wire.beginTransmission(MPU_ADDR);
  Wire.write(0x3B);  // ACCEL_XOUT_H .. GYRO_ZOUT_L
  if (Wire.endTransmission(false) != 0 || Wire.requestFrom(MPU_ADDR, 14) != 14) {
    Serial.println("read failed");
    return;
  }
  int16_t v[7];
  for (auto& x : v) x = (Wire.read() << 8) | Wire.read();
  // Defaults: accel +-2 g (16384 LSB/g), gyro +-250 deg/s (131 LSB per deg/s).
  Serial.printf("accel g  %+.2f %+.2f %+.2f   gyro rad/s  %+.3f %+.3f %+.3f   temp %.1f C\n",
                v[0] / 16384.0, v[1] / 16384.0, v[2] / 16384.0,
                v[4] / 131.0 * DEG_TO_RAD, v[5] / 131.0 * DEG_TO_RAD, v[6] / 131.0 * DEG_TO_RAD,
                v[3] / 340.0 + 36.53);
}
