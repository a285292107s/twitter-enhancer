/**
 * 右侧栏隐藏（页内开关 + Alt+B）。
 *
 * 设计要点：
 * 1. 隐藏右栏用 CSS 属性开关（html[data-te-sidebar]），不删节点、不破坏 X 的 React 树。
 * 2. 右栏显示时把它钉在主列右侧（行改左对齐 + 右栏 margin-left），不依赖 space-between
 *    在剩余空间里的分配，见 applySidebarGap。
 * 3. 左导航条（rail）**不写任何样式** —— X 自己的 fixed 定位已经正确（与主列左缘对齐），
 *    由脚本覆盖反而会让 /home 与 /i/grok 的导航条走两套机制，见下方 rail 一节。
 *
 * 曾经还包含「搜索框迁移到左导航条」（自建输入框 / 搬原生搜索框两种模式），
 * 该功能已按用户要求移除：模块只负责右栏显隐。
 */
import { CONFIG } from '../config';
import { createToggle } from '../lib/toggle';
import { setSidebarHidden } from '../lib/gate';
import { onDomChanged, dispatchLayoutEvent } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import { SEL } from '../lib/selectors';
import './sidebar.css';

/** 稳定锚点统一登记在 lib/selectors.ts */
const SIDEBAR = SEL.sidebarColumn;

function findSidebar(): HTMLElement | null {
  return document.querySelector<HTMLElement>(SIDEBAR);
}

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
 * 右栏显示时把它钉在主列右侧 CONFIG.sidebar.gap（X 原生 30px）：行改左对齐 + 右栏 margin-left。
 * 不依赖 space-between 在剩余空间里"随机"分配（行被 min-width 撑开后剩余空间会变）。
 *
 * 左导航条不在此处处理 —— 它由 X 自己 fixed 定位，脚本不写（见上面 rail 的说明）。
 */
function applySidebarGap(): void {
  const sidebar = findSidebar();
  const row = sidebar?.parentElement ?? null;
  // 开关关闭 / 右栏隐藏 / 结构未就绪 → 交回 X 原生（space-between）
  // 这一步不做任何测量（只写固定 30px 间距），因此不需要等布局就绪
  if (!CONFIG.sidebar.anchorSidebar || hidden || !sidebar || !row) {
    resetSidebarAnchor();
    return;
  }
  row.style.justifyContent = 'flex-start';
  sidebar.style.marginLeft = `${CONFIG.sidebar.gap}px`;
  anchoredSidebar = sidebar;
  anchoredRow = row;
}

/**
 * 右栏隐藏开关的当前值 —— 与 createToggle 同步的镜像（理由见 timeline-width.ts 同类注释）。
 *
 * 它（连同存储 key `sidebar`）的语义是「隐藏」，从旧版起就是这么写的；
 * 设置面板问的是「显示右侧栏」，方向由 createToggle 的 `isEnabled` 翻转 ——
 * 存储值语义不能改，那是用户机器上已经写下的数据。
 */
let hidden = CONFIG.sidebar.hiddenByDefault;

function applyHidden(value: boolean): void {
  hidden = value;
  setSidebarHidden(value);
  applySidebarGap();
  // 右栏显隐会改变主列可用宽度，通知宽时间线重算（旧版靠观察 data-te-sidebar 属性，
  // 已随全站观察器收敛移除，改由显式事件驱动）。
  // 这里不用再判「属性是否真的变化」：调用方 createToggle 只在值真的变了、或首帧第一次
  // 渲染时才会走到这里 —— 两种情况下布局都需要重算。
  dispatchLayoutEvent();
}

export function enableSidebar(): void {
  // 开关：默认值 / 存储读取 / 写盘 / 面板登记与刷新全部交给 createToggle（见 lib/toggle.ts）。
  const sidebarToggle = createToggle({
    id: 'sidebar',
    group: '布局',
    label: '显示右侧栏',
    description: '关闭后隐藏右栏，把横向空间让给主列',
    shortcut: 'Alt+B',
    default: CONFIG.sidebar.hiddenByDefault,
    // 存储值语义是「隐藏」，面板问的是「显示」—— 方向相反，只在面板侧翻转
    isEnabled: (hiddenValue) => !hiddenValue,
    apply: applyHidden,
  });

  // 首帧 / 布局稳定后各校正一次（X 的右栏可能晚于主列挂载）
  applySidebarGap();
  window.addEventListener('load', applySidebarGap, { once: true });

  // 订阅 dom-watch 单例派发的合并批次（120ms 节流）。
  // 只在「右栏 / 三栏行结构相关」的变更时才校正，避免滚动时虚拟列表插入推文触发无谓的
  // 几何重算（applySidebarGap 虽然只写固定值，但读 DOM 引用的成本没必要每批都付）。
  onDomChanged(({ added, overflow: hadOverflow, structural }) => {
    // 结构性替换（SPA 导航重挂 app shell）：三栏行 / 右栏都换了新节点，
    // 补偿样式必须立刻重写（本批次由 dom-watch 在渲染帧前同步派发）。
    if (hadOverflow || structural) {
      applySidebarGap();
      return;
    }
    for (const node of added) {
      if (node.matches?.(SIDEBAR) || node.querySelector?.(SIDEBAR)) {
        applySidebarGap();
        return;
      }
    }
  });

  // SPA 导航会重建右栏 / 三栏行容器，锚点与行对齐样式写在节点上会随旧节点一起消失：
  // 路由切换（低频）直接校正一次。
  onRouteChanged(applySidebarGap);

  // 宽时间线重算行宽后会广播 te:layout：右栏显示时主列宽度刚变，右栏的 30px 间距
  // 与行对齐需要跟着是最终值（写入幂等、无需测量，代价可忽略）。
  document.addEventListener('te:layout', applySidebarGap);

  // Alt+B 继续保留，方便键盘切换
  window.addEventListener('keydown', (event) => {
    if (!event.altKey || event.code !== 'KeyB') return;
    sidebarToggle.toggle();
    event.preventDefault();
  });
}
