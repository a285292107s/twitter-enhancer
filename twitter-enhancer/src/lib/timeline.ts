/**
 * 时间线包装层解析：新旧结构兼容 + 占位层兼容（做法取自社区标准实现
 * control-panel-for-twitter 的 `observeTimeline` / `observeIndividualTweetTimeline`）。
 *
 * ## 为什么需要单独一层
 *
 * 「时间线」在 X 的 DOM 里不是一个稳定节点，而是**会被整层替换**的滚动容器：
 *
 * ```
 * div[data-testid="primaryColumn"]
 *   └ section
 *       ├ h1            ← 页面标题（"主页" / "帖子"）
 *       └ div[aria-label]   ← 滚动容器
 *           └ div           ← 真正承载 cellInnerDiv / article 的那一层（本模块的 root）
 * ```
 *
 * 两种替换时机（参考项目为它们分别写了等待逻辑）：
 * 1. **占位层**：X 先把滚动层挂成一个空壳（没有内联 `style`、内部没有时间线单元），
 *    内容到达后再整层换成真实时间线。此刻任何「对时间线做整树扫描」的功能都会扫到空 ——
 *    参考项目的判据是 `$timeline.hasAttribute('style')`，本模块再加上「内部有没有
 *    cellInnerDiv」一起判（只按 style 判会在 X 改成用 class 写几何时误判）；
 * 2. **标签页切换**：推荐 / 关注、个人主页各 tab 之间切换时旧层被换掉，
 *    功能绑定在旧层上的状态（标记、观察器）随之失效。
 *
 * ## 与参考项目的一处刻意不同
 *
 * 参考项目为时间线单独挂 MutationObserver；本项目**不新建观察器**，而是消费已有的
 * dom-watch 单例批次 + `te:route`（见 docs/architecture.md 不变量「各功能只订阅事件、
 * 不自己 new MutationObserver」）—— X 的虚拟滚动让节点高频增删，观察器一多就是重复派发。
 * 只有「等占位层变成真实层」这一件事用 `waitFor` + `stopIf` 表达：
 * 页面切走就放弃，不会把上一个页面的等待拖到新页面里。
 */

import { SEL } from './selectors';
import { onDomChanged } from './dom-watch';
import { onRouteChanged } from './spa-route';
import { currentPagePath, pagePathChanged } from './page';
import { waitFor } from './wait-for';

/** 新结构（X 现行）：section > h1 + div[aria-label] > div */
const TIMELINE_NEW = `${SEL.primaryColumn} section > h1 + div[aria-label] > div`;
/**
 * 旧结构：没有 section / h1 包装时（含移动端与旧版桌面），滚动层是 primaryColumn 里
 * 第一个带 aria-label 的 div 的内层。回退链的存在本身就是「新旧包装层兼容」。
 */
const TIMELINE_LEGACY = `${SEL.primaryColumn} div[aria-label] > div`;

const TIMELINE_EVENT = 'te:timeline';
/**
 * 时间线状态锚点（`html[data-te-timeline-state]`）。三个值：
 * - `none`：这一页没有时间线（非时间线页 / 主列还没挂载）；
 * - `placeholder`：X 挂的是占位层，真实时间线还没到（此刻对时间线做整树工作没有意义）；
 * - `ready`：真实时间线已在位。
 * 与 `data-te-media-budget` 同类：把模块内部的判定结论暴露成一个可读事实，
 * 免得验证脚本 / 排查时去复算一遍判据（判据只允许有一处）。
 */
const STATE_ATTR = 'teTimelineState';

type TimelineState = 'none' | 'placeholder' | 'ready';

export type TimelineChangeReason = 'appeared' | 'replaced';

export interface TimelineDetail {
  /** 当前时间线滚动层（承载 cellInnerDiv / article 的那一层） */
  root: HTMLElement;
  /**
   * appeared：本页第一次拿到时间线；replaced：**同一个页面内**整层被换过
   * （标签页切换 / 占位层被真实层替换 / SPA 导航重挂主列）。
   * 功能据此决定要不要重做整树工作 —— 增量路径不受影响。
   */
  reason: TimelineChangeReason;
}

interface Resolution {
  /** 解析到的节点 */
  root: HTMLElement;
  /** 是否命中了滚动层选择器（false = 退回 primaryColumn 兜底，此时不做占位层判定） */
  scroller: boolean;
}

let root: HTMLElement | null = null;
/** 是否已经有一个「等真实滚动层」的等待在跑（占位层期间每个 DOM 批次都会走到这里） */
let waiting = false;
let started = false;

/**
 * 解析当前时间线滚动层。
 *
 * 回退链：新结构 → 旧结构 → primaryColumn 本身。
 * 最后这层兜底是给「结构还没长出来」的瞬间用的：此时**不做占位层判定**
 * （primaryColumn 上本来就可能没有内联 style，按占位层判会把整页时间线判成不存在）。
 */
function resolve(): Resolution | null {
  const primary = document.querySelector<HTMLElement>(SEL.primaryColumn);
  if (!primary) return null;
  const fresh = document.querySelector<HTMLElement>(TIMELINE_NEW);
  if (fresh) return { root: fresh, scroller: true };
  const legacy = document.querySelector<HTMLElement>(TIMELINE_LEGACY);
  if (legacy) return { root: legacy, scroller: true };
  return { root: primary, scroller: false };
}

/** 占位层：X 挂壳时不写内联几何，且内部还没有时间线单元 */
function isPlaceholder(el: HTMLElement): boolean {
  return !el.hasAttribute('style') && el.querySelector(SEL.cell) === null;
}

/** 当前时间线滚动层（尚未解析出来时返回 null）；供功能在批次回调里做范围判断 */
export function getTimelineRoot(): HTMLElement | null {
  return root;
}

let lastState: TimelineState | null = null;

function writeState(state: TimelineState): void {
  if (state === lastState) return;
  lastState = state;
  try {
    document.documentElement.dataset[STATE_ATTR] = state;
  } catch {
    // 极早期 documentElement 未就绪时忽略
  }
}

/** 订阅「时间线出现 / 被替换」；返回取消函数 */
export function onTimelineChanged(listener: (detail: TimelineDetail) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<TimelineDetail>).detail;
    if (detail?.root) listener(detail);
  };
  document.addEventListener(TIMELINE_EVENT, handler);
  return () => {
    document.removeEventListener(TIMELINE_EVENT, handler);
  };
}

function publish(next: HTMLElement): void {
  writeState('ready');
  if (next === root) return;
  const reason: TimelineChangeReason = root ? 'replaced' : 'appeared';
  root = next;
  try {
    document.dispatchEvent(new CustomEvent<TimelineDetail>(TIMELINE_EVENT, { detail: { root: next, reason } }));
  } catch {
    // 极早期 document 未就绪时忽略
  }
}

/**
 * 占位层期间等真实层替换它（`waitFor` + `stopIf` 的标准用法）。
 * 命中条件包含两种形态：X 换了一个新节点，或同一个节点被填上了内容 / 几何。
 */
function waitForRealTimeline(placeholder: HTMLElement): void {
  if (waiting) return;
  waiting = true;
  // 记录等待开始时的路径：页面切走就放弃，避免把旧页面的等待拖进新页面
  const path = currentPagePath();
  void waitFor<HTMLElement>(
    () => {
      const resolved = resolve();
      if (!resolved || !resolved.scroller) return null;
      if (resolved.root === placeholder) return isPlaceholder(placeholder) ? null : placeholder;
      return resolved.root;
    },
    { name: 'timeline', stopIf: pagePathChanged(path) },
  ).then((found) => {
    waiting = false;
    if (found) publish(found);
    // 等待被放弃（页面切走 / 超时）：按当前状态改写一次状态锚点，
    // 不重新发起等待 —— 下一批 DOM 变更或路由事件会走 refresh() 重新决定。
    else if (root) writeState('ready');
    else writeState('none');
  });
}

/**
 * 重解析一次（DOM 批次 / 路由切换时调用）。身份没变就直接返回 ——
 * 滚动时每个批次都会走到这里，必须廉价。
 */
function refresh(): void {
  const resolved = resolve();
  if (!resolved) {
    // 主列整个没了（导航走了）：静默清空，不派发事件 —— 消费者本来就会收到 te:route
    root = null;
    writeState('none');
    return;
  }
  const { root: next, scroller } = resolved;
  if (next === root) {
    writeState('ready');
    return;
  }
  if (scroller && isPlaceholder(next)) {
    writeState('placeholder');
    waitForRealTimeline(next);
    return;
  }
  publish(next);
}

/** 启动时间线观察（幂等）。在 main.ts 里、启用各功能之前调用一次。 */
export function startTimelineWatch(): void {
  if (started) return;
  started = true;
  refresh();
  onDomChanged(() => refresh());
  onRouteChanged(() => refresh());
}
