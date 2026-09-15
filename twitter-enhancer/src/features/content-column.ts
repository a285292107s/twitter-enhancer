/**
 * 内容列排版：版心、Hero、内容语义、轮播序号。
 *
 * 为什么单独成模块（而不是继续堆在 tweet-ui 里）：tweet-ui 是「皮肤层」（令牌 / 主题 /
 * 操作栏反馈），本模块是「排版层」—— 它要**读内容**再写属性，属于有状态的 DOM 逻辑。
 * 两者开关独立，方便逐条对比（见 docs/content-column-design.md）。
 *
 * 三件事，全部只写属性、不插节点、不搬节点：
 * 1. 版心 / Hero：焦点帖（详情页 URL 里那条）打 data-te-hero，它的 cell 打
 *    data-te-hero-cell；CSS 据此把主角立起来（结构色带 + 更大上内边距）。
 *    判据用「article 里有 a[href] 的路径 === location.pathname」——2026-09-14 真机实测：
 *    焦点帖命中、同页 45 条回复全部不命中。
 * 2. 内容语义：给 article 写 data-te-caption = none | emoji | short | long。
 *    emoji 是行内 <img>，textContent 长度为 0，因此「emoji 独占正文」必须靠
 *    img 计数单独识别（标本帖子正文就是 6 个 emoji）。
 * 3. 轮播序号：多图轮播在媒体宿主上写 data-te-carousel="3/4"，
 *    CSS 用 ::after + attr() 画角标；滚动时只改属性值，不插节点。
 *
 * 监听策略（与 media-cap 同一套）：dom-watch 的合并批次回调只**收集**命中的
 * article（滚动路径上不做子树扫描与布局读），真正的分类 / 定位推迟到下一个 rAF
 * 帧统一执行；结构性变化（te:layout / 路由 / overflow / load）走整树补扫。
 */
import { CONFIG } from '../config';
import { registerSetting, notifySettingsChanged } from '../lib/settings';
import { readFlag, writeFlag } from '../lib/store';
import { onDomChanged } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import './content-column.css';

const TWEET_SELECTOR = 'article[data-testid="tweet"]';
const TEXT_SELECTOR = '[data-testid="tweetText"]';
const SNAP_SELECTOR = '[data-testid="ScrollSnap-List"]';
const CELL_SELECTOR = '[data-testid="cellInnerDiv"]';
/** 焦点帖 URL：/user/status/123（可选 ?query 已由 pathname 排除） */
const STATUS_PATH = /^\/[^/]+\/status\/\d+/;

const CAROUSEL_ATTR = 'teCarousel';
const HERO_ATTR = 'teHero';
const HERO_CELL_ATTR = 'teHeroCell';
const CAPTION_ATTR = 'teCaption';

/** 轮播宿主向上查找的最大层数（防在异常 DOM 上爬太远） */
const HOST_MAX_DEPTH = 6;
const FALLBACK_FRAME_MS = 16;

let enabled = CONFIG.column.enabledByDefault;

/* ------------------------------------------------------------------ *
 * 帧任务合并：批次回调只收集，工作在下一个 rAF 帧里做
 * ------------------------------------------------------------------ */
let frameQueued = false;
let pendingArticles: Set<HTMLElement> | null = null;
let fullScanPending = false;

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
  // 首屏推文是从新增节点池里来的：这里补一次版心解析（load / DOMContentLoaded
  // 常常早于推文渲染，那两次拿不到正文样本）
  resolveSpine();
  for (const article of batch) {
    if (article.isConnected) processArticle(article);
  }
}

function scheduleFullScan(): void {
  fullScanPending = true;
  queueFrameWork();
}

/* ------------------------------------------------------------------ *
 * 分类与标记
 * ------------------------------------------------------------------ */

/**
 * 取本条推文自己的正文：跳过引用卡片里的正文（它在 div[role="link"] 内），
 * 否则「无正文 + 引用一条带文字的帖子」会被按引用内容分类。
 */
function ownText(article: HTMLElement): HTMLElement | null {
  for (const node of article.querySelectorAll<HTMLElement>(TEXT_SELECTOR)) {
    if (!node.closest('div[role="link"]')) return node;
  }
  return null;
}

type CaptionKind = 'none' | 'emoji' | 'short' | 'long';

/**
 * 内容语义分类。emoji 在 X 里是行内 <img>（不产生文本），所以：
 * 可见字符数 = textContent 去掉空白后的长度（emoji 记 0），emoji 数 = img 数。
 */
function classify(text: HTMLElement | null): CaptionKind {
  if (!text) return 'none';
  const chars = (text.textContent ?? '').replace(/\s+/g, '').length;
  const emoji = text.querySelectorAll('img').length;
  if (chars === 0) return emoji > 0 ? 'emoji' : 'none';
  return chars <= CONFIG.column.shortMaxChars ? 'short' : 'long';
}

function classifyCaption(article: HTMLElement): void {
  const kind = classify(ownText(article));
  if (article.dataset[CAPTION_ATTR] !== kind) article.dataset[CAPTION_ATTR] = kind;
}

/** 当前页是否是帖子详情页；是则返回焦点帖的路径，否则 null */
function heroPath(): string | null {
  const match = STATUS_PATH.exec(location.pathname);
  return match ? match[0] : null;
}

/**
 * 焦点帖判定：article 里存在指向当前路径的链接（时间戳 / 图片链接都指向它）。
 * 用 getAttribute 直接比较字符串，避免为每篇推文构造 URL 对象。
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
/** 待在本帧更新序号的 (列表 → 宿主) */
const indexTargets = new Map<HTMLElement, HTMLElement>();
let indexFrameQueued = false;

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

function flushCarouselIndexes(): void {
  indexFrameQueued = false;
  if (!enabled) {
    indexTargets.clear();
    return;
  }
  const targets = [...indexTargets];
  indexTargets.clear();
  for (const [list, host] of targets) {
    if (host.isConnected) updateCarouselIndex(list, host);
  }
}

function scheduleCarouselIndex(list: HTMLElement, host: HTMLElement): void {
  indexTargets.set(list, host);
  if (indexFrameQueued) return;
  indexFrameQueued = true;
  if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flushCarouselIndexes);
  else setTimeout(flushCarouselIndexes, FALLBACK_FRAME_MS);
}

function markCarousel(article: HTMLElement): void {
  if (!CONFIG.column.carouselIndex) return;
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
  classifyCaption(article);
  markHero(article, heroPath());
  markCarousel(article);
}

/** 整树补扫：先清掉焦点帖标记（SPA 导航后旧焦点帖可能已不是焦点），再逐条处理 */
function scanAll(): void {
  clearHeroMarks();
  // 版心要等首屏正文出现才能读到（取决于正文的解析字号）
  resolveSpine();
  const path = heroPath();
  for (const article of document.querySelectorAll<HTMLElement>(TWEET_SELECTOR)) {
    classifyCaption(article);
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
  const selector = '[data-te-caption],[data-te-hero],[data-te-hero-cell],[data-te-carousel]';
  for (const el of document.querySelectorAll<HTMLElement>(selector)) {
    delete el.dataset[CAPTION_ATTR];
    delete el.dataset[HERO_ATTR];
    delete el.dataset[HERO_CELL_ATTR];
    delete el.dataset[CAROUSEL_ATTR];
  }
}

/* ------------------------------------------------------------------ *
 * 开关与令牌
 * ------------------------------------------------------------------ */

/**
 * 版心宽度（px）。
 *
 * 为什么不能直接用 `72ch`：ch 是**相对元素自身字号**的长度单位。同一页里
 * 正文 16px、操作栏继承 X 的 15px，`72ch` 会被解析成两条不同的右边界
 * （2026-09-14 真机实测：操作栏 max-width 633.34px，正文 763.776px）。
 *
 * 取值方式：直接读真实正文元素上 72ch 的解析结果 —— 那就是阅读流的右边界，
 * 不需要自己量 ch（实测「72 个 0」的宽度与 72ch 的解析结果并不相等：
 * 同一字体下前者 785px、后者 764px，所以不能用量尺反推）。
 * 短句帖的正文按 20px 排版，而 ch 随字号线性缩放，按 fontSize 换算回正文字号。
 */
let spineResolved = false;

function resolveSpine(force = false): void {
  if (spineResolved && !force) return;
  // 只有推文 UI 开启时正文上的 max-width 才是我们的 72ch
  if (document.documentElement.dataset.teUi !== 'on') return;
  const sample = document.querySelector<HTMLElement>('[data-testid="tweetText"]');
  if (!sample) return;
  const style = getComputedStyle(sample);
  if (!style.maxWidth.endsWith('px')) return;
  const size = Number.parseFloat(style.fontSize);
  const measure = Number.parseFloat(style.maxWidth);
  if (!(size > 0) || !(measure > 0)) return;
  const px = Math.round((measure / size) * CONFIG.tweetUi.bodyFontSize);
  if (px <= 0) return;
  document.documentElement.style.setProperty('--te-spine', `${px}px`);
  spineResolved = true;
}

function applyTokens(): void {
  const root = document.documentElement;
  const { column } = CONFIG;
  root.style.setProperty('--te-action-gap', `${column.actionGap}px`);
  root.style.setProperty('--te-caption-emoji-size', `${column.emojiFontSize}px`);
  root.style.setProperty('--te-caption-short-size', `${column.shortFontSize}px`);
}

function setEnabled(value: boolean): void {
  enabled = value;
  document.documentElement.dataset.teColumn = value ? 'on' : 'off';
  if (value) scheduleFullScan();
  else clearMarks();
}

function toggleColumn(): void {
  setEnabled(!enabled);
  void writeFlag('content-column', enabled);
  notifySettingsChanged();
}

export function enableContentColumn(): void {
  applyTokens();
  setEnabled(enabled);
  void readFlag('content-column').then((stored) => {
    if (stored !== null && stored !== enabled) setEnabled(stored);
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
    queueFrameWork();
  });

  // 列宽调整 / 右栏显隐 / SPA 路由都会重排或重建推文子树：整树补扫一次
  document.addEventListener('te:layout', () => {
    if (enabled) {
      resolveSpine(true);
      scheduleFullScan();
    }
  });
  onRouteChanged(() => {
    if (enabled) scheduleFullScan();
  });

  // 字体加载 / 布局变化后正文的 72ch 可能变宽（回退字体与 Chirp 不等宽）：重读一次
  window.addEventListener('load', () => resolveSpine(true), { once: true });
  try {
    void document.fonts?.ready?.then(() => resolveSpine(true));
  } catch {
    // 极早期没有 document.fonts 时忽略：CSS 侧还有 72ch 兜底
  }

  registerSetting({
    id: 'content-column',
    group: '内容',
    label: '内容列排版',
    description: '正文按内容分层（emoji / 短句 / 长文）、操作栏收进版心、焦点帖加结构分隔',
    isEnabled: () => enabled,
    toggle: toggleColumn,
  });
}
