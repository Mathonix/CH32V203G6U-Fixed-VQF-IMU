// UI previews use only the explicitly labelled Mock device; no real COM port.
import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const base = process.env.BASE || 'http://127.0.0.1:8765';
const shots = process.env.UI_SHOTS || fileURLToPath(new URL('./ui-20261004/', import.meta.url));
mkdirSync(shots, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
const errors = [], report = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
try {
 for (const [width, height, prefix] of [[1440, 1000, 'desktop'], [390, 844, 'mobile']]) {
  const p = await browser.newPage(); await p.setViewport({ width, height });
  p.on('pageerror', (e) => errors.push(e.message)); p.on('dialog', (d) => d.accept());
  await p.goto(base + '/?mock=1#/status', { waitUntil: 'networkidle0' }); await p.click('#btnConnect');
  await p.waitForFunction(() => window.__ch32.link.state === 'CONNECTED' && document.getElementById('liveBadge').textContent === 'LIVE');
  await sleep(2500);
  for (const view of ['status', 'output', 'calib', 'diag', 'settings']) {
   await p.click(`[data-nav="${view}"]`); await sleep(300);
   if (view === 'calib') {
    await p.click('#btnCalStart'); await p.waitForFunction(() => window.__ch32.session.accCal?.done_mask > 0 && window.__ch32.session.calibrating, { timeout: 7000 }); await sleep(350);
   }
   if (view === 'output') {
    const immediate = await p.evaluate(() => {
     const sel = document.getElementById('selProto');
     sel.value = 'L3'; sel.dispatchEvent(new Event('change', { bubbles: true }));
     const locked = document.getElementById('outFieldset').disabled;
     document.querySelectorAll('[data-bit]').forEach((b) => b.checked = Number(b.dataset.bit) < 3);
     sel.value = '1'; sel.dispatchEvent(new Event('change', { bubbles: true }));
     document.getElementById('btnAll').click();
     return { locked, enabled: !document.getElementById('outFieldset').disabled, checked: document.querySelectorAll('[data-bit]:checked').length };
    });
    assert(immediate.locked && immediate.enabled && immediate.checked === 9, 'fast protocol change must accept immediate Select All');
   }
   const info = await p.evaluate(() => {
    const v = document.querySelector('.view:not([hidden])');
    const visible = (e) => !!e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden';
    const overflow = v.scrollWidth > v.clientWidth + 1 || document.documentElement.scrollWidth > innerWidth;
    const controls = [...v.querySelectorAll('button, select, input')].filter(visible).map((e) => { const target = e.matches('input[type=checkbox]') ? (e.closest('label') || e) : e; const r = target.getBoundingClientRect(); return { id: e.id || e.dataset.filter || e.dataset.tab, w: r.width, h: r.height }; });
    const smallText = [...v.querySelectorAll('span, label, summary, p, h1, h2, button')].filter((e) => visible(e) && !e.classList.contains('sr-only') && e.textContent.trim() && !e.querySelector('span,label,p,h1,h2,button')).filter((e) => parseFloat(getComputedStyle(e).fontSize) < 14).map((e) => e.id || e.textContent);
    return { view: v.dataset.view, overflow, smallText, controls, filterNoteHidden: !visible(document.getElementById('fNote')) || document.getElementById('fNote').classList.contains('sr-only'), packetLineHidden: document.getElementById('plotVals').classList.contains('sr-only') };
   });
   assert.equal(info.overflow, false, `${width} ${view} overflow`); assert.deepEqual(info.smallText, [], `${width} ${view} small text`);
   assert(info.filterNoteHidden && info.packetLineHidden);
   if (width < 600) assert(info.controls.every((c) => c.h >= 38 || !c.id), `${view} touch target`);
   report.push({ width, height, ...info });
   await p.screenshot({ path: `${shots}/${prefix}-${view}.png` });
   if (view === 'calib') { await p.click('#btnCalCancel'); await p.waitForFunction(() => !window.__ch32.session.calibrating); }
  }
  await p.click('#btnDisconnect'); await p.close();
 }
 assert.deepEqual(errors, []);
 writeFileSync(`${shots}/layout-checks.json`, JSON.stringify({ mock: true, pages: report, errors }, null, 2));
 console.log('PASS ui-pages: 10 page/viewport + 2 immediate interaction checks, 0 overflow, 0 visible text below 14px; Mock screenshots');
} finally { await browser.close(); }
