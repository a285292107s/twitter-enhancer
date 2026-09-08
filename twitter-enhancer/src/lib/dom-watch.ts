/**
 * 全局 DOM 观察调度器（单例）。
 *
 * 旧版每个功能（宽度解锁、右栏搜索、时间线重算）各自注册一个监听
 * document.documentElement 的 subtree MutationObserver。X 的虚拟滚动会在滚动时
 * 高频增删节点，同一批变更被 N 个观察器重复派发，回调又各自触发全量扫描 /
 * 重建 —— 浪费且掉帧。
 *
 * 这里收敛为全站唯一的 childList+subtree 观察器：
 * - mutation 回调只做三件廉价的事：累计计数、保留前若干条记录做采样、
 *   把新增的 Element 加入共享池（供宽度解锁器增量消费）；
 * - 派发经 setTimeout 节流（后台标签页 rAF 会被冻结，故不用 rAF），
 *   visibilitychange 回前台时再补一次冲刷；
 * - 订阅方在各自回调里只处理自己的逻辑。
 *
 * 注意：主题跟随（tweet-ui）仍需监听 html/body 的 style/class 属性变化，
 * 那属于「按属性过滤、只观察两个元素」的窄观察器，不在本单例覆盖范围，
 * 也不造成滚动开销（childList 才是滚动时的噪声来源）。
 */

export interface DomWatchDetail {
  /** 本批次累计的 mutation 记录数 */
  count: number;
  /** 前若干条记录的采样（订阅方按需查看类型） */
  samples: MutationRecord[];
  /** 本批次新增的 Element（已过滤非元素节点、已去重） */
  added: Element[];
  /** 新增元素数量超出共享池上限，可能丢节点（订阅方决定是否整树兜底重扫） */
  overflow: boolean;
}

export type DomWatchListener = (detail: DomWatchDetail) => void;

const FLUSH_MS = 120;
/** 单批次新增节点池上限，超出视为 overflow（防虚拟滚动下无界增长） */
const ADDED_POOL_LIMIT = 3000;
/** 采样保留条数 */
const SAMPLE_LIMIT = 8;

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;

let count = 0;
let samples: MutationRecord[] = [];
let addedPool: Element[] = [];
let overflow = false;
const listeners = new Set<DomWatchListener>();

function scheduleFlush(): void {
  if (timer !== null) return;
  timer = setTimeout(() => {
    timer = null;
    flush();
  }, FLUSH_MS);
}

function flush(): void {
  if (count === 0 && addedPool.length === 0) return;
  const detail: DomWatchDetail = {
    count,
    samples,
    added: addedPool,
    overflow,
  };
  count = 0;
  samples = [];
  addedPool = [];
  overflow = false;
  for (const listener of [...listeners]) {
    try {
      listener(detail);
    } catch (error) {
      console.error('[twitter-enhancer] dom-watch 订阅方执行失败', error);
    }
  }
}

/**
 * 启动单例观察器（幂等）。document-start 时 documentElement 一定存在。
 * 在 main.ts 里、启用各功能之前调用一次。
 */
export function startDomWatch(): void {
  if (started) return;
  started = true;
  try {
    observer = new MutationObserver((records) => {
      count += records.length;
      for (const record of records) {
        if (samples.length < SAMPLE_LIMIT) samples.push(record);
        for (const node of record.addedNodes) {
          if (!(node instanceof Element)) continue;
          if (addedPool.length >= ADDED_POOL_LIMIT) {
            overflow = true;
            continue;
          }
          addedPool.push(node);
        }
      }
      scheduleFlush();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    // 回前台时若观察器因后台冻结未及时冲刷，补一次
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) flushDomWatch();
    });
  } catch (error) {
    console.error('[twitter-enhancer] 无法建立 DOM 观察器', error);
    observer = null;
  }
}

/** 订阅一次合并后的 DOM 变更批次；返回取消函数 */
export function onDomChanged(listener: DomWatchListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** 立即冲刷当前未派发的批次（回前台兜底 / 测试用） */
export function flushDomWatch(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}

/**
 * 广播「主列 / 右栏 / 时间线几何可能已变化」。
 * 由宽时间线重算、右栏显隐后触发，供左栏 / 右栏锚定与媒体重算订阅。
 * 保留 CustomEvent('te:layout') 名称，与既有页面内监听兼容。
 */
export function dispatchLayoutEvent(): void {
  try {
    document.dispatchEvent(new CustomEvent('te:layout'));
  } catch {
    // 极早期 document 未就绪时忽略
  }
}
