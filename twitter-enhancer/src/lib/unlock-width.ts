/**
 * 宽度解锁器（按内容单元向上定位）。
 *
 * 要解决的问题：X 用 hashed class 给「列容器」写死 `max-width: 600px`，选择器命中不了，
 * 于是宽时间线把主列放宽后，里面的内容仍是 600px。这里用运行时测量把它放开。
 *
 * 判据（2026-09-14 重做，两版经验教训都在下面）：
 * 1. **候选由内容单元向上走祖先链得到**：`CONTENT_UNIT`（cellInnerDiv / article）是列的
 *    语义内容，列宽上限只可能挂在这条祖先路径上。角色由**遍历方式**保证 ——
 *    不再用「这个元素内部有没有内容单元」这种谓词去判断。
 *    为什么不能那样判：容器**先于**内容出现（X 先挂列容器、再往里渲染推文），
 *    谓词在那一刻必然为 false，而祖先一旦扫过就不会再回看 —— 实测后果是
 *    带 `max-width:600px` 的列容器始终不被标记，整列退回 600px（用户实测反馈）。
 * 2. **尺寸只是必要条件**：仍然要求「计算宽度落在 lockedRange 且明显窄于容器」，
 *    但候选已经限定在祖先链上，所以轮播格（562px）、图片容器这类
 *    「数值凑巧」的元素根本不会进入判定 —— 不必再为它们列豁免（历史上列过两张表）。
 * 3. **禁止自反馈**：脚本自己写过的尺寸不作为输入（`lib/script-sized.ts`）。
 *    等比媒体链会被写成 608px，正好落进锁宽区间，不登记就会被自己改写。
 *
 * 性能：不走全树 BFS。只在「结构变化」时从内容单元向上走（屏上内容单元 ~10–30 个 ×
 * 祖先深度 ~6），且沿用原来的做法 —— dom-watch 回调只收集，真正的测量放进下一个 rAF 帧。
 *
 * 标记语义：命中就打 `data-te-width-unlocked`（'fixed' = 写死宽度，'max' = 写死上限），
 * 真正放开宽度的 CSS 挂在宽时间线开关下（timeline-width.css）；本模块只打标记。
 */
import { onDomChanged } from './dom-watch';
import { createFrameQueue } from './frame-work';
import { isScriptSized } from './script-sized';
import { SEL } from './selectors';

/** 打在元素上的标记属性名（data-te-width-unlocked） */
const FLAG = 'teWidthUnlocked';

/**
 * 内容单元：X 的时间线 / 推文内容节点 —— 解锁器的**锚点**。
 *
 * 只从它们向上找候选，等于把「这是列的一部分」这件事交给 DOM 结构回答：
 * 轮播格、tweetPhoto、操作栏都在内容单元**内部**，永远不会成为候选。
 */
const CONTENT_UNIT = `${SEL.cell}, ${SEL.tweet}`;

export interface UnlockOptions {
  /**
   * 兜底区间 [min, max]（px）：读不到原生列宽时使用（见 CONFIG.lockedWidthRange）。
   * 它的**半宽**同时决定主判据的带宽 —— 主判据是「原生列宽 ± 半宽」。
   */
  lockedRange?: [number, number];
  /**
   * X 原生主列宽度（px）提供者：主判据的区间 = 原生列宽 ± 半宽。
   *
   * 为什么要有它：本功能要抓的是「X 把列宽写死的那个值」，而那个值就是**原生列宽**
   * （实测 600px）。写死成常量后，X 一改断点 / 列宽判据就整体错位；
   * 由调用方在「宽列生效前」读一次真实值传进来，判据跟着 X 走。
   */
  nativeWidth?: () => number;
  /** 容器宽度与元素宽度的差值超过该值才处理，避免误伤宽度接近容器正常元素 */
  tolerance?: number;
  /**
   * 是否处于激活状态（默认恒为 true）。
   *
   * 解锁器只负责「打标记」，真正放开宽度的 CSS 由调用方挂在开关下。当调用方
   * 判断宽度覆盖不会生效时（宽时间线开关关闭、主列里渲染的是 X Chat 私信
   * 界面等），应返回 false：解锁器会撤销全部标记，既不浪费扫描，
   * 也不留下会让后续判断失真的悬挂标记。由关转开时自动整树补扫。
   */
  isActive?: () => boolean;
}

/** 判断某个计算值是否为「写死的像素宽度且明显窄于容器」 */
function isLockedValue(value: string, containerWidth: number, range: [number, number], opts: Required<UnlockOptions>): boolean {
  if (!value.endsWith('px')) return false;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) return false;
  const [min, max] = range;
  return n >= min && n <= max && containerWidth - n >= opts.tolerance;
}

export function createWidthUnlocker(containerSelector: string, options: UnlockOptions = {}) {
  const opts: Required<UnlockOptions> = {
    lockedRange: options.lockedRange ?? [560, 660],
    nativeWidth: options.nativeWidth ?? (() => 0),
    tolerance: options.tolerance ?? 40,
    isActive: options.isActive ?? (() => true),
  };

  /** 当前生效的锁宽区间：原生列宽 ± 半宽；读不到原生列宽时退回兜底区间 */
  function lockedRange(): [number, number] {
    const [fallbackMin, fallbackMax] = opts.lockedRange;
    const native = opts.nativeWidth();
    if (!(native > 0)) return [fallbackMin, fallbackMax];
    const half = (fallbackMax - fallbackMin) / 2;
    return [native - half, native + half];
  }

  /** 已被处理过的元素（强引用；重置时用于清除标记） */
  let touched: HTMLElement[] = [];
  let container: HTMLElement | null = null;
  let resizeObserver: ResizeObserver | null = null;
  let unsubscribe: (() => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let visibilityHandler: (() => void) | null = null;
  let domContentLoadedHandler: (() => void) | null = null;
  /** 上次完成全量扫描时的容器宽度 */
  let scannedWidth = -1;
  let stopped = true;
  /** 上次同步到的激活状态（用于识别「关 → 开」跃迁，需要整树补扫） */
  let active = true;
  /** 待处理的内容单元（帧任务里统一测量） */
  let pendingUnits: Set<Element> | null = null;
  /** 帧任务队列：DOM 批次回调只收集单元，测量放到下一个渲染帧（见 lib/frame-work.ts） */
  const frameQueue = createFrameQueue('unlock-width');

  /** 清除所有已打标记，使后续可重新计算 */
  function reset(): void {
    for (const el of touched) {
      delete el.dataset[FLAG];
    }
    touched = [];
    pendingUnits = null;
    scannedWidth = -1;
  }

  function unlock(el: Element): void {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset[FLAG] || !container) return;
    // 脚本自己写过的尺寸不作为输入（禁止自反馈，见 lib/script-sized.ts）
    if (isScriptSized(el)) return;
    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;
    const style = getComputedStyle(el);
    const range = lockedRange();
    const widthLocked = isLockedValue(style.width, containerWidth, range, opts);
    const maxLocked = isLockedValue(style.maxWidth, containerWidth, range, opts);
    if (!widthLocked && !maxLocked) return;
    el.dataset[FLAG] = widthLocked ? 'fixed' : 'max';
    touched.push(el);
  }

  /**
   * 处理一个内容单元：沿祖先链逐个判定。
   * 链上每一层都可能是「X 写死的列宽上限」（实测最常见的就是最外层那个
   * `max-width: 600px` 的 div），所以不能只看最近的一层。
   */
  function considerUnit(unit: Element): void {
    if (!container || !unit.isConnected || !container.contains(unit)) return;
    for (let el: Element | null = unit; el && el !== container.parentElement; el = el.parentElement) {
      unlock(el);
    }
  }

  function runFrameWork(): void {
    if (stopped) return;
    if (!ensureActive()) return;
    if (!ensureContainer()) return;
    const units = pendingUnits;
    pendingUnits = null;
    if (units) {
      for (const unit of units) considerUnit(unit);
    }
  }

  /** 全量：按当前 DOM 把所有内容单元的祖先链过一遍 */
  function scanAll(): void {
    if (!container) return;
    for (const unit of container.querySelectorAll(CONTENT_UNIT)) considerUnit(unit);
  }

  /** 整树补扫：清标记后重扫（容器首现 / 容器宽度变化 / 开关由关转开 / 窗口 resize） */
  function fullRescan(): void {
    reset();
    if (!ensureContainer()) return;
    scanAll();
  }

  /**
   * 同步 isActive 状态，返回当前是否激活。
   * - 由开转关：撤销全部标记 —— 宽度覆盖已失效，留着的标记只会让后续判断失真；
   * - 由关转开：整树补扫 —— 关闭期间新增的内容从未被检视过。
   * 状态不变时只做一次属性读取，代价可忽略，因此可以放心在热路径上调用。
   */
  function ensureActive(): boolean {
    const next = opts.isActive();
    if (next === active) return next;
    active = next;
    if (next) fullRescan();
    else reset();
    return next;
  }

  /** 保证容器存在：首现或容器被替换时全量扫一次并挂 ResizeObserver */
  function ensureContainer(): HTMLElement | null {
    if (container && container.isConnected) return container;
    container = document.querySelector<HTMLElement>(containerSelector);
    if (!container) return null;

    reset();
    resizeObserver?.disconnect();
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (!container || stopped) return;
        const w = container.clientWidth;
        // 宽度变化超过容差才重扫（普通布局抖动不触发）。容器先于内容出现、
        // 或 X 稍后才给容器加上 max-width 时，都会在这里被重新量一次。
        if (Math.abs(w - scannedWidth) > opts.tolerance) {
          scannedWidth = w;
          fullRescan();
        }
      });
      resizeObserver.observe(container);
    }
    scannedWidth = container.clientWidth;
    scanAll();
    return container;
  }

  /** 从新增节点里挑出内容单元（节点自身命中 / 包含命中两种） */
  function collectUnits(node: Element): void {
    if (!node.isConnected) return;
    if (!pendingUnits) pendingUnits = new Set();
    if (node.matches(CONTENT_UNIT)) pendingUnits.add(node);
    for (const unit of node.querySelectorAll(CONTENT_UNIT)) pendingUnits.add(unit);
  }

  return {
    /** 启动：立即扫描一次，并订阅共享 DOM 变更池做增量扫描 */
    start(): void {
      stopped = false;
      // 初始状态先与调用方对齐，避免首帧就产生一次无谓的「关 → 开」补扫
      active = opts.isActive();
      if (ensureActive()) fullRescan();
      domContentLoadedHandler = () => {
        if (ensureActive()) fullRescan();
      };
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', domContentLoadedHandler, { once: true });
      }
      // 增量：订阅 dom-watch 单例共享的新增节点池。
      // 回调里只收集内容单元，测量放进下一个 rAF 帧（滚动路径上不做同步布局读）。
      unsubscribe = onDomChanged(({ added, overflow: hadOverflow }) => {
        if (stopped) return;
        // 调用方可能在不触发 DOM 变更的情况下切换激活状态（开关 / 路由切换）
        if (!ensureActive()) return;
        // 主列被 React 整体替换（SPA 导航重挂 app shell）时旧容器已脱离文档：
        // 此时需要重新锁定新主列并整树补扫。
        if (!container || !container.isConnected) {
          fullRescan();
          return;
        }
        // 单批新增超池上限：池里可能没有我们要的锚点（dom-watch 的 overflow 契约），
        // 增量路径不可信 → 整树补扫一次（内容单元不多，代价可控）。
        if (hadOverflow) {
          fullRescan();
          return;
        }
        for (const node of added) {
          if (!container.contains(node)) continue;
          collectUnits(node);
        }
        if (pendingUnits) frameQueue.schedule('units', runFrameWork);
      });
      resizeHandler = () => {
        // 窗口尺寸变化可能让整条宽链失效：清标记并整树补扫
        if (ensureActive()) fullRescan();
      };
      window.addEventListener('resize', resizeHandler);
      visibilityHandler = () => {
        if (!document.hidden && ensureActive()) fullRescan();
      };
      document.addEventListener('visibilitychange', visibilityHandler);
    },
    /**
     * 主动同步激活状态。调用方在切换开关 / 改变布局判定后调用：
     * 由开转关撤销标记，由关转开整树补扫。避免「开关已关闭但解锁器仍在
     * 扫描」与「开关已开启但解锁器还以为自己是关的」两种错位。
     */
    sync(): void {
      if (stopped) return;
      if (!ensureActive()) return;
      fullRescan();
    },
    /** 停止并还原所有改动 */
    stop(): void {
      stopped = true;
      resizeObserver?.disconnect();
      resizeObserver = null;
      unsubscribe?.();
      unsubscribe = null;
      if (domContentLoadedHandler) document.removeEventListener('DOMContentLoaded', domContentLoadedHandler);
      if (resizeHandler) window.removeEventListener('resize', resizeHandler);
      if (visibilityHandler) document.removeEventListener('visibilitychange', visibilityHandler);
      reset();
      container = null;
    },
  };
}

