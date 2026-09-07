/**
 * 宽度解锁器。
 *
 * 问题：X 用哈希 class（css-xxxx）给时间线 / 推文容器写死 `max-width: 600px`，
 * 选择器无法稳定命中，且不同页面（首页、推文详情、用户主页）的层级各不相同。
 *
 * 方案：不猜选择器，直接按「计算后的固定宽度值」识别被锁死的容器，
 * 给它打上 `data-te-width-unlocked` 属性，由 CSS 统一把宽度放开到 100%。
 * 这样即使 X 改 class 名或调整 DOM 层级，只要限宽值不变，脚本依然生效。
 */

/** 打在元素上的标记属性名（data-te-width-unlocked） */
const FLAG = 'teWidthUnlocked';

export interface UnlockOptions {
  /** 被写死的宽度区间 [min, max]（px），只有落在该区间内的固定宽度才视为锁死 */
  lockedRange?: [number, number];
  /** 容器宽度与元素宽度的差值超过该值才处理，避免误伤宽度接近容器正常元素 */
  tolerance?: number;
  /** 单次扫描的最大元素数，超出则只处理前 N 个，防止长列表卡顿 */
  maxScan?: number;
}

/** 判断某个计算值是否为「写死的像素宽度且明显窄于容器」 */
function isLockedValue(value: string, containerWidth: number, opts: Required<UnlockOptions>): boolean {
  if (!value.endsWith('px')) return false;
  const n = Number.parseFloat(value);
  if (Number.isNaN(n) || n <= 0) return false;
  const [min, max] = opts.lockedRange;
  return n >= min && n <= max && containerWidth - n >= opts.tolerance;
}

/**
 * 创建一个容器宽度解锁器。
 * @param containerSelector 需要解锁的容器（如时间线主列）选择器
 */
export function createWidthUnlocker(containerSelector: string, options: UnlockOptions = {}) {
  const opts: Required<UnlockOptions> = {
    lockedRange: options.lockedRange ?? [560, 660],
    tolerance: options.tolerance ?? 40,
    maxScan: options.maxScan ?? 4000,
  };

  /** 已被处理过的元素，重置时用于清除标记（元素可能已被移除，故存放强引用后过滤） */
  let touched: HTMLElement[] = [];
  let container: HTMLElement | null = null;
  let pending: Node[] = [];
  let scheduled = false;
  let resizeObserver: ResizeObserver | null = null;
  /** 是否已完成过一次覆盖整个容器的扫描（容器更换后需重新置为 false） */
  let fullScanDone = false;

  /** 清除所有已打标记，使后续可重新计算（例如容器宽度变化后） */
  function reset(): void {
    for (const el of touched) {
      delete el.dataset[FLAG];
    }
    touched = [];
    // 容器变化后原有判定失效，需要重新做一次全量扫描
    fullScanDone = false;
  }

  function unlock(el: HTMLElement, containerWidth: number): void {
    if (el.dataset[FLAG]) return;
    const style = getComputedStyle(el);
    const widthLocked = isLockedValue(style.width, containerWidth, opts);
    const maxLocked = isLockedValue(style.maxWidth, containerWidth, opts);
    if (!widthLocked && !maxLocked) return;
    el.dataset[FLAG] = widthLocked ? 'fixed' : 'max';
    touched.push(el);
  }

  function scan(root: ParentNode, containerWidth: number): void {
    const targets: HTMLElement[] = [];
    if (root instanceof HTMLElement) targets.push(root);
    targets.push(...root.querySelectorAll<HTMLElement>('*'));
    const limit = Math.min(targets.length, opts.maxScan);
    for (let i = 0; i < limit; i += 1) {
      unlock(targets[i], containerWidth);
    }
  }

  /** 主流程：确保容器存在 → 扫描容器本身 + 待处理的新增节点 */
  function flush(): void {
    scheduled = false;

    if (!container || !container.isConnected) {
      container = document.querySelector<HTMLElement>(containerSelector);
      if (!container) return;
      reset();
      resizeObserver?.disconnect();
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver(() => {
          if (!container) return;
          reset();
          scan(container, container.clientWidth);
        });
        resizeObserver.observe(container);
      }
    }

    const containerWidth = container.clientWidth;
    if (containerWidth <= 0) return;

    // 首次扫描必须覆盖整个容器：若启动瞬间页面就有新增节点（例如其他功能插入 DOM），
    // 增量分支会把全量扫描挤掉，导致初始内容识别不到。
    if (!fullScanDone || pending.length === 0) {
      scan(container, containerWidth);
      fullScanDone = true;
      if (pending.length === 0) return;
    }

    const nodes = pending;
    pending = [];
    for (const node of nodes) {
      if (node.nodeType !== Node.ELEMENT_NODE && node.nodeType !== Node.DOCUMENT_FRAGMENT_NODE) continue;
      if (!node.isConnected) continue;
      scan(node as ParentNode, containerWidth);
    }
  }

  function schedule(nodes?: Node[]): void {
    if (nodes?.length) pending.push(...nodes);
    if (scheduled) return;
    scheduled = true;
    const run = () => flush();
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
    else setTimeout(run, 16);
  }

  function onMutation(mutations: MutationRecord[]): void {
    const added: Node[] = [];
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => added.push(node));
    }
    schedule(added.length ? added : undefined);
  }

  return {
    /** 启动：立即扫描一次，并监听后续 DOM 新增与容器尺寸变化 */
    start(): void {
      schedule();
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => schedule(), { once: true });
      }
      new MutationObserver(onMutation).observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      window.addEventListener('resize', () => {
        reset();
        schedule();
      });
    },
    /** 停止并还原所有改动 */
    stop(): void {
      resizeObserver?.disconnect();
      resizeObserver = null;
      reset();
      container = null;
    },
  };
}
