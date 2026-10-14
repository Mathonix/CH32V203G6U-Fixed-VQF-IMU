// mock-device.mjs — Mock 固件行为对照交接文档 §4–§9（状态码 / detail / ACK+配置 / 复位 / vofa）。Mock，不是实板。
import { load, check, summary } from './_src.mjs';
const P = await load('protocol.js');
const M = await load('mock-device.js');
const { MSG, CMD, encodeFrame, encodeCommand, StreamParser } = P;
function dev(opts = {}) {
  const frames = [], jf = [], writes = [];
  const p = new StreamParser({ onFrame: (f) => frames.push(f), onJustFloat: (v) => jf.push(v) });
  const d = new M.MockCh32Device({ ...opts, onTx: (b) => { writes.push(b); p.push(b); } });
  let seq = 0;
  const send = (cmd, payload = new Uint8Array(0)) => { const n0 = frames.length; d.write(encodeFrame(cmd, ++seq & 0xff, payload)); return frames.slice(n0).filter((f) => f.msg !== MSG.CUSTOM); };
  const ack = (cmd, payload) => { const r = send(cmd, payload); return r.find((f) => f.msg === MSG.ACK)?.data; };
  return { d, p, frames, jf, writes, send, ack, get seq() { return seq; } };
}
const u8 = (...a) => Uint8Array.from(a);
const t = dev();
check('Mock 固件文本 20261003m；MOCK_ASSUMPTIONS 标为已对照 app_command.c 20261003b；未确认项单列', M.MOCK_FW_TEXT === '20261003m' && M.MOCK_SOURCE.includes('20261003h') && M.MOCK_ASSUMPTIONS.every((x) => x.startsWith('已确认')) && M.MOCK_UNCONFIRMED.length >= 3);
check('PING → ACK OK（回显 SEQ）', (() => { const r = t.send(CMD.PING); return r.length === 1 && r[0].data.status === 0 && r[0].data.cmd_id === 0x10 && r[0].seq === t.seq; })());
check('查询 14/1F/23/24/26 直接应答 05/07/32/0A/0B，无 ACK', [[0x14, 5], [0x1f, 7], [0x23, 0x32], [0x24, 0x0a], [0x26, 0x0b]].every(([c, m]) => { const r = t.send(c); return r.length === 1 && r[0].msg === m && r[0].type === 'message' && r[0].seq === t.seq; }));
check('0x0A：LEN 60 version=1 one=1，空闲 state 0、flash_valid 0、scale 1', (() => { const r = t.send(0x24); const c = r[0].data; return r[0].payload.length === 60 && c.version === 1 && c.one === 1 && c.state === 0 && c.flash_valid === 0 && c.scale.every((x) => x === 1) && r[0].type === 'message'; })());
check('0x25 → ACK + 0A', (() => { const r = t.send(0x25); return r.length === 2 && r[0].msg === MSG.ACK && r[1].msg === 0x0a; })());
check('空 payload 命令带参数 → status 2', t.ack(CMD.PING, u8(1)).status === 2);
check('0x1D 300 Hz / 3 Hz / 0 Hz（不整除 2000）→ status 2', t.ack(0x1d, u8(0x2c, 0x01)).status === 2 && t.ack(0x1d, u8(3, 0)).status === 2 && t.ack(0x1d, u8(0, 0)).status === 2 && t.d.saved.hz === 200);
check('0x1D 100 Hz → ACK + 07（active/saved 100，写 Flash 1 次）', (() => { const r = t.send(0x1d, u8(100, 0)); return r.length === 2 && r[0].data.status === 0 && r[1].data.output_hz === 100 && r[1].data.saved_output_hz === 100 && t.d.flashWrites === 1; })());
check('ACK + 0x07 在同一次写出', t.writes.at(-1).length === 11 + 35);
check('0x20 port=1（USB）/ port=2 → status 3', t.ack(0x20, u8(1, 1, 0xff, 1, 0)).status === 3 && t.ack(0x20, u8(2, 1, 0xff, 1, 0)).status === 3);
check('0x20 format=2 → status 2（Legacy 需 0x13）', t.ack(0x20, u8(0, 2, 0xff, 1, 0)).status === 2);
check('0x20 mask bit9 → status 2；persist=2 → status 2', t.ack(0x20, u8(0, 1, 0, 2, 0)).status === 2 && t.ack(0x20, u8(0, 1, 0xff, 1, 2)).status === 2);
check('0x20 RAM（persist 0）不写 Flash', (() => { const n = t.d.flashWrites; const r = t.send(0x20, u8(0, 0, 7, 0, 0)); return r[0].data.status === 0 && r[1].data.uart_format === 0 && r[1].data.uart_mask === 7 && t.d.flashWrites === n && t.d.saved.format === 1; })());
check('0x13 preset 5 → status 2；preset 3 → ACK（format 2 / legacy 3）', t.ack(0x13, u8(5)).status === 2 && t.ack(0x13, u8(3)).status === 0 && t.d.active.format === 2 && t.d.active.legacy === 3);
check('0x27 设置模式外 → status 3 / detail 0（已确认）', (() => { const a = t.ack(0x27, u8(2, 0)); return a.status === 3 && a.detail === 0; })());
check('参数先于设置模式校验：模式外 0x27 profile 4 → status 2', (() => { const a = t.ack(0x27, u8(4, 0)); return a.status === 2 && a.detail === 0; })());
check('0x19 设置模式外 → status 3 / 0；模式外非法参数 → status 2', (() => { const a = t.ack(0x19, u8(0, 0)), b = t.ack(0x19, u8(0, 5)); return a.status === 3 && a.detail === 0 && b.status === 2; })());
check('17 → 27(profile 2) → 18：ACK + 0B，active 2 saved 1', (() => { t.ack(0x17); const r = t.send(0x27, u8(2, 0)); t.ack(0x18); return r[0].data.status === 0 && r[1].data.active_profile === 2 && r[1].data.saved_profile === 1 && !t.d.settings; })());
check('0x27 profile 3（ZARU）→ status 0', (() => { t.ack(0x17); const a = t.ack(0x27, u8(3, 0)); t.ack(0x18); return a.status === 0; })());
check('0x19 设置模式内 mode 0 → OK；mode 1 → status 2', (() => { t.ack(0x17); const a = t.ack(0x19, u8(0, 1)), b = t.ack(0x19, u8(1, 0)); t.ack(0x18); return a.status === 0 && b.status === 2; })());
check('12 / 1B 陀螺校准 → status 3 / 0x0601', [0x12, 0x1b].every((c) => { const a = t.ack(c); return a.status === 3 && a.detail === 0x0601; }));
check('16 Bootloader → status 3', t.ack(0x16).status === 3);
check('1E 启动配置（3 字节）→ status 3', t.ack(0x1e, u8(0, 0, 0)).status === 3);
check('固件文本可配置（20261003c / d，协议不变）', ['20261003c', '20261003d'].every((v) => { const f = dev({ fwText: v }); const r = f.send(0x23)[0].data; return r.text === v && f.send(0x1f)[0].data.capabilities === 0xc4; }));
check('caps 0xC4（bit7 六面校准）', t.send(0x1f)[0].data.capabilities === 0xc4);
check('1C 六面：设置模式外 2/0602；带 payload → 2/0602', (() => { const a = t.ack(0x1c); const b = t.ack(0x1c, u8(1)); return a.status === 2 && a.detail === 0x0602 && b.status === 2; })());
{ const T = { place: 100, settle: 50, sample: 200, save: 100 };
  const cal = (o = {}) => { const f = dev({ calTiming: T, ...o }); f.ack(0x17); const r = f.send(0x1c); return { f, r, seq: f.seq }; };
  const runTo = (f, pred, max = 20000) => { for (let i = 0; i < max / 5; i++) { f.d.advance(5); if (pred()) return true; } return false; };
  const finals = (f, seq) => f.frames.filter((x) => x.msg === MSG.ACK && x.data.cmd_id === 0x1c && x.seq === seq && x.data.detail !== 0x0100); // 排除启动 ACK（0x0100）
  { const { f, r, seq } = cal(); const n0 = f.frames.length;
    check('1C 设置模式内 → ACK 0 / 0x0100 + 一帧 0x0A（state 1，同 SEQ）', r.length === 2 && r[0].data.status === 0 && r[0].data.detail === 0x0100 && r[1].msg === 0x0a && r[1].data.state === 1 && r[1].seq === seq);
    f.d.advance(1000); const pushes = f.frames.slice(n0).filter((x) => x.msg === 0x0a);
    check(`0x0A 每 200 ms 推送（1 s → ${pushes.length} 帧），SEQ = 启动 SEQ`, pushes.length === 5 && pushes.every((x) => x.seq === seq));
    check('校准中再次 1C → 3 / 0x0604', (() => { const a = f.ack(0x1c); return a.status === 3 && a.detail === 0x0604; })());
    check('校准中 0x1D → 3 / 0x0604（不写 Flash）', (() => { const n = f.d.flashWrites; const a = f.ack(0x1d, u8(100, 0)); return a.status === 3 && a.detail === 0x0604 && f.d.flashWrites === n; })());
    check('校准中 0x20 persist=1 → 3 / 0x0604；persist=0 → 正常', f.ack(0x20, u8(0, 1, 0xff, 1, 1)).detail === 0x0604 && f.ack(0x20, u8(0, 1, 0xff, 1, 0)).status === 0);
    check('校准中 0x27 persist=1 → 3 / 0x0604；persist=0 → 正常', f.ack(0x27, u8(1, 1)).detail === 0x0604 && f.ack(0x27, u8(1, 0)).status === 0);
    check('0x24 校准中 → 只回一帧 0x0A（查询 SEQ，无 ACK）', (() => { const q = f.send(0x24); return q.length === 1 && q[0].msg === 0x0a && q[0].seq === f.seq && q[0].data.state === 1; })());
    const phases = new Set(); const ok = runTo(f, () => { const l = f.frames.filter((x) => x.msg === 0x0a).at(-1); phases.add(l.data.phase); return finals(f, seq).length > 0; });
    const fin = finals(f, seq)[0], idx = f.frames.indexOf(fin), after = f.frames.slice(idx + 1).find((x) => x.msg === 0x0a);
    check('完成：最终 ACK（cmd 0x1C、启动 SEQ）st0 + 一帧 0x0A state 2 / phase 4 / mask 0x3F', ok && fin.data.status === 0 && after.seq === seq && after.data.state === 2 && after.data.phase === 4 && after.data.done_mask === 0x3f);
    check('完成：flash_valid 1，bias / scale 已保存，写 Flash 1 次', after.data.flash_valid === 1 && Math.abs(after.data.scale[0] - 1.003) < 1e-6 && f.d.flashWrites === 1);
    check('raw_g 跟随当前面（|raw| ≈ 1 g）', Math.abs(Math.hypot(...after.data.raw_g) - 1) < 0.05);
    const n1 = f.frames.length; f.d.advance(600); check('结束后不再推送 0x0A', !f.frames.slice(n1).some((x) => x.msg === 0x0a)); f.ack(0x18); }
  { const { f, seq } = cal(); const n0 = f.frames.filter((x) => x.msg === MSG.CUSTOM).length; let gapBeforeSave = 0, prev = null, sawSave = false;
    runTo(f, () => { const cs = f.frames.filter((x) => x.msg === MSG.CUSTOM); if (f.d.calRec?.phase === 3) sawSave = true; for (const x of cs.slice(prev ?? n0)) { const i = cs.indexOf(x); if (i > 0 && !sawSave && ((x.seq - cs[i - 1].seq) & 0xff) !== 1) gapBeforeSave++; } prev = cs.length; return finals(f, seq).length > 0; });
    const cs = f.frames.filter((x) => x.msg === MSG.CUSTOM); const gaps = cs.slice(n0).reduce((g, x, i, a) => i ? g + (((x.seq - a[i - 1].seq) & 0xff) - 1) : 0, 0);
    check(`遥测只在 SAVING 暂停（app_device.c L70）：各面期间无跳号，SAVING 丢 ${f.d.calSaveDropped} 帧 = 全部跳号`, gapBeforeSave === 0 && f.d.calSaveDropped > 0 && gaps === f.d.calSaveDropped && f.d.droppedDuringFlash === f.d.calSaveDropped); }
  { const { f, seq } = cal({ calScenario: 'timeout', calFaceTimeoutMs: 400 }); runTo(f, () => finals(f, seq).length > 0); check('未到第 6 面就结束（超时）：无 SAVING 暂停', !f.d.calSaveDropped && !f.d.droppedDuringFlash); }
  { const { f, seq } = cal({ calScenario: 'fitFail' }); runTo(f, () => finals(f, seq).length > 0); const last = f.frames.filter((x) => x.msg === 0x0a).at(-1).data;
    check('0x0606：6 面完成即判拟合失败，不进 phase 3、不清队列、不暂停、不写 Flash', finals(f, seq)[0].data.detail === 0x0606 && last.done_mask === 0x3f && !f.d.calSaveDropped && !f.d.calQueueFlushed && f.d.flashWrites === 0); }
  { const { f, seq } = cal(); f.d.calFinalOverride = { mask: 0x1f }; runTo(f, () => finals(f, seq).length > 0); const fin = finals(f, seq)[0], i = f.frames.indexOf(fin), nx = f.frames[i + 1];
    const g = cal(); g.f.d.calFinalOverride = { omit0A: true }; runTo(g.f, () => finals(g.f, g.seq).length > 0); const fin2 = finals(g.f, g.seq)[0], nx2 = g.f.frames.slice(g.f.frames.indexOf(fin2) + 1).find((x) => x.msg !== MSG.CUSTOM);
    check('calFinalOverride（测试注入）：改写 ACK 后 0x0A 的 mask / 省略该帧', fin.data.status === 0 && nx.msg === 0x0a && nx.data.done_mask === 0x1f && fin2.data.status === 0 && !nx2); }
  { const { f, seq } = cal({ calScenario: 'saveFail' }); runTo(f, () => finals(f, seq).length > 0);
    check(`0x0607：经过 phase 3（清队列 ${f.d.calQueueFlushed} 帧 + 暂停 共丢 ${f.d.calSaveDropped} 帧）`, finals(f, seq)[0].data.detail === 0x0607 && f.d.calQueueFlushed > 0 && f.d.calSaveDropped > f.d.calQueueFlushed); }
  { const { f, seq } = cal(); const n0 = f.frames.filter((x) => x.msg === MSG.CUSTOM).length; let last3f = null, lastTel = null;
    runTo(f, () => { const fr = f.frames; for (let i = fr.length - 1; i >= 0 && last3f == null; i--) { if (fr[i].msg === 0x0a && (fr[i].data.done_mask & 0x3f) === 0x3f) { last3f = i; lastTel = fr.slice(0, i).filter((x) => x.msg === MSG.CUSTOM).at(-1)?.seq; } } return finals(f, seq).length > 0; });
    const cs = f.frames.filter((x) => x.msg === MSG.CUSTOM); const after = f.frames.slice(last3f).filter((x) => x.msg === MSG.CUSTOM)[0];
    check(`进入 phase 3 清掉已排队帧：0x3F 可见前最后一帧 SEQ ${lastTel} 之后有 ${f.d.calQueueFlushed} 个已分配 SEQ 未发出（跳号先于 0x3F 开始）`, f.d.calQueueFlushed > 0 && ((after.seq - lastTel) & 0xff) - 1 === f.d.calSaveDropped); }
  { const f = dev(); f.d.advance(100); f.d.injectLoss(50); for (let i = 0; i < 40; i++) f.d.advance(5); check('injectLoss：模拟链路丢帧（SEQ 照常递增，不计为 Flash 暂停）', f.d.injectedLoss >= 9 && !f.d.droppedDuringFlash); }
  { const { f, seq } = cal(); f.d.advance(300); const r = f.send(0x25);
    check('0x25 取消 → 立即 ACK + 0x0A（state 4）', r.length === 2 && r[0].data.status === 0 && r[1].data.state === 4);
    check('取消后稍后到达最终 ACK 3 / 0x0608（启动 SEQ）', finals(f, seq).length === 0 && runTo(f, () => finals(f, seq).length > 0, 1000) && finals(f, seq)[0].data.detail === 0x0608 && finals(f, seq)[0].data.status === 3); }
  { const { f, seq } = cal(); f.d.advance(300); const a = f.ack(0x18);
    check('0x18 退出设置模式同样取消 → 最终 3 / 0x0608', a.status === 0 && !f.d.settings && runTo(f, () => finals(f, seq).length > 0, 1000) && finals(f, seq)[0].data.detail === 0x0608); }
  for (const [sc, err, phase, o] of [['timeout', 0x0603, 7, { calFaceTimeoutMs: 500 }], ['fitFail', 0x0606, 7], ['saveFail', 0x0607, 7], ['ok', 0x0607, 7, { failFlash: true }]]) {
    const { f, seq } = cal({ calScenario: sc, ...o }); runTo(f, () => finals(f, seq).length > 0); const fin = finals(f, seq)[0]; const last = f.frames.filter((x) => x.msg === 0x0a).at(-1).data;
    check(`场景 ${o?.failFlash ? 'failFlash' : sc} → 最终 3 / 0x${err.toString(16).padStart(4, '0')}，state 3 phase ${phase}，flash_valid 0`, fin?.data.status === 3 && fin.data.detail === err && last.state === 3 && last.phase === phase && last.error === err && last.flash_valid === 0); }
  for (const [sc, ph] of [['shake', 5], ['duplicate', 6]]) { const { f, seq } = cal({ calScenario: sc }); const seen = new Set(); runTo(f, () => { seen.add(f.frames.filter((x) => x.msg === 0x0a).at(-1).data.phase); return finals(f, seq).length > 0; });
    check(`场景 ${sc}：出现 phase ${ph}（${ph === 5 ? '晃动' : '重复面'}）后恢复并完成`, seen.has(ph) && finals(f, seq)[0].data.status === 0); }
  { const { f } = cal(); f.d.advance(300); const r = f.send(0x15);
    check('固件不阻止 0x15：校准中复位 → ACK 并重启，校准丢失（上位机须自行锁定）', r[0].data.status === 0 && f.d.resets === 1 && f.d.calLostByReset === 1 && f.d.calRec === null);
    runTo(f, () => false, 2500); check('校准中复位后不发最终 ACK', finals(f, 2).length === 0); }
  { const f = dev({ calTiming: T }); const r = f.send(0x25); f.d.advance(1500);
    check('未在校准时 0x25 → 只有 ACK + 0x0A（state 0），之后无最终 ACK', r.length === 2 && r[0].data.status === 0 && r[1].data.state === 0 && !f.frames.some((x) => x.msg === MSG.ACK && x.data.cmd_id === 0x1c)); }
  { const f = dev({ calTiming: T }); f.ack(0x17); f.send(0x1c); f.d.advance(300); f.send(0x25); const n = f.frames.length; f.ack(0x17); f.send(0x25);
    f.d.advance(1000); check('取消后再次 0x25（已不在校准）不产生第二个最终 ACK', f.frames.slice(n).filter((x) => x.msg === MSG.ACK && x.data.cmd_id === 0x1c && x.data.detail === 0x0608).length === 1); }
  { const f = dev({ calTiming: T }); f.ack(0x17); f.d.dropReplyFor.add(0x1c); const r = f.send(0x1c);
    check('dropReplyFor 0x1C：启动应答丢失但校准已开始（0x24 可查到 state 1）', r.length === 0 && f.d.calStarts === 1 && f.send(0x24)[0].data.state === 1); }
}
check('21 / 22 CAN、28..33 高级 → status 1 未知命令', [0x21, 0x22, 0x28, 0x2c, 0x33].every((c) => t.ack(c).status === 1));
check('0x11 归零 → ACK；无传感器 → status 3', t.ack(0x11).status === 0 && dev({ sensorOk: false }).ack(0x11).status === 3);
{ const f = dev({ failFlash: true }); const r = f.send(0x1d, u8(100, 0)); check('Flash 故障注入：1D → status 3 / 0x0607 + 现有 0x07（未应用）', r[0].data.status === 3 && r[0].data.detail === 0x0607 && r[1].msg === 7 && r[1].data.output_hz === 200 && f.d.active.hz === 200); }
{ const f = dev({ failFlash: true }); f.ack(0x17); const r = f.send(0x27, u8(0, 1)); check('Flash 故障：27 persist → 3 / 0607 + 现有 0B', r[0].data.detail === 0x0607 && r[1].data.active_profile === 1); }
{ const f = dev(); f.d.advance(1000); const n = f.frames.filter((x) => x.msg === MSG.CUSTOM); const d = n.at(-1).data;
  check('默认遥测：Custom 九字段 200 Hz（1 s ≈200 帧）', n.length >= 199 && n.length <= 201 && d.mask === 0x1ff && n.at(-1).payload.length === 40);
  check('Custom 加速度单位 m/s²（|a|≈9.81，非 g）', Math.abs(Math.hypot(d.ax, d.ay, d.az) - 9.80665) < 0.1);
  check('遥测 SEQ 独立递增并 u8 回绕', n.every((x, i) => i === 0 || x.seq === ((n[i - 1].seq + 1) & 0xff)));
  check('设备 timestamp 与 PC 有偏差（clockSkew 1.0084）', d.timestamp_ms > 1000 && d.timestamp_ms < 1020);
  for (let i = 0; i < 6600; i++) f.d.advance(10); const last = f.frames.filter((x) => x.msg === MSG.CUSTOM).at(-1).data; check('timestamp u16 回绕（67.6 s → ~2027）', last.timestamp_ms < 4000); }
{ const f = dev(); f.d.advance(200); f.d.write(new TextEncoder().encode('VoFa')); const n0 = f.jf.length; f.d.advance(100);
  check('vofa（大小写无关）→ RAM JustFloat 保留 mask 9 通道、无 ACK', f.d.active.format === 0 && f.d.active.mask === 0x1ff && f.jf.length - n0 >= 19 && f.jf.at(-1).length === 9 && f.d.saved.format === 1 && !f.frames.some((x) => x.msg === MSG.ACK)); }
{ const f = dev(); f.send(0x20, u8(0, 1, 0xff, 1, 0)); f.d.write(encodeFrame(0x7e, 1, new TextEncoder().encode('xvofax'))); check('payload 内 vofa 不触发切换', f.d.active.format === 1); }
{ const f = dev(); f.send(0x1d, u8(50, 0)); f.send(0x20, u8(0, 0, 3, 0, 0)); f.d.advance(500); const r = f.send(0x15);
  check(`0x15 → ACK 后复位，重启期间静默（随机 ${Math.round(f.d.lastRebootMs)} ms）`, r[0].data.status === 0 && f.d.resets === 1 && f.send(0x10).length === 0);
  let waited = 0; while (f.send(0x10).length === 0 && waited < 3000) { f.d.advance(10); waited += 10; }
  check('首个 PING 应答出现在重启结束后', waited >= f.d.lastRebootMs - 10 && waited <= f.d.lastRebootMs + 20);
  f.d.advance(100); const c = f.send(0x1f)[0].data;
  check('复位后按已保存配置：50 Hz Custom 0x1FF（RAM JF 丢失），SEQ 从 0', c.output_hz === 50 && c.uart_format === 1 && c.uart_mask === 0x1ff && f.frames.filter((x) => x.msg === MSG.CUSTOM).at(-1).seq < 10); }
{ const f = dev({ chunk: 7 }); f.d.advance(200); check('chunk 选项：随机分块输出仍可完整解析', f.frames.length >= 39 && f.p.stats.crcErrors === 0 && f.writes.every((w) => w.length <= 7)); }
{ const f = dev({ noise: 0.5 }); f.d.advance(500); check('noise 选项：插入噪声后帧仍可恢复', f.frames.length >= 95 && f.p.stats.noiseBytes > 0); }
for (const p of [0, 1, 2, 3, 4]) { const f = dev(); f.ack(0x13, u8(p)); f.d.advance(50);
  const ok = p === 0 ? f.jf.at(-1)?.length === 3 : p === 4 ? f.jf.at(-1)?.length === 6 : f.frames.at(-1).msg === [0, 1, 4, 3][p] && f.frames.at(-1).type === 'message';
  check(`旧预设 ${p} 输出 ${['JF×3', '0x01 LEN16', '0x04 LEN12', '0x03 LEN28', 'JF×6'][p]}`, ok); }
{ const ds = [1, 2, 3, 4, 5].map((seed) => { const f = dev({ seed }); f.send(0x15); return Math.round(f.d.lastRebootMs); }); check(`重启耗时随机、不固定（${ds.join(' / ')} ms）`, new Set(ds).size >= 4 && ds.every((x) => x >= 120 && x <= 900)); }
{ const f = dev({ flashPauseMs: 40 }); f.d.advance(100); const n0 = f.frames.filter((x) => x.msg === MSG.CUSTOM).length; f.send(0x1d, u8(200, 0)); for (let i = 0; i < 20; i++) f.d.advance(5);
  const cs = f.frames.filter((x) => x.msg === MSG.CUSTOM); const gap = cs.slice(n0 - 1).reduce((g, x, i, a) => i ? Math.max(g, ((x.seq - a[i - 1].seq) & 0xff) - 1) : 0, 0);
  check(`Flash 写入期间遥测暂停并丢弃排队帧 → SEQ 跳号 ${gap}（丢弃 ${f.d.droppedDuringFlash}）`, gap === f.d.droppedDuringFlash && gap >= 7); }
{ const f = dev(); f.ack(0x17); f.d.advance(100); check('设置模式内遥测照常', f.frames.filter((x) => x.msg === MSG.CUSTOM).length >= 19); f.ack(0x18); }
{ const f = dev({ failFlash: true }); const r = f.send(0x20, u8(0, 0, 7, 0, 1)); check('0x20 persist=1 Flash 失败 → 3 / 0x0607 + 现有 0x07', r[0].data.status === 3 && r[0].data.detail === 0x0607 && r[1].msg === 7 && r[1].data.uart_format === 1); }
summary('mock-device');
