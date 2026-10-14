// 测试源：SRC=live → 从线上 https://gyroc.233688.xyz 下载 JS 到临时目录后再 import（测线上同一份代码）
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
const here = dirname(fileURLToPath(import.meta.url));
export const BASE = process.env.BASE || 'https://gyroc.233688.xyz';
export async function srcDir() {
  if (process.env.SRC !== 'live') return join(here, '../public');
  const dir = '/tmp/gyroc-live-src'; mkdirSync(dir, { recursive: true });
  for (const f of ['protocol.js', 'ota.js', 'state.js', 'serial.js', 'mock-device.js', 'mock-serial.js']) {
    const r = await fetch(`${BASE}/${f}`, { cache: 'no-store' }); if (!r.ok) throw new Error(`${f} HTTP ${r.status}`);
    writeFileSync(join(dir, f), await r.text());
  }
  return dir;
}
export async function load(name) { return import(pathToFileURL(join(await srcDir(), name)).href); }
let pass = 0, fail = 0;
export function check(name, cond, extra = '') { if (cond) { pass++; console.log(`  ✔ ${name}`); } else { fail++; console.log(`  ✘ ${name} ${extra}`); } }
export function summary(tag) { console.log(`${fail ? 'FAIL' : 'PASS'} ${tag}: ${pass} passed, ${fail} failed (SRC=${process.env.SRC || 'local'})`); if (fail) process.exitCode = 1; return { pass, fail }; }
