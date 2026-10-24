// Copy this file to secrets.h (same folder) and fill it in. secrets.h is gitignored.
// Everything here can also be changed later over the serial monitor without reflashing
// (type "help" at 115200 baud), which matters because quick-tunnel URLs change on restart.
#pragma once

#define WIFI_SSID "your-network"
#define WIFI_PASS "your-password"

// Venue wifi (client isolation, no hotspots): dial out to the cloudflared tunnel.
//   SERVER_HOST "something-random.trycloudflare.com", SERVER_PORT 443, SERVER_TLS 1
// Home / same LAN as the laptop:
//   SERVER_HOST "192.168.1.50", SERVER_PORT 8000, SERVER_TLS 0
#define SERVER_HOST "something-random.trycloudflare.com"
#define SERVER_PORT 443
#define SERVER_TLS 1
