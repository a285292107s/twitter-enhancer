/**
 * 门控事实 —— 功能之间互相读的那几个 `html[data-te-*]` 属性，只有这里知道它们的名字与取值。
 *
 * ## 为什么要有这个模块
 *
 * 「宽列是否真的生效」这个判据有三个读者：宽时间线自己（写）、媒体钳制
 * （`dataset.teTimeline === 'wide'`，还额外补了一条宽度条件）、宽度解锁器（经回调传入）。
 * `html[data-te-sidebar]` 由右栏功能写，宽时间线又把属性名与取值（`'teSidebar'` / `'off'`）
 * 用字面量抄了一遍。同一份事实于是有了多个副本 ——
 * docs/architecture.md 那条「判定的实现各自只允许有一处，多了必然漂」在代码里并不成立。
 *
 * 这里把**属性名与取值词表**变成模块私有，功能之间只传布尔值。属性本身照旧写进
 * `html[data-te-*]`：CSS、DevTools 与验证脚本按它工作（`docs/architecture.md`
 * 的「单一布局门控点」不变），只是它不再充当功能之间的 API。
 *
 * 取值不是统一的 on/off：宽时间线的开值是 `'wide'`（CSS 与验证脚本都按它判定），
 * 这里原样保留 —— 词表是本模块的实现细节，调用方只看见 true/false。
 */

const TIMELINE_ATTR = 'teTimeline';
const TIMELINE_WIDE = 'wide';
const SIDEBAR_ATTR = 'teSidebar';
const SIDEBAR_ON = 'on';
const SIDEBAR_OFF = 'off';

/** 宽列门控（`html[data-te-timeline]`）：同时决定 CSS 宽度覆盖、媒体高度钳制、宽度解锁器是否生效 */
export function setWideTimeline(wide: boolean): void {
  document.documentElement.dataset[TIMELINE_ATTR] = wide ? TIMELINE_WIDE : 'off';
}

export function isWideTimeline(): boolean {
  return document.documentElement.dataset[TIMELINE_ATTR] === TIMELINE_WIDE;
}

/**
 * 右栏是否已被脚本隐藏（`html[data-te-sidebar]`）。
 * 属性**缺失**表示「脚本没管过右栏」⇒ 右栏可见（右栏功能整体关闭时也不会误判）。
 */
export function setSidebarHidden(hidden: boolean): void {
  document.documentElement.dataset[SIDEBAR_ATTR] = hidden ? SIDEBAR_OFF : SIDEBAR_ON;
}

export function isSidebarHidden(): boolean {
  return document.documentElement.dataset[SIDEBAR_ATTR] === SIDEBAR_OFF;
}
