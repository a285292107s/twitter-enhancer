// GM shim —— 由 e2e-real.mjs 在页面脚本执行前经 addInitScript 注入（document-start 时序）。
//
// 为什么只需补这一个 API（2026-09 依据 dist 产物逐条核对）：
// - CSS 注入：vite-plugin-monkey 把每个 CSS import 编译成
//     if (typeof GM_addStyle === "function") GM_addStyle(c)
//   无 GM 环境若不补，脚本的全部样式功能（宽列 / tweet-ui / sidebar）都不会注入 —— 硬依赖；
// - store.ts 的 GM_getValue / GM_setValue：编译成 (() => typeof GM_getValue != "undefined"
//   ? GM_getValue : void 0)()，未定义时 store.gmAvailable() 为 false，
//   自动落到仓库自带的 localStorage 双写路径 —— 保持未定义即可，行为与 jsdom 回归一致；
// - 开关不再走油猴菜单（GM_registerMenuCommand 已从 grant 中移除），页内设置面板是普通 DOM，
//   本通道与 jsdom 回归都能正常覆盖它。
//
// 时序硬化：Playwright addInitScript 在 document 刚创建时执行，document.documentElement /
// document.head 可能尚未生成（真 TM 的 document-start 同理）。style 无处可挂时先排队，
// 待根节点出现后由 MutationObserver 补挂，避免 appendChild(null) 崩溃。
(function () {
  'use strict';
  if (typeof window.GM_addStyle === 'function') return;

  var pending = [];
  function target() {
    return document.head || document.documentElement;
  }
  function appendNow(css) {
    var t = target();
    if (!t) return false;
    var style = document.createElement('style');
    style.textContent = css;
    t.appendChild(style);
    return true;
  }
  function flush() {
    for (var i = 0; i < pending.length; i++) {
      if (!appendNow(pending[i])) return false;
    }
    pending = [];
    return true;
  }

  window.GM_addStyle = function gmAddStyle(css) {
    if (!appendNow(css)) pending.push(css);
  };

  if (!document.documentElement && typeof MutationObserver !== 'undefined') {
    var mo = new MutationObserver(function () {
      if (document.documentElement && flush()) mo.disconnect();
    });
    mo.observe(document, { childList: true });
  }
})();
