/**
 * 脚本自写尺寸登记表 —— 「禁止自反馈」不变式。
 *
 * 背景（2026-09-14，两次踩同一个坑）：宽度解锁器是**按几何推断**的启发式 ——
 * 「计算宽度落在 600px 附近、且明显窄于容器」⇒ 判为「X 写死的列宽上限」并改写成 100%。
 * 而脚本自己也会写尺寸：媒体等比模式把图片连同整条媒体链写成 608px
 * （540 × 1200/1066），正好落进同一区间 —— 启发式于是把**脚本刚写下的值**
 * 当成 X 的容器上限，再改成 `width: 100% !important`：图片被横向拉伸 1.6 倍，
 * 且命中与否取决于两个扫描谁先跑到该节点（同一页面刷新后观感不同）。
 *
 * 不变式：**脚本自己写过的元素，永远不作为启发式的输入**。
 * 写几何的功能在写入处调 `markScriptSized()`；按尺寸/样式推断的功能用
 * `isScriptSized()` 过滤。这样新增功能不会因为「数值凑巧落进某个区间」
 * 把既有启发式带偏 —— 不需要再为每个新场景加一条豁免。
 */
const ATTR = 'teScriptSized';
const SELECTOR = '[data-te-script-sized]';

/** 标记该元素的尺寸是脚本自己写的（幂等） */
export function markScriptSized(el: HTMLElement): void {
  if (!el.dataset[ATTR]) el.dataset[ATTR] = '1';
}

/** 撤销标记（脚本把尺寸还原成 X 原生后调用） */
export function unmarkScriptSized(el: HTMLElement): void {
  delete el.dataset[ATTR];
}

/** 该元素自身或其任一祖先是否由脚本写过尺寸 */
export function isScriptSized(el: Element): boolean {
  return el.closest(SELECTOR) !== null;
}
