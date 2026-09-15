/**
 * 页面类型检测（做法取自社区标准实现 control-panel-for-twitter 的 `PagePaths` + `isOnXxxPage`）。
 *
 * 参考项目里每个功能都用 `isOnHomeTimelinePage()` / `isOnIndividualTweetPage()` 这类谓词
 * 问「现在是哪一页」，而不是各自 `location.pathname.match(...)`。本模块把这层收敛成：
 * 一条**纯函数** `classifyPath(pathname)`（可测、无副作用）+ 一个缓存 + 一个事件。
 *
 * 为什么必须有缓存与事件：
 * - 缓存放进每次 `currentPageKind()` 调用里（路径变了就地重算），所以**即使路由 hook
 *   漏掉一次导航也不会读到过期类型** —— 参考项目踩过「页面变了但 currentPage 还是旧值，
 *   于是 stopIf 永远不触发」的坑；
 * - 事件（`te:page`）让功能可以「进了某一类页面才挂东西、离开就拆」，而不是在每个
 *   DOM 批次回调里自己判断。
 *
 * **它不取代结构判据**：判「这一页是不是三栏时间线」的权威仍是 DOM 结构（主列所在行里
 * 有没有右栏兄弟节点），因为 X 会临时渲染出结构不完整的页面（见 docs/architecture.md
 * 「适用页面按 DOM 结构判」）。页面类型只用来做**不依赖 DOM 时序**的粗判 ——
 * 例如「路由已经是 X Chat 了，先撤销宽列」（路由判定不依赖主列何时挂载）。
 */

import { onRouteChanged } from './spa-route';

/** 页面类型（只列本项目会用到的；新页面一律落到 'other'） */
export type PageKind =
  | 'home'
  | 'profile'
  | 'status'
  | 'search'
  | 'notifications'
  | 'explore'
  | 'messages'
  | 'grok'
  | 'compose'
  | 'settings'
  | 'other';

export interface PageDetail {
  /** 切换后的页面类型 */
  kind: PageKind;
  /** 切换后的路径（`location.pathname`） */
  path: string;
  /** 切换前的页面类型（首次发布时为 'other'） */
  previous: PageKind;
}

/** /i/chat 与 /messages（后者 302 到前者）：X Chat 是独立双栏布局，主列原生 1187px */
const MESSAGES_RE = /^\/(?:i\/chat|messages)(?:\/|$)/;
/** /i/grok：X 自己的单栏版，主列原生 980px、没有右栏 */
const GROK_RE = /^\/i\/grok(?:\/|$)/;
/** 详情页：/:user/status/:id（后面可跟 /photo/1、/analytics 等） */
const STATUS_RE = /^\/[^/]+\/status\/\d+/;
/** 详情页路径的**焦点帖部分**：/:user/status/:id（用于「这一条是不是本页主角」的比对） */
const STATUS_PATH_RE = /^(\/[^/]+\/status\/\d+)/;
/** 个人主页：/:user 以及它的标签页（with_replies / media / likes / highlights …） */
const PROFILE_RE = /^\/[A-Za-z0-9_]{1,20}(?:\/[A-Za-z0-9_-]+)?\/?$/;
/** 保留路径：这些一级路径不是用户名 */
const RESERVED_ROOTS = new Set([
  'home',
  'explore',
  'search',
  'notifications',
  'messages',
  'settings',
  'compose',
  'i',
  'hashtag',
  'jobs',
]);

/** 把 pathname 分类成页面类型（纯函数，无 DOM / 无状态，便于单测与复现） */
export function classifyPath(pathname: string): PageKind {
  const path = pathname.replace(/\/+$/, '') || '/';
  if (MESSAGES_RE.test(path)) return 'messages';
  if (GROK_RE.test(path)) return 'grok';
  if (path === '/compose' || path.startsWith('/compose/')) return 'compose';
  if (path === '/settings' || path.startsWith('/settings/')) return 'settings';
  if (path === '/home' || path.startsWith('/home/')) return 'home';
  if (path === '/explore' || path.startsWith('/explore/')) return 'explore';
  if (path === '/search' || path.startsWith('/search/') || path.startsWith('/hashtag/')) return 'search';
  if (path === '/notifications' || path.startsWith('/notifications/')) return 'notifications';
  if (STATUS_RE.test(path)) return 'status';
  const root = path.split('/')[1] ?? '';
  if (PROFILE_RE.test(path) && root !== '' && !RESERVED_ROOTS.has(root)) return 'profile';
  return 'other';
}

/**
 * 时间线类页面：有 X 自己渲染的时间线（首页 / 个人主页 / 详情页 / 搜索 / 通知 / 探索）。
 * 用途是「这一页值不值得起时间线相关的功能」，**不是**「宽列能不能生效」——
 * 后者只认结构判据（见文件头）。
 */
export function isTimelinePage(kind: PageKind): boolean {
  return (
    kind === 'home' ||
    kind === 'profile' ||
    kind === 'status' ||
    kind === 'search' ||
    kind === 'notifications' ||
    kind === 'explore'
  );
}

const PAGE_EVENT = 'te:page';
const PAGE_ATTR = 'tePage';

let lastPath = '';
let lastKind: PageKind = 'other';
let started = false;

/** 当前页面类型。路径变了就地重算（不依赖路由事件是否到达），保证不会读到过期值 */
export function currentPageKind(): PageKind {
  const path = location.pathname;
  if (path !== lastPath) {
    lastPath = path;
    lastKind = classifyPath(path);
  }
  return lastKind;
}

/** 当前路径（与 currentPageKind 共用同一份缓存） */
export function currentPagePath(): string {
  currentPageKind();
  return lastPath;
}

/**
 * 详情页的焦点帖路径（`/:user/status/:id`），非详情页返回 null。
 *
 * 收敛在页面类型层的原因：它同时是「这一页是详情页」和「哪一条是主角」两个判断，
 * 拆到功能里各写一次就会出现两套正则（旧实现就是如此）。
 */
export function currentStatusPath(): string | null {
  if (currentPageKind() !== 'status') return null;
  return STATUS_PATH_RE.exec(location.pathname)?.[1] ?? null;
}

/**
 * 计算并把类型写到 `html[data-te-page]`，类型变化时派发 `te:page`。
 *
 * 属性与事件的**分工**：属性是给 CSS / DevTools / 验证脚本读的当前值（幂等写入，
 * 与 `data-te-theme` 同一套路）；事件是给功能做「进出页面」的挂载 / 卸载。
 */
function publish(): void {
  const path = location.pathname;
  const kind = classifyPath(path);
  const previous = lastKind;
  const changed = kind !== previous || path !== lastPath;
  lastPath = path;
  lastKind = kind;
  try {
    document.documentElement.dataset[PAGE_ATTR] = kind;
  } catch {
    // 极早期 documentElement 未就绪时忽略（下一次路由 / 首帧后还会写）
  }
  if (!changed) return;
  try {
    document.dispatchEvent(new CustomEvent<PageDetail>(PAGE_EVENT, { detail: { kind, path, previous } }));
  } catch {
    // 极早期忽略
  }
}

/** 启动页面类型观察（幂等）。在 main.ts 里、启用各功能之前调用一次。 */
export function startPageWatch(): void {
  if (started) return;
  started = true;
  publish();
  onRouteChanged(() => publish());
}

/** 订阅「页面类型变化」；返回取消函数 */
export function onPageKindChanged(listener: (detail: PageDetail) => void): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<PageDetail>).detail;
    listener(detail ?? { kind: currentPageKind(), path: currentPagePath(), previous: 'other' });
  };
  document.addEventListener(PAGE_EVENT, handler);
  return () => {
    document.removeEventListener(PAGE_EVENT, handler);
  };
}

/**
 * 构造 `waitForElement` / `waitFor` 的 `stopIf`：路径不再是给定路径就返回 true。
 * 约定用法：`waitFor(probe, { name: 'timeline', stopIf: pagePathChanged(path) })`
 * （见 `lib/timeline.ts`）—— 页面切走就放弃等待，别把上一个页面的等待拖进新页面。
 */
export function pagePathChanged(path: string): () => boolean {
  return () => location.pathname !== path;
}
