// protocol.test.mjs — 交接文档 §10 编解码向量与解析验收（纯 Node，SRC=live 时测线上同一份代码）。Mock / 构造字节，不是实板。
import { load, check, summary } from './_src.mjs';
const P = await load('protocol.js');
const { MockCh32Device } = await load('mock-device.js');
const { StreamParser, encodeFrame, encodeCommand, encodeCustom, encodeJustFloat, encodeMessage, hex, fromHex, crc16, MSG, CMD, MASK_ALL } = P;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const collect = (opts = {}) => { const out = { frames: [], jf: [] }; const p = new StreamParser({ onFrame: (f) => out.frames.push(f), onJustFloat: (v) => out.jf.push(v) }); p.configure(opts); out.p = p; return out; };
const cust = (seq, vals = {}, mask = MASK_ALL, ts = 0) => encodeCustom(seq, mask, ts, { yaw: 1, pitch: 2, roll: 3, ax: 0.1, ay: 0.2, az: 9.8, gx: 4, gy: 5, gz: 6, ...vals });
const cat = (...a) => { const n = a.reduce((s, x) => s + x.length, 0), o = new Uint8Array(n); let k = 0; for (const x of a) { o.set(x, k); k += x.length; } return o; };

console.log('§10 编解码向量');
check('crc("123456789") = 0x29B1', crc16(new TextEncoder().encode('123456789')) === 0x29b1);
check('pack(0x10,0) = aa55100000ff8f', hex(encodeCommand(CMD.PING, 0)) === 'aa55100000ff8f');
check('pack(0x1F,1) = aa551f0001efb3', hex(encodeCommand(CMD.QUERY_CONFIG, 1)) === 'aa551f0001efb3');
check('pack(0x20,2,0001ff0100) = aa552005020001ff01005732', hex(encodeCommand(CMD.SET_OUTPUT_CONFIG, 2, { port: 0, format: 1, mask: 0x1ff, persist: 0 })) === 'aa552005020001ff01005732');
check('pack(0x20,3,0001000000) = aa552005030001000000a58b', hex(encodeCommand(CMD.SET_OUTPUT_CONFIG, 3, { port: 0, format: 1, mask: 0, persist: 0 })) === 'aa552005030001000000a58b');
check('layout sizes 05=16 07=28 0B=16 32=16 0A=60 90=4 01=16 04=12 03=28', [[5, 16], [7, 28], [0x0b, 16], [0x32, 16], [0x0a, 60], [0x90, 4], [1, 16], [4, 12], [3, 28]].every(([m, n]) => P.layoutSize(P.LAYOUTS[m]) === n));
check('Custom 9 字段 payload 40 / 整帧 47', cust(0).length === 47 && cust(0)[3] === 40);
check('payload > 64 拒绝组帧', (() => { try { encodeFrame(0x7e, 0, new Uint8Array(65)); return false; } catch { return true; } })());
check('本地参数校验：Hz 白名单 / port=0 / format 0..1 / mask 9 位 / profile 0..3', ['hz:300', 'port:1', 'format:2', 'mask:512', 'profile:4'].every((x) => { const [k, v] = x.split(':'); const cmd = { hz: CMD.SET_OUTPUT_HZ, port: CMD.SET_OUTPUT_CONFIG, format: CMD.SET_OUTPUT_CONFIG, mask: CMD.SET_OUTPUT_CONFIG, profile: CMD.SET_FILTER }[k]; const base = { port: 0, format: 1, mask: 1, persist: 0, profile: 0, hz: 200 }; try { P.encodeCommandPayload(cmd, { ...base, [k]: Number(v) }); return false; } catch { return true; } }) && P.OUTPUT_HZ.join() === '1,2,4,5,8,10,16,20,25,40,50,80,100,125,200,250,400,500,1000,2000');

console.log('解析：半包 / 粘包 / 噪声 / 边界');
{ const c = collect({ jfEnabled: false }); const f = cust(7); for (const b of f) c.p.push(Uint8Array.of(b)); check('半包：逐字节输入 → 1 帧', c.frames.length === 1 && c.frames[0].data.az > 9.7 && c.frames[0].seq === 7); }
{ const c = collect({ jfEnabled: false }); c.p.push(cat(cust(1), cust(2), encodeMessage(MSG.ACK, 9, { cmd_id: 0x10, status: 0, detail: 0 }), cust(3))); check('粘包：4 帧一个块 → 4 帧顺序正确', c.frames.map((f) => f.seq).join() === '1,2,9,3'); }
{ const c = collect({ jfEnabled: false }); c.p.push(cat(Uint8Array.of(1, 2, 3, 0x55, 0x00, 0xff), cust(1), Uint8Array.of(0x13, 0x37), cust(2))); check('噪声：帧间垃圾丢弃并重同步', c.frames.length === 2 && c.p.stats.noiseBytes === 8 && c.p.stats.crcErrors === 0); }
{ const c = collect({ jfEnabled: false }); c.p.push(cat(Uint8Array.of(0xaa), cust(5))); check('AA AA 55：从第二个 AA 同步', c.frames.length === 1 && c.frames[0].seq === 5 && c.p.stats.noiseBytes === 1); }
{ const inner = encodeCommand(CMD.PING, 3), payload = cat(inner, new Uint8Array(3)); const f = encodeFrame(0x7e, 4, payload); const c = collect({ jfEnabled: false }); c.p.push(f); check('payload 内含完整 AA55 帧：只出外层 1 帧', c.frames.length === 1 && c.frames[0].msg === 0x7e && c.frames[0].payload.length === 10); }
{ const buf = new ArrayBuffer(4); new DataView(buf).setUint32(0, 0x0a0055aa, true); const v = new DataView(buf).getFloat32(0, true); const c = collect({ jfEnabled: false }); c.p.push(cust(6, { yaw: v })); check('float 中的 AA 55 字节不截断 Custom 帧', c.frames.length === 1 && Object.is(c.frames[0].data.yaw, v)); }
{ const f = cust(1); f[10] ^= 0x40; const c = collect({ jfEnabled: false }); c.p.push(cat(f, cust(2))); check('CRC 错误：计数 +1，不出帧，下一帧正常', c.p.stats.crcErrors === 1 && c.frames.length === 1 && c.frames[0].seq === 2); }
{ const c = collect({ jfEnabled: false }); const f64 = encodeFrame(0x7e, 1, new Uint8Array(64).fill(0x5a)); c.p.push(f64); check('LEN=64 边界：合法帧（整帧 71 字节）', c.frames.length === 1 && c.frames[0].payload.length === 64 && f64.length === 71); }
{ const c = collect({ jfEnabled: false }); const bad = Uint8Array.of(0xaa, 0x55, 0x7e, 65, 0x01, ...new Array(67).fill(0)); c.p.push(cat(bad, cust(8))); check('LEN=65：LEN 错误计数，重同步到下一帧', c.p.stats.lenErrors === 1 && c.frames.length === 1 && c.frames[0].seq === 8); }
for (const jf of [false, true]) {
  const c = collect({ jfEnabled: jf }); let seed = 7; const rnd = () => ((seed = (seed * 1103515245 + 12345) >>> 0) >>> 24);
  for (let k = 0; k < 200; k++) { const g = new Uint8Array(512); for (let i = 0; i < 512; i++) g[i] = (i % 37 === 0) ? 0xaa : (i % 37 === 1 ? 0x55 : rnd()); c.p.push(g); }
  const maxLen = c.p.len; c.p.push(cat(new Uint8Array(80), cust(9)));
  check(`持续错误输入 100 KB（JF ${jf ? '开' : '关'}）：缓冲有界(${maxLen}≤71) 并重新同步`, maxLen <= P.MAX_FRAME && c.p.buf.length <= 16384 && c.frames.some((f) => f.msg === MSG.CUSTOM && f.seq === 9));
}

console.log('Custom 0x06 解码');
{ const c = collect({ jfEnabled: false }); c.p.push(cust(1, {}, 0b101)); const d = c.frames[0].data; check('字段选择 mask 0x005 → 只有 Yaw、Roll，LEN=12', c.frames[0].payload.length === 12 && d.yaw === 1 && d.roll === 3 && !('pitch' in d) && !('az' in d)); }
{ const c = collect({ jfEnabled: false }); const p = new Uint8Array(44); new DataView(p.buffer).setUint16(0, 0x1ff, true); c.p.push(encodeFrame(MSG.CUSTOM, 1, p)); check('LEN 与 popcount 不符（44≠40）→ bad', c.frames[0].type === 'bad'); }
{ const c = collect({ jfEnabled: false }); const p = new Uint8Array(8); new DataView(p.buffer).setUint16(0, 0x200, true); c.p.push(encodeFrame(MSG.CUSTOM, 1, p)); check('mask 高位 bit9 → bad', c.frames[0].type === 'bad'); }
{ const c = collect({ jfEnabled: false }); c.p.push(cust(1, { pitch: NaN })); check('非有限浮点 → bad', c.frames[0].type === 'bad'); }
{ const c = collect({ jfEnabled: false }); c.p.push(encodeMessage(MSG.DEVICE_CONFIG, 1, {}).slice(0, 0)); const p = new Uint8Array(18); c.p.push(encodeFrame(MSG.DEVICE_CONFIG, 1, p)); check('0x07 旧版 18 字节 → bad（v3 必须 28）', c.frames[0].type === 'bad'); }

console.log('JustFloat 与混合流');
for (const n of [1, 3, 9]) {
  const c = collect({ jfEnabled: true, jfChannels: n }); const parts = []; const acks = [];
  for (let k = 0; k < 50; k++) { parts.push(encodeJustFloat(Array.from({ length: n }, (_, i) => k + i / 10))); if (k % 5 === 0) { const a = encodeMessage(MSG.ACK, k, { cmd_id: 0x10, status: 0, detail: 0 }); parts.push(a); acks.push(k); } if (k % 7 === 0) parts.push(encodeMessage(MSG.DEVICE_CONFIG, k, { version: 3, capabilities: 0x44, uart_format: 0, uart_mask: (1 << n) - 1, output_hz: 200 })); }
  const all = cat(...parts); for (let i = 0; i < all.length; i += 13) c.p.push(all.slice(i, i + 13));
  check(`JF ${n} 通道 + ACK/配置混流（13 字节分块）：50 JF / ${acks.length} ACK / 8 配置，0 丢弃`, c.jf.length === 50 && c.jf.every((v, k) => v.length === n && v[0] === k) && c.frames.filter((f) => f.msg === MSG.ACK).length === acks.length && c.frames.filter((f) => f.msg === MSG.DEVICE_CONFIG).length === 8 && c.p.stats.noiseBytes === 0 && c.p.stats.crcErrors === 0);
}
{ const buf = new ArrayBuffer(8), v = new DataView(buf); v.setUint32(0, 0x041090aa >>> 0, true); v.setUint32(4, 0x55aa0000 >>> 0, true); const f1 = v.getFloat32(0, true), f2 = v.getFloat32(4, true);
  const c = collect({ jfEnabled: true, jfChannels: 3 }); c.p.push(cat(encodeJustFloat([f1, f2, 1.5]), encodeJustFloat([1, 2, 3])));
  check('JF float 内含 AA 55 / AA 55 90 04 不截断', c.jf.length === 2 && Object.is(c.jf[0][0], f1) && Object.is(c.jf[0][1], f2) && c.frames.length === 0); }
{ const c = collect({ jfEnabled: true, jfChannels: 3 }); c.p.push(cat(new Uint8Array([1, 2, 3, 4, 5]), encodeJustFloat([1, 2, 3]))); check('JF 前的过渡字节：丢弃后对齐', c.jf.length === 1 && c.jf[0][2] === 3); }
{ const c = collect({ jfEnabled: false }); c.p.push(encodeJustFloat([1, 2, 3])); check('Custom 模式下 JF 字节不被误判', c.jf.length === 0 && c.frames.length === 0); }

console.log('遥测统计（SEQ / timestamp 模差）');
{ const t = new P.TelemetryStats(); let now = 0; for (let s = 250; s < 262; s++) t.add(s & 0xff, (s * 5) & 0xffff, now += 5); check('SEQ 250→5 回绕：缺失 0、回绕 1', t.missing === 0 && t.seqWraps === 1); }
{ const t = new P.TelemetryStats(); [1, 2, 2, 3, 6].forEach((s, i) => t.add(s, i, i)); check('重复 SEQ 计 1 次重复，不算 255 丢失；1→… 6 缺 2', t.duplicates === 1 && t.missing === 2); }
{ const t = new P.TelemetryStats(); [65530, 65535, 4, 9].forEach((ts, i) => t.add(i, ts, i * 5)); check('timestamp 65530→4 回绕：tsWraps=1，不重建基线', t.tsWraps === 1 && t.baselineResets === 0 && t.missing === 0); }
{ const t = new P.TelemetryStats(); t.add(10, 0, 0); t.add(200, 0, 5); check('无法区分的 SEQ 跳变 → 重建基线，不计 189 丢失', t.missing === 0 && t.baselineResets === 1); }
{ const t = new P.TelemetryStats(); t.add(1, 0, 0); t.add(2, 0, 3000); check('长时间中断（>2 s）→ 重建基线', t.baselineResets === 1); }

// ---------- 会话 + Mock 固件 ----------
function rig(opts = {}, { async = false } = {}) {
  const d = new MockCh32Device({ ...opts }); let s; const chunks = [];
  d.onTx = (b) => { chunks.push(b); if (async) queueMicrotask(() => s.feed(b)); else s.feed(b); };
  s = new P.Ch32Session({ write: (b) => d.write(b), now: () => d.t, timeoutMs: opts.timeoutMs || 300, rawLog: opts.rawLog });
  const timer = setInterval(() => d.advance(5), 5);
  return { d, s, chunks, stop: () => { clearInterval(timer); s.cancelAll(); } };
}
console.log('会话：握手、查询、ACK 匹配');
{ const r = rig(); const h = await r.s.handshake({ settleMs: 20 });
  check('握手顺序 10 → 23 → 1F → 26 → 14 → 24（只查询；bit7 置位时查询校准状态）', r.d.rxCommands.join() === [0x10, 0x23, 0x1f, 0x26, 0x14, 0x24].join());
  check('连接无 Flash 写入、无 0x1D、无 vofa、无 USB/CAN(21/22) 与 28..33 轮询', r.d.flashWrites === 0 && !r.d.rxCommands.includes(0x1d) && !r.d.vofaCount && !r.d.rxCommands.some((c) => c === 0x21 || c === 0x22 || (c >= 0x28 && c <= 0x33)));
  check('0x32 Mock 固件 20261003m 标记为 Mock', h.firmware.text === '20261003m' && h.firmware.mock === true);
  check('0x07 v3：caps 0xC4、UART、Custom 0x1FF、200/200 Hz、USB 占位 1/0/0、量程 125', h.config.version === 3 && h.config.capabilities === 0xc4 && h.config.source === 0 && h.config.uart_format === 1 && h.config.uart_mask === 0x1ff && h.config.output_hz === 200 && h.config.saved_output_hz === 200 && h.config.usb_format === 1 && h.config.usb_mask === 0 && h.config.active_gyro_range_dps === 125);
  check('0x07 能力位 → 自选输出 + 频率持久化 + 六面校准（bit7）', P.capsList(h.config.capabilities).join() === 'CUSTOM_OUTPUT,PERSIST_HZ,SIX_FACE_CAL' && h.config.capabilities & P.CAP_SIX_FACE);
  check('0x0B：count=4（数量）、active/saved 1、2000 Hz、τmag 0、τAcc 2.5', h.filter.profile_count === 4 && h.filter.active_profile === 1 && h.filter.saved_profile === 1 && h.filter.estimator_hz === 2000 && h.filter.tau_mag_s === 0 && Math.abs(h.filter.rest_tau_s - 2.5) < 1e-6);
  check('0x05：2000 / 200 / skip 10 / 温度 °C / stream_mode 0xFF / can_ok', h.system.fusion_hz === 2000 && h.system.output_hz === 200 && h.system.skip === 10 && h.system.temperature_c > 20 && h.system.temperature_c < 45 && h.system.stream_mode === 0xff && h.system.can_ok === 1);
  check('查询直接应答（握手中仅 PING 有 ACK）', r.chunks.filter((c) => c[2] === MSG.ACK).length === 1);
  await sleep(500);
  const L = r.s.last; check('Custom 九字段遥测：m/s²（|a|≈9.81）+ deg/s', L && Math.abs(Math.hypot(...L.accel) - 9.80665) < 0.1 && L.gyro.length === 3);
  check('实收率按 PC 单调时钟（设备时钟快 0.84% 不影响）≈200 Hz', Math.abs(r.s.telemetry.rateHz(r.d.t) - 200) < 6, r.s.telemetry.rateHz(r.d.t));
  check('遥测 SEQ 无缺失 / CRC 0', r.s.telemetry.missing === 0 && r.s.parser.stats.crcErrors === 0);
  r.stop(); }
{ const r = rig(); await r.s.handshake({ settleMs: 0 }); const before = r.chunks.length;
  await r.s.previewCustom9(); const ackChunk = r.chunks.slice(before).find((c) => c[2] === MSG.ACK);
  check('设置命令 ACK + 0x07 在同一读取块（监听先注册）', ackChunk && ackChunk.length === 11 + 35 && ackChunk[11 + 2] === MSG.DEVICE_CONFIG);
  r.stop(); }
{ // 意外 ACK / 迟到应答 / SEQ 回绕：用手动设备
  const sent = []; const s = new P.Ch32Session({ write: (b) => { sent.push(b); }, timeoutMs: 200, retries: 1 });
  s.seq = 254;
  const p1 = s.command(CMD.ZERO_YAW); await sleep(1); const seq1 = sent[0][4];
  s.feed(encodeMessage(MSG.ACK, seq1, { cmd_id: CMD.PING, status: 0, detail: 0 })); // cmd 不符
  s.feed(encodeMessage(MSG.ACK, (seq1 - 1) & 0xff, { cmd_id: CMD.ZERO_YAW, status: 0, detail: 0 })); // SEQ 不符（上一轮）
  let done = false; p1.then(() => { done = true; }, () => {}); await sleep(5);
  check('意外 ACK（cmd 不符 / 旧 SEQ）不完成当前命令', !done && s.cmdStats.unexpectedAcks === 2);
  s.feed(encodeMessage(MSG.ACK, seq1, { cmd_id: CMD.ZERO_YAW, status: 0, detail: 0 })); await p1;
  check('SEQ 255 正确匹配', seq1 === 255);
  const p2 = s.query(CMD.QUERY_CONFIG); await sleep(1); const seq2 = sent[1][4];
  check('SEQ 回绕 255 → 0', seq2 === 0);
  // 不应答 → 超时重试（新 SEQ）；第一次的迟到应答到达时不能完成第二次
  await sleep(230); check('查询超时自动重试 1 次（新 SEQ）', sent.length === 3 && sent[2][4] === 1 && s.cmdStats.retries === 1 && s.cmdStats.timeouts === 1);
  const cfg = { version: 3, capabilities: 0x44, uart_format: 1, uart_mask: 0x1ff, output_hz: 200, saved_output_hz: 200 };
  s.feed(encodeMessage(MSG.DEVICE_CONFIG, seq2, cfg)); let done2 = false; p2.then(() => { done2 = true; }, () => {}); await sleep(5);
  check('迟到应答（旧 SEQ）不完成重试中的命令', !done2 && s.cmdStats.lateReplies === 1);
  s.feed(encodeMessage(MSG.DEVICE_CONFIG, 1, cfg)); const got = await p2; check('匹配 SEQ 的应答完成命令', got.uart_mask === 0x1ff);
  // 非可重试命令：超时不重发
  const n0 = sent.length; const e = await s.command(CMD.SYSTEM_RESET).catch((x) => x); await sleep(300);
  check('复位超时：不自动重发，报告 Timeout', e.kind === 'Timeout' && sent.length === n0 + 1);
  const e2 = await s.command(CMD.SET_OUTPUT_HZ, { hz: 100 }).catch((x) => x);
  check('保存频率超时：不自动重发', e2.kind === 'Timeout' && sent.length === n0 + 2);
  const e3 = await s.command(0x12).catch((x) => x); const e5 = await s.command(0x16).catch((x) => x);
  check('未实现命令（12 陀螺校准 / 16 Bootloader）本地拦截，不发送；1C 已不在未实现列表', !P.UNSUPPORTED_CMDS[0x1c] && [e3, e5].every((x) => x.kind === 'Unsupported') && sent.length === n0 + 2);
  const e6 = await s.command(CMD.SET_OUTPUT_HZ, { hz: 300 }).catch((x) => x); check('非法 Hz 本地拒绝，不发送', e6.kind === 'LocalInvalid' && sent.length === n0 + 2);
}
{ // 一次只有一条命令
  const r = rig(); const order = []; const w = r.s.write; let inflight = 0, maxIn = 0;
  r.s.write = (b) => { inflight++; maxIn = Math.max(maxIn, inflight); order.push(b[2]); return w(b); };
  const origFinish = r.s._finish.bind(r.s); r.s._finish = (p, e) => { inflight--; return origFinish(p, e); };
  await Promise.all([r.s.command(CMD.PING), r.s.query(CMD.QUERY_STATUS), r.s.query(CMD.QUERY_FILTER), r.s.command(CMD.PING)]);
  check('并发调用被串行化：同时在途 ≤1，顺序保持', maxIn === 1 && order.join() === [0x10, 0x14, 0x26, 0x10].join());
  r.stop(); }

console.log('配置：RAM / Flash、失败 ACK、复位回读');
{ const r = rig(); await r.s.handshake({ settleMs: 0 });
  const f2 = await r.s.setFilter(2, 0);
  check('滤波 RAM：active 2 / saved 1，17→27→18 且退出设置模式', f2.active_profile === 2 && f2.saved_profile === 1 && r.d.rxCommands.slice(-3).join() === '23,39,24' && !r.d.settings && r.d.flashWrites === 0);
  const f0 = await r.s.setFilter(0, 1); check('滤波 persist=1：active 0 / saved 0（只写 1 次 Flash）', f0.active_profile === 0 && f0.saved_profile === 0 && r.d.flashWrites === 1);
  r.d.failFlash = true;
  const e = await r.s.setFilter(2, 1).catch((x) => x);
  check('Flash 失败 → status 3 / 0x0607，不显示成功，不应用新值', e.kind === 'AckFailed' && e.ack.detail === 0x0607 && r.s.filter.active_profile === 0 && r.s.filter.saved_profile === 0);
  check('失败路径也退出设置模式（…27→18）', r.d.rxCommands.slice(-2).join() === '39,24' && !r.d.settings && !r.s.settingsMode);
  const e2 = await r.s.saveOutputHz(100).catch((x) => x);
  check('保存频率 Flash 失败：AckFailed，回读仍 200/200', e2.kind === 'AckFailed' && e2.ack.detail === 0x0607 && r.s.config.output_hz === 200 && r.s.config.saved_output_hz === 200 && r.s.cmdStats.ackFailures === 2);
  r.d.failFlash = false;
  const c = await r.s.saveOutputHz(100); check('显式保存 100 Hz：active/saved 100（写 Flash）', c.output_hz === 100 && c.saved_output_hz === 100);
  await r.s.setOutputConfig({ format: 0, mask: 0x007, persist: 0 }); check('RAM 切 JustFloat 3 通道（未保存）', r.s.config.uart_format === 0 && r.s.config.uart_mask === 7);
  const nWr = r.d.flashWrites;
  const before = r.s.telemetry.baselineResets;
  const to0 = r.s.cmdStats.timeouts;
  const h = await r.s.reset();
  check(`复位后按有界节奏 PING，首个应答即恢复（Mock 重启 ${Math.round(r.d.lastRebootMs)} ms，PING ${r.s.cmdStats.rebootPings} 次，${r.s.cmdStats.lastRebootMs} ms）；重启期间 PING 超时不计入命令超时`, r.s.cmdStats.rebootPings >= 2 && r.s.cmdStats.lastRebootMs >= r.d.lastRebootMs && r.s.cmdStats.timeouts === to0);
  check('复位：ACK、MCU 重启、重新握手；回读 saved 100 Hz 与已保存 Custom 0x1FF（RAM JF 丢失）', r.d.resets === 1 && h.config.output_hz === 100 && h.config.saved_output_hz === 100 && h.config.uart_format === 1 && h.config.uart_mask === 0x1ff && r.d.flashWrites === nWr);
  await sleep(300);
  check('复位后统计基线重建：SEQ 归零不计为丢失（非 Flash 缺失 0）', r.s.telemetry.baselineResets > before && r.s.telemetry.unexpectedMissing === 0 && r.s.last.seq < 120);
  r.stop(); }
{ const r = rig(); await r.s.handshake({ settleMs: 0 });
  await r.s.setOutputConfig({ format: 1, mask: 0, persist: 0 }); await sleep(30); const n = r.s.telemetry.frames; await sleep(200);
  check('mask=0：不再有遥测', r.s.telemetry.frames === n);
  const st = await r.s.query(CMD.QUERY_STATUS), cf = await r.s.query(CMD.QUERY_CONFIG), fl = await r.s.query(CMD.QUERY_FILTER); await r.s.command(CMD.PING);
  check('mask=0 时查询 14/1F/26/PING 仍可用', st.output_hz === 200 && cf.uart_mask === 0 && fl.profile_count === 4);
  check('数据过期判定（无新遥测 > 300 ms）', r.s.isStale(r.d.t));
  await r.s.setOutputConfig({ format: 1, mask: 0x1ff, persist: 0 }); await sleep(100); check('恢复 mask 后不再过期', !r.s.isStale(r.d.t));
  const res = await r.s.withTelemetryPaused(async () => { const n1 = r.s.telemetry.frames; await sleep(100); return r.s.telemetry.frames - n1; });
  check('批量命令期间暂停遥测（mask 0 / persist 0）并恢复原 format/mask', res <= 1 && r.s.config.uart_mask === 0x1ff && r.s.config.uart_format === 1 && r.d.flashWrites === 0);
  r.stop(); }
{ const r = rig({ sensorOk: false }); await r.s.handshake({ settleMs: 0 }); const e = await r.s.zeroYaw().catch((x) => x); await sleep(400);
  check('无传感器数据：0x11 status 3 不显示成功；遥测停止 → 过期', e.kind === 'AckFailed' && r.s.isStale(r.d.t) && r.s.last === null); r.stop(); }
{ const r = rig({ dropReplies: 1 }); const t0 = r.s.cmdStats; await r.s.command(CMD.PING); check('PING 丢一次应答 → 重试成功并计数', t0.retries === 1 && t0.timeouts === 1);
  r.d.dropReplies = 1; const e = await r.s.zeroYaw().catch((x) => x); check('ZERO_YAW 丢应答 → 超时，不重试', e.kind === 'Timeout' && r.s.cmdStats.retries === 1 && r.d.rxCommands.filter((c) => c === 0x11).length === 1); r.stop(); }

console.log('JustFloat 1/3/9 通道 + 双向命令（Mock 固件）');
for (const mask of [0x001, 0x007, 0x1ff]) {
  const n = P.popcount(mask); const r = rig({ format: 0, mask, chunk: 23 }, { async: true }); const h = await r.s.handshake({ settleMs: 0 });
  let ok = 0; const N = n === 9 ? 200 : 40;
  for (let i = 0; i < N; i++) { await (i % 3 === 0 ? r.s.command(CMD.PING) : i % 3 === 1 ? r.s.query(CMD.QUERY_STATUS) : r.s.query(CMD.QUERY_CONFIG)); ok++; await sleep(2); }
  await sleep(50);
  const ps = r.s.parser.stats;
  check(`JF ${n} 通道${n === 9 ? '（双向压力 200 命令）' : ''}：命令 ${ok}/${N} 成功、JF 帧 ${ps.jfFrames}、CRC/丢弃/重试 0`, h.config.uart_format === 0 && ok === N && ps.jfFrames > 20 && ps.crcErrors === 0 && ps.noiseBytes === 0 && r.s.cmdStats.retries === 0 && r.s.last.jf.length === n && r.s.last.jf.every(Number.isFinite));
  if (n === 9) check('JF 9 通道按 mask 映射字段（|a|≈g）', Math.abs(Math.hypot(...r.s.last.accel) - 9.80665) < 0.1);
  r.stop();
}
{ const r = rig(); await r.s.handshake({ settleMs: 0 }); const c = await r.s.sendVofa(); await sleep(100);
  check('显式 vofa：RAM JustFloat、保留 mask 0x1FF、不写 Flash、无 ACK', c.uart_format === 0 && c.uart_mask === 0x1ff && r.d.flashWrites === 0 && r.s.parser.stats.jfFrames > 5); r.stop(); }

console.log('旧预设 0x13（0..4）');
{ const r = rig(); await r.s.handshake({ settleMs: 0 }); const res = [];
  for (const p of [0, 1, 2, 3, 4]) { const c = await r.s.setLegacyPreset(p); await sleep(80); res.push([p, c.uart_format, c.uart_legacy, r.s.last]); }
  check('预设 0：JF 3 通道 Yaw/Pitch/Roll', res[0][1] === 2 && res[0][3].jf.length === 3 && res[0][3].yaw !== undefined);
  check('预设 1：0x01 float 欧拉角 + ts', res[1][3].roll !== undefined && res[1][3].ts !== undefined && res[1][3].jf === undefined);
  check('预设 2：0x04 int16 欧拉角 + Gz', res[2][3].gyro[2] !== undefined && res[2][3].ts !== undefined);
  check('预设 3：0x03 IMU + 温度', res[3][3].accel && Math.abs(Math.hypot(...res[3][3].accel) - 9.80665) < 0.1 && res[3][3].temp > 20);
  check('预设 4：JF 6 通道 Yaw/Pitch/Roll/Gz/Az/温度', res[4][3].jf.length === 6 && res[4][3].temp > 20);
  check('0x13 后主动查询 1F', r.d.rxCommands.filter((c) => c === 0x13).length === 5 && r.d.rxCommands.filter((c) => c === 0x1f).length >= 6);
  const st = await r.s.query(CMD.QUERY_STATUS); check('Legacy 时 0x05 stream_mode = preset', st.stream_mode === 4);
  r.stop(); }
{ const c = collect({ jfEnabled: false }); c.p.push(encodeMessage(MSG.EULER_F32, 1, { roll: 1, pitch: 2, yaw: 3, flags: 1, timestamp_ms: 7 })); c.p.push(encodeMessage(MSG.EULER_I16, 2, { roll_cd: 100, pitch_cd: 200, yaw_cd: 300, gz_ddps: 15, flags: 1, timestamp_ms: 8 }));
  const a = P.sampleFromLegacy(1, c.frames[0].data), b = P.sampleFromLegacy(4, c.frames[1].data);
  check('旧预设二进制欧拉角顺序 Roll/Pitch/Yaw；int16 0.01° / Gz 0.1 dps', a.roll === 1 && a.pitch === 2 && a.yaw === 3 && b.roll === 1 && b.yaw === 3 && b.gyro[2] === 1.5); }

console.log('复位重启时长不固定 / Flash 写入跳号');
for (const seed of [3, 11, 29]) { const r = rig({ seed }); await r.s.handshake({ settleMs: 0 }); const h = await r.s.reset();
  check(`seed ${seed}：Mock 重启 ${Math.round(r.d.lastRebootMs)} ms → PING ${r.s.cmdStats.rebootPings} 次后恢复并重新握手`, h.config.version === 3 && r.s.cmdStats.lastRebootMs >= r.d.lastRebootMs && r.s.cmdStats.lastRebootMs < r.d.lastRebootMs + 400); r.stop(); }
{ const sent = []; const s = new P.Ch32Session({ write: (b) => { sent.push(b); }, timeoutMs: 100 }); s.command(CMD.SYSTEM_RESET).catch(() => {}); await sleep(1); s.feed(encodeMessage(MSG.ACK, sent[0][4], { cmd_id: 0x15, status: 0, detail: 0 }));
  const e = await s.reset({ maxWaitMs: 400, pingTimeoutMs: 50 }).catch((x) => x); check('复位后一直无应答：有界等待后报错（不无限重试，不重发 0x15）', e.kind === 'Timeout' && sent.filter((f) => f[2] === 0x15).length === 2 && sent.filter((f) => f[2] === 0x10).length <= 10); }
{ const r = rig({ flashPauseMs: 50 }); await r.s.handshake({ settleMs: 0 }); await sleep(200); const m0 = r.s.telemetry.missing;
  await r.s.saveOutputHz(200); await sleep(400);
  const t = r.s.telemetry;
  check(`0x1D 写 Flash：遥测暂停、排队帧丢弃 → SEQ 跳号 ${t.missing - m0} 帧，标为“Flash 写入期间跳号（正常）”`, r.d.droppedDuringFlash >= 5 && t.missing - m0 === r.d.droppedDuringFlash && t.expectedMissing === t.missing - m0 && t.unexpectedMissing === 0 && t.flashGaps === 1 && /Flash 写入期间跳号.*正常/.test(t.lastGapNote));
  const f0 = await r.s.setFilter(2, 1); await sleep(300); check('0x27 persist=1 写 Flash 跳号同样标为正常', t.flashGaps === 2 && t.unexpectedMissing === 0);
  r.stop(); }
{ const t = new P.TelemetryStats(); t.beginFlashWindow(0); t.add(1, 0, 1); t.add(5, 0, 6); t.endFlashWindow(10, 100); t.add(6, 0, 300); t.add(9, 0, 305);
  check('Flash 窗口外的跳号仍按异常缺失计数', t.missing === 5 && t.expectedMissing === 3 && t.unexpectedMissing === 2); }
{ const bad = [3, 7, 300, 3000, 0].every((hz) => { try { P.encodeCommandPayload(CMD.SET_OUTPUT_HZ, { hz }); return false; } catch { return true; } });
  check('主机端 0x1D 校验：必须整除 2000 且在 20 值列表内（3 / 7 / 300 / 3000 / 0 拒绝）', bad && P.OUTPUT_HZ.every((h) => 2000 % h === 0)); }
{ const r = rig({ failFlash: true }); await r.s.handshake({ settleMs: 0 }); const e = await r.s.setOutputConfig({ format: 0, mask: 7, persist: 1 }).catch((x) => x);
  check('0x20 persist=1 Flash 失败：3 / 0x0607 + 现有 0x07 刷新状态（仍 Custom 0x1FF），不计迟到应答', e.kind === 'AckFailed' && e.ack.detail === 0x0607 && r.s.config.uart_format === 1 && r.s.config.uart_mask === 0x1ff && r.s.cmdStats.lateReplies === 0); r.stop(); }
{ const r = rig(); await r.s.handshake({ settleMs: 0 }); const e = await r.s.command(CMD.SET_FILTER, { profile: 2, persist: 0 }).catch((x) => x);
  check('0x27 未进入设置模式 → status 3 / detail 0（显示为失败）', e.kind === 'AckFailed' && e.ack.status === 3 && e.ack.detail === 0); r.stop(); }

console.log('六面校准 0x1C / 0x0A / 0x25');
{ const v = { version: 1, state: 1, phase: 2, face: 4, done_mask: 0x0b, one: 1, flash_valid: 1, reserved: 0, progress: 456, error: 0, samples: 1234, elapsed_ms: 98765, left_ms: 43210, bias_g: [0.01, -0.02, 0.03], scale: [1.001, 0.999, 1.002], raw_g: [0, 1, 0] };
  const c = collect({ jfEnabled: false }); c.p.push(encodeMessage(MSG.ACC_CAL, 9, v)); const d = c.frames[0].data;
  check('0x0A 60 B 布局解码（u8×8 / u16×2 / u32×3 / f32×9）', c.frames[0].payload.length === 60 && d.state === 1 && d.phase === 2 && d.face === 4 && d.done_mask === 0x0b && d.progress === 456 && d.samples === 1234 && d.elapsed_ms === 98765 && d.left_ms === 43210 && Math.abs(d.bias_g[1] + 0.02) < 1e-6 && Math.abs(d.scale[2] - 1.002) < 1e-6 && d.raw_g[1] === 1 && c.frames[0].type === 'message');
  const c2 = collect({ jfEnabled: false }); c2.p.push(encodeMessage(MSG.ACC_CAL, 9, { ...v, version: 2 })); check('0x0A version ≠ 1 标为异常帧', c2.frames[0].type === 'bad' && c2.p.stats.badFrames === 1);
  check('面编号 1..6 = -X +X -Y +Y -Z +Z；phase 5/6 为警告', P.CAL_FACES.join() === '-X,+X,-Y,+Y,-Z,+Z' && P.CAL_PHASE_WARN.has(5) && P.CAL_PHASE_WARN.has(6) && P.CAL_ERROR[0x0608] && P.CAL_ERROR[0x0603]); }
const CT = { place: 60, settle: 40, sample: 120, save: 60 };
{ const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); const order = []; const w = r.s.write; r.s.write = (b) => { order.push(b[2]); return w(b); };
  const run = await r.s.startSixFace(); const pushes = []; r.s.onCal = (c) => pushes.push(c);
  check('启动流程 17 → 1C（ACK 0x0100 + 0x0A）；最终 ACK 监听在发送前已注册', order.join() === '23,28' && run.seq === r.d.calRec.seq && r.s.calibrating && r.s.accCal.state === 1);
  const eR = await r.s.reset().catch((x) => x); const eC = await r.s.command(CMD.SYSTEM_RESET).catch((x) => x);
  check('校准中 0x15 被上位机拦截（reset() 与直接 command 两条路径都拦截，未发送）', eR.kind === 'CalibrationActive' && eC.kind === 'CalibrationActive' && !order.includes(0x15) && r.d.resets === 0 && r.s.cmdStats.calBlocked >= 2);
  const eH = await r.s.saveOutputHz(100).catch((x) => x); const eF = await r.s.setFilter(2, 0).catch((x) => x); const eO = await r.s.setOutputConfig({ format: 1, mask: 0x1ff, persist: 1 }).catch((x) => x); const e1C = await r.s.command(CMD.START_ACC_CAL).catch((x) => x);
  check('校准中拦截：0x1D 保存 / 滤波（其 0x18 会取消）/ 0x20 persist / 重复 0x1C', [eH, eF, eO, e1C].every((x) => x.kind === 'CalibrationActive') && order.filter((c) => c === 0x1c).length === 1 && order.filter((c) => c === 0x18).length === 0);
  const ram = await r.s.setOutputConfig({ format: 1, mask: 0x1ff, persist: 0 }).catch((x) => x); check('校准中 RAM 输出设置（不写 Flash）仍允许', ram.uart_mask === 0x1ff);
  const res = await run.final;
  check(`异步最终 ACK：成功、mask 0x3F、flash_valid 1、之后自动 18（推送 ${pushes.length} 帧）`, res.ok && res.status === 0 && res.cal.done_mask === 0x3f && res.cal.flash_valid === 1 && order.at(-1) === 0x18 && !r.d.settings && !r.s.calibrating && pushes.length >= 5);
  check('校准 0x0A 推送 / 最终 ACK 不计迟到应答或意外 ACK；保存阶段跳号标为正常', r.s.cmdStats.lateReplies === 0 && r.s.cmdStats.unexpectedAcks === 0 && r.s.telemetry.unexpectedMissing === 0);
  const h = await r.s.reset(); check('校准结束后复位解锁', h.config.version === 3 && r.d.resets === 1); r.stop(); }
for (const via of [0x25, 0x18]) { const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); await sleep(150);
  const res = await r.s.cancelSixFace({ via });
  check(`取消（0x${via.toString(16)}）→ 最终 3 / 0x0608 显示为“已取消”而非错误，退出设置模式`, res.cancelled && !res.ok && res.detail === 0x0608 && !r.d.settings && !r.s.settingsMode && !r.s.calibrating); r.stop(); }
for (const [sc, err, o] of [['timeout', 0x0603, { calFaceTimeoutMs: 400 }], ['saveFail', 0x0607], ['fitFail', 0x0606], ['ok', 0x0607, { failFlash: true }]]) {
  const r = rig({ calTiming: CT, calScenario: sc, ...o }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); const res = await run.final;
  check(`失败路径 ${o?.failFlash ? 'failFlash' : sc} → 0x${err.toString(16).padStart(4, '0')}「${res.errorText}」，非取消，已发 18`, !res.ok && !res.cancelled && res.detail === err && !r.d.settings && res.errorText === P.CAL_ERROR[err]); r.stop(); }
for (const [sc, ph] of [['shake', 5], ['duplicate', 6]]) { const r = rig({ calTiming: CT, calScenario: sc }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); const seen = new Set(); r.s.onCal = (c) => seen.add(c.phase); const res = await run.final;
  check(`${sc}：会话收到 phase ${ph} 警告后完成`, seen.has(ph) && res.ok); r.stop(); }
{ const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); r.d.dropReplyFor.add(0x1c); const order = []; const w = r.s.write; r.s.write = (b) => { order.push(b[2]); return w(b); };
  const run = await r.s.startSixFace();
  check('0x1C 超时：不重发 0x1C，改发 0x24 查询，state 1 → 按设备状态继续', run.recovered && order.filter((c) => c === 0x1c).length === 1 && order.indexOf(0x24) > order.indexOf(0x1c) && r.d.calStarts === 1 && r.s.calibrating);
  const res = await run.final; check('恢复后照常收到最终 ACK 并退出设置模式', res.ok && !r.d.settings && order.filter((c) => c === 0x1c).length === 1); r.stop(); }
{ const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); const orig = r.d._command.bind(r.d);
  r.d._command = (cmd, seq, p) => { if (cmd === 0x1c) { r.d.settings = false; r.d.dropReplyFor.add(0x1c); } return orig(cmd, seq, p); };
  const order = []; const w = r.s.write; r.s.write = (b) => { order.push(b[2]); return w(b); };
  const e = await r.s.startSixFace().catch((x) => x);
  check('0x1C 超时且 0x24 显示空闲 → 报 Timeout，不重发 0x1C，发 18 退出', e.kind === 'Timeout' && order.join() === '23,28,36,24' && !r.s.calibrating); r.stop(); }
{ const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); const e = await r.s.command(CMD.START_ACC_CAL).catch((x) => x);
  check('设置模式外直接发 0x1C → 2 / 0x0602', e.kind === 'AckInvalid' && e.ack.status === 2 && e.ack.detail === 0x0602); r.stop(); }
{ const r = rig({ calTiming: { ...CT, place: 400 } }); await r.s.handshake({ settleMs: 0 }); await r.s.command(CMD.ENTER_SETTINGS); await r.s.command(CMD.START_ACC_CAL);
  const s2 = new P.Ch32Session({ write: (b) => r.d.write(b), now: () => r.d.t, timeoutMs: 300 }); r.d.onTx = (b) => s2.feed(b); await s2.handshake({ settleMs: 0 });
  const e = await s2.reset().catch((x) => x);
  check('重新连接时 0x24 显示校准进行中 → 同样锁定复位', s2.accCal.state === 1 && s2.calibrating && e.kind === 'CalibrationActive' && r.d.resets === 0); r.stop(); }
console.log('校准期间跳号：最终 0x1C ACK 到达时追溯裁决（0x3F 前最后一帧 → ACK 后第一帧）');
const calRig = async (o = {}, tm = {}) => { const r = rig({ calTiming: { ...CT, ...tm }, ...o }); await r.s.handshake({ settleMs: 0 }); return r; };
const settle = () => sleep(120);
{ const r = await calRig(); const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check(`成功 st0：phase 3 清队列 ${r.d.calQueueFlushed} 帧 + 暂停，共跳号 ${t.expectedMissing} 帧 → Flash 写入期间跳号（正常）`, res.ok && r.d.calSaveDropped > 0 && r.d.calQueueFlushed > 0 && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0 && t.flashGaps === 1 && run.gapDecision === 'normal' && /Flash 写入期间跳号.*正常/.test(t.lastGapNote) && !t.calHold && !t.calDecide); r.stop(); }
{ const r = await calRig({ calScenario: 'saveFail' }); const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check(`失败 st3 / 0x0607（经过 phase 3：清队列 + 写 Flash）→ 跳号 ${t.expectedMissing} 帧为正常`, !res.ok && res.detail === 0x0607 && res.cal.done_mask === 0x3f && r.d.calSaveDropped > 0 && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0 && run.gapDecision === 'normal'); r.stop(); }
{ const r = await calRig({ calScenario: 'saveFail' }, { save: 60 }); let saw3f = false; r.s.onCal = (c) => { if ((c.done_mask & 0x3f) === 0x3f) saw3f = true; };
  r.d._origTick = r.d._calTick; r.d._calTick = function (ms) { const ph = this.calRec?.phase; this._origTick(ms); if (ph !== 3 && this.calRec?.phase === 3) this.calRec.pushT = -1e9; }; // phase 3 期间不推 0x0A
  r.d.calFinalOverride = { omit0A: true }; // ACK 后也没有 0x0A
  const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check(`0x0607 且从未见到 mask 0x3F（ACK 后亦无 0x0A）→ 与 st0 同等：跳号 ${t.expectedMissing} 帧为正常`, !res.ok && res.detail === 0x0607 && !saw3f && r.d.calSaveDropped > 0 && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0 && run.gapDecision === 'normal' && !run.maskChecked); r.stop(); }
{ const r = await calRig(); const ev = []; r.s.onEvent = (l, m) => ev.push([l, m]); r.d.calFinalOverride = { mask: 0x1f };
  const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check('st0 + ACK 后 0x0A mask 0x1F（≠0x3F）→ 跳号仍为正常，并记录交叉校验警告', res.ok && run.gapDecision === 'normal' && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0 && run.maskMismatch === 0x1f && ev.some(([l, m]) => l === 'warn' && /0x1f ≠ 0x3F/.test(m))); r.stop(); }
{ const r = await calRig(); const ev = []; r.s.onEvent = (l, m) => ev.push([l, m]); const run = await r.s.startSixFace(); await run.final; await settle();
  check('st0 + ACK 后 0x0A mask 0x3F：交叉校验通过，无警告', run.maskChecked && run.maskMismatch == null && !ev.some(([l, m]) => /交叉校验/.test(m))); r.stop(); }
{ const r = await calRig({ calScenario: 'fitFail' }); const orig = r.d._calEnd.bind(r.d); r.d._calEnd = (st, err, dl) => { if (err === 0x0606) r.d.injectLoss(40); return orig(st, err, dl); }; // 跳号跨过最终 ACK
  const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check(`0x0606（mask 0x3F，不写 Flash 不暂停）：跨最终 ACK 的跳号 ${r.d.injectedLoss} 帧 → 计为丢失（原“正常”判定已反转）`, !res.ok && res.detail === 0x0606 && res.cal.done_mask === 0x3f && !r.d.calSaveDropped && r.d.injectedLoss >= 5 && t.unexpectedMissing === r.d.injectedLoss && t.expectedMissing === 0 && t.flashGaps === 0 && run.gapDecision === 'loss'); r.stop(); }
{ const r = await calRig({}, { save: 400, txQueue: 15 }); let seen3fAt = null; r.s.onCal = (c) => { if (seen3fAt == null && (c.done_mask & 0x3f) === 0x3f) seen3fAt = r.s.telemetry.lastAt; };
  const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry; const g = t.gapLog.filter((x) => x.n > 0).at(-1);
  check(`跳号起点早于看到 0x3F（清队列 ${r.d.calQueueFlushed} 帧，SEQ 已分配；gap 起点 ≤ 0x3F 可见时最后一帧）→ 成功时为正常`, res.ok && seen3fAt != null && r.d.calQueueFlushed >= 2 && g && g.prevAt <= seen3fAt && g.prevAt < run.mask3fTelAt + 1 && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0); r.stop(); }
{ const r = await calRig({}, { save: 60 }); let shown3 = false; r.s.onCal = (c) => { if (c.phase === 3) shown3 = true; };
  r.d._origTick = r.d._calTick; r.d._calTick = function (ms) { const ph = this.calRec?.phase; this._origTick(ms); if (ph !== 3 && this.calRec?.phase === 3) this.calRec.pushT = -1e9; }; // 保证 SAVING 期间不推 0x0A
  const run = await r.s.startSixFace(); const res = await run.final; await settle(); const t = r.s.telemetry;
  check('从未见到 phase 3 的 0x0A：最终 ACK 自行触发裁决，成功 → 正常', res.ok && !shown3 && r.d.calSaveDropped > 0 && t.expectedMissing === r.d.calSaveDropped && t.unexpectedMissing === 0); r.stop(); }
{ const r = await calRig({}, { sample: 300 }); const run = await r.s.startSixFace();
  await new Promise((ok) => { const id = setInterval(() => { if (r.s.accCal?.phase === 2) { clearInterval(id); ok(); } }, 5); });
  r.d.injectLoss(40); const res = await run.final; await settle(); const t = r.s.telemetry;
  check(`面采样中途跳号 ${r.d.injectedLoss} 帧 → 真实丢失；SAVING 跳号仍为正常`, res.ok && r.d.injectedLoss >= 5 && t.unexpectedMissing === r.d.injectedLoss && t.expectedMissing === r.d.calSaveDropped && t.flashGaps === 1);
  r.d.injectLoss(30); await sleep(150); check('最终 ACK 后第一帧之后的跳号 → 真实丢失', t.unexpectedMissing === r.d.injectedLoss && t.expectedMissing === r.d.calSaveDropped); r.stop(); }
{ const r = await calRig({}, { place: 400 }); const run = await r.s.startSixFace(); await sleep(100);
  const orig = r.d._calEnd.bind(r.d); r.d._calEnd = (st, err, dl) => { r.d.injectLoss(60); return orig(st, err, dl); }; // 跳号跨过最终 ACK 0x0608
  const res = await r.s.cancelSixFace(); await sleep(200); const t = r.s.telemetry;
  check(`取消（0x0608）：跨最终 ACK 的跳号 ${r.d.injectedLoss} 帧 → 真实丢失，无 Flash 豁免`, res.cancelled && r.d.injectedLoss >= 5 && t.unexpectedMissing === r.d.injectedLoss && t.expectedMissing === 0 && t.flashGaps === 0 && run.gapDecision === 'loss'); r.stop(); }
{ const t = new P.TelemetryStats(); t.add(1, 0, 0); t.add(2, 0, 5); t.calHoldFrom(5); t.add(9, 0, 50);
  const held = t.tentativeMissing, u0 = t.unexpectedMissing; t.calCommit(true, 60, 5); t.add(10, 0, 65); t.add(14, 0, 70);
  check('暂挂记账：ACK 前不计入（tentative 6，unexpected 0），裁决后提交；裁决只覆盖 ACK 后第一帧', held === 6 && u0 === 0 && t.expectedMissing === 6 && t.unexpectedMissing === 3 && !t.calHold && !t.calDecide);
  const t2 = new P.TelemetryStats(); t2.add(1, 0, 0); t2.calHoldFrom(0); t2.add(5, 0, 20); t2.calRelease(); check('无最终 ACK（断开 / 复位）：暂挂跳号按丢失提交', t2.unexpectedMissing === 3 && !t2.calHold);
  const t3 = new P.TelemetryStats(); t3.add(1, 0, 0); t3.add(2, 0, 5); t3.add(6, 0, 30); t3.calCommit(true, 40, 5); check('追溯：起点之后、ACK 前已计入的跳号在成功裁决时改判为正常', t3.expectedMissing === 3 && t3.unexpectedMissing === 0);
  const t4 = new P.TelemetryStats(); t4.add(1, 0, 0); t4.calHoldFrom(0); t4.calCommit(true, 10, 0); t4.add(2, 0, 3000); check('2 s 兜底：ACK 后 2 s 内无帧则裁决失效', !t4.calDecide && t4.expectedMissing === 0); }
check('0x0609 只保留为未知 / 保存失败文本（固件实际只报 0x0607）', /0x0607/.test(P.CAL_ERROR[0x0609]) && /保存失败/.test(P.CAL_ERROR[0x0609]));
{ const r = rig({ calTiming: CT }); await r.s.handshake({ settleMs: 0 }); const t0 = Date.now(); const res = await r.s.cancelSixFace();
  check(`未在校准时取消：0x25 只有 ACK + 0x0A，不等最终 ACK（${Date.now() - t0} ms 返回）`, res.noRun && !res.cancelled && Date.now() - t0 < 300 && r.s.cmdStats.unexpectedAcks === 0); r.stop(); }
{ const r = rig({ calTiming: { ...CT, place: 5000 } }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); await sleep(100);
  r.d.calRec = null; const t0 = Date.now(); const res = await r.s.cancelSixFace({ finalWaitMs: 500 }); // 主机仍以为在校准，设备已不在：0x25 无最终 ACK
  check(`取消时设备已不在校准（无最终 ACK）→ 有界等待后经 0x24 收尾（${Date.now() - t0} ms），不挂起`, res.cancelled && res.recoveredFromQuery && !r.s.calibrating && Date.now() - t0 < 1500 && !r.d.settings); r.stop(); }
{ const r = rig({ calTiming: { ...CT, place: 5000 } }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); await sleep(100);
  r.d.write(P.encodeCommand(CMD.SYSTEM_RESET, 200)); // 绕过上位机（如板上按键 / 其他工具）复位：无最终 ACK
  const bootDeadline = Date.now() + 5000; while (r.d.t < r.d.silentUntil && Date.now() < bootDeadline) await sleep(20); if (r.d.t < r.d.silentUntil) throw new Error('Mock clock did not reach reboot completion'); await r.s.handshake({ settleMs: 0 }); const res = await Promise.race([run.final, sleep(100).then(() => 'hang')]);
  check('校准中设备被外部复位：无最终 ACK；重新握手 / 0x24 清除等待（不挂起），解锁复位', res !== 'hang' && res.lost && !res.ok && !r.s.calibrating && r.d.resets === 1); r.stop(); }
{ const r = rig({ calTiming: { ...CT, place: 5000 } }); await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); r.s.cancelAll('串口已断开');
  const res = await Promise.race([run.final, sleep(50).then(() => 'hang')]); check('校准中断开：最终 ACK 等待立即结束（lost）', res !== 'hang' && res.lost); r.stop(); }
for (const v of ['20261003c', '20261003d']) { const r = rig({ calTiming: CT, fwText: v }); const h = await r.s.handshake({ settleMs: 0 }); const run = await r.s.startSixFace(); const res = await run.final;
  check(`固件 ${v}：不按版本字符串做门控，六面校准照常（bit7 决定）`, h.firmware.text === v && r.s.sixFaceSupported && res.ok); r.stop(); }
{ const sent = []; const s = new P.Ch32Session({ write: (b) => { sent.push(b); }, timeoutMs: 100 }); s.config = { capabilities: 0x44 };
  const e = await s.startSixFace().catch((x) => x); check('bit7 未置位 → 不支持，不发送', e.kind === 'Unsupported' && sent.length === 0); }

console.log('原始帧记录');
{ const log = []; const r = rig({ rawLog: (dir, kind, bytes) => log.push([dir, kind, bytes.length]) }); await r.s.handshake({ settleMs: 0 }); await sleep(50); await r.s.setOutputConfig({ format: 0, mask: 7 }); await sleep(50);
  check('原始帧记录：TX AA55 + RX AA55 + RX JF', log.some((l) => l[0] === 'tx' && l[1] === 'aa55') && log.some((l) => l[0] === 'rx' && l[1] === 'aa55' && l[2] === 47) && log.some((l) => l[0] === 'rx' && l[1] === 'jf' && l[2] === 16)); r.stop(); }

summary('protocol.test');
