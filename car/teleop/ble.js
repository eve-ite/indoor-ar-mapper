// Web Bluetooth link to the car (firmware CONTROL_LINK = LINK_BLE): Nordic-UART-style service,
// '\n'-terminated JSON lines, chunked on write and re-joined on notify.
// Needs Chrome/Edge (Brave disables Web Bluetooth) and a secure context (localhost or https).

const NUS = '6e400001-b5a3-f393-e0a9-e50e24dcca9e';
const RX = '6e400002-b5a3-f393-e0a9-e50e24dcca9e'; // we write
const TX = '6e400003-b5a3-f393-e0a9-e50e24dcca9e'; // car notifies
const NAME = 'mapper-car';

export const bleSupported = () => !!navigator.bluetooth;

export class BleCar {
  constructor({ onLine, onDisconnect }) {
    this.onLine = onLine;
    this.onDisconnect = onDisconnect;
    this.device = null;
    this.rx = null;
    this.buf = '';
    this.chunk = 180; // try big writes first; drop to 20 if the link's MTU is the default
    this.pending = null; // newest line not yet written (latest wins: drive commands never queue)
    this.writing = false;
  }

  get connected() {
    return !!this.device?.gatt.connected && !!this.rx;
  }

  async connect() {
    this.device = await navigator.bluetooth.requestDevice({ filters: [{ name: NAME }], optionalServices: [NUS] });
    this.device.addEventListener('gattserverdisconnected', () => {
      this.rx = null;
      this.onDisconnect?.();
    });
    const server = await this.device.gatt.connect();
    const svc = await server.getPrimaryService(NUS);
    this.rx = await svc.getCharacteristic(RX);
    this.noResponse = !!this.rx.properties.writeWithoutResponse;
    const tx = await svc.getCharacteristic(TX);
    tx.addEventListener('characteristicvaluechanged', (e) => this.#onNotify(e));
    await tx.startNotifications();
  }

  disconnect() {
    this.device?.gatt.disconnect();
  }

  #onNotify(e) {
    this.buf += new TextDecoder().decode(e.target.value);
    if (this.buf.length > 8192) this.buf = '';
    let i;
    while ((i = this.buf.indexOf('\n')) >= 0) {
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      this.onLine?.(line);
    }
  }

  // Queue a line; if a write is in flight, it replaces any older waiting line.
  send(line) {
    if (!this.connected) return;
    this.pending = line;
    if (!this.writing) this.#pump();
  }

  async #pump() {
    this.writing = true;
    try {
      while (this.pending !== null && this.connected) {
        const line = this.pending;
        this.pending = null;
        await this.#write(new TextEncoder().encode(line + '\n'));
      }
    } catch (err) {
      console.warn('BLE write failed:', err);
    } finally {
      this.writing = false;
    }
  }

  async #write(data) {
    for (let i = 0; i < data.length; ) {
      const part = data.slice(i, i + this.chunk);
      try {
        await (this.noResponse ? this.rx.writeValueWithoutResponse(part) : this.rx.writeValueWithResponse(part));
        i += part.length;
      } catch (err) {
        if (this.chunk > 20) {
          this.chunk = 20; // value too long for this MTU: retry the same bytes in small chunks
          continue;
        }
        throw err;
      }
    }
  }
}
