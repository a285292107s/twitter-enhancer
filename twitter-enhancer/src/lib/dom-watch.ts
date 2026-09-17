/**
 * 全局 DOM 观察调度器（单例）。
 *
 * 旧版每个功能（宽度解锁、时间线重算……）各自注册一个监听
 * document.documentElement 的 subtree MutationObserver。X 的虚拟滚动会在滚动时
 * 高频增删节点，同一批变更被 N 个观察器重复派发，回调又各自触发全量扫描 /
 * 重建 —— 浪费且掉帧。
 *
 * 这里收敛为全站唯一的 childList+subtree 观察器：
 * - mutation 回调只做三件廉价的事：累计计数、保留前若干条记录做采样、
 *   把新增的 Element 加入共享池（供宽度解锁器增量消费）；
 * - 派发经 setTimeout 节流（后台标签页 rAF 会被冻结，故不用 rAF），
 *   visibilitychange 回前台时再补一次冲刷；
 * - **例外（快路径）**：SPA 导航会整棵重挂 app shell，主列 / 三栏行 / 左栏换成新节点，
 *   各功能写在这些节点上的内联样式随之丢失。若等 120ms 节流再补写，用户会看到
 *   「主列突然左移又回弹、左栏跳位」的闪烁（实测见 structuralAnchorChanged）。
 *   锚点节点身份变化时在 MO 回调里同步冲刷（早于渲染帧），其余变更照旧节流。
 * - 订阅方在各自回调里只处理自己的逻辑。
 *
 * 注意：主题跟随（features/theme.ts）仍需监听 html/body 的 style/class 属性变化，
 * 那属于「按属性过滤、只观察两个元素」的窄观察器，不在本单例覆盖范围，
 * 也不造成滚动开销（childList 才是滚动时的噪声来源）。
 */

import { SEL, LOGO_SELECTOR } from './selectors';

export interface DomWatchDetail {
  /** 本批次累计的 mutation 记录数 */
  count: number;
  /** 前若干条记录的采样（订阅方按需查看类型） */
  samples: MutationRecord[];
  /** 本批次新增的 Element（已过滤非元素节点、已去重） */
  added: Element[];
  /** 新增元素数量超出共享池上限，可能丢节点（订阅方决定是否整树兜底重扫） */
  overflow: boolean;
  /**
   * 本批次是否含「锚点节点身份变化」：主列 / 三栏行 / 左栏 logo / 右栏被 React
   * 整体替换（SPA 导航重挂 app shell 的典型特征）。为 true 时该批次已同步冲刷，
   * 订阅方写在节点上的内联样式必须在本回调内重写（否则新节点会先按 X 原生布局绘制）。
   */
  structural: boolean;
}

export type DomWatchListener = (detail: DomWatchDetail) => void;

const FLUSH_MS = 120;
/** 单批次新增节点池上限，超出视为 overflow（防虚拟滚动下无界增长） */
const ADDED_POOL_LIMIT = 3000;
/** 采样保留条数 */
const SAMPLE_LIMIT = 8;

/**
 * 结构性锚点：各功能把补偿样式写成「内联样式」挂在这些节点上
 * （三栏行的 justify-content / min-width、右栏的 margin-left）。
 * X 的 SPA 导航会整棵卸载并重挂 app shell —— 这些节点全部换成新节点，
 * 内联样式随之丢失。
 *
 * logo 只是「导航条也被重建了」的廉价探针；左导航条本身的位置由 X 自己
 * fixed 定位，脚本一个字节都不写（见 features/sidebar.ts）。
 */
const PRIMARY_SELECTOR = SEL.primaryColumn;
const SIDEBAR_SELECTOR = SEL.sidebarColumn;

let lastPrimary: Element | null = null;
let lastSidebar: Element | null = null;
let lastRow: Element | null = null;
let lastLogo: Element | null = null;

/**
 * 锚点节点身份是否变化（被 React 替换 / 增删）。
 *
 * 为什么必须单独判定：若等 120ms 节流批次再重写样式，用户会看到明显闪烁 ——
 * 2026-09 真机实测（1440×900，时间线点进详情推文）：新三栏行在 t+546ms 挂载时
 * 还是 X 原生布局，t+687ms 才被改成本脚本的锚定布局，也就是「先按 X 原生画一帧再回弹」。
 *
 * 每次只做三个 querySelector + 一次 parentElement 读取；主列在文档序里靠前，
 * 命中即返回。滚动时（虚拟列表增删推文）这些引用都不变，不会走快路径。
 */
function structuralAnchorChanged(): boolean {
  const primary = document.querySelector(PRIMARY_SELECTOR);
  const sidebar = document.querySelector(SIDEBAR_SELECTOR);
  const row = primary?.parentElement ?? null;
  const logo = document.querySelector(LOGO_SELECTOR);
  if (
    primary === lastPrimary &&
    sidebar === lastSidebar &&
    row === lastRow &&
    logo === lastLogo
  ) {
    return false;
  }
  lastPrimary = primary;
  lastSidebar = sidebar;
  lastRow = row;
  lastLogo = logo;
  return true;
}

let started = false;
let timer: ReturnType<typeof setTimeout> | null = null;
let observer: MutationObserver | null = null;

let count = 0;
let samples: MutationRecord[] = [];
let addedPool: Element[] = [];
let overflow = false;
/** 本批次是否含「锚点节点身份变化」（由 MO 回调设置，冲刷后清零） */
let structuralPending = false;
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
    structural: structuralPending,
  };
  count = 0;
  samples = [];
  addedPool = [];
  overflow = false;
  structuralPending = false;
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
      // 结构性替换必须抢在渲染帧之前补写样式（MO 回调在本次变更的微任务检查点执行，
      // 早于样式计算与绘制）：同步冲刷，避免主列 / 左栏在首帧跳位后再回弹。
      // 普通变更（滚动插入推文等）仍走 120ms 节流批次。
      if (structuralAnchorChanged()) {
        structuralPending = true;
        flushDomWatch();
      } else {
        scheduleFlush();
      }
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

/** 立即冲刷当前未派发的批次（MO 快路径与回前台兜底都用它） */
function flushDomWatch(): void {
  if (timer !== null) {
    clearTimeout(timer);
    timer = null;
  }
  flush();
}

/**
 * 广播「主列 / 右栏 / 时间线几何可能已变化」。
 * 由宽时间线重算、右栏显隐后触发，供右栏锚定与媒体重算订阅。
 * 保留 CustomEvent('te:layout') 名称，与既有页面内监听兼容。
 */
export function dispatchLayoutEvent(): void {
  try {
    document.dispatchEvent(new CustomEvent('te:layout'));
  } catch {
    // 极早期 document 未就绪时忽略
  }
}
