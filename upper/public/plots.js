// plots.js — Canvas 自绘曲线：读 ring buffer，按像素列做 min/max 抽样（不画全部 10,000 点）
export const AXIS_COLORS = ['#e5484d', '#30a46c', '#3e63dd'];
export function drawPlot(canvas, ring, { windowMs = 10000, labels = ['X', 'Y', 'Z'], unit = '', colors = AXIS_COLORS, stale = false } = {}) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (!w || !h) return;
  if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr); }
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  const padL = 62, padR = 12, padT = 32, padB = 28, pw = w - padL - padR, ph = h - padT - padB;
  ctx.font = '14px ui-monospace, Menlo, Consolas, monospace'; ctx.textBaseline = 'middle';
  if (!ring.n) { ctx.fillStyle = '#8a94a6'; ctx.textAlign = 'center'; ctx.fillText('无数据', w / 2, h / 2); return; }
  const tEnd = ring.t[ring.last()], tStart = tEnd - windowMs;
  // 找窗口起点（二分）
  let lo = 0, hi = ring.n - 1;
  while (lo < hi) { const m = (lo + hi) >> 1; if (ring.t[ring.idx(m)] < tStart) lo = m + 1; else hi = m; }
  const cols = Math.max(1, Math.floor(pw));
  const mins = ring.v.map(() => new Float32Array(cols).fill(Infinity)), maxs = ring.v.map(() => new Float32Array(cols).fill(-Infinity));
  let ymin = Infinity, ymax = -Infinity;
  for (let k = lo; k < ring.n; k++) {
    const i = ring.idx(k); const x = Math.min(cols - 1, Math.floor((ring.t[i] - tStart) / windowMs * cols));
    if (x < 0) continue;
    for (let c = 0; c < ring.ch; c++) { const v = ring.v[c][i]; if (v < mins[c][x]) mins[c][x] = v; if (v > maxs[c][x]) maxs[c][x] = v; if (v < ymin) ymin = v; if (v > ymax) ymax = v; }
  }
  if (!Number.isFinite(ymin)) { ymin = -1; ymax = 1; }
  if (ymax - ymin < 1e-3) { ymin -= 0.5; ymax += 0.5; }
  const span = ymax - ymin; ymin -= span * 0.08; ymax += span * 0.08;
  const Y = (v) => padT + (1 - (v - ymin) / (ymax - ymin)) * ph;
  ctx.strokeStyle = '#e6e9ef'; ctx.lineWidth = 1; ctx.fillStyle = '#6b7385'; ctx.textAlign = 'right';
  for (let g = 0; g <= 4; g++) { const v = ymin + (ymax - ymin) * g / 4, y = Y(v); ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(w - padR, y); ctx.stroke(); ctx.fillText(v.toFixed(Math.abs(ymax - ymin) < 2 ? 3 : 1), padL - 4, y); }
  ctx.textAlign = 'left'; ctx.fillText(`-${(windowMs / 1000).toFixed(0)} s`, padL, h - 12); ctx.textAlign = 'right'; ctx.fillText(`0 s ${unit}`, w - padR, h - 12);
  for (let c = 0; c < ring.ch; c++) {
    ctx.strokeStyle = colors[c]; ctx.lineWidth = 1.8; ctx.beginPath(); let started = false;
    for (let x = 0; x < cols; x++) {
      if (mins[c][x] === Infinity) continue;
      const px = padL + x; if (!started) { ctx.moveTo(px, Y(mins[c][x])); started = true; } else ctx.lineTo(px, Y(mins[c][x]));
      if (maxs[c][x] !== mins[c][x]) ctx.lineTo(px, Y(maxs[c][x]));
    }
    ctx.stroke();
  }
  ctx.textAlign = 'left';
  let lx = 8; labels.forEach((l, c) => { const t = `● ${l}`; ctx.fillStyle = colors[c]; ctx.fillText(t, lx, 14); lx += Math.max(72, ctx.measureText(t).width + 16); }); // 图例按文字宽度排布，长标签不重叠
  if (stale) { ctx.fillStyle = '#b54708'; ctx.textAlign = 'right'; ctx.fillText('非实时（最后一屏）', w - padR, 14); }
}
