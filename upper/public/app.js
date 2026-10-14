// app.js — UI 层：串口数据逐帧进入 ring buffer，界面按 rAF 限频刷新（采集与渲染解耦）
import { CMD, FORMAT, FORMAT_NAME, MASK_ALL, CUSTOM_FIELDS, CUSTOM_LABELS, LEGACY_PRESETS, FILTER_PROFILES, filterDetails, OUTPUT_HZ, UNSUPPORTED_FEATURES, CAP_TEXT, CAL_FACES, CAL_STATE, CAL_ERROR, CAL_CANCELLED, calSummary, G, popcount, maskFields, hex, ackText } from './protocol.js';
import { createState, logEvent } from './state.js';
import { Ch32Serial, describePort } from './serial.js';
import { drawPlot } from './plots.js';
import { initRouter } from './router.js';
import { inspectImage } from './ota.js';

const $ = (id) => document.getElementById(id);
const state = createState();
let dirty = true, tab = 'attitude', lastDraw = 0;
let pcbView = null, modelDirty = true, modelSig = ''; // 3D 板卡预览（见文件末尾）
const ATT_LABELS = ['Yaw(相对)', 'Pitch', 'Roll']; // 姿态曲线通道顺序 = P.attitude.push 顺序
const link = new Ch32Serial({ onSample, onEvent: (lvl, t) => { logEvent(state, t, lvl); dirty = true; }, onChange: () => { dirty = true; } });
window.__ch32 = { state, link, get session() { return link.session; } }; // 调试/测试钩子

const params = new URLSearchParams(location.search);
const NATIVE_SERIAL = 'serial' in navigator;
if (!NATIVE_SERIAL) { $('serialNotice').hidden = false; if (params.get('mock') === '1') $('serialNoticeMock').hidden = true; }
const MOCK = params.get('mock') === '1';
if (MOCK) {
  const { installMockSerial } = await import('./mock-serial.js');
  installMockSerial();
  $('mockNote').textContent = 'Mock 设备模式 · 模拟数据，不是实板'; $('mockNote').title = '?mock=1，固件文本 20261003m';
}

// ---------- 静态内容 ----------
const bitTile = (i) => `<label><input type="checkbox" data-bit="${i}" checked> ${CUSTOM_LABELS[i]}</label>`;
$('maskBits').insertAdjacentHTML('afterbegin', CUSTOM_FIELDS.slice(0, 6).map((f, i) => bitTile(i)).join('')); // Yaw Pitch Roll Ax Ay Az
$('maskMore').innerHTML = CUSTOM_FIELDS.slice(6).map((f, i) => bitTile(i + 6)).join(''); // Gx Gy Gz → 「更多选项 ›」
// 协议下拉：Custom / JustFloat（0x20 format）+ 旧预设（0x13，仅 RAM）
$('selProto').innerHTML = `<option value="${FORMAT.CUSTOM}">Custom</option><option value="${FORMAT.JUSTFLOAT}">JustFloat</option>` + LEGACY_PRESETS.map((p) => `<option value="L${p.id}">旧预设 ${p.id} · ${p.name}</option>`).join('');
$('hzList').innerHTML = OUTPUT_HZ.map((h) => `<option value="${h}"></option>`).join('');
$('inpHz').value = '200';
$('filterBtns').innerHTML = FILTER_PROFILES.map((p) => `<button data-filter="${p.id}" disabled title="档位 ${p.id} · 输出静止 ${p.restTauS} s / 运动 ${p.motionTauS} s">${p.name}</button>`).join('');
$('calFaces').innerHTML = CAL_FACES.map((f, i) => `<div class="calface" data-face="${i + 1}">${f}</div>`).join('');
$('unsupported').innerHTML = UNSUPPORTED_FEATURES.map((t) => `<li>${t}</li>`).join('');
// ---------- 页面路由（#/status #/output #/calib #/diag #/settings；无升级页）----------
const router = initRouter({ onChange: () => { dirty = true; lastDraw = 0; modelDirty = true; } });
window.__ch32.router = router;
const selectedMask = () => [...document.querySelectorAll('[data-bit]')].reduce((m, el) => el.checked ? m | (1 << Number(el.dataset.bit)) : m, 0);

// ---------- 遥测入口（每帧调用，不触碰 DOM） ----------
function onSample(s) {
  const P = state.plots;
  if (s.roll !== undefined || s.pitch !== undefined || s.yaw !== undefined) P.attitude.push(s.t, [s.yaw, s.pitch, s.roll]); // 显示顺序 Yaw / Pitch / Roll
  if (s.gyro) P.gyro.push(s.t, s.gyro);
  if (s.accel) P.accel.push(s.t, s.accel);
  if (state.rec) state.rec.rows.push([s.t.toFixed(2), s.seq ?? '', s.ts ?? '', s.yaw, s.pitch, s.roll, ...(s.accel || [, , ]), ...(s.gyro || [, , ]), s.temp ?? ''].join(','));
  if (state.drift) driftAdd(s);
  dirty = true;
}
function rawSink(dir, kind, bytes, t) {
  const r = state.raw; if (r.lines.length >= r.max) { r.dropped++; return; }
  r.lines.push(`${t.toFixed(3)}\t${dir}\t${kind}\t${hex(bytes)}`);
}

// ---------- 通用 ----------
function fmtErr(e) { return e && e.kind ? `[${e.kind}] ${e.message}` : String(e?.message || e); }
function setMsg(el, text, cls = '') { el.textContent = text; el.className = `msg ${cls}`; }
// 结果所在的卡片不在当前页（例如状态页的 Yaw 归零写到诊断页 actMsg）时，用 toast 提示一次
function toast(text, kind = 'ok', ms = 2600) {
  const box = $('toasts'); if (!box) return; const t = document.createElement('div');
  t.className = `toast ${kind}`; t.textContent = text; box.append(t);
  while (box.children.length > 3) box.firstChild.remove();
  setTimeout(() => { t.classList.add('out'); setTimeout(() => t.remove(), 300); }, ms);
}
const offPage = (el) => !el.closest('.view') || !!el.closest('.view[hidden]');
let busy = false, outSig = null, lastGapNote = '';
async function act(msgEl, label, fn) {
  if (busy) return; busy = true; updateControls();
  setMsg(msgEl, `${label}…`);
  try { const r = await fn(); setMsg(msgEl, `${label}：成功`, 'ok'); logEvent(state, `${label}：成功`, 'ok'); if (offPage(msgEl)) toast(`${label}：成功`, 'ok'); return r; }
  catch (e) { setMsg(msgEl, `${label}：失败 ${fmtErr(e)}`, 'err'); logEvent(state, `${label}：${fmtErr(e)}`, 'error'); if (offPage(msgEl)) toast(`${label}：失败 ${fmtErr(e)}`, 'error', 4000); }
  finally { busy = false; dirty = true; updateControls(); }
}
const S = () => link.session;

// ---------- 连接 ----------
$('btnConnect').onclick = async () => {
  if (!('serial' in navigator)) { logEvent(state, '浏览器不支持 Web Serial（请用电脑 Chrome / Edge，或 ?mock=1）', 'error'); dirty = true; return; }
  let port;
  try { port = await navigator.serial.requestPort(); } catch (e) { logEvent(state, `未选择串口：${e.message}`, 'warn'); dirty = true; return; }
  $('btnConnect').disabled = true;
  Object.values(state.plots).forEach((r) => r.clear());
  try { await link.connect(port); if (state.raw.on) link.rawSink = rawSink; logEvent(state, `已连接 ${describePort(link.info)} @ 2,000,000（只查询，未写 Flash）`, 'ok'); }
  catch (e) { logEvent(state, fmtErr(e), 'error'); }
  dirty = true; updateControls();
};
$('btnDisconnect').onclick = async () => { stopRecording(); await link.disconnect().catch((e) => logEvent(state, fmtErr(e), 'error')); dirty = true; updateControls(); };

// ---------- 输出 ----------
const persistOut = () => ($('outPersist').checked ? 1 : 0);
const confirmFlash = (what) => window.confirm(`${what}\n\n此操作会写入 Flash（重启后保留）。继续？`);
let pausedFrom = null;
$('btnPause').onclick = () => {
  const c = S()?.config; if (!c) return;
  if (pausedFrom) { const k = pausedFrom; act($('outMsg'), '恢复遥测', async () => { await S().setOutputConfig({ ...k, persist: 0 }); pausedFrom = null; }); return; }
  if (c.uart_format === FORMAT.LEGACY) { setMsg($('outMsg'), '旧预设模式没有 mask，无法用 mask=0 暂停', 'err'); return; }
  const keep = { format: c.uart_format, mask: c.uart_mask };
  act($('outMsg'), '暂停遥测', async () => { await S().setOutputConfig({ format: keep.format, mask: 0, persist: 0 }); pausedFrom = keep; });
};
$('btnVofa').onclick = () => act($('outMsg'), '发送 vofa（RAM JustFloat）', () => S().sendVofa());
// 单卡「应用」：草稿 = 协议 + 输出内容 + 断电保存 + 频率。下发内容与原来的独立按钮完全相同：
//   Custom / JustFloat → setOutputConfig({ format, mask, persist })（原 Custom 9 字段 / 所选字段 Custom / JustFloat，Custom + 全选 = 20 00 01 FF 01 00）
//   旧预设 N → setLegacyPreset(N)（0x13，仅 RAM，原「应用旧预设」）；频率有改动 → saveOutputHz(hz)（0x1D，总是写 Flash，原「保存频率」）
//   协议 / 内容未改动且未勾断电保存时不发 0x20；频率未改动时不发 0x1D。
const protoDraft = () => { const v = $('selProto').value; return v[0] === 'L' ? { legacy: Number(v.slice(1)) } : { format: Number(v) }; };
function outDiff(c) {
  const d = { ...protoDraft(), mask: selectedMask(), hz: Number($('inpHz').value) };
  const fmtChanged = d.legacy !== undefined ? !(c.uart_format === FORMAT.LEGACY && c.uart_legacy === d.legacy) : (c.uart_format !== d.format || c.uart_mask !== d.mask);
  return { d, fmtChanged, hzChanged: d.hz !== c.output_hz };
}
function syncOutDraft(c) { // 回读变化时把草稿同步为设备当前值（用户未改动的回读周期内不覆盖）
  const sig = c ? [c.uart_format, c.uart_mask, c.uart_legacy, c.output_hz, pausedFrom ? pausedFrom.mask : ''].join() : '';
  if (sig === outSig) return; outSig = sig; if (!c) return;
  $('selProto').value = c.uart_format === FORMAT.LEGACY ? `L${c.uart_legacy}` : String(c.uart_format);
  const m = pausedFrom ? pausedFrom.mask : c.uart_format === FORMAT.LEGACY ? null : c.uart_mask;
  if (m != null) document.querySelectorAll('[data-bit]').forEach((el) => { el.checked = !!(m & (1 << Number(el.dataset.bit))); });
  $('inpHz').value = String(c.output_hz);
}
$('btnAll').onclick = () => { document.querySelectorAll('[data-bit]').forEach((el) => { el.checked = true; }); dirty = true; };
$('btnNone').onclick = () => { document.querySelectorAll('[data-bit]').forEach((el) => { el.checked = false; }); dirty = true; };
$('btnApply').onclick = () => {
  const s = S(), c = s?.config; if (!c) return;
  const { d, fmtChanged, hzChanged } = outDiff(c), legacy = d.legacy !== undefined, p = legacy ? 0 : persistOut();
  const sendFmt = fmtChanged || !!p;
  if (sendFmt && !legacy && !d.mask) { setMsg($('outMsg'), '至少选择一个字段；暂停请用“暂停遥测”', 'err'); return; }
  if (hzChanged && !OUTPUT_HZ.includes(d.hz)) { setMsg($('outMsg'), `不支持 ${$('inpHz').value || '空'} Hz，可选：${OUTPUT_HZ.join(' / ')}`, 'err'); return; }
  if (hzChanged && s.calibrating) { setMsg($('outMsg'), '六面校准进行中：保存频率已锁定（固件会回 0x0604）', 'err'); return; }
  if (!sendFmt && !hzChanged) { setMsg($('outMsg'), '没有改动'); return; }
  const m = d.mask, fmtLabel = legacy ? `旧预设 ${d.legacy}（RAM）` : d.format === FORMAT.JUSTFLOAT ? `JustFloat ${popcount(m)} 通道（${p ? 'Flash' : 'RAM'}）` : m === MASK_ALL ? `Custom 九字段（${p ? 'Flash' : 'RAM'}）` : `Custom mask 0x${m.toString(16).padStart(3, '0')}（${p ? 'Flash' : 'RAM'}）`;
  const flashWhat = [sendFmt && p ? (legacy ? '' : fmtLabel) : '', hzChanged ? `输出频率 ${d.hz} Hz（0x1D 总是保存）` : ''].filter(Boolean);
  if (flashWhat.length && !confirmFlash(flashWhat.join('\n'))) return;
  const label = [sendFmt ? fmtLabel : '', hzChanged ? `保存频率 ${d.hz} Hz` : ''].filter(Boolean).join(' + ');
  act($('outMsg'), label, async () => {
    if (sendFmt) { if (legacy) await S().setLegacyPreset(d.legacy); else await S().setOutputConfig({ format: d.format, mask: m, persist: p }); pausedFrom = null; }
    if (hzChanged) await S().saveOutputHz(d.hz);
  });
};
$('selProto').onchange = () => { dirty = true; updateControls(); };
// ---------- 滤波：17 → 27 → 18 ----------
document.querySelectorAll('[data-filter]').forEach((b) => b.onclick = () => {
  const id = Number(b.dataset.filter), p = $('filterPersist').checked ? 1 : 0;
  if (p && !confirmFlash(`滤波档位 ${FILTER_PROFILES[id].name}${id === 3 ? '；保存后降级到三档旧固件前须先保存 0–2 档' : ''}`)) return;
  act($('filterMsg'), `${p ? '保存' : '切换'}滤波 ${FILTER_PROFILES[id].name}`, () => S().setFilter(id, p));
});
// ---------- UART OTA（文件检查不访问设备；仅显式确认后写 Flash） ----------
let otaImage = null, otaAbort = null;
$('otaFile').onchange = async () => {
  otaImage = null;
  try {
    const file = $('otaFile').files[0]; if (!file) return;
    if (file.size < 512 || file.size > 31232) throw new Error('应用大小须为 512–31232 B');
    otaImage = inspectImage(new Uint8Array(await file.arrayBuffer()));
    setMsg($('otaMsg'), `${file.name} · ${otaImage.version} · ${otaImage.size} B · CRC32 ${otaImage.crc.toString(16).padStart(8, '0')}`, 'ok');
  } catch (e) { setMsg($('otaMsg'), e.message, 'err'); }
  updateControls();
};
$('btnOtaCancel').onclick = () => otaAbort?.abort();
$('btnOta').onclick = () => {
  if (!otaImage || !confirmFlash(`UART 应用升级到 ${otaImage.version}（${otaImage.size} B），将重启设备。仅更新应用，保留 NV 配置和校准；引导桩不更新。${S()?.filter?.saved_profile === 3 && /^20261003[b-f]$/.test(otaImage.version) ? ' 请先保存 0–2 档再降级。' : ''}`)) return;
  if (S()?.filter?.saved_profile === 3 && /^20261003[b-f]$/.test(otaImage.version)) { setMsg($('otaMsg'), '请先保存 0–2 档再降级到三档固件', 'err'); return; }
  $('otaProgress').value = 0; otaAbort = new AbortController();
  act($('otaMsg'), 'UART 升级', () => link.updateFirmware(otaImage, { signal: otaAbort.signal, onProgress: ({ phase, done, total }) => {
    $('otaProgress').value = done / total; $('btnOtaCancel').disabled = phase !== '上传';
    setMsg($('otaMsg'), `${phase} · ${done}/${total} B…`);
  } })).finally(() => { otaAbort = null; updateControls(); });
};
// ---------- 六面校准 ----------
let calResult = null;
function watchCal(run) {
  run.final.then((r) => {
    calResult = r; const cls = r.ok ? 'ok' : r.cancelled || r.lost ? 'warn' : 'err';
    setMsg($('calMsg'), r.ok ? '六面校准完成，已写入 Flash' : r.lost ? r.errorText : r.cancelled ? '六面校准已取消' : `六面校准失败：${r.errorText}`, cls === 'warn' ? '' : cls);
    dirty = true; updateControls();
  });
}
$('btnCalStart').onclick = () => {
  if (!window.confirm('开始六面加速度校准？\n进入设置模式（17）后发 0x1C；按提示依次放置 6 个面（每面 60 s 超时）。\n完成时固件把 bias / scale 写入 Flash；期间复位与保存会被锁定。')) return;
  calResult = null; $('calResult').hidden = true;
  act($('calMsg'), '启动六面校准', async () => { const run = await S().startSixFace(); watchCal(run); if (run.recovered) logEvent(state, '0x1C 应答超时，已通过 0x24 恢复为进行中（未重发）', 'warn'); });
};
$('btnCalCancel').onclick = () => act($('calMsg'), '取消六面校准', () => S().cancelSixFace({ via: 0x25 }));
function renderCal(s, connected) {
  const sup = !!(connected && s?.sixFaceSupported), c = sup ? s.accCal : null, k = calSummary(c);
  $('calCard').classList.toggle('locked', !!s?.calibrating);
  $('calState').textContent = !connected ? '未连接' : !sup ? '不支持（caps bit7=0）' : c ? (CAL_STATE[c.state] ?? c.state) : '—';
  $('calState').className = `pill ${c?.state === 1 ? 'stale' : c?.state === 2 ? 'live' : ''}`;
  $('calPhase').textContent = k ? (k.running || c.state !== 0 ? k.phaseText : '—') : '—';
  $('calPhase').className = k?.warn ? 'warn' : c?.phase === 7 ? 'err' : '';
  const onFace = !!(k?.running && [1, 2, 5, 6].includes(c.phase)); // 等待放置（phase 0）时不高亮上一面
  document.querySelectorAll('[data-face]').forEach((el) => { const f = Number(el.dataset.face); el.classList.toggle('done', !!(c && c.done_mask & (1 << (f - 1)))); el.classList.toggle('cur', !!(onFace && c.face === f)); });
  const fp = k && c.state !== 0 && !(k.running && c.phase === 0) ? Math.round(k.faceProgress * 100) : k?.running ? 0 : null, ap = k ? Math.round(k.overall * 100) : null;
  $('calFaceBar').style.width = `${fp ?? 0}%`; $('calFacePct').textContent = fp == null ? '—' : `${fp}%`;
  $('calAllBar').style.width = `${ap ?? 0}%`; $('calAllPct').textContent = k ? `${k.done} / 6 面 · ${ap}%` : '—';
  $('calFace').textContent = k?.running ? `${onFace ? k.faceName : '等待放置下一面'} · ${(c.left_ms / 1000).toFixed(1)} s` : k ? k.faceName : '—';
  $('calSamples').textContent = c && c.state !== 0 ? `${c.samples} · ${(c.elapsed_ms / 1000).toFixed(1)} s` : '—';
  $('calRaw').textContent = c && c.state !== 0 ? c.raw_g.map((x) => x.toFixed(3)).join(' ') : '—';
  $('calErr').textContent = c?.error ? `0x${c.error.toString(16).padStart(4, '0')} ${c.error === CAL_CANCELLED ? '已取消（非错误）' : CAL_ERROR[c.error] ?? ''}` : '—';
  $('calValid').textContent = c ? (c.flash_valid ? '1（有效）' : '0（无保存值）') : '—';
  $('calBias').textContent = c ? c.bias_g.map((x) => x.toFixed(4)).join(' ') : '—';
  $('calScale').textContent = c ? c.scale.map((x) => x.toFixed(4)).join(' ') : '—';
  const r = calResult; $('calResult').hidden = !r;
  if (r) { $('calResult').className = `calres ${r.ok ? 'ok' : r.cancelled || r.lost ? 'warn' : 'err'}`; $('calResult').textContent = r.ok ? `完成：6 / 6 面，已保存到 Flash（flash_valid ${r.cal?.flash_valid}）` : r.lost ? `${r.errorText}；Flash 中原值不变` : r.cancelled ? '已取消：最终 ACK 3 / 0x0608（不是错误，Flash 中原值不变）' : `失败：0x${r.detail.toString(16).padStart(4, '0')} ${r.errorText}（Flash 中原值不变）`; }
}

// ---------- 动作 ----------
$('btnZeroYaw').onclick = () => act($('actMsg'), 'Yaw 归零', async () => { await S().zeroYaw(); state.relativeZero = true; });
$('btnReset').onclick = () => { if (S()?.calibrating) { setMsg($('actMsg'), '六面校准进行中：复位已锁定（固件不会阻止 0x15，但会中断校准）', 'err'); return; } if (!window.confirm('复位设备（0x15）？\nMCU 将重启并从 Flash 载入已保存配置，未保存的 RAM 设置会丢失。0x15 不会自动重发；之后按节奏发送 PING，首个应答即视为恢复。')) return; pausedFrom = null; state.relativeZero = false; act($('actMsg'), '复位（等待首个 PING 应答）并重新握手', () => S().reset()); };
$('btnRequery').onclick = () => act($('actMsg'), '重新查询设备', () => S().handshake({ settleMs: 0 }));
$('btnRaw').onclick = () => {
  state.raw.on = !state.raw.on;
  if (state.raw.on) { state.raw.lines = []; state.raw.dropped = 0; link.rawSink = rawSink; logEvent(state, '开始记录原始帧（TX/RX，含 JustFloat）'); }
  else { link.rawSink = null; logEvent(state, `停止记录原始帧：${state.raw.lines.length} 行`); }
  dirty = true; updateControls();
};
$('btnRawSave').onclick = () => download(`ch32-raw-${stamp()}.tsv`, `# pc_ms\tdir\tkind\thex  (dropped ${state.raw.dropped})\n${state.raw.lines.join('\n')}\n`, 'text/tab-separated-values');
$('btnRec').onclick = () => { if (state.rec) stopRecording(); else { state.rec = { rows: [], t0: performance.now() }; logEvent(state, '开始记录 CSV（加速度 m/s²）'); } dirty = true; updateControls(); };
function stopRecording() {
  if (!state.rec) return; const r = state.rec; state.rec = null;
  download(`ch32-${stamp()}.csv`, `pc_ms,seq,dev_ts_ms,yaw_deg,pitch_deg,roll_deg,ax_ms2,ay_ms2,az_ms2,gx_dps,gy_dps,gz_dps,temp_c\n${r.rows.join('\n')}\n`, 'text/csv');
  setMsg($('recMsg'), `已导出 ${r.rows.length} 行`, 'ok');
}
$('btnDiag').onclick = () => {
  const s = S();
  download(`ch32-diag-${stamp()}.json`, JSON.stringify({ time: new Date().toISOString(), mock: MOCK, port: link.info ? describePort(link.info) : null, state: link.state,
    firmware: s?.firmware, config: s?.config, filter: s?.filter, system: s?.system, stats: s ? { parser: s.parser.stats, commands: s.cmdStats, telemetry: { ...s.telemetry, window: undefined, rateHz: s.telemetry.rateHz(performance.now()) } } : null,
    events: state.events }, null, 2), 'application/json');
};
$('btnDrift').onclick = () => {
  const sec = Number($('selDrift').value);
  state.drift = { until: performance.now() + sec * 1000, sec, first: null, last: null, min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity], n: 0 };
  $('driftOut').textContent = `静止测试 ${sec} s 进行中…`; updateControls();
};
function driftAdd(s) {
  const d = state.drift; if (s.yaw === undefined) return;
  const v = [s.yaw, s.pitch, s.roll]; if (!d.first) d.first = { t: s.t, v }; d.last = { t: s.t, v }; d.n++;
  v.forEach((x, i) => { if (x < d.min[i]) d.min[i] = x; if (x > d.max[i]) d.max[i] = x; });
  if (s.t >= d.until) {
    state.drift = null; const dt = (d.last.t - d.first.t) / 1000 || 1;
    $('driftOut').textContent = `${d.sec} s · ${d.n} 帧\n极差 Y/P/R ${d.min.map((m, i) => (d.max[i] - m).toFixed(3)).join(' / ')} °\nYaw 漂移 ${((d.last.v[0] - d.first.v[0]) / dt * 60).toFixed(3)} °/min（仅本次静置观察）`;
    updateControls();
  }
}
function download(name, text, type) { const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([text], { type })); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 5000); }
function stamp() { const d = new Date(), p = (x) => String(x).padStart(2, '0'); return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`; }

// ---------- Tabs ----------
document.querySelectorAll('[data-tab]').forEach((b) => b.onclick = () => { tab = b.dataset.tab; document.querySelectorAll('[data-tab]').forEach((x) => x.classList.toggle('active', x === b)); dirty = true; });
$('selAccUnit').onchange = () => { state.accelUnit = $('selAccUnit').value; dirty = true; };

// ---------- 渲染 ----------
function updateControls() {
  const ok = link.state === 'CONNECTED', s = S(), c = s?.config;
  $('btnConnect').disabled = link.state !== 'DISCONNECTED' && link.state !== 'ERROR';
  $('btnDisconnect').disabled = !link.port || link.state === 'UPDATING';
  $('otaFile').disabled = busy || link.state === 'UPDATING';
  $('btnOta').disabled = !ok || busy || s?.calibrating || !otaImage || s?.firmware?.ota_version !== 1 || otaImage.size > (s?.firmware?.app_max ?? 0);
  $('btnOtaCancel').disabled = !s?.otaActive || $('otaProgress').value >= 1;
  for (const id of ['selProto', 'inpHz', 'btnApply', 'btnPause', 'btnVofa', 'btnZeroYaw', 'btnReset', 'btnRequery']) $(id).disabled = !ok || busy;
  const cal = !!s?.calibrating; // 六面校准进行中：锁定复位（0x15）/ 保存频率 / persist / 滤波（其 0x18 会取消校准）
  for (const id of ['btnReset', 'inpHz']) if (cal) $(id).disabled = true;
  $('outFieldset').disabled = $('selProto').value[0] === 'L'; // 旧预设由 enum 决定字段
  $('btnReset').title = cal ? '六面校准进行中：已锁定（固件不阻止 0x15，但会中断校准）' : '0x15：ACK 后 MCU 复位，按已保存配置启动；不自动重发';
  for (const id of ['outPersist', 'filterPersist']) { if (cal) $(id).checked = false; $(id).disabled = cal; }
  $('btnCalStart').disabled = !ok || busy || cal || !s?.sixFaceSupported; $('btnCalCancel').disabled = !ok || busy || !cal;
  document.querySelectorAll('[data-filter]').forEach((b) => { b.hidden = Number(b.dataset.filter) === 3 && !(s?.filter?.profile_count >= 4); b.disabled = !ok || busy || cal || !(Number(b.dataset.filter) < (s?.filter?.profile_count ?? 0)); b.classList.toggle('active', s?.filter?.active_profile === Number(b.dataset.filter)); });
  $('btnPause').textContent = pausedFrom ? '恢复遥测' : '暂停遥测';
  $('btnRaw').disabled = !link.port && !state.raw.on; $('btnRaw').textContent = state.raw.on ? `停止记录原始帧（${state.raw.lines.length}）` : '记录原始帧';
  $('btnRawSave').disabled = !state.raw.lines.length;
  $('btnRec').disabled = !ok && !state.rec; $('btnRec').textContent = state.rec ? `停止并导出 CSV（${state.rec.rows.length}）` : '开始记录 CSV';
  $('btnDrift').disabled = !ok || !!state.drift;
  syncOutDraft(c);
}
const f2 = (x, d = 2) => (x === undefined || x === null || Number.isNaN(x) ? '—' : Number(x).toFixed(d));
function kpi(label, value, unit = '', cls = '') { return `<div class="kpi ${cls}"><span>${label}</span><b>${value}${unit ? `<em>${unit}</em>` : ''}</b></div>`; }
function metric(label, value, cls = '') { return `<div class="m ${cls}"><i>${label}</i><b>${value}</b></div>`; }
function render(now) {
  requestAnimationFrame(render);
  if (now - lastDraw < 33) return; // ≈30 fps
  lastDraw = now;
  const s = S(), connected = link.state === 'CONNECTED' || link.state === 'HANDSHAKE';
  const stale = connected && s ? s.isStale(now) : false, live = connected && s?.last && !stale;
  const plan = s?.plan;
  $('liveBadge').textContent = !connected ? 'OFFLINE' : live ? 'LIVE' : plan?.paused ? 'PAUSED' : 'STALE';
  $('liveBadge').className = `pill ${live ? 'live' : connected ? 'stale' : ''}`;
  $('staleBadge').hidden = !(connected && !live);
  $('staleBadge').textContent = plan?.paused ? '遥测已暂停（mask=0）' : s?.last ? `数据过期 ${(s.telemetry.ageMs(now) / 1000).toFixed(1)} s` : '暂无遥测';
  $('connState').textContent = link.state;
  $('connChip').dataset.state = link.state === 'CONNECTED' ? 'on' : link.state === 'ERROR' ? 'fail' : link.state === 'DISCONNECTED' ? 'off' : 'busy';
  $('sData').textContent = !connected ? '无数据' : live ? '实时' : plan?.paused ? '已暂停' : '过期';
  $('sData').className = `chip ${live ? 'on' : connected ? 'warn' : ''}`;
  { const c0 = s?.config, od = c0 && connected ? outDiff(c0) : null; // 输出页状态：等待读取 / 已读取 / 未应用 / 已暂停
    $('outState').textContent = !od ? '等待读取' : pausedFrom ? '已暂停' : od.fmtChanged || od.hzChanged ? '未应用' : '已读取';
    $('outState').className = `chip ${!od ? '' : pausedFrom || od.fmtChanged || od.hzChanged ? 'warn' : 'on'}`; }
  $('setState').textContent = connected && s?.filter ? `滤波 · ${FILTER_PROFILES[s.filter.active_profile]?.name ?? s.filter.active_profile}` : connected ? '已连接' : '未连接';
  $('setState').className = `chip ${connected ? 'on' : ''}`;
  $('portInfo').textContent = link.port ? describePort(link.info) : '—';
  const fw = s?.firmware; $('fw').textContent = fw ? fw.text : '—';
  if (fw?.mock) { const badge = document.createElement('span'); badge.className = 'badge mock'; badge.textContent = 'Mock'; $('fw').append(badge); }
  $('otaCap').textContent = fw ? (fw.ota_version === 1 ? `UART OTA v1 · 应用上限 ${fw.app_max} B` : '设备未声明 UART OTA v1') : '连接后查询能力';
  const c = s?.config;
  const fmt = c ? (c.uart_format === FORMAT.LEGACY ? `Legacy ${c.uart_legacy} · ${LEGACY_PRESETS[c.uart_legacy]?.name ?? '?'}` : `${FORMAT_NAME[c.uart_format] ?? c.uart_format} · ${popcount(c.uart_mask)} 字段`) : '—';
  $('streamMode').textContent = fmt; $('outFormat').textContent = c ? `${fmt}（当前值）` : '—';
  $('outMask').textContent = c ? (c.uart_format === FORMAT.LEGACY ? '— (旧预设由 enum 决定)' : `0x${c.uart_mask.toString(16).padStart(3, '0')}${c.uart_mask === 0 ? '（不输出遥测）' : ''}`) : '—';
  $('outFields').textContent = c ? (plan?.fields ? plan.fields.join(' ') || '—' : `MSG 0x${(plan?.msg ?? 0).toString(16).padStart(2, '0')}`) : '—';
  const hzPair = c ? `${c.output_hz} / ${c.saved_output_hz} Hz` : '—'; $('hzPair').textContent = hzPair; $('outHz').textContent = hzPair;
  const rate = s ? s.telemetry.rateHz(now) : 0; $('rxRate').textContent = s && connected ? `${rate.toFixed(1)} 帧/s` : '—';
  const f = s?.filter;
  $('fPair').textContent = f ? `${FILTER_PROFILES[f.active_profile]?.name ?? f.active_profile} / ${FILTER_PROFILES[f.saved_profile]?.name ?? f.saved_profile}` : '—';
  const fd = filterDetails(f, fw), fp = fd.profile;
  $('fTau').textContent = f && fd.outputRestTauS != null ? `${f2(fd.outputRestTauS)} s / ${f2(fp?.motionTauS)} s` : '—';
  $('fCore').textContent = fd.kind === 'core' ? `τAcc ${f2(fd.tauAccS)} s · 陀螺 LPF ${fp?.gyroLpfHz ?? '—'} Hz · σRest ${fp?.biasSigmaRestDps ?? '—'} °/s` : fd.kind === 'output' ? '旧固件：仅输出平滑档位' : f ? `未识别固件语义 · 原始参数 ${f.rest_tau_s} s` : '—';
  $('fNote').textContent = fd.zaruActive && fd.kind !== 'unknown' ? `${fd.kind === 'core' ? '均衡内核' : '旧 VQF 内核'} + UART 航向保持；检测到运动后退出保持。阈值固定。` : fd.kind === 'core' ? '响应适合快速运动；稳定优先抑制干扰，响应较慢。运动实测待完成。' : '参数语义按固件版本区分，档位按设备回读显示。';
  $('fEst').textContent = f ? `${f.estimator_hz} Hz · ${f.profile_count} 档 · 无磁 τ=${f.tau_mag_s}` : '—';
  const sy = s?.system;
  $('dTemp').textContent = sy ? `${sy.temperature_c.toFixed(2)} °C` : '—'; $('sTemp').textContent = $('dTemp').textContent;
  $('dRates').textContent = sy ? `${sy.fusion_hz} / ${sy.output_hz} Hz / ${sy.skip}` : '—';
  $('dStream').textContent = sy ? (sy.stream_mode === 0xff ? '0xFF（非 Legacy）' : `Legacy ${sy.stream_mode}`) : '—';
  $('dCan').textContent = sy ? (sy.can_ok ? '已初始化（总线未验证）' : '未初始化') : '—';
  $('dCaps').textContent = c ? `0x${c.capabilities.toString(16)} ${CAP_TEXT.filter((_, i) => c.capabilities & (1 << i)).join('、')}` : '—';
  $('dRange').textContent = c ? `${c.active_gyro_range_dps} dps（不可修改）` : '—';
  $('dFusion').textContent = c ? `六轴（${c.active_fusion_mode}/${c.saved_fusion_mode}）` : '—';
  // 姿态
  const L = s?.last;
  $('yaw').textContent = f2(L?.yaw); $('pitch').textContent = f2(L?.pitch); $('roll').textContent = f2(L?.roll);
  ['yaw', 'pitch', 'roll'].forEach((k) => $(k).style.opacity = live ? 1 : 0.45);
  if (L?.roll !== undefined) $('horizon').style.transform = `translateY(${Math.max(-40, Math.min(40, L.pitch ?? 0))}%) rotate(${-L.roll}deg)`;
  drawModel(L, !live);
  $('relZero').hidden = !state.relativeZero;
  // 统计
  if (s) {
    const ps = s.parser.stats, cs = s.cmdStats, ts = s.telemetry, age = ts.ageMs(now);
    const warnN = ps.crcErrors + cs.timeouts + cs.ackFailures + ts.unexpectedMissing;
    $('diagState').textContent = !connected ? '未连接' : warnN ? '有告警' : '正常'; $('diagState').className = `chip ${!connected ? '' : warnN ? 'warn' : 'on'}`;
    $('diagKey').innerHTML = [kpi('实收', `${rate.toFixed(1)}`, 'Hz', live ? 'ok' : ''), kpi('SEQ 缺失', ts.unexpectedMissing, '', ts.unexpectedMissing ? 'warn' : ''), kpi('CRC 错误', ps.crcErrors, '', ps.crcErrors ? 'bad' : ''), kpi('超时', cs.timeouts, '', cs.timeouts ? 'warn' : '')].join('');
    $('diag').innerHTML = [
      metric('实收率(PC)', `${rate.toFixed(1)} Hz`, live ? 'ok' : connected && !plan?.paused ? 'warn' : ''),
      metric('标称', c ? `${c.output_hz} Hz` : '—'),
      metric('数据', !connected ? '—' : live ? '实时' : plan?.paused ? '已暂停' : `过期 ${Number.isFinite(age) ? (age / 1000).toFixed(1) + ' s' : ''}`, live ? 'ok' : connected ? 'warn' : ''),
      metric('遥测帧', ts.frames), metric('AA55 帧', ps.frames), metric('JustFloat 帧', ps.jfFrames),
      metric('CRC 错误', ps.crcErrors, ps.crcErrors ? 'bad' : 'ok'), metric('LEN 错误', ps.lenErrors, ps.lenErrors ? 'warn' : ''), metric('坏帧(长度/mask)', ps.badFrames, ps.badFrames ? 'warn' : ''),
      metric('丢弃字节', ps.noiseBytes, ps.noiseBytes ? 'warn' : ''), metric('SEQ 缺失', ts.expectedMissing ? `${ts.missing}（Flash ${ts.expectedMissing}）` : ts.missing, ts.unexpectedMissing ? 'warn' : 'ok'),
      metric('Flash 跳号', ts.flashGaps ? `${ts.flashGaps} 次 · 正常` : '0', ''), metric('SEQ 重复', ts.duplicates),
      metric('SEQ / ts 回绕', `${ts.seqWraps} / ${ts.tsWraps}`), metric('基线重建', ts.baselineResets),
      metric('命令', cs.sent), metric('超时', cs.timeouts, cs.timeouts ? 'warn' : ''), metric('重试', cs.retries, cs.retries ? 'warn' : ''),
      metric('失败 ACK', cs.ackFailures, cs.ackFailures ? 'warn' : ''), metric('意外 ACK', cs.unexpectedAcks, cs.unexpectedAcks ? 'warn' : ''), metric('迟到应答', cs.lateReplies), metric('校准拦截', cs.calBlocked || 0),
      metric('复位 / 重启 PING', cs.resets ? `${cs.resets} / ${cs.rebootPings}${cs.lastRebootMs != null ? ` · ${cs.lastRebootMs} ms` : ''}` : '0'),
      metric('原始帧', state.raw.on ? `记录中 ${state.raw.lines.length}` : state.raw.lines.length ? `${state.raw.lines.length} 行` : '关'),
    ].join('');
  } else { $('diag').innerHTML = metric('状态', '未连接'); $('diagKey').innerHTML = ['实收', 'SEQ 缺失', 'CRC 错误', '超时'].map((k) => kpi(k, '—')).join(''); $('diagState').textContent = '未连接'; $('diagState').className = 'chip'; }
  if (s && s.telemetry.lastGapNote && s.telemetry.lastGapNote !== lastGapNote) { lastGapNote = s.telemetry.lastGapNote; logEvent(state, s.telemetry.lastGapNote, 'info'); }
  renderCal(s, connected);
  $('events').innerHTML = state.events.map((e) => `<li class="${e.level}">${e.time} ${e.text.replace(/</g, '&lt;')}</li>`).join('');
  updateControls();
  // 曲线
  const canvas = $('plot'), g = state.accelUnit === 'g';
  if (tab === 'attitude') drawPlot(canvas, state.plots.attitude, { windowMs: Number($('selWindow').value), labels: ATT_LABELS, unit: 'deg', stale: !live });
  else if (tab === 'gyro') drawPlot(canvas, state.plots.gyro, { windowMs: Number($('selWindow').value), labels: ['Gx', 'Gy', 'Gz'], unit: 'deg/s', stale: !live });
  else drawPlot(canvas, g ? scaled(state.plots.accel) : state.plots.accel, { windowMs: Number($('selWindow').value), labels: ['Ax', 'Ay', 'Az'], unit: g ? 'g' : 'm/s²', stale: !live });
  const a = L?.accel, gy = L?.gyro, k = g ? 1 / G : 1;
  $('plotVals').textContent = L ? `Accel ${a ? a.map((x) => f2(x === undefined ? x : x * k, 3)).join(' ') : '—'} ${g ? 'g' : 'm/s²'} · Gyro ${gy ? gy.map((x) => f2(x)).join(' ') : '—'} deg/s${L.temp !== undefined ? ` · ${f2(L.temp)} °C` : ''}${L.seq != null ? ` · SEQ ${L.seq}` : ''}${L.ts != null ? ` · ts ${L.ts}` : ''}` : '';
}
// g 显示：只在绘图时换算（设备与记录始终是 m/s²）
let scaledCache = null;
function scaled(ring) {
  if (!scaledCache || scaledCache.src !== ring) scaledCache = { src: ring, view: { cap: ring.cap, ch: ring.ch } };
  const v = scaledCache.view; v.t = ring.t; v.n = ring.n; v.head = ring.head; v.idx = ring.idx.bind(ring); v.last = ring.last.bind(ring);
  if (!v.v || v.v[0].length !== ring.cap) v.v = ring.v.map(() => new Float32Array(ring.cap));
  for (let c = 0; c < ring.ch; c++) for (let i = 0; i < ring.cap; i++) v.v[c][i] = ring.v[c][i] / G;
  return v;
}
requestAnimationFrame(render);

// ---------- 3D 板卡姿态（AT32 gyro 的 three.js + GLB 渲染器与轴约定；WebGL / 模型不可用时保留地平仪）----------
// 固件 VQF_UpdateEuler：roll=atan2(r21,r22)，pitch=atan2(-r20,√(r00²+r10²))，yaw=atan2(r10,r00)
// 即 ZYX（yaw→pitch→roll）：R = Rz(yaw)·Ry(pitch)·Rx(roll)，机体 → 世界（ENU，Z 向上）；与 AT32 app.js eulerToMatrix 同式
const DEG = Math.PI / 180;
function eulerToMatrix(yawDeg, pitchDeg, rollDeg) {
  const cy = Math.cos(yawDeg * DEG), sy = Math.sin(yawDeg * DEG), cp = Math.cos(pitchDeg * DEG), sp = Math.sin(pitchDeg * DEG), cr = Math.cos(rollDeg * DEG), sr = Math.sin(rollDeg * DEG);
  return [[cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr], [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr], [-sp, cp * sr, cp * cr]];
}
function drawModel(L, stale) {
  if (!pcbView?.ready || router.view !== 'status') return;
  const sig = L ? `${L.yaw},${L.pitch},${L.roll},${stale}` : `-,${stale}`;
  if (!modelDirty && sig === modelSig) return;
  modelDirty = false; modelSig = sig;
  const P = { yaw: L?.yaw || 0, pitch: L?.pitch || 0, roll: L?.roll || 0, t: L?.t };
  pcbView.render(eulerToMatrix(P.yaw, P.pitch, P.roll), stale); window.__ch32.modelPose = P;
}
window.__ch32.eulerToMatrix = eulerToMatrix; window.__ch32.attLabels = ATT_LABELS;
import('./pcb-view.js?v=20261003m1').then(async ({ createPCBView }) => {
  const stage = $('stage');
  const availability = (ok) => { stage.classList.toggle('model-ready', ok); $('modelReset').hidden = !ok; modelDirty = true; };
  pcbView = await createPCBView(stage, () => { modelDirty = true; }, availability);
  availability(true);
  $('modelReset').onclick = () => pcbView.reset();
  window.__ch32.model = pcbView;
}).catch((e) => { window.__ch32.modelError = String(e?.message || e); }); // 回退：地平仪
