/**
 * jsdom 回归夹具（`scripts/verify.mjs` 的基础设施，不含任何断言场景）。
 *
 * 这里只放两类东西，它们都是**所有场景共用**的：
 *
 * 1. **jsdom 缺布局引擎的补偿**：`offsetWidth` / `offsetHeight` / `clientWidth` 与
 *    `getBoundingClientRect` 的桩。jsdom 没有布局，这些属性恒为 0，而脚本的判断大量
 *    依赖它们（宽列是否生效、媒体宿主宽度、右栏占用、设置按钮锚点）。桩是**按需求值**的：
 *    元素带 `data-w` / `data-h` 就返回它，否则按下面的实测几何回答。
 * 2. **一份实测几何**（2026-09 真机 1440 视口 + 1280×720 悬浮按钮实测）：三栏行宽、
 *    主列原生宽与左缘、右栏几何与其保留右边距、右下角两个抽屉的收起态盒子。
 *    场景里需要别的几何时用 `data-w` / `data-h` 就地覆盖，不要再往这里加「某个场景专用」的常量。
 *
 * **不做的两件事**（有意）：
 * - **不与 `scripts/e2e-real.mjs` 共用几何**。那边是**真机测量**（Playwright 打开真实 x.com
 *   量出来的值），这边是**桩**。两者角色相反：桩允许与真机漂移（漂了只是这台夹具失真），
 *   真机测量才是事实来源。共用一份常量会把「桩过时了」和「X 改版了」变成同一个故障。
 * - **不做按场景过滤 / 分文件**。场景之间有真实的顺序耦合：有一部分场景读的是前面场景
 *   建出来的 window（例如「按 CONFIG 拼装的样式表」读的是第一个场景那个窗口），还有若干
 *   共享的 HTML 夹具与辅助函数。把它们拆成互不依赖的场景文件是独立的一件事，
 *   要先解开这些耦合（见 docs/development.md）。
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

/** 打包产物（IIFE）：场景用 `window.eval(script)` 注入 */
export const script = readFileSync(new URL('../dist/twitter-enhancer.user.js', import.meta.url), 'utf8');

/** jsdom 默认视口 1024 低于脚本的 1095 断点，会让宽列直接走「不放大」分支 */
const VIEWPORT_WIDTH = 1440;

/** 2026-09 真机实测几何（元素盒由边导出，避免同一个宽度写两遍） */
const rect = (left, right, top, bottom) => ({
  left,
  right,
  top,
  bottom,
  width: right - left,
  height: bottom - top,
});
const GEOMETRY = {
  /** 左导航条 logo 链接 */
  logo: rect(12, 62, 8, 58),
  /** 左导航条本体（宽 275） */
  nav: rect(0, 275, 0, 600),
  /** logo 所在的行容器（宽 275、高 50） */
  logoRow: rect(0, 275, 0, 50),
  /** 三栏行左缘 363、原生主列宽 600；宽列生效后真实宽度由 CSS 变量决定，桩保持原生值 */
  primaryLeft: 363,
  primaryNativeWidth: 600,
  /** 右栏 350 宽（左缘 993 / 右缘 1343），右缘之外另有 70px 右边距 */
  sidebar: rect(993, 1343, 0, 100),
  sidebarReservedMargin: 70,
  /** 三栏行宽 1050 = 600 主列 + 30 间距 + 350 右栏 + 70 右栏右边距 */
  rowWidth: 1050,
  /** 右下角 Grok 抽屉容器（1280×720 实测 350×55 @ y=586）与其中的悬浮按钮 55×55 */
  grokDrawer: rect(910, 1260, 586, 641),
  grokDrawerHeader: rect(1205, 1260, 586, 641),
};

/**
 * 默认页面夹具：三栏时间线 + 左导航条，与 `createWindow()` 的默认值一致。
 * 场景需要别的结构时自己传 HTML，不要改这里（这里一改，几十个场景的基准同时漂）。
 */
export const HTML = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary">
    <a href="/home" aria-label="X">logo</a>
    <a href="/home">主页</a>
    <a href="/explore">探索</a>
  </nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="timeline" style="max-width:600px">
          <div data-testid="cellInnerDiv">
            <div id="tweet" style="width:600px">tweet body</div>
          </div>
          <div id="avatar" style="width:48px">avatar</div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn">
      <form role="search"><input data-testid="SearchBox_Search_Input" /></form>
    </div>
  </div>
</body></html>`;

/* ------------------------------------------------------------------ *
 * 断言与结果收集
 * ------------------------------------------------------------------ */

export const results = [];

export const expect = (name, actual, wanted) => {
  results.push({ name, actual, wanted, ok: Object.is(actual, wanted) });
};

export const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** 功能公布的高度预算（单一事实来源：别在测试里复算 media-cap 的公式） */
export const budgetOf = (window) => Number(window.document.documentElement.dataset.teMediaBudget);

/* ------------------------------------------------------------------ *
 * 窗口
 * ------------------------------------------------------------------ */

export function createWindow(html = HTML, url = 'https://x.com/home') {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.error('[jsdom]', e.message));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
    virtualConsole,
  });
  const { window } = dom;
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: VIEWPORT_WIDTH });
  // 布局桩：带 data-w / data-h 的元素返回指定值，其余按下面的规则回答
  Object.defineProperty(window.HTMLElement.prototype, 'offsetWidth', {
    configurable: true,
    get() {
      const w = this.getAttribute?.('data-w');
      return w ? Number(w) : 0;
    },
  });
  Object.defineProperty(window.HTMLElement.prototype, 'offsetHeight', {
    configurable: true,
    get() {
      const h = this.getAttribute?.('data-h');
      return h ? Number(h) : 0;
    },
  });
  // clientWidth 恒为 0 → 主列一律回答「宽列已生效」的 980（媒体钳制 / 解锁器都按它判断）
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const forced = this.getAttribute?.('data-w');
      if (forced) return Number(forced);
      return this.getAttribute('data-testid') === 'primaryColumn' ? 980 : 0;
    },
  });
  Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.matches?.('a[aria-label="X"]')) return GEOMETRY.logo;
      if (this.matches?.('nav[aria-label="Primary"]')) return GEOMETRY.nav;
      if (this.matches?.('#logoRow')) return GEOMETRY.logoRow;
      // 主列：带 data-w 时按指定值（模拟 X Chat 原生 1187 / Grok 原生 980）
      if (this.matches?.('[data-testid="primaryColumn"]')) {
        const width = Number(this.getAttribute('data-w') ?? GEOMETRY.primaryNativeWidth);
        return rect(GEOMETRY.primaryLeft, GEOMETRY.primaryLeft + width, 0, 100);
      }
      if (this.matches?.('[data-testid="sidebarColumn"]')) return GEOMETRY.sidebar;
      if (this.matches?.('[data-testid="GrokDrawer"]')) return GEOMETRY.grokDrawer;
      if (this.matches?.('[data-testid="GrokDrawerHeader"]')) return GEOMETRY.grokDrawerHeader;
      return rect(0, 0, 0, 0);
    },
  });
  // 行宽 1050：宽时间线「右栏隐藏时铺满内容区」的目标宽 = 1050 − 70 = 980 由此可复现
  for (const primary of window.document.querySelectorAll('[data-testid="primaryColumn"]')) {
    const row = primary.parentElement;
    if (row && !row.hasAttribute('data-w')) row.setAttribute('data-w', String(GEOMETRY.rowWidth));
  }
  for (const sidebar of window.document.querySelectorAll('[data-testid="sidebarColumn"]')) {
    sidebar.style.marginRight = `${GEOMETRY.sidebarReservedMargin}px`;
  }
  return window;
}

/* ------------------------------------------------------------------ *
 * 会话辅助（都驱动真实 UI，而不是直接调功能内部函数）
 * ------------------------------------------------------------------ */

export const press = (window, code) =>
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true }),
  );

/** 打开页内设置弹窗（已打开则原样返回） */
export const openSettings = (window) => {
  const overlay = window.document.querySelector('.te-settings-overlay');
  if (overlay?.getAttribute('data-te-settings-open') !== 'true') {
    window.document.querySelector('.te-settings-fab').click();
  }
  return overlay;
};

/** 通过设置面板切换某个开关 */
export const toggleSetting = (window, id) => {
  openSettings(window);
  const toggle = window.document.querySelector(
    `.te-settings-row[data-te-setting="${id}"] .te-settings-switch`,
  );
  toggle.click();
  return toggle;
};

/** 读某个开关当前的 aria-checked */
export const settingState = (window, id) =>
  window.document
    .querySelector(`.te-settings-row[data-te-setting="${id}"] .te-settings-switch`)
    ?.getAttribute('aria-checked');

/* ------------------------------------------------------------------ *
 * 输出
 * ------------------------------------------------------------------ */

/** 打印全部断言并按失败数决定退出码（失败一项也是失败） */
export function report() {
  let failed = 0;
  for (const r of results) {
    if (!r.ok) failed += 1;
    console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  →  实际=${String(r.actual)}`);
  }
  console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed} 项失败`);
  process.exit(failed === 0 ? 0 : 1);
}
