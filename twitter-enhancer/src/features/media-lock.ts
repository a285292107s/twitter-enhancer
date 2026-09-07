/**
 * 媒体尺寸锁定：主列加宽后，媒体（图片 / 视频）不跟着无节制放大。
 *
 * 背景（真机实测）：X 把媒体区宽度绑定到推文内容宽——主列 600→800 时，
 * 轮播格 306×565 → 426×786、单图同比例放大（宽高均 +39%），竖图高度可到 890px，
 * 一屏放不下、必须滚动页面才能看全。
 * 各类媒体的尺寸来源不一致：单图是内联像素（React 算好写死）、轮播格是内部计算，
 * 逐个覆盖内联值既脆弱又会破坏比例，因此对「媒体区宿主」整体做视觉缩放：
 *
 * 1. 从每个媒体元素向上找第一个超限祖先（宽超锁定值或高超限高）作为宿主——
 *    它就是「宽度跟随内容宽」的那一层（轮播列表 / 单图媒体区）；
 * 2. 对宿主设 transform: scale(宽向因子与高向因子的较小值)：
 *    横图被宽度钳到 566px、竖长图被高度钳到 maxHeight（一屏内看全），
 *    任何媒体类型统一生效，缩小是超采样、不会模糊，宽高取同一比例、不变形；
 * 3. transform 不参与布局，用负 margin-bottom 补偿缩小的占位高度，
 *    否则推文底部会留出一大段空白；
 * 4. 只改宿主的 inline style，不插入 / 移动任何 React 管理的节点。
 *
 * 监听策略（性能版）：
 * - 滚动时新增 / 恢复的媒体来自 dom-watch 单例派发的共享批次，只增量处理
 *   新增节点子树，不再每 50ms 对全站 MEDIA_SELECTOR 全量重扫；
 * - 每个宿主挂 ResizeObserver：图片加载完成、主列宽变化导致宿主尺寸变化时
 *   就地重算缩放（有界，宿主数量 = 屏幕上媒体数）；
 * - 主列宽切换（宽时间线开关 / 右栏显隐 → te:layout）后做一次全量对账，
 *   把宽高已回落 / 超限的宿主统一修正；媒体数量少，全量对账代价可忽略。
 */
import { CONFIG } from '../config';
import { registerToggleMenu } from '../lib/menu';
import { readFlag, writeFlag } from '../lib/store';
import { onDomChanged } from '../lib/dom-watch';

/** 媒体元素：图片与视频 */
const MEDIA_SELECTOR = '[data-testid="tweetPhoto"],[data-testid="videoPlayer"]';
/** 宿主上记录已缩放的标记 */
const FLAG = 'teMediaLocked';
/** 宿主上记录已挂 ResizeObserver 的标记（避免重复观察） */
const OBSERVED = 'teMediaObserved';

let locked = CONFIG.media.lock;

/** 宿主上的锁定标记属性选择器（dataset.teMediaLocked → data-te-media-locked） */
const FLAG_SELECTOR = '[data-te-media-locked]';

/** 全局共享的 ResizeObserver：宿主尺寸变化时重算缩放 */
const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) {
          scaleHost(entry.target as HTMLElement);
        }
      })
    : null;

/**
 * 解除单个宿主的缩放（含清理标记与 ResizeObserver）。
 * 供「关闭开关」「scale 回落到 1」「清除嵌套冗余锁定」三条路径复用。
 */
function unlockHost(host: HTMLElement): void {
  for (const prop of ['transform', 'transform-origin', 'margin-bottom']) {
    host.style.removeProperty(prop);
  }
  delete host.dataset[FLAG];
  delete host.dataset[OBSERVED];
  resizeObserver?.unobserve(host);
}

/**
 * 媒体区宿主：媒体元素向上第一个宽度达到锁定值的祖先。
 * 「宽度 = 推文内容宽」是媒体区唯一可靠的指纹（轮播列表 / 单图媒体区都满足）；
 * 不能用高度做条件——虚拟列表容器、超长占位等元素同样「高」，误命中会把整个
 * 时间线容器缩成几个像素、并产生巨额负 margin 导致推文重叠（真机踩过）。
 * 宽度条件用 >=：主列回落 600 时媒体区恰好 566，竖图超高仍需被钳。
 */
function findHost(el: Element): HTMLElement | null {
  let p = el.parentElement;
  while (p && p !== document.body) {
    if (p.offsetWidth >= CONFIG.media.lockWidth) return p;
    p = p.parentElement;
  }
  return null;
}

/**
 * 对单个宿主执行缩放（幂等：transform 不影响 offsetWidth / offsetHeight）。
 *
 * 缩放因子取宽、高两个方向的较小值（contain 语义）：
 * - 横图被宽度钳住：不超过 566px（600 布局的内容宽）；
 * - 竖图被高度钳住：不超过 maxHeight，一屏内即可看全，无需上下滚动；
 * - 两者都不超时 scale = 1，保持 X 原生尺寸。
 * 宽高取同一比例，图片永远不变形。
 */
function scaleHost(host: HTMLElement): void {
  // 开关已关闭时不再加锁（ResizeObserver 回调仍可能触发本函数）
  if (!locked) {
    if (host.dataset[FLAG]) unlockHost(host);
    return;
  }
  const width = host.offsetWidth;
  const height = host.offsetHeight;
  if (width === 0 || height === 0) return;
  // 高度超过 2.5 屏的宿主不是媒体区（虚拟列表 / 超长占位容器），跳过以防误缩
  if (height > window.innerHeight * 2.5) return;
  const scale = Math.min(
    1,
    CONFIG.media.lockWidth / width,
    CONFIG.media.maxHeight / height,
  );
  if (scale >= 1) {
    // 布局尺寸本就在锁定范围内（如右栏显示时主列回落 600），清掉可能残留的缩放
    if (host.dataset[FLAG]) unlockHost(host);
    return;
  }
  host.style.transformOrigin = 'top left';
  host.style.transform = `scale(${scale.toFixed(4)})`;
  host.style.marginBottom = `${-Math.round(height * (1 - scale))}px`;
  host.dataset[FLAG] = '1';
  if (resizeObserver && !host.dataset[OBSERVED]) {
    resizeObserver.observe(host);
    host.dataset[OBSERVED] = '1';
  }
}

function applyOne(media: Element): void {
  // 已被外层锁定宿主覆盖的媒体不再处理：
  // 外层缩放会连同内容一起缩，再锁内层会叠加（0.79 × 0.69 → 图片被压到一半），
  // 真机踩过：轮播行（766）因同行小图被锁定时，行内大图（716 宿主）已各自锁定。
  if (media.closest(FLAG_SELECTOR)) return;
  const host = findHost(media);
  if (!host) return;
  // 锁外层前清掉内部冗余锁定——外层缩放已覆盖全部内容
  for (const inner of host.querySelectorAll(FLAG_SELECTOR)) {
    unlockHost(inner as HTMLElement);
  }
  scaleHost(host);
}

/**
 * 全量对账：归一化嵌套锁定，锁定新出现的媒体，并对已锁宿主重算缩放。
 * 仅「开关切换 / 布局大变化（te:layout）/ 增量批次 overflow」时调用，媒体数少，代价可忽略。
 *
 * 注意必须显式重算「已锁宿主」：宿主一旦加锁，其内部媒体就被标记覆盖、
 * applyOne 不再触碰它；若主列宽度回落 / 布局变化让宿主不再超限，只能靠这里
 * 或宿主的 ResizeObserver 解除（scale ≥ 1 时 scaleHost 自动解锁）。
 */
function reconcileMediaLock(): void {
  if (!locked) {
    resetMediaLock();
    return;
  }
  // 归一化：历史上产生的嵌套锁定一律保留最外层，内层解除
  for (const inner of document.querySelectorAll(`${FLAG_SELECTOR} ${FLAG_SELECTOR}`)) {
    unlockHost(inner as HTMLElement);
  }
  // 锁新出现的媒体（未被外层覆盖的才处理）
  for (const media of document.querySelectorAll(MEDIA_SELECTOR)) {
    if (media.closest(FLAG_SELECTOR)) continue;
    const host = findHost(media);
    if (!host) continue;
    // 锁外层前清掉内部冗余锁定——外层缩放已覆盖全部内容
    for (const inner of host.querySelectorAll(FLAG_SELECTOR)) {
      unlockHost(inner as HTMLElement);
    }
    scaleHost(host);
  }
  // 对已锁宿主重算：布局变化后可能仍需缩放 / 已回落应解锁（scaleHost 内处理解锁）
  for (const host of document.querySelectorAll<HTMLElement>(FLAG_SELECTOR)) {
    scaleHost(host);
  }
}

/** 增量处理：只检视新增节点子树里的媒体 */
function processAdded(added: Element[]): void {
  if (!locked) return;
  for (const node of added) {
    if (!node.isConnected) continue;
    if (node.matches?.(MEDIA_SELECTOR)) applyOne(node);
    const inside = node.querySelectorAll?.(MEDIA_SELECTOR);
    if (inside) {
      for (const media of inside) applyOne(media);
    }
  }
}

/** 撤销所有缩放（关闭开关时还原 X 原生观感） */
function resetMediaLock(): void {
  // 注意选择器必须是 data-te-media-locked（dataset 驼峰会转成连字符属性名）；
  // 曾写成 [data-teMediaLocked] 匹配不到任何元素，导致关闭开关后缩放残留。
  for (const el of document.querySelectorAll(FLAG_SELECTOR)) {
    unlockHost(el as HTMLElement);
  }
}

function toggleLock(): void {
  locked = !locked;
  reconcileMediaLock();
  void writeFlag('media-lock', locked);
}

export function enableMediaLock(): void {
  reconcileMediaLock();
  // 存储读取是异步的，先用默认值渲染，读到用户设置后再覆盖
  void readFlag('media-lock').then((stored) => {
    if (stored !== null && stored !== locked) {
      locked = stored;
      reconcileMediaLock();
    }
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reconcileMediaLock, { once: true });
  }
  window.addEventListener('load', reconcileMediaLock, { once: true });

  // 增量：订阅 dom-watch 单例的共享新增节点池（滚动恢复的媒体从这里来）
  onDomChanged(({ added, overflow: hadOverflow }) => {
    if (!locked) return;
    if (hadOverflow) {
      // 单批新增超上限、池可能丢节点：做一次全量对账兜底
      reconcileMediaLock();
      return;
    }
    processAdded(added);
  });

  // 主列宽度 / 右栏显隐变化（宽时间线开关、右栏切换）会整体改变媒体宿主尺寸，
  // 全量对账一次修正缩放。媒体宿主本身也挂 ResizeObserver，双保险。
  const onLayout = (): void => {
    if (locked) reconcileMediaLock();
  };
  document.addEventListener('te:layout', onLayout);

  registerToggleMenu({
    label: (enabled) => `图片锁定原生尺寸：${enabled ? '开' : '关'}`,
    isEnabled: () => locked,
    toggle: toggleLock,
  });
}
