/**
 * 推文 UI 重设计。
 *
 * 三件事：
 * 1. 主题适配：X 有 Light / Dim / Dark 三套主题，CSS 无法按计算样式选择元素，
 *    故由 JS 读 body 背景色判定并写入 html[data-te-theme]，CSS 分支消费。
 * 2. 令牌注入：把 config 里的字号 / 行高 / 行长写成 CSS 变量，改 config 即生效。
 * 3. 开关：油猴菜单 + Alt+U 实时对比新旧样式，状态优先存脚本管理器（GM_setValue）。
 *
 * 具体视觉规则见 tweet-ui.css 与设计文档 design-system/twitter-enhancer/pages/timeline.md。
 */
import { CONFIG } from '../config';
import { registerToggleMenu } from '../lib/menu';
import { readFlag, writeFlag } from '../lib/store';
import './tweet-ui.css';

type Theme = 'light' | 'dim' | 'dark';

/**
 * 依据 body 背景亮度判定主题。
 * X 三套主题的背景：Light #FFFFFF、Dim #15202B、Dark #000000。
 */
function detectTheme(): Theme {
  const bg = getComputedStyle(document.body).backgroundColor;
  const rgb = bg.match(/\d+(\.\d+)?/g)?.map(Number);
  if (!rgb || rgb.length < 3) {
    // 背景透明时退回系统偏好
    return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  }
  const [r, g, b] = rgb;
  const luminance = 0.299 * r + 0.587 * g + 0.114 * b;
  if (luminance > 200) return 'light';
  if (luminance > 24) return 'dim';
  return 'dark';
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
}

export function enableTweetUi(): void {
  applyTokens();
  applyTheme();
  setEnabled(enabled);
  void readFlag('tweet-ui').then((stored) => {
    if (stored !== null && stored !== enabled) setEnabled(stored);
  });

  // X 切换主题 / SPA 导航时会改写 body 与 html 的行内样式，需要跟随重算。
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
  const startObserving = (): void => {
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['style', 'class', 'data-theme'],
    });
    if (document.body) {
      observer.observe(document.body, { attributes: true, attributeFilter: ['style', 'class'] });
    }
  };
  if (document.body) startObserving();
  else document.addEventListener('DOMContentLoaded', startObserving, { once: true });

  // Alt+U：实时开关，方便对比前后效果
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyU') return;
    toggleTweetUi();
    event.preventDefault();
  });

  registerToggleMenu({
    label: (on) => `推文新样式：${on ? '开' : '关'}`,
    isEnabled: () => enabled,
    toggle: toggleTweetUi,
  });
}
