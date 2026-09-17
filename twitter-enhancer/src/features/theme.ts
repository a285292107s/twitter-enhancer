/**
 * 主题检测：把 X 的 Light / Dim / Dark 三套主题判出来，写在 `html[data-te-theme]` 上。
 *
 * 为什么需要它：CSS 无法按计算样式选择元素（「背景是深色就用浅色边框」这类规则写不出来），
 * 所以由 JS 判定一次、写属性，CSS 用属性分支消费（settings-panel.css、content-column.css、
 * theme.css 的主题分支）。这是本模块唯一的职责 —— 共享令牌在 theme.css 里，
 * 具体组件的观感规则归各自的功能模块。
 *
 * document-start 崩溃修复（性能版）：
 * - 脚本在 document-start 注入时 document.body 为 null，旧版 detectTheme() 直接
 *   读 document.body 会抛错，导致整个功能中断；
 * - 主题检测推迟到首次上色（首帧 + DOMContentLoaded 后各一次），此前用系统偏好
 *   prefers-color-scheme 兜底，避免首帧误判为暗色 / 亮色造成闪烁；
 * - 优先用 html 的 color-scheme 样式（X 会按主题写入），读不到再回退 body 背景；
 * - 只有 html / body 的 style、class、data-theme 变化才需要重算主题 —— 这是一个
 *   只观察两个元素、按属性过滤的窄观察器，不是滚动时的高频 subtree 观察。
 */
import { createFrameQueue } from '../lib/frame-work';
import './theme.css';

type Theme = 'light' | 'dim' | 'dark';

/**
 * 解析 CSS 颜色为 RGB。返回 null 表示「尚未上色」：
 * - 显式 transparent / 透明（alpha=0）—— X 未完成首次上色时 body 背景是
 *   rgba(0,0,0,0)，若按数值 0 判定会误判成 Dark，造成首屏闪烁（真机踩坑）。
 */
function parseRgb(bg: string): [number, number, number] | null {
  if (!bg || bg === 'transparent') return null;
  const parts = bg.match(/[\d.]+/g)?.map(Number);
  if (!parts || parts.length < 3) return null;
  if (parts.length >= 4 && parts[3] === 0) return null; // alpha 0 → 全透明
  return [parts[0], parts[1], parts[2]];
}

/**
 * 依据 body 背景亮度判定主题。
 * X 三套主题的背景：Light #FFFFFF、Dim #15202B、Dark #000000。
 */
function detectTheme(): Theme {
  // 优先读 X 写在 html 上的 color-scheme（跟随主题，最可靠且不依赖 body）
  try {
    const colorScheme = getComputedStyle(document.documentElement).colorScheme;
    if (colorScheme === 'dark') return 'dark';
    if (colorScheme === 'light') return 'light';
  } catch {
    // 极早期读取失败则继续回退
  }

  // body 未就绪时用系统偏好占位，避免首帧误判闪烁
  if (!document.body) {
    return systemPrefersDark() ? 'dark' : 'light';
  }

  const rgb = parseRgb(getComputedStyle(document.body).backgroundColor);
  if (!rgb) {
    // 背景透明时退回系统偏好
    return systemPrefersDark() ? 'dark' : 'light';
  }
  const [r, g, b] = rgb;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luminance > 200) return 'light';
  if (luminance > 24) return 'dim';
  return 'dark';
}

function systemPrefersDark(): boolean {
  try {
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ?? false;
  } catch {
    return false;
  }
}

function applyTheme(): void {
  document.documentElement.dataset.teTheme = detectTheme();
}

export function enableTheme(): void {
  applyTheme();

  // 主题重测合并到下一帧：属性观察器可能在一次导航里连着报好几次，
  // 且读 computed style 会触发样式重算，不能留在观察器回调里同步做。
  const frameQueue = createFrameQueue('theme');
  const scheduleThemeSync = (): void => {
    frameQueue.schedule('theme', applyTheme);
  };

  // 首帧后重测一次（此时 X 已把主题色写到 body），
  // 若与系统偏好占位不同会修正，避免首屏配色错误。
  frameQueue.schedule('theme', applyTheme);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
  }

  // 只观察 html / body 两个元素的 style / class / data-theme 变化（窄观察器），
  // X 切换主题 / SPA 导航时会改写这些属性。不做 subtree 监听，无滚动开销。
  // 用裸 MutationObserver 而不是 lib/observer-scope：那个模块解决的是「观察目标会被 X
  // 整棵替换」——html / body 全程稳定，且本功能没有关闭路径要拆观察器，
  // 它的同名重登记 / disconnectAll 在这里都是死代码。将来若出现挂在会被替换节点上的
  // 观察器，再按那时的需要重建（settings-panel 的抽屉 RO 是现在唯一自己做重绑的地方）。
  const rootObserver = new MutationObserver(scheduleThemeSync);
  rootObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'],
  });
  const startBodyObserve = (): void => {
    if (!document.body) return;
    const bodyObserver = new MutationObserver(scheduleThemeSync);
    bodyObserver.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
  };
  if (document.body) startBodyObserve();
  else document.addEventListener('DOMContentLoaded', startBodyObserve, { once: true });
}
