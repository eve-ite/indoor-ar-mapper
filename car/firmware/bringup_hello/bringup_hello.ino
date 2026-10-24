// Bring-up 0: does the board flash and talk? Prints once a second at 115200 on the COM/UART port.
// Board: ESP32S3 Dev Module, Flash 16MB, PSRAM OPI. On the native USB port, enable USB CDC On Boot.
void setup() {
  Serial.begin(115200);
}

void loop() {
  static uint32_t n = 0;
  static uint32_t last = 0;
  if (millis() - last < 1000) return;
  last = millis();
  Serial.printf("hello from mapper-car #%lu  chip %s rev %d, %d cores, flash %lu MB, psram %lu KB free\n", (unsigned long)n++,
                ESP.getChipModel(), ESP.getChipRevision(), ESP.getChipCores(), (unsigned long)(ESP.getFlashChipSize() >> 20),
                (unsigned long)(ESP.getFreePsram() >> 10));
}
