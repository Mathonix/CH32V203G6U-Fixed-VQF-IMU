import puppeteer from 'puppeteer-core';
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const base = process.env.BASE || 'http://127.0.0.1:8765';
const out = fileURLToPath(new URL('./mobile-20261004/', import.meta.url)); mkdirSync(out, { recursive: true });
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe', headless: true, args: ['--no-sandbox'] });
const report = [], errors = [], views = ['status', 'output', 'calib', 'diag', 'settings'];
try {
 const p = await browser.newPage();
 p.on('pageerror', e => errors.push(e.message));
 await p.setViewport({width:390,height:844,isMobile:true,hasTouch:true,deviceScaleFactor:2});
 await p.goto(base + '/?mock=1', {waitUntil:'networkidle0'}); await p.click('#btnConnect');
 await p.waitForFunction(() => window.__ch32.link.state === 'CONNECTED' && window.__ch32.model?.ready);
 // Same page rotates/resizes without reconnecting, including a collapsed browser viewport.
 for (const [width,height] of [[320,568],[360,640],[390,844],[430,932],[844,390],[390,600]]) {
  await p.setViewport({width,height,isMobile:true,hasTouch:true,deviceScaleFactor:2});
  for (const view of views) {
   await p.click(`[data-nav="${view}"]`);
   await p.waitForFunction(v => !document.querySelector(`.view[data-view="${v}"]`).hidden, {}, view);
   for (const expanded of [false,true]) {
    const state = await p.evaluate(({expanded,width}) => {
     const v=document.querySelector('.view:not([hidden])');
     v.querySelectorAll('details').forEach(d=>d.open=expanded);
     const visible=e=>!!e.getClientRects().length && getComputedStyle(e).visibility!=='hidden';
     const controls=[...v.querySelectorAll('button,select,input,summary'),...document.querySelectorAll('.nav-item,.topbar button')].filter(visible).map(e=>{
      const t=e.matches('input[type=checkbox]')?(e.closest('label')||e):e;const r=t.getBoundingClientRect();
      return {id:e.id||e.dataset.nav||e.dataset.filter||e.tagName,w:r.width,h:r.height};
     });
     v.scrollTop=v.scrollHeight;
     const r=v.getBoundingClientRect(),nav=document.querySelector('.nav').getBoundingClientRect();
     const navVisible=[...document.querySelectorAll('.nav-item')].every(e=>{const b=e.getBoundingClientRect();return b.top>=0&&b.bottom<=innerHeight+1});
     return {overflow:document.documentElement.scrollWidth>innerWidth||v.scrollWidth>v.clientWidth+1,
      detailsOverflow:[...v.querySelectorAll('details[open]')].some(e=>e.scrollWidth>e.clientWidth+1),
      controls,navVisible,bottomClear:width>640||r.bottom<=nav.top+1,viewportFits:Math.abs(document.querySelector('.app').getBoundingClientRect().height-innerHeight)<2};
    },{expanded,width});
    assert(!state.overflow && !state.detailsOverflow, `${width}x${height} ${view} overflow expanded=${expanded}`);
    assert(state.navVisible && state.bottomClear && state.viewportFits, `${width}x${height} ${view} navigation/viewport`);
    assert(state.controls.every(c=>c.h>=43.5 && c.w>=43.5), `${width} ${view} touch targets: ${JSON.stringify(state.controls.filter(c=>c.h<43.5||c.w<43.5))}`);
    report.push({width,height,view,expanded,...state});
   }
   await p.evaluate(()=>{const v=document.querySelector('.view:not([hidden])');v.querySelectorAll('details').forEach(d=>d.open=false);v.scrollTop=0;});
   if(width===390&&height===844) { await new Promise(resolve=>setTimeout(resolve,250)); await p.screenshot({path:`${out}/phone-${view}.png`,fullPage:false}); }
  }
 }
 // Long signed angles must fit even on the smallest supported screen.
 await p.setViewport({width:320,height:568,isMobile:true,hasTouch:true,deviceScaleFactor:2});
 await p.click('[data-nav=status]');
 const fit=await p.evaluate(()=>{
  const saved=[];document.querySelectorAll('.ypr-item strong').forEach(e=>{saved.push([e,e.textContent]);e.textContent='-180.00'});
  const result=[...document.querySelectorAll('.ypr-item strong')].every(e=>{const range=document.createRange();range.selectNodeContents(e);const text=range.getBoundingClientRect();const cell=e.parentElement.getBoundingClientRect();return text.right<=cell.right+1&&text.left>=cell.left-1});
  for(const [e,t] of saved)e.textContent=t;return result;
 });assert(fit,'320px signed angle values fit');assert.deepEqual(errors,[]);
 writeFileSync(`${out}/checks.json`,JSON.stringify({mock:true,pages:report,signedAnglesFit:fit,errors},null,2));
 console.log(`PASS mobile-layout: ${report.length} page/size/detail checks + signed angle check; 44px touch targets, portrait/landscape, no overflow (Chrome touch emulation, Mock)`);
} finally {await browser.close()}
