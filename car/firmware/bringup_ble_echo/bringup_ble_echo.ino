// Bring-up 4: BLE. Advertises as "mapper-car" with a Nordic-UART-style service and echoes every
// received line back. Test it from Chrome with car/teleop/ble-test.html (open it from localhost
// or the server so Web Bluetooth is allowed). Serial monitor at 115200 shows what arrives.
#include "../car/ble_link.h"

BleLink ble;

void setup() {
  Serial.begin(115200);
  ble.begin("mapper-car");
  Serial.println("[ble] advertising as mapper-car");
}

void loop() {
  static bool was = false;
  if (ble.connected() != was) {
    was = ble.connected();
    Serial.printf("[ble] central %s (mtu %u)\n", was ? "connected" : "disconnected", (unsigned)(ble.chunkSize() + 3));
  }
  String line;
  while (ble.readLine(line)) {
    Serial.printf("[ble] rx %u bytes: %s\n", (unsigned)line.length(), line.c_str());
    ble.sendLine(line);  // echo
  }
  delay(2);  // bring-up sketch: no motors here, a short sleep is fine
}
