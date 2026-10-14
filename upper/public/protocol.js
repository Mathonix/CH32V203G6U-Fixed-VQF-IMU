// protocol.js — CH32V203G6U AHRS（UART）上位机协议层：纯逻辑，不访问 DOM。对接当前 CH32 固件，独立于其他上位机部署。
// 依据：ch32-handoff-20261003h.md + 固件侧对 App/app_command.c（20261003b）的核对。固件版本以 0x32 回读为准，不在代码中写死。
//   外框  AA 55 | MSG u8 | LEN u8 (≤64) | SEQ u8 | PAYLOAD | CRC16-CCITT-FALSE（覆盖 MSG..PAYLOAD，低字节先）
//   ACK   0x90 LEN 4：cmd_id u8, status u8 (0 成功 / 1 未知命令 / 2 参数非法 / 3 执行失败), detail u16
//   查询  0x14/0x1F/0x23/0x24/0x26 直接回数据消息（无 ACK）；设置命令回 ACK + 配置消息（可能在同一次读取里）
//   遥测  0x06 Custom（mask u16 + timestamp_ms u16 + float32[popcount]），或 JustFloat（float32[N] + 00 00 80 7F），或旧预设 0x01/0x04/0x03
export const PROTOCOL_PROVISIONAL = false;
export const PROTOCOL_SOURCE = 'ch32-handoff-20261003h + app_command.c review (20261003h)';
export const PROTOCOL_ID = 'ch32-uart-aa55-v3';
export const SYNC1 = 0xaa, SYNC2 = 0x55, MAX_PAYLOAD = 64, FRAME_OVERHEAD = 7, MAX_FRAME = MAX_PAYLOAD + FRAME_OVERHEAD;
export const BAUD_RATE = 2_000_000;
export const JF_TAIL = Object.freeze([0x00, 0x00, 0x80, 0x7f]);
export const VOFA_BYTES = Uint8Array.of(0x76, 0x6f, 0x66, 0x61); // ASCII "vofa"：仅二进制帧外识别 → RAM JustFloat，无 ACK，不写 Flash。只作为用户显式操作
export const G = 9.80665;
export const ADAPTER_HINT = Object.freeze({ usbVendorId: 0x1a86, usbProductId: 0x8010, name: 'WCH-Link' }); // 仅辅助识别适配器，不代表板端能力

export const MSG = Object.freeze({
  EULER_F32: 0x01, IMU_F32: 0x03, EULER_I16: 0x04, SYSTEM_INFO: 0x05, CUSTOM: 0x06, DEVICE_CONFIG: 0x07,
  ACC_CAL: 0x0a, FILTER_CONFIG: 0x0b, FW_INFO: 0x32, ACK: 0x90,
});
export const CMD = Object.freeze({
  PING: 0x10, ZERO_YAW: 0x11, SET_STREAM_MODE: 0x13, QUERY_STATUS: 0x14, SYSTEM_RESET: 0x15,
  ENTER_SETTINGS: 0x17, EXIT_SETTINGS: 0x18, SET_FUSION_MODE: 0x19, SET_OUTPUT_HZ: 0x1d, QUERY_CONFIG: 0x1f,
  START_ACC_CAL: 0x1c, SET_OUTPUT_CONFIG: 0x20, QUERY_FW_INFO: 0x23, QUERY_ACC_CAL: 0x24, CANCEL_ACC_CAL: 0x25, QUERY_FILTER: 0x26, SET_FILTER: 0x27,
  OTA_BEGIN: 0x40, OTA_WRITE: 0x41, OTA_END: 0x42, OTA_COMMIT: 0x43, OTA_ABORT: 0x44,
});
// 固件未实现（§9）：上位机隐藏入口、不发送、不轮询
export const UNSUPPORTED_CMDS = Object.freeze({
  0x12: '陀螺运行时校准', 0x1b: '陀螺运行时校准', 0x16: 'Bootloader / 固件升级', 0x1e: '启动配置（快速启动/初始化时长/量程）',
0x21: 'AT32 CAN 配置', 0x22: 'AT32 CAN 配置', 0x28: '高级诊断', 0x29: '高级诊断', 0x2a: '高级诊断', 0x2b: '高级诊断',
  0x2c: '高级诊断', 0x2d: '高级诊断', 0x2e: '高级诊断', 0x2f: '高级诊断', 0x30: '高级诊断', 0x31: '高级诊断', 0x32: '高级诊断', 0x33: '高级诊断',
});
export const UNSUPPORTED_FEATURES = Object.freeze(['USB 输出 / USB CDC / DFU / USB 固件升级（板端无 USB）', '陀螺运行时校准（12 / 1B）', 'AT32 Bootloader 命令（16）', '快速启动 / 陀螺初始化时长 / 运行时量程', 'AT32 CAN 配置扩展', '0x02 四元数遥测', '磁力计 / 九轴']);
export const CMD_NAME = Object.freeze(Object.fromEntries(Object.entries(CMD).map(([k, v]) => [v, k])));
export const MSG_NAME = Object.freeze(Object.fromEntries(Object.entries(MSG).map(([k, v]) => [v, k])));
export const ACK = Object.freeze({ OK: 0, UNKNOWN: 1, INVALID: 2, FAILED: 3 });
export const ACK_NAME = Object.freeze(['OK', 'UNKNOWN', 'INVALID', 'FAILED']);
export const ACK_TEXT = Object.freeze(['成功', '未知命令', '参数非法', '执行失败']);
export const DETAIL_TEXT = Object.freeze({ 0x0607: 'Flash 保存失败（未应用新值，已回读现有配置）', 0x0601: '陀螺校准未实现', 0x0602: '需先进入设置模式（六面校准）', 0x0600: '六面校准不可用',
  0x0100: '六面校准已启动', 0x0603: '当前面超时（60 s）', 0x0604: '六面校准进行中，拒绝该操作', 0x0605: '样本不足', 0x0606: '拟合结果超出范围', 0x0608: '已取消', 0x0701: 'OTA 需设置模式', 0x0702: 'OTA 参数非法', 0x0703: 'OTA 会话或阶段错误', 0x0704: 'OTA 偏移或块内容错误', 0x0705: 'OTA Flash 擦写失败', 0x0706: 'OTA CRC 不符', 0x0707: 'OTA 尚未校验', 0x0708: 'OTA 应用描述符非法', 0x0609: '保存失败（未知代码；固件实际只报 0x0607）' });
export const SAMPLE_HZ = 2000; // 0x1D：频率必须整除采样率，否则 status 2
export function ackText(status, detail = 0) {
  return `${ACK_NAME[status] ?? status}（${ACK_TEXT[status] ?? '未知状态'}）${detail ? ` detail 0x${detail.toString(16).padStart(4, '0')}${DETAIL_TEXT[detail] ? ' ' + DETAIL_TEXT[detail] : ''}` : ''}`;
}

// 六面加速度校准（0x1C 启动 / 0x24 查询 / 0x25 取消，进度 MSG 0x0A；capabilities bit7）
export const CAP_SIX_FACE = 0x80;
export const CAL_STATE = Object.freeze(['空闲', '进行中', '完成', '失败', '已取消']);
export const CAL_PHASE = Object.freeze(['等待放置', '稳定中', '采样中', '保存中', '完成', '晃动', '重复面', '失败']);
export const CAL_PHASE_WARN = Object.freeze(new Set([5, 6])); // 晃动 / 重复面：警告而非错误
export const CAL_FACES = Object.freeze(['-X', '+X', '-Y', '+Y', '-Z', '+Z']); // face 1..6；done mask bit0..5
export const CAL_ERROR = Object.freeze({ 0x0603: '当前面超时（60 s）', 0x0605: '样本不足', 0x0606: '拟合结果超出范围', 0x0607: 'Flash 写入失败', 0x0608: '已取消', 0x0701: 'OTA 需设置模式', 0x0702: 'OTA 参数非法', 0x0703: 'OTA 会话或阶段错误', 0x0704: 'OTA 偏移或块内容错误', 0x0705: 'OTA Flash 擦写失败', 0x0706: 'OTA CRC 不符', 0x0707: 'OTA 尚未校验', 0x0708: 'OTA 应用描述符非法', 0x0609: '保存失败（未知代码；固件实际只报 0x0607）' });
export const CAL_START_DETAIL = 0x0100, CAL_BUSY_DETAIL = 0x0604, CAL_CANCELLED = 0x0608;
export function calSummary(c) { if (!c) return null; const done = popcountLow6(c.done_mask); return { running: c.state === 1, done, overall: done / 6, faceProgress: c.progress / 1000, phaseText: CAL_PHASE[c.phase] ?? `phase ${c.phase}`, warn: CAL_PHASE_WARN.has(c.phase), errorText: c.error ? (CAL_ERROR[c.error] || `0x${c.error.toString(16).padStart(4, '0')}`) : '', faceName: CAL_FACES[c.face - 1] || '—' }; }
function popcountLow6(m) { let n = 0; for (let i = 0; i < 6; i++) if (m & (1 << i)) n++; return n; }

// 0x06 Custom 字段（bit 从小到大，未选字段不占位）
export const CUSTOM_FIELDS = Object.freeze(['yaw', 'pitch', 'roll', 'ax', 'ay', 'az', 'gx', 'gy', 'gz']);
export const CUSTOM_LABELS = Object.freeze(['Yaw', 'Pitch', 'Roll', 'Ax', 'Ay', 'Az', 'Gx', 'Gy', 'Gz']);
export const CUSTOM_UNITS = Object.freeze(['deg', 'deg', 'deg', 'm/s²', 'm/s²', 'm/s²', 'deg/s', 'deg/s', 'deg/s']);
export const MASK_ALL = 0x01ff;
export const FLASH_DETAIL = 0x0607; // Flash 保存失败 detail
export function popcount(m) { let n = 0; for (let x = m & 0xffff; x; x &= x - 1) n++; return n; }
export function maskFields(mask) { return CUSTOM_FIELDS.filter((_, i) => mask & (1 << i)); }
// UART 输出格式（0x07 offset 10）
export const FORMAT = Object.freeze({ JUSTFLOAT: 0, CUSTOM: 1, LEGACY: 2 });
export const FORMAT_NAME = Object.freeze(['JustFloat', 'Custom', 'Legacy']);
// 旧预设 0x13（RAM），二进制欧拉角顺序为 Roll/Pitch/Yaw
export const LEGACY_PRESETS = Object.freeze([
  { id: 0, name: 'JustFloat 3 通道', jf: ['yaw', 'pitch', 'roll'] },
  { id: 1, name: '0x01 欧拉角 float32', msg: 0x01 },
  { id: 2, name: '0x04 欧拉角 int16 + Gz', msg: 0x04 },
  { id: 3, name: '0x03 IMU float32 + 温度', msg: 0x03 },
  { id: 4, name: 'JustFloat 6 通道', jf: ['yaw', 'pitch', 'roll', 'gz', 'az', 'temp'] },
]);
export const CAP_BITS = Object.freeze(['NINE_AXIS', 'FAST_START', 'CUSTOM_OUTPUT', 'AT32_CAN_EXT', 'GYRO_INIT_MS', 'GYRO_RANGE', 'PERSIST_HZ', 'SIX_FACE_CAL']);
export const CAP_TEXT = Object.freeze(['九轴模式', '快速启动', '自选输出', 'AT32 CAN 配置扩展', '陀螺初始化时长', '运行时量程', '输出频率持久化', '六面校准']);
export function capsList(mask) { return CAP_BITS.filter((_, i) => mask & (1 << i)); }
export const FILTER_PROFILES = Object.freeze([
  { id: 0, name: '响应', en: 'Response', restTauS: 0.15, motionTauS: 0.04, tauAccS: 1, gyroLpfHz: 120, biasSigmaRestDps: 0.03 },
  { id: 1, name: '均衡', en: 'Balanced', restTauS: 0.50, motionTauS: 0.10, tauAccS: 2.5, gyroLpfHz: 80, biasSigmaRestDps: 0.02 },
  { id: 2, name: '稳定', en: 'Stable', restTauS: 1.50, motionTauS: 0.20, tauAccS: 5, gyroLpfHz: 40, biasSigmaRestDps: 0.01 },
  { id: 3, name: 'ZARU', en: 'Balanced + ZARU', restTauS: 0.50, motionTauS: 0.10, tauAccS: 2.5, gyroLpfHz: 80, biasSigmaRestDps: 0.02 },
]);
// 0B offset12 has different semantics in g and h. A fourth profile alone cannot identify h.
export function filterDetails(filter, firmware) {
  if (!filter) return { kind: 'unknown', profile: null };
  const p = FILTER_PROFILES[filter.active_profile];
  const text = firmware?.text;
  const core = text === '20261003h' || text === '20261003m'; // bundled Mock explicitly models h
  const legacy = /^20261003[b-g]$/.test(text || '');
  return { kind: core ? 'core' : legacy ? 'output' : 'unknown', profile: p,
    tauAccS: core ? filter.rest_tau_s : null,
    outputRestTauS: core ? p?.restTauS : legacy ? filter.rest_tau_s : null,
    zaruAvailable: filter.profile_count >= 4, zaruActive: filter.active_profile === 3 };
}
export const OUTPUT_HZ = Object.freeze([1, 2, 4, 5, 8, 10, 16, 20, 25, 40, 50, 80, 100, 125, 200, 250, 400, 500, 1000, 2000]);
export const STREAM_MODE_NOT_LEGACY = 0xff;

// ---------------- 布局表 ----------------
export const TYPES = Object.freeze({ u8: 1, i8: 1, u16: 2, i16: 2, u32: 4, i32: 4, f32: 4, bytes: 1 });
export const LAYOUTS = {
  [MSG.SYSTEM_INFO]: { name: 'SYSTEM_INFO', fields: [['fusion_hz', 'u32'], ['output_hz', 'u32'], ['skip', 'u16'], ['temperature_cdeg', 'i16'], ['stream_mode', 'u8'], ['can_ok', 'u8'], ['reserved', 'u16']] },
  [MSG.DEVICE_CONFIG]: { name: 'DEVICE_CONFIG', fields: [
    ['version', 'u8'], ['source', 'u8'], ['active_fusion_mode', 'u8'], ['saved_fusion_mode', 'u8'], ['active_fast_start', 'u8'], ['saved_fast_start', 'u8'],
    ['capabilities', 'u8'], ['reserved', 'u8'], ['output_hz', 'u16'], ['uart_format', 'u8'], ['uart_legacy', 'u8'], ['uart_mask', 'u16'],
    ['usb_format', 'u8'], ['usb_legacy', 'u8'], ['usb_mask', 'u16'], // USB 占位：保持共享布局，不代表存在接口
    ['active_gyro_init_ms', 'u16'], ['saved_gyro_init_ms', 'u16'], ['active_gyro_range_dps', 'u16'], ['saved_gyro_range_dps', 'u16'], ['saved_output_hz', 'u16']] },
  [MSG.FILTER_CONFIG]: { name: 'FILTER_CONFIG', fields: [['version', 'u8'], ['active_profile', 'u8'], ['saved_profile', 'u8'], ['profile_count', 'u8'], ['estimator_hz', 'u16'], ['reserved', 'u16'], ['tau_mag_s', 'f32'], ['rest_tau_s', 'f32']] },
  [MSG.FW_INFO]: { name: 'FW_INFO', fields: [['format', 'u8'], ['text_len', 'u8'], ['text_bytes', 'bytes', 14]] },
  [MSG.ACC_CAL]: { name: 'ACC_CAL', fields: [['version', 'u8'], ['state', 'u8'], ['phase', 'u8'], ['face', 'u8'], ['done_mask', 'u8'], ['one', 'u8'], ['flash_valid', 'u8'], ['reserved', 'u8'],
    ['progress', 'u16'], ['error', 'u16'], ['samples', 'u32'], ['elapsed_ms', 'u32'], ['left_ms', 'u32'], ['bias_g', 'f32', 3], ['scale', 'f32', 3], ['raw_g', 'f32', 3]] }, // LEN 60；bias/scale 为 Flash 中已保存值
  [MSG.ACK]: { name: 'ACK', fields: [['cmd_id', 'u8'], ['status', 'u8'], ['detail', 'u16']] },
  [MSG.EULER_F32]: { name: 'LEGACY_EULER_F32', fields: [['roll', 'f32'], ['pitch', 'f32'], ['yaw', 'f32'], ['flags', 'u8'], ['reserved', 'u8'], ['timestamp_ms', 'u16']] },
  [MSG.EULER_I16]: { name: 'LEGACY_EULER_I16', fields: [['roll_cd', 'i16'], ['pitch_cd', 'i16'], ['yaw_cd', 'i16'], ['gz_ddps', 'i16'], ['flags', 'u8'], ['reserved', 'u8'], ['timestamp_ms', 'u16']] },
  [MSG.IMU_F32]: { name: 'LEGACY_IMU_F32', fields: [['gx', 'f32'], ['gy', 'f32'], ['gz', 'f32'], ['ax', 'f32'], ['ay', 'f32'], ['az', 'f32'], ['temperature_cdeg', 'i16'], ['timestamp_ms', 'u16']] },
};
// Host → MCU payload（未列出 = 空 payload，LEN 必须为 0）
export const CMD_LAYOUTS = {
  [CMD.SET_STREAM_MODE]: { fields: [['preset', 'u8']] },
  [CMD.SET_FUSION_MODE]: { fields: [['mode', 'u8'], ['apply_now', 'u8']] },
  [CMD.SET_OUTPUT_HZ]: { fields: [['hz', 'u16']] },
  [CMD.SET_OUTPUT_CONFIG]: { fields: [['port', 'u8'], ['format', 'u8'], ['mask', 'u16'], ['persist', 'u8']] },
  [CMD.SET_FILTER]: { fields: [['profile', 'u8'], ['persist', 'u8']] },
};
// 应答方式：ack = 等成功 ACK；msg = 数据消息；ack+msg = ACK 后跟配置（同 SEQ）
export const CMD_REPLY = {
  [CMD.PING]: { ack: true }, [CMD.ZERO_YAW]: { ack: true }, [CMD.SET_STREAM_MODE]: { ack: true }, [CMD.SYSTEM_RESET]: { ack: true },
  [CMD.ENTER_SETTINGS]: { ack: true }, [CMD.EXIT_SETTINGS]: { ack: true }, [CMD.SET_FUSION_MODE]: { ack: true },
  [CMD.SET_OUTPUT_HZ]: { ack: true, msg: MSG.DEVICE_CONFIG }, [CMD.SET_OUTPUT_CONFIG]: { ack: true, msg: MSG.DEVICE_CONFIG },
  [CMD.CANCEL_ACC_CAL]: { ack: true, msg: MSG.ACC_CAL }, [CMD.START_ACC_CAL]: { ack: true, msg: MSG.ACC_CAL }, [CMD.SET_FILTER]: { ack: true, msg: MSG.FILTER_CONFIG }, // 0x1C：ACK(0x0100)+0x0A；最终 ACK 异步到达
  [CMD.QUERY_STATUS]: { msg: MSG.SYSTEM_INFO }, [CMD.QUERY_CONFIG]: { msg: MSG.DEVICE_CONFIG }, [CMD.QUERY_FW_INFO]: { msg: MSG.FW_INFO },
  [CMD.QUERY_ACC_CAL]: { msg: MSG.ACC_CAL }, [CMD.QUERY_FILTER]: { msg: MSG.FILTER_CONFIG },
};
// 可安全重试（幂等、只读）的命令；复位 / 保存 / 设置一律不自动重发
export const RETRYABLE = Object.freeze(new Set([CMD.PING, CMD.QUERY_STATUS, CMD.QUERY_CONFIG, CMD.QUERY_FW_INFO, CMD.QUERY_ACC_CAL, CMD.QUERY_FILTER]));
// 会写 Flash 的命令（UI 需显式确认）
export function writesFlash(cmd, params = {}) { return cmd === CMD.SET_OUTPUT_HZ || ((cmd === CMD.SET_OUTPUT_CONFIG || cmd === CMD.SET_FILTER) && params.persist === 1); }
export const LIMITS = {
  preset: (v) => Number.isInteger(v) && v >= 0 && v <= 4,
  mode: (v) => v === 0, apply_now: (v) => v === 0 || v === 1,
  hz: (v) => Number.isInteger(v) && v >= 1 && SAMPLE_HZ % v === 0 && OUTPUT_HZ.includes(v),
  port: (v) => v === 0, // 本设备只有 UART（port 1 = USB → 固件 status 3）
  format: (v) => v === 0 || v === 1, // format 2 需用 0x13
  mask: (v) => Number.isInteger(v) && v >= 0 && v <= MASK_ALL,
  persist: (v) => v === 0 || v === 1,
  profile: (v) => Number.isInteger(v) && v >= 0 && v <= 3,
};

// ---------------- 编解码 ----------------
export function layoutSize(layout) { return layout.fields.reduce((n, [, t, c = 1]) => n + TYPES[t] * c, 0); }
const GET = { u8: 'getUint8', i8: 'getInt8', u16: 'getUint16', i16: 'getInt16', u32: 'getUint32', i32: 'getInt32', f32: 'getFloat32' };
const SET = { u8: 'setUint8', i8: 'setInt8', u16: 'setUint16', i16: 'setInt16', u32: 'setUint32', i32: 'setInt32', f32: 'setFloat32' };
export function decodeLayout(layout, bytes) {
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length); const out = {}; let o = 0;
  for (const [name, t, c] of layout.fields) {
    if (t === 'bytes') { out[name] = bytes.slice(o, o + c); o += c; continue; }
    const w = TYPES[t];
    if (c) { out[name] = []; for (let i = 0; i < c; i++, o += w) out[name].push(v[GET[t]](o, true)); } else { out[name] = v[GET[t]](o, true); o += w; }
  }
  return out;
}
export function encodeLayout(layout, obj) {
  const bytes = new Uint8Array(layoutSize(layout)); const v = new DataView(bytes.buffer); let o = 0;
  for (const [name, t, c] of layout.fields) {
    const val = obj[name];
    if (t === 'bytes') { if (val) bytes.set(Array.from(val).slice(0, c), o); o += c; continue; }
    const w = TYPES[t];
    if (c) { for (let i = 0; i < c; i++, o += w) v[SET[t]](o, Number(val?.[i] ?? 0), true); } else { v[SET[t]](o, Number(val ?? 0), true); o += w; }
  }
  return bytes;
}
export function encodeCommandPayload(cmd, params = {}) {
  if (cmd === CMD.OTA_BEGIN || cmd === CMD.OTA_WRITE) {
    const p = params.payload;
    if (!(p instanceof Uint8Array) || (cmd === CMD.OTA_BEGIN ? p.length !== 20 : p.length < 8 || p.length > 60 || p.length % 4)) throw new RangeError('非法 OTA 请求长度');
    return p;
  }
  const layout = CMD_LAYOUTS[cmd];
  if (!layout) return new Uint8Array(0);
  for (const [name] of layout.fields) { const check = LIMITS[name]; if (check && !check(params[name])) throw new RangeError(`参数越界：${name}=${params[name]}`); }
  return encodeLayout(layout, params);
}
// CRC16-CCITT-FALSE：poly 0x1021，init 0xFFFF，不反射，xorout 0。"123456789" → 0x29B1
export function crc16(bytes, start = 0, end = bytes.length) {
  let crc = 0xffff;
  for (let i = start; i < end; i++) { crc ^= bytes[i] << 8; for (let b = 0; b < 8; b++) crc = (crc & 0x8000) ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff; }
  return crc;
}
export function encodeFrame(msg, seq, payload = new Uint8Array(0)) {
  if (!(msg >= 0 && msg <= 255 && seq >= 0 && seq <= 255)) throw new RangeError('MSG / SEQ 必须是 u8');
  if (payload.length > MAX_PAYLOAD) throw new RangeError('payload > 64');
  const f = new Uint8Array(FRAME_OVERHEAD + payload.length);
  f[0] = SYNC1; f[1] = SYNC2; f[2] = msg; f[3] = payload.length; f[4] = seq; f.set(payload, 5);
  const crc = crc16(f, 2, 5 + payload.length); f[5 + payload.length] = crc & 0xff; f[6 + payload.length] = crc >> 8;
  return f;
}
export function encodeCommand(cmd, seq, params = {}) { return encodeFrame(cmd, seq, encodeCommandPayload(cmd, params)); }
export function encodeMessage(msg, seq, obj) { return encodeFrame(msg, seq, encodeLayout(LAYOUTS[msg], obj)); }
export function encodeCustom(seq, mask, timestampMs, valuesByName) {
  const n = popcount(mask), p = new Uint8Array(4 + 4 * n), v = new DataView(p.buffer);
  v.setUint16(0, mask, true); v.setUint16(2, timestampMs & 0xffff, true);
  let k = 0; CUSTOM_FIELDS.forEach((f, i) => { if (mask & (1 << i)) v.setFloat32(4 + 4 * k++, valuesByName[f] ?? 0, true); });
  return encodeFrame(MSG.CUSTOM, seq, p);
}
export function encodeJustFloat(values) {
  const b = new Uint8Array(values.length * 4 + 4), v = new DataView(b.buffer);
  values.forEach((x, i) => v.setFloat32(i * 4, x, true)); b.set(JF_TAIL, values.length * 4); return b;
}
export function hex(bytes) { return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(''); }
export function fromHex(s) { const c = s.replace(/[^0-9a-f]/gi, ''); const b = new Uint8Array(c.length / 2); for (let i = 0; i < b.length; i++) b[i] = parseInt(c.substr(i * 2, 2), 16); return b; }

// 严格解码：LEN 精确匹配、mask 合法、数值有限；错误返回 {type:'bad', reason}，不得更新状态
export function decodePayload(msg, payload) {
  if (msg === MSG.CUSTOM) {
    if (payload.length < 4) return { type: 'bad', msg, reason: 'custom: LEN < 4' };
    const v = new DataView(payload.buffer, payload.byteOffset, payload.length), mask = v.getUint16(0, true);
    if (mask & ~MASK_ALL) return { type: 'bad', msg, reason: `custom: 非法 mask 0x${mask.toString(16)}` };
    if (payload.length !== 4 + 4 * popcount(mask)) return { type: 'bad', msg, reason: `custom: LEN ${payload.length} ≠ 4+4×${popcount(mask)}` };
    const data = { mask, timestamp_ms: v.getUint16(2, true) }; let k = 0;
    for (let i = 0; i < 9; i++) if (mask & (1 << i)) { const x = v.getFloat32(4 + 4 * k++, true); if (!Number.isFinite(x)) return { type: 'bad', msg, reason: 'custom: 非有限浮点' }; data[CUSTOM_FIELDS[i]] = x; }
    return { type: 'message', msg, name: 'CUSTOM', data };
  }
  const layout = LAYOUTS[msg];
  if (!layout) return { type: 'unknown', msg, length: payload.length };
  const expected = layoutSize(layout);
  if (payload.length !== expected) return { type: 'bad', msg, name: layout.name, reason: `${layout.name}: LEN ${payload.length} ≠ ${expected}` };
  const data = decodeLayout(layout, payload);
  if (msg === MSG.FW_INFO) {
    if (data.format !== 1 || data.text_len < 1 || data.text_len > 14) return { type: 'bad', msg, name: layout.name, reason: 'FW_INFO: format/text_len 非法' };
    data.text = String.fromCharCode(...data.text_bytes.subarray(0, data.text_len));
    // Reserved tail only exists when text does not overlap byte12..15 (old long text stays text).
    data.ota_version = data.text_len <= 10 ? payload[12] : 0;
    data.app_max = data.text_len <= 10 ? new DataView(payload.buffer, payload.byteOffset, payload.length).getUint16(14, true) : 0;
    delete data.text_bytes;
    data.mock = /m$/.test(data.text);
  }
  if (msg === MSG.FILTER_CONFIG && (data.version !== 1 || !data.profile_count || data.active_profile >= data.profile_count || data.saved_profile >= data.profile_count || data.estimator_hz === 0 || data.rest_tau_s <= 0)) return { type: 'bad', msg, name: layout.name, reason: 'FILTER_CONFIG: 非法档位或参数' };
  if (msg === MSG.ACC_CAL && data.version !== 1) return { type: 'bad', msg, name: layout.name, reason: 'ACC_CAL: version ≠ 1' };
  if (msg === MSG.SYSTEM_INFO) data.temperature_c = data.temperature_cdeg / 100;
  if (msg === MSG.IMU_F32) data.temperature_c = data.temperature_cdeg / 100;
  for (const [k, x] of Object.entries(data)) if (typeof x === 'number' && !Number.isFinite(x)) return { type: 'bad', msg, name: layout.name, reason: `${layout.name}: ${k} 非有限` };
  return { type: 'message', msg, name: layout.name, data };
}

// ---------------- 混合流解析：AA55 + JustFloat（有界缓冲、逐字节重同步） ----------------
// 识别依据：完整长度 + CRC + 当前位置。float32 对齐时不可能等于帧尾 00 00 80 7F（= +Inf），
// 所以 JustFloat 帧 = 从当前位置起第一个 4 字节对齐的帧尾且前面全部为有限浮点；AA55 必须 CRC 正确才算帧。
export function newStreamStats() {
  return { frames: 0, crcErrors: 0, lenErrors: 0, badFrames: 0, unknown: 0, noiseBytes: 0, jfFrames: 0, jfBadCount: 0, rxBytes: 0, maxBuffered: 0 };
}
export class StreamParser {
  constructor({ onFrame, onJustFloat, onRaw } = {}) {
    this.onFrame = onFrame || (() => {}); this.onJustFloat = onJustFloat || (() => {}); this.onRaw = onRaw || null;
    this.stats = newStreamStats();
    this.jfEnabled = true; // 是否可能出现 JustFloat（format 0 / 旧预设 0、4 / 尚未读到配置）
    this.jfChannels = null; // 由 0x07 确定的 N（null = 自动）
    this.buf = new Uint8Array(4096); this.len = 0;
  }
  reset() { this.len = 0; }
  configure({ jfEnabled, jfChannels }) { if (jfEnabled !== undefined) this.jfEnabled = jfEnabled; if (jfChannels !== undefined) this.jfChannels = jfChannels; }
  push(chunk) {
    this.stats.rxBytes += chunk.length;
    if (this.len + chunk.length > this.buf.length) { const nb = new Uint8Array(Math.max(this.buf.length * 2, this.len + chunk.length)); nb.set(this.buf.subarray(0, this.len)); this.buf = nb; }
    this.buf.set(chunk, this.len); this.len += chunk.length;
    if (this.len > this.stats.maxBuffered) this.stats.maxBuffered = this.len;
    let i = 0; const b = this.buf, n = this.len;
    while (i < n) {
      const r = this._try(b, i, n);
      if (r > 0) { i += r; continue; }
      if (r === 0) break; // 需要更多字节（最多 MAX_FRAME 字节，缓冲有界）
      this.stats.noiseBytes++; i++; // 当前字节不是任何帧的起点：丢 1 字节重同步
    }
    if (i > 0) { b.copyWithin(0, i, n); this.len = n - i; }
    if (this.buf.length > 16384 && this.len < 4096) this.buf = this.buf.slice(0, 4096);
  }
  // >0：消费字节数；0：等待更多数据；-1：不是帧起点
  _try(b, i, n) {
    let needMore = false, crcBad = false, lenBad = false;
    if (b[i] === SYNC1) {
      if (i + 1 >= n) needMore = true;
      else if (b[i + 1] === SYNC2) {
        if (i + 4 >= n) needMore = true;
        else {
          const len = b[i + 3];
          if (len > MAX_PAYLOAD) lenBad = true; // LEN=65.. 不是合法帧：只丢 1 字节后重同步
          else if (i + FRAME_OVERHEAD + len > n) needMore = true;
          else {
            const end = i + 5 + len, rx = b[end] | (b[end + 1] << 8);
            if (crc16(b, i + 2, end) === rx) { this._emitFrame(b, i, len); return FRAME_OVERHEAD + len; }
            crcBad = true;
          }
        }
      }
    }
    if (this.jfEnabled) {
      const j = this._jfAt(b, i, n);
      if (j > 0) return j;
      if (j === 0) needMore = true;
    }
    if (needMore) return 0;
    if (crcBad) this.stats.crcErrors++;
    if (lenBad) this.stats.lenErrors++;
    return -1;
  }
  // JustFloat：在 i 起找第一个对齐的帧尾；返回消费长度 / 0 等待 / -1 不是
  _jfAt(b, i, n) {
    const maxCh = this.jfChannels || 9;
    for (let k = 1; k <= maxCh; k++) {
      const t = i + 4 * k;
      if (t + 4 > n) return 0;
      if (b[t] === 0x00 && b[t + 1] === 0x00 && b[t + 2] === 0x80 && b[t + 3] === 0x7f) {
        if (this.jfChannels && k !== this.jfChannels) { this.stats.jfBadCount++; return -1; } // 通道数与 0x07 不符：视为错位
        const v = new DataView(b.buffer, b.byteOffset + i, 4 * k), vals = [];
        for (let c = 0; c < k; c++) { const x = v.getFloat32(c * 4, true); if (!Number.isFinite(x)) return -1; vals.push(x); }
        this.stats.jfFrames++;
        if (this.onRaw) this.onRaw('jf', b.slice(i, t + 4));
        this.onJustFloat(vals);
        return 4 * k + 4;
      }
      // 中途出现非有限值（含 NaN）→ 不可能是 JustFloat
      const x = new DataView(b.buffer, b.byteOffset + i + 4 * (k - 1), 4).getFloat32(0, true);
      if (!Number.isFinite(x)) return -1;
    }
    return -1;
  }
  _emitFrame(b, i, len) {
    const msg = b[i + 2], seq = b[i + 4], payload = b.slice(i + 5, i + 5 + len);
    this.stats.frames++;
    if (this.onRaw) this.onRaw('aa55', b.slice(i, i + FRAME_OVERHEAD + len));
    const d = decodePayload(msg, payload);
    if (d.type === 'bad') this.stats.badFrames++;
    if (d.type === 'unknown') this.stats.unknown++;
    d.seq = seq; d.payload = payload; this.onFrame(d);
  }
}

// ---------------- 遥测统计：u8 SEQ / u16 timestamp 模差，PC 单调时钟测速 ----------------
export class TelemetryStats {
  constructor() { this.reset(); }
  reset() { this.expectedMissing = 0; this.flashGaps = 0; this.flashWindow = null; this.calHold = null; this.calDecide = null; this.gapLog = []; this.calGapsNormal = 0; this.calGapsLoss = 0; this.lastGapNote = ''; this.frames = 0; this.missing = 0; this.duplicates = 0; this.seqWraps = 0; this.tsWraps = 0; this.baselineResets = 0; this.prevSeq = null; this.prevTs = null; this.firstAt = null; this.lastAt = null; this.window = []; }
  // Flash 写入期间固件暂停遥测并丢弃排队帧 → SEQ 跳号属正常：在窗口内的缺失单独计入 expectedMissing
  beginFlashWindow(now) { this.flashWindow = { from: now, until: Infinity }; }
  endFlashWindow(now, graceMs = 300) { if (this.flashWindow) this.flashWindow.until = now + graceMs; }
  // 六面校准跳号（app_device.c L70 + 20261003 复核）：进入 phase 3 会清掉已排队帧（SEQ 已分配），跳号可能早于看到 mask 0x3F 就开始。
  // 候选区间 = [看到 0x3F 前最后一帧（最迟：ACK 前最后一个 0x0A 时的最后一帧）, 最终 ACK 后第一帧]；区间内跳号先暂挂（不计入），
  // 最终 ACK 到达后追溯裁决：mask 0x3F 且 (st0 或 st3/0x0607) → Flash 写入期间跳号（正常）；否则（0x0606 / 0x0608 等）→ 真实丢失。
  calHoldFrom(t) { if (!this.calHold) this.calHold = { from: t, gaps: [] }; else this.calHold.from = Math.min(this.calHold.from, t); }
  get tentativeMissing() { return this.calHold ? this.calHold.gaps.reduce((a, g) => a + g.n, 0) : 0; }
  _classify(g, normal) {
    this.missing += g.n;
    if (normal) { this.expectedMissing += g.n; this.flashGaps++; this.calGapsNormal += g.n; this.lastGapNote = `Flash 写入期间跳号 ${g.n} 帧（正常）`; }
    else { this.calGapsLoss += g.n; this.lastGapNote = `六面校准期间跳号 ${g.n} 帧（计为丢失）`; }
  }
  // 裁决：from 起（含）已计入的跳号追溯改判；暂挂的按裁决提交；最终 ACK 后第一帧（cap 2 s）按同一裁决处理
  calCommit(normal, now, from, capMs = 2000) {
    if (normal) for (const g of this.gapLog) if (!g.held && !g.reclassified && g.prevAt >= from && !g.expected) { g.reclassified = true; this.expectedMissing += g.n; this.flashGaps++; this.calGapsNormal += g.n; this.lastGapNote = `Flash 写入期间跳号 ${g.n} 帧（正常）`; }
    if (this.calHold) for (const g of this.calHold.gaps) this._classify(g, normal);
    this.calHold = null;
    this.calDecide = { normal, until: now + capMs };
  }
  calRelease() { if (this.calHold) for (const g of this.calHold.gaps) this._classify(g, false); this.calHold = null; this.calDecide = null; } // 无最终 ACK（断开 / 复位）→ 丢失
  inFlashWindow(now) { const w = this.flashWindow; return !!w && now >= w.from && now <= w.until; }
  get unexpectedMissing() { return this.missing - this.expectedMissing; }
  rebuild(reason = '') { this.prevSeq = null; this.prevTs = null; this.baselineResets++; this.lastReason = reason; this.window = []; }
  // seq 为 null 表示该格式无序号（JustFloat）
  add(seq, ts, now) {
    const prevAt = this.lastAt;
    if (this.calDecide && now > this.calDecide.until) this.calDecide = null; // 2 s 兜底
    if (this.lastAt != null && now - this.lastAt > 2000) this.rebuild('长时间中断');
    this.frames++; if (this.firstAt == null) this.firstAt = now; this.lastAt = now;
    this.window.push(now); while (this.window.length && now - this.window[0] > 2000) this.window.shift();
    if (seq != null) {
      if (this.prevSeq != null) {
        const d = (seq - this.prevSeq) & 0xff;
        if (d === 0) { this.duplicates++; return; } // 重复 SEQ 不是 255 帧丢失
        const flash = this.inFlashWindow(now), dec = this.calDecide, hold = this.calHold && prevAt != null && prevAt >= this.calHold.from;
        if (d > 128 && !flash && !hold && !dec?.normal) { this.rebuild('SEQ 跳变无法区分'); }
        else {
          if (seq < this.prevSeq) this.seqWraps++;
          if (d > 1) {
            const g = { prevAt, at: now, n: d - 1 };
            this.gapLog.push(g); while (this.gapLog.length && now - this.gapLog[0].at > 5000) this.gapLog.shift();
            if (dec) this._classify(g, dec.normal);
            else if (hold) { g.held = true; this.calHold.gaps.push(g); } // 暂挂：等最终 ACK 裁决
            else { this.missing += g.n; if (flash) { g.expected = true; this.expectedMissing += g.n; this.flashGaps++; this.lastGapNote = `Flash 写入期间跳号 ${g.n} 帧（正常）`; } }
          }
        }
      }
      this.prevSeq = seq;
      if (this.calDecide) this.calDecide = null; // 一次性：最终 ACK 后的第一帧已裁决
    }
    if (ts != null) {
      if (this.prevTs != null && ts < this.prevTs && ((ts - this.prevTs) & 0xffff) < 0x8000) this.tsWraps++; // 正常回绕，不是复位证据
      this.prevTs = ts;
    }
  }
  rateHz(now) { const w = this.window.filter((t) => now - t <= 2000); if (w.length < 2) return 0; return (w.length - 1) / ((w[w.length - 1] - w[0]) / 1000 || 1); }
  ageMs(now) { return this.lastAt == null ? Infinity : now - this.lastAt; }
}

// 把各种遥测统一成 Sample（单位：deg、m/s²、deg/s、°C；缺失字段为 undefined）
export function sampleFromCustom(d) { const s = { yaw: d.yaw, pitch: d.pitch, roll: d.roll, ts: d.timestamp_ms, mask: d.mask }; if ('ax' in d || 'ay' in d || 'az' in d) s.accel = [d.ax, d.ay, d.az]; if ('gx' in d || 'gy' in d || 'gz' in d) s.gyro = [d.gx, d.gy, d.gz]; return s; }
export function sampleFromLegacy(msg, d) {
  if (msg === MSG.EULER_F32) return { roll: d.roll, pitch: d.pitch, yaw: d.yaw, ts: d.timestamp_ms, flags: d.flags };
  if (msg === MSG.EULER_I16) return { roll: d.roll_cd / 100, pitch: d.pitch_cd / 100, yaw: d.yaw_cd / 100, gyro: [undefined, undefined, d.gz_ddps / 10], ts: d.timestamp_ms, flags: d.flags };
  if (msg === MSG.IMU_F32) return { gyro: [d.gx, d.gy, d.gz], accel: [d.ax, d.ay, d.az], temp: d.temperature_c, ts: d.timestamp_ms };
  return null;
}
// JustFloat 通道含义：format 0 → 当前 UART mask 的字段；旧预设 0/4 → 固定布局
export function justFloatFields(config) {
  if (!config) return null;
  if (config.uart_format === FORMAT.JUSTFLOAT) return maskFields(config.uart_mask);
  if (config.uart_format === FORMAT.LEGACY) return LEGACY_PRESETS[config.uart_legacy]?.jf || null;
  return null;
}
export function sampleFromJustFloat(fields, values) {
  const o = {}; (fields || []).forEach((f, i) => { o[f] = values[i]; });
  const s = { yaw: o.yaw, pitch: o.pitch, roll: o.roll };
  if ('ax' in o || 'ay' in o || 'az' in o) s.accel = [o.ax, o.ay, o.az];
  if ('gx' in o || 'gy' in o || 'gz' in o) s.gyro = [o.gx, o.gy, o.gz];
  if ('temp' in o) s.temp = o.temp;
  return s;
}
// 0x07 → 预期遥测
export function telemetryPlan(config) {
  if (!config) return { kind: 'unknown', jfEnabled: true, jfChannels: null, fields: null };
  if (config.uart_format === FORMAT.CUSTOM) return { kind: 'custom', jfEnabled: false, jfChannels: null, fields: maskFields(config.uart_mask), paused: config.uart_mask === 0 };
  if (config.uart_format === FORMAT.JUSTFLOAT) { const f = maskFields(config.uart_mask); return { kind: 'justfloat', jfEnabled: true, jfChannels: f.length || null, fields: f, paused: config.uart_mask === 0 }; }
  const p = LEGACY_PRESETS[config.uart_legacy];
  if (p?.jf) return { kind: 'legacy-jf', jfEnabled: true, jfChannels: p.jf.length, fields: p.jf, preset: p.id };
  return { kind: 'legacy', jfEnabled: false, jfChannels: null, msg: p?.msg, preset: p?.id };
}

// ---------------- 会话：命令事务（一次一条）、握手、遥测分发。与传输无关（gyroc Web Serial / Hub Transport 共用） ----------------
export class CommandError extends Error { constructor(kind, message, extra = {}) { super(message); this.kind = kind; Object.assign(this, extra); } }
// kind：Timeout | AckUnknown | AckInvalid | AckFailed | LocalInvalid | Unsupported | Cancelled | NotConnected
const ACK_KIND = ['OK', 'AckUnknown', 'AckInvalid', 'AckFailed'];
export class Ch32Session {
  constructor({ write, now = () => performance.now(), timeoutMs = 1000, retries = 2, onEvent = () => {}, onSample = () => {}, onUpdate = () => {}, rawLog = null } = {}) {
    this.write = write; this.now = now; this.timeoutMs = timeoutMs; this.retries = retries;
    this.onEvent = onEvent; this.onSample = onSample; this.onUpdate = onUpdate;
    this.seq = 0; this.pending = null; this.chain = Promise.resolve(); this.busy = 0;
    this.cmdStats = { sent: 0, timeouts: 0, retries: 0, ackFailures: 0, unexpectedAcks: 0, lateReplies: 0, unsupportedBlocked: 0, resets: 0, rebootPings: 0, lastRebootMs: null };
    this.telemetry = new TelemetryStats();
    this.config = null; this.filter = null; this.system = null; this.firmware = null; this.accCal = null; this.settingsMode = false; this.last = null; this.plan = telemetryPlan(null);
    this.raw = rawLog; // 可选：(dir, kind, bytes, t) 原始帧记录
    this.parser = new StreamParser({ onFrame: (f) => this._onFrame(f), onJustFloat: (v) => this._onJust(v), onRaw: (k, b) => { if (this.raw) this.raw('rx', k, b, this.now()); } });
  }
  feed(bytes) { this.parser.push(bytes); }
  get stats() { return { parser: this.parser.stats, commands: this.cmdStats, telemetry: this.telemetry }; }
  nextSeq() { this.seq = (this.seq + 1) & 0xff; return this.seq; }
  _applyConfig(c) {
    this.config = c; this.plan = telemetryPlan(c);
    this.parser.configure({ jfEnabled: this.plan.jfEnabled, jfChannels: this.plan.jfChannels });
  }
  _onFrame(f) {
    if (f.type !== 'message') { this.onUpdate('bad'); return; }
    const d = f.data, now = this.now();
    if (f.msg !== MSG.ACK) this.applicationFrames = (this.applicationFrames || 0) + 1;
    // 先尝试匹配当前待完成命令（ACK：cmd_id + SEQ；数据：MSG + SEQ）
    const p = this.pending;
    if (f.msg === MSG.ACK) {
      if (p && p.seq === f.seq && p.cmd === d.cmd_id && !p.ack) {
        p.ack = d;
        if (d.status !== ACK.OK) { this.cmdStats.ackFailures++; this._grace = { seq: p.seq, msg: p.reply.msg }; this._finish(p, new CommandError(ACK_KIND[d.status] || 'AckFailed', `${CMD_NAME[p.cmd] || hx(p.cmd)} → ${ackText(d.status, d.detail)}`, { ack: d })); }
        else if (!p.reply.msg || p.data) this._finish(p, null);
      } else if (d.cmd_id === CMD.START_ACC_CAL && this.calRun && !this.calRun.finished && f.seq === this.calRun.seq) this._calFinalSync(d); // 0x1C 最终 ACK（启动 SEQ，异步）
      else if (d.cmd_id === CMD.START_ACC_CAL && (!this.calRun || this.calRun.finished) && d.detail !== CAL_START_DETAIL && this.sixFaceSupported) this.onEvent(d.status ? 'warn' : 'ok', `0x1C 最终 ACK（非本页启动的校准）：${d.status ? ackText(d.status, d.detail) : '完成'}`);
      else this.cmdStats.unexpectedAcks++; // 意外 / 迟到 ACK：不能完成其他命令
      return;
    }
    switch (f.msg) {
      case MSG.CUSTOM: this._telemetry(f.seq, d.timestamp_ms, sampleFromCustom(d), now); return;
      case MSG.EULER_F32: case MSG.EULER_I16: case MSG.IMU_F32: this._telemetry(f.seq, d.timestamp_ms, sampleFromLegacy(f.msg, d), now); return;
      case MSG.DEVICE_CONFIG: this._applyConfig(d); break;
      case MSG.FILTER_CONFIG: this.filter = d; break;
      case MSG.SYSTEM_INFO: this.system = d; break;
      case MSG.FW_INFO: this.firmware = d; break;
      case MSG.ACC_CAL: this._onCal(f.seq, d, now); break;
    }
    if (p && p.reply.msg === f.msg && p.seq === f.seq && !p.data) {
      p.data = d;
      if (!p.reply.ack || p.ack) this._finish(p, null);
    } else if (this._grace && this._grace.seq === f.seq && this._grace.msg === f.msg) this._grace = null; // 失败 ACK 后的现有配置回读
    else if (f.msg === MSG.ACC_CAL && this._calSeq === f.seq) { /* 校准推送（启动 SEQ） */ }
    else if ([MSG.DEVICE_CONFIG, MSG.FILTER_CONFIG, MSG.SYSTEM_INFO, MSG.FW_INFO, MSG.ACC_CAL].includes(f.msg)) this.cmdStats.lateReplies++; // 迟到 / 未请求的应答：更新显示但不完成任何命令
    this.onUpdate(MSG_NAME[f.msg]);
  }
  _onJust(values) { this.applicationFrames = (this.applicationFrames || 0) + 1; this._telemetry(null, null, sampleFromJustFloat(justFloatFields(this.config), values), this.now(), values); }
  _telemetry(seq, ts, s, now, jfValues) {
    if (!s) return;
    const run = this.calRun; if (run?.gapPending) this._calDecideGaps(run); // 最终 ACK 后第一帧先于 0x0A 到达时在此裁决
    this.telemetry.add(seq, ts, now); s.t = now; s.seq = seq; if (jfValues) s.jf = jfValues;
    this.last = s; this.onSample(s);
  }
  isStale(now = this.now()) { const hz = this.config?.output_hz || 200; return this.telemetry.ageMs(now) > Math.max(300, 5000 / hz); }
  _finish(p, err) {
    if (this.pending !== p) return; this.pending = null; clearTimeout(p.timer);
    if (err) p.reject(err); else p.resolve({ ack: p.ack, data: p.data, seq: p.seq });
  }
  // 单次事务；发送前注册监听（ACK 与配置可在同一读取块到达）
  _once(cmd, params, timeoutMs, { quiet = false } = {}) {
    return new Promise((resolve, reject) => {
      let frame; const seq = this.nextSeq();
      if (cmd === CMD.START_ACC_CAL && this._calSeqHook) this._calSeqHook(seq);
      try { frame = encodeCommand(cmd, seq, params); } catch (e) { reject(new CommandError('LocalInvalid', `本地参数校验失败：${e.message}`)); return; }
      const reply = CMD_REPLY[cmd] || { ack: true };
      const flash = writesFlash(cmd, params);
      const p = { cmd, seq, reply, resolve: (v) => { if (flash) this.telemetry.endFlashWindow(this.now()); resolve(v); }, reject: (e) => { if (flash) this.telemetry.endFlashWindow(this.now()); reject(e); }, ack: null, data: null, timer: null };
      if (flash) this.telemetry.beginFlashWindow(this.now());
      this.pending = p;
      p.timer = setTimeout(() => { if (this.pending === p) { this.pending = null; if (!quiet) this.cmdStats.timeouts++; p.reject(new CommandError('Timeout', `${CMD_NAME[cmd] || hx(cmd)} 超时（${timeoutMs} ms，SEQ ${seq}${p.ack ? '，已收 ACK 未收配置' : ''}）`)); } }, timeoutMs);
      this.cmdStats.sent++;
      if (this.raw) this.raw('tx', 'aa55', frame, this.now());
      Promise.resolve(this.write(frame)).catch((e) => { if (this.pending === p) { this.pending = null; clearTimeout(p.timer); p.reject(new CommandError('NotConnected', e.message)); } });
    });
  }
  // 公开命令：串行（一次一条），只对 PING / 查询有限重试
  command(cmd, params = {}, { timeoutMs = this.timeoutMs, retries, quiet = false, owner = null } = {}) {
    if (UNSUPPORTED_CMDS[cmd]) { this.cmdStats.unsupportedBlocked++; return Promise.reject(new CommandError('Unsupported', `0x${cmd.toString(16)} ${UNSUPPORTED_CMDS[cmd]}：固件未实现，上位机不发送`)); }
    const maxRetry = RETRYABLE.has(cmd) ? (retries ?? this.retries) : 0;
    const run = async () => {
      if (this.otaActive && owner !== this.otaOwner) throw new CommandError('OtaActive', 'UART 升级进行中，已暂停其他命令');
      const guard = this._calGuard(cmd, params); if (guard) throw guard;
      this.busy++;
      try {
        for (let attempt = 0; ; attempt++) {
          try { return await this._once(cmd, params, timeoutMs, { quiet }); }
          catch (e) { if (e.kind !== 'Timeout' || attempt >= maxRetry) throw e; this.cmdStats.retries++; this.onEvent('warn', `${CMD_NAME[cmd]} 超时，重试 ${attempt + 1}/${maxRetry}`); }
        }
      } finally { this.busy--; }
    };
    const r = this.chain.then(run, run); this.chain = r.catch(() => {}); return r;
  }
  async query(cmd) { return (await this.command(cmd)).data; }
  // ---------- 六面校准 ----------
  get sixFaceSupported() { return !!(this.config && (this.config.capabilities & CAP_SIX_FACE)); }
  get calibrating() { return !!(this.calRun && !this.calRun.finished) || this.accCal?.state === 1; }
  // 校准中：固件不拦截 0x15 → 上位机必须拦截；写 Flash 的设置固件回 0x0604，上位机提前拦截；0x1C 不重复
  _calGuard(cmd, params) {
    if (!this.calibrating) return null;
    if (cmd === CMD.START_ACC_CAL && this.calRun?.starting) return null; // startSixFace 自身发出的那一条
    const why = cmd >= CMD.OTA_BEGIN && cmd <= CMD.OTA_ABORT ? 'UART 升级' : cmd === CMD.SYSTEM_RESET ? '复位（固件不会阻止，但会中断校准）' : cmd === CMD.START_ACC_CAL ? '重复启动' : writesFlash(cmd, params) ? '写 Flash 的设置（固件会回 0x0604）' : null;
    if (!why) return null;
    this.cmdStats.calBlocked = (this.cmdStats.calBlocked || 0) + 1;
    return new CommandError('CalibrationActive', `六面校准进行中，已拦截 ${CMD_NAME[cmd] || hx(cmd)}：${why}`);
  }
  _onCal(seq, d, now) {
    const prev = this.accCal; this.accCal = d;
    const run = this.calRun;
    if (run && seq === run.seq) run.lastPush = now;
    if (run && !run.finished) {
      const T = this.telemetry, last = T.lastAt ?? now;
      if (!run.finalAck) run.lastPushTelAt = last; // ACK 前最后一个 0x0A 时的最后一帧
      if ((d.done_mask & 0x3f) === 0x3f && run.mask3fTelAt == null) { run.mask3fTelAt = run.finalAck ? (run.lastPushTelAt ?? last) : last; T.calHoldFrom(run.mask3fTelAt); } // 首次看到 0x3F：暂挂起点 = 此前最后一帧
      if (run.finalAck && run.gapPending) this._calDecideGaps(run); // 最终 ACK 后紧跟的 0x0A
    }
    // ACK 后的 0x0A 只做交叉校验：st0 / st3+0x0607 却 mask ≠ 0x3F → 警告（不影响裁决，也不要求该帧）
    if (run && run.finalAck && !run.maskChecked && seq === run.seq) { run.maskChecked = true; const a = run.finalInfo || {};
      if ((a.status === 0 || (a.status === ACK.FAILED && a.detail === 0x0607)) && (d.done_mask & 0x3f) !== 0x3f) { run.maskMismatch = d.done_mask; this.onEvent('warn', `最终 ACK ${a.status === 0 ? 'st0' : 'st3/0x0607'} 后的 0x0A mask 0x${d.done_mask.toString(16).padStart(2, '0')} ≠ 0x3F（交叉校验不一致，跳号仍按正常处理）`); } }
    if (this.onCal) this.onCal(d);
  }
  // 17 → 1C（ACK 0x0100 + 0x0A）→ 0x0A 每 200 ms → 最终 ACK（启动 SEQ）→ 18。返回 run，run.final 为最终结果。
  async startSixFace() {
    if (!this.sixFaceSupported) throw new CommandError('Unsupported', '设备 capabilities bit7 未置位：不支持六面校准');
    if (this.calibrating) throw new CommandError('CalibrationActive', '六面校准已在进行');
    await this.command(CMD.ENTER_SETTINGS); this.settingsMode = true;
    const run = { seq: null, finished: false, startedAt: this.now(), lastPush: this.now(), recovered: false, result: null, starting: true };
    run.final = new Promise((res) => { run._resolve = res; });
    this.calRun = run; // 先注册最终 ACK 监听，再发送 0x1C
    this._calSeqHook = (seq) => { run.seq = seq; this._calSeq = seq; };
    try { const r = await this.command(CMD.START_ACC_CAL); this.accCal = r.data; }
    catch (e) {
      let ok = false;
      if (e.kind === 'Timeout') { // 0x1C 绝不自动重发：先查 0x24 恢复状态
        const q = await this.query(CMD.QUERY_ACC_CAL).catch(() => null);
        if (q && q.state === 1) { ok = true; run.recovered = true; run.lastPush = this.now(); this.onEvent('warn', '0x1C 应答超时；0x24 显示校准进行中，按设备状态继续（未重发 0x1C）'); }
        else if (q && q.state !== 1) this.onEvent('error', `0x1C 应答超时；0x24 显示 ${CAL_STATE[q.state] ?? q.state}，未重发 0x1C`);
      }
      if (!ok) { this.calRun = null; await this._exitSettings(); throw e; }
    } finally { this._calSeqHook = null; run.starting = false; }
    clearInterval(this._calWatch);
    this._calWatch = setInterval(() => this._calWatchdog(), 500);
    return run;
  }
  // 推送中断时用 0x24 恢复状态（不发 0x1C）
  async _calWatchdog() {
    const run = this.calRun; if (!run || run.finished) { clearInterval(this._calWatch); return; }
    if (this.pending || this.busy || this.now() - run.lastPush < 1500) return;
    const q = await this.query(CMD.QUERY_ACC_CAL).catch(() => null);
    if (!q || run.finished) return;
    run.lastPush = this.now();
    if (q.state === 0) this._calAbandon('推送中断且 0x24 显示空闲（设备可能已复位）');
    else if (q.state !== 1) this._calFinal({ status: q.state === 2 ? 0 : 3, detail: q.state === 4 ? CAL_CANCELLED : q.error, fromQuery: true });
  }
  // 最终 ACK（同步处理，早于其后的遥测帧）：没见过 phase 3 / 0x3F 也照样触发。暂挂起点 = 0x3F 前最后一帧，最迟 = ACK 前最后一个 0x0A 时的最后一帧
  _calFinalSync(ack) {
    const run = this.calRun; if (!run || run.finished || run.finalAck) return;
    run.finalAck = true; run.finalInfo = ack; run.gapPending = true;
    run.gapFrom = run.mask3fTelAt ?? run.lastPushTelAt ?? this.telemetry.lastAt ?? this.now();
    this.telemetry.calHoldFrom(run.gapFrom);
    clearTimeout(run.gapTimer); run.gapTimer = setTimeout(() => { if (run.gapPending) this._calDecideGaps(run); }, 2000); // 兜底
    this._calFinal(ack);
  }
  // 裁决（固件确认）：st0 与 st3/0x0607 只可能来自 acc_six_face_saved()——6 面完成、拟合通过、已进入 phase 3 → 正常；
  // 不要求见过 mask 0x3F，也不等 ACK 后的 0x0A（该帧只做交叉校验）。其余（0x0603/0x0605/0x0606/0x0608…）→ 丢失
  _calDecideGaps(run) {
    if (!run.gapPending) return; run.gapPending = false; clearTimeout(run.gapTimer);
    const a = run.finalInfo || {};
    const normal = a.status === 0 || (a.status === ACK.FAILED && a.detail === 0x0607);
    run.gapDecision = normal ? 'normal' : 'loss';
    this.telemetry.calCommit(normal, this.now(), run.gapFrom ?? -Infinity);
  }
  async _calFinal(ack) {
    const run = this.calRun; if (!run || run.finished) return;
    run.finished = true; clearInterval(this._calWatch);
    const cancelled = ack.status !== 0 && ack.detail === CAL_CANCELLED;
    if (!run.finalAck) { run.finalAck = true; run.finalInfo = ack; run.gapPending = true; run.gapFrom = run.mask3fTelAt ?? run.lastPushTelAt ?? -Infinity; } // 0x24 收尾：同一规则
    await new Promise((r) => setTimeout(r, 0)); // 最终 ACK 后紧跟一帧 0x0A（同一读取块）
    if (ack.fromQuery && run.gapPending) this._calDecideGaps(run);
    if (this.settingsMode) await this._exitSettings();
    run.result = { ok: ack.status === 0, cancelled, status: ack.status, detail: ack.detail, errorText: ack.status === 0 ? '' : (CAL_ERROR[ack.detail] || ackText(ack.status, ack.detail)), cal: this.accCal, recoveredFromQuery: !!ack.fromQuery };
    this.onEvent(run.result.ok ? 'ok' : cancelled ? 'warn' : 'error', run.result.ok ? '六面校准完成并已保存到 Flash' : cancelled ? '六面校准已取消（最终 ACK 0x0608）' : `六面校准失败：${run.result.errorText}`);
    this.onUpdate('CAL_FINAL'); run._resolve(run.result);
  }
  async _exitSettings() { try { await this.command(CMD.EXIT_SETTINGS); this.settingsMode = false; } catch (e) { this.onEvent('error', `退出设置模式失败：${e.message}`); } }
  // 取消：0x25（ACK + 0x0A）或 0x18（退出设置模式也会取消）；之后最终 ACK st3/0x0608
  // 未在校准时 0x25 只回 ACK + 0x0A，没有最终 ACK → 不等；最终 ACK 迟迟不到时用 0x24 收尾（有界）
  async cancelSixFace({ via = 0x25, finalWaitMs = 1500 } = {}) {
    const run = this.calRun && !this.calRun.finished ? this.calRun : null;
    let reply = null;
    if (via === CMD.EXIT_SETTINGS) { await this.command(CMD.EXIT_SETTINGS); this.settingsMode = false; }
    else reply = (await this.command(CMD.CANCEL_ACC_CAL)).data;
    if (!run) { if (this.settingsMode && !this.calibrating) await this._exitSettings(); return { ok: false, cancelled: false, noRun: true, cal: reply || this.accCal }; }
    let timer; const late = new Promise((r) => { timer = setTimeout(() => r('late'), finalWaitMs); });
    const first = await Promise.race([run.final, late]); clearTimeout(timer);
    if (first !== 'late') return first;
    const q = await this.query(CMD.QUERY_ACC_CAL).catch(() => null);
    if (!run.finished) this._calFinal({ status: 3, detail: q?.state === 4 || !q || q.state === 0 ? CAL_CANCELLED : (q.error || CAL_CANCELLED), fromQuery: true, noFinalAck: true });
    return run.final;
  }
  // 断开 / 复位：设备不会再发最终 ACK → 结束等待（不挂起）
  _calAbandon(reason) { const run = this.calRun; if (!run || run.finished) return; run.finished = true; clearInterval(this._calWatch); clearTimeout(run.gapTimer); run.gapPending = false; this.telemetry.calRelease(); this.settingsMode = false; run.result = { ok: false, cancelled: false, lost: true, status: null, detail: 0, errorText: `校准中断：${reason}（无最终 ACK）`, cal: this.accCal, recoveredFromQuery: false }; this.onEvent('warn', run.result.errorText); this.onUpdate('CAL_FINAL'); run._resolve(run.result); }
  cancelAll(reason = '已断开') { this._calAbandon(reason); const p = this.pending; if (p) { this.pending = null; clearTimeout(p.timer); p.reject(new CommandError('Cancelled', reason)); } }

  // ---------- 流程 ----------
  // 握手：只查询，不写 Flash，不发 vofa，不发 0x1D
  async handshake({ settleMs = 200 } = {}) {
    await new Promise((r) => setTimeout(r, settleMs));
    this.telemetry.rebuild('连接');
    await this.command(CMD.PING);
    const fw = await this.query(CMD.QUERY_FW_INFO);
    const cfg = await this.query(CMD.QUERY_CONFIG);
    await this.query(CMD.QUERY_FILTER);
    await this.query(CMD.QUERY_STATUS);
    if (this.sixFaceSupported) { const c = await this.query(CMD.QUERY_ACC_CAL).catch(() => null); if (c?.state === 1) this.onEvent('warn', '设备上已有六面校准在进行（0x24）：已锁定复位与保存'); else if (this.calRun && !this.calRun.finished) this._calAbandon('重新握手时 0x24 显示未在校准（设备可能已复位）'); }
    else if (this.calRun && !this.calRun.finished) this._calAbandon('重新握手');
    this.onEvent('ok', `握手完成：固件 ${fw.text}${fw.mock ? '（Mock 模拟数据）' : ''} · ${FORMAT_NAME[cfg.uart_format] ?? cfg.uart_format} · ${cfg.output_hz} Hz`);
    return { firmware: fw, config: cfg, filter: this.filter, system: this.system };
  }
  // 0x20：RAM / 保存（persist=1 写 Flash）。成功 ACK + 0x07 回读后才算完成
  async setOutputConfig({ format, mask, persist = 0 }) {
    const r = await this.command(CMD.SET_OUTPUT_CONFIG, { port: 0, format, mask, persist });
    if (r.data.uart_format !== format || r.data.uart_mask !== mask) throw new CommandError('VerifyMismatch', `回读不一致：format ${r.data.uart_format} mask 0x${r.data.uart_mask.toString(16)}`);
    this.telemetry.rebuild('输出格式变化');
    return r.data;
  }
  previewCustom9() { return this.setOutputConfig({ format: FORMAT.CUSTOM, mask: MASK_ALL, persist: 0 }); } // 20 00 01 FF 01 00
  async setLegacyPreset(preset) { await this.command(CMD.SET_STREAM_MODE, { preset }); this.telemetry.rebuild('旧预设'); return this.query(CMD.QUERY_CONFIG); }
  // 0x1D 总是写 Flash：仅由用户显式操作调用
  async saveOutputHz(hz) {
    const r = await this.command(CMD.SET_OUTPUT_HZ, { hz });
    if (r.data.output_hz !== hz || r.data.saved_output_hz !== hz) throw new CommandError('VerifyMismatch', `回读不一致：active ${r.data.output_hz} / saved ${r.data.saved_output_hz} Hz`);
    return r.data;
  }
  // 17 → 27 → 18（失败也退出设置模式）
  async setFilter(profile, persist = 0) {
    if (this.calibrating) throw new CommandError('CalibrationActive', '六面校准进行中：设置滤波需 17→27→18，而 0x18 会取消校准，已拦截');
    if (!LIMITS.profile(profile) || !LIMITS.persist(persist)) throw new CommandError('LocalInvalid', '非法滤波档位或保存标记');
    if (!this.filter) await this.query(CMD.QUERY_FILTER);
    if (profile >= this.filter.profile_count) throw new CommandError('Unsupported', '设备未声明该滤波档位，未发送设置命令');
    let result, error;
    await this.command(CMD.ENTER_SETTINGS); this.settingsMode = true;
    try { result = (await this.command(CMD.SET_FILTER, { profile, persist })).data; }
    catch (e) { error = e; }
    try { await this.command(CMD.EXIT_SETTINGS); this.settingsMode = false; }
    catch (e) { this.onEvent('error', `退出设置模式失败：${e.message}`); if (!error) error = e; }
    if (error) throw error;
    if (result.active_profile !== profile || (persist && result.saved_profile !== profile)) throw new CommandError('VerifyMismatch', `回读不一致：active ${result.active_profile} / saved ${result.saved_profile}`);
    return result;
  }
  zeroYaw() { return this.command(CMD.ZERO_YAW); }
  // ASCII vofa：切 RAM JustFloat、保留 mask，无 ACK → 等待后查询 0x1F 确认（仅用户显式操作）
  sendVofa({ settleMs = 60 } = {}) {
    const run = async () => {
      if (this.raw) this.raw('tx', 'ascii', VOFA_BYTES, this.now());
      await this.write(VOFA_BYTES); await new Promise((r) => setTimeout(r, settleMs));
    };
    const r = this.chain.then(run, run); this.chain = r.catch(() => {});
    return r.then(() => { this.parser.configure({ jfEnabled: true, jfChannels: null }); this.telemetry.rebuild('vofa'); return this.query(CMD.QUERY_CONFIG); });
  }
  // 复位：0x15 不重试。固件 ACK 发完、TX 队列排空后复位并从 Flash 载入已保存配置（RAM 临时设置丢失），SEQ 从 0、timestamp=开机 ms。
  // 重启时长不固定：按有界节奏重发 PING，首个 PING 应答即视为恢复，然后重新握手并重建统计基线。
  async reset({ pingTimeoutMs = 200, pingIntervalMs = 50, maxWaitMs = 5000 } = {}) {
    await this.command(CMD.SYSTEM_RESET, {}, { retries: 0 });
    this.cmdStats.resets++;
    const t0 = this.now(); this.telemetry.rebuild('复位');
    let online = false, n = 0;
    while (this.now() - t0 < maxWaitMs) {
      await new Promise((r) => setTimeout(r, pingIntervalMs));
      n++; this.cmdStats.rebootPings++;
      try { await this.command(CMD.PING, {}, { timeoutMs: pingTimeoutMs, retries: 0, quiet: true }); online = true; break; }
      catch (e) { if (e.kind !== 'Timeout') throw e; }
    }
    if (!online) throw new CommandError('Timeout', `复位后 ${maxWaitMs} ms 内无 PING 应答（已尝试 ${n} 次）`);
    this.cmdStats.lastRebootMs = Math.round(this.now() - t0);
    this.onEvent('ok', `设备已重启：第 ${n} 次 PING 应答，约 ${this.cmdStats.lastRebootMs} ms`);
    this.telemetry.rebuild('复位后恢复'); this.settingsMode = false;
    return this.handshake({ settleMs: 0 });
  }
  // 批量命令期间暂停遥测（mask=0, persist=0），结束后按原 format/mask RAM 恢复
  async withTelemetryPaused(fn) {
    const c = this.config; if (!c || c.uart_format === FORMAT.LEGACY || c.uart_mask === 0) return fn();
    const keep = { format: c.uart_format, mask: c.uart_mask };
    await this.setOutputConfig({ format: keep.format, mask: 0, persist: 0 });
    try { return await fn(); } finally { await this.setOutputConfig({ ...keep, persist: 0 }).catch((e) => this.onEvent('error', `恢复遥测失败：${e.message}`)); }
  }
}
function hx(n) { return `0x${n.toString(16).padStart(2, '0')}`; }
