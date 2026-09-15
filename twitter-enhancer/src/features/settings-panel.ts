/**
 * 页内设置面板：右下角设置按钮 + 设置弹窗（取代旧版油猴菜单开关）。
 *
 * ## 位置（2026-09-13 真机实测：headless 独立 profile，1280×720）
 *
 * X 把右下角的悬浮容器固定在同一列，且都从底部向上生长：
 *
 * | 容器 | 选择器 | 收起态几何 |
 * |------|--------|------------|
 * | Grok 抽屉 | `[data-testid="GrokDrawer"]` | 350×55 @ y=586（可见按钮是其中右侧 55×55，距右边 20、距底边 79） |
 * | 私信抽屉 | `[data-testid="chat-drawer-root"]` | 350×55 @ y=653 |
 *
 * 设置按钮因此锚定在「这一列容器里最高的那个上缘 − 间距」处：收起时正好落在
 * Grok 按钮正上方（底边距 79 + 按钮高 55 + 间距 12 = 146），任一抽屉展开
 * （向上生长、最高可达半屏）时自动跟到它上方，不会挡住 Grok / 私信面板。
 * 页面里没有这两个容器时（如 `/i/grok`、X Chat）退回配置里的固定偏移，
 * 保证各页面的位置一致、不跳动。
 *
 * 外观同样与 X 的悬浮按钮保持一致（2026-09-13 实测 55×55、圆角 16px、图标 32px、
 * 背景 rgba(255,255,255,0.85)、1px 描边、X 自己那套投影）：尺寸走 `CONFIG.settings.fab`
 * 兜底，配色与描边阴影直接镜像 X 当前按钮的计算样式 —— 不猜它三套主题的颜色，
 * X 换主题或改版都能自动跟上（见 syncFabLook）。
 *
 * ## 挂载
 *
 * 只往 document.body 追加一个自建的 `.te-settings-root`（不进 X 的 React 树，
 * 也不搬运 React 管理的节点）；X 的 SPA 导航若把它连根删掉，由共享 DOM 批次兜底补挂。
 * 弹窗显隐由 `data-te-settings-open` 属性 + 自身 CSS 控制，不写 X 元素的样式。
 */
import { CONFIG } from '../config';
import { getSettings, notifySettingsChanged, onSettingsChanged, type SettingItem } from '../lib/settings';
import { onDomChanged } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import { waitForElement } from '../lib/wait-for';
import { createStyleSheet } from '../lib/style-sheet';
import { SEL } from '../lib/selectors';
import './settings-panel.css';

const ROOT_CLASS = 'te-settings-root';
const FAB_CLASS = 'te-settings-fab';
const OVERLAY_CLASS = 'te-settings-overlay';
/** 弹窗显隐属性（CSS 消费，同时是验证脚本的锚点） */
const OPEN_ATTR = 'data-te-settings-open';
/** 右下角悬浮抽屉容器：取它们中最高的上缘作为设置按钮的下边界（稳定锚点见 lib/selectors.ts） */
const DRAWER_SELECTORS = [SEL.grokDrawer, SEL.chatDrawer];
/**
 * 外观镜像来源：X 自己的悬浮按钮 —— 收起态的 Grok 按钮（抽屉头就是那个 55×55 的按钮），
 * 其次是私信抽屉里的按钮。设置按钮与它们同列相邻，尺寸 / 圆角 / 描边阴影必须一致。
 */
const LOOK_SOURCE_SELECTORS = [SEL.grokDrawerHeader, `${SEL.chatDrawer} button`];
/** 镜像时的合理尺寸区间（px）：抽屉展开后同一 testid 会变成整条 350 宽的头，必须挡掉 */
const FAB_MIN_SIZE = 40;
const FAB_MAX_SIZE = 80;

/**
 * 设置按钮的**几何样式表**（运行时按 CONFIG 拼装，见 lib/style-sheet.ts）。
 *
 * 为什么是样式表而不是 CSS 文件里的常量：`right` / `bottom` / 尺寸 / 圆角 / 图标大小
 * 与 `CONFIG.settings` 是同一份事实，写在两处必然漂 —— 这里由 config.ts 单向生成，
 * 改配置即生效。它只在功能生效后才有意义，所以不存在首屏时序问题。
 *
 * 位置（right / bottom）仍会被 `anchorFab()` 用实测几何写成内联样式覆盖：
 * 内联优先于样式表，这正是我们要的「先有兜底、再跟上 X 的实时位置」。
 */
const fabSheet = createStyleSheet('settings-fab');

function renderFabSheet(): void {
  const { right, fallbackBottom, fab } = CONFIG.settings;
  fabSheet.set(
    '.te-settings-fab{' +
      `right:${right}px;bottom:${fallbackBottom}px;` +
      `width:${fab.size}px;height:${fab.size}px;border-radius:${fab.radius}px;` +
      `--te-set-fab-icon:${fab.iconSize}px;` +
      '}',
  );
}

/** 齿轮图标（自绘 SVG，不用 emoji，见设计规范） */
const GEAR_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"
       stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
    <circle cx="12" cy="12" r="3.2"></circle>
    <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.09A1.7 1.7 0 0 0 9 19.4a1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.09A1.7 1.7 0 0 0 4.6 9a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.7 1.7 0 0 0 9 4.6h.09A1.7 1.7 0 0 0 10.12 3.04V3a2 2 0 1 1 4 0v.09A1.7 1.7 0 0 0 15.15 4.6a1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.7 1.7 0 0 0 19.4 9v.09a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.09a1.7 1.7 0 0 0-1.51 1.03z"></path>
  </svg>`;

const CLOSE_ICON = `
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
       stroke-linecap="round" aria-hidden="true">
    <path d="M6 6l12 12M18 6L6 18"></path>
  </svg>`;

let root: HTMLElement | null = null;
let fab: HTMLButtonElement | null = null;
let overlay: HTMLElement | null = null;
let dialog: HTMLElement | null = null;
/** 弹窗是否打开（关闭只是改属性，DOM 常驻，避免每次开关都重建节点） */
let opened = false;
/** 上次渲染的设置项 id 串：变化才重建开关行（否则只同步状态，保住节点身份） */
let renderedIds = '';

const resizeObserver =
  typeof ResizeObserver !== 'undefined' ? new ResizeObserver(() => anchorFab()) : null;
/** 当前被 ResizeObserver 观察的抽屉容器（X 换节点时重新绑定） */
const observedDrawers = new Set<Element>();

/* ------------------------------------------------------------------ *
 * 位置：右下角抽屉列的上缘
 * ------------------------------------------------------------------ */

/** 让 ResizeObserver 盯住当前的抽屉容器（展开 / 收起时高度变化 → 重新锚定） */
function observeDrawers(): void {
  if (!resizeObserver) return;
  for (const el of observedDrawers) resizeObserver.unobserve(el);
  observedDrawers.clear();
  for (const selector of DRAWER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    resizeObserver.observe(el);
    observedDrawers.add(el);
  }
}

/**
 * 挑一个可以镜像外观的 X 悬浮按钮：
 * 必须是方形按钮（收起态 55×55）；抽屉展开后同一个 testid 会变成整条抽屉头（350 宽），
 * 或换成尺寸迥异的关闭按钮，这些都靠「BUTTON + 近方形 + 40~80px」挡掉。
 * 悬停中的按钮也不取（hover 态背景会被镜像成常驻样式）。
 */
function findLookSource(): HTMLElement | null {
  for (const selector of LOOK_SOURCE_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el || el.tagName !== 'BUTTON') continue;
    const rect = el.getBoundingClientRect();
    if (rect.width < FAB_MIN_SIZE || rect.width > FAB_MAX_SIZE) continue;
    if (Math.abs(rect.width - rect.height) > 1) continue;
    if (el.matches(':hover')) continue;
    return el;
  }
  return null;
}

/**
 * 让设置按钮与 X 自己的悬浮按钮**完全一致**（尺寸 / 圆角 / 图标大小 / 描边阴影 / 配色）。
 *
 * 不去猜 X 的三套主题色，而是直接镜像它当前按钮的计算样式：X 换主题、改版都能自动跟上。
 * 先写配置里的兜底几何（55×55 / 圆角 16 / 图标 32，2026-09-13 实测），
 * 页面里读不到 X 的按钮时（如 /i/grok、X Chat）就用兜底值，尺寸仍然一致。
 */
function syncFabLook(): void {
  if (!fab) return;
  const { size, radius, iconSize } = CONFIG.settings.fab;
  fab.style.width = `${size}px`;
  fab.style.height = `${size}px`;
  fab.style.borderRadius = `${radius}px`;
  fab.style.setProperty('--te-set-fab-icon', `${iconSize}px`);

  const source = findLookSource();
  if (!source) return;
  const computed = getComputedStyle(source);
  // 透明背景（抽屉展开过程中的过渡态）不作数，保留兜底外观
  if (!computed.backgroundColor || computed.backgroundColor === 'rgba(0, 0, 0, 0)') return;

  const rect = source.getBoundingClientRect();
  const round = (value: number): number => Math.round(value);
  fab.style.width = `${round(rect.width)}px`;
  fab.style.height = `${round(rect.height)}px`;
  fab.style.borderRadius = computed.borderRadius;
  fab.style.backgroundColor = computed.backgroundColor;
  fab.style.borderWidth = computed.borderTopWidth;
  fab.style.borderStyle = computed.borderTopStyle;
  fab.style.borderColor = computed.borderTopColor;
  fab.style.boxShadow = computed.boxShadow;
  fab.style.color = computed.color;
  const icon = source.querySelector('svg');
  if (icon) {
    const iconRect = icon.getBoundingClientRect();
    if (iconRect.width > 0) fab.style.setProperty('--te-set-fab-icon', `${round(iconRect.width)}px`);
  }
}

/**
 * 把设置按钮摆到 Grok 按钮上方：取右下角抽屉容器里最高的上缘，往上留一个间距。
 * 容器都不在（/i/grok 等页面）时用配置里的固定偏移，位置与其它页面保持一致。
 */
function anchorFab(): void {
  if (!fab) return;
  const { right, gap, fallbackBottom } = CONFIG.settings;
  let top = Number.POSITIVE_INFINITY;
  for (const selector of DRAWER_SELECTORS) {
    const el = document.querySelector<HTMLElement>(selector);
    if (!el) continue;
    const rect = el.getBoundingClientRect();
    // 高度为 0 说明抽屉整体收起（无布局盒），不参与定位
    if (rect.height <= 0) continue;
    if (rect.top < top) top = rect.top;
  }
  fab.style.right = `${right}px`;
  fab.style.bottom = `${Number.isFinite(top) ? Math.round(window.innerHeight - top + gap) : fallbackBottom}px`;
  syncFabLook();
  observeDrawers();
}

/* ------------------------------------------------------------------ *
 * 弹窗
 * ------------------------------------------------------------------ */

function buildFab(): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = FAB_CLASS;
  button.title = '页面优化设置';
  button.setAttribute('aria-label', '页面优化设置');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = GEAR_ICON;
  button.addEventListener('click', () => {
    if (opened) closePanel();
    else openPanel();
  });
  return button;
}

/** 开关行：左侧名称 / 说明 / 快捷键，右侧自绘 switch */
function buildRow(item: SettingItem): HTMLElement {
  const row = document.createElement('div');
  row.className = 'te-settings-row';
  row.dataset.teSetting = item.id;

  const text = document.createElement('div');
  text.className = 'te-settings-text';

  const label = document.createElement('span');
  label.className = 'te-settings-label';
  label.textContent = item.label;
  if (item.shortcut) {
    const kbd = document.createElement('kbd');
    kbd.className = 'te-settings-kbd';
    kbd.textContent = item.shortcut;
    label.appendChild(kbd);
  }
  text.appendChild(label);

  const desc = document.createElement('span');
  desc.className = 'te-settings-desc';
  desc.textContent = item.description;
  text.appendChild(desc);

  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'te-settings-switch';
  toggle.setAttribute('role', 'switch');
  toggle.setAttribute('aria-label', item.label);
  toggle.addEventListener('click', () => {
    // 功能自己生效并持久化，随后同步行状态
    item.toggle();
    notifySettingsChanged();
  });

  row.appendChild(text);
  row.appendChild(toggle);
  return row;
}

/** 按 group 归并开关行：同名分组合并为一段，顺序按首次出现 */
function buildBody(): HTMLElement {
  const body = document.createElement('div');
  body.className = 'te-settings-body';
  const groups = new Map<string, HTMLElement>();
  for (const item of getSettings()) {
    let section = groups.get(item.group);
    if (!section) {
      section = document.createElement('section');
      section.className = 'te-settings-group';
      const title = document.createElement('h3');
      title.className = 'te-settings-group-title';
      title.textContent = item.group;
      section.appendChild(title);
      groups.set(item.group, section);
      body.appendChild(section);
    }
    section.appendChild(buildRow(item));
  }
  return body;
}

/** 打开时重建开关行（设置项增删时），随后同步状态 */
function renderRows(): void {
  if (!dialog) return;
  const ids = getSettings()
    .map((item) => item.id)
    .join(',');
  if (ids !== renderedIds) {
    renderedIds = ids;
    const previous = dialog.querySelector('.te-settings-body');
    const body = buildBody();
    if (previous) previous.replaceWith(body);
    else dialog.insertBefore(body, dialog.querySelector('.te-settings-foot'));
  }
  syncRows();
}

/** 同步每个开关的当前状态（面板点击与页面快捷键都会走到这里） */
function syncRows(): void {
  if (!dialog) return;
  for (const row of dialog.querySelectorAll<HTMLElement>('.te-settings-row')) {
    const item = getSettings().find((candidate) => candidate.id === row.dataset.teSetting);
    const toggle = row.querySelector<HTMLButtonElement>('.te-settings-switch');
    if (!item || !toggle) continue;
    const on = item.isEnabled();
    toggle.setAttribute('aria-checked', on ? 'true' : 'false');
    row.dataset.teSettingState = on ? 'on' : 'off';
  }
}

function buildOverlay(): HTMLElement {
  const layer = document.createElement('div');
  layer.className = OVERLAY_CLASS;
  layer.setAttribute(OPEN_ATTR, 'false');
  // 点遮罩关闭（只认落在遮罩本身上的点击，弹窗内部的点击不冒泡关闭）
  layer.addEventListener('click', (event) => {
    if (event.target === layer) closePanel();
  });

  const box = document.createElement('div');
  box.className = 'te-settings-dialog';
  box.setAttribute('role', 'dialog');
  box.setAttribute('aria-modal', 'true');
  box.setAttribute('aria-labelledby', 'te-settings-title');
  box.tabIndex = -1;

  const head = document.createElement('header');
  head.className = 'te-settings-head';
  const heading = document.createElement('div');
  heading.className = 'te-settings-heading';
  const title = document.createElement('h2');
  title.className = 'te-settings-title';
  title.id = 'te-settings-title';
  title.textContent = '设置';
  const sub = document.createElement('p');
  sub.className = 'te-settings-sub';
  sub.textContent = 'Twitter / X 页面优化';
  heading.appendChild(title);
  heading.appendChild(sub);

  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'te-settings-close';
  close.setAttribute('aria-label', '关闭设置');
  close.innerHTML = CLOSE_ICON;
  close.addEventListener('click', () => closePanel());

  head.appendChild(heading);
  head.appendChild(close);

  const foot = document.createElement('p');
  foot.className = 'te-settings-foot';
  foot.textContent = '改动即时生效，并保存在本机（脚本管理器与 localStorage 双写）。';

  box.appendChild(head);
  box.appendChild(foot);
  layer.appendChild(box);

  dialog = box;
  return layer;
}

function openPanel(): void {
  if (!overlay) return;
  renderRows();
  opened = true;
  overlay.setAttribute(OPEN_ATTR, 'true');
  fab?.setAttribute('aria-expanded', 'true');
  dialog?.focus();
}

function closePanel(): void {
  if (!overlay) return;
  opened = false;
  overlay.setAttribute(OPEN_ATTR, 'false');
  fab?.setAttribute('aria-expanded', 'false');
  fab?.focus();
}

/* ------------------------------------------------------------------ *
 * 启用
 * ------------------------------------------------------------------ */

export function enableSettingsPanel(): void {
  // 几何令牌先于挂载生成：按钮一进 DOM 就有正确尺寸（不依赖 X 的抽屉是否存在）
  renderFabSheet();

  const mount = (): void => {
    // 根节点被 React 重挂 app shell 时连根删掉 → 整个重建（弹窗状态一并复位）
    if (!root?.isConnected) {
      opened = false;
      root = document.createElement('div');
      root.className = ROOT_CLASS;
      fab = buildFab();
      overlay = null;
      dialog = null;
      root.appendChild(fab);
      document.body.appendChild(root);
    }
    if (!overlay) {
      overlay = buildOverlay();
      root.appendChild(overlay);
      // 设置项在功能启用时陆续登记，这里先渲染一次（后续变化走 onSettingsChanged）
      renderRows();
    }
    anchorFab();
  };

  // document-start 注入时 body 还没有生成：用 waitForElement 等它（不用 DOMContentLoaded ——
  // 脚本管理器可能在 DOMContentLoaded 之后才注入，那样回调永远不会触发）
  void waitForElement('body', { name: 'document.body' }).then((body) => {
    if (body) mount();
  });

  // 右下角抽屉展开 / 收起、视口尺寸、SPA 导航、布局重算都会挪动锚点
  window.addEventListener('resize', anchorFab);
  onRouteChanged(() => anchorFab());
  document.addEventListener('te:layout', anchorFab);

  // X 的 SPA 导航会重挂 app shell：自建根节点若被连根删掉就补挂（检查很廉价，可放在共享批次里）
  onDomChanged(() => {
    if (root && !root.isConnected) mount();
  });

  // 面板点击或页面快捷键改了开关 → 同步开关状态
  onSettingsChanged(() => syncRows());

  // Esc 关闭。捕获阶段处理并拦住冒泡，避免同一次 Esc 又去关 X 自己的浮层
  window.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape' || !opened) return;
      event.preventDefault();
      event.stopPropagation();
      closePanel();
    },
    true,
  );
}
