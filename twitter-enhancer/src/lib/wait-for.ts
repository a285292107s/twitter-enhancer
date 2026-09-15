/**
 * 等条件成立（社区标准做法：control-panel-for-twitter 的 `getElement`），带 `stopIf` 提前放弃。
 *
 * 为什么需要它：X 的 DOM 是「先挂壳、后填内容」，而且**没有页面生命周期事件**可以等 ——
 * 功能要么自己写轮询，要么靠全局 DOM 批次回调反复试探。参考项目的做法是把等待抽成一个
 * Promise：命中就 resolve，`stopIf()` 变真就 resolve `null`（调用方直接 `if (!el) return`，
 * 不必自己判断「这次等待是否已经过期」）。
 *
 * `stopIf` 是本模块存在的理由：SPA 导航后上一次等待的目标可能永远不会出现，
 * 不设终止条件的等待会一直轮询下去，并且**在导航回来时命中一个属于旧页面的元素**。
 * 约定用法是 `pagePathChanged(path)`（见 lib/page.ts）。
 *
 * 两个入口：
 * - `waitFor(probe, options)`：等任意条件（返回真值即命中）。需要「不只是存在、
 *   而且状态正确」时用它 —— 例如时间线要等到「真实滚动层」而不是 X 先挂的占位层
 *   （见 lib/timeline.ts）；
 * - `waitForElement(selector, options)`：`waitFor` 的常见特例。
 *
 * 轮询策略（与本项目其它调度器一致，见 docs/architecture.md「后台标签页」）：
 * - 可见时用 rAF（每帧一次，页面卡住时自然降频，不产生定时器噪声）；
 * - 后台标签页 rAF 被完全冻结，改用 `setTimeout` 轮询（节流到 1s 级别也能很快补上，
 *   而 rAF 是永远不触发）；
 * - 顺序是「先探测、后 stopIf」：目标已经就绪时，不应该因为同一批里路由刚好变了而放弃。
 *
 * 默认不超时（`timeout: 0`）：X 在慢网络下首屏可能十几秒，写死超时只会制造
 * 「偶发不生效」的报告。需要兜底的调用方显式传 `timeout`，语义是「超时后放弃，
 * 不视为错误」（但会打一条 warn —— 那通常意味着选择器失效）。
 */

export interface WaitForOptions {
  /** 调试名：只用于超时日志，例如 'timeline' */
  name?: string;
  /** 返回 true 时立即放弃（resolve null）；约定用 `pagePathChanged(path)` 构造 */
  stopIf?: (() => boolean) | null;
  /** 超时毫秒数；0（默认）= 不超时 */
  timeout?: number;
}

/** 后台标签页的轮询间隔（rAF 被冻结时使用） */
const BACKGROUND_POLL_MS = 100;

/**
 * 等 `probe()` 返回真值（元素、非空字符串等）。命中返回该值；`stopIf` 命中或超时返回 `null`。
 */
export function waitFor<T>(probe: () => T | null | false | undefined, options: WaitForOptions = {}): Promise<T | null> {
  const { name = 'condition', stopIf = null, timeout = 0 } = options;
  return new Promise<T | null>((resolve) => {
    const startTime = Date.now();
    let rafId = 0;
    let timerId: ReturnType<typeof setTimeout> | null = null;
    let settled = false;

    // 「因为路由切走而放弃」是正常路径，不打日志（每次导航都会有一次）；
    // 只有真正超时才留线索 —— 那通常意味着选择器失效，是需要排查的信号。
    const stop = (value: T | null, reason: 'found' | 'stopIf' | 'timeout'): void => {
      if (settled) return;
      settled = true;
      if (rafId) cancelAnimationFrame(rafId);
      if (timerId !== null) clearTimeout(timerId);
      if (reason === 'timeout') console.warn(`[twitter-enhancer] 等待 ${name} 超时（${timeout}ms）`);
      resolve(value);
    };

    const tick = (): void => {
      if (settled) return;
      const value = probe();
      if (value) {
        stop(value, 'found');
        return;
      }
      if (stopIf?.() === true) {
        stop(null, 'stopIf');
        return;
      }
      if (timeout > 0 && Date.now() - startTime >= timeout) {
        stop(null, 'timeout');
        return;
      }
      if (document.hidden || typeof requestAnimationFrame !== 'function') {
        timerId = setTimeout(tick, BACKGROUND_POLL_MS);
      } else {
        rafId = requestAnimationFrame(tick);
      }
    };

    // 同步先探测一次：条件已经成立时不要白白等一帧 —— 调用方紧接着读 DOM 也不会读到旧状态
    tick();
  });
}

/** 等 `selector` 命中的第一个元素出现（`context` 默认 document） */
export function waitForElement<T extends Element = HTMLElement>(
  selector: string,
  options: WaitForOptions & { context?: ParentNode } = {},
): Promise<T | null> {
  const { context = document, name = selector, ...rest } = options;
  return waitFor<T>(() => context.querySelector<T>(selector), { ...rest, name });
}
