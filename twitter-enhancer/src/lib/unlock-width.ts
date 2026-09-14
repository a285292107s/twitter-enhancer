/**
 * 宽度解锁器（性能版）。
 *
 * 旧实现的问题：每次 mutation 冲刷时都对容器做一次 `querySelectorAll('*')`
 * 全量扫描（可达数千节点），并对每个节点调用 getComputedStyle —— 这在 X 的
 * 虚拟滚动（React Virtualized）下会造成明显的 Layout Thrashing 与滚动掉帧。
 *
 * 新方案：
 * 1. 优先用纯 CSS 覆盖（timeline-width.css 已按 data-testid 放开主列内部容器），
 *    本模块只处理 CSS 覆盖不到的「哈希 class 写死宽度」兜底；
 * 2. 不再自己注册 MutationObserver —— 增量节点来自 dom-watch 单例共享池；
 * 3. 全量扫描只发生一次（容器首现 / 宽度显著变化时），此后只增量检视新增节点，
 *    绝不重扫已扫过的整棵子树；
 * 4. 待检元素维护为队列，每帧只处理一个时间片（sliceSize 个）后让出主线程，
 *    处理元素时把其子元素入队 —— 不产生一次性大数组，不会单帧卡死滚动；
 * 5. 队列长度有上限（防虚拟滚动下无界增长），后台 rAF 冻结由 visibilitychange
 *    与 dom-watch 的兜底冲刷覆盖；
 * 6. 只在元素写死宽（560–660px 且明显窄于容器）时打 data-te-width-unlocked，
 *    由 CSS 放开到 100%。**媒体轮播（ScrollSnap-List）子树除外**：轮播格的宽度是
 *    「行高 × 内联 aspect-ratio」推出来的媒体比例，数值可能正好落在锁宽区间里
 *    （实测 2026-09-14：3 竖图轮播 行高 757 × 0.74248 = 562px），误解锁会把整格
 *    拉成 100% 列宽，竖图被放大铺满；详见 CAROUSEL_SCOPE 注释；
 * 7. 打标记本身不改变任何样式 —— 「放开到 100%」的 CSS 挂在宽时间线开关下。
 *    因此开关关闭 / 主列是 X Chat 私信界面时，标记既不产生视觉效果又白耗全树
 *    扫描，必须靠 isActive 停摆并撤销已有标记（见 options.isActive）。
 */

import { onDomChanged } from './dom-watch';

/** 打在元素上的标记属性名（data-te-width-unlocked） */
const FLAG = 'teWidthUnlocked';

/**
 * 媒体轮播作用域：X 的横向轮播容器，下面的每一格（含格内的 tweetPhoto / img）
 * 宽度都由「行高 × 内联 aspect-ratio」推出，是**媒体比例**而不是写死的容器宽度。
 *
 * 实测（2026-09-14，1440 视口，headless 独立 profile，推文 /status/…）：
 * 3 张竖图（原图 1521×2048，比例 0.74248）的轮播格在行高 757 时宽 562px，
 * 正好落在 CONFIG.lockedWidthRange [560, 660] 里 → 被误判成「X 写死的 600px
 * 容器」并放开到 100%（946px）：media-cap 只压了行高（757→540），格宽仍是整列，
 * 竖图被放大铺满整列（观感「图片宽高都不再受限」）。是否命中取决于解锁器的 BFS
 * 分片扫描与 media-cap 的 rAF 钳制谁先跑到该节点，因此同一页面冷加载时好时坏。
 *
 * 轮播格的宽高必须交回 X 自己算，这里整棵子树都不参与解锁。
 */
const CAROUSEL_SCOPE = '[data-testid="ScrollSnap-List"]';

export interface UnlockOptions {
  /** 被写死的宽度区间 [min, max]（px），只有落在该区间内的固定宽度才视为锁死 */
  lockedRange?: [number, number];
  /** 容器宽度与元素宽度的差值超过该值才处理，避免误伤宽度接近容器正常元素 */
  tolerance?: number;
  /** 单帧最多处理的元素数（时间片大小，越小越不抢主线程，完成越慢） */
  sliceSize?: number;
  /** 待检队列上限，防止虚拟滚动下无界增长 */
  maxQueue?: number;
  /**
   * 是否处于激活状态（默认恒为 true）。
   *
   * 解锁器只负责「打标记」，真正放开宽度的 CSS 由调用方挂在开关下。当调用方
   * 判断宽度覆盖不会生效时（宽时间线开关关闭、主列里渲染的是 X Chat 私信
   * 界面等），应返回 false：解锁器会清空待检队列并撤销全部标记，既不浪费
   * 全树扫描，也不留下会让后续判断失真的悬挂标记。
   * 由关转开时自动整树补扫（关闭期间新增的锁宽元素从未被检视过）。
   */
  isActive?: () => boolean;
}

/** 判断某个计算值是否为「写死的像素宽度且明显窄于容器」 */
function isLockedValue(value: string, containerWidth: number, opts: Required<UnlockOptions>): boolean {
  if (!value.endsWith('px')) return false;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) return false;
  const [min, max] = opts.lockedRange;
  return n >= min && n <= max && containerWidth - n >= opts.tolerance;
}

export function createWidthUnlocker(containerSelector: string, options: UnlockOptions = {}) {
  const opts: Required<UnlockOptions> = {
    lockedRange: options.lockedRange ?? [560, 660],
    tolerance: options.tolerance ?? 40,
    sliceSize: options.sliceSize ?? 300,
    maxQueue: options.maxQueue ?? 8000,
    isActive: options.isActive ?? (() => true),
  };

  /** 已被处理过的元素（强引用；重置时用于清除标记） */
  let touched: HTMLElement[] = [];
  let container: HTMLElement | null = null;
  /** 待检队列 */
  let queue: Element[] = [];
  let scheduled = false;
  let resizeObserver: ResizeObserver | null = null;
  let unsubscribe: (() => void) | null = null;
  let resizeHandler: (() => void) | null = null;
  let visibilityHandler: (() => void) | null = null;
  let domContentLoadedHandler: (() => void) | null = null;
  /** 上次完成全量扫描时的容器宽度 */
  let scannedWidth = -1;
  let stopped = false;
  /** 上次同步到的激活状态（用于识别「关 → 开」跃迁，需要整树补扫） */
  let active = true;

  /** 清除所有已打标记，使后续可重新计算 */
  function reset(): void {
    for (const el of touched) {
      delete el.dataset[FLAG];
    }
    touched = [];
    queue = [];
    scannedWidth = -1;
  }

  function unlock(el: Element): void {
    if (!(el instanceof HTMLElement)) return;
    if (el.dataset[FLAG] || !container) return;
    // 轮播格（及其内部的 tweetPhoto / img）宽度是媒体比例推出来的，不是写死的容器
    // 宽度 —— 数值可能落在 lockedRange 内，这里必须放过（见 CAROUSEL_SCOPE 注释）。
    if (el.closest(CAROUSEL_SCOPE)) return;
    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;
    const style = getComputedStyle(el);
    const widthLocked = isLockedValue(style.width, containerWidth, opts);
    const maxLocked = isLockedValue(style.maxWidth, containerWidth, opts);
    if (!widthLocked && !maxLocked) return;
    el.dataset[FLAG] = widthLocked ? 'fixed' : 'max';
    touched.push(el);
  }

  function enqueue(el: Element): void {
    if (queue.length >= opts.maxQueue) return;
    queue.push(el);
  }

  /** 处理一个时间片：检视队首若干元素，再把其子元素入队（BFS） */
  function workSlice(): void {
    scheduled = false;
    if (stopped) return;
    if (!ensureActive()) return;
    const c = ensureContainer();
    if (!c) return;
    const containerWidth = c.clientWidth;
    if (containerWidth <= 0) return;

    let processed = 0;
    while (queue.length > 0 && processed < opts.sliceSize) {
      const el = queue.shift()!;
      if (!el.isConnected) continue; // 虚拟滚动已移除的节点直接跳过
      unlock(el);
      processed += 1;
      const kids = el.children;
      for (let i = 0; i < kids.length; i += 1) {
        enqueue(kids[i] as Element);
      }
    }

    if (queue.length > 0) scheduleWork();
  }

  function scheduleWork(): void {
    if (scheduled || stopped) return;
    scheduled = true;
    const run = () => workSlice();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function fullScan(): void {
    if (!container) return;
    queue = [];
    enqueue(container);
    scheduleWork();
  }

  /**
   * 整树补扫：清掉全部标记后从容器重新入队，显式调度扫描。
   * reset() 会把待检队列一并清空，此时直接 flush() 因队列为空不会调度任何
   * 扫描（旧版 overflow / resize 分支在此静默失效：标记被清掉但从未重扫）。
   */
  function fullRescan(): void {
    reset();
    if (ensureContainer()) fullScan();
  }

  /**
   * 同步 isActive 状态，返回当前是否激活。
   * - 由开转关：撤销全部标记 —— 宽度覆盖已失效，留着的标记只会让后续判断失真；
   * - 由关转开：整树补扫 —— 关闭期间新增的锁宽元素从未被检视过，增量路径
   *   也补不回来（队列在关闭时已被清空）。
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
        // 宽度变化超过容差才整树复位重扫（普通布局抖动不触发）
        if (Math.abs(w - scannedWidth) > opts.tolerance) {
          scannedWidth = w;
          reset();
          fullScan();
        }
      });
      resizeObserver.observe(container);
    }
    scannedWidth = container.clientWidth;
    fullScan();
    return container;
  }

  function flush(): void {
    if (stopped) return;
    if (!ensureActive()) return;
    if (ensureContainer() && queue.length > 0) scheduleWork();
  }

  return {
    /** 启动：立即扫描一次，并订阅共享 DOM 变更池做增量扫描 */
    start(): void {
      stopped = false;
      // 初始状态先与调用方对齐，避免首帧就产生一次无谓的「关 → 开」补扫
      active = opts.isActive();
      flush();
      domContentLoadedHandler = () => flush();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', domContentLoadedHandler, { once: true });
      }
      // 增量：订阅 dom-watch 单例共享的新增节点池
      unsubscribe = onDomChanged(({ added, overflow: hadOverflow }) => {
        if (stopped) return;
        // 调用方可能在不触发 DOM 变更的情况下切换激活状态（菜单开关 / 路由
        // 切换），这里兜底同步一次：非激活直接返回，关 → 开则整树补扫。
        if (!ensureActive()) return;
        // overflow 说明单批新增超上限、池可能丢节点：宽列布局下宁可整树补扫一次
        if (hadOverflow) {
          fullRescan();
          return;
        }
        // 主列被 React 整体替换（SPA 导航重挂 app shell）时旧容器已脱离文档：
        // 此时 added 里的新节点都不在旧容器内，增量分支会把它们全部跳过，
        // 解锁器会静默失效到下一次 resize —— 重新锁定新主列并整树补扫。
        if (!container || !container.isConnected) {
          fullRescan();
          return;
        }
        let any = false;
        for (const node of added) {
          if (!node.isConnected) continue;
          // 只关心主列内部的节点
          if (container && !container.contains(node)) continue;
          enqueue(node);
          any = true;
        }
        if (any) scheduleWork();
      });
      resizeHandler = () => {
        // 窗口尺寸变化可能让整条宽链失效：清标记并整树补扫（fullRescan 而非
        // reset+flush —— 后者因队列被清空不会调度扫描）
        if (!ensureActive()) return;
        fullRescan();
      };
      window.addEventListener('resize', resizeHandler);
      visibilityHandler = () => {
        if (!document.hidden) flush();
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
      flush();
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
