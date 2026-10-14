// state.js — UI 状态 + ring buffer + 事件日志（协议统计在 Ch32Session 内）
export class Ring {
  constructor(capacity, channels) { this.cap = capacity; this.ch = channels; this.t = new Float64Array(capacity); this.v = Array.from({ length: channels }, () => new Float32Array(capacity)); this.n = 0; this.head = 0; }
  push(t, values) { const i = this.head; this.t[i] = t; for (let c = 0; c < this.ch; c++) this.v[c][i] = values[c] ?? NaN; this.head = (i + 1) % this.cap; if (this.n < this.cap) this.n++; }
  clear() { this.n = 0; this.head = 0; }
  idx(k) { return (this.head - this.n + k + this.cap) % this.cap; } // k: 0 = 最旧
  last() { return this.n ? this.idx(this.n - 1) : -1; }
}
export function createState() {
  return {
    events: [], relativeZero: false, accelUnit: 'ms2',
    plots: { attitude: new Ring(20000, 3), gyro: new Ring(20000, 3), accel: new Ring(20000, 3) },
    raw: { on: false, lines: [], dropped: 0, max: 200000 },
    rec: null, drift: null,
  };
}
export function logEvent(state, text, level = 'info') {
  const d = new Date(); const p = (x) => String(x).padStart(2, '0');
  state.events.unshift({ time: `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`, text, level });
  if (state.events.length > 40) state.events.length = 40;
}
