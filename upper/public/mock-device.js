// mock-device.js — 模拟 CH32 固件 UART 行为（Mock 固件文本 20261003m）。不是实板，结果不能代替 COM4 实测。
// 依据：交接文档 ch32-handoff-20261003.md §4–§9 + 固件侧对 App/app_command.c（20261003b）的核对；仍未确认的行为见 MOCK_UNCONFIRMED。
import {
  MSG, CMD, ACK, FORMAT, MASK_ALL, OUTPUT_HZ, CUSTOM_FIELDS, G, SYNC1, SYNC2, MAX_PAYLOAD, FLASH_DETAIL,
  crc16, encodeFrame, encodeMessage, encodeCustom, encodeJustFloat, popcount, FILTER_PROFILES,
} from './protocol.js';
import { crc32, inspectImage } from './ota.js';
export const MOCK_FW_TEXT = '20261003m';
export const MOCK_SOURCE = 'App/app_command.c (20261003h)';
// 以下行为已由固件侧对照 app_command.c（20261003b）确认
export const MOCK_ASSUMPTIONS = Object.freeze([
  '已确认（app_command.c 20261003b）：参数先校验（非法 → status 2，detail 0），再检查设置模式；0x27 / 0x19 在设置模式外 → status 3，detail 0',
  '已确认：0x1C 在设置模式外 → status 2 / detail 0x0602',
  '已确认：0x15 复位先发 ACK、等 TX 队列排空再复位，从 Flash 载入已保存配置（RAM 临时设置丢失）；SEQ 从 0，timestamp = 开机 ms & 0xFFFF；重启耗时不固定（Mock 用随机延时）',
  '已确认：非法参数只回 ACK；写 Flash 的设置（0x1D，或 0x20 / 0x27 persist=1）失败 → status 3 / 0x0607，仍附 0x07 / 0x0B 现有配置',
  '已确认：设置模式内遥测照常；Flash 写入期间遥测暂停并丢弃排队帧（SEQ 跳号）',
  '已确认：0x20 port≠0（USB）→ status 3；0x1D 频率必须整除 2000，否则 status 2',
  '已确认：收到 vofa 自动切 RAM JustFloat（保留 mask）',
  '已确认（ch32-sixface-20261003b）：caps 0xC4；0x1C 空 payload、模式外 2/0602、进行中 3/0604；成功 ACK 0/0x0100 + 0x0A，之后每 200 ms 推送 0x0A（启动 SEQ）；结束发最终 ACK（启动 SEQ）+ 一帧 0x0A',
  '已确认（app_device.c L70）：校准期间遥测只在 phase==SAVING 暂停，该阶段只出现一次（第 6 面完成后、最终 ACK 前），上位机可能看不到 SAVING 的 0x0A',
  '已确认（20261003 复核）：进入 phase 3 清掉已排队遥测帧（SEQ 已分配，跳号可能早于 mask 0x3F 可见）；0x0607 经过 phase 3（清队列 + 写 Flash + 暂停）；0x0603 / 0x0605 / 0x0606 不写 Flash、不暂停遥测',
  '已确认：0x25 / 0x18 取消 → 稍后最终 ACK 3/0x0608；未在校准时 0x25 只回 ACK + 0x0A（无最终 ACK）；校准中 0x15 复位不发最终 ACK；保存失败只报 0x0607（0x0609 实际不出现）；校准中 0x1D 与 persist=1 的 0x20/0x27 → 3/0x0604；0x24 只回 0x0A（无 ACK）；固件不阻止 0x15',
]);
// 仍是 Mock 自行假设（固件未给出数值或未接入）
export const MOCK_UNCONFIRMED = Object.freeze([
  '重启耗时：Mock 取 120–900 ms 随机（实板未给数值）',
  'Flash 写入暂停时长：Mock 取 25–60 ms 随机',
  '六面校准时序：Mock 每面 等待放置 / 稳定 / 采样 默认 0.8 / 0.5 / 1.2 s（实板由用户翻面决定），保存 0.3 s；bias / scale 数值为 Mock 虚构',
  '温度 ~31 °C 缓慢变化；设备时钟比 PC 快 0.84%（clockSkew）',
]);
function rng(seed) { let s = (seed >>> 0) || 1; return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; } // mulberry32
export class MockCh32Device {
  constructor({ onTx = () => {}, seed = 1, outputHz = 200, format = FORMAT.CUSTOM, mask = MASK_ALL, legacy = 0, filter = 1, clockSkew = 1.0084,
    chunk = 0, noise = 0, failFlash = false, sensorOk = true, replyDelayMs = 0, dropReplies = 0, rebootMs = null, flashPauseMs = null,
    calScenario = 'ok', calTiming = {}, calFaceTimeoutMs = 60000, fwText = null, profileCount = null } = {}) {
    this.onTx = onTx; this.rand = rng(seed);
    this.saved = { hz: outputHz, format, mask, legacy, filter };
    this.opts = { chunk, noise, clockSkew, rebootMs, replyDelayMs, flashPauseMs }; // rebootMs / flashPauseMs = null → 随机
    // 六面校准场景：ok | timeout（不放置 → 0x0603）| shake（第 2 面采样中晃动）| duplicate（第 2 面放回第 1 面）| fitFail（0x0606）| saveFail（保存失败 → 0x0607；固件不会发 0x0609）
    this.profileCount = profileCount ?? (/^20261003[b-f]$/.test(fwText || '') ? 3 : 4);
    this.coreVqf = !fwText || fwText === '20261003h' || fwText === MOCK_FW_TEXT;
    this.fwText = fwText; // 固件文本可换（20261003c / d 等，协议不变）
    this.calScenario = calScenario; this.calFaceTimeoutMs = calFaceTimeoutMs;
    this.calTiming = { place: 800, settle: 500, sample: 1200, save: 300, cancelFinal: 120, shake: 600, dup: 600, txQueue: 12, ...calTiming }; // txQueue：校准期间遥测在 UART 发送队列中的停留 ms（进入 phase 3 时被清掉）
    this.telQ = [];
    this.calSaved = { valid: 0, bias: [0, 0, 0], scale: [1, 1, 1] }; this.calRec = null; this.calFinalOverride = null; this.calStarts = 0;
    this.failFlash = failFlash; this.sensorOk = sensorOk; this.dropReplies = dropReplies; this.dropReplyFor = new Set(); this.droppedFor = [];
    this.flashWrites = 0; this.resets = 0; this.rxCommands = []; this.rxErrors = 0; this.delayed = [];
    this.rx = new Uint8Array(0); this.t = 0; this._boot();
  }
  _boot() {
    const s = this.saved;
    this.active = { hz: s.hz, format: s.format, mask: s.mask, legacy: s.legacy, filter: s.filter };
    this.ota = null; this.settings = false; this.telSeq = 0; this.devMs = 0; this.acc = 0; this.yawOffset = 0; this.fusion = 0; this.silentUntil = 0; this.flashPauseUntil = 0; this.lossUntil = 0;
  }
  get config() {
    const a = this.active;
    return { version: 3, source: 0, active_fusion_mode: this.fusion, saved_fusion_mode: 0, active_fast_start: 0, saved_fast_start: 0, capabilities: 0xc4, reserved: 0,
      output_hz: a.hz, uart_format: a.format, uart_legacy: a.legacy, uart_mask: a.mask, usb_format: 1, usb_legacy: 0, usb_mask: 0,
      active_gyro_init_ms: 0, saved_gyro_init_ms: 0, active_gyro_range_dps: 125, saved_gyro_range_dps: 125, saved_output_hz: this.saved.hz };
  }
  get filterConfig() { const p = FILTER_PROFILES[this.active.filter]; return { version: 1, active_profile: this.active.filter, saved_profile: this.saved.filter, profile_count: this.profileCount, estimator_hz: 2000, reserved: 0, tau_mag_s: 0, rest_tau_s: this.coreVqf ? p.tauAccS : p.restTauS }; }
  get temperature() { return 31.25 + 0.4 * Math.sin(this.t / 60000); }
  _tx(bytes) {
    if (this.opts.chunk > 0) { for (let i = 0; i < bytes.length;) { const n = 1 + Math.floor(this.rand() * this.opts.chunk); this.onTx(bytes.slice(i, i + n)); i += n; } }
    else this.onTx(bytes);
  }
  _reply(bytes) {
    if (this.dropReplies > 0) { this.dropReplies--; return; }
    if (this.opts.replyDelayMs > 0) { this.delayed.push({ at: this.t + this.opts.replyDelayMs, bytes }); return; }
    this._tx(bytes);
  }
  // ---------- 接收：AA55 帧 + 帧外 ASCII vofa ----------
  write(bytes) {
    if (this.t < this.silentUntil) return;
    const b = new Uint8Array(this.rx.length + bytes.length); b.set(this.rx); b.set(bytes, this.rx.length);
    let i = 0;
    while (i < b.length) {
      if (b[i] === SYNC1) {
        if (i + 5 > b.length) break;
        if (b[i + 1] === SYNC2) {
          const len = b[i + 3];
          if (len <= MAX_PAYLOAD) {
            if (i + 7 + len > b.length) break;
            const crc = b[i + 5 + len] | (b[i + 6 + len] << 8);
            if (crc16(b, i + 2, i + 5 + len) === crc) { this._command(b[i + 2], b[i + 4], b.slice(i + 5, i + 5 + len)); i += 7 + len; continue; }
          }
          this.rxErrors++;
        }
      }
      if ((b[i] | 0x20) === 0x76) { // 'v'
        if (i + 4 > b.length) break;
        if (String.fromCharCode(...b.slice(i, i + 4)).toLowerCase() === 'vofa') { this.active.format = FORMAT.JUSTFLOAT; this.vofaCount = (this.vofaCount || 0) + 1; i += 4; continue; }
      }
      i++;
    }
    this.rx = b.slice(i);
  }
  _ack(cmd, seq, status = ACK.OK, detail = 0) { return encodeMessage(MSG.ACK, seq, { cmd_id: cmd, status, detail }); }
  _cfg(seq) { return encodeMessage(MSG.DEVICE_CONFIG, seq, this.config); }
  _flt(seq) { return encodeMessage(MSG.FILTER_CONFIG, seq, this.filterConfig); }
  // 测试用：模拟链路丢帧 ms（不是 Flash 暂停，上位机应计为真实丢失）
  _flushTelQ() { const n = this.telQ.length; this.telQ = []; this.calQueueFlushed = (this.calQueueFlushed || 0) + n; this.calSaveDropped = (this.calSaveDropped || 0) + n; this.droppedDuringFlash = (this.droppedDuringFlash || 0) + n; }
  injectLoss(ms) { this.lossUntil = this.t + ms; }
  get calRunning() { return this.calRec?.state === 1; }
  _calObj() {
    const c = this.calRec || { state: 0, phase: 0, face: 0, mask: 0, progress: 0, error: 0, samples: 0, elapsed: 0, left: 0, raw: [0, 0, 1] };
    return { version: 1, state: c.state, phase: c.phase, face: c.face, done_mask: c.mask, one: 1, flash_valid: this.calSaved.valid, reserved: 0, progress: Math.round(c.progress), error: c.error,
      samples: Math.round(c.samples), elapsed_ms: Math.round(c.elapsed), left_ms: Math.round(c.left), bias_g: this.calSaved.bias, scale: this.calSaved.scale, raw_g: c.raw };
  }
  _accCal(seq) { return encodeMessage(MSG.ACC_CAL, seq, this._calObj()); }
  _calStart(seq) {
    this.calStarts++;
    this.calRec = { seq, state: 1, phase: 0, face: 0, mask: 0, progress: 0, error: 0, samples: 0, elapsed: 0, left: this.calFaceTimeoutMs, raw: [0, 0, 1], phaseT: 0, faceStart: this.t, pushT: 0, order: [6, 5, 2, 1, 4, 3], shaken: false, dupDone: false };
  }
  // 结束：最终 ACK（启动 SEQ）+ 一帧 0x0A
  _calEnd(state, error, delayMs = 0) {
    const c = this.calRec; c.state = state; c.error = error; c.phase = state === 2 ? 4 : state === 3 ? 7 : c.phase;
    // 测试注入 calFinalOverride：{ omit0A: true } 不发 ACK 后的 0x0A；{ mask } 改写 ACK 后 0x0A 的 done_mask（交叉校验用）
    const o = this.calFinalOverride, tail = () => o?.omit0A ? new Uint8Array(0) : o?.mask != null ? encodeMessage(MSG.ACC_CAL, c.seq, { ...this._calObj(), done_mask: o.mask }) : this._accCal(c.seq);
    const bytes = () => this._cat(this._ack(0x1c, c.seq, error ? ACK.FAILED : ACK.OK, error), tail());
    if (delayMs > 0) { const b = bytes(); this.delayed.push({ at: this.t + delayMs, bytes: b }); } else this._tx(bytes());
  }
  _calCancel() { const c = this.calRec; c.state = 4; c.error = 0x0608; this._calEnd(4, 0x0608, this.calTiming.cancelFinal); }
  _calTick(ms) {
    const c = this.calRec; if (!c || c.state !== 1) return;
    const T = this.calTiming; c.elapsed += ms; c.phaseT += ms; c.pushT += ms;
    const next = () => c.order.find((f) => !(c.mask & (1 << (f - 1))));
    const faceVec = (f) => { const ax = (f - 1) >> 1, sg = (f & 1) ? -1 : 1, v = [0, 0, 0]; v[ax] = sg; return v; };
    if ([0, 1, 2, 5, 6].includes(c.phase)) { c.left = Math.max(0, this.calFaceTimeoutMs - (this.t - c.faceStart)); if (c.left === 0) { this._calEnd(3, 0x0603); return; } }
    switch (c.phase) {
      case 0: if (this.calScenario !== 'timeout' && c.phaseT >= T.place) {
        const done = popcount(c.mask);
        if (this.calScenario === 'duplicate' && done === 1 && !c.dupDone) { c.face = c.order[0]; c.phase = 6; }
        else { c.face = next(); c.phase = 1; }
        c.phaseT = 0; c.progress = 0;
      } break;
      case 6: if (c.phaseT >= T.dup) { c.dupDone = true; c.face = next(); c.phase = 1; c.phaseT = 0; } break;
      case 1: if (c.phaseT >= T.settle) { c.phase = 2; c.phaseT = 0; c.samples = 0; } break;
      case 5: if (c.phaseT >= T.shake) { c.phase = 1; c.phaseT = 0; c.progress = 0; c.samples = 0; } break;
      case 2:
        c.progress = Math.min(1000, c.phaseT / T.sample * 1000); c.samples = c.phaseT * 2;
        if (this.calScenario === 'shake' && popcount(c.mask) === 1 && !c.shaken && c.progress > 400) { c.shaken = true; c.phase = 5; c.phaseT = 0; break; }
        if (c.phaseT >= T.sample) {
          c.mask |= 1 << (c.face - 1); c.progress = 1000;
          if (popcount(c.mask) === 6) { if (this.calScenario === 'fitFail') return this._calEnd(3, 0x0606); /* 0x0606 拟合失败：不写 Flash、不暂停遥测 */ c.phase = 3; c.phaseT = 0; this.flashPauseUntil = this.t + T.save; this._flushTelQ(); /* app_device.c L70：遥测只在 phase==SAVING 暂停；进入时清掉已排队帧（SEQ 已分配） */ } else { c.phase = 0; c.phaseT = 0; c.faceStart = this.t; c.left = this.calFaceTimeoutMs; }
        } break;
      case 3: if (c.phaseT >= T.save) {
        if (this.calScenario === 'saveFail' || this.failFlash) return this._calEnd(3, 0x0607); // 保存失败一律 0x0607（固件不发 0x0609）
        this.flashWrites++; this.calSaved = { valid: 1, bias: [0.012, -0.008, 0.021], scale: [1.003, 0.998, 1.001] };
        return this._calEnd(2, 0);
      } break;
    }
    const n = () => (this.rand() - 0.5) * (c.phase === 5 ? 0.6 : 0.004);
    const v = c.face ? faceVec(c.face) : [0, 0, 1]; c.raw = v.map((x) => x * (c.phase === 3 ? 1 : 1) + n());
    if (c.pushT >= 200) { c.pushT = 0; this._tx(this._accCal(c.seq)); } // 进度推送：启动 SEQ
  }
  _sys(seq) { const a = this.active; return encodeMessage(MSG.SYSTEM_INFO, seq, { fusion_hz: 2000, output_hz: a.hz, skip: 2000 / a.hz, temperature_cdeg: Math.round(this.temperature * 100), stream_mode: a.format === FORMAT.LEGACY ? a.legacy : 0xff, can_ok: 1, reserved: 0 }); }
  _fw(seq) {
    const t = this.fwText || MOCK_FW_TEXT, tail = new Uint8Array(14); tail.set(new TextEncoder().encode(t).slice(0, 14));
    if (t.length <= 10 && (!this.fwText || /^20261003[e-hm]$/.test(t))) { tail[10] = 1; tail[12] = 0; tail[13] = 122; }
    return encodeMessage(MSG.FW_INFO, seq, { format: 1, text_len: t.length, text_bytes: tail });
  }
  _cat(...parts) { const n = parts.reduce((s, p) => s + p.length, 0), o = new Uint8Array(n); let k = 0; for (const p of parts) { o.set(p, k); k += p.length; } return o; } // ACK 与配置同一次写出（同一读取块）
  _command(cmd, seq, p) {
    if (this.t < this.silentUntil) return; // 复位中
    this.rxCommands.push(cmd);
    const ack = (st = 0, d = 0) => this._ack(cmd, seq, st, d), empty = p.length === 0, v = new DataView(p.buffer, p.byteOffset, p.length);
    const send = (b) => { if (this.dropReplyFor.has(cmd)) { this.dropReplyFor.delete(cmd); this.droppedFor.push(cmd); return; } this._reply(b); }; // dropReplyFor：只丢指定命令的一次应答
    // Flash 写入：成功时遥测暂停一段时间，期间产生的帧被丢弃（SEQ 继续递增 → 主机看到跳号）
    const flash = () => { if (this.failFlash) return false; this.flashWrites++; const ms = this.opts.flashPauseMs ?? (25 + this.rand() * 35); this.flashPauseUntil = this.t + ms; this.lastFlashPauseMs = ms; return true; };
    switch (cmd) {
      case CMD.PING: return send(empty ? ack() : ack(ACK.INVALID));
      case CMD.QUERY_STATUS: return empty ? send(this._sys(seq)) : send(ack(ACK.INVALID));
      case CMD.QUERY_CONFIG: return empty ? send(this._cfg(seq)) : send(ack(ACK.INVALID));
      case CMD.QUERY_FW_INFO: return empty ? send(this._fw(seq)) : send(ack(ACK.INVALID));
      case CMD.QUERY_ACC_CAL: return empty ? send(this._accCal(seq)) : send(ack(ACK.INVALID));
      case CMD.QUERY_FILTER: return empty ? send(this._flt(seq)) : send(ack(ACK.INVALID));
      case CMD.CANCEL_ACC_CAL: { if (!empty) return send(ack(ACK.INVALID)); const run = this.calRunning; if (run) { this.calRec.state = 4; this.calRec.error = 0x0608; } send(this._cat(ack(), this._accCal(seq))); if (run) this._calEnd(4, 0x0608, this.calTiming.cancelFinal); return; }
      case CMD.ZERO_YAW:
        if (!empty) return send(ack(ACK.INVALID));
        if (!this.sensorOk) return send(ack(ACK.FAILED));
        this.yawOffset = this._raw().yaw; return send(ack());
      case CMD.SET_STREAM_MODE:
        if (p.length !== 1 || p[0] > 4) return send(ack(ACK.INVALID));
        this.active.format = FORMAT.LEGACY; this.active.legacy = p[0]; return send(ack());
      case CMD.SYSTEM_RESET:
        if (!empty) return send(ack(ACK.INVALID));
        this._tx(ack()); // ACK 完整发出后复位；串口不重枚举
        if (this.calRunning) this.calLostByReset = (this.calLostByReset || 0) + 1; // 固件不阻止复位：校准被中断（不保存）
        this.calRec = null; this.telQ = []; this.resets++; this.delayed = []; this._boot(); this.lastRebootMs = this.opts.rebootMs ?? (120 + this.rand() * 780); this.silentUntil = this.t + this.lastRebootMs; this.rx = new Uint8Array(0); return;
      case CMD.ENTER_SETTINGS: if (!empty) return send(ack(ACK.INVALID)); this.settings = true; return send(ack());
      case CMD.EXIT_SETTINGS: if (!empty) return send(ack(ACK.INVALID)); this.settings = false; send(ack()); if (this.calRunning) this._calCancel(); return; // 退出设置模式也取消校准
      case CMD.SET_FUSION_MODE:
        if (p.length !== 2 || p[0] !== 0 || p[1] > 1) return send(ack(ACK.INVALID)); // 先校验参数
        if (!this.settings) return send(ack(ACK.FAILED)); // 设置模式外 → 3 / 0
        return send(ack());
      case CMD.SET_OUTPUT_HZ: {
        if (p.length !== 2 || v.getUint16(0, true) === 0 || 2000 % v.getUint16(0, true) !== 0) return send(ack(ACK.INVALID)); // 必须整除采样率 2000
        const hz = v.getUint16(0, true);
        if (this.calRunning) return send(ack(ACK.FAILED, 0x0604));
        if (!flash()) return send(this._cat(ack(ACK.FAILED, FLASH_DETAIL), this._cfg(seq))); // 不应用新值并回读现有配置
        this.saved.hz = hz; this.active.hz = hz; this.acc = 0; return send(this._cat(ack(), this._cfg(seq)));
      }
      case CMD.SET_OUTPUT_CONFIG: {
        if (p.length !== 5) return send(ack(ACK.INVALID));
        const port = p[0], format = p[1], mask = v.getUint16(2, true), persist = p[4];
        if (format > 1 || (mask & ~MASK_ALL) || persist > 1) return send(ack(ACK.INVALID));
        if (port !== 0) return send(ack(ACK.FAILED)); // 只有 UART（port 0）；USB 等其它端口 → status 3
        if (persist && this.calRunning) return send(ack(ACK.FAILED, 0x0604));
        if (persist && !flash()) return send(this._cat(ack(ACK.FAILED, FLASH_DETAIL), this._cfg(seq)));
        this.active.format = format; this.active.mask = mask;
        if (persist) { this.saved.format = format; this.saved.mask = mask; }
        return send(this._cat(ack(), this._cfg(seq)));
      }
      case CMD.SET_FILTER: {
        if (p.length !== 2 || p[0] >= this.profileCount || p[1] > 1) return send(ack(ACK.INVALID));
        if (!this.settings) return send(ack(ACK.FAILED)); // 参数先校验，再检查设置模式：模式外 → 3 / 0
        if (p[1] && this.calRunning) return send(ack(ACK.FAILED, 0x0604));
        if (p[1] && !flash()) return send(this._cat(ack(ACK.FAILED, FLASH_DETAIL), this._flt(seq)));
        this.active.filter = p[0]; if (p[1]) this.saved.filter = p[0];
        return send(this._cat(ack(), this._flt(seq)));
      }
      case CMD.OTA_BEGIN: {
        if (!this.settings) return send(ack(ACK.FAILED, 0x0701));
        if (this.calRunning) return send(ack(ACK.FAILED, 0x0604));
        if (p.length !== 20 || v.getUint32(0, true) < 512 || v.getUint32(0, true) > 31232 || v.getUint32(0, true) % 4) return send(ack(ACK.INVALID, 0x0702));
        if (this.failFlash) return send(ack(ACK.FAILED, 0x0705));
        this.ota = { data: new Uint8Array(v.getUint32(0, true)), crc: v.getUint32(4, true), off: 0, verified: false, lastOff: -1, last: null };
        return send(ack());
      }
      case CMD.OTA_WRITE: {
        if (p.length < 8 || p.length > 60 || p.length % 4) return send(ack(ACK.INVALID, 0x0702));
        const o = this.ota; if (!o || o.verified) return send(ack(ACK.FAILED, 0x0703));
        const off = v.getUint32(0, true), data = p.slice(4);
        if (off === o.lastOff && data.length === o.last?.length && data.every((b, i) => b === o.last[i])) return send(ack());
        if (off !== o.off || off + data.length > o.data.length || off % 256 + data.length > 256) return send(ack(ACK.FAILED, 0x0704));
        if (this.failFlash) { this.ota = null; return send(ack(ACK.FAILED, 0x0705)); }
        o.data.set(data, off); o.off += data.length; o.lastOff = off; o.last = data;
        return send(ack());
      }
      case CMD.OTA_END: {
        if (!empty) return send(ack(ACK.INVALID, 0x0702));
        const o = this.ota; if (!o) return send(ack(ACK.FAILED, 0x0703));
        if (o.verified) return send(ack());
        if (o.off !== o.data.length) return send(ack(ACK.FAILED, 0x0704));
        if (crc32(o.data) !== o.crc) { this.ota = null; return send(ack(ACK.FAILED, 0x0706)); }
        try { const end = new DataView(o.data.buffer).getUint32(260, true) - 0x400; o.image = inspectImage(o.data.slice(0, end)); }
        catch { this.ota = null; return send(ack(ACK.FAILED, 0x0708)); }
        o.verified = true; return send(ack());
      }
      case CMD.OTA_COMMIT: {
        if (!empty) return send(ack(ACK.INVALID, 0x0702));
        if (!this.ota?.verified) return send(ack(ACK.FAILED, 0x0707));
        if (this.failFlash) return send(ack(ACK.FAILED, 0x0705));
        const version = this.ota.image.version; send(ack()); this.otaCommits = (this.otaCommits || 0) + 1;
        this.fwText = version; this.coreVqf = version === '20261003h' || version === MOCK_FW_TEXT;
        this.profileCount = /^20261003[b-f]$/.test(version) ? 3 : 4;
        this._boot(); this.silentUntil = this.t + (this.opts.rebootMs ?? 150); return;
      }
      case CMD.OTA_ABORT:
        if (!empty) return send(ack(ACK.INVALID, 0x0702));
        this.ota = null; this.otaAborts = (this.otaAborts || 0) + 1; return send(ack(this.failFlash ? ACK.FAILED : ACK.OK, this.failFlash ? 0x0705 : 0));
      // ---- §9 未实现 ----
      case 0x12: case 0x1b: return send(ack(ACK.FAILED, 0x0601));
      case 0x16: return send(ack(ACK.FAILED));
      case 0x1e: return send([3, 5, 7].includes(p.length) ? ack(ACK.FAILED) : ack(ACK.INVALID));
      case CMD.START_ACC_CAL:
        if (!empty || !this.settings) return send(ack(ACK.INVALID, 0x0602));
        if (this.calRunning) return send(ack(ACK.FAILED, 0x0604));
        this._calStart(seq); return send(this._cat(ack(ACK.OK, 0x0100), this._accCal(seq)));
      default: return send(ack(ACK.UNKNOWN)); // 21/22、28..33 及其它
    }
  }
  // ---------- 遥测 ----------
  _raw() {
    const s = this.t / 1000;
    const roll = 12 * Math.sin(s * 0.9), pitch = 7 * Math.sin(s * 0.55 + 1), yaw = ((30 * s * 0.1 + 20 * Math.sin(s * 0.2)) % 360 + 540) % 360 - 180; // 相对航向
    const r = roll * Math.PI / 180, p = pitch * Math.PI / 180;
    const ax = -Math.sin(p) * G, ay = Math.sin(r) * Math.cos(p) * G, az = Math.cos(r) * Math.cos(p) * G;
    const gx = 12 * 0.9 * Math.cos(s * 0.9) * 57.2958 / 57.2958, gy = 7 * 0.55 * Math.cos(s * 0.55 + 1), gz = 3 + 4 * Math.cos(s * 0.2);
    const n = () => (this.rand() - 0.5) * 0.02;
    return { yaw, pitch, roll, ax: ax + n(), ay: ay + n(), az: az + n(), gx: gx + n(), gy: gy + n(), gz: gz + n(), temp: this.temperature };
  }
  _sample() { const v = this._raw(); let y = v.yaw - this.yawOffset; y = ((y + 540) % 360) - 180; v.yaw = y; return v; }
  _emitTelemetry() {
    const a = this.active, v = this._sample(), ts = Math.floor(this.devMs) & 0xffff;
    let out = null;
    if (a.format === FORMAT.CUSTOM) { if (a.mask) out = encodeCustom(this.telSeq, a.mask, ts, v); }
    else if (a.format === FORMAT.JUSTFLOAT) { if (a.mask) out = encodeJustFloat(CUSTOM_FIELDS.filter((_, i) => a.mask & (1 << i)).map((f) => v[f])); }
    else switch (a.legacy) {
      case 0: out = encodeJustFloat([v.yaw, v.pitch, v.roll]); break;
      case 1: out = encodeMessage(MSG.EULER_F32, this.telSeq, { roll: v.roll, pitch: v.pitch, yaw: v.yaw, flags: 1, reserved: 0, timestamp_ms: ts }); break;
      case 2: out = encodeMessage(MSG.EULER_I16, this.telSeq, { roll_cd: Math.round(v.roll * 100), pitch_cd: Math.round(v.pitch * 100), yaw_cd: Math.round(v.yaw * 100), gz_ddps: Math.round(v.gz * 10), flags: 1, reserved: 0, timestamp_ms: ts }); break;
      case 3: out = encodeMessage(MSG.IMU_F32, this.telSeq, { gx: v.gx, gy: v.gy, gz: v.gz, ax: v.ax, ay: v.ay, az: v.az, temperature_cdeg: Math.round(v.temp * 100), timestamp_ms: ts }); break;
      case 4: out = encodeJustFloat([v.yaw, v.pitch, v.roll, v.gz, v.az, v.temp]); break;
    }
    if (!out) return;
    if (out[0] === SYNC1 && out[1] === SYNC2) this.telSeq = (this.telSeq + 1) & 0xff;
    if (this.ota) return;
    if (this.t < this.flashPauseUntil) { this.droppedDuringFlash = (this.droppedDuringFlash || 0) + 1; if (this.calRec?.phase === 3) this.calSaveDropped = (this.calSaveDropped || 0) + 1; return; } // Flash 写入：丢弃排队帧（校准仅 SAVING 阶段）
    if (this.t < this.lossUntil) { this.injectedLoss = (this.injectedLoss || 0) + 1; return; } // 测试注入：链路丢帧（SEQ 照常递增）
    if (this.calRunning && this.calTiming.txQueue > 0) { this.telQ.push({ at: this.t + this.calTiming.txQueue, bytes: out }); return; } // 校准期间：经发送队列
    if (this.opts.noise > 0 && this.rand() < this.opts.noise) this._tx(Uint8Array.from({ length: 1 + Math.floor(this.rand() * 6) }, () => Math.floor(this.rand() * 256)));
    this._tx(out);
  }
  advance(ms) {
    const t0 = this.t; this.t += ms;
    if (t0 < this.silentUntil && this.t >= this.silentUntil) ms = this.t - this.silentUntil; // 复位静默结束后才开始计时
    if (this.telQ.length) { const due = this.telQ.filter((q) => q.at <= this.t || !this.calRunning); this.telQ = this.telQ.filter((q) => !due.includes(q)); for (const q of due) this._tx(q.bytes); }
    if (this.delayed.length) { const due = this.delayed.filter((d) => d.at <= this.t); this.delayed = this.delayed.filter((d) => d.at > this.t); for (const d of due) this._tx(d.bytes); }
    if (this.t < this.silentUntil) return;
    if (this.calRec?.state === 1) { // 大步长 advance 也按 5 ms 细分（校准时钟逐步推进）
      const tEnd = this.t; let tc = tEnd - ms;
      while (tc < tEnd && this.calRec?.state === 1) { const st = Math.min(5, tEnd - tc); tc += st; this.t = tc; this._calTick(st); }
      this.t = tEnd;
    }
    if (!this.sensorOk) return; // 无有效传感器数据：停止产生遥测
    const period = 1000 / this.active.hz;
    this.acc += ms;
    let guard = 0;
    while (this.acc >= period && guard++ < 400) { this.acc -= period; this.devMs += period * this.opts.clockSkew; this._emitTelemetry(); }
    if (guard >= 400) this.acc = 0;
  }
}
