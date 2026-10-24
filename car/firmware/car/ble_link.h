// BLE "UART" link for the car: a Nordic UART Service (NUS) style GATT peripheral.
//   service 6e400001-...  RX 6e400002 (central writes to us)  TX 6e400003 (we notify)
// Framing: newline-terminated text lines (the same JSON messages as the WebSocket link), split
// into chunks that fit the negotiated MTU and re-joined at '\n' on the other side. That way it
// works whatever MTU Windows/Chrome/Android settle on (as low as the 20-byte BLE default).
//
// BLE callbacks run on the Bluetooth host task; readLine()/sendLine() are meant for one other
// task (the car's network task). The receive buffer is shared under a spinlock.
#pragma once

#include <BLE2902.h>
#include <BLEDevice.h>
#include <BLEServer.h>

#define NUS_SERVICE_UUID "6e400001-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_RX_UUID "6e400002-b5a3-f393-e0a9-e50e24dcca9e"
#define NUS_TX_UUID "6e400003-b5a3-f393-e0a9-e50e24dcca9e"

class BleLink : public BLEServerCallbacks, public BLECharacteristicCallbacks {
 public:
  void begin(const char* name) {
    BLEDevice::init(name);
    BLEDevice::setMTU(247);  // ask for big packets; the central decides
    server_ = BLEDevice::createServer();
    server_->setCallbacks(this);
    BLEService* svc = server_->createService(NUS_SERVICE_UUID);
    tx_ = svc->createCharacteristic(NUS_TX_UUID, BLECharacteristic::PROPERTY_NOTIFY);
    tx_->addDescriptor(new BLE2902());
    BLECharacteristic* rx =
        svc->createCharacteristic(NUS_RX_UUID, BLECharacteristic::PROPERTY_WRITE | BLECharacteristic::PROPERTY_WRITE_NR);
    rx->setCallbacks(this);
    svc->start();
    BLEAdvertising* adv = BLEDevice::getAdvertising();
    adv->addServiceUUID(NUS_SERVICE_UUID);
    adv->setScanResponse(true);  // name goes in the scan response, UUID in the advert
    BLEDevice::startAdvertising();
  }

  bool connected() const { return connected_; }
  uint32_t connectCount() const { return connects_; }

  // Bytes per notification: negotiated MTU minus the 3-byte ATT header.
  size_t chunkSize() {
    uint16_t mtu = connected_ ? server_->getPeerMTU(server_->getConnId()) : 23;
    if (mtu < 23) mtu = 23;
    if (mtu > 247) mtu = 247;
    return mtu - 3;
  }

  // Pop one complete received line (without '\n'). Returns false if none is waiting.
  bool readLine(String& out) {
    bool got = false;
    portENTER_CRITICAL(&mux_);
    int nl = rx_.indexOf('\n');
    if (nl >= 0) {
      out = rx_.substring(0, nl);
      rx_.remove(0, nl + 1);
      got = true;
    }
    portEXIT_CRITICAL(&mux_);
    if (got && out.endsWith("\r")) out.remove(out.length() - 1);
    return got;
  }

  // Send one line (a '\n' is appended), chunked to the MTU.
  void sendLine(const String& line) {
    if (!connected_) return;
    String data = line + "\n";
    size_t chunk = chunkSize();
    for (size_t i = 0; i < data.length(); i += chunk) {
      size_t n = min(chunk, data.length() - i);
      tx_->setValue((uint8_t*)data.c_str() + i, n);
      tx_->notify();
      // Back-to-back notifications can overrun the stack's buffers on a small MTU. Only this
      // (network) task waits; the motor loop runs on the other core.
      if (i + n < data.length()) vTaskDelay(pdMS_TO_TICKS(4));
    }
  }

  // ---- BLE callbacks (Bluetooth host task) ----
  void onConnect(BLEServer*) override {
    portENTER_CRITICAL(&mux_);
    rx_ = "";
    portEXIT_CRITICAL(&mux_);
    connects_++;
    connected_ = true;
  }

  void onDisconnect(BLEServer*) override {
    connected_ = false;
    BLEDevice::startAdvertising();  // be findable again straight away
  }

  void onWrite(BLECharacteristic* c) override {
    String v = c->getValue();
    portENTER_CRITICAL(&mux_);
    if (rx_.length() + v.length() > 2048) rx_ = "";  // garbage without newlines: drop it
    rx_ += v;
    portEXIT_CRITICAL(&mux_);
  }

 private:
  BLEServer* server_ = nullptr;
  BLECharacteristic* tx_ = nullptr;
  String rx_;
  portMUX_TYPE mux_ = portMUX_INITIALIZER_UNLOCKED;
  volatile bool connected_ = false;
  volatile uint32_t connects_ = 0;
};
