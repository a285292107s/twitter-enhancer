/**
 * 内容列排版：版心、Hero、轮播序号。
 *
 * 为什么单独成模块（而不是继续堆在皮肤层里）：皮肤层的规则是纯 CSS 的属性门控，
 * 本模块是「排版层」—— 它要**读内容**再写属性，属于有状态的 DOM 逻辑。
 *
 * 两件事，全部只写属性、不插节点、不搬节点：
 * 1. 版心 / Hero：正文与操作栏收进 764px 版心（`--te-spine`，见 features/theme.css）；
 *    焦点帖（详情页 URL 里那条）打 data-te-hero、它的 cell 打 data-te-hero-cell，
 *    CSS 据此把主角立起来（结构色带 + 更大上内边距）。
 *    判据用「article 里有 a[href] 的路径 === location.pathname」——2026-09-14 真机实测：
 *    焦点帖命中、同页 45 条回复全部不命中。
 * 2. 轮播序号：多图轮播在媒体宿主上写 data-te-carousel="3/4"，
 *    CSS 用 ::after + attr() 画角标；滚动时只改属性值，不插节点。
 *
 * 曾经还有一件「内容语义分类」（emoji / 短句 / 长文分档，供短帖大字号用），
 * 随该开关一并移除。
 *
 * 监听策略（与 media-cap 同一套）：dom-watch 的合并批次回调只**收集**命中的
 * article（滚动路径上不做子树扫描与布局读），真正的定位推迟到下一个 rAF
 * 帧统一执行；结构性变化（te:layout / 路由 / overflow / load）走整树补扫。
 */
import { CONFIG } from '../config';
import { createToggle } from '../lib/toggle';
import { createFrameQueue } from '../lib/frame-work';
import { onDomChanged } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import { currentStatusPath } from '../lib/page';
import { onTimelineChanged } from '../lib/timeline';
import { SEL } from '../lib/selectors';
import './content-column.css';

const TWEET_SELECTOR = SEL.tweet;
const TEXT_SELECTOR = SEL.tweetText;
const SNAP_SELECTOR = SEL.scrollSnapList;
const CELL_SELECTOR = SEL.cell;

const CAROUSEL_ATTR = 'teCarousel';
const HERO_ATTR = 'teHero';
const HERO_CELL_ATTR = 'teHeroCell';

/** 轮播宿主向上查找的最大层数（防在异常 DOM 上爬太远） */
const HOST_MAX_DEPTH = 6;

/** 内容列排版的当前值 —— 与 createToggle 同步的镜像（理由见 timeline-width.ts 同类注释） */
let enabled = CONFIG.column.enabledByDefault;
/** 轮播序号的当前值 —— 同上。它自己一个开关：角标是本项目**新增**的视觉元素，不是 X 原生 */
let carouselIndexOn = CONFIG.column.carouselIndex;

/* ------------------------------------------------------------------ *
 * 帧任务合并：批次回调只收集，工作在下一个渲染帧里做。
 * 队列本身（同帧合并 / 没有 rAF 时退回 setTimeout）由 lib/frame-work.ts 提供；
 * 本模块的增量批次与整树补扫共用同一个队列、同一帧（分支见 runFrameWork）。
 * ------------------------------------------------------------------ */
const frameQueue = createFrameQueue('content-column');
let pendingArticles: Set<HTMLElement> | null = null;
let fullScanPending = false;

function runFrameWork(): void {
  if (!enabled) return;
  if (fullScanPending) {
    fullScanPending = false;
    pendingArticles = null;
    scanAll();
    return;
  }
  const batch = pendingArticles;
  pendingArticles = null;
  if (!batch) return;
  for (const article of batch) {
    if (article.isConnected) processArticle(article);
  }
}

function scheduleFullScan(): void {
  fullScanPending = true;
  frameQueue.schedule('work', runFrameWork);
}

/* ------------------------------------------------------------------ *
 * 标记
 * ------------------------------------------------------------------ */

/**
 * 焦点帖判定：article 里存在指向当前路径的链接（时间戳 / 图片链接都指向它）。
 * 用 getAttribute 直接比较字符串，避免为每篇推文构造 URL 对象。
 * 路径由 `lib/page.ts` 的 `currentStatusPath()` 给出（非详情页为 null）。
 */
function markHero(article: HTMLElement, path: string | null): void {
  if (!path) return;
  let hit = false;
  for (const anchor of article.querySelectorAll('a[href]')) {
    const href = anchor.getAttribute('href');
    if (href && href.split('?')[0] === path) {
      hit = true;
      break;
    }
  }
  if (!hit) return;
  article.dataset[HERO_ATTR] = '1';
  const cell = article.closest<HTMLElement>(CELL_SELECTOR);
  if (cell) cell.dataset[HERO_CELL_ATTR] = '1';
}

function clearHeroMarks(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-te-hero]')) {
    delete el.dataset[HERO_ATTR];
  }
  for (const el of document.querySelectorAll<HTMLElement>('[data-te-hero-cell]')) {
    delete el.dataset[HERO_CELL_ATTR];
  }
}

/**
 * 轮播宿主：轮播列表之上第一个「宽 ≥ lockWidth 且内部无正文」的祖先
 * （与 media-cap 的 findHost 同一判据，但从列表自身之上起算，避免把
 * 滚动容器本身设为定位上下文 —— 那样角标会跟着内容滚走）。
 * 上溯到本条推文的 article 为止：无正文的纯媒体帖里 article 也满足宽度条件，
 * 若不停会导致角标跑到整条推文的右上角。
 */
function findCarouselHost(list: HTMLElement): HTMLElement | null {
  const stop = list.closest('article');
  let node = list.parentElement;
  for (let depth = 0; node && node !== document.body && node !== stop && depth < HOST_MAX_DEPTH; depth += 1) {
    if (node.offsetWidth >= CONFIG.media.lockWidth && !node.querySelector(TEXT_SELECTOR)) return node;
    node = node.parentElement;
  }
  return null;
}

/** 已挂过滚动监听的轮播列表 */
const wiredLists = new WeakSet<HTMLElement>();

/**
 * 序号 = 左缘（RTL 下为右缘）离列表可视起点最近的那一格。
 * 用 getBoundingClientRect 而不是 offsetLeft：宿主被设成 position: relative 后
 * offsetLeft 的参照系与 scrollLeft 不再一致。
 */
function updateCarouselIndex(list: HTMLElement, host: HTMLElement): void {
  const tiles = list.children;
  if (tiles.length < 2) return;
  const listRect = list.getBoundingClientRect();
  const rtl = getComputedStyle(list).direction === 'rtl';
  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let i = 0; i < tiles.length; i += 1) {
    const rect = tiles[i].getBoundingClientRect();
    const distance = rtl ? Math.abs(rect.right - listRect.right) : Math.abs(rect.left - listRect.left);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  const label = `${best + 1}/${tiles.length}`;
  if (host.dataset[CAROUSEL_ATTR] !== label) host.dataset[CAROUSEL_ATTR] = label;
}

/**
 * 序号更新排进同一个帧队列，用**列表元素本身**当去重 key：
 * 同一个列表在同一帧里被滚动事件更新多次时，只有最后那次的宿主会被采用。
 * （旧实现用 `indexTargets: Map<列表 → 宿主>` + 独立的 `indexFrameQueued` 表达同一件事，
 * 于是本模块里有两个互不相干的帧队列，见 lib/frame-work.ts 文件头。）
 */
function scheduleCarouselIndex(list: HTMLElement, host: HTMLElement): void {
  frameQueue.schedule(list, () => {
    if (enabled && carouselIndexOn && host.isConnected) updateCarouselIndex(list, host);
  });
}

function markCarousel(article: HTMLElement): void {
  if (!carouselIndexOn) return;
  const list = article.querySelector<HTMLElement>(SNAP_SELECTOR);
  if (!list || list.children.length < 2) return;
  const host = findCarouselHost(list);
  if (!host) return;
  if (!wiredLists.has(list)) {
    wiredLists.add(list);
    // passive：滚动路径上只登记目标，真正的测量在 rAF 帧里做
    list.addEventListener('scroll', () => scheduleCarouselIndex(list, host), { passive: true });
  }
  scheduleCarouselIndex(list, host);
}

function processArticle(article: HTMLElement): void {
  markHero(article, currentStatusPath());
  markCarousel(article);
}

/** 整树补扫：先清掉焦点帖标记（SPA 导航后旧焦点帖可能已不是焦点），再逐条处理 */
function scanAll(): void {
  clearHeroMarks();
  const path = currentStatusPath();
  for (const article of document.querySelectorAll<HTMLElement>(TWEET_SELECTOR)) {
    markHero(article, path);
    markCarousel(article);
  }
}

/** 从 dom-watch 的新增节点池里收集 article（含自身、祖先、子树三种命中方式） */
function collectArticles(added: Element[], into: Set<HTMLElement>): void {
  for (const node of added) {
    if (!node.isConnected) continue;
    if (node.matches?.(TWEET_SELECTOR)) into.add(node as HTMLElement);
    else {
      const owner = node.closest?.(TWEET_SELECTOR);
      if (owner) into.add(owner as HTMLElement);
    }
    for (const article of node.querySelectorAll?.(TWEET_SELECTOR) ?? []) {
      into.add(article as HTMLElement);
    }
  }
}

/** 清掉本模块写过的全部属性（关闭开关 / 交回 X 原生） */
function clearMarks(): void {
  const selector = '[data-te-hero],[data-te-hero-cell],[data-te-carousel]';
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    delete el.dataset[HERO_ATTR];
    delete el.dataset[HERO_CELL_ATTR];
    delete el.dataset[CAROUSEL_ATTR];
  }
}

/** 只清轮播序号（单个子开关关闭时用，不动焦点帖标记） */
function clearCarouselIndex(): void {
  for (const el of document.querySelectorAll<HTMLElement>('[data-te-carousel]')) {
    delete el.dataset[CAROUSEL_ATTR];
  }
}

/* ------------------------------------------------------------------ *
 * 开关与令牌
 * ------------------------------------------------------------------ */

/**
 * 版心（`--te-spine`）是共享令牌，定义在 features/theme.css 的 `:root`（764px）。
 * 本模块只是消费方（CSS 里 `max-width: var(--te-spine)`），不测量、不反推。
 * 曾经由写 `--te-measure` 的那一层按正文的 72ch 解析结果覆盖它；推文新样式移除后
 * 正文不再限宽、测量失去样本，版心回到静态值。
 */
function applyTokens(): void {
  document.documentElement.style.setProperty('--te-action-gap', `${CONFIG.column.actionGap}px`);
}

function applyEnabled(value: boolean): void {
  enabled = value;
  document.documentElement.dataset.teColumn = value ? 'on' : 'off';
  if (value) scheduleFullScan();
  else clearMarks();
}

/**
 * 轮播序号开关生效。
 *
 * 关掉时要把已写下的 `data-te-carousel` 清掉（CSS 里也有它自己的属性门控，
 * 但留着属性会让「关掉」这件事只成立在 CSS 一侧，回来时又得靠一次全量补扫才对齐）；
 * 打开时整树补扫一次，把已经渲染好的轮播重新打上角标。
 */
function applyCarouselIndex(value: boolean): void {
  carouselIndexOn = value;
  document.documentElement.dataset.teCarouselIndex = value ? 'on' : 'off';
  if (value) scheduleFullScan();
  else clearCarouselIndex();
}

export function enableContentColumn(): void {
  applyTokens();
  // 开关：默认值 / 存储读取 / 写盘 / 面板登记与刷新全部交给 createToggle（见 lib/toggle.ts）。
  // 构造时的第一次 apply 会走 applyEnabled，也就是首帧那次整树补扫。
  createToggle({
    id: 'content-column',
    group: '内容',
    label: '内容列排版',
    description: '操作栏收进 764px 版心、焦点帖加结构分隔',
    default: CONFIG.column.enabledByDefault,
    apply: applyEnabled,
  });
  // 子开关：面板行序紧跟主开关。它与主开关相互独立，但主开关关掉时一并失效
  // （CSS 规则同时挂在 data-te-column 与子属性下）。
  createToggle({
    id: 'carousel-index',
    group: '内容',
    label: '轮播序号',
    description: '多图轮播右上角显示 3/4 角标（本脚本新增的元素，X 原生没有）',
    default: CONFIG.column.carouselIndex,
    apply: applyCarouselIndex,
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scheduleFullScan, { once: true });
  }
  window.addEventListener('load', scheduleFullScan, { once: true });

  // 增量：滚动恢复 / 懒加载出来的推文从共享新增节点池里来
  onDomChanged(({ added, overflow: hadOverflow }) => {
    if (!enabled) return;
    if (hadOverflow) {
      scheduleFullScan();
      return;
    }
    if (added.length === 0) return;
    if (!pendingArticles) pendingArticles = new Set();
    collectArticles(added, pendingArticles);
    frameQueue.schedule('work', runFrameWork);
  });

  // 列宽调整 / 右栏显隐 / SPA 路由都会重排或重建推文子树：整树补扫一次
  document.addEventListener('te:layout', () => {
    if (enabled) scheduleFullScan();
  });
  onRouteChanged(() => {
    if (enabled) scheduleFullScan();
  });
  // 时间线**整层被替换**（标签页切换 / X 先用占位层再换真实层）：写在旧层节点上的
  // 标记与轮播序号随之失效，整树补扫一次。与上面的路由补扫会在同一个帧里合并
  // （同一个队列 + 同一个 key + fullScanPending 分支），不会重复扫。
  onTimelineChanged(() => {
    if (enabled) scheduleFullScan();
  });
}
