// mock-serial.js — 用 MockCh32Device（模拟固件 20261003m）模拟 WCH-Link 串口（?mock=1 或测试注入）。不是实板。
import { MockCh32Device } from './mock-device.js';
export function createMockPort(opts = {}) {
  let device = null, timer = null, ctrl = null, opened = false, lastT = 0;
  const port = {
    mock: true,
    getInfo: () => ({ usbVendorId: 0x1a86, usbProductId: 0x8010, mock: true }),
    get device() { return device; },
    async open(o) {
      if (opened) throw new DOMException('already open', 'InvalidStateError');
      port.openOptions = o; opened = true;
      port.readable = new ReadableStream({ start(c) { ctrl = c; } });
      port.writable = new WritableStream({ write(chunk) { device.write(chunk); } });
      device = port.device0 || new MockCh32Device({ ...opts, onTx: (b) => { try { ctrl.enqueue(b); } catch {} } });
      device.onTx = (b) => { try { ctrl.enqueue(b); } catch {} };
      port.device0 = device;
      lastT = performance.now();
      timer = setInterval(() => { const now = performance.now(); device.advance(Math.min(100, now - lastT)); lastT = now; }, 10);
    },
    async close() { clearInterval(timer); opened = false; try { ctrl.close(); } catch {} port.readable = null; port.writable = null; },
    signals: [], async setSignals(s) { port.signals.push(s); }, // 上位机不应调用（不切换 DTR/RTS）
    unplug() { clearInterval(timer); opened = false; try { ctrl.error(new DOMException('The device has been lost.', 'NetworkError')); } catch {} },
  };
  return port;
}
export function installMockSerial(opts = {}) {
  const port = createMockPort(opts);
  const serial = { requestPort: async () => port, getPorts: async () => [port], addEventListener() {}, mockPort: port };
  Object.defineProperty(navigator, 'serial', { value: serial, configurable: true });
  return port;
}
