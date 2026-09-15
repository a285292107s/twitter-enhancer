/**
 * 推文 UI 重设计。
 *
 * 三件事：
 * 1. 主题适配：X 有 Light / Dim / Dark 三套主题，CSS 无法按计算样式选择元素，
 *    故由 JS 判定并写入 html[data-te-theme]，CSS 分支消费。
 * 2. 令牌注入：把 config 里的字号 / 行高 / 行长写成 CSS 变量，改 config 即生效；
 *    行长令牌同时决定操作栏用的 px 版心（`--te-spine`），见 publishSpine。
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
import { createToggle } from '../lib/toggle';
import { createObserverScope } from '../lib/observer-scope';
import { createFrameQueue } from '../lib/frame-work';
import { onDomChanged } from '../lib/dom-watch';
import { SEL } from '../lib/selectors';
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

/**
 * 版心的 px 值（`--te-spine`）—— 由**定义 measure 的这一层**测量并发布。
 *
 * 为什么需要它：`--te-measure` 是 `72ch`，而 ch 相对**元素自身字号**解析 ——
 * 同一个 72ch 在正文（`--te-body-size` = 16px）上解析成 764px，在操作栏
 * （继承 X 自己的 15px）上只有 633px。操作栏要跟正文对齐，就必须有一个 px 版心
 * （见 content-column.css 的消费方规则）。
 *
 * 为什么由本模块发布、而不是由消费方反推：这个 px 值只有把 `--te-measure` 真正解析出来
 * 才知道 —— 实测「72 个 0」的宽度（785px）与 72ch 的解析结果（764px）并不相等，
 * 不能靠字体度量反推。既然它属于 measure 令牌，就由写令牌的一方测完发布；
 * 消费方只读 `--te-spine`，既不碰 computed style，也不需要知道另一个功能的开关状态。
 */
let spineResolved = false;

function publishSpine(force = false): void {
  if (spineResolved && !force) return;
  // 本功能关闭时正文上没有我们的 72ch（那时读到的是 X 自己的 max-width），不测量
  if (!uiEnabled) return;
  const sample = document.querySelector<HTMLElement>(SEL.tweetText);
  if (!sample) return;
  const style = getComputedStyle(sample);
  if (!style.maxWidth.endsWith('px')) return;
  const size = Number.parseFloat(style.fontSize);
  const measure = Number.parseFloat(style.maxWidth);
  if (!(size > 0) || !(measure > 0)) return;
  // 样本可能是「短句帖」的正文（按 CONFIG.column.shortFontSize 排版），而 ch 随字号线性
  // 缩放 —— 按样本字号换算回正文字号下的版心
  const px = Math.round((measure / size) * CONFIG.tweetUi.bodyFontSize);
  if (px <= 0) return;
  document.documentElement.style.setProperty('--te-spine', `${px}px`);
  spineResolved = true;
}

/** 推文新样式的当前值 —— 与 createToggle 同步的镜像（理由见 timeline-width.ts 同类注释） */
let uiEnabled = CONFIG.tweetUi.enabledByDefault;

/** 开关生效：写 `html[data-te-ui]`，CSS 里的规则全部挂在它下面 */
function applyEnabled(value: boolean): void {
  uiEnabled = value;
  document.documentElement.dataset.teUi = value ? 'on' : 'off';
  // 令牌刚生效 / 刚失效：重新测一次版心（关闭时保留上一次的值，消费方仍有兜底默认值）
  if (value) publishSpine(true);
}

export function enableTweetUi(): void {
  applyTokens();
  applyTheme();
  // 开关：默认值 / 存储读取 / 写盘 / 面板登记与刷新全部交给 createToggle（见 lib/toggle.ts）
  const uiToggle = createToggle({
    id: 'tweet-ui',
    group: '内容',
    label: '推文新样式',
    description: '正文 16px / 行高 1.5，重绘操作栏、引用卡片与媒体圆角',
    shortcut: 'Alt+U',
    default: CONFIG.tweetUi.enabledByDefault,
    apply: applyEnabled,
  });

  // 版心 px 的测量与主题重测都放到下一个渲染帧（队列见 lib/frame-work.ts）：
  // 前者要读 computed style（会触发样式重算），后者由属性观察器高频触发 ——
  // 两者都不能留在 DOM 批次 / 观察器回调里同步做。
  const frameQueue = createFrameQueue('tweet-ui');

  // 版心的测量时机：正文样本与字体都可能在令牌生效之后才就绪 ——
  // 首屏推文到达、字体加载完成、以及 load。三者都会让 72ch 的解析结果变化。
  onDomChanged(() => {
    if (!spineResolved) frameQueue.schedule('spine', () => publishSpine());
  });
  window.addEventListener('load', () => publishSpine(true), { once: true });
  try {
    void document.fonts?.ready?.then(() => publishSpine(true));
  } catch {
    // 极早期没有 document.fonts 时忽略：CSS 侧有 --te-spine 的兜底默认值
  }

  // 首帧后重测一次主题（此时 X 已把主题色写到 body），
  // 若与系统偏好占位不同会修正，避免首屏配色错误。
  frameQueue.schedule('theme', applyTheme);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', applyTheme, { once: true });
  }

  // 只观察 html / body 两个元素的 style / class / data-theme 变化（窄观察器），
  // X 切换主题 / SPA 导航时会改写这些属性。不做 subtree 监听，无滚动开销。
  // 走作用域：body 可能在 documentElement 之后才出现，且 X 换主题时观察目标不变 ——
  // 同名重登记保证「晚到的 body」与「已存在的 html」各自只有一个观察器。
  const scope = createObserverScope('tweet-ui');
  /** 主题重测合并到下一帧：属性观察器可能在一次导航里连着报好几次 */
  const scheduleThemeSync = (): void => {
    frameQueue.schedule('theme', applyTheme);
  };
  const themeMutations = {
    attributes: true,
    attributeFilter: ['style', 'class', 'data-theme', 'data-color-scheme'],
  };
  scope.observe(document.documentElement, 'theme-root', scheduleThemeSync, themeMutations);
  const startBodyObserve = (): void => {
    if (document.body) {
      scope.observe(document.body, 'theme-body', scheduleThemeSync, {
        attributes: true,
        attributeFilter: ['style', 'class'],
      });
    }
  };
  if (document.body) startBodyObserve();
  else document.addEventListener('DOMContentLoaded', startBodyObserve, { once: true });

  // Alt+U：实时开关，方便对比前后效果
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyU') return;
    uiToggle.toggle();
    event.preventDefault();
  });
}
