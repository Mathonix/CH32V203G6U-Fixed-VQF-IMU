// CH32 UART OTA v1. Only an application binary linked at 0x400 is accepted.
import { CMD, CommandError } from './protocol.js';
export function crc32(data) {
  let c = 0xffffffff;
  for (const b of data) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
}
export function inspectImage(input, appMax = 31232) {
  const src = new Uint8Array(input); // own snapshot: a caller cannot mutate a staged file
  if (src.length < 512 || src.length > 31232) throw new Error('应用大小须为 512–31232 B');
  const v = new DataView(src.buffer, src.byteOffset, src.byteLength);
  if (v.getUint32(0, true) === 0 || v.getUint32(0, true) === 0xffffffff || String.fromCharCode(...src.slice(256, 260)) !== 'CHAP' || v.getUint32(260, true) - 0x400 !== src.length) throw new Error('无有效 CHAP 描述符：请选择 CH32_AHRS_app.bin，不能使用 full.bin、HEX 或 ELF');
  const versionBytes = src.slice(264, 276), stop = versionBytes.indexOf(0);
  const text = versionBytes.slice(0, stop < 0 ? 12 : stop);
  if (!text.length || Array.from(text).some((b) => b < 32 || b > 126)) throw new Error('镜像版本文本非法');
  const size = Math.ceil(src.length / 4) * 4;
  if (size > Math.min(appMax, 31232)) throw new Error(`镜像 ${size} B 超出应用区 ${appMax} B`);
  const data = new Uint8Array(size).fill(255); data.set(src);
  return { data, size, version: String.fromCharCode(...text), crc: crc32(data) };
}
export function* chunkPlan(size, chunk = 32) {
  if (!Number.isInteger(size) || size < 512 || size > 31232 || size % 4 || !Number.isInteger(chunk) || chunk < 4 || chunk > 56 || chunk % 4) throw new Error('非法 OTA 分块参数');
  for (let off = 0; off < size;) { const n = Math.min(chunk, 256 - off % 256, size - off); yield [off, n]; off += n; }
}
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
export async function uploadFirmware(s, image, { signal, onProgress = () => {}, timeoutMs = 2000, quietMaxMs = 12000, recoveryMs = 15000 } = {}) {
  if (s.otaActive || s.busy || s.pending) throw new Error('设备忙，请等待当前操作结束');
  if (s.calibrating) throw new Error('六面校准进行中，不能升级');
  const fw = s.firmware;
  if (fw?.ota_version !== 1 || !fw.app_max) throw new Error('设备未声明 UART OTA v1');
  // Reinspect owned data, rather than trusting UI metadata. The descriptor size is unpadded.
  const end = new DataView(image.data.buffer, image.data.byteOffset, image.data.byteLength).getUint32(260, true) - 0x400;
  const img = inspectImage(image.data.slice(0, end), fw.app_max);
  if (s.filter?.saved_profile === 3 && /^20261003[b-f]$/.test(img.version)) throw new Error('请先保存 0–2 档再降级到三档固件');
  const owner = s.otaOwner = Symbol('OTA'); s.otaActive = true;
  let beginAttempted = false, commitAttempted = false, commitAck = false;
  const command = (cmd, payload) => s.command(cmd, payload ? { payload } : {}, { timeoutMs, retries: 0, owner });
  const cancelled = () => { if (signal?.aborted) throw new CommandError('Cancelled', '已取消升级'); };
  const repeatable = async (cmd, payload) => {
    for (let i = 0;; i++) { cancelled(); try { return await command(cmd, payload); } catch (e) { if (e.kind !== 'Timeout' || i >= 2) throw e; } }
  };
  try {
    cancelled(); await command(CMD.ENTER_SETTINGS);
    const b = new Uint8Array(20), v = new DataView(b.buffer);
    v.setUint32(0, img.size, true); v.setUint32(4, img.crc, true); b.set(new TextEncoder().encode(img.version).slice(0, 12), 8);
    beginAttempted = true; await command(CMD.OTA_BEGIN, b);
    for (const [off, n] of chunkPlan(img.size)) {
      cancelled(); const p = new Uint8Array(4 + n); new DataView(p.buffer).setUint32(0, off, true); p.set(img.data.subarray(off, off + n), 4);
      await repeatable(CMD.OTA_WRITE, p); onProgress({ phase: '上传', done: off + n, total: img.size });
    }
    cancelled(); await repeatable(CMD.OTA_END); cancelled();
    onProgress({ phase: '提交并等待重启', done: img.size, total: img.size });
    commitAttempted = true;
    try { await command(CMD.OTA_COMMIT); commitAck = true; }
    catch (e) { if (e.ack) { commitAttempted = false; throw e; } if (e.kind !== 'Timeout') throw e; }
    // Never retransmit COMMIT or send ABORT after an uncertain commit. No traffic during copy.
    const frames = s.applicationFrames || 0; // after ACK/timeout: queued frames before COMMIT ACK are not reboot evidence
    const quietStart = performance.now();
    while ((s.applicationFrames || 0) === frames && performance.now() - quietStart < quietMaxMs) await pause(30);
    const deadline = performance.now() + recoveryMs;
    let after;
    while (performance.now() < deadline) {
      try { await command(CMD.PING); after = (await command(CMD.QUERY_FW_INFO)).data; break; }
      catch (e) { if (e.kind !== 'Timeout') throw e; await pause(100); }
    }
    if (!after || after.text !== img.version) throw new Error(`升级提交后版本未确认（预期 ${img.version}，回读 ${after?.text || '无应答'}）；请重新连接查询，勿重复提交`);
    if (!commitAck && fw.text === img.version) throw new Error('提交 ACK 丢失且版本相同，无法确认是否完成；请重新连接检查');
    s.telemetry.rebuild('OTA 重启');
    return { version: after.text, size: img.size, crc: img.crc, commitAck };
  } catch (e) {
    if (!commitAttempted) {
      if (beginAttempted) try { await command(CMD.OTA_ABORT); } catch (cleanup) { e.message += `；中止未确认：${cleanup.message}`; }
      try { await command(CMD.EXIT_SETTINGS); } catch (cleanup) { e.message += `；退出设置未确认：${cleanup.message}`; }
    }
    throw e;
  } finally { s.otaActive = false; s.otaOwner = null; }
}
