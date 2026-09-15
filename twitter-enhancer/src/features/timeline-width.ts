/**
 * 时间线主列宽度修正（宽时间线开关）。
 *
 * 三层处理：
 * 1. 开关：`html[data-te-timeline='wide']` 控制 CSS 是否生效，可在页内设置面板切换并持久化；
 * 2. CSS：把 `div[data-testid="primaryColumn"]` 放宽到 `--te-timeline-width`（见 timeline-width.css）；
 * 3. JS：目标宽度按 X 自己的三栏几何算 —— 右栏隐藏时铺满 X 的内容区，
 *    右栏显示时在可用空间内按 `CONFIG.timelineWidth` 封顶。
 *
 * ## 右栏隐藏 = 铺满内容区（2026-09-08 真机实测）
 *
 * X 原生三栏的内容区是一个固定盒子：主列 600 + 间距 30 + 右栏 350，盒子右缘之外
 * 还留着右栏自带的 margin-right（1440 视口 70px，1024/1280 视口 10px）。
 * `/i/grok` 就是 X 自己的「单栏版」该盒子 —— 它把右栏那一份横向空间整个让给主列：
 *
 * | 视口 | 三栏行左缘 | 内容区宽（= grok 主列宽） | /i/grok 主列 | /home 主列 + 右栏 |
 * |------|-----------|--------------------------|--------------|------------------|
 * | 1024 | 96        | 920 − 10 = 910           | 910 @96      | 600 @96 + 290 @716 |
 * | 1440 | 363       | 1050 − 70 = 980          | 980 @363     | 600 @363 + 350 @993 |
 * | 2560 | 923       | 1050 − 70 = 980          | 980 @923     | 600 @923 + 350 @1553 |
 *
 * 关键：Grok 页的主列**左缘与 /home 完全相同**，左导航条（fixed，275px）一点没动 ——
 * X 只是把右栏的 margin-right 做成三栏行的 `padding-right` 来留住右侧留白。
 * 所以右栏被本脚本隐藏时，主列直接铺满这个盒子（`行宽 − 右栏保留的右边距`）即可：
 * 不居中、不移动左缘，在 /home 与 /i/grok 之间切换时主区几何逐像素相同。
 *
 * 旧版是「按视口可用宽放宽到 800 并在行里居中」：1440 视口下主列 800 @488、
 * 左导航条被锚到 213，切到 /i/grok（980 @363、导航条 88）时整页横移 125px 再弹回，
 * 正是「两个 tab 表现不一致」的来源。
 *
 * ## 适用页面：X 自己渲染三栏的页面
 *
 * 判据取 DOM 结构 —— 主列所在的行里有右栏兄弟节点。`/i/grok`（980 单栏）与
 * `/i/chat`（1187 双栏）都没有，一律交回 X 原生。
 * 不能改用「主列当前宽度」判据：SPA 从 /home 切到 /i/grok 时新主列会先以非原生
 * 宽度挂载，宽度判据在那个瞬间会误判成「可以放宽」，把 Grok 页钉成 800px
 * （2026-09-08 逐帧实测：点左栏 Grok 进入后主列 800 @363、直接刷新才是 980 @363）。
 *
 * 单一门控点：`html[data-te-timeline='wide']` 同时决定三件事是否生效 ——
 * CSS 宽度覆盖（timeline-width.css）、媒体高度钳制（media-cap 的 isActive）、
 * 宽度解锁器（unlock-width 的 isActive）。因此「宽列不适用」的判定只需要
 * 收敛到一处（开关关闭 / 视口过窄 / X 没渲染三栏，如 /i/grok、 /i/chat），
 * 不必在 CSS 与各模块里重复排除条件。
 * JS 侧读写这个属性只允许走 `lib/gate.ts` 的 `isWideTimeline()` / `setWideTimeline()` ——
 * 属性名与取值 `'wide'` 是它的私有实现，功能之间只传布尔值。
 *
 * 监听策略（性能版）：
 * - 不再自建轮询定时器 / 全站 MutationObserver。主列 / 右栏的出现与消失走
 *   dom-watch 单例派发的合并批次（滚动时也只有 120ms 一次的节流回调）；
 * - 右栏显隐会改变可用宽度：sidebar 功能切换后会广播 `te:layout`，这里订阅重算；
 * - 自身调整完布局也会广播 `te:layout`，供右栏锚定逻辑（sidebar）跟随。
 */
import { CONFIG } from '../config';
import { createToggle } from '../lib/toggle';
import { createFrameQueue } from '../lib/frame-work';
import { isSidebarHidden, isWideTimeline, setWideTimeline } from '../lib/gate';
import { createWidthUnlocker } from '../lib/unlock-width';
import { onDomChanged, dispatchLayoutEvent } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import { currentPageKind, onPageKindChanged } from '../lib/page';
import { SEL } from '../lib/selectors';
import './timeline-width.css';

/** 主列选择器（稳定锚点统一登记在 lib/selectors.ts） */
const PRIMARY_COLUMN = SEL.primaryColumn;
/** 右栏选择器：三栏行里 X 自己渲染的那一栏 */
const SIDEBAR_COLUMN = SEL.sidebarColumn;
/** X 原生主列宽度：可用空间不足时退回该值，避免主列被压得比原生还窄 */
const MIN_WIDTH = 600;
/** 视口右侧安全边距 */
const EDGE = 16;
/** 宽度兜底判据的容差（px）：吸收 getBoundingClientRect 的小数误差 */
const WIDTH_GUARD_TOLERANCE = 1;
/**
 * X Chat（私信）全屏路由 —— 唯一已确认的非时间线主列页面。
 *
 * 实测（2026-09-11，1440 视口，headless 独立 profile，只读短探测）：
 * - `/home`：primaryColumn 原生 600px（width / max-width 均为 600px），右侧有 sidebarColumn；
 * - `/messages` → 重定向到 `/i/chat/*`：X Chat 是独立双栏布局，primaryColumn
 *   原生 **1187px**、`max-width: none`、**没有** sidebarColumn。
 *
 * 宽时间线会让主列铺满内容区（并顺带套上 `max-width: 100% !important` 等一组
 * 「放开内层 600 上限」的规则），1187px 的聊天分栏会被挤坏 —— 同类扩展
 * （typefully/minimal-twitter）也为 X Chat 单独写了例外规则。
 * 结构判据（行里没有右栏）本已能挡掉它，这里再按路由挡一道：路由判定不依赖
 * DOM 时序，从 /home 导航过去时不必等聊天主列挂载就能先撤销宽列。
 * 路由类型由 `lib/page.ts` 统一分类（`/messages` 与 `/i/chat` 同归 'messages'），
 * 这里不再自己写正则 —— 页面类型判据只允许有一处。
 *
 * drawer 形态（`chat-drawer-root`）是浮层、不在 primaryColumn 内，不受宽列
 * 影响，因此不需要为它加判定。
 */
function isChatRoute(): boolean {
  return currentPageKind() === 'messages';
}

/**
 * 宽列开关的当前值 —— 与 `createToggle` 同步的一份镜像。
 *
 * 为什么不处处读 toggle 句柄：`writeTimelineLayout()` 会在**构造 toggle 的那一次
 * `apply` 里**就被调用，那一刻句柄还没赋值（`const` 的 TDZ），读它会直接抛错。
 */
let wide = CONFIG.timelineWide;
/** 上次实际写入的几何（用于判定是否真的变化，避免无意义地反复广播 te:layout） */
let lastEnabled: boolean | null = null;
let lastTarget = 0;
let lastMinWidth = '';
/**
 * 上次写入 min-width 的三栏行（只在右栏显示时需要撑开行，让「主列 + 右栏」放得下）。
 * SPA 导航时 React 可能重建该行容器：旧节点若带着残留 min-width 退出并无碍，
 * 但新行不会被自动撑开 —— 必须感知行容器被替换，先清旧节点再写新节点（社区教训：
 * SPA 下任何「写在具体节点上的内联样式」都要自己跟踪节点生命周期）。
 */
let lastRow: HTMLElement | null = null;
/**
 * 被本功能亲手放宽过的主列。
 *
 * 「只放宽、从不收窄」的兜底判据需要区分「页面原生就这么宽」与「这是我们自己写的」：
 * 没有这份记录时，第二轮读到的是我们写进去的宽度（可能比兜底阈值宽），会被误判成
 * 「这一页本来就不该动」而永久停摆（自锁）。
 */
const widenedByUs = new WeakSet<Element>();
/** 宽度解锁器实例（由 enableTimelineWidth 创建；applyTimelineLayout 收尾时同步其门控） */
let unlocker: ReturnType<typeof createWidthUnlocker> | null = null;

/**
 * X 原生主列宽度（px，宽列生效前观测到的值）。
 *
 * 解锁器要抓的是「X 把列宽写死的那个值」，而那个值就是原生列宽本身 —— 与其在
 * CONFIG 里写死 [560, 660]，不如把真实观测值传给它，判据跟着 X 的断点走。
 * 只在「不是我们写过的宽度」时更新（见 writeTimelineLayout 里的读取点）。
 */
let nativeColumnWidth = 0;

/**
 * 撤销宽列，交回 X 原生布局。四条路径共用：
 * 开关关闭 / 路由不是时间线（X Chat）/ X 没渲染三栏（Grok）/ 视口低于断点。
 *
 * `row` 传当前主列所在的行 —— 可能为 null（路由已切走、主列尚未挂载）。
 */
function disableTimelineLayout(row: HTMLElement | null): void {
  if (lastEnabled === false) return;
  if (row) clearRowStyle(row);
  // 行容器被 React 换过时上一行还留着 min-width，一并清掉
  if (lastRow && lastRow !== row) clearRowStyle(lastRow);
  lastRow = null;
  lastTarget = 0;
  lastMinWidth = '';
  lastEnabled = false;
  setWideTimeline(false);
  dispatchLayoutEvent();
}

/** 清掉写在上一次三栏行上的内联样式（行被 React 替换 / 功能关闭时调用） */
function clearRowStyle(row: HTMLElement | null): void {
  if (!row) return;
  row.style.removeProperty('min-width');
  row.removeAttribute('data-te-row');
}

/**
 * 主列所在的行里，X 自己渲染的右栏（行的直接子节点）。
 * Grok / X Chat 这类 X 自己收起右栏的页面没有 → 不是三栏时间线。
 */
function findRowSidebar(row: HTMLElement): HTMLElement | null {
  for (const child of Array.from(row.children)) {
    if (child.matches(SIDEBAR_COLUMN)) return child as HTMLElement;
  }
  return null;
}

/**
 * 当前主列所在行里有没有 X 自己渲染的右栏。
 * 用于识别「三栏 ↔ 单栏」的页面切换（/home ↔ /i/grok 这类）：它决定目标宽度的
 * 算法，所以必须在 DOM 批次里当作重算触发条件。
 */
function hasRowSidebar(): boolean {
  const primary = document.querySelector<HTMLElement>(PRIMARY_COLUMN);
  const row = primary?.parentElement;
  return !!row && findRowSidebar(row) !== null;
}

/**
 * 右栏是否已被本脚本隐藏。
 *
 * 判据是门控模块发布的那份事实（`html[data-te-sidebar]`，与 sidebar.css 里隐藏右栏的规则
 * 同一个属性）：属性缺失即右栏可见 —— sidebar 功能整体关闭时也不会误判。
 */
/**
 * 右栏右缘之外 X 保留的右边距（右栏自带的 margin-right，display:none 时计算值仍在）。
 * 它是内容区右边界的一部分：/i/grok 把同一个值做成了三栏行的 padding-right。
 */
function sidebarReservedMargin(sidebar: HTMLElement): number {
  return Number.parseFloat(getComputedStyle(sidebar).marginRight) || 0;
}

/** 右栏可见时占用的横向空间：宽度 + margin-right + 与主列的间距（隐藏时为 0） */
function sidebarVisibleOuter(sidebar: HTMLElement): number {
  // display:none 时 getClientRects 为空，比读 computed display 更可靠
  if (sidebar.getClientRects().length === 0) return 0;
  return sidebar.getBoundingClientRect().width + sidebarReservedMargin(sidebar) + CONFIG.sidebar.gap;
}

/**
 * 计算主列目标宽度（px）。
 *
 * - 右栏隐藏：铺满 X 内容区 = 行宽 − 右栏保留的右边距（与 /i/grok 一致，左缘不动）；
 * - 右栏显示：可用宽 = 视口宽 − 行左缘 − 安全边距 − 右栏占用，按 CONFIG.timelineWidth 封顶。
 *
 * 返回 0 表示布局尚未就绪（行宽读不到），本轮先不写。
 */
function timelineTarget(row: HTMLElement, sidebar: HTMLElement, hidden: boolean): number {
  if (hidden) {
    const rowWidth = row.clientWidth;
    if (rowWidth <= 0) return 0;
    return Math.max(MIN_WIDTH, Math.round(rowWidth - sidebarReservedMargin(sidebar)));
  }
  const available =
    window.innerWidth - row.getBoundingClientRect().left - EDGE - sidebarVisibleOuter(sidebar);
  return Math.max(MIN_WIDTH, Math.min(CONFIG.timelineWidth, Math.round(available)));
}

/**
 * 计算并写入主列宽度（可提前 return，收尾统一交给 applyTimelineLayout）。
 */
function writeTimelineLayout(): void {
  const root = document.documentElement;
  const primary = document.querySelector<HTMLElement>(PRIMARY_COLUMN);
  const row = primary?.parentElement ?? null;

  // 路由已明确不是时间线：不等主列挂载就先撤销开关。
  // SPA 从 /home 导航到 /i/chat 时聊天主列会晚于路由就绪，若拖到 DOM 批次里
  // 发现「主列换了」再撤销，中间可能有一帧用宽列样式绘制 1187px 的聊天列
  // （1187 → 目标宽 → 1187 的可见抖动）。路由判定不依赖 DOM 时序，先做。
  if (isChatRoute()) {
    disableTimelineLayout(row);
    return;
  }

  if (!primary || !row) return;

  // X 自己没渲染右栏 → 这一页不是三栏时间线（/i/grok 980 单栏、/i/chat 1187 双栏），
  // 结构判据在此挡掉，理由见文件头「适用页面」。
  const sidebar = findRowSidebar(row);
  if (!sidebar) {
    disableTimelineLayout(row);
    return;
  }

  // 行容器被 React 替换（旧引用不在新行上）：清掉旧节点的残留样式
  if (lastRow && lastRow !== row) clearRowStyle(lastRow);

  const hidden = isSidebarHidden();
  const target = timelineTarget(row, sidebar, hidden);
  if (target <= 0) return;

  // 本功能只负责放宽，从不收窄：页面原生就比目标宽（X 后续新增的非时间线页面）
  // 时原样交回。我们自己写过的主列不算「原生」（否则会自锁，见 widenedByUs 注释）。
  const primaryWidth = primary.getBoundingClientRect().width;
  // 只有**我们自己的宽度覆盖没生效时**（data-te-timeline 不是 wide）读到的值才是 X 原生列宽。
  // SPA 导航时上一页的 'wide' 还在，新主列一挂载就被 CSS 写成目标宽 —— 那一刻读到的
  // 是脚本自己的输出，拿它当「原生列宽」会把解锁器判据挪到目标宽一带（实测 2026-09-14：
  // 导航后时间线内容退回 600px，且一直坏到刷新）。见 architecture.md 的「禁止自反馈」。
  if (!isWideTimeline() && primaryWidth > 0) {
    nativeColumnWidth = primaryWidth;
  }
  if (!widenedByUs.has(primary) && primaryWidth > target + WIDTH_GUARD_TOLERANCE) {
    disableTimelineLayout(row);
    return;
  }

  // 视口过窄 / 开关关闭 → 交回 X 原生，与「不适用的页面」走同一条路径：
  // 撤掉 data-te-timeline 即可让 CSS 宽度覆盖、媒体高度钳制、宽度解锁器
  // （三者都挂在这个属性上）一并失效，不需要在 CSS 里逐条加 :not() 排除。
  if (!wide || window.innerWidth < CONFIG.timelineBreakpoint) {
    disableTimelineLayout(row);
    return;
  }
  setWideTimeline(true);

  // 行补偿样式只有「右栏显示」时才需要：把右栏钉在主列右侧 30px（见 sidebar.applyAnchor），
  // 所以要撑开行让「主列 + 右栏」放得下（父容器 overflow:visible，不会裁剪）。
  // 右栏隐藏时主列已铺满内容区，行保持 X 原生的 space-between 即可 ——
  // 单子节点下它等价于左对齐，与 /i/grok 的行完全一致，不写任何内联样式。
  const wantRowStyle = !hidden;
  const minWidth = wantRowStyle ? `${Math.round(target + sidebarVisibleOuter(sidebar))}px` : '';
  const rowStyleChanged = wantRowStyle ? lastRow !== row : lastRow !== null;

  // 几何不变且行节点没被替换时也要跳过重写（新节点没有 min-width，rowStyleChanged 已覆盖）
  const changed = lastEnabled !== true;
  const geometryChanged = changed || rowStyleChanged || target !== lastTarget || minWidth !== lastMinWidth;
  lastEnabled = true;
  lastTarget = target;
  lastMinWidth = minWidth;
  if (!geometryChanged) return;

  root.style.setProperty('--te-timeline-width', `${target}px`);
  root.dataset.teTimelineWidth = String(target);
  widenedByUs.add(primary);
  if (wantRowStyle) {
    row.style.minWidth = minWidth;
    row.dataset.teRow = '1';
    lastRow = row;
  } else if (lastRow) {
    // 右栏刚被隐藏：撤掉上一轮写在行上的 min-width，交回 X 原生
    clearRowStyle(lastRow);
    lastRow = null;
  }

  // 布局（尤其行的 min-width）变化会移动右栏，通知锚定逻辑重新摆它
  dispatchLayoutEvent();
}

/**
 * 布局入口：写完宽度后同步解锁器的门控。
 *
 * 放在这里而不是各个分支里，是为了保证「只要 data-te-timeline 被写过，
 * 解锁器就与它对齐」这一不变量 —— 属性是宽度覆盖的唯一开关，解锁器必须
 * 同频，否则会出现「开关已关但解锁器仍在打标记」的白耗，或「开关已开但
 * 解锁器还停着」的漏解锁（关闭期间新增的锁宽元素永远不会被处理）。
 */
function applyTimelineLayout(): void {
  writeTimelineLayout();
  unlocker?.sync();
}

export function enableTimelineWidth(): void {
  // 宽度解锁器与宽时间线共用同一个门控（html[data-te-timeline='wide']）：
  // 解锁器只负责给「被写死宽度的容器」打标记，真正放开宽度的 CSS 挂在该属性下。
  // 因此开关关闭 / 当前不是时间线页面时让它彻底停摆 —— 打标记既无视觉效果，
  // 又白耗全树扫描。
  // 必须在首次 applyTimelineLayout 之前建好：布局收尾要同步它的门控。
  unlocker = createWidthUnlocker(PRIMARY_COLUMN, {
    lockedRange: CONFIG.lockedWidthRange,
    // 主判据 = 原生列宽 ± 半宽（宽列生效前读到的那次），读不到时退回 CONFIG 区间
    nativeWidth: () => nativeColumnWidth,
    isActive: isWideTimeline,
  });
  unlocker.start();

  // 主列是 React 渲染的，可能晚于脚本注入：订阅共享观察器，出现 / 结构变化时重算。
  // 回调本身很廉价（几次 querySelector + getBoundingClientRect），120ms 节流足够。
  // 布局重算合并到下一帧：主列 / 右栏 / 窗口尺寸 / te:layout 可能在同一次导航里连着报好几次。
  // 队列见 lib/frame-work.ts（同帧合并 + 没有 rAF 时退回 setTimeout）。
  const layoutQueue = createFrameQueue('timeline-width');
  const scheduleLayout = (): void => {
    layoutQueue.schedule('layout', applyTimelineLayout);
  };

  // 开关：默认值 / 存储读取 / 写盘 / 面板登记与刷新全部交给 createToggle（见 lib/toggle.ts）。
  // 构造时的第一次 apply 就是收尾的 applyTimelineLayout()，所以它必须排在解锁器就位之后。
  createToggle({
    id: 'timeline-wide',
    group: '布局',
    label: '宽时间线',
    description: '主列铺满 X 内容区；右栏显示时最多放宽到 800px',
    default: CONFIG.timelineWide,
    apply: (value) => {
      wide = value;
      applyTimelineLayout();
    },
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleLayout, { once: true });
  }
  window.addEventListener('load', scheduleLayout, { once: true });
  window.addEventListener('resize', scheduleLayout);
  // 右栏显示 / 隐藏会改变可用宽度：sidebar 切换后广播 te:layout，这里跟随重算
  document.addEventListener('te:layout', scheduleLayout);
  // SPA 导航（home / explore / 详情页切换）会重建主列子树、替换三栏行容器：
  // 路由切换是低频事件，直接重算一次即可，无需等 DOM 批次里发现存在性跃迁。
  onRouteChanged(() => scheduleLayout());
  // 页面类型跃迁（尤其 /home → X Chat）同步重算一次：te:page 在 te:route 之后同帧派发，
  // 不必再等一个 rAF —— 「聊天列先按宽列样式画一帧」的窗口就是从这里抢回来的。
  onPageKindChanged(() => applyTimelineLayout());

  // 主列可能在任意时刻被 React 挂载 / 替换（SPA 导航），订阅共享 DOM 批次即可。
  // 判断采用「主列 / 右栏的存在性跃迁」+「行里右栏的有无」+「锚点节点身份变化
  // （structural）」：每批只做几个 querySelector 的廉价检查，而不是遍历新增节点
  // 子树 —— 滚动时插入的普通推文不会触发重算。
  // structural 批次由 dom-watch 在渲染帧前同步派发，此时必须同步重算并写入
  // 新行（不能等 rAF）：React 重挂 app shell 时旧行连 min-width 一起消失，
  // 新行若先按 X 原生宽度绘制一帧，就是可见的宽度闪烁（2026-09 真机实测）。
  let hadPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
  let hadSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
  let hadRowSidebar = hasRowSidebar();
  onDomChanged(({ overflow: hadOverflow, structural }) => {
    const nowPrimary = document.querySelector(PRIMARY_COLUMN) !== null;
    const nowSidebar = document.querySelector(SIDEBAR_COLUMN) !== null;
    const nowRowSidebar = hasRowSidebar();
    const relevant =
      hadOverflow ||
      structural ||
      nowPrimary !== hadPrimary ||
      nowSidebar !== hadSidebar ||
      nowRowSidebar !== hadRowSidebar;
    hadPrimary = nowPrimary;
    hadSidebar = nowSidebar;
    hadRowSidebar = nowRowSidebar;
    if (!relevant) return;
    if (structural) applyTimelineLayout();
    else scheduleLayout();
  });
}

