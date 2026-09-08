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
 *    由 CSS 放开到 100%。
 */

import { onDomChanged } from './dom-watch';

/** 打在元素上的标记属性名（data-te-width-unlocked） */
const FLAG = 'teWidthUnlocked';

export interface UnlockOptions {
  /** 被写死的宽度区间 [min, max]（px），只有落在该区间内的固定宽度才视为锁死 */
  lockedRange?: [number, number];
  /** 容器宽度与元素宽度的差值超过该值才处理，避免误伤宽度接近容器正常元素 */
  tolerance?: number;
  /** 单帧最多处理的元素数（时间片大小，越小越不抢主线程，完成越慢） */
  sliceSize?: number;
  /** 待检队列上限，防止虚拟滚动下无界增长 */
  maxQueue?: number;
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
  function rescanAll(): void {
    reset();
    if (ensureContainer()) fullScan();
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
    if (ensureContainer() && queue.length > 0) scheduleWork();
  }

  return {
    /** 启动：立即扫描一次，并订阅共享 DOM 变更池做增量扫描 */
    start(): void {
      stopped = false;
      flush();
      domContentLoadedHandler = () => flush();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', domContentLoadedHandler, { once: true });
      }
      // 增量：订阅 dom-watch 单例共享的新增节点池
      unsubscribe = onDomChanged(({ added, overflow: hadOverflow }) => {
        if (stopped) return;
        // overflow 说明单批新增超上限、池可能丢节点：宽列布局下宁可整树补扫一次
        if (hadOverflow) {
          rescanAll();
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
        // 窗口尺寸变化可能让整条宽链失效：清标记并整树补扫（rescanAll 而非
        // reset+flush —— 后者因队列被清空不会调度扫描）
        rescanAll();
      };
      window.addEventListener('resize', resizeHandler);
      visibilityHandler = () => {
        if (!document.hidden) flush();
      };
      document.addEventListener('visibilitychange', visibilityHandler);
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
