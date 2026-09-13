/**
 * 推文 UI 重设计。
 *
 * 三件事：
 * 1. 主题适配：X 有 Light / Dim / Dark 三套主题，CSS 无法按计算样式选择元素，
 *    故由 JS 判定并写入 html[data-te-theme]，CSS 分支消费。
 * 2. 令牌注入：把 config 里的字号 / 行高 / 行长写成 CSS 变量，改 config 即生效。
 * 3. 开关：页内设置面板 + Alt+U 实时对比新旧样式，状态优先存脚本管理器（GM_setValue）。
 *
 * document-start 崩溃修复（性能版）：
 * - 脚本在 document-start 注入时 document.body 为 null，旧版 detectTheme() 直接
 *   读 document.body 会抛错，导致整个 tweet-ui 功能中断；
 * - 主题检测推迟到首次上色（首帧 + DOMContentLoaded 后各一次），此前用系统偏好
 *   prefers-color-scheme 兜底，避免首帧误判为暗色 / 亮色造成闪烁；
 * - 优先用 html 的 color-scheme 样式（X 会按主题写入），读不到再回退 body 背景；
 * - 只有 html / body 的 style、class、data-theme 变化才需要重算主题 —— 这是一个
 *   只观察两个元素、按属性过滤的窄观察器，不是滚动时的高频 subtree 观察。
 */
import { CONFIG } from '../config';
import { registerSetting, notifySettingsChanged } from '../lib/settings';
import { readFlag, writeFlag } from '../lib/store';
import './tweet-ui.css';

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

function applyTokens(): void {
  const root = document.documentElement;
  const { tweetUi } = CONFIG;
  root.style.setProperty('--te-body-size', `${tweetUi.bodyFontSize}px`);
  root.style.setProperty('--te-body-lh', String(tweetUi.bodyLineHeight));
  root.style.setProperty('--te-measure', tweetUi.measure);
}

let enabled = CONFIG.tweetUi.enabledByDefault;

function setEnabled(value: boolean): void {
  enabled = value;
  document.documentElement.dataset.teUi = value ? 'on' : 'off';
}

function toggleTweetUi(): void {
  setEnabled(!enabled);
  void writeFlag('tweet-ui', enabled);
  notifySettingsChanged();
}

export function enableTweetUi(): void {
  applyTokens();
  applyTheme();
  setEnabled(enabled);
  void readFlag('tweet-ui').then((stored) => {
    if (stored !== null && stored !== enabled) setEnabled(stored);
  });

  // 首帧后重测一次主题（此时 X 已把主题色写到 body），
  // 若与系统偏好占位不同会修正，避免首屏配色错误。
  requestAnimationFrame(() => applyTheme());
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
  }

  // 只观察 html / body 两个元素的 style / class / data-theme 变化（窄观察器），
  // X 切换主题 / SPA 导航时会改写这些属性。不做 subtree 监听，无滚动开销。
  let scheduled = false;
  const scheduleThemeSync = (): void => {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      applyTheme();
    });
  };
  const observer = new MutationObserver(scheduleThemeSync);
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'],
  });
  const startBodyObserve = (): void => {
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  };
  if (document.body) startBodyObserve();
  else document.addEventListener('DOMContentLoaded', startBodyObserve, { once: true });

  // Alt+U：实时开关，方便对比前后效果
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyU') return;
    toggleTweetUi();
    event.preventDefault();
  });

  registerSetting({
    id: 'tweet-ui',
    group: '内容',
    label: '推文新样式',
    description: '正文 16px / 行高 1.5，重绘操作栏、引用卡片与媒体圆角',
    shortcut: 'Alt+U',
    isEnabled: () => enabled,
    toggle: toggleTweetUi,
  });
}
