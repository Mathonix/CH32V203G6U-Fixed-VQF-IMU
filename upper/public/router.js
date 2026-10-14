// router.js — hash 路由（参照 AT32 gyro ui-shell.js 的 route()）：#/status #/output #/calib #/diag #/settings
// 只切换 .view 的 hidden 与导航高亮，不触碰协议 / 会话。CH32 OTA（0x40–0x44）未定稿，没有 #/upgrade 页。
export const VIEWS = ['status', 'output', 'calib', 'diag', 'settings'];
export const DEFAULT_VIEW = 'status';
export function parseRoute(hash) {
  const raw = (String(hash || '').match(/^#\/(\w+)/) || [])[1];
  return VIEWS.includes(raw) ? raw : DEFAULT_VIEW;
}
export function initRouter({ onChange } = {}) {
  let current = null;
  function route() {
    const view = parseRoute(location.hash);
    // 未知路由（含 #/upgrade）回退到状态页，并把地址栏改成 #/status，导航高亮与内容一致
    if (location.hash && location.hash !== `#/${view}`) history.replaceState(null, '', `${location.pathname}${location.search}#/${view}`);
    const changed = current !== null && current !== view;
    current = view;
    document.querySelectorAll('.view').forEach((v) => {
      v.hidden = v.dataset.view !== view;
      if (v.hidden) v.classList.remove('view-enter');
      else if (changed) { v.classList.remove('view-enter'); void v.offsetWidth; v.classList.add('view-enter'); }
    });
    document.querySelectorAll('.nav-item[data-nav]').forEach((a) => {
      const on = a.dataset.nav === view; a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page'); else a.removeAttribute('aria-current');
    });
    document.body.dataset.view = view;
    const t = document.querySelector(`.view[data-view="${view}"] .page-h h1`)?.textContent;
    document.title = `${t && view !== DEFAULT_VIEW ? t + ' · ' : ''}CH32 AHRS · UART 上位机`;
    onChange?.(view);
  }
  document.addEventListener('animationend', (e) => { if (e.animationName === 'view-in') e.target.classList.remove('view-enter'); });
  window.addEventListener('hashchange', route);
  route();
  return { route, get view() { return current; } };
}
