// serial.js — Web Serial 传输层：2,000,000 8N1、无流控、不切换 DTR/RTS。协议事务全部在 protocol.js 的 Ch32Session。
import { Ch32Session, CMD, BAUD_RATE, ADAPTER_HINT } from './protocol.js';
export const SERIAL_OPTIONS = Object.freeze({ baudRate: BAUD_RATE, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536 });
export function describePort(info = {}) {
  const hex = (n) => n == null ? '????' : n.toString(16).toUpperCase().padStart(4, '0');
  const known = info.usbVendorId === ADAPTER_HINT.usbVendorId && info.usbProductId === ADAPTER_HINT.usbProductId;
  return `${hex(info.usbVendorId)}:${hex(info.usbProductId)}${known ? ' WCH-Link' : ''}${info.mock ? '（Mock）' : ''}`;
}
export class Ch32Serial {
  constructor({ onSample = () => {}, onEvent = () => {}, onChange = () => {}, pollMs = 1000 } = {}) {
    this.onSample = onSample; this.onEvent = onEvent; this.onChange = onChange; this.pollMs = pollMs;
    this.port = null; this.reader = null; this.writer = null; this.session = null; this.state = 'DISCONNECTED'; this.rawSink = null; this.pollTimer = null;
  }
  _set(s) { this.state = s; this.onChange(); }
  _newSession() {
    const s = new Ch32Session({
      write: (b) => this.writer.write(b), onEvent: this.onEvent, onSample: this.onSample, onUpdate: () => this.onChange(),
      rawLog: (dir, kind, bytes, t) => { if (this.rawSink) this.rawSink(dir, kind, bytes, t); },
    });
    return s;
  }
  async connect(port) {
    if (this.port) await this.disconnect();
    this._set('CONNECTING');
    try { await port.open(SERIAL_OPTIONS); }
    catch (e) { this._set('DISCONNECTED'); throw new Error(/already open|InvalidState/i.test(e.message + e.name) ? '串口已被占用：请关闭占用该端口的软件（如串口助手 / VOFA+）后重试' : `打开串口失败：${e.message}`); }
    this.port = port; this.info = port.getInfo ? port.getInfo() : {};
    this.writer = port.writable.getWriter();
    this.session = this._newSession();
    this._readLoop(port);
    this._set('HANDSHAKE');
    try { await this.session.handshake({ settleMs: 200 }); }
    catch (e) { this.onEvent('error', `握手失败：${e.message}`); this._set('ERROR'); throw e; }
    this._set('CONNECTED');
    this._startPoll();
  }
  async _readLoop(port) {
    const reader = this.reader = port.readable.getReader();
    try {
      for (;;) { const { value, done } = await reader.read(); if (done) break; if (value && this.session) this.session.feed(value); }
    } catch (e) { if (this.port === port) { this.onEvent('error', `串口断开：${e.message}`); this._teardown(); } }
    finally { try { reader.releaseLock(); } catch {} }
  }
  // 1 Hz 0x14：只在空闲时发送（一次只有一条命令）
  _startPoll() {
    clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => { const s = this.session; if (s && this.state === 'CONNECTED' && !s.busy && !s.pending && !s.otaActive) s.command(CMD.QUERY_STATUS).catch(() => {}); }, this.pollMs);
  }
  async updateFirmware(image, options = {}) {
    if (this.state !== 'CONNECTED') throw new Error('设备未连接');
    const { uploadFirmware } = await import('./ota.js');
    this._set('UPDATING');
    try {
      const result = await uploadFirmware(this.session, image, options);
      await this.session.handshake({ settleMs: 0 });
      this._set('CONNECTED'); return result;
    } catch (e) {
      if (this.port) this._set('ERROR');
      throw e;
    }
  }
  _teardown() {
    clearInterval(this.pollTimer); this.pollTimer = null;
    if (this.session) this.session.cancelAll('串口已关闭');
    this.port = null; this.reader = null; this.writer = null; this._set('DISCONNECTED');
  }
  async disconnect() {
    const port = this.port; if (!port) return;
    clearInterval(this.pollTimer);
    if (this.session) this.session.cancelAll('已断开');
    this.port = null;
    try { await this.reader?.cancel(); } catch {}
    try { this.writer?.releaseLock(); } catch {}
    try { await port.close(); } catch {}
    this._teardown();
  }
}
