/**
 * 时间线主列宽度修正（宽时间线开关）。
 *
 * 三层处理：
 * 1. 开关：`html[data-te-timeline='wide']` 控制 CSS 是否生效，可在油猴菜单里切换并持久化；
 * 2. CSS：把 `div[data-testid="primaryColumn"]` 放宽到 `--te-timeline-width`（见 timeline-width.css）；
 * 3. JS：目标宽度不是写死的 800 —— 右栏显示时需要的横向空间要大得多
 *    （主列 + 30 间距 + 右栏 350 + 右栏 margin-right 70），
 *    这里按视口可用空间动态收敛，并把三栏行 `min-width` 撑开以容纳主列 + 右栏
 *    （X 的父容器 overflow:visible，撑开不会裁剪，也不会产生横向滚动条）。
 *
 * 监听策略（性能版）：
 * - 不再自建轮询定时器 / 全站 MutationObserver。主列 / 右栏的出现与消失走
 *   dom-watch 单例派发的合并批次（滚动时也只有 120ms 一次的节流回调）；
 * - 右栏显隐会改变可用宽度：sidebar 功能切换后会广播 `te:layout`，这里订阅重算；
 * - 自身调整完布局也会广播 `te:layout`，供左右栏锚定逻辑（sidebar）跟随。
 */
import { CONFIG } from '../config';
import { registerToggleMenu } from '../lib/menu';
import { readFlag, writeFlag } from '../lib/store';
import { createWidthUnlocker } from '../lib/unlock-width';
import { onDomChanged, dispatchLayoutEvent } from '../lib/dom-watch';
import './timeline-width.css';

/** 主列选择器 */
const PRIMARY_COLUMN = 'div[data-testid="primaryColumn"]';
const SIDEBAR_COLUMN = 'div[data-testid="sidebarColumn"]';
/** X 原生主列宽度：可用空间不足时退回该值，避免主列被压得比原生还窄 */
const MIN_WIDTH = 600;
/** 视口右侧安全边距 */
const EDGE = 16;
/** X 的窄屏断点：低于该值保持 X 原生布局 */
const BREAKPOINT = 1095;

let wide = CONFIG.timelineWide;
/** 上次实际写入的几何（用于判定是否真的变化，避免无意义地反复广播 te:layout） */
let lastEnabled: boolean | null = null;
let lastTarget = 0;
let lastMinWidth = '';

/** 右栏实际占用的横向空间（宽度 + margin-right + 与主列的间距）；隐藏时为 0 */
function measureSidebarOuter(): number {
  const sb = document.querySelector<HTMLElement>(SIDEBAR_COLUMN);
  // display:none 时 getClientRects 为空，比读 computed display 更可靠
  if (!sb || sb.getClientRects().length === 0) return 0;
  const margin = Number.parseFloat(getComputedStyle(sb).marginRight) || 0;
  return sb.getBoundingClientRect().width + margin + 30;
}

/**
 * 计算并写入主列宽度。
 * 宽度 = clamp(600, min(目标宽, 视口可用宽), 目标宽)，
 * 可用宽 = 视口宽 − 三栏行左边缘 − 安全边距 − 右栏占用。
 */
function applyTimelineLayout(): void {
  const primary = document.querySelector<HTMLElement>(PRIMARY_COLUMN);
  const row = primary?.parentElement ?? null;
  const root = document.documentElement;

  if (!primary || !row) return;

  const enabled = wide && window.innerWidth >= BREAKPOINT;
  const changed = enabled !== lastEnabled;
  if (!enabled) {
    if (changed) {
      root.dataset.teTimeline = 'off';
      row.style.removeProperty('min-width');
      lastEnabled = false;
      lastTarget = 0;
      lastMinWidth = '';
      dispatchLayoutEvent();
    }
    return;
  }
  root.dataset.teTimeline = 'wide';

  const sidebarOuter = measureSidebarOuter();
  const rowLeft = row.getBoundingClientRect().left;
  const available = window.innerWidth - rowLeft - EDGE - sidebarOuter;
  const target = Math.max(MIN_WIDTH, Math.min(CONFIG.timelineWidth, Math.round(available)));
  const minWidth = `${Math.round(target + sidebarOuter)}px`;

  const geometryChanged = changed || target !== lastTarget || minWidth !== lastMinWidth;
  lastEnabled = true;
  lastTarget = target;
  lastMinWidth = minWidth;
  if (!geometryChanged) return;

  root.style.setProperty('--te-timeline-width', `${target}px`);
  // 撑开三栏行，让「主列 + 右栏」放得下（父容器 overflow:visible，不会裁剪）
  row.style.minWidth = minWidth;
  root.dataset.teTimelineWidth = String(target);

  // 布局（尤其行的 min-width）变化会移动主列，通知锚定逻辑重新摆放左右栏
  dispatchLayoutEvent();
}

function toggleWide(): void {
  wide = !wide;
  applyTimelineLayout();
  void writeFlag('timeline-wide', wide);
}

export function enableTimelineWidth(): void {
  // 主列是 React 渲染的，可能晚于脚本注入：订阅共享观察器，出现 / 结构变化时重算。
  // 回调本身很廉价（几次 querySelector + getBoundingClientRect），120ms 节流足够。
  let layoutScheduled = false;
  const scheduleLayout = (): void => {
    if (layoutScheduled) return;
    layoutScheduled = true;
    requestAnimationFrame(() => {
      layoutScheduled = false;
      applyTimelineLayout();
    });
  };

  applyTimelineLayout();
  // 存储读取是异步的，先用默认值渲染，读到用户设置后再覆盖
  void readFlag('timeline-wide').then((stored) => {
    if (stored !== null && stored !== wide) {
      wide = stored;
      applyTimelineLayout();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleLayout, { once: true });
  }
  window.addEventListener('load', scheduleLayout, { once: true });
  window.addEventListener('resize', scheduleLayout);
  // 右栏显示 / 隐藏会改变可用宽度：sidebar 切换后广播 te:layout，这里跟随重算
  document.addEventListener('te:layout', scheduleLayout);

  // 主列可能在任意时刻被 React 挂载 / 替换（SPA 导航），订阅共享 DOM 批次即可。
  // 判断采用「主列 / 右栏的存在性跃迁」：每批（120ms 一次）只做两个 querySelector
  // 的廉价检查，而不是遍历新增节点子树 —— 滚动时插入的普通推文不会触发重算。
  let hadPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
  let hadSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
  onDomChanged(({ overflow: hadOverflow }) => {
    const nowPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
    const nowSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
    const relevant =
      hadOverflow || nowPrimary !== hadPrimary || nowSidebar !== hadSidebar;
    hadPrimary = nowPrimary;
    hadSidebar = nowSidebar;
    if (relevant) scheduleLayout();
  });

  // 解除主列内部被写死宽度的容器（推文、时间线列表等）—— 增量 + 时间片扫描
  createWidthUnlocker(PRIMARY_COLUMN, {
    lockedRange: CONFIG.lockedWidthRange,
  }).start();

  registerToggleMenu({
    label: (enabled) => `宽时间线（${CONFIG.timelineWidth}px）：${enabled ? '开' : '关'}`,
    isEnabled: () => wide,
    toggle: toggleWide,
  });
}
