// Bring-up: scan 2.4 GHz WiFi every 10 s and print what the car could join (115200 baud).
// The ESP32-S3 has no 5 GHz radio. "ENTERPRISE" (802.1X, eduroam-style) networks need a
// username/password login the car firmware doesn't support; use BLE mode or ask for an IoT network.
#include <WiFi.h>

static const char* authName(wifi_auth_mode_t a) {
  switch (a) {
    case WIFI_AUTH_OPEN: return "OPEN";
    case WIFI_AUTH_WEP: return "WEP";
    case WIFI_AUTH_WPA_PSK: return "WPA";
    case WIFI_AUTH_WPA2_PSK: return "WPA2";
    case WIFI_AUTH_WPA_WPA2_PSK: return "WPA/WPA2";
    case WIFI_AUTH_WPA2_ENTERPRISE: return "ENTERPRISE";
    case WIFI_AUTH_WPA3_PSK: return "WPA3";
    case WIFI_AUTH_WPA2_WPA3_PSK: return "WPA2/WPA3";
    default: return "OTHER";
  }
}

void scan() {
  Serial.println("scanning...");
  int n = WiFi.scanNetworks(false, true);  // include hidden networks
  if (n <= 0) {
    Serial.println(n == 0 ? "no networks found" : "scan failed");
    return;
  }
  Serial.printf("%d networks (strongest first):\n", n);
  Serial.println("  RSSI  CH  SECURITY     BSSID              SSID");
  for (int i = 0; i < n; i++) {
    String ssid = WiFi.SSID(i);
    Serial.printf("  %4d  %2ld  %-11s  %s  %s\n", WiFi.RSSI(i), (long)WiFi.channel(i), authName(WiFi.encryptionType(i)),
                  WiFi.BSSIDstr(i).c_str(), ssid.length() ? ssid.c_str() : "(hidden)");
  }
  WiFi.scanDelete();
}

void setup() {
  Serial.begin(115200);
  WiFi.mode(WIFI_STA);
  WiFi.disconnect();
}

void loop() {
  static uint32_t last = 0;
  if (last && millis() - last < 10000) return;
  last = millis();
  scan();
}
