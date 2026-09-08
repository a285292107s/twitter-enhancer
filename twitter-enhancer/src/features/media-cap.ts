/**
 * 宽列媒体高度钳制（宽时间线真正放宽后生效）。
 *
 * 背景（真机实测 2026-09）：横排轮播的竖长图行有时超过一屏高，必须滚动滚轮
 * 才能完整浏览——800 宽列下实测轮播行高 774~898px（加正文/操作栏后必然超出
 * 一屏）。单图竖长图 X 自己会钳到约 510 高，不在此列。
 *
 * 方案：对「媒体行宿主」只钳 **layout height**，不施加 transform——
 * 实测确认 X 的媒体行（轮播格带内联 aspect-ratio）会按行高自动重排：
 * 792px 高的 2:1 轮播行压到 540 后，格从 425×786 自动变成 289×534，
 * 比例不变、整幅可见、无裁剪、无缩放副作用、scroll-snap 吸附依然准确。
 * 加 transform 反而会双重缩小（height×k 再 scale(k) → 视觉变成原高×k²，
 * 这是上一版在 likes 页「表现不对」的根因），所以只改布局高度这一条路。
 *
 * 1. 宿主 = 从媒体元素向上找到的第一个宽度 ≥ lockWidth 的祖先：宽度下限把
 *    定位抬到「整行」（单图媒体区宽 = 内容列宽；轮播列表宽 = 行宽），而不是
 *    轮播里的某一格；候选层含正文（data-testid=tweetText）则不是媒体区
 *    （是整条推文列），跳过继续上溯；
 * 2. 预算 = min(maxHeight, 视口高 − 220)：保证超高媒体缩到当前屏内整幅可看；
 * 3. 钳制后做一次布局校验：若内容没跟着行高重排（罕见：固定像素高的媒体），
 *    立刻还原、保持 X 原生观感，绝不裁剪/重叠；
 * 4. 只写宿主的 inline height，不插入/移动 React 节点；列宽回落或媒体变小
 *    （自然高 ≤ 预算）后自动解锁还原。
 *
 * 监听策略（性能版，复用 dom-watch 单例）：
 * - 滚动新增/恢复的媒体走共享新增节点池增量处理：dom-watch 冲刷回调只负责
 *   收集节点，扫描 / 钳制推迟到下一个 rAF 帧统一执行 —— 滚动路径上的同步
 *   layout 读（offsetWidth / getBoundingClientRect）是掉帧主因，收进帧任务
 *   后同一帧内的布局读只触发一次 layout，且多个来源可合并；
 * - 宿主挂 ResizeObserver 只按「宽度变化」触发（我们只改高度，不会自触发）；
 * - 图片/视频加载完成只做「宿主粒度对账」：解锁并重测受影响的这一条链，
 *   不做全列 reset+重钳（旧版在首屏图片并发加载时整列媒体反复回流两次）；
 * - 结构性变化（te:layout / te:route / 宿主宽度变化 / 窗口 resize / 回前台
 *   visibilitychange / dom-watch overflow）仍走 120ms 去抖的全量对账。
 */
import { CONFIG } from '../config';
import { registerToggleMenu } from '../lib/menu';
import { readFlag, writeFlag } from '../lib/store';
import { onDomChanged } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';

/** 媒体元素：图片与视频 */
const MEDIA_SELECTOR = '[data-testid="tweetPhoto"],[data-testid="videoPlayer"]';
/** 宿主上记录已钳制 / 已挂 ResizeObserver 的标记 */
const FLAG = 'teMediaCapped';
const OBSERVED = 'teMediaObserved';
const FLAG_SELECTOR = '[data-te-media-capped]';
/** ResizeObserver 触发重算的宽度变化容差（px），过滤普通抖动 */
const RESIZE_TOLERANCE = 10;
/** 对账去抖时长（ms）：图片加载 / 视口变化等高频事件合并为一次全量对账 */
const RECONCILE_DEBOUNCE = 120;
/** 钳制后内容底部允许超出宿主的容差（px）：超出说明内容没跟着重排 */
const CROP_TOLERANCE = 4;

let locked = CONFIG.media.cap;

/**
 * 被我们临时归零的「百分比 padding 比例盒」的原始 padding-bottom。
 * X 用 style="padding-bottom: calc(…%)" 按宽度撑出整组媒体的比例占位
 * （高度与行内格子无关），这类盒子的高度不能靠 height 压掉，必须同时归零
 * padding；解锁时用这里记录的原值还原，避免破坏 React 的样式。
 */
const originalPadding = new WeakMap<HTMLElement, string>();

/** 布局是否处于「需要钳制」的状态：宽时间线开启，且主列真的被放宽（>640px） */
function isActive(): boolean {
  if (document.documentElement.dataset.teTimeline !== 'wide') return false;
  const primary = document.querySelector<HTMLElement>('div[data-testid="primaryColumn"]');
  return !!primary && primary.clientWidth > 640;
}

/** 高度预算：配置上限与「视口内看全」两者取小（小窗口下进一步收紧） */
function heightBudget(): number {
  return Math.max(120, Math.min(CONFIG.media.maxHeight, window.innerHeight - 220));
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
/** 去抖后的全量对账（结构性变化 / 视口变化 / RO 宽度变化时调用） */
function scheduleReconcile(): void {
  if (reconcileTimer !== null) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileMediaCap();
  }, RECONCILE_DEBOUNCE);
}

/* ------------------------------------------------------------------ *
 * 帧任务合并（性能版）
 *
 * dom-watch 的冲刷回调运行在滚动路径上（每 120ms 一批）。任何同步的子树
 * 扫描 / offsetWidth 布局读都会抢主线程并强制 layout，是滚动掉帧的来源。
 * 因此订阅回调只做两件廉价的事：把本批新增节点收进 pendingAdded、把
 * 「加载完成的已钳宿主」收进 pendingLoadedHosts；真正的工作推迟到下一个
 * rAF 帧统一执行（后台标签页 rAF 被冻结时退回 setTimeout），每帧至多跑
 * 一次 —— 帧内多次几何读只触发一次 layout，其余命中浏览器布局缓存。
 * ------------------------------------------------------------------ */
const FALLBACK_FRAME_MS = 16;

let frameQueued = false;
let pendingAdded: Element[] | null = null;
const pendingLoadedHosts = new Set<HTMLElement>();

function queueFrameWork(): void {
  if (frameQueued) return;
  frameQueued = true;
  const run = (): void => {
    frameQueued = false;
    runFrameWork();
  };
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
  else setTimeout(run, FALLBACK_FRAME_MS);
}

function runFrameWork(): void {
  const added = pendingAdded;
  pendingAdded = null;
  if (added && added.length > 0) processAdded(added);
  if (pendingLoadedHosts.size > 0) {
    const hosts = [...pendingLoadedHosts];
    pendingLoadedHosts.clear();
    for (const host of hosts) {
      if (!host.isConnected) continue;
      reconcileHostChain(host);
    }
  }
}

/** 解除单个宿主的钳制（含清理标记、ResizeObserver 与还原 padding） */
function unlockHost(host: HTMLElement): void {
  host.style.removeProperty('height');
  if (originalPadding.has(host)) {
    host.style.paddingBottom = originalPadding.get(host) ?? '';
    originalPadding.delete(host);
  }
  delete host.dataset[FLAG];
  delete host.dataset[OBSERVED];
  resizeObserver?.unobserve(host);
}

/**
 * 宿主粒度对账：媒体加载完成 / 尺寸变化后只解锁并重测这一条宿主链。
 *
 * 旧版对任何变化都做全量 reconcile（先 resetMediaCap 放开全列所有钳制、
 * 再全部重钳）—— 首屏图片并发加载时会反复让整列媒体先回原高再压回预算，
 * 等于每批加载都做两次整列布局回流，肉眼可见地闪。
 * 加载事件只影响自身这条链的自然高（宿主 + 宿主上方一起压的纯媒体祖先
 * 只属于这一个钳制组，见 applyCap 的链式收集与 closest 防嵌套），逐链
 * 解锁重测即可：自然高仍超预算则重新钳制，已回落则保持解锁。
 */
function reconcileHostChain(start: HTMLElement): void {
  if (!locked || !isActive()) return;
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = start;
  while (el && el !== document.body && el.dataset[FLAG]) {
    chain.push(el);
    el = el.parentElement;
  }
  if (chain.length === 0) return;
  for (const item of chain) unlockHost(item);
  // 重新定位真正的行宿主并钳制（applyCap 内会重测自然高，不超预算即保持解锁）
  const host = findHost(start);
  if (host) applyCap(host);
}

/**
 * 媒体行宿主：媒体元素向上第一个宽度 ≥ lockWidth 的祖先，且内部不含正文。
 * 宽度下限保证定位到「整行」（单图媒体区宽 = 内容列宽；轮播列表宽 = 行宽），
 * 而不是轮播里的某一格；含正文的祖先（整条推文列）跳过，避免误缩文字。
 */
function findHost(el: Element): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.body) {
    if (p.offsetWidth >= CONFIG.media.lockWidth) {
      if (!p.querySelector('[data-testid="tweetText"]')) return p;
    }
    p = p.parentElement;
  }
  return null;
}

/**
 * 钳制后的内容底边（相对宿主顶，布局坐标）：读一次同步布局来校验内容是否
 * 随行高重排。校验时宿主应处于钳制后的状态（height 已写入、无 transform）。
 */
function contentBottomAfterClamp(host: HTMLElement): number {
  const top = host.getBoundingClientRect().top;
  let bottom = 0;
  for (const media of host.querySelectorAll(MEDIA_SELECTOR)) {
    const rect = media.getBoundingClientRect();
    if (rect.width <= 0) continue;
    if (rect.bottom - top > bottom) bottom = rect.bottom - top;
  }
  return Math.round(bottom);
}

/**
 * 对单个宿主执行高度钳制（幂等、只缩不放、只改布局高度）。
 *
 * 除宿主本身外，把「宿主与正文列之间的整条纯媒体祖先链」一起压到预算——
 * X 在轮播行与内容列之间常有多层包裹，其中：
 * - 某些层高度由 React 写死；
 * - 最典型的是「百分比 padding 比例盒」（style="padding-bottom: calc(…%)"），
 *   其高度 = 宽×组内比例，与行内格子的实际高度无关——只压行会在这类盒里
 *   留下整段冗余空白。
 * 爬升边界（防误伤）：
 * - 到 article / cellInnerDiv 为止；
 * - 含正文（tweetText）或操作栏（reply/like 等 data-testid）即停，
 *   绝不压缩文字与计数栏。
 * 百分比 padding 盒在压高时把 padding-bottom 临时归零（记录原值、解锁还原）。
 * 钳住后同步校验行内媒体底边：若内容没随行高重排（会超界被裁），整链还原。
 */
function applyCap(host: HTMLElement): void {
  if (!locked || !isActive()) return;
  // 已被外层钳制的宿主不再处理（外层已统一覆盖整行内容）
  if (host.closest(FLAG_SELECTOR)) return;
  const natural = host.offsetHeight;
  if (natural === 0) return;
  // 超过 2.5 屏的宿主不是媒体区（虚拟列表 / 超长占位容器），跳过以防误伤
  if (natural > window.innerHeight * 2.5) return;
  const budget = heightBudget();
  if (natural <= budget) {
    // 自然高度在预算内（列宽回落 / 媒体变小），清掉可能残留的钳制
    if (host.dataset[FLAG]) unlockHost(host);
    return;
  }
  // 已钳住的宿主：offsetHeight 现在返回预算值，直接返回避免重复处理
  if (host.dataset[FLAG]) return;

  // 收集与宿主一起压的纯媒体祖先链（含宿主自身，最多 10 层）
  const run: HTMLElement[] = [host];
  let p = host.parentElement;
  while (p && p !== document.body && run.length < 10) {
    const te = p.getAttribute('data-testid');
    if (p.tagName === 'ARTICLE' || te === 'cellInnerDiv') break;
    if (te === 'primaryColumn' || te === 'sidebarColumn') break;
    if (p.querySelector('[data-testid="tweetText"]')) break;
    if (
      p.querySelector(
        '[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"]',
      )
    ) {
      break;
    }
    run.push(p);
    p = p.parentElement;
  }

  for (const el of run) {
    el.style.height = `${budget}px`;
    // 百分比 padding 比例盒：高度来自 padding，光压 height 无效 → 归零 padding
    if (/calc|%/.test(el.style.paddingBottom ?? '')) {
      if (!originalPadding.has(el)) {
        originalPadding.set(el, el.style.paddingBottom);
      }
      el.style.paddingBottom = '0px';
    }
    el.dataset[FLAG] = '1';
  }
  // 布局校验：内容底边超出预算（且超出容差）说明没有随行高重排，
  // 此时硬压会裁图/重叠 → 整链还原，保持 X 原生观感
  if (contentBottomAfterClamp(host) > budget + CROP_TOLERANCE) {
    for (const el of run) unlockHost(el);
    return;
  }
  if (resizeObserver && !host.dataset[OBSERVED]) {
    resizeObserver.observe(host);
    // 记录钳制时的布局宽度：RO 首次回调与此一致，不会自触发重算
    host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
  }
}

function applyOne(media: Element): void {
  // 已被外层钳制的媒体不再处理
  if (media.closest(FLAG_SELECTOR)) return;
  const host = findHost(media);
  if (!host) return;
  applyCap(host);
}

/** ResizeObserver 回调：只看宽度变化（我们的钳制只改高度，不会自触发） */
function onHostResize(host: HTMLElement): void {
  if (!locked || !isActive()) return;
  const width = Math.round(host.offsetWidth);
  const last = Number(host.dataset[OBSERVED] ?? -1);
  if (Number.isFinite(last) && Math.abs(width - last) < RESIZE_TOLERANCE) return;
  // 行宽真的变了（列宽调整 / 内容变化）：全量对账重测自然高度
  scheduleReconcile();
}

const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) onHostResize(entry.target as HTMLElement);
      })
    : null;

/**
 * 全量对账：先解除所有钳制（重测自然高度），再对当前所有媒体重新钳制。
 * 宿主数量 = 屏上媒体数，代价可忽略；te:layout / te:route / overflow /
 * 宿主宽度变化 / 窗口 resize / 回前台时调用（媒体加载完成走宿主粒度
 * reconcileHostChain，不经过这里，避免整列反复回流）。
 */
function reconcileMediaCap(): void {
  if (!locked || !isActive()) {
    resetMediaCap();
    return;
  }
  resetMediaCap();
  for (const media of document.querySelectorAll(MEDIA_SELECTOR)) {
    if (!media.isConnected) continue;
    const host = findHost(media);
    if (!host) continue;
    applyCap(host);
  }
  // 记录已观察宿主的当前布局宽度，供 RO 宽度变化判定
  for (const host of document.querySelectorAll<HTMLElement>(FLAG_SELECTOR)) {
    host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
  }
}

/** 增量处理：只检视新增节点子树里的媒体（在 rAF 帧任务内调用，见 runFrameWork） */
function processAdded(added: Element[]): void {
  if (!locked || !isActive()) return;
  // 一个媒体可能既作为节点本身出现、又被其祖先的 querySelectorAll 命中，
  // 也可能跨两批 flush 被重复收集：先去重再逐个处理，避免对同一宿主重复钳制
  const seen = new Set<Element>();
  for (const node of added) {
    if (!node.isConnected) continue;
    if (node.matches?.(MEDIA_SELECTOR)) seen.add(node);
    const inside = node.querySelectorAll?.(MEDIA_SELECTOR);
    if (inside) {
      for (const media of inside) {
        if (media.isConnected) seen.add(media);
      }
    }
  }
  for (const media of seen) applyOne(media);
}

/** 撤销所有钳制（功能关闭 / 布局回原生时还原 X 原生观感） */
function resetMediaCap(): void {
  for (const el of document.querySelectorAll(FLAG_SELECTOR)) {
    unlockHost(el as HTMLElement);
  }
}

function toggleCap(): void {
  locked = !locked;
  reconcileMediaCap();
  void writeFlag('media-cap', locked);
}

export function enableMediaCap(): void {
  reconcileMediaCap();
  // 存储读取是异步的，先用默认值渲染，读到用户设置后再覆盖
  void readFlag('media-cap').then((stored) => {
    if (stored !== null && stored !== locked) {
      locked = stored;
      reconcileMediaCap();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reconcileMediaCap, { once: true });
  }
  window.addEventListener('load', reconcileMediaCap, { once: true });

  // 增量：订阅 dom-watch 单例的共享新增节点池（滚动恢复的媒体从这里来）。
  // 冲刷回调只负责收集节点、绝不做事 —— 扫描 / 钳制全部推迟到下一个 rAF
  // 帧统一执行（滚动路径上的同步 layout 读是掉帧主因）。overflow 说明单批
  // 新增超上限、池可能丢节点：结构性缺失，走去抖全量对账兜底。
  onDomChanged(({ added, overflow: hadOverflow }) => {
    if (!locked) return;
    if (hadOverflow) {
      scheduleReconcile();
      return;
    }
    if (added.length === 0) return;
    if (pendingAdded) pendingAdded.push(...added);
    else pendingAdded = added.slice();
    queueFrameWork();
  });

  // 宽时间线开关 / 右栏显隐 / SPA 路由都会重建或移动媒体子树，全量对账一次。
  const onLayout = (): void => {
    if (locked) scheduleReconcile();
  };
  document.addEventListener('te:layout', onLayout);
  onRouteChanged(onLayout);

  // 图片 / 视频加载完成后自然尺寸会变（占位 → 真实比例），媒体行高随之重排：
  // 捕获阶段监听 load / loadeddata，命中已钳宿主时做宿主粒度对账（解锁重测
  // 这一条链），不再像旧版那样触发全列 reset+重钳 —— 首屏图片并发加载时
  // 整列媒体会反复回流两次，肉眼可见地闪。帧任务在下一个 rAF 里合并执行。
  const onMediaLoad = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) return;
    if (!locked) return;
    const flagged = target.closest<HTMLElement>(FLAG_SELECTOR);
    if (!flagged) return;
    pendingLoadedHosts.add(flagged);
    queueFrameWork();
  };
  document.addEventListener('load', onMediaLoad, true);
  document.addEventListener('loadeddata', onMediaLoad, true);
  // 视口高度变化会改变高度预算（maxHeight = min(上限, 视口高−220)）
  window.addEventListener('resize', scheduleReconcile);
  // 后台标签页定时器被冻结：回到前台时主动补一次对账
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && locked) scheduleReconcile();
  });

  registerToggleMenu({
    label: (enabled) =>
      `媒体高度钳制（超高媒体 ≤${CONFIG.media.maxHeight}px 一屏看全）：${enabled ? '开' : '关'}`,
    isEnabled: () => locked,
    toggle: toggleCap,
  });
}
