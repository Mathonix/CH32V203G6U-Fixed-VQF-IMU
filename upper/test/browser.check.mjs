// browser.check.mjs — 无头 Chrome 访问线上 gyroc，注入 Mock Web Serial（/mock-serial.js → 模拟固件 20261003m）。Mock，不是实板验收。
// BASE=https://gyroc.233688.xyz SHOTS=/workspace/gyroc/shots node test/browser.check.mjs
import puppeteer from 'puppeteer-core';
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
const BASE = process.env.BASE || 'http://127.0.0.1:8765', SHOTS = resolve(process.env.SHOTS || fileURLToPath(new URL('./shots/', import.meta.url))), DL = resolve(process.env.DL || fileURLToPath(new URL('./downloads/', import.meta.url)));
mkdirSync(SHOTS, { recursive: true }); mkdirSync(DL, { recursive: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let pass = 0, fail = 0; const errors = [], modelCancellations = [];
const check = (n, c, x = '') => { if (c) { pass++; console.log(`  ✔ ${n}`); } else { fail++; console.log(`  ✘ ${n} ${x}`); } };
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
// Keep browser-level download settings on a browser session, independent of test-page closure.
const downloadCdp = await browser.target().createCDPSession();
async function open(vw, vh, query = '') {
  const page = await browser.newPage(); await page.setViewport({ width: vw, height: vh });
  const closePage = page.close.bind(page); page.close = async (...args) => { page._testClosing = true; return closePage(...args); }; // Closing intentionally aborts any outstanding model fetch.
  if (!query) await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'serial', { configurable: true, value: {
      requestPort: async () => { const m = await import('/mock-serial.js'); window.__testPort = window.__testPort || m.createMockPort(); return window.__testPort; },
      getPorts: async () => [], addEventListener() {} } });
  });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console.error: ' + m.text()); });
  page.on('requestfailed', (r) => {
    if (page._testClosing) return;
    const message = 'requestfailed: ' + r.url() + ' ' + r.failure()?.errorText + ' (page=' + page.url() + ', initial=' + query + ')';
    // Chrome can signal cancellation even after the GLB has loaded. Verify the same page
    // actually renders the complete model before classifying this as a completed fetch.
    if (r.failure()?.errorText === 'net::ERR_ABORTED' && new URL(r.url()).pathname === '/models/ch32.glb') modelCancellations.push({ page, message });
    else errors.push(message);
  });
  page.dialogs = []; page.acceptDialogs = true;
  page.on('dialog', async (d) => { page.dialogs.push(d.message()); if (page.acceptDialogs) await d.accept(); else await d.dismiss(); });
  page.allowDownloads = () => downloadCdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: DL }); await page.allowDownloads();
  const res = await page.goto(BASE + '/' + query, { waitUntil: 'networkidle0' });
  page.waitFor = async (fn, what, t = 6000, arg) => { const t0 = Date.now(); for (;;) { const v = await page.evaluate(fn, arg); if (v) return v; if (Date.now() - t0 > t) throw new Error('timeout: ' + what); await sleep(50); } };
  page.txt = (id) => page.$eval('#' + id, (e) => e.textContent);
  // 多页面（hash 路由）：点击 / 选择前先切到元素所在的页面（与用户点导航一致：改 location.hash）
  page.goView = async (view) => { await page.evaluate((v) => { if (location.hash !== '#/' + v) location.hash = '#/' + v; }, view); await page.waitFor((v) => !document.querySelector(`.view[data-view="${v}"]`).hidden, 'view ' + view, 3000, view); };
  page.viewOf = (sel) => page.$eval(sel, (e) => e.closest('.view')?.dataset.view || null);
  const rawClick = page.click.bind(page), rawSelect = page.select.bind(page);
  // 次要控件收在 <details>（「更多选项 ›」「设备当前配置 ›」…）里：点击前像用户一样展开
  const openDetails = (sel) => page.$eval(sel, (e) => { for (let d = e.closest('details'); d; d = d.parentElement.closest('details')) if (e !== d.querySelector('summary')) d.open = true; });
  page.click = async (sel, ...a) => { const v = await page.viewOf(sel); if (v) await page.goView(v); await openDetails(sel); return rawClick(sel, ...a); };
  page.select = async (sel, ...a) => { const v = await page.viewOf(sel); if (v) await page.goView(v); await openDetails(sel); return rawSelect(sel, ...a); };
  page.setHz = (hz) => page.$eval('#inpHz', (e, v) => { e.value = String(v); e.dispatchEvent(new Event('input', { bubbles: true })); }, hz);
  page.setBits = (n) => page.evaluate((k) => { document.querySelectorAll('[data-bit]').forEach((e) => { e.checked = Number(e.dataset.bit) < k; }); }, n);
  page.apply = async () => { await page.click('#btnApply'); };
  page.dev = (expr) => page.evaluate(`(() => { const d = window.__testPort.device; return ${expr}; })()`);
  page.waitMsg = (id, re, what) => page.waitFor(([i, r]) => new RegExp(r).test(document.getElementById(i).textContent) && !/…$/.test(document.getElementById(i).textContent), what || id, 6000, [id, re]).then(() => sleep(120));
  return { page, status: res.status() };
}
async function download(page, btn, re) { const before = new Set(readdirSync(DL)); await page.click(btn); const deadline = Date.now() + 15000; while (Date.now() < deadline) { await sleep(100); const f = readdirSync(DL).find((x) => !before.has(x) && re.test(x) && !x.endsWith('.crdownload')); if (f) { const text = readFileSync(`${DL}/${f}`, 'utf8'); if (text.length && !readdirSync(DL).includes(f + '.crdownload')) return text; } } return null; }

const { page, status } = await open(1440, 900);
check('线上页面 200，标题 CH32 AHRS', status === 200 && (await page.title()).includes('CH32 AHRS'));
const body0 = await page.evaluate(() => document.body.innerText);
check('无「协议为暂定版」徽标 / #provisional', !(await page.$('#provisional')) && !/暂定/.test(body0));
check('链路显示 UART 2,000,000 8N1', (await page.txt('baud')).includes('2,000,000'));
const btnTexts = await page.$$eval('button,select option,a', (els) => els.map((e) => e.textContent).join('|'));
check('无陀螺校准 / USB / 固件升级 / Bootloader 入口；有六面校准卡片（连接前禁用）', !/陀螺校准|USB|Bootloader|DFU/i.test(btnTexts) && /开始校准/.test(btnTexts) && (await page.$eval('#btnCalStart', (b) => b.disabled)) && (await page.$$('[data-face]')).length === 6);
check('“固件未实现”列表列出 USB、陀螺校准、四元数，不再列六面校准', /USB/.test(await page.txt('unsupported')) && /陀螺运行时校准/.test(await page.txt('unsupported')) && !/六面/.test(await page.txt('unsupported')) && /四元数/.test(await page.txt('unsupported')));
check('连接前 OFFLINE，命令按钮禁用', (await page.txt('liveBadge')) === 'OFFLINE' && (await page.$eval('#btnApply', (b) => b.disabled)) && (await page.$eval('#inpHz', (b) => b.disabled)) && (await page.$eval('#btnReset', (b) => b.disabled)));
await page.screenshot({ path: `${SHOTS}/gyroc-1440x900-offline.png` });
// ---- 路由：5 个页面，每页单独显示；无升级页 ----
const VIEWS = ['status', 'output', 'calib', 'diag', 'settings'];
const PAGE_CARDS = { status: ['roll', 'horizon', 'btnZeroYaw', 'plot', 'rxRate', 'hzPair', 'streamMode'], output: ['selProto', 'maskBits', 'outPersist', 'inpHz', 'btnApply', 'outMask'], calib: ['calCard', 'calFaces', 'btnCalStart', 'calValid'], diag: ['diag', 'btnReset', 'btnRaw', 'btnDrift', 'events', 'unsupported'], settings: ['filterBtns', 'fPair', 'dCaps', 'fw', 'portInfo', 'baud'] };
const routeInfo = () => page.evaluate(() => ({ hash: location.hash, shown: [...document.querySelectorAll('.view')].filter((v) => !v.hidden).map((v) => v.dataset.view), active: [...document.querySelectorAll('.nav-item.active')].map((a) => a.dataset.nav), cur: document.querySelector('[aria-current=page]')?.dataset.nav, body: document.body.dataset.view }));
{ const r = await routeInfo(); check('默认路由（无 hash）→ 状态页，仅一个页面可见', r.shown.join() === 'status' && r.active.join() === 'status' && r.cur === 'status' && r.body === 'status', JSON.stringify(r)); }
check('导航 5 项：状态 / 输出 / 校准 / 诊断 / 设置，无升级（#/upgrade）', (await page.$$eval('.nav-item[data-nav]', (as) => as.map((a) => `${a.dataset.nav}:${a.getAttribute('href')}:${a.textContent.trim()}`).join())) === 'status:#/status:状态,output:#/output:输出,calib:#/calib:校准,diag:#/diag:诊断,settings:#/settings:设置' && !(await page.$('[data-view="upgrade"],[href="#/upgrade"]')));
check('页面共 5 个 .view，每个有标题', (await page.$$eval('.view', (vs) => vs.map((v) => v.dataset.view + ':' + !!v.querySelector('.page-h h1')).join())) === VIEWS.map((v) => v + ':true').join());
for (const v of VIEWS) {
  await page.click(`.nav-item[data-nav="${v}"]`); await sleep(350);
  const r = await routeInfo();
  const vis = await page.evaluate((ids) => ids.map((id) => { const e = document.getElementById(id), b = (e.closest('.card') || e).getBoundingClientRect(); return [id, b.width > 0 && b.height > 0 && !e.closest('[hidden]')]; }), PAGE_CARDS[v]);
  const others = await page.evaluate((ids) => ids.filter((id) => document.getElementById(id).getBoundingClientRect().width > 0), Object.entries(PAGE_CARDS).filter(([k]) => k !== v).flatMap(([, ids]) => ids));
  const ov = await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.view:not([hidden])')].every((x) => x.scrollWidth <= x.clientWidth + 1));
  check(`点击导航「${v}」→ #/${v}，只显示该页；本页卡片可见、其它页卡片不渲染；无横向溢出`, r.hash === '#/' + v && r.shown.join() === v && r.active.join() === v && r.cur === v && vis.every(([, ok]) => ok) && others.length === 0 && ov, JSON.stringify({ r, vis: vis.filter(([, ok]) => !ok), others }));
  await page.screenshot({ path: `${SHOTS}/gyroc-1440x900-page-${v}.png` });
}
{ const codes = await page.evaluate(() => [...document.querySelectorAll('.view button, .view h1, .view h2, .view .page-h .chip, .view dt, .view .stat>span, .view label>span, .view .card-h .chip, .nav-item')].map((e) => e.textContent.trim()).filter((t) => /0x[0-9a-f]{2}|（.*0x|persist=|\d{2}\s*→/i.test(t)));
  const longNotes = await page.evaluate(() => [...document.querySelectorAll('.view .aux, .view p, .view .note')].map((e) => e.textContent.trim()).filter((t) => t.length > 40));
  check('精简排版：标题 / 按钮 / 标签不含协议命令码，无长说明（详情在 title 提示）', codes.length === 0 && longNotes.length === 0 && /0x15/.test(await page.$eval('#btnReset', (b) => b.title)) && /0x11/.test(await page.$eval('#btnZeroYaw', (b) => b.title)), JSON.stringify({ codes, longNotes })); }
await page.evaluate(() => { location.hash = '#/upgrade'; }); await sleep(300);
{ const r = await routeInfo(); check('未知路由 #/upgrade → 回退状态页（地址改为 #/status）', r.hash === '#/status' && r.shown.join() === 'status' && r.active.join() === 'status', JSON.stringify(r)); }
await page.evaluate(() => { location.hash = '#/nope'; }); await sleep(300);
check('未知路由 #/nope → 状态页', (await routeInfo()).shown.join() === 'status');
await page.click('.nav-item[data-nav="calib"]'); await sleep(300);
check('导航 → 校准页（状态页不再放快捷入口）', (await routeInfo()).shown.join() === 'calib');
await page.goBack(); await sleep(300);
check('浏览器后退 → 回到状态页（hashchange）', (await routeInfo()).shown.join() === 'status');
{ const { page: pd } = await open(1440, 900, '#/settings'); await sleep(200); const r = await pd.evaluate(() => ({ shown: [...document.querySelectorAll('.view')].filter((v) => !v.hidden).map((v) => v.dataset.view).join(), t: document.title }));
  check('直接打开 /#/settings → 设置页（深链接），标题含 CH32 AHRS', r.shown === 'settings' && /CH32 AHRS/.test(r.t), JSON.stringify(r)); await pd.close(); await page.allowDownloads(); } // 关闭第二个页面的 CDP 会话会重置浏览器级下载设置
await page.goView('status');

await page.click('#btnConnect');
await page.waitFor(() => document.getElementById('connState').textContent === 'CONNECTED' && document.getElementById('liveBadge').textContent === 'LIVE', 'CONNECTED');
check('握手后 CONNECTED / LIVE，顶栏连接点 on，状态页数据「实时」', (await page.txt('connState')) === 'CONNECTED' && (await page.$eval('#connChip', (e) => e.dataset.state)) === 'on' && (await page.txt('sData')) === '实时');
check('串口 2,000,000 8N1、无流控', await page.evaluate(() => { const o = window.__testPort.openOptions; return o.baudRate === 2000000 && o.dataBits === 8 && o.stopBits === 1 && o.parity === 'none' && o.flowControl === 'none'; }));
check('未切换 DTR/RTS（setSignals 未调用）', (await page.evaluate(() => window.__testPort.signals.length)) === 0);
check('串口显示 1A86:8010 WCH-Link（Mock）', /1A86:8010 WCH-Link/.test(await page.txt('portInfo')));
check('固件 20261003m 带 Mock 标记', (await page.txt('fw')).startsWith('20261003m') && !!(await page.$('#fw .badge.mock')));
check('握手只查询：10,23,1F,26,14,24（bit7 → 查询校准状态）；Flash 写入 0；未发 vofa / 1D / 1C', (await page.dev('d.rxCommands.slice(0,6).join()')) === '16,35,31,38,20,36' && !(await page.dev('d.rxCommands.includes(0x1c)')) && (await page.dev('d.flashWrites')) === 0 && !(await page.dev('d.vofaCount')) && !(await page.dev('d.rxCommands.includes(0x1d)')));
await sleep(1500);
check('连接后无 USB/CAN/高级/校准命令轮询（仅 0x14）', await page.dev('d.rxCommands.slice(6).every((c) => c === 0x14)'));
check('当前输出 Custom · 9 字段，频率 200 / 200 Hz（当前 / 已保存）', (await page.txt('streamMode')) === 'Custom · 9 字段' && (await page.txt('hzPair')) === '200 / 200 Hz');
const rate = parseFloat(await page.txt('rxRate')); check('实收率（PC 时钟）≈200 帧/s', rate > 185 && rate < 215, rate);
check('温度来自 0x05（°C），能力 0xC4（含六面校准 bit7）', /°C$/.test(await page.txt('dTemp')) && /^0xc4 自选输出、输出频率持久化、六面校准/.test(await page.txt('dCaps')));
check('六面校准卡片：空闲、可开始、取消禁用、flash_valid 0', /空闲/.test(await page.txt('calState')) && !(await page.$eval('#btnCalStart', (b) => b.disabled)) && (await page.$eval('#btnCalCancel', (b) => b.disabled)) && /^0/.test(await page.txt('calValid')));
check('CAN 控制器说明“总线未验证”，量程只读', /总线未验证/.test(await page.txt('dCan')) && /不可修改/.test(await page.txt('dRange')));
check('滤波 当前/已保存 均衡 / 均衡，4 档', (await page.txt('fPair')) === '均衡 / 均衡' && /4 档/.test(await page.txt('fEst')));
const r1 = await page.txt('roll'); await sleep(300); check('Roll/Pitch/Yaw 实时更新', r1 !== (await page.txt('roll')) && /^-?\d+\.\d\d$/.test(await page.txt('yaw')));
const diagTxt = await page.txt('diag'); check('链路统计含 实收率/CRC/SEQ 缺失/超时/重试/失败 ACK/数据状态', ['实收率', 'CRC 错误', 'SEQ 缺失', '超时', '重试', '失败 ACK', '意外 ACK', '数据实时'].every((k) => diagTxt.includes(k.replace('数据实时', '数据'))) && diagTxt.includes('实时'));
await page.click('[data-tab="accel"]'); await sleep(200);
check('Accel m/s²（Az≈9.x）', /Accel .* m\/s²/.test(await page.txt('plotVals')));
await page.select('#selAccUnit', 'g'); await sleep(200);
const az = parseFloat((await page.txt('plotVals')).split(' ')[3]); check('切换 g：除以 9.80665（Az≈1）', /g ·/.test(await page.txt('plotVals')) && az > 0.8 && az < 1.05, az);
await page.select('#selAccUnit', 'ms2'); await page.click('[data-tab="attitude"]');
{ const o = await page.evaluate(() => { const ids = [...document.querySelectorAll('.ypr-item')].map((e) => [e.querySelector('span').textContent, e.querySelector('strong').id]);
    const r = window.__ch32.state.plots.attitude, i = r.idx(r.n - 1), L = window.__ch32.session.last, pl = [...document.querySelectorAll('.ypr-item strong')].map((e) => e.getBoundingClientRect().left);
    return { ids, labels: window.__ch32.attLabels, ring: [0, 1, 2].map((c) => r.v[c][i]), last: [L.yaw, L.pitch, L.roll], lr: pl[0] < pl[1] && pl[1] < pl[2] }; });
  check('状态页大数字顺序 Yaw / Pitch / Roll（DOM 与视觉从左到右）', JSON.stringify(o.ids) === JSON.stringify([['Yaw', 'yaw'], ['Pitch', 'pitch'], ['Roll', 'roll']]) && o.lr, JSON.stringify(o.ids));
  check('姿态曲线图例与通道顺序 Yaw / Pitch / Roll（通道 0/1/2 = yaw/pitch/roll）', /^Yaw/.test(o.labels[0]) && o.labels[1] === 'Pitch' && o.labels[2] === 'Roll' && o.ring.every((v, k) => Math.abs(v - o.last[k]) < 1e-3), JSON.stringify(o)); }
await page.screenshot({ path: `${SHOTS}/gyroc-1440x900-live.png` });

// 滤波：17 → 27 → 18
await page.click('[data-filter="2"]'); await page.waitMsg('filterMsg', '成功|失败');
check('滤波 稳定（RAM）：当前/已保存 = 稳定 / 均衡，17→27→18', (await page.txt('fPair')) === '稳定 / 均衡' && (await page.dev('d.rxCommands.filter((c) => c !== 0x14).slice(-3).join()')) === '23,39,24' && !(await page.dev('d.settings')));
await page.click('#filterPersist'); page.acceptDialogs = true;
await page.click('[data-filter="0"]'); await page.waitMsg('filterMsg', '成功|失败');
check('滤波 响应 persist=1：确认框 + 响应 / 响应', page.dialogs.at(-1).includes('Flash') && (await page.txt('fPair')) === '响应 / 响应' && (await page.dev('d.flashWrites')) === 1);
await page.click('#filterPersist');
// ---- 输出页：单卡「应用」 ----
check('输出页：协议下拉 Custom / JustFloat / 旧预设；主区 6 个字段（Yaw…Az），Gx/Gy/Gz 在「更多选项 ›」；状态 已读取；草稿 = 设备当前值',
  (await page.$$eval('#selProto option', (o) => o.map((x) => x.textContent).join('|'))).startsWith('Custom|JustFloat|旧预设 0') && (await page.$$eval('#maskBits > label', (l) => l.map((x) => x.textContent.trim()).join())) === 'Yaw,Pitch,Roll,Ax,Ay,Az' && (await page.$$eval('#maskMore label', (l) => l.map((x) => x.textContent.trim()).join())) === 'Gx,Gy,Gz' && (await page.txt('outState')) === '已读取' && (await page.$eval('#inpHz', (e) => e.value)) === '200' && (await page.$eval('#selProto', (e) => e.value)) === '1');
// 记录调用：「应用」只能调用与原独立按钮相同的会话方法与参数
await page.evaluate(() => { const s = window.__ch32.session; window.__calls = []; for (const k of ['setOutputConfig', 'setLegacyPreset', 'saveOutputHz']) { const f = s[k].bind(s); s[k] = (...a) => { window.__calls.push([k, JSON.stringify(a)]); return f(...a); }; } });
const calls = () => page.evaluate(() => window.__calls.splice(0).map((c) => c.join(' ')).join(' | '));
{ const n = await page.dev('d.rxCommands.length'); await page.apply(); await sleep(300); const t = await page.txt('outMsg');
  check('应用（无改动）：不发送 0x20 / 0x1D，提示没有改动', /没有改动/.test(t) && (await page.dev(`d.rxCommands.slice(${n}).filter((c) => c !== 0x14).length`)) === 0 && (await calls()) === '', t); }
// 频率：只在应用且频率改动时写 Flash（0x1D 总是保存，需确认）
page.acceptDialogs = false; await page.setHz(100); const n0 = await page.dev('d.rxCommands.length'); await sleep(100);
check('改动后状态 chip「未应用」', (await page.txt('outState')) === '未应用');
await page.apply(); await sleep(300);
check('取消保存确认：不发送 0x1D', !(await page.dev(`d.rxCommands.slice(${n0}).includes(0x1d)`)) && (await page.txt('hzPair')) === '200 / 200 Hz' && (await calls()) === '');
page.acceptDialogs = true; await page.setHz(100); await page.apply(); await page.waitMsg('outMsg', '成功|失败');
check('保存 100 Hz（写 Flash）：100 / 100 Hz，只调用 saveOutputHz(100)', (await page.txt('hzPair')) === '100 / 100 Hz' && (await page.dev('d.flashWrites')) === 2 && (await calls()) === 'saveOutputHz [100]' && /Flash/.test(page.dialogs.at(-1)) && (await page.txt('outState')) === '已读取');
await sleep(400);
check('Flash 写入期间 SEQ 跳号标为正常（统计 + 事件），非 Flash 缺失 0', await page.evaluate(() => { const t = window.__ch32.session.telemetry; return t.flashGaps >= 1 && t.expectedMissing > 0 && t.unexpectedMissing === 0; }) && /正常/.test(await page.txt('diag')) && /Flash 写入期间跳号.*正常/.test(await page.txt('events')));
await page.setHz(123); await page.apply(); await sleep(200);
check('不支持的频率（123 Hz）：本地拒绝，不发送', /不支持 123 Hz/.test(await page.txt('outMsg')) && (await calls()) === '');
await page.evaluate(() => { window.__testPort.device.failFlash = true; });
await page.setHz(50); await page.apply(); await page.waitMsg('outMsg', '成功|失败');
const om = await page.txt('outMsg');
check('Flash 失败 ACK（3 / 0x0607）显示失败，不显示成功，回读仍 100 / 100', /失败/.test(om) && /0x0607/.test(om) && !/成功/.test(om) && (await page.txt('hzPair')) === '100 / 100 Hz', om);
await page.evaluate(() => { window.__testPort.device.failFlash = false; }); await calls(); await page.setHz(100);
// 暂停 / 查询仍可用（暂停在「设备当前配置 ›」里）
await page.click('#btnPause'); await page.waitMsg('outMsg', '成功|失败'); await sleep(600);
check('暂停遥测（mask=0）：PAUSED，过期提示为“已暂停”，输出页 chip 已暂停', (await page.txt('liveBadge')) === 'PAUSED' && /已暂停/.test(await page.txt('staleBadge')) && /0x000/.test(await page.txt('outMask')) && (await page.txt('outState')) === '已暂停');
await page.click('#btnRequery'); await page.waitMsg('actMsg', '成功|失败');
check('mask=0 时查询仍可用（23/1F/26/14 成功）', /成功/.test(await page.txt('actMsg')));
await page.click('#btnPause'); await page.waitMsg('outMsg', '成功|失败'); await page.waitFor(() => document.getElementById('liveBadge').textContent === 'LIVE', 'resume');
check('恢复遥测：Custom 0x1FF', /0x1ff/.test(await page.txt('outMask'))); await calls();
// 协议 + 输出内容 → 应用（等价于原 所选字段 Custom / JustFloat / 旧预设 / Custom 9 字段）
await page.setBits(3); await page.apply(); await page.waitMsg('outMsg', '成功|失败'); await sleep(300);
check('Custom + Yaw Pitch Roll → setOutputConfig({format:1,mask:7,persist:0})：mask 0x007', /0x007/.test(await page.txt('outMask')) && (await page.txt('outFields')) === 'yaw pitch roll' && (await page.txt('liveBadge')) === 'LIVE' && (await calls()) === 'setOutputConfig [{"format":1,"mask":7,"persist":0}]');
await page.select('#selProto', '0'); await page.apply(); await page.waitMsg('outMsg', '成功|失败'); await sleep(400);
const jf1 = await page.evaluate(() => window.__ch32.session.parser.stats.jfFrames);
check('JustFloat 3 通道（RAM）：LIVE、JF 帧计数增长、无 CRC 错误；setOutputConfig({format:0,mask:7,persist:0})', (await page.txt('streamMode')) === 'JustFloat · 3 字段' && jf1 > 10 && (await page.txt('liveBadge')) === 'LIVE' && (await page.evaluate(() => window.__ch32.session.parser.stats.crcErrors)) === 0 && (await calls()) === 'setOutputConfig [{"format":0,"mask":7,"persist":0}]');
await page.select('#selProto', 'L3'); await sleep(100);
check('选择旧预设：字段区禁用（由 enum 决定）', await page.$eval('#outFieldset', (f) => f.disabled));
await page.apply(); await page.waitMsg('outMsg', '成功|失败'); await sleep(300);
check('旧预设 3（0x03 IMU + 温度）：只调用 setLegacyPreset(3)（0x13，RAM）', /^Legacy 3/.test(await page.txt('streamMode')) && (await page.txt('liveBadge')) === 'LIVE' && (await calls()) === 'setLegacyPreset [3]' && (await page.$eval('#selProto', (e) => e.value)) === 'L3');
await page.select('#selProto', '1'); await page.click('#btnAll'); await page.apply(); await page.waitMsg('outMsg', '成功|失败');
await page.click('#btnVofa'); await page.waitMsg('outMsg', '成功|失败'); await sleep(300);
check('显式 vofa：JustFloat 9 字段（RAM），不写 Flash', (await page.txt('streamMode')) === 'JustFloat · 9 字段' && (await page.dev('d.flashWrites')) === 2, JSON.stringify({ mode: await page.txt('streamMode'), writes: await page.dev('d.flashWrites'), msg: await page.txt('outMsg') }));
await calls(); await page.click('#btnRaw'); await sleep(100);
await page.select('#selProto', '1'); await page.click('#btnAll'); await page.apply(); await page.waitMsg('outMsg', '成功|失败'); await sleep(200);
await page.click('#btnRaw');
{ const tx = await page.evaluate(() => window.__ch32.state.raw.lines.filter((l) => l.includes('\ttx\t')).join('\n'));
  check('Custom + 全选（RAM）= 原「Custom 9 字段」：线上帧 cmd 20 + 00 01 FF 01 00', (await page.txt('streamMode')) === 'Custom · 9 字段' && (await page.dev('d.saved.format')) === 1 && (await calls()) === 'setOutputConfig [{"format":1,"mask":511,"persist":0}]' && /\taa5520[0-9a-f]{4}0001ff0100/.test(tx), tx.slice(0, 300)); }
page.acceptDialogs = false; await page.click('#outPersist'); await page.apply(); await sleep(300);
check('断电保存 + 应用（无其它改动）：弹 Flash 确认（取消则不发送）', /Custom 九字段（Flash）[\s\S]*Flash/.test(page.dialogs.at(-1)) && (await calls()) === '');
await page.click('#outPersist'); page.acceptDialogs = true;
await page.click('#btnNone'); await page.apply(); await sleep(200);
check('清空后应用：本地拒绝（至少选择一个字段），不发送', /至少选择一个字段/.test(await page.txt('outMsg')) && (await calls()) === '');
await page.click('#btnAll');
// 归零
await page.click('#btnZeroYaw'); await page.waitMsg('actMsg', '成功|失败');
check('Yaw 归零（0x11）→ 相对零点；结果卡片不在本页 → toast 提示', !(await page.$eval('#relZero', (e) => e.hidden)) && (await page.evaluate(() => [...document.querySelectorAll('#toasts .toast')].some((t) => /Yaw 归零：成功/.test(t.textContent)))));
// 原始帧 / CSV / 诊断
await page.click('#btnRaw'); await sleep(200); await page.click('#btnZeroYaw'); await sleep(300); await page.click('#btnRaw');
const raw = await download(page, '#btnRawSave', /^ch32-raw-.*\.tsv$/);
check('原始帧记录导出：含 rx aa55 47 字节帧与 tx 命令', raw && /\trx\taa55\taa5506/.test(raw) && /\ttx\taa55\taa5511/.test(raw), raw?.slice(0, 200));
await page.click('#btnRec'); await sleep(500);
const csv = await download(page, '#btnRec', /^ch32-\d.*\.csv$/);
check('CSV 记录（m/s² 列）', csv && csv.startsWith('pc_ms,seq,dev_ts_ms,yaw_deg') && csv.includes('ax_ms2') && csv.trim().split('\n').length > 50);
const diag = await download(page, '#btnDiag', /^ch32-diag-.*\.json$/);
const dj = diag && JSON.parse(diag);
check('诊断 JSON：mock 标记、固件、统计（CRC/超时/重试/缺失）', dj && dj.mock === false && dj.firmware.text === '20261003m' && dj.stats.parser.crcErrors === 0 && 'retries' in dj.stats.commands && 'missing' in dj.stats.telemetry);
// 数据过期
await page.evaluate(() => { window.__testPort.device.sensorOk = false; }); await sleep(800);
check('遥测停止 → STALE / 数据过期，数值变灰', (await page.txt('liveBadge')) === 'STALE' && /数据过期/.test(await page.txt('staleBadge')) && (await page.$eval('#roll', (e) => e.style.opacity)) === '0.45');
await page.evaluate(() => { window.__testPort.device.sensorOk = true; }); await page.waitFor(() => document.getElementById('liveBadge').textContent === 'LIVE', 'live again');
// 复位
const resets0 = await page.evaluate(() => window.__ch32.session.telemetry.baselineResets);
await page.click('#btnReset'); await page.waitMsg('actMsg', '成功|失败');
check('复位（确认框）：ACK → 重启 → 重新握手，回读已保存 100 / 100 Hz Custom', page.dialogs.at(-1).includes('复位') && (await page.dev('d.resets')) === 1 && (await page.txt('hzPair')) === '100 / 100 Hz' && (await page.txt('streamMode')) === 'Custom · 9 字段' && (await page.dev('d.rxCommands.filter((c) => c === 0x15).length')) === 1);
await sleep(500);
check('复位后统计基线重建、非 Flash 缺失 0；按 PING 恢复（重启耗时随机）', (await page.evaluate(() => window.__ch32.session.telemetry.baselineResets)) > resets0 && (await page.evaluate(() => window.__ch32.session.telemetry.unexpectedMissing)) === 0 && (await page.evaluate(() => window.__ch32.session.cmdStats.rebootPings)) >= 1 && /复位 \/ 重启 PING1 \/ \d+ · \d+ ms/.test(await page.txt('diag')));
// 恢复 200 Hz（Mock 设备默认值）
await page.setHz(200); await page.apply(); await page.waitMsg('outMsg', '成功|失败');
await page.screenshot({ path: `${SHOTS}/gyroc-1440x900-after.png` });
// 六面校准（Mock 时序加速）
await page.evaluate(() => { const d = window.__testPort.device; d.calTiming = { ...d.calTiming, place: 300, settle: 200, sample: 500, save: 200 }; });
const fw0 = await page.dev('d.flashWrites'), rx0 = await page.dev('d.rxCommands.length');
await page.click('#btnCalStart'); await page.waitMsg('calMsg', '成功|失败');
check('开始六面校准（确认框）：17 → 1C，进行中', page.dialogs.at(-1).includes('六面') && (await page.dev(`d.rxCommands.slice(${rx0}).filter((c) => c !== 0x14).slice(0, 2).join()`)) === '23,28' && /进行中/.test(await page.txt('calState')));
await page.waitFor(() => document.querySelector('.calface.cur'), 'cur face');
check('校准中锁定：复位 / 保存频率 / persist / 滤波按钮；取消可用；卡片标注锁定', await page.evaluate(() => ['btnReset', 'inpHz', 'outPersist', 'filterPersist'].every((id) => document.getElementById(id).disabled) && [...document.querySelectorAll('[data-filter]')].every((b) => b.disabled) && !document.getElementById('btnCalCancel').disabled && document.getElementById('calCard').classList.contains('locked') && /锁定/.test(document.getElementById('btnReset').title)));
const rsErr = await page.evaluate(() => window.__ch32.session.reset().then(() => 'sent', (e) => e.kind));
const sfErr = await page.evaluate(() => window.__ch32.session.setFilter(1, 0).then(() => 'sent', (e) => e.kind));
check('其他 0x15 路径（直接调用 session.reset）与滤波（含 0x18）同样被拦截，未发送', rsErr === 'CalibrationActive' && sfErr === 'CalibrationActive' && (await page.dev('d.rxCommands.filter((c) => c === 0x15).length')) === 1 && (await page.dev('d.calRunning')));
await page.waitFor(() => /[1-9] \/ 6 面/.test(document.getElementById('calAllPct').textContent), 'face done', 8000);
check('面块 / 阶段 / 进度 / 剩余时间 / 原始加速度（g）显示', await page.evaluate(() => document.querySelectorAll('.calface.done').length >= 1 && /\d+(\.\d)? s$/.test(document.getElementById('calFace').textContent) && /%/.test(document.getElementById('calFacePct').textContent) && document.getElementById('calRaw').textContent.split(' ').length === 3) && (await page.txt('calPhase')) !== '—');
await page.screenshot({ path: `${SHOTS}/gyroc-1440x900-cal.png` });
await page.waitFor(() => !document.getElementById('calResult').hidden, 'cal final', 15000); await sleep(300);
check('完成：最终 ACK → 自动 18；6 面全部完成；Flash 中已保存值 flash_valid 1', /完成/.test(await page.txt('calResult')) && (await page.$eval('#calResult', (e) => e.className)).includes('ok') && (await page.$$('.calface.done')).length === 6 && /^1/.test(await page.txt('calValid')) && (await page.txt('calBias')) !== '0.0000 0.0000 0.0000' && !(await page.dev('d.settings')) && (await page.dev('d.flashWrites')) === fw0 + 1);
{ const gs = await page.evaluate(() => { const t = window.__ch32.session.telemetry, r = window.__ch32.session.calRun; return { u: t.unexpectedMissing, e: t.expectedMissing, ten: t.tentativeMissing, hold: !!t.calHold, dec: !!t.calDecide, fw: t.flashWindow, dec2: r?.gapDecision, from: r?.gapFrom, m3: r?.mask3fTelAt, gaps: t.gapLog.slice(-4), dropped: window.__testPort.device.calSaveDropped, inj: window.__testPort.device.injectedLoss }; });
  check('校准跳号：最终 ACK 追溯裁决，成功 → SAVING 丢帧标为正常、非 Flash 缺失 0、暂挂已提交', gs.u === 0 && (!gs.fw || gs.fw.until < gs.m3) && !gs.hold && !gs.dec && gs.ten === 0 && gs.dec2 === 'normal' && gs.dropped > 0, JSON.stringify(gs)); }
check('完成后解锁复位 / 保存', !(await page.$eval('#btnReset', (b) => b.disabled)) && !(await page.$eval('#inpHz', (b) => b.disabled)) && !(await page.$eval('#btnApply', (b) => b.disabled)) && !(await page.$eval('#outPersist', (b) => b.disabled)));
await page.click('#btnCalStart'); await page.waitMsg('calMsg', '成功|失败'); await sleep(500);
await page.click('#btnCalCancel'); await page.waitFor(() => !document.getElementById('calResult').hidden, 'cancel final', 6000); await sleep(200);
check('取消（0x25）：最终 0x0608 显示为“已取消”（警告色，不是错误），已退出设置模式', /已取消/.test(await page.txt('calResult')) && (await page.$eval('#calResult', (e) => e.className)).includes('warn') && /已取消（非错误）/.test(await page.txt('calErr')) && !/失败/.test(await page.txt('calMsg')) && !(await page.dev('d.settings')));
await page.evaluate(() => { window.__testPort.device.calScenario = 'fitFail'; });
await page.click('#btnCalStart'); await page.waitMsg('calMsg', '成功|失败'); await page.waitFor(() => !document.getElementById('calResult').hidden, 'fail final', 15000); await sleep(200);
check('失败（0x0606）：显示错误码文本，Flash 原值不变，已发 18', /0x0606 拟合结果超出范围/.test(await page.txt('calResult')) && (await page.$eval('#calResult', (e) => e.className)).includes('err') && /^1/.test(await page.txt('calValid')) && !(await page.dev('d.settings')));
await page.evaluate(() => { window.__testPort.device.calScenario = 'ok'; });
const ce = await page.evaluate(() => window.__ch32.session.cmdStats); check('校准推送 / 最终 ACK 不计意外 ACK 或迟到应答', ce.unexpectedAcks === 0 && ce.lateReplies === 0);
// 断开 / 重连
await page.click('#btnDisconnect'); await page.waitFor(() => document.getElementById('liveBadge').textContent === 'OFFLINE', 'offline');
check('断开 → OFFLINE / DISCONNECTED', (await page.txt('connState')) === 'DISCONNECTED');
await page.click('#btnConnect'); await page.waitFor(() => document.getElementById('liveBadge').textContent === 'LIVE', 'reconnect');
await sleep(500);
check('重连：新会话、统计基线重建、非 Flash 缺失 0、连接无 Flash 写入', (await page.evaluate(() => window.__ch32.session.telemetry.unexpectedMissing)) === 0 && (await page.dev('d.flashWrites')) === 4);
await page.evaluate(() => window.__testPort.unplug()); await page.waitFor(() => document.getElementById('connState').textContent === 'DISCONNECTED', 'unplug');
check('拔线 → DISCONNECTED + 事件', /串口断开/.test(await page.txt('events')));
// 1366 截图
const { page: p2 } = await open(1366, 768); await p2.click('#btnConnect'); await p2.waitFor(() => document.getElementById('liveBadge').textContent === 'LIVE', 'LIVE 1366'); await sleep(800);
await p2.screenshot({ path: `${SHOTS}/gyroc-1366x768-live.png` });
for (const v of VIEWS) { await p2.goView(v); await sleep(300); const ov = await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth && [...document.querySelectorAll('.view:not([hidden])')].every((x) => x.scrollWidth <= x.clientWidth + 1));
  check(`1366×768 ${v} 页：渲染、无横向溢出`, ov && (await p2.evaluate((x) => document.querySelector(`.view[data-view="${x}"]`).getBoundingClientRect().height > 100, v))); await p2.screenshot({ path: `${SHOTS}/gyroc-1366x768-page-${v}.png` }); }
await p2.goView('status'); await sleep(300);
check('回到状态页后曲线重新绘制（canvas 有尺寸）', await p2.evaluate(() => { const c = document.getElementById('plot'); return c.clientWidth > 100 && c.clientHeight > 100 && c.width >= c.clientWidth; }));
await p2.evaluate(() => { const d = window.__testPort.device; d.calTiming = { ...d.calTiming, place: 300, settle: 200, sample: 600 }; });
await p2.click('#btnCalStart'); await p2.waitMsg('calMsg', '成功|失败'); await p2.waitFor(() => document.querySelectorAll('.calface.done').length >= 2, '1366 cal', 10000);
await p2.evaluate(() => document.getElementById('calCard').scrollIntoView({ block: 'center' })); await sleep(200);
await p2.screenshot({ path: `${SHOTS}/gyroc-1366x768-cal.png` });
await p2.click('#btnCalCancel'); await p2.waitFor(() => !document.getElementById('calResult').hidden, '1366 cancel', 6000);
const ov = await p2.evaluate(() => document.documentElement.scrollWidth <= innerWidth); check('1366×768 无横向溢出', ov);
// ?mock=1
const { page: p3, status: s3 } = await open(1440, 900, '?mock=1'); await p3.click('#btnConnect'); await p3.waitFor(() => document.getElementById('liveBadge').textContent === 'LIVE', 'LIVE mock=1');
check('?mock=1：Mock 说明 + LIVE', s3 === 200 && /Mock 设备模式/.test(await p3.txt('mockNote')));
// ---------- 3D 板卡预览（three.js + GLB，替换地平仪；WebGL 不可用回退地平仪）----------
{ await p3.goView('status'); await p3.waitFor(() => !!window.__ch32.model?.ready, '3D 模型就绪', 10000); await sleep(400);
  const m = await p3.evaluate(() => { const st = window.__ch32.model.state(), stg = document.getElementById('stage'), cv = document.getElementById('pcbModel');
    return { st, cls: stg.className, inStatus: stg.closest('.view')?.dataset.view, hzHidden: getComputedStyle(stg.querySelector('.horizon')).display === 'none',
      cv: cv && { w: cv.width, h: cv.height, cw: cv.clientWidth, ch: cv.clientHeight }, reset: !document.getElementById('modelReset').hidden }; });
  check('状态页：3D 板卡模型就绪，地平仪隐藏，复位按钮可见', m.inStatus === 'status' && /model-ready/.test(m.cls) && m.hzHidden && m.reset && m.cv && m.cv.cw > 200 && m.cv.ch > 150 && m.cv.w >= m.cv.cw, JSON.stringify(m.cv));
  check('GLB 元数据：CH32 STEP 源 sha、14116 三角形、151 个零件，实际绘制三角形 > 1 万', m.st.sourceSha256 === '9d9fc508e8a164326d4bd24d9d819ee9884162d03e28ef59cdf108c9bd993954' && m.st.triangles === 14116 && m.st.componentMeshes === 151 && m.st.renderedTriangles > 10000, JSON.stringify({ t: m.st.triangles, r: m.st.renderedTriangles }));
  const C = m.st.cadToBody, det = C[0][0] * (C[1][1] * C[2][2] - C[1][2] * C[2][1]) - C[0][1] * (C[1][0] * C[2][2] - C[1][2] * C[2][0]) + C[0][2] * (C[1][0] * C[2][1] - C[1][1] * C[2][0]);
  const im = m.st.imu, d = [0, 1, 2].map((i) => im.pin1Mm[i] - im.centerMm[i]), body = C.map((r) => r[0] * d[0] + r[1] * d[1] + r[2] * d[2]);
  check('CAD→机体为真旋转（det=+1），LSM6DSV Pin1 落在芯片 (−X,+Y) 角（datasheet 顶视图）', Math.abs(det - 1) < 1e-9 && body[0] < 0 && body[1] > 0, JSON.stringify({ det, body }));
  const w = m.st.cadWorldMatrix, rz = [[w[0], w[4], w[8]], [w[1], w[5], w[9]], [w[2], w[6], w[10]]];
  check('模型节点世界矩阵 = 板矩阵 · CAD→机体', (() => { const B = m.st.matrix, R = [[B[0], B[4], B[8]], [B[1], B[5], B[9]], [B[2], B[6], B[10]]];
    for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) { const v = R[i][0] * C[0][j] + R[i][1] * C[1][j] + R[i][2] * C[2][j]; if (Math.abs(v - rz[i][j]) > 1e-5) return false; } return true; })());
  // 板矩阵 = ZYX(yaw,pitch,roll)：取最近一次绘制所用的遥测样本精确比较，且该样本就是会话最新样本附近（≤ 0.3 s）
  const fit = await p3.evaluate(() => { const P = window.__ch32.modelPose, L = window.__ch32.session.last, B = window.__ch32.model.state().matrix, R = window.__ch32.eulerToMatrix(P.yaw, P.pitch, P.roll);
    let e = 0; for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++) e = Math.max(e, Math.abs(B[j * 4 + i] - R[i][j])); return { e, P, L: [L.roll, L.pitch, L.yaw], dt: L.t - P.t, moving: Math.abs(P.yaw) > 0.01 }; });
  check('板矩阵跟随遥测：R = Rz(yaw)·Ry(pitch)·Rx(roll)，样本为最新帧', fit.e < 1e-5 && fit.dt >= 0 && fit.dt < 300 && fit.moving, JSON.stringify(fit));
  const R90 = await p3.evaluate(() => window.__ch32.eulerToMatrix(0, 0, 90));
  check('Roll +90°：机体 +Y 转到世界 +Z（右手系绕 X）', Math.abs(R90[2][1] - 1) < 1e-9 && Math.abs(R90[1][2] + 1) < 1e-9);
  const cam0 = (await p3.evaluate(() => window.__ch32.model.state().camera)).join();
  const box = await (await p3.$('#pcbModel')).boundingBox(); await p3.mouse.move(box.x + box.width / 2, box.y + box.height / 2); await p3.mouse.down(); await p3.mouse.move(box.x + box.width / 2 + 60, box.y + box.height / 2 + 10, { steps: 5 }); await p3.mouse.up(); await sleep(100);
  const cam1 = (await p3.evaluate(() => window.__ch32.model.state().camera)).join();
  await p3.click('#modelReset'); await sleep(100); const cam2 = (await p3.evaluate(() => window.__ch32.model.state().camera)).join();
  check('拖动改变视角，「复位」恢复默认视角', cam1 !== cam0 && cam2 === cam0);
  const glb = await fetch(BASE + '/models/ch32.glb'); const gb = new Uint8Array(await glb.arrayBuffer());
  check('GLB 资产 200、glTF 2.0 头、< 1.5 MB', glb.status === 200 && gb[0] === 0x67 && gb[1] === 0x6c && gb[2] === 0x54 && gb[3] === 0x46 && gb.length < 1.5e6, String(gb.length));
}
{ // WebGL 不可用 → 回退地平仪，页面其它功能照常（该页的 three.js 报错不计入总错误）
  const pg = await browser.newPage(); await pg.setViewport({ width: 1440, height: 900 });
  await pg.evaluateOnNewDocument(() => { const g = HTMLCanvasElement.prototype.getContext; HTMLCanvasElement.prototype.getContext = function (t, ...a) { return /webgl/i.test(t) ? null : g.call(this, t, ...a); }; });
  const pe = []; pg.on('pageerror', (e) => pe.push(e.message));
  await pg.goto(BASE + '/?mock=1#/status', { waitUntil: 'networkidle0' });
  for (let i = 0; i < 50 && !(await pg.evaluate(() => !!window.__ch32.modelError)); i++) await sleep(100);
  await pg.evaluate(() => document.getElementById('btnConnect').click()); await sleep(1200);
  const f = await pg.evaluate(() => { const stg = document.getElementById('stage'), hz = stg.querySelector('.horizon'), r = hz.getBoundingClientRect();
    return { err: window.__ch32.modelError, ready: /model-ready/.test(stg.className), canvas: !!document.getElementById('pcbModel'), hz: r.width > 200 && r.height > 150 && getComputedStyle(hz).display !== 'none', reset: document.getElementById('modelReset').hidden, sky: document.getElementById('horizon').style.transform, live: document.getElementById('liveBadge').textContent }; });
  check('WebGL 不可用：回退地平仪（无模型画布、复位按钮隐藏），地平仪随姿态转动，LIVE 照常', !!f.err && !f.ready && !f.canvas && f.hz && f.reset && /rotate\(/.test(f.sky) && f.live === 'LIVE' && pe.length === 0, JSON.stringify({ ...f, pe }));
  await pg.close();
}
const hz = await (await fetch(BASE + '/healthz')).json();
check('healthz ok，protocol ch32-uart-aa55-v3（固件版本不写死），provisional false', hz.ok && hz.protocol === 'ch32-uart-aa55-v3' && /20261003h/.test(hz.source) && !/20261003[cd]/.test(hz.protocol) && hz.provisional === false);
for (const { page: sourcePage, message } of modelCancellations) {
  const complete = !sourcePage.isClosed() && await sourcePage.evaluate(() => {
    const model = window.__ch32?.model;
    return !!model?.ready && !window.__ch32.modelError && model.state().triangles === 14116 && model.state().renderedTriangles > 10000;
  });
  if (!complete) errors.push(message);
}
if (modelCancellations.length) console.log('  模型请求取消事件：' + modelCancellations.length + '（逐页验证完整模型及实际绘制；未完成则失败）');
check('无 console / page / 资源加载错误', errors.length === 0, errors.join(' | '));
await browser.close();
console.log(`${fail ? 'FAIL' : 'PASS'} browser.check: ${pass} passed, ${fail} failed (BASE=${BASE}, Mock serial)`);
if (fail) process.exitCode = 1;
