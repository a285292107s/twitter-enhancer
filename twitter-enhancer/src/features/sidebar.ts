/**
 * 右侧栏隐藏 + 搜索迁移到左侧导航条（logo 右侧）。
 *
 * 设计要点：
 * 1. 隐藏右栏用 CSS 属性开关（html[data-te-sidebar]），不删节点、不破坏 X 的 React 树。
 * 2. 搜索框优先「行内左右结构」：logo 左、搜索框右，随容器自然流动；
 *    只有 logo 没有独立行容器时才退回绝对定位（见 mountBesideLogo）。
 * 3. X 的 SPA 重渲染可能移除宿主或被测量元素变化，因此用 MutationObserver + ResizeObserver 守护。
 * 4. 自建输入框（custom）为默认；move 模式搬运原生搜索框属高风险选项，见 config 说明。
 * 5. 左导航条（rail）不写任何样式 —— X 自己的 fixed 定位已经正确（与主列左缘对齐），
 *    由脚本覆盖反而会让 /home 与 /i/grok 的导航条走两套机制，见 applySidebarGap 上方说明。
 *
 * 真实 DOM（2026-09 实测，class 为哈希值，只能按结构定位）：
 *   div.r-1habvwh（内栏，flex column，已 position:relative）
 *     ├ div（logo 行，只撑到 logo 宽度）→ h1 → a[aria-label="X"]
 *     ├ div → nav[aria-label="主要"]
 *     └ div（发帖按钮）
 *   注意：logo 是 nav 的**兄弟**，不在 nav 里；早期版本在 nav 内找 logo，
 *   会误命中 nav a[href="/home"]（"主页"项，宽 259），算出错误坐标使搜索框退化成单图标。
 */
import { CONFIG } from '../config';
import { registerSetting, notifySettingsChanged } from '../lib/settings';
import { readFlag, writeFlag } from '../lib/store';
import { onDomChanged, dispatchLayoutEvent } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import './sidebar.css';

const SIDEBAR = '[data-testid="sidebarColumn"]';
const SEARCH_INPUT = '[data-testid="SearchBox_Search_Input"]';
/** 右栏左缘与主列右缘的间距：沿用 X 原生的 30px */
const SIDEBAR_GAP = 30;
/** 左侧导航条：不同版本结构略有差异，按优先级回退 */
const NAV_SELECTORS = [
  'nav[aria-label="Primary"]',
  // 中文界面下 aria-label 是本地化文案
  'nav[aria-label="主要"]',
  'nav[role="navigation"]',
  'header[role="banner"] nav',
  '[data-testid="SideNav"]',
];
/** logo 链接：X 的 aria-label 随品牌调整，按优先级回退 */
const LOGO_SELECTORS = [
  'a[aria-label="X"]',
  'a[aria-label="Twitter"]',
  'a[href="/home"]',
];
/** 搜索框高度，用于与 logo 垂直居中对齐 */
const SEARCH_HEIGHT = 44;
/** 内栏宽度低于该值视为「图标条」，放不下输入框 */
const COMPACT_WIDTH = 240;
/** 行内布局写到 logo 行容器上的内联样式（切换方案时需要清除） */
const ROW_STYLE_PROPS = [
  'display',
  'flex-direction',
  'flex-wrap',
  'align-items',
  'justify-content',
  'gap',
  'align-self',
  'min-width',
] as const;

function findNav(): HTMLElement | null {
  for (const selector of NAV_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (el) return el;
  }
  return null;
}

/**
 * 侧栏内栏：logo 行、导航条、发帖按钮的共同父容器（nav 的祖父节点）。
 * 只按结构定位，不认哈希 class —— X 改样式类名后依然有效。
 */
function findInner(nav: HTMLElement): HTMLElement {
  const parent = nav.parentElement;
  const grand = parent?.parentElement;
  return grand ?? parent ?? nav;
}

/**
 * logo 链接：只能在导航条之外找。
 * X 的 logo 是 nav 的兄弟节点；若退而在 nav 内匹配 `a[href="/home"]`，
 * 命中的是"主页"导航项（宽 259），会算出错误坐标使搜索框退化成单图标。
 */
function findLogo(root: ParentNode, nav: HTMLElement): HTMLElement | null {
  // 第一轮只要「导航条之外」的 logo；老版本 X 把 logo 放在 nav 内，
  // 此时第二轮放宽，仍优先取带 aria-label 的那个，而不是 "主页" 导航项。
  for (const outsideNav of [true, false]) {
    for (const selector of LOGO_SELECTORS) {
      for (const el of root.querySelectorAll<HTMLElement>(selector)) {
        if (outsideNav && nav.contains(el)) continue;
        return el;
      }
    }
  }
  return null;
}

/**
 * logo 所在的行容器：从 logo 往上走到「内栏的直接子节点」为止。
 * 真实 DOM 里是 h1 → div（logo 行），即 div 才是需要改成左右结构的那一层。
 */
function findLogoRow(logo: HTMLElement, inner: HTMLElement): HTMLElement | null {
  let row: HTMLElement | null = logo.parentElement;
  while (
    row &&
    row !== inner &&
    row !== document.body &&
    row.parentElement &&
    row.parentElement !== inner
  ) {
    row = row.parentElement;
  }
  return row && row !== inner ? row : null;
}

function findSidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SIDEBAR);
}

/** 原生搜索框：取 input 外层承载整块搜索区域的容器 */
function findNativeSearch(): HTMLElement | null {
  const input = document.querySelector<HTMLElement>(SEARCH_INPUT);
  if (!input) return null;
  const search = input.closest<HTMLElement>('[role="search"]');
  return search ?? input.parentElement ?? null;
}

/** 保证宿主元素存在（插入位置由 mountBesideLogo 决定） */
function ensureHost(): HTMLElement {
  const existing = document.querySelector<HTMLElement>('.te-search-host');
  if (existing) return existing;
  const host = document.createElement('div');
  host.className = 'te-search-host';
  return host;
}

/**
 * 判断某容器是否为「只承载 logo 的一行」。
 * 只有在这种情况下才能安全地把它改成左右结构（logo 左、搜索框右）；
 * 若该容器还承载其他导航项，改 display 会打乱整个导航排列。
 */
function isLogoRow(row: HTMLElement, logo: HTMLElement): boolean {
  const own = Array.from(row.children).filter((el) => !el.classList.contains('te-search-host'));
  if (own.length === 0 || own.length > 2) return false;

  const rowBox = row.getBoundingClientRect();
  const logoBox = logo.getBoundingClientRect();
  // 布局未就绪（rect 全 0）时退化为按结构判断
  if (rowBox.height === 0 || logoBox.height === 0) return own.length === 1;
  // 容器高度与 logo 相当，说明它确实只占 logo 这一行
  return rowBox.height <= logoBox.height * 1.6;
}

/** 行内左右结构：logo 左，搜索框右，随容器自然流动 */
function applyRowLayout(row: HTMLElement, host: HTMLElement): void {
  row.style.display = 'flex';
  row.style.flexDirection = 'row';
  row.style.flexWrap = 'nowrap';
  row.style.alignItems = 'center';
  row.style.justifyContent = 'space-between';
  row.style.gap = '12px';
  // logo 行默认只撑到 logo 宽度（52px），必须拉伸到内栏宽度才有空间放搜索框
  row.style.alignSelf = 'stretch';
  row.style.minWidth = '0';

  // X 给 logo 容器（h1）带了 flex-grow，会和搜索框平分剩余空间：
  // 表现为 logo 被顶到行中间、输入框只剩几十像素。压住非搜索框子元素的伸缩。
  rowChildren = [];
  for (const child of Array.from(row.children)) {
    if (child === host) continue;
    const el = child as HTMLElement;
    el.style.flexGrow = '0';
    el.style.flexShrink = '0';
    rowChildren.push(el);
  }
}

/** 撤销上一次写在行容器（及其子元素）上的内联样式（切换方案 / X 换结构时避免残留） */
function resetRowLayout(row: HTMLElement): void {
  for (const prop of ROW_STYLE_PROPS) {
    row.style.removeProperty(prop);
  }
  for (const el of rowChildren) {
    el.style.removeProperty('flex-grow');
    el.style.removeProperty('flex-shrink');
  }
  rowChildren = [];
}

/** 回退方案：绝对定位到 logo 右侧（不改 X 任何元素的布局属性） */
function applyAbsoluteLayout(nav: HTMLElement, host: HTMLElement, logo: HTMLElement | null): void {
  if (getComputedStyle(nav).position === 'static') nav.style.position = 'relative';
  if (!logo) {
    host.style.top = '4px';
    host.style.left = '12px';
    host.style.right = '12px';
    return;
  }

  const navBox = nav.getBoundingClientRect();
  const logoBox = logo.getBoundingClientRect();
  // 布局未就绪时 rect 全为 0，跳过以免算出错误坐标
  if (navBox.width === 0 || logoBox.width === 0) return;

  const left = Math.round(logoBox.right - navBox.left + 12);
  const top = Math.round(logoBox.top - navBox.top + Math.max(0, (logoBox.height - SEARCH_HEIGHT) / 2));
  host.style.top = `${top}px`;
  host.style.left = `${left}px`;
  host.style.right = '12px';
}

/** 上一次被改成左右结构的容器，切换方案时用于清除残留样式 */
let lastRow: HTMLElement | null = null;
/** 被压住 flex 伸缩的行内子元素（logo 容器等），同上用于还原 */
let rowChildren: HTMLElement[] = [];

/**
 * 把搜索框放到 logo 右侧。
 * 优先「行内左右结构」（自然流动、无需测量、随断点自适应）；
 * 只有在 logo 没有独立行容器时才退回绝对定位。
 * 实际采用的方案会写在 host.dataset.teSearchLayout 上，便于在 DevTools 确认。
 */
function mountBesideLogo(nav: HTMLElement, host: HTMLElement): void {
  // 切换方案时清掉上一次留下的定位样式
  host.removeAttribute('style');

  const inner = findInner(nav);
  const logo = findLogo(inner, nav);
  const row = logo ? findLogoRow(logo, inner) : null;

  if (logo && row && row !== nav && isLogoRow(row, logo)) {
    if (lastRow && lastRow !== row) resetRowLayout(lastRow);
    lastRow = row;
    if (host.parentElement !== row) row.appendChild(host);
    applyRowLayout(row, host);
    host.dataset.teSearchLayout = 'row';
  } else {
    if (lastRow) {
      resetRowLayout(lastRow);
      lastRow = null;
    }
    if (host.parentElement !== nav) nav.insertBefore(host, nav.firstChild);
    applyAbsoluteLayout(nav, host, logo);
    host.dataset.teSearchLayout = 'absolute';
  }

  // 左栏收窄成图标条时放不下输入框（宽度未知时为 0，不误判）
  const width = inner.clientWidth || nav.clientWidth;
  inner.dataset.teNavCompact = width > 0 && width < COMPACT_WIDTH ? 'true' : 'false';
}

/** custom 模式：自建输入框，回车跳搜索页 */
function buildSearchBox(host: HTMLElement): void {
  if (host.querySelector('.te-search')) return;

  const wrap = document.createElement('form');
  wrap.className = 'te-search';
  wrap.setAttribute('role', 'search');
  wrap.innerHTML = `
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
      <circle cx="11" cy="11" r="7"></circle>
      <path d="M20 20l-3.5-3.5"></path>
    </svg>
    <input type="search" placeholder="${CONFIG.search.placeholder}" aria-label="${CONFIG.search.placeholder}" autocomplete="off" />
    <button class="te-search-clear" type="button" aria-label="清除">
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" aria-hidden="true">
        <path d="M6 6l12 12M18 6L6 18"></path>
      </svg>
    </button>
  `;

  const input = wrap.querySelector('input')!;
  const clear = wrap.querySelector<HTMLButtonElement>('.te-search-clear')!;

  clear.addEventListener('click', () => {
    input.value = '';
    wrap.dataset.hasValue = 'false';
    input.focus();
  });
  input.addEventListener('input', () => {
    wrap.dataset.hasValue = input.value ? 'true' : 'false';
  });
  wrap.addEventListener('submit', (event) => {
    event.preventDefault();
    const query = input.value.trim();
    if (!query) return;
    window.location.assign(`/search?q=${encodeURIComponent(query)}`);
  });

  host.appendChild(wrap);
}

/** move 模式：把原生搜索框搬进宿主 */
function moveNativeSearch(host: HTMLElement): boolean {
  const search = findNativeSearch();
  if (!search) return false;
  if (search.parentElement !== host) host.appendChild(search);
  return true;
}

/** 导航条搜索框开关（菜单里可切换，状态持久化） */
let searchEnabled = CONFIG.search.enabled;

/**
 * 左导航条（rail）**完全不动**。
 *
 * 旧版按「主列左缘 − 导航条宽」把 fixed 导航条重新钉一遍（并锁死 width/right），
 * 理由是「主列一旦居中就会脱节」。铺满内容区后主列左缘恒等于 X 内容区左缘，
 * 2026-09-08 真机复核：把脚本写上去的内联样式整条剥掉，X 自己算出的位置
 * （1440 视口 left 87.5px；右栏显示 / 隐藏两种状态都一样）与主列左缘关系
 * （主列左缘 − 导航条宽）完全吻合，也就是说这层覆盖已经没有任何补偿作用，
 * 只留下「/home 的导航条由脚本摆、/i/grok 由 X 摆」的机制差异。
 * 现在两个 tab 共用 X 自己的 fixed 定位，脚本不再写一个字节。
 */

/** 已加过锚点样式的元素，用于关闭 / 还原时清理 */
let anchoredSidebar: HTMLElement | null = null;
/**
 * 被改成左对齐（右栏显示时的锚定布局）的三栏行；右栏隐藏后必须还原 X 原生的
 * space-between —— 右栏隐藏时主列铺满内容区、行里只剩一个子节点，原生 space-between
 * 等价于左对齐，与 /i/grok 的行一致；留着 flex-start 虽看不出差别，但会让「行样式」
 * 在两个页面之间不一致，日后排错容易误判。
 */
let anchoredRow: HTMLElement | null = null;

function resetSidebarAnchor(): void {
  if (anchoredSidebar) {
    anchoredSidebar.style.removeProperty('margin-left');
    anchoredSidebar = null;
  }
  if (anchoredRow) {
    anchoredRow.style.removeProperty('justify-content');
    anchoredRow = null;
  }
}

/**
 * 右栏显示时把它钉在主列右侧 SIDEBAR_GAP（30px）：行改左对齐 + 右栏 margin-left。
 * 不依赖 space-between 在剩余空间里"随机"分配（行被 min-width 撑开后剩余空间会变）。
 *
 * 左导航条不在此处处理 —— 它由 X 自己 fixed 定位，脚本不写（见上面 rail 的说明）。
 */
function applySidebarGap(): void {
  const sidebar = findSidebar();
  const row = sidebar?.parentElement ?? null;
  // 功能开关关闭 / 右栏隐藏 / 结构未就绪 → 交回 X 原生（space-between）
  // 这一步不做任何测量（只写固定 30px 间距），因此不需要等布局就绪
  if (!CONFIG.sidebar.anchorSidebar || hidden || !sidebar || !row) {
    resetSidebarAnchor();
    return;
  }
  row.style.justifyContent = 'flex-start';
  sidebar.style.marginLeft = `${SIDEBAR_GAP}px`;
  anchoredSidebar = sidebar;
  anchoredRow = row;
}

let hidden = CONFIG.sidebar.hiddenByDefault;

function applyHidden(value: boolean): void {
  const attribute = value ? 'off' : 'on';
  // 以属性实际变化为准（首轮从「未设置」到 off 也算变化）：宽时间线以这个属性为准，
  // feature 启用顺序不该影响它能否收到通知。
  const changed = document.documentElement.dataset.teSidebar !== attribute;
  hidden = value;
  document.documentElement.dataset.teSidebar = attribute;
  applySidebarGap();
  // 右栏显隐会改变主列可用宽度，通知宽时间线重算（旧版靠观察 data-te-sidebar 属性，
  // 已随全站观察器收敛移除，改由显式事件驱动）
  if (changed) dispatchLayoutEvent();
}

function toggleSidebar(): void {
  applyHidden(!hidden);
  void writeFlag('sidebar', hidden);
  notifySettingsChanged();
}

/**
 * 内栏宽度变化（窗口缩放 / X 切换断点）时重新判定：
 * 收窄成图标条就隐藏搜索框，并重新决定用哪种布局。
 * 标记打在内栏上（而非导航条）——行内结构下宿主是 logo 行的子节点，不在 nav 里。
 */
function watchInner(inner: HTMLElement, nav: HTMLElement, host: HTMLElement): void {
  if (typeof ResizeObserver === 'undefined') return;
  new ResizeObserver(() => {
    mountBesideLogo(nav, host);
  }).observe(inner);
}

function isSearchEnabled(): boolean {
  return searchEnabled;
}

function applySearchEnabled(value: boolean): void {
  searchEnabled = value;
  document.documentElement.dataset.teSearch = value ? 'on' : 'off';
}

function toggleSearch(): void {
  applySearchEnabled(!searchEnabled);
  void writeFlag('nav-search', searchEnabled);
  notifySettingsChanged();
}

/**
 * 拦截 X 原生的「/」快捷键。
 * 右栏隐藏后原生搜索框不可见，按 / 会把焦点送进看不见的输入框，
 * 这里在捕获阶段抢先处理，把焦点转到自建输入框。
 */
function interceptSlashShortcut(): void {
  if (CONFIG.search.mode !== 'custom') return;
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== '/' || event.metaKey || event.ctrlKey || event.altKey) return;
      // 搜索框被关掉时不要抢焦点，交回 X 原生行为
      if (!isSearchEnabled()) return;
      const target = event.target as HTMLElement | null;
      if (target) {
        const tag = target.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA' || target.isContentEditable) return;
      }
      const input = document.querySelector<HTMLInputElement>('.te-search input');
      if (!input) return;
      event.preventDefault();
      event.stopPropagation();
      input.focus();
      input.select();
    },
    true,
  );
}

export function enableSidebarSearch(): void {
  applyHidden(hidden);
  applySearchEnabled(searchEnabled);
  // 存储读取是异步的，先用默认值渲染，读到用户设置后再覆盖
  void readFlag('sidebar').then((stored) => {
    if (stored !== null && stored !== hidden) applyHidden(stored);
  });
  void readFlag('nav-search').then((stored) => {
    if (stored !== null && stored !== searchEnabled) applySearchEnabled(stored);
  });

  let watching = false;
  const sync = (): void => {
    // 快速路径：宿主仍在位时只做廉价的校正，避免高频 mutation 下反复重建
    const mounted = document.querySelector<HTMLElement>('.te-search-host');
    if (mounted?.isConnected) {
      if (CONFIG.search.mode === 'move') moveNativeSearch(mounted);
      applySidebarGap();
      return;
    }

    const nav = findNav();
    if (!nav) return;
    const host = ensureHost();

    if (CONFIG.search.mode === 'move') {
      moveNativeSearch(host);
    } else {
      buildSearchBox(host);
    }

    mountBesideLogo(nav, host);
    applySidebarGap();

    if (!watching) {
      watching = true;
      watchInner(findInner(nav), nav, host);
    }
  };

  sync();
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sync, { once: true });
  }
  // 布局稳定后（字体、图片加载完）位置可能变化，再校正一次
  window.addEventListener('load', sync, { once: true });

  // 订阅 dom-watch 单例派发的合并批次（120ms 节流）。
  // 只在与导航条 / 侧栏 / 右栏结构相关的变更时才做校正，避免滚动时虚拟列表
  // 插入推文触发无谓的几何重算（applySidebarGap / mountBesideLogo 含测量）。
  // 用 setTimeout 语义由 dom-watch 提供（后台标签页不被冻结），
  // 回前台由 dom-watch 的 visibilitychange 兜底冲刷。
  onDomChanged(({ added, overflow: hadOverflow, structural }) => {
    // 结构性替换（SPA 导航重挂 app shell）：主列 / 三栏行 / 左栏都换了新节点，
    // 补偿样式必须立刻重写（本批次由 dom-watch 在渲染帧前同步派发）。
    if (hadOverflow || structural) {
      sync();
      return;
    }
    const nav = findNav();
    let relevant = false;
    for (const node of added) {
      // 导航条 / 右栏（或右栏祖先）出现
      if (node.matches?.(SIDEBAR) || node.querySelector?.(SIDEBAR)) {
        relevant = true;
        break;
      }
      if (nav && (node.contains(nav) || nav.contains(node))) {
        relevant = true;
        break;
      }
      // 搜索宿主被移除后重新挂载，或原生搜索框重新出现（move 模式）
      if (node.matches?.('.te-search-host, [data-testid="SearchBox_Search_Input"]')) {
        relevant = true;
        break;
      }
    }
    if (relevant) sync();
  });

  // SPA 导航会重建右栏 / 三栏行容器，锚点与行对齐样式写在节点上会随旧节点一起消失：
  // 路由切换（低频）直接做一次轻量校正（sync 的快速路径只做廉价检查）。
  onRouteChanged(() => sync());

  // 宽时间线重算行宽后会广播 te:layout：右栏显示时主列宽度刚变，右栏的 30px 间距
  // 与行对齐需要跟着是最终值（写入幂等、无需测量，代价可忽略）。
  document.addEventListener('te:layout', applySidebarGap);

  interceptSlashShortcut();

  registerSetting({
    id: 'sidebar',
    group: '布局',
    label: '显示右侧栏',
    description: '关闭后隐藏右栏，把横向空间让给主列',
    shortcut: 'Alt+B',
    isEnabled: () => !hidden,
    toggle: toggleSidebar,
  });

  registerSetting({
    id: 'nav-search',
    group: '布局',
    label: '导航条搜索框',
    description: '在左栏 logo 右侧显示搜索框（回车跳转搜索页）',
    isEnabled: isSearchEnabled,
    toggle: toggleSearch,
  });

  // Alt+B 继续保留，方便键盘切换
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyB') return;
    toggleSidebar();
    event.preventDefault();
  });
}
