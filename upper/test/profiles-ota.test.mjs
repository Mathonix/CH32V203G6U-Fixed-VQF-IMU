import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { CMD, MSG, Ch32Session, filterDetails, encodeMessage, decodePayload, encodeCommandPayload, LIMITS } from '../public/protocol.js';
import { MockCh32Device } from '../public/mock-device.js';
import { inspectImage, chunkPlan, crc32, uploadFirmware } from '../public/ota.js';
let pass = 0;
async function test(name, fn) { await fn(); pass++; console.log('  ✔ ' + name); }
function rig(opts = {}) {
  const d = new MockCh32Device(opts);
  const s = new Ch32Session({ write: (b) => d.write(b), now: () => d.t, timeoutMs: 40, retries: 0 }); d.onTx = (b) => s.feed(b);
  const timer = setInterval(() => d.advance(5), 5);
  return { d, s, close() { clearInterval(timer); s.cancelAll(); } };
}
function fixture(version = '20261003h', size = 516) {
  const data = new Uint8Array(size).fill(0xaa); const v = new DataView(data.buffer);
  data.set(new TextEncoder().encode('CHAP'), 256); v.setUint32(260, size + 0x400, true); data.fill(0, 264, 276); data.set(new TextEncoder().encode(version), 264);
  return data;
}
await test('h/mock: 四档 RAM 切换，真实参数回读、当前/保存分离、无 Flash 写入', async () => {
 const r = rig(); try { await r.s.handshake({ settleMs: 0 });
 for (const [id, tau] of [[0, 1], [1, 2.5], [2, 5], [3, 2.5]]) { const f = await r.s.setFilter(id, 0); const x = filterDetails(f, r.s.firmware); assert.equal(x.kind, 'core'); assert.equal(x.tauAccS, tau); assert.equal(f.saved_profile, 1); assert.equal(x.zaruActive, id === 3); }
 assert.equal(r.d.flashWrites, 0); assert.equal(r.d.settings, false);
 } finally { r.close(); }
});
await test('h/mock: 保存 ZARU 后复位保持第3档，保留其他配置', async () => { const r = rig({ rebootMs: 40 }); try { await r.s.handshake({ settleMs: 0 }); await r.s.setFilter(3, 1); await r.s.reset({ pingTimeoutMs: 50, pingIntervalMs: 5 }); assert.equal(r.s.filter.saved_profile, 3); assert.equal(r.s.filter.active_profile, 3); assert.equal(r.s.config.output_hz, 200); assert.equal(r.d.flashWrites, 1); } finally { r.close(); } });
await test('e/mock: 三档旧固件不发送第3档设置，旧0B仅作为输出时间', async () => { const r = rig({ fwText: '20261003e' }); try { await r.s.handshake({ settleMs: 0 }); const n = r.d.rxCommands.length; await assert.rejects(r.s.setFilter(3), (e) => e.kind === 'Unsupported'); assert.equal(r.d.rxCommands.length, n); const x = filterDetails(r.s.filter, r.s.firmware); assert.equal(x.kind, 'output'); assert.equal(x.outputRestTauS, 0.5); assert.equal(x.tauAccS, null); } finally { r.close(); } });
await test('g/mock: 支持 ZARU，但不把0B的输出τ误作核心τAcc', async () => { const r = rig({ fwText: '20261003g' }); try { await r.s.handshake({ settleMs: 0 }); await r.s.setFilter(3); assert.equal(filterDetails(r.s.filter, r.s.firmware).kind, 'output'); assert.equal(r.s.filter.rest_tau_s, 0.5); } finally { r.close(); } });
await test('未知版本只显示原始参数，count4不猜测核心参数语义', () => { assert.equal(filterDetails({ active_profile: 1, profile_count: 4, rest_tau_s: 7 }, { text: 'other' }).kind, 'unknown'); });
await test('0B非法version/count/active/saved和非有限参数不更新状态', () => { const good = { version: 1, active_profile: 1, saved_profile: 1, profile_count: 4, estimator_hz: 2000, tau_mag_s: 0, rest_tau_s: 2.5 }; for (const bad of [{ version: 2 }, { profile_count: 0 }, { active_profile: 4 }, { saved_profile: 4 }, { rest_tau_s: NaN }]) { const p = encodeMessage(MSG.FILTER_CONFIG, 0, { ...good, ...bad }); assert.equal(decodePayload(MSG.FILTER_CONFIG, p.subarray(5, -2)).type, 'bad'); } });
await test('0x32 OTA能力和应用上限只读尾字节，旧长文本不被误判', () => { const p = new Uint8Array(16); p[0] = 1; p[1] = 9; p.set(new TextEncoder().encode('20261003h'), 2); p[12] = 1; p[14] = 0; p[15] = 122; const d = decodePayload(MSG.FW_INFO, p).data; assert.equal(d.ota_version, 1); assert.equal(d.app_max, 31232); p[1] = 14; const old = decodePayload(MSG.FW_INFO, p).data; assert.equal(old.ota_version, 0); assert.equal(old.app_max, 0); });
await test('CRC32标准向量、CHAP/尺寸/full镜像拒绝、补齐与分块页边界', () => {
 assert.equal(crc32(new TextEncoder().encode('123456789')), 0xcbf43926);
 const img = inspectImage(fixture('20261003h', 515)); assert.equal(img.size, 516); assert.equal(img.data[515], 255);
 assert.throws(() => inspectImage(new Uint8Array(32112))); const wrong = fixture(); wrong[256] = 0; assert.throws(() => inspectImage(wrong)); assert.throws(() => inspectImage(fixture(), 512));
 for (const [o, n] of chunkPlan(31232, 56)) { assert(n >= 4 && n <= 56 && n % 4 === 0 && o % 256 + n <= 256); }
 assert.throws(() => [...chunkPlan(515)]); assert.throws(() => [...chunkPlan(516, 3)]); assert.throws(() => encodeCommandPayload(CMD.OTA_WRITE, { payload: new Uint8Array(7) })); assert.equal(LIMITS.profile(4), false);
});
await test('OTA成功：BEGIN/WRITE/END/COMMIT、静默重启、版本确认、NV/校准不变', async () => {
 const r = rig({ fwText: '20261003g', rebootMs: 90 }); try { await r.s.handshake({ settleMs: 0 }); const saved = JSON.stringify(r.d.saved), cal = JSON.stringify(r.d.calSaved); let external;
 const result = await uploadFirmware(r.s, inspectImage(fixture()), { timeoutMs: 40, quietMaxMs: 400, recoveryMs: 500, onProgress: () => { if (!external) external = r.s.zeroYaw().catch((e) => e.kind); } });
 assert.equal(await external, 'OtaActive'); assert.equal(result.version, '20261003h'); assert.equal(r.d.otaCommits, 1); assert.equal(JSON.stringify(r.d.saved), saved); assert.equal(JSON.stringify(r.d.calSaved), cal); assert.equal(r.s.otaActive, false); assert.equal(r.d.rxCommands.filter((c) => c === CMD.OTA_COMMIT).length, 1);
 } finally { r.close(); }
});
await test('OTA WRITE丢ACK只重发相同块；COMMIT不重发', async () => { const r = rig({ fwText: '20261003g', rebootMs: 40 }); try { await r.s.handshake({ settleMs: 0 }); r.d.dropReplyFor.add(CMD.OTA_WRITE); await uploadFirmware(r.s, inspectImage(fixture()), { timeoutMs: 35, quietMaxMs: 200, recoveryMs: 300 }); assert.equal(r.d.rxCommands.filter((c) => c === CMD.OTA_WRITE).length, [...chunkPlan(516)].length + 1); assert.equal(r.d.otaCommits, 1); } finally { r.close(); } });
await test('OTA COMMIT丢ACK：被动等首帧后确认新版本，不发送ABORT', async () => { const r = rig({ fwText: '20261003g', rebootMs: 70 }); try { await r.s.handshake({ settleMs: 0 }); r.d.dropReplyFor.add(CMD.OTA_COMMIT); const a = await uploadFirmware(r.s, inspectImage(fixture()), { timeoutMs: 35, quietMaxMs: 300, recoveryMs: 400 }); assert.equal(a.commitAck, false); assert.equal(r.d.otaCommits, 1); assert.equal(r.d.otaAborts || 0, 0); } finally { r.close(); } });
await test('COMMIT后传输错误保持不确定状态：不ABORT、不重发COMMIT', async () => {
 const r = rig({ fwText: '20261003g' }); try { await r.s.handshake({ settleMs: 0 }); const write = r.s.write; r.s.write = (b) => { if (b[2] === CMD.OTA_COMMIT) { r.d.dropReplyFor.add(CMD.OTA_COMMIT); write(b); return Promise.reject(Object.assign(new Error('lost after send'), { kind: 'NotConnected' })); } return write(b); };
 await assert.rejects(uploadFirmware(r.s, inspectImage(fixture()))); assert.equal(r.d.otaCommits, 1); assert.equal(r.d.otaAborts || 0, 0); assert.equal(r.d.rxCommands.filter((c) => c === CMD.OTA_COMMIT).length, 1);
 } finally { r.close(); }
});
await test('同版本COMMIT丢ACK不能只凭相同版本宣称完成', async () => { const r = rig({ fwText: '20261003h', rebootMs: 40 }); try { await r.s.handshake({ settleMs: 0 }); r.d.dropReplyFor.add(CMD.OTA_COMMIT); await assert.rejects(uploadFirmware(r.s, inspectImage(fixture()), { timeoutMs: 25, quietMaxMs: 200, recoveryMs: 200 }), /版本相同/); assert.equal(r.d.otaAborts || 0, 0); assert.equal(r.d.otaCommits, 1); } finally { r.close(); } });
await test('OTA中途取消：中止暂存/退出设置，不提交、不改版本/NV', async () => { const r = rig({ fwText: '20261003g' }); const ctrl = new AbortController(); try { await r.s.handshake({ settleMs: 0 }); await assert.rejects(uploadFirmware(r.s, inspectImage(fixture()), { signal: ctrl.signal, onProgress: () => ctrl.abort() }), (e) => e.kind === 'Cancelled'); assert.equal(r.d.otaCommits || 0, 0); assert.equal(r.d.otaAborts, 1); assert.equal(r.d.settings, false); assert.equal(r.d.fwText, '20261003g'); } finally { r.close(); } });
await test('OTA校验失败：ABORT后退出，无COMMIT；Flash失败不报成功', async () => { for (const mode of ['crc', 'flash']) { const r = rig({ fwText: '20261003g' }); try { await r.s.handshake({ settleMs: 0 }); if (mode === 'flash') r.d.failFlash = true; else { const original = r.d._command.bind(r.d); r.d._command = (cmd, seq, p) => { if (cmd === CMD.OTA_END) r.d.ota.data[500] ^= 1; return original(cmd, seq, p); }; } await assert.rejects(uploadFirmware(r.s, inspectImage(fixture())), (e) => e.ack?.detail === (mode === 'crc' ? 0x0706 : 0x0705)); assert.equal(r.d.otaCommits || 0, 0); assert.equal(r.d.settings, false); } finally { r.close(); } } });
await test('旧固件/校准状态/忙设备不发OTA命令', async () => { for (const opts of [{ fwText: '20261003d' }, {}]) { const r = rig(opts); try { await r.s.handshake({ settleMs: 0 }); if (!opts.fwText) r.s.accCal.state = 1; const n = r.d.rxCommands.length; await assert.rejects(uploadFirmware(r.s, inspectImage(fixture()))); assert.equal(r.d.rxCommands.length, n); } finally { r.close(); } } });
if (process.env.APP_IMAGE) await test('真实h应用镜像描述符与CRC可读；full镜像不接受', async () => { const a = inspectImage(await readFile(process.env.APP_IMAGE)); assert.equal(a.version, '20261003h'); assert.equal(a.size, 31088); });
if (process.env.HARDWARE_CONTROL) await test('COM4真实回读经前端解码：h/OTA1/四档tauAcc、恢复原配置', async () => {
 const h = JSON.parse(await readFile(process.env.HARDWARE_CONTROL, 'utf8')); assert(h.pass && h.restored);
 const fw = decodePayload(MSG.FW_INFO, Uint8Array.from(Buffer.from(h.firmware, 'hex'))); assert.equal(fw.data.text, '20261003h'); assert.equal(fw.data.ota_version, 1); assert.equal(fw.data.app_max, 31232);
 for (const p of h.profiles) { const d = decodePayload(MSG.FILTER_CONFIG, Uint8Array.from(Buffer.from(p.payload, 'hex'))); assert.equal(d.type, 'message'); assert.equal(d.data.active_profile, p.id); assert.equal(filterDetails(d.data, fw.data).tauAccS, [1, 2.5, 5, 2.5][p.id]); }
 assert.equal(h.filter_before, h.filter_after); assert.equal(h.config_before, h.config_after);
});
console.log(`PASS profiles-ota: ${pass} passed, 0 failed (Mock, no hardware writes)`);
