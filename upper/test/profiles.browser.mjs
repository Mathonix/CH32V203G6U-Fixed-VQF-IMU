import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const base = process.env.BASE || 'http://127.0.0.1:8765';
const shots = new URL('./shots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'); mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
let pass = 0; const errors = [];
async function check(name, fn) { await fn(); pass++; console.log('  ✔ ' + name); }
async function open(opts = {}, width = 1440) {
 const p = await browser.newPage(); await p.setViewport({ width, height: 900 });
 p.on('pageerror', (e) => errors.push(e.message)); p.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
 p.dialogs = []; p.accept = true; p.on('dialog', async (d) => { p.dialogs.push(d.message()); p.accept ? await d.accept() : await d.dismiss(); });
 await p.evaluateOnNewDocument((opts) => Object.defineProperty(navigator, 'serial', { configurable: true, value: { requestPort: async () => { const { createMockPort } = await import('/mock-serial.js'); return window.__port = createMockPort(opts); }, getPorts: async () => [], addEventListener() {} } }), opts);
 await p.goto(base + '/#/settings', { waitUntil: 'networkidle0' }); await p.click('#btnConnect'); await p.waitForFunction(() => window.__ch32.link.state === 'CONNECTED' && document.getElementById('fCore').textContent !== '—');
 p.txt = (id) => p.$eval('#' + id, (e) => e.textContent);
 p.idle = () => p.waitForFunction(() => !document.querySelector('[data-filter="1"]').disabled);
 return p;
}
try {
 const p = await open();
 await check('h Mock：四档显示，tauAcc/软件LPF/静止零偏参数准确', async () => { assert.equal(await p.$$eval('[data-filter]:not([hidden])', (b) => b.length), 4); assert.match(await p.txt('fCore'), /2.50 s.*80 Hz.*0.02/); assert.match(await p.txt('otaCap'), /31232/); });
 for (const [id, tau, lpf] of [[0, '1.00', 120], [1, '2.50', 80], [2, '5.00', 40], [3, '2.50', 80]]) await check(`h Mock：UI切换档位${id}，当前/已保存和参数回读`, async () => { await p.click(`[data-filter="${id}"]`); await p.waitForFunction((id) => window.__ch32.session.filter.active_profile === id, {}, id); await p.idle(); await p.waitForFunction((name) => document.getElementById('fPair').textContent.startsWith(name + ' /'), {}, ['响应', '均衡', '稳定', 'ZARU'][id]); assert.match(await p.txt('fCore'), new RegExp(tau + ' s.*' + lpf + ' Hz')); assert.equal(await p.evaluate(() => window.__port.device.flashWrites), 0); assert.match(await p.txt('fPair'), / \/ 均衡$/); });
 await check('ZARU显示固定阈值/运动退出说明，保存取消不发命令', async () => { assert.match(await p.txt('fNote'), /UART.*固定/); await p.click('#filterPersist'); p.accept = false; const n = await p.evaluate(() => window.__port.device.rxCommands.length); await p.click('[data-filter="3"]'); assert.match(p.dialogs.at(-1), /降级/); assert.equal(await p.evaluate(() => window.__port.device.flashWrites), 0); assert.equal(await p.evaluate((n) => window.__port.device.rxCommands.slice(n).filter((c) => c !== 0x14).length, n), 0); p.accept = true; await p.click('#filterPersist'); });
 await p.screenshot({ path: shots + '/profiles-h-desktop.png', fullPage: true });
 await check('升级UI：真实h app.bin可校验，确认取消无OTA命令', async () => { await p.$eval('#otaCard', (e) => e.open = true); const input = await p.$('#otaFile'); await input.uploadFile(process.env.APP_IMAGE || fileURLToPath(new URL('../../firmware/obj/ahrs_real/CH32_AHRS_app.bin', import.meta.url))); await p.waitForFunction(() => !document.getElementById('btnOta').disabled); assert.match(await p.txt('otaMsg'), /20261003h.*31088 B/); p.accept = false; await p.click('#btnOta'); assert.equal(await p.evaluate(() => window.__port.device.otaCommits || 0), 0); p.accept = true; });
 await check('升级UI：上传/版本确认/重新握手，升级后解锁', async () => { await p.click('#btnOta'); await p.waitForFunction(() => /UART 升级：成功/.test(document.getElementById('otaMsg').textContent), { timeout: 20000 }); assert.equal(await p.evaluate(() => window.__port.device.otaCommits), 1); assert.equal(await p.evaluate(() => window.__ch32.link.state), 'CONNECTED'); await p.waitForFunction(() => document.getElementById('fw').textContent.includes('20261003h')); assert.match(await p.txt('fw'), /20261003h/); assert.equal(await p.evaluate(() => window.__port.device.saved.filter), 1); });
 await p.screenshot({ path: shots + '/ota-h-desktop.png', fullPage: true }); await p.close();
 for (const fw of ['20261003e', '20261003g', 'unknown']) { const old = await open({ fwText: fw }); await check(`${fw}：兼容档位数量及参数语义`, async () => { const visible = await old.$$eval('[data-filter]:not([hidden])', (b) => b.length); assert.equal(visible, fw === '20261003e' ? 3 : 4); assert.match(await old.txt('fCore'), fw === 'unknown' ? /原始参数/ : /旧固件/); if (fw === 'unknown') assert.match(await old.txt('otaCap'), /未声明/); }); await old.screenshot({ path: shots + '/profiles-' + fw + '.png', fullPage: true }); await old.close(); }
 const mobile = await open({}, 390); await check('390px窄屏四档/参数/OTA无横向溢出', async () => { assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); await mobile.$eval('#otaCard', (e) => e.open = true); assert(await mobile.evaluate(() => document.documentElement.scrollWidth <= innerWidth)); }); await mobile.screenshot({ path: shots + '/profiles-mobile.png', fullPage: true }); await mobile.close();
 await check('浏览器无脚本/资源错误', () => assert.deepEqual(errors, []));
 console.log(`PASS profiles.browser: ${pass} passed, 0 failed (Mock serial; no hardware writes)`);
} finally { await browser.close(); }
