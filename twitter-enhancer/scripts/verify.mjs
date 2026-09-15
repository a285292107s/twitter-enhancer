/**
 * 用 jsdom 回归验证脚本运行时行为（无需打开 x.com）。
 *
 * 覆盖：
 * 1. 宽度解锁器 unlock-width：按计算值识别并解除被写死的 600px 容器
 *    （媒体轮播 ScrollSnap-List 子树除外：格宽是媒体比例，可能正好落在锁宽区间里）；
 * 2. 推文 UI tweet-ui：主题检测、设计令牌注入、Alt+U 开关与持久化；
 * 3. 侧栏与搜索 sidebar：右栏隐藏、搜索宿主挂载、Alt+B 双向切换；
 * 4. 宽时间线 timeline-width：右栏隐藏时主列铺满 X 内容区（与 /i/grok 一致、左缘不动），
 *    右栏显示时 800 封顶；X 没渲染三栏的页面（/i/grok 单栏、/i/chat 双栏）交回原生；
 * 5. 页内设置面板 settings-panel：右下角设置按钮（Grok 按钮上方）、弹窗、开关生效。
 *
 * 运行：node scripts/verify.mjs（或 npm run verify）
 */
import { readFileSync } from 'node:fs';
import { JSDOM, VirtualConsole } from 'jsdom';

const script = readFileSync(new URL('../dist/twitter-enhancer.user.js', import.meta.url), 'utf8');

const HTML = `<!doctype html><html><head></head><body>
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

const results = [];
const expect = (name, actual, wanted) => {
  results.push({ name, actual, wanted, ok: Object.is(actual, wanted) });
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
/** 功能公布的高度预算（单一事实来源：别在测试里复算 media-cap 的公式） */
const budgetOf = (window) => Number(window.document.documentElement.dataset.teMediaBudget);

function createWindow(html = HTML, url = 'https://x.com/home') {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.error('[jsdom]', e.message));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url,
    virtualConsole,
  });
  const { window } = dom;
  // jsdom 默认视口 1024，低于脚本的 1095 断点会直接走「不放大」分支；放宽到 1440
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  // 部分断言依赖 offsetWidth / offsetHeight（jsdom 无布局引擎，默认为 0）；
  // 带 data-w / data-h 的元素返回指定值
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
  // jsdom 无布局引擎，clientWidth 恒为 0；这里让主列返回宽列已生效后的宽度 980
  // （媒体钳制 / 解锁器都按它判断「主列已经放宽」），带 data-w 的元素返回指定宽度。
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const forced = this.getAttribute?.('data-w');
      if (forced) return Number(forced);
      return this.getAttribute('data-testid') === 'primaryColumn' ? 980 : 0;
    },
  });
  // 给 logo 与导航条编造几何信息，用于验证「搜索框定位到 logo 右侧」的计算
  Object.defineProperty(window.Element.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      if (this.matches?.('a[aria-label="X"]')) {
        return { left: 12, right: 62, top: 8, bottom: 58, width: 50, height: 50 };
      }
      if (this.matches?.('nav[aria-label="Primary"]')) {
        return { left: 0, right: 275, top: 0, bottom: 600, width: 275, height: 600 };
      }
      if (this.matches?.('#logoRow')) {
        return { left: 0, right: 275, top: 0, bottom: 50, width: 275, height: 50 };
      }
      // 主列：1440 视口实测原生几何（左缘 363，原生宽 600）；宽列生效后由 CSS 变量
      // 决定真实宽度，这里保持原生值 —— 宽时间线「只放宽、从不收窄」的兜底判据
      // 读的就是它。带 data-w 时（模拟 X Chat 原生 1187 / Grok 原生 980）按指定值。
      if (this.matches?.('[data-testid="primaryColumn"]')) {
        const width = Number(this.getAttribute('data-w') ?? 600);
        return { left: 363, right: 363 + width, top: 0, bottom: 100, width, height: 100 };
      }
      // 右栏：1440 视口实测 350 宽（左缘 993 / 右缘 1343），右缘之外还有 70px 右边距
      if (this.matches?.('[data-testid="sidebarColumn"]')) {
        return { left: 993, right: 1343, top: 0, bottom: 100, width: 350, height: 100 };
      }
      // 右下角 Grok 抽屉容器：1280×720 实测 350×55 @ y=586（可见按钮距右边 20、距底边 79）。
      // 设置按钮以它的上缘定位（在 Grok 按钮正上方），见 settings-panel.ts。
      if (this.matches?.('[data-testid="GrokDrawer"]')) {
        return { left: 910, right: 1260, top: 586, bottom: 641, width: 350, height: 55 };
      }
      // Grok 悬浮按钮本体（收起态就是抽屉头）：实测 55×55，右侧留 20。
      if (this.matches?.('[data-testid="GrokDrawerHeader"]')) {
        return { left: 1205, right: 1260, top: 586, bottom: 641, width: 55, height: 55 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
  });
  // 布局桩：1440 视口实测三栏行宽 1050（= 600 主列 + 30 间距 + 350 右栏 + 70 右栏右边距）。
  // 宽时间线「右栏隐藏时铺满内容区」的目标宽度 = 1050 − 70 = 980 由此可复现。
  for (const primary of window.document.querySelectorAll('[data-testid="primaryColumn"]')) {
    const row = primary.parentElement;
    if (row && !row.hasAttribute('data-w')) row.setAttribute('data-w', '1050');
  }
  for (const sidebar of window.document.querySelectorAll('[data-testid="sidebarColumn"]')) {
    sidebar.style.marginRight = '70px';
  }
  return window;
}

const press = (window, code) =>
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true }),
  );

/** 打开页内设置弹窗（已打开则原样返回） */
const openSettings = (window) => {
  const overlay = window.document.querySelector('.te-settings-overlay');
  if (overlay?.getAttribute('data-te-settings-open') !== 'true') {
    window.document.querySelector('.te-settings-fab').click();
  }
  return overlay;
};

/** 通过设置面板切换某个开关（驱动真实 UI，而不是直接调功能内部函数） */
const toggleSetting = (window, id) => {
  openSettings(window);
  const toggle = window.document.querySelector(
    `.te-settings-row[data-te-setting="${id}"] .te-settings-switch`,
  );
  toggle.click();
  return toggle;
};

/** 读某个开关当前的 aria-checked */
const settingState = (window, id) =>
  window.document
    .querySelector(`.te-settings-row[data-te-setting="${id}"] .te-settings-switch`)
    ?.getAttribute('aria-checked');

// ================= 实例一：默认状态 =================
const w1 = createWindow();
w1.eval(script);
await sleep(120);

const q = (id) => w1.document.getElementById(id);
expect('时间线容器（max-width:600px，内含 cellInnerDiv）应被解锁', q('timeline').dataset.teWidthUnlocked, 'max');
// 角色判据：推文内部的盒子（宽度也是 600）不再算「X 写死的列宽上限」。
// 实测（2026-09-14，/home + 详情页）：解锁器真正命中的只有「承载内容单元的容器」；
// 一条推特内部的 600px 盒子放开只会把内容拉变形（轮播格 562px 就是这么被拉宽的）。
expect('推文内部的 600px 盒子不再被解锁（按角色，不按尺寸）', q('tweet').dataset.teWidthUnlocked, undefined);
expect('avatar（48px）不应被误伤', q('avatar').dataset.teWidthUnlocked, undefined);
// 右栏隐藏时主列铺满 X 内容区：行宽 1050 − 右栏保留的右边距 70 = 980
// （1440 视口实测，与 /i/grok 的原生主列同宽同左缘）
expect(
  '主列铺满内容区（980 = 行 1050 − 右栏保留的右边距 70）',
  w1.document.documentElement.style.getPropertyValue('--te-timeline-width'),
  '980px',
);

const root1 = w1.document.documentElement;
expect('推文 UI 默认开启', root1.dataset.teUi, 'on');
expect('主题已检测', typeof root1.dataset.teTheme, 'string');
expect('正文字号令牌 16px', root1.style.getPropertyValue('--te-body-size'), '16px');
expect('行高令牌 1.5', root1.style.getPropertyValue('--te-body-lh'), '1.5');
expect('行长令牌 72ch', root1.style.getPropertyValue('--te-measure'), '72ch');
expect('宽时间线默认开启', root1.dataset.teTimeline, 'wide');
// 铺满内容区时主列已占满 X 给内容区的宽度，行不需要任何补偿样式：
// 保持 X 原生的 space-between（单子节点下等价于左对齐），与 /i/grok 的行一致
expect('铺满内容区时不撑开三栏行', w1.document.getElementById('row').style.minWidth, '');
expect('铺满内容区时不给行打补偿标记', w1.document.getElementById('row').dataset.teRow, undefined);
expect('导航条搜索框默认开启', root1.dataset.teSearch, 'on');

expect('右侧栏默认隐藏', root1.dataset.teSidebar, 'off');
const nav1 = w1.document.querySelector('nav[aria-label="Primary"]');
const host1 = nav1.querySelector('.te-search-host');
expect('左栏已插入搜索宿主', Boolean(host1), true);
expect('宿主挂在导航条内', host1?.parentElement === nav1, true);
expect('custom 模式生成输入框', Boolean(host1?.querySelector('input[type="search"]')), true);
expect(
  '输入框带无障碍名称',
  host1?.querySelector('input[type="search"]')?.getAttribute('aria-label'),
  '搜索',
);
// 右栏隐藏时不再做居中补偿（居中会把主列左缘推开、左导航条跟着偏移）；
// 主列铺满内容区，行交回 X 原生对齐
expect('右栏隐藏时不改写行对齐', q('row').style.justifyContent, '');
expect('logo 与导航项同级时退回绝对定位', host1?.dataset.teSearchLayout, 'absolute');
expect('导航条被设为定位上下文', nav1.style.position, 'relative');
expect('搜索框左边缘在 logo 右侧（62+12）', host1?.style.left, '74px');
expect('搜索框与 logo 垂直居中对齐', host1?.style.top, '11px');
expect(
  '原生搜索框仍留在右栏（custom 模式不搬运 React 节点）',
  Boolean(w1.document.querySelector('[data-testid="sidebarColumn"] [role="search"]')),
  true,
);

// ================= 实例二：Alt+U 持久化 =================
const w2 = createWindow();
// 布尔开关统一以 'true' / 'false' 落盘：false = 关闭推文新样式
w2.localStorage.setItem('twitter-enhancer:tweet-ui', 'false');
w2.eval(script);
await sleep(120);
expect('按存储恢复推文 UI 为关闭态', w2.document.documentElement.dataset.teUi, 'off');

// 旧版本写过 'on' / 'off' 格式，读取时需兼容
const w2b = createWindow();
w2b.localStorage.setItem('twitter-enhancer:tweet-ui', 'off');
w2b.eval(script);
await sleep(120);
expect('兼容旧格式 off', w2b.document.documentElement.dataset.teUi, 'off');
const w2c = createWindow();
w2c.localStorage.setItem('twitter-enhancer:tweet-ui', 'on');
w2c.eval(script);
await sleep(120);
expect('兼容旧格式 on', w2c.document.documentElement.dataset.teUi, 'on');

// ================= 实例三：Alt+B 双向切换侧栏 =================
const w3 = createWindow();
// false = 不隐藏右栏（即显示）
w3.localStorage.setItem('twitter-enhancer:sidebar', 'false');
w3.eval(script);
await sleep(120);
const root3 = w3.document.documentElement;
const row3 = w3.document.getElementById('row');
expect('按存储恢复为显示右栏', root3.dataset.teSidebar, 'on');
// 右栏显示时改为「左对齐 + 右栏固定 30px 间距」的锚定布局，而不是把行交给 X 原生
expect('显示右栏时行改为左对齐锚定', row3.style.justifyContent, 'flex-start');

press(w3, 'KeyB');
await sleep(60);
expect('Alt+B 隐藏右栏', root3.dataset.teSidebar, 'off');
expect('隐藏后还原 X 原生行对齐（不做居中补偿）', row3.style.justifyContent, '');

press(w3, 'KeyB');
await sleep(60);
expect('再次 Alt+B 恢复右栏', root3.dataset.teSidebar, 'on');
expect('恢复后重新锚定为左对齐', row3.style.justifyContent, 'flex-start');

// ================= 实例四：/ 快捷键拦截 =================
const w4 = createWindow();
w4.eval(script);
await sleep(120);
const input4 = w4.document.querySelector('.te-search input');
w4.document.body.focus();
w4.dispatchEvent(
  new w4.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
);
await sleep(30);
expect('按 / 焦点落到自建搜索框', w4.document.activeElement === input4, true);

// 在输入框内输入 / 不应被拦截（此时焦点已在输入框，目标为 INPUT）
input4.focus();
w4.dispatchEvent(
  new w4.KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }),
);
await sleep(30);
expect('输入框内按 / 不被重复处理', w4.document.activeElement === input4, true);

// ================= 实例五：页内设置面板（取代旧版油猴菜单开关） =================
// 开关从油猴菜单搬进页面：右下角设置按钮（在 X 的 Grok 悬浮按钮正上方）→ 设置弹窗。
// 面板按钮位置来自 X 右下角抽屉容器的实测几何（见 createWindow 的 getBoundingClientRect 桩）。
const HTML_SETTINGS = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%"><div id="timeline" style="max-width:600px"><div id="tweet" style="width:600px">tweet</div></div></div>
    </div>
    <div data-testid="sidebarColumn"><form role="search"><input data-testid="SearchBox_Search_Input" /></form></div>
  </div>
  <div data-testid="GrokDrawer"><button data-testid="GrokDrawerHeader" aria-label="Grok">Grok</button></div>
</body></html>`;

const w5 = createWindow(HTML_SETTINGS);
// 旧版把开关挂进油猴菜单；现在必须完全不注册菜单项（mock 仍然挂上，用来证明没有调用）
const menu5 = new Map();
let menuId5 = 1;
w5.GM_registerMenuCommand = (label, fn) => {
  const id = menuId5++;
  menu5.set(id, { label, fn });
  return id;
};
w5.GM_unregisterMenuCommand = (id) => menu5.delete(id);
w5.eval(script);
await sleep(120);

expect('不再注册油猴菜单开关', menu5.size, 0);
const fab5 = w5.document.querySelector('.te-settings-fab');
expect('右下角出现设置按钮', Boolean(fab5), true);
expect('设置按钮有可访问名称', fab5?.getAttribute('aria-label'), '页面优化设置');
// 位置锚定在 Grok 抽屉容器上缘之上：jsdom 视口高 768，抽屉上缘 586，间距 12 → 768−586+12
expect('设置按钮距右边与 Grok 按钮同列（20px）', fab5?.style.right, '20px');
expect('设置按钮落在 Grok 按钮上方（抽屉上缘 − 12px）', fab5?.style.bottom, '194px');
// 尺寸必须与 X 的悬浮按钮一致（55×55 / 圆角 16 / 图标 32）：页面里读到 X 按钮时镜像它的
// 实时几何，读不到时用 CONFIG.settings.fab 兜底 —— 两条路径下都不该出现 48px 这类旧值。
expect('设置按钮与 Grok 按钮同尺寸（55×55）', `${fab5?.style.width}x${fab5?.style.height}`, '55pxx55px');
expect('设置按钮圆角与 Grok 按钮一致（16px）', fab5?.style.borderRadius, '16px');
expect('设置按钮内的图标为 32px（与 X 按钮图标同大）', fab5?.style.getPropertyValue('--te-set-fab-icon'), '32px');

const overlay5 = w5.document.querySelector('.te-settings-overlay');
expect('弹窗默认关闭', overlay5?.getAttribute('data-te-settings-open'), 'false');

fab5.click();
await sleep(30);
expect('点击设置按钮打开弹窗', overlay5?.getAttribute('data-te-settings-open'), 'true');
expect('打开后按钮标记为展开', fab5.getAttribute('aria-expanded'), 'true');
const dialog5 = overlay5.querySelector('.te-settings-dialog');
expect('弹窗带对话框语义', dialog5?.getAttribute('role'), 'dialog');
expect('弹窗标题为「设置」', w5.document.getElementById('te-settings-title')?.textContent, '设置');

const rows5 = [...w5.document.querySelectorAll('.te-settings-row')];
expect('五个功能共登记七个开关', rows5.length, 7);
expect(
  '开关顺序为 布局三项 + 内容四项',
  rows5.map((row) => row.dataset.teSetting).join(','),
  'timeline-wide,sidebar,nav-search,tweet-ui,media-cap,media-fit,content-column',
);
expect(
  '同组开关合并到一个小标题下',
  [...w5.document.querySelectorAll('.te-settings-group-title')].map((t) => t.textContent).join(','),
  '布局,内容',
);
expect('宽时间线开关初始为开', settingState(w5, 'timeline-wide'), 'true');
expect('显示右侧栏开关初始为关（右栏默认隐藏）', settingState(w5, 'sidebar'), 'false');
expect('内容列排版开关初始为开', settingState(w5, 'content-column'), 'true');
expect('单图等比开关初始为开', settingState(w5, 'media-fit'), 'true');
expect('开关的可访问角色为 switch', rows5[0].querySelector('.te-settings-switch')?.getAttribute('role'), 'switch');

// 点击开关 → 功能生效 + 面板状态刷新
toggleSetting(w5, 'sidebar');
await sleep(30);
expect('点击「显示右侧栏」后右栏显示', w5.document.documentElement.dataset.teSidebar, 'on');
expect('开关状态刷新为开', settingState(w5, 'sidebar'), 'true');
expect('开关行状态标记同步', w5.document.querySelector('[data-te-setting="sidebar"]').dataset.teSettingState, 'on');

// 宽时间线开关：关闭后主列交回 X 原生，写入的宽度变量不再被 CSS 采用、行样式清空
toggleSetting(w5, 'timeline-wide');
await sleep(30);
expect('关闭宽时间线后属性转为 off', w5.document.documentElement.dataset.teTimeline, 'off');
expect('关闭宽时间线后行样式被清空', w5.document.getElementById('row').style.minWidth, '');
expect('宽时间线开关状态刷新为关', settingState(w5, 'timeline-wide'), 'false');
toggleSetting(w5, 'timeline-wide');
await sleep(30);
expect('再次点击恢复宽时间线', w5.document.documentElement.dataset.teTimeline, 'wide');
expect('宽时间线开关状态刷新为开', settingState(w5, 'timeline-wide'), 'true');

// 导航条搜索框开关
toggleSetting(w5, 'nav-search');
await sleep(30);
expect('关闭导航条搜索框', w5.document.documentElement.dataset.teSearch, 'off');
expect('关闭后宿主仍在 DOM（可随时再开）', Boolean(w5.document.querySelector('.te-search-host')), true);
toggleSetting(w5, 'nav-search');
await sleep(30);
expect('再次点击恢复搜索框', w5.document.documentElement.dataset.teSearch, 'on');

// 页面快捷键改状态时，打开着的面板要跟着刷新（Alt+U 关推文新样式）
press(w5, 'KeyU');
await sleep(30);
expect('Alt+U 关闭推文新样式', w5.document.documentElement.dataset.teUi, 'off');
expect('面板中推文新样式开关同步为关', settingState(w5, 'tweet-ui'), 'false');
press(w5, 'KeyU');
await sleep(30);
expect('Alt+U 再次开启', w5.document.documentElement.dataset.teUi, 'on');

// 关闭路径：Esc、遮罩、右上角关闭按钮
const escape5 = new w5.KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
w5.dispatchEvent(escape5);
await sleep(30);
expect('Esc 关闭弹窗', overlay5.getAttribute('data-te-settings-open'), 'false');
expect('Esc 关闭后按钮标记复位', fab5.getAttribute('aria-expanded'), 'false');
expect('Esc 已阻止默认行为（不惊动 X 自己的浮层）', escape5.defaultPrevented, true);

openSettings(w5);
await sleep(30);
overlay5.dispatchEvent(new w5.MouseEvent('click', { bubbles: true }));
await sleep(30);
expect('点击遮罩关闭弹窗', overlay5.getAttribute('data-te-settings-open'), 'false');

openSettings(w5);
await sleep(30);
w5.document.querySelector('.te-settings-close').click();
await sleep(30);
expect('点击关闭按钮关闭弹窗', overlay5.getAttribute('data-te-settings-open'), 'false');

// 页面里没有 Grok / 私信抽屉时（如 /i/grok）退回配置里的固定偏移，位置不跳动
const HTML_NO_DRAWER = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="rowNoDrawer" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px"></div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;
const w5b = createWindow(HTML_NO_DRAWER);
w5b.eval(script);
await sleep(120);
expect(
  '无抽屉容器的页面用固定偏移（79+55+12=146）',
  w5b.document.querySelector('.te-settings-fab')?.style.bottom,
  '146px',
);
const fab5b = w5b.document.querySelector('.te-settings-fab');
expect(
  '无 X 悬浮按钮可镜像时仍用兜底尺寸 55×55',
  `${fab5b?.style.width}x${fab5b?.style.height}`,
  '55pxx55px',
);

// ================= 实例六：真实 DOM 结构（logo 是 nav 的兄弟） =================
// 结构取自 2026-09 实测：内栏 flex column → [logo 行, nav 容器, 发帖按钮]，
// logo 行默认只撑到 logo 宽度，必须拉伸后才能放下搜索框。
const HTML_REAL = `<!doctype html><html><head></head><body>
  <div id="inner" data-w="259">
    <div id="logoRow"><h1 id="logoH1"><a href="/home" aria-label="X">logo</a></h1></div>
    <div id="navWrap"><nav aria-label="Primary">
      <a href="/home">主页</a>
      <a href="/explore">探索</a>
    </nav></div>
  </div>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px"></div>
    <div data-testid="sidebarColumn"><form role="search"><input data-testid="SearchBox_Search_Input" /></form></div>
  </div>
</body></html>`;

const w6 = createWindow(HTML_REAL);
w6.eval(script);
await sleep(120);
const inner6 = w6.document.getElementById('inner');
const logoRow = w6.document.getElementById('logoRow');
const logo6 = w6.document.querySelector('a[aria-label="X"]');
const host6 = w6.document.querySelector('.te-search-host');
expect('真实结构下采用左右结构', host6?.dataset.teSearchLayout, 'row');
expect('宿主挂在 logo 行（不是 h1、也不是 nav）', host6?.parentElement === logoRow, true);
expect('宿主与 h1 同为 logo 行子节点', logo6?.parentElement?.parentElement === logoRow, true);
expect('行容器改为 flex', logoRow.style.display, 'flex');
expect('行方向改为 row（X 默认 column）', logoRow.style.flexDirection, 'row');
expect('行内容左右分布', logoRow.style.justifyContent, 'space-between');
expect('行容器不换行', logoRow.style.flexWrap, 'nowrap');
expect('行容器拉伸到内栏宽度', logoRow.style.alignSelf, 'stretch');
expect('logo 容器被压住 flex-grow（否则抢走搜索框空间）', w6.document.getElementById('logoH1').style.flexGrow, '0');
expect('logo 容器被压住 flex-shrink', w6.document.getElementById('logoH1').style.flexShrink, '0');
expect('未退回绝对定位（无 left/top 残留）', host6?.style.left, '');
expect('内栏未判定为图标条', inner6.dataset.teNavCompact, 'false');

// ================= 实例七：内栏收窄成图标条 =================
const HTML_COMPACT = HTML_REAL.replace('id="inner" data-w="259"', 'id="inner" data-w="120"');
const w7 = createWindow(HTML_COMPACT);
w7.eval(script);
await sleep(120);
const inner7 = w7.document.getElementById('inner');
expect('内栏 120px 判定为图标条', inner7.dataset.teNavCompact, 'true');
expect('图标条下宿主仍挂载（由 CSS 隐藏）', Boolean(inner7.querySelector('.te-search-host')), true);

// ================= 实例八：h1 之上无独立行容器时退回绝对定位 =================
const HTML_NO_ROW = `<!doctype html><html><head></head><body>
  <div id="inner" data-w="259">
    <a href="/home" aria-label="X">logo</a>
    <div id="navWrap"><nav aria-label="Primary">
      <a href="/home">主页</a>
      <a href="/explore">探索</a>
    </nav></div>
    <div id="post">发帖</div>
  </div>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px"></div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const w8 = createWindow(HTML_NO_ROW);
w8.eval(script);
await sleep(120);
const nav8 = w8.document.querySelector('nav[aria-label="Primary"]');
const host8 = w8.document.querySelector('.te-search-host');
expect('logo 与导航项同级时退回绝对定位', host8?.dataset.teSearchLayout, 'absolute');
expect('绝对定位时宿主挂回导航条', host8?.parentElement === nav8, true);

// ================= 实例九：右栏隐藏时脚本不碰左导航条 =================
const HTML_RAIL = `<!doctype html><html><head></head><body>
  <div id="rail" style="position:fixed;left:320px;right:1310px">
    <div id="logoRow"><h1><a href="/home" aria-label="X">logo</a></h1></div>
    <div><nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav></div>
  </div>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px"></div>
    <div data-testid="sidebarColumn"><form role="search"><input data-testid="SearchBox_Search_Input" /></form></div>
  </div>
</body></html>`;

const w9 = createWindow(HTML_RAIL);
w9.eval(script);
await sleep(120);
const rail9 = w9.document.getElementById('rail');
const row9 = w9.document.getElementById('row');
const sb9 = w9.document.querySelector('[data-testid="sidebarColumn"]');
// 左导航条由 X 自己 fixed 定位（实测与主列左缘对齐），脚本不写一个字节 ——
// 旧版在这里钉 width/right/left，导致 /home 的导航条由脚本摆、/i/grok 由 X 摆
expect('左栏原生 left 未被改写', rail9.style.left, '320px');
expect('左栏原生 right 未被放开', rail9.style.right, '1310px');
expect('左栏宽度未被钉死', rail9.style.width, '');
expect('右栏隐藏时不动右栏外边距', sb9.style.marginLeft, '');
expect('右栏隐藏时不改写行对齐（交回 X 原生）', row9.style.justifyContent, '');

// ================= 实例十：右栏显示时把它锚在主列右侧 =================
const w10 = createWindow(HTML_RAIL);
// false = 不隐藏右栏（即显示）
w10.localStorage.setItem('twitter-enhancer:sidebar', 'false');
w10.eval(script);
await sleep(120);
const rail10 = w10.document.getElementById('rail');
const row10 = w10.document.getElementById('row');
const sb10 = w10.document.querySelector('[data-testid="sidebarColumn"]');
expect('右栏显示时依然不碰左导航条', rail10.style.left, '320px');
expect('右栏显示时三栏行改为左对齐', row10.style.justifyContent, 'flex-start');
expect('右栏紧贴主列右侧（固定 30px）', sb10.style.marginLeft, '30px');

// ================= 实例十四：document-start 透明背景不误判暗色 =================
// X 未完成首次上色时 body 背景是 rgba(0,0,0,0) / transparent；旧版按数值 0 亮度
// 会误判为 Dark 造成首屏闪烁。新版：透明视为「未上色」，回退系统偏好（jsdom 为 light）。
const w15 = createWindow();
w15.eval(script);
await sleep(120);
const theme15 = w15.document.documentElement.dataset.teTheme;
expect('透明背景回退系统偏好而非误判暗色', theme15 === 'dark', false);
expect('透明背景下主题已写入（light）', theme15, 'light');

// ================= 实例十七：滚动新增的写死宽度容器被增量解锁 =================
// 初始容器内已解锁；模拟 React 无限加载追加一节写死 600px 的新内容容器
// （内含内容单元，才符合「列容器」的角色）。
// 增量路径应识别并打上标记（无需整树重扫旧节点）。
const w18 = createWindow();
w18.eval(script);
await sleep(150);
const timeline18 = w18.document.getElementById('timeline');
const lateLocked = w18.document.createElement('div');
lateLocked.id = 'lateLocked';
lateLocked.style.width = '600px';
lateLocked.innerHTML = '<div data-testid="cellInnerDiv">late tweet</div>';
timeline18.appendChild(lateLocked);
await sleep(200); // 等 dom-watch 合并 + rAF 时间片
expect('滚动新增的 600px 内容容器被解锁', lateLocked.dataset.teWidthUnlocked, 'fixed');
expect('既有解锁标记未被打乱', timeline18.dataset.teWidthUnlocked, 'max');

// ================= 实例十一：SPA 导航后布局自动重算（渲染帧前） =================
// X 是 React SPA，站内导航不触发 load；脚本通过 hook history.pushState 广播 te:route。
// 模拟 React 在导航时替换三栏行容器（锚点 / min-width 随旧节点丢失）。
// 关键：这里**不等待 120ms 节流批次**，只等一个宏任务让 MutationObserver 微任务回调跑完。
// 真机实测（2026-09，时间线点进详情推文）：若等节流批次，新行会先以 X 原生布局绘制
// （主列位置跳一下），~120ms 后才被改回来，肉眼可见闪烁。
// dom-watch 因此在锚点节点身份变化时同步冲刷（MO 回调早于渲染帧），这里断言的就是它。
const HTML_RAIL2 = HTML_RAIL.replace(
  '<div id="row" style="display:flex">',
  '<div id="row2" style="display:flex">',
);
const w11 = createWindow(HTML_RAIL2);
// false = 显示右栏（锚定路径覆盖更全：min-width 撑开 + margin-left 锚定同时生效）。
// 行 min-width = 主列目标宽 + 右栏占用；jsdom 无布局引擎，右栏的 getClientRects 为空、
// 占位按 0 计，所以这里等于「可用空间内 800 封顶」的目标宽本身（真机几何见 e2e:real）
const SIDEBAR_SHOWN_MIN_WIDTH = '800px';
w11.localStorage.setItem('twitter-enhancer:sidebar', 'false');
w11.eval(script);
await sleep(120);
const row11a = w11.document.getElementById('row2');
expect('初始状态行被撑开', row11a.style.minWidth, SIDEBAR_SHOWN_MIN_WIDTH);
expect('初始状态右栏已锚定', w11.document.querySelector('[data-testid="sidebarColumn"]').style.marginLeft, '30px');

// 模拟 SPA 导航：React 替换三栏行容器并把右栏移入新行，旧样式随旧节点消失
const row11b = w11.document.createElement('div');
row11b.id = 'row2-new';
row11b.style.display = 'flex';
const primary11b = w11.document.createElement('div');
primary11b.setAttribute('data-testid', 'primaryColumn');
primary11b.style.width = '800px';
row11b.appendChild(primary11b);
const sidebar11 = w11.document.querySelector('[data-testid="sidebarColumn"]');
sidebar11.style.marginLeft = '';
row11b.appendChild(sidebar11);
w11.document.getElementById('row2').replaceWith(row11b);
await sleep(0); // 只让 MutationObserver 微任务回调执行，不进入 120ms 节流批次
const row11b2 = w11.document.getElementById('row2-new');
expect(
  '重挂行后同一任务内即重新撑开（不等 120ms 节流）',
  row11b2.style.minWidth,
  SIDEBAR_SHOWN_MIN_WIDTH,
);
expect(
  '重挂行后同一任务内右栏锚点即重新写入',
  w11.document.querySelector('[data-testid="sidebarColumn"]').style.marginLeft,
  '30px',
);
expect('重挂行后左导航条依然不被改写', w11.document.getElementById('rail').style.left, '320px');
// 路由广播（pushState）后仍应保持正确，且不产生重复 / 错乱
w11.history.pushState({}, '', '/explore');
await sleep(120);
expect('路由广播后行仍被撑开', row11b2.style.minWidth, SIDEBAR_SHOWN_MIN_WIDTH);
expect(
  '路由广播后右栏锚点保持',
  w11.document.querySelector('[data-testid="sidebarColumn"]').style.marginLeft,
  '30px',
);

// ================= 实例二十二：主列被 React 替换后宽度解锁器重新绑定 =================
// 旧版 bug：解锁器缓存的主列容器被 React 整体换掉后，旧容器已脱离文档，
// 新增节点都不在旧容器内 → 增量分支全部跳过，解锁静默失效到下一次 resize。
// 修正后应重新锁定新主列并整树补扫（新主列里写死 600px 的容器要被解锁）。
const w19 = createWindow();
w19.eval(script);
await sleep(150);
const oldPrimary19 = w19.document.querySelector('[data-testid="primaryColumn"]');
const newPrimary19 = w19.document.createElement('div');
newPrimary19.setAttribute('data-testid', 'primaryColumn');
newPrimary19.style.width = '800px';
const newWrap19 = w19.document.createElement('div');
newWrap19.style.width = '100%';
const newLocked19 = w19.document.createElement('div');
newLocked19.id = 'newLocked';
newLocked19.style.width = '600px';
newLocked19.innerHTML = '<div data-testid="cellInnerDiv">new tweet</div>';
newWrap19.appendChild(newLocked19);
newPrimary19.appendChild(newWrap19);
oldPrimary19.replaceWith(newPrimary19);
await sleep(400); // dom-watch 微任务快路径 + rAF 时间片扫描
expect(
  '主列被替换后新主列内的锁宽容器被解锁',
  newLocked19.dataset.teWidthUnlocked,
  'fixed',
);

// ================= 实例十二：宽列媒体高度钳制 =================
// 800 宽列下横排轮播的竖长行无 X 原生钳制，实测行高可达 774~898px，超过一屏
// （加正文/操作栏后必须滚轮才能看全）。宿主 = 媒体向上第一个宽度 ≥ lockWidth
// 且不含正文的祖先。方案 = 只改宿主 layout height 到预算（X 轮播格按内联
// aspect-ratio 随行高自动重排，比例不变、不裁剪、无 transform 双重缩放）。
// 媒体回落到预算内（列宽回落 / 媒体变小）后自动解锁还原。
const HTML_MEDIA = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="mcWrap" data-w="718" data-h="900" style="padding-bottom: calc(100% - 4px)">
          <div id="mcRegion" data-w="718" data-h="774">
            <div data-testid="tweetPhoto">图片</div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wMedia = createWindow(HTML_MEDIA);
wMedia.eval(script);
await sleep(180);
const regionM = wMedia.document.getElementById('mcRegion');
const wrapM = wMedia.document.getElementById('mcWrap');
expect('宽列超高媒体行宿主被钳制', regionM.dataset.teMediaCapped, '1');
// 预算 = min(540, 视口高−220=548) = 540：只把宿主 layout 高度压到 540
expect('宿主 layout 高度压到预算', regionM.style.height, `${budgetOf(wMedia)}px`);
expect('只改高度、不加 transform（避免双重缩放）', regionM.style.transform, '');
// 宿主上方的纯包裹层（只含该媒体子链）若被 X 写死行高/用百分比 padding 撑高，
// 会留下冗余空白：必须与宿主一起压到预算，百分比 padding 盒同步归零 padding。
expect('纯包裹层一并压到预算', wrapM.style.height, `${budgetOf(wMedia)}px`);
expect('包裹层也打上钳制标记', wrapM.dataset.teMediaCapped, '1');
expect('百分比 padding 比例盒的 padding 归零', wrapM.style.paddingBottom, '0px');

// 设置面板里的「媒体高度钳制」开关：关掉后已钳制的媒体立即还原，再开立即恢复
toggleSetting(wMedia, 'media-cap');
await sleep(30);
expect('面板关闭媒体钳制后宿主解锁', regionM.dataset.teMediaCapped, undefined);
expect('面板关闭媒体钳制后清除 height', regionM.style.height, '');
expect('面板关闭媒体钳制后还原包裹层原始 padding', wrapM.style.paddingBottom, 'calc(100% - 4px)');
expect('媒体钳制开关状态刷新为关', settingState(wMedia, 'media-cap'), 'false');
toggleSetting(wMedia, 'media-cap');
await sleep(30);
expect('面板重新开启后媒体再次被钳制', regionM.dataset.teMediaCapped, '1');
expect('媒体钳制开关状态刷新为开', settingState(wMedia, 'media-cap'), 'true');

// 媒体尺寸回落到预算内（如主列宽回落 / 媒体变小）→ te:layout 对账自动解锁
regionM.setAttribute('data-w', '300');
regionM.setAttribute('data-h', '300');
wrapM.setAttribute('data-w', '300');
wrapM.setAttribute('data-h', '300');
wMedia.document.dispatchEvent(new wMedia.CustomEvent('te:layout'));
await sleep(300); // 对账带 120ms 去抖，等它跑完
expect('媒体回落到预算内自动解锁', regionM.dataset.teMediaCapped, undefined);
expect('包裹层同步解锁', wrapM.dataset.teMediaCapped, undefined);
expect('解锁后清除 height', regionM.style.height, '');
expect('解锁后清除包裹层 height', wrapM.style.height, '');
expect('解锁后还原包裹层原始 padding', wrapM.style.paddingBottom, 'calc(100% - 4px)');

// ================= 实例二十七：媒体轮播格不被宽度解锁器误伤 =================
// 真机缺陷（2026-09-14 实测，1440 视口，headless 独立 profile，推文详情页）：
// X 的横向轮播（data-testid=ScrollSnap-List）里每一格的宽度 = 行高 × 内联
// aspect-ratio —— 3 竖图轮播实测 757 × 0.74248 = 562px，正好落在
// CONFIG.lockedWidthRange [560, 660] 里，被误判成「X 写死的 600px 容器」放开到
// 100%（946px = 整列宽）：media-cap 只压了行高，格宽仍是整列，竖图被放大铺满
// 整列（观感「图片宽高都不再受限」）。命中与否取决于解锁器 BFS 分片扫描与
// media-cap 的 rAF 钳制谁先跑到该节点，所以同一页面冷加载时好时坏。
// 修正后判据换成「角色」：只有承载内容单元的容器才可能被放开 —— 轮播格、推文内
// 部写死的盒子都在**内容单元内部**，一律不参与；列容器（下面那条 contentColumn）照旧。
const HTML_CAROUSEL = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="contentColumn" style="width:600px">
          <div data-testid="cellInnerDiv">
            <div id="carouselTweet" style="width:600px">
              <div data-testid="ScrollSnap-List">
                <div id="carouselCell" style="width:562px">轮播格（宽度来自媒体比例）</div>
                <div data-testid="tweetPhoto"><img id="carouselImg" style="width:560px" /></div>
              </div>
              <div id="lockedInTweet" style="width:600px">轮播推文里轮播之外的写死容器</div>
              <div id="fixed562Outside" style="width:562px">轮播之外的写死 562px</div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wCar = createWindow(HTML_CAROUSEL);
wCar.eval(script);
await sleep(220);
expect(
  '轮播格（562px，正好落在锁宽区间内）不被打解锁标记',
  wCar.document.getElementById('carouselCell').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '轮播格内的 tweetPhoto / img 不被打解锁标记',
  wCar.document.getElementById('carouselImg').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '轮播之外写死 562px 的容器也不解锁（在内容单元内部，按角色排除）',
  wCar.document.getElementById('fixed562Outside').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '内容单元（cellInnerDiv）内部的推文容器不解锁',
  wCar.document.getElementById('carouselTweet').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '内容单元内部、轮播之外的写死容器同样不解锁',
  wCar.document.getElementById('lockedInTweet').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '承载内容单元的列容器（600px）才被解锁',
  wCar.document.getElementById('contentColumn').dataset.teWidthUnlocked,
  'fixed',
);

// ================= 实例二十：dom-watch 溢出（单批超池上限）后整树补扫 =================
// 旧版 bug：overflow 分支 reset() 清空待检队列后 flush() 因队列为空不会调度任何
// 扫描 —— 标记被清掉但新增的锁宽元素永远不会被解锁。修正后应显式整树补扫。
const wOver = createWindow();
wOver.eval(script);
await sleep(150);
const tlOver = wOver.document.getElementById('timeline');
const fragOver = wOver.document.createDocumentFragment();
let burstLocked;
for (let i = 0; i < 3002; i += 1) {
  const d = wOver.document.createElement('div');
  if (i === 0) {
    d.id = 'burstLocked';
    d.style.width = '600px';
    d.innerHTML = '<div data-testid="cellInnerDiv"></div>';
    burstLocked = d;
  }
  fragOver.appendChild(d);
}
tlOver.appendChild(fragOver);
await sleep(700); // dom-watch 冲刷 → overflow → 整树补扫（300 节点/帧 × rAF 时间片）
expect('溢出后新增的锁宽元素被整树补扫命中', burstLocked.dataset.teWidthUnlocked, 'fixed');
expect('溢出补扫不打乱既有解锁标记', wOver.document.getElementById('timeline').dataset.teWidthUnlocked, 'max');

// ================= 实例二十一：滚动增量新增的媒体走 rAF 帧任务被钳制 =================
// 增量路径不再在 dom-watch 冲刷回调里同步扫描/钳制，而是收进下一个 rAF 帧任务。
// 宿主链按 cellInnerDiv 边界隔离（与真实 X 结构一致），媒体加载完成只解锁自身链。
const HTML_MEDIA_LATE = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav>
  <div id="rowLate" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%"></div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wML = createWindow(HTML_MEDIA_LATE);
wML.eval(script);
await sleep(150);
const colLate = wML.document.querySelector('[data-testid="primaryColumn"] > div');
const cellA = wML.document.createElement('div');
cellA.setAttribute('data-testid', 'cellInnerDiv');
cellA.id = 'cellA';
const wrapA = wML.document.createElement('div');
wrapA.id = 'wrapA';
wrapA.setAttribute('data-w', '718');
wrapA.setAttribute('data-h', '900');
const photoA = wML.document.createElement('div');
photoA.setAttribute('data-testid', 'tweetPhoto');
photoA.textContent = '图A';
wrapA.appendChild(photoA);
cellA.appendChild(wrapA);
const cellB = wML.document.createElement('div');
cellB.setAttribute('data-testid', 'cellInnerDiv');
cellB.id = 'cellB';
const wrapB = wML.document.createElement('div');
wrapB.id = 'wrapB';
wrapB.setAttribute('data-w', '718');
wrapB.setAttribute('data-h', '900');
const photoB = wML.document.createElement('div');
photoB.setAttribute('data-testid', 'tweetPhoto');
photoB.textContent = '图B';
wrapB.appendChild(photoB);
cellB.appendChild(wrapB);
colLate.appendChild(cellA);
colLate.appendChild(cellB);
await sleep(450); // dom-watch 冲刷（120ms）+ rAF 帧任务
expect('滚动新增的媒体宿主 A 被增量钳制', wrapA.dataset.teMediaCapped, '1');
expect('滚动新增的媒体宿主 B 被增量钳制', wrapB.dataset.teMediaCapped, '1');
expect('增量钳制只改宿主 layout height', wrapA.style.height, `${budgetOf(wML)}px`);

// 模拟宿主 A 内图片加载完成且媒体自然高回落到预算内：
// 只解锁 A 这一条链（宿主粒度对账），B 不受影响仍保持钳制
const imgA = wML.document.createElement('img');
imgA.id = 'imgA';
wrapA.appendChild(imgA);
wrapA.setAttribute('data-h', '300');
imgA.dispatchEvent(new wML.Event('load', { bubbles: true }));
await sleep(250); // rAF 帧任务执行宿主粒度对账
expect('宿主 A 图片回落预算内后解锁', wrapA.dataset.teMediaCapped, undefined);
expect('宿主 A 解锁后清除 height', wrapA.style.height, '');
expect('宿主 B 不受 A 的加载影响仍保持钳制', wrapB.dataset.teMediaCapped, '1');
expect('宿主 B 高度仍为预算', wrapB.style.height, `${budgetOf(wML)}px`);

// ================= 实例二十三：X 没渲染三栏的页面交回原生 =================
// 实测（2026-09-08，1440 视口，headless 独立 profile）：
// - /home：primaryColumn 原生 600px，右侧有 sidebarColumn（在同一个三栏行里）；
// - /i/grok：X 自己的「单栏版」内容区 —— primaryColumn 原生 980px、
//   max-width none、**行里没有 sidebarColumn**；
// - /messages → 重定向到 /i/chat/*：X Chat 独立双栏，primaryColumn 原生
//   1187px、max-width none、同样没有 sidebarColumn。
// 宽时间线的判据因此取结构：主列所在的行里有没有 X 自己渲染的右栏。
// 若不加判定，宽列会把 1187px 的聊天分栏挤到目标宽，Grok 页也会被当成时间线
// （并套上「放开内层 600 上限」的一组规则）。
const HTML_CHAT = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" data-w="1187" style="width:1187px">
      <div id="chatPane" style="width:100%">
        <div id="chatLocked" style="width:600px">会话</div>
      </div>
    </div>
  </div>
</body></html>`;

const wChat = createWindow(HTML_CHAT, 'https://x.com/i/chat/pin/new');
wChat.eval(script);
await sleep(220);
expect('X Chat 路由下不启用宽主列', wChat.document.documentElement.dataset.teTimeline, 'off');
expect('X Chat 路由下不写宽度变量', wChat.document.documentElement.dataset.teTimelineWidth, undefined);
expect('X Chat 路由下不撑开三栏行', wChat.document.getElementById('row').style.minWidth, '');
expect(
  'X Chat 下解锁器停摆（原生 1187 双栏不被改写）',
  wChat.document.getElementById('chatLocked').dataset.teWidthUnlocked,
  undefined,
);

// /i/grok：单栏 + 原生 980px（= /home 的内容区宽）。X 自己就是全宽布局，
// 本功能必须完全不碰 —— 否则会把 Grok 钉成比原生更窄的宽度。
const HTML_GROK = HTML_CHAT.replace('data-w="1187" style="width:1187px"', 'data-w="980" style="width:980px"');
const wGrok = createWindow(HTML_GROK, 'https://x.com/i/grok');
wGrok.eval(script);
await sleep(220);
expect('Grok 页（行里没有右栏）不启用宽主列', wGrok.document.documentElement.dataset.teTimeline, 'off');
expect('Grok 页不写宽度变量', wGrok.document.documentElement.dataset.teTimelineWidth, undefined);
expect('Grok 页解锁器停摆（原生 980 单栏不被改写）', wGrok.document.getElementById('chatLocked').dataset.teWidthUnlocked, undefined);

// 兜底判据：行里有右栏、但主列原生已宽于目标宽度的页面（X 后续新增的非时间线页面）
// ——本功能只放宽、从不收窄，因此同样不碰
const HTML_WIDE_COLUMN = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a><a href="/explore">探索</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" data-w="1400" style="width:1400px"></div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;
const wWide = createWindow(HTML_WIDE_COLUMN);
wWide.eval(script);
await sleep(220);
expect('三栏页但主列原生已宽于目标时不收窄', wWide.document.documentElement.dataset.teTimeline, 'off');
expect('主列原生已宽于目标时不写宽度变量', wWide.document.documentElement.dataset.teTimelineWidth, undefined);

// 对照：时间线页原生 600px（< 目标）应正常铺满内容区，证明判定不会误伤正常页面
const wTimeline = createWindow();
wTimeline.eval(script);
await sleep(220);
expect('时间线页原生 600px 仍正常放宽', wTimeline.document.documentElement.dataset.teTimeline, 'wide');
expect('时间线页宽度变量为 980px', wTimeline.document.documentElement.style.getPropertyValue('--te-timeline-width'), '980px');

// ================= 实例二十四：宽列关闭时解锁器停摆 / 重开时整树补扫 =================
// 缺陷背景：解锁器只负责打 data-te-width-unlocked 标记，真正放开宽度的 CSS 挂在
// html[data-te-timeline='wide'] 下 —— 开关关闭后继续扫描既无视觉效果，又白耗全树
// 遍历；同时关闭期间新增的锁宽元素从未被检视，重开时必须整树补扫（增量路径补不
// 回来：队列在关闭时已被清空）。
const wGate = createWindow();
wGate.eval(script);
await sleep(200);
expect('门控前置：宽列开启时既有元素已解锁', wGate.document.getElementById('timeline').dataset.teWidthUnlocked, 'max');

// 开关从设置面板里点（驱动真实 UI）
toggleSetting(wGate, 'timeline-wide');
await sleep(60);
expect('关闭宽列后既有解锁标记被撤销', wGate.document.getElementById('timeline').dataset.teWidthUnlocked, undefined);

const tlGate = wGate.document.getElementById('timeline');
const lateGate = wGate.document.createElement('div');
lateGate.id = 'lateGate';
lateGate.style.width = '600px';
lateGate.innerHTML = '<div data-testid="cellInnerDiv">late tweet while off</div>';
tlGate.appendChild(lateGate);
await sleep(320);
expect('关闭宽列后新增锁宽元素不被打标记', lateGate.dataset.teWidthUnlocked, undefined);
expect('关闭宽列后既有元素仍无标记', wGate.document.getElementById('timeline').dataset.teWidthUnlocked, undefined);

toggleSetting(wGate, 'timeline-wide');
await sleep(420);
expect('重新开启宽列后新增元素被整树补扫解锁', lateGate.dataset.teWidthUnlocked, 'fixed');
expect('重新开启宽列后既有元素恢复标记', wGate.document.getElementById('timeline').dataset.teWidthUnlocked, 'max');

// ================= 实例二十五：SPA 导航到 X Chat 后立即撤销宽列 =================
// 覆盖「路由判定必须早于主列挂载」这条时序：从 /home 导航到 /i/chat 时聊天主列
// 会晚于路由就绪，若拖到 DOM 批次里发现「主列换了」再撤销，中间可能有一帧用
// 宽列样式绘制 1187px 的聊天列（1187 → 目标宽 → 1187 的抖动）。
const wNav = createWindow();
wNav.eval(script);
await sleep(200);
expect('导航前宽列已开启', wNav.document.documentElement.dataset.teTimeline, 'wide');
expect('导航前主列已铺满内容区（980）', wNav.document.documentElement.dataset.teTimelineWidth, '980');

wNav.history.pushState({}, '', '/i/chat');
await sleep(160);
expect('SPA 导航到 X Chat 后撤销宽列', wNav.document.documentElement.dataset.teTimeline, 'off');
expect('SPA 导航到 X Chat 后清掉行的 min-width', wNav.document.getElementById('row').style.minWidth, '');
expect('SPA 导航到 X Chat 后解锁标记被撤销', wNav.document.getElementById('timeline').dataset.teWidthUnlocked, undefined);

wNav.history.pushState({}, '', '/home');
await sleep(160);
expect('导航回时间线后恢复宽列', wNav.document.documentElement.dataset.teTimeline, 'wide');
expect('导航回时间线后主列重新铺满内容区', wNav.document.documentElement.dataset.teTimelineWidth, '980');
expect('导航回时间线后重新解锁', wNav.document.getElementById('timeline').dataset.teWidthUnlocked, 'max');

// ================= 实例二十六：SPA 导航 /home → /i/grok 不把 Grok 钉窄 =================
// 真机逐帧实测（2026-09-08，1440 视口）：从 /home 点左栏 Grok 进入时，新主列会先以
// 非原生宽度挂载，旧版按「主列当前宽度是否已宽于目标」判断，会在这个瞬间误判成
// 「可以放宽」，把 Grok 页的主列钉成 800px（比 X 自己的 980 窄），直接刷新才是 980。
// 结构判据（行里有没有右栏）不依赖时序，这里覆盖这条回归。
const wGrokNav = createWindow(HTML_RAIL2);
wGrokNav.eval(script);
await sleep(200);
expect('导航前（/home）宽列已开启', wGrokNav.document.documentElement.dataset.teTimeline, 'wide');

// 模拟 React 切到 Grok：整行重挂，新行里只有主列（没有右栏），主列原生 980
const grokRow = wGrokNav.document.createElement('div');
grokRow.id = 'row-grok';
grokRow.style.display = 'flex';
const grokPrimary = wGrokNav.document.createElement('div');
grokPrimary.setAttribute('data-testid', 'primaryColumn');
grokPrimary.setAttribute('data-w', '980');
grokPrimary.style.width = '980px';
grokRow.appendChild(grokPrimary);
wGrokNav.document.getElementById('row2').replaceWith(grokRow);
wGrokNav.history.pushState({}, '', '/i/grok');
await sleep(120);
expect('导航到 Grok 后撤销宽列', wGrokNav.document.documentElement.dataset.teTimeline, 'off');
// Grok 是 X 自己的单栏布局，解锁器必须停摆：新增的写死 600px 容器不该被打标记
// （否则 Grok UI 里宽度落在 560–660 的面板会被放开到 100%）
const grokLocked = wGrokNav.document.createElement('div');
grokLocked.id = 'grokLocked';
grokLocked.style.width = '600px';
grokPrimary.appendChild(grokLocked);
await sleep(240);
expect('Grok 页解锁器停摆（新增锁宽容器不被打标记）', grokLocked.dataset.teWidthUnlocked, undefined);

// 导航回 /home（React 重挂带右栏的三栏行）→ 宽列恢复
const homeRow = wGrokNav.document.createElement('div');
homeRow.id = 'row-home';
homeRow.style.display = 'flex';
homeRow.setAttribute('data-w', '1050');
const homePrimary = wGrokNav.document.createElement('div');
homePrimary.setAttribute('data-testid', 'primaryColumn');
homePrimary.style.width = '600px';
homeRow.appendChild(homePrimary);
const homeSidebar = wGrokNav.document.createElement('div');
homeSidebar.setAttribute('data-testid', 'sidebarColumn');
homeSidebar.style.marginRight = '70px';
homeRow.appendChild(homeSidebar);
grokRow.replaceWith(homeRow);
wGrokNav.history.pushState({}, '', '/home');
await sleep(160);
expect('导航回 /home 后恢复宽列', wGrokNav.document.documentElement.dataset.teTimeline, 'wide');
expect('导航回 /home 后主列重新铺满内容区（980）', wGrokNav.document.documentElement.dataset.teTimelineWidth, '980');

// ================= 实例二十八：单图等比（fit）模式 =================
// 真机缺陷（2026-09-14，/home @1440，脚本 ON）：X 用百分比 padding 比例盒把单图铺满列宽，
// 只压宿主高度会让图片被拉到容器尺寸 —— 实测方图 900×895 渲染成 896×540（比例 1.005 → 1.66，
// object-fit: fill，等于纵向压扁 40%）。fit 模式改成「按预算高度等比缩宽度 + 水平居中」。
const HTML_FIT = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="fitWrap" data-w="896" data-h="891" style="padding-bottom: 99.44%">
          <div id="fitHost" data-w="896" data-h="891">
            <div id="fitPhoto" data-testid="tweetPhoto" style="margin: 0px"><img id="fitImg" /></div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wFit = createWindow(HTML_FIT);
// jsdom 不解码图片：直接给 img 一个自然尺寸（真实浏览器里来自解码后的位图）
const fitImg = wFit.document.getElementById('fitImg');
Object.defineProperty(fitImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(fitImg, 'naturalHeight', { configurable: true, value: 895 });
wFit.eval(script);
await sleep(200);
const fitHost = wFit.document.getElementById('fitHost');
const fitPhoto = wFit.document.getElementById('fitPhoto');
expect('单图超预算时宿主仍被钳制', fitHost.dataset.teMediaCapped, '1');
// 预算 = min(540, 768−220=548) = 540；宽度 = round(540 × 900 / 895) = 543
// 预算高 × 900/895 等比 → 宽度
expect('fit 模式按原比例缩宽度', fitPhoto.style.width, `${Math.round((budgetOf(wFit) * 900) / 895)}px`);
expect('fit 模式高度取满预算', fitPhoto.style.height, `${budgetOf(wFit)}px`);
// 2026-09-14 用户实测反馈：只缩图片会留下「容器比图片大、左右一圈冗余空间」，
// 宿主必须一起收到图片宽度（X 的 8px 圆角包裹贴着图片，右侧留页面底色）
expect('fit 模式宿主收到与图片同宽（不再比图片大）', fitHost.style.width, `${Math.round((budgetOf(wFit) * 900) / 895)}px`);
expect(
  'fit 标记同时打在图片容器与宿主上（解锁器据此放过它们）',
  `${fitPhoto.dataset.teMediaFit}/${fitHost.dataset.teMediaFit}`,
  '1/1',
);

// 宽度解锁器必须放过 fit 过的媒体：实测 608px（= 540 × 1200/1066）落在
// lockedRange [560,660] 内被误判成「X 写死的 600px 容器」，宽被顶回整列而高度
// 仍是我们设的预算 → 图片横向拉伸 1.6 倍；且是否命中取决于扫描顺序，刷新后观感不同。
const wUnlock = createWindow(HTML_FIT);
const unlockImg = wUnlock.document.getElementById('fitImg');
Object.defineProperty(unlockImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(unlockImg, 'naturalHeight', { configurable: true, value: 895 });
// 对照组：一对**结构完全相同**的列容器（都内含内容单元、宽 608px，落在锁宽区间内），
// 唯一区别是其中一个带 data-te-script-sized（脚本自写尺寸登记）。
// 这样才隔离出「禁止自反馈」这一条判据 —— 挂进 fit 子树里测不出东西，
// 因为那同时还会被「只解锁承载内容单元的容器」这条角色判据排除。
const makeColumn = (id, marked) => {
  const el = wUnlock.document.createElement('div');
  el.id = id;
  el.style.width = '608px';
  el.innerHTML = '<div data-testid="cellInnerDiv"></div>';
  if (marked) el.dataset.teScriptSized = '1';
  wUnlock.document.querySelector('[data-testid="primaryColumn"]').appendChild(el);
};
makeColumn('unlockControlMarked', true);
makeColumn('unlockControlPlain', false);
wUnlock.eval(script);
await sleep(260);
expect(
  '解锁器放过 fit 过的图片容器（宽度是媒体比例，不是容器上限）',
  wUnlock.document.getElementById('fitPhoto').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '解锁器放过 fit 过的宿主',
  wUnlock.document.getElementById('fitHost').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '带脚本自写标记的列容器不解锁（禁止自反馈）',
  wUnlock.document.getElementById('unlockControlMarked').dataset.teWidthUnlocked,
  undefined,
);
expect(
  '同结构、无脚本自写标记的列容器照旧解锁（判据是标记，不是宽度）',
  wUnlock.document.getElementById('unlockControlPlain').dataset.teWidthUnlocked,
  'fixed',
);

// 关闭单图等比 → 还原 X 的内联样式，只保留高度钳制
toggleSetting(wFit, 'media-fit');
await sleep(60);
expect('关闭单图等比后清除图片内联宽度', fitPhoto.style.width, '');
expect('关闭单图等比后宿主宽度也还原', fitHost.style.width, '');
expect('关闭单图等比后清除 fit 标记', fitPhoto.dataset.teMediaFit, undefined);
expect('关闭单图等比后宿主仍被钳制（旧行为）', fitHost.dataset.teMediaCapped, '1');
expect('单图等比开关状态刷新为关', settingState(wFit, 'media-fit'), 'false');
toggleSetting(wFit, 'media-fit');
await sleep(60);
expect('重新开启单图等比后再次等比缩宽度', fitPhoto.style.width, `${Math.round((budgetOf(wFit) * 900) / 895)}px`);
expect('单图等比开关状态刷新为开', settingState(wFit, 'media-fit'), 'true');

// 轮播（ScrollSnap-List 多格）不参与 fit：格子自带内联比例，压行高即自动等比重排
const HTML_FIT_CAROUSEL = HTML_FIT.replace(
  '<div id="fitPhoto" data-testid="tweetPhoto" style="margin: 0px"><img id="fitImg" /></div>',
  `<div data-testid="ScrollSnap-List">
     <div data-testid="tweetPhoto"><img id="fitImg" /></div>
     <div data-testid="tweetPhoto"><img id="fitImg2" /></div>
   </div>`,
);
const wFitCar = createWindow(HTML_FIT_CAROUSEL);
const carImg = wFitCar.document.getElementById('fitImg');
Object.defineProperty(carImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(carImg, 'naturalHeight', { configurable: true, value: 895 });
wFitCar.eval(script);
await sleep(200);
expect(
  '轮播里不做单图等比（否则会破坏 X 自己的比例重排）',
  wFitCar.document.querySelector('[data-te-media-fit]'),
  null,
);

// ================= 实例二十九：内容列排版（语义分类 / 焦点帖 / 轮播序号） =================
// 标本（2026-09-14 实测）：SENA 8ito 那条帖子正文 textContent 长度 0、只有 6 个 emoji <img>，
// 却按 16px/1.5 的段落排版。分类写在 article[data-te-caption] 上，CSS 按类排版；
// 焦点帖用「article 里有 a[href] 的路径 === location.pathname」判定（同页 45 条回复均不命中）。
const HTML_COLUMN = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div data-testid="cellInnerDiv" id="heroCell">
          <article data-testid="tweet" id="tweetHero">
            <div data-testid="User-Name">作者</div>
            <div data-testid="tweetText"><img alt="☀️" /><img alt="🌱" /></div>
            <div id="carouselRow" data-w="978">
              <div data-testid="ScrollSnap-List" id="snapList">
                <div data-w="291" id="tile1"></div>
                <div data-w="291" id="tile2"></div>
                <div data-w="291" id="tile3"></div>
              </div>
            </div>
            <div role="group"><div data-testid="reply"></div><div data-testid="views"></div></div>
            <a href="/alice/status/111">时间</a>
          </article>
        </div>
        <div data-testid="cellInnerDiv" id="shortCell">
          <article data-testid="tweet" id="tweetShort">
            <div data-testid="tweetText">太强了</div>
            <a href="/bob/status/222">时间</a>
          </article>
        </div>
        <div data-testid="cellInnerDiv" id="longCell">
          <article data-testid="tweet" id="tweetLong">
            <div data-testid="tweetText">${'长'.repeat(40)}</div>
            <a href="/carol/status/333">时间</a>
          </article>
        </div>
        <div data-testid="cellInnerDiv" id="mediaCell">
          <article data-testid="tweet" id="tweetMedia">
            <div data-testid="tweetPhoto">图</div>
            <a href="/dave/status/444">时间</a>
          </article>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wCol = createWindow(HTML_COLUMN, 'https://x.com/alice/status/111');
wCol.eval(script);
await sleep(220);
const colRoot = wCol.document.documentElement;
const tweetHero = wCol.document.getElementById('tweetHero');
expect('内容列排版默认开启', colRoot.dataset.teColumn, 'on');
expect('emoji 独占正文 → caption=emoji', tweetHero.dataset.teCaption, 'emoji');
expect('短句 → caption=short', wCol.document.getElementById('tweetShort').dataset.teCaption, 'short');
expect('长文 → caption=long', wCol.document.getElementById('tweetLong').dataset.teCaption, 'long');
expect('无正文 → caption=none', wCol.document.getElementById('tweetMedia').dataset.teCaption, 'none');
expect('焦点帖被标记（URL 里的那条）', tweetHero.dataset.teHero, '1');
expect('焦点帖的单元格被标记（CSS 据此去掉下边界线）', wCol.document.getElementById('heroCell').dataset.teHeroCell, '1');
expect('回复不会被标成焦点帖', wCol.document.getElementById('tweetShort').dataset.teHero, undefined);
expect('多图轮播写出序号（1/3）', wCol.document.getElementById('carouselRow').dataset.teCarousel, '1/3');
expect('单图帖不写轮播序号', wCol.document.getElementById('mediaCell').dataset.teCarousel, undefined);

// 关掉内容列排版：属性全清，交回 X 原生
toggleSetting(wCol, 'content-column');
await sleep(60);
expect('关闭内容列排版后属性转为 off', colRoot.dataset.teColumn, 'off');
expect('关闭后清除语义分类', tweetHero.dataset.teCaption, undefined);
expect('关闭后清除焦点帖标记', tweetHero.dataset.teHero, undefined);
expect('关闭后清除单元格标记', wCol.document.getElementById('heroCell').dataset.teHeroCell, undefined);
expect('关闭后清除轮播序号', wCol.document.getElementById('carouselRow').dataset.teCarousel, undefined);
expect('内容列排版开关状态刷新为关', settingState(wCol, 'content-column'), 'false');
toggleSetting(wCol, 'content-column');
await sleep(60);
expect('重新开启后语义分类恢复', tweetHero.dataset.teCaption, 'emoji');
expect('重新开启后焦点帖标记恢复', tweetHero.dataset.teHero, '1');
expect('内容列排版开关状态刷新为开', settingState(wCol, 'content-column'), 'true');

// ================= 实例三十：轮播格不被当成行宿主，也不进 fit =================
// 真机缺陷（2026-09-14，Sena 4 图竖图帖，1440 视口）：轮播某格的「比例盒」在未钳制状态下
// 宽 591px（≥ lockWidth 566），被当成行宿主单独钳制（格高 540），其余格由行宿主钳制后是 534
// —— 同一轮播里首格比其它格大一圈，行框也被撑到 1010px；同时该格内部只有 1 张图，
// 单图等比把尺寸钉在它身上，轮播其余格到达后也不还原（刷新后观感不同）。
// 修正：轮播内部的元素一律不作为宿主（轮播列表自身仍可），且轮播里的媒体不参与 fit。
const HTML_CAROUSEL_HOST = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="carRow" data-w="978" data-h="900" style="padding-bottom: 90%">
          <div data-testid="ScrollSnap-List" id="carList" data-w="978" data-h="900">
            <div id="carBox" data-w="591" data-h="900">
              <div data-testid="tweetPhoto" id="carPhoto" data-w="591" data-h="900"><img id="carImg" /></div>
            </div>
            <div id="carBox2" data-w="591" data-h="900">
              <div data-testid="tweetPhoto" data-w="591" data-h="900"></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wCarHost = createWindow(HTML_CAROUSEL_HOST);
const carHostImg = wCarHost.document.getElementById('carImg');
Object.defineProperty(carHostImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(carHostImg, 'naturalHeight', { configurable: true, value: 895 });
wCarHost.eval(script);
await sleep(220);
const carHostList = wCarHost.document.getElementById('carList');
const carHostBox = wCarHost.document.getElementById('carBox');
expect('轮播列表自身作为行宿主被钳制', carHostList.dataset.teMediaCapped, '1');
expect('轮播列表被压到预算高度', carHostList.style.height, `${budgetOf(wCarHost)}px`);
expect('轮播格（宽 591 ≥ lockWidth）不被单独当成宿主', carHostBox.dataset.teMediaCapped, undefined);
expect(
  '轮播里的媒体不参与单图等比',
  wCarHost.document.querySelectorAll('[data-te-media-fit]').length,
  0,
);
expect('轮播列表外层（比例盒）一并压到预算', wCarHost.document.getElementById('carRow').style.height, `${budgetOf(wCarHost)}px`);

// 单格轮播（X 逐格渲染时的中间态）：轮播里只有 1 张图也不能 fit
const HTML_CAROUSEL_ONE = HTML_CAROUSEL_HOST.replace(
  '<div id="carBox2" data-w="591" data-h="900">\n              <div data-testid="tweetPhoto" data-w="591" data-h="900"></div>\n            </div>',
  '',
);
const wCarOne = createWindow(HTML_CAROUSEL_ONE);
const carOneImg = wCarOne.document.getElementById('carImg');
Object.defineProperty(carOneImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(carOneImg, 'naturalHeight', { configurable: true, value: 895 });
wCarOne.eval(script);
await sleep(220);
expect(
  '单格轮播（逐格渲染中间态）也不进 fit',
  wCarOne.document.querySelectorAll('[data-te-media-fit]').length,
  0,
);
expect('单格轮播仍按行宿主钳制', wCarOne.document.getElementById('carList').dataset.teMediaCapped, '1');

// ================= 实例三十一：列容器先出现、推文后渲染（用户实测回归） =================
// 真机时序：X 先挂「列容器」（带 max-width:600px 的 hashed class），再往里渲染推文。
// 曾经用「这个元素内部有没有内容单元」判断角色 —— 容器被扫描时内部还是空的，判 false；
// 而祖先一旦扫过就不会再回看，于是那个唯一的列宽上限始终不被标记，整列退回 600px
// （用户实测「推文长度变回 600 宽」）。现在的实现从内容单元向上走祖先链，
// 内容后到时自然会补上。
const HTML_LATE_CONTENT = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="lateContainer" style="max-width:600px"></div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wLate = createWindow(HTML_LATE_CONTENT);
wLate.eval(script);
await sleep(200);
expect(
  '容器先出现时（内部还没内容）不打标记',
  wLate.document.getElementById('lateContainer').dataset.teWidthUnlocked,
  undefined,
);
// X 现在才把推文渲染进容器
const lateCell = wLate.document.createElement('div');
lateCell.setAttribute('data-testid', 'cellInnerDiv');
lateCell.innerHTML = '<article data-testid="tweet">hi</article>';
wLate.document.getElementById('lateContainer').appendChild(lateCell);
await sleep(320); // dom-watch 合并 + rAF 帧任务
expect(
  '内容到达后列容器被补上解锁标记（祖先链补扫）',
  wLate.document.getElementById('lateContainer').dataset.teWidthUnlocked,
  'max',
);

// ================= 实例三十二：视频 / GIF 也走等比 + 行高正好等于预算的坑 =================
// 真机缺陷（2026-09-14，akaoni2gou 的 GIF 帖，1440 视口）：
// ① X 的播放器比例盒把行高做成了**正好 540 = 预算**，旧实现先判「自然高度 ≤ 预算 → 无需处理」
//    就直接返回，等比永远不生效 → 盒子停在整列宽 976×540，`object-fit: contain` 把画面缩到
//    652 宽、两侧各留 164px 黑边；
// ② 用 videoWidth/Height 之外，播放器里还挂着 240×240 的装饰图，按 DOM 顺序取 img 会取错。
// 现在：判据改成「固有比例 × 行宽 > 预算」，盒子高度取 min(预算, 宿主当前高度)，固有尺寸取面积最大者。
const HTML_VIDEO = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="vidWrap" data-w="896" data-h="540" style="padding-bottom: 55.3279%">
          <div id="vidHost" data-w="896" data-h="540">
            <div id="vidPhoto" data-testid="tweetPhoto" data-w="896" data-h="540" style="margin: 0px">
              <img id="vidIcon" />
              <div data-testid="videoPlayer" id="vidPlayer"><video id="vidEl"></video></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

const wVideo = createWindow(HTML_VIDEO);
// jsdom 不解码媒体：直接给装饰图与视频各自的固有尺寸
const vidIcon = wVideo.document.getElementById('vidIcon');
Object.defineProperty(vidIcon, 'naturalWidth', { configurable: true, value: 240 });
Object.defineProperty(vidIcon, 'naturalHeight', { configurable: true, value: 240 });
const vidEl = wVideo.document.getElementById('vidEl');
Object.defineProperty(vidEl, 'videoWidth', { configurable: true, value: 1200 });
Object.defineProperty(vidEl, 'videoHeight', { configurable: true, value: 1000 });
wVideo.eval(script);
await sleep(240);
const vidPhoto = wVideo.document.getElementById('vidPhoto');
const vidHost = wVideo.document.getElementById('vidHost');
expect('GIF 帖：行高正好等于预算时依然进入等比', vidPhoto.dataset.teMediaFit, '1');
// 视频 1200×1000（比例 1.2）→ 540 × 1.2 = 648；若误取 240×240 的装饰图会得到 540
// 预算高 × 1200/1000 等比 → 宽度
expect('等比按视频固有比例算宽度', vidPhoto.style.width, `${Math.round((budgetOf(wVideo) * 1200) / 1000)}px`);
expect('等比高度取预算', vidPhoto.style.height, `${budgetOf(wVideo)}px`);
expect('宿主与媒体同宽', vidHost.style.width, `${Math.round((budgetOf(wVideo) * 1200) / 1000)}px`);
expect('媒体链整条收窄（含外层比例盒）', wVideo.document.getElementById('vidWrap').style.width, `${Math.round((budgetOf(wVideo) * 1200) / 1000)}px`);
// 盒内嵌套的播放器也要钉成同一个盒子：它的高度来自 X 那层「按盒宽算高度」的比例盒，
// 只钉外层时实测会在 648×540 / 648×359 / 648×0 之间飘（GIF 帖上下黑边或整块塌掉）
expect(
  '盒内嵌套的播放器被一起钉成同一尺寸',
  `${wVideo.document.getElementById('vidPlayer').style.width}×${wVideo.document.getElementById('vidPlayer').style.height}`,
  `${Math.round((budgetOf(wVideo) * 1200) / 1000)}px×${budgetOf(wVideo)}px`,
);

// 关闭单图等比 → 内部嵌套播放器的内联尺寸必须还原
toggleSetting(wVideo, 'media-fit');
await sleep(60);
expect(
  '关闭等比后嵌套播放器的内联尺寸还原',
  wVideo.document.getElementById('vidPlayer').getAttribute('style'),
  null,
);

// 反向：整列宽下按比例算出来不超过预算的宽图，不参与等比（保持「只缩不放」）
const HTML_WIDE_MEDIA = HTML_VIDEO.replace('data-w="896" data-h="540"', 'data-w="896" data-h="300"')
  .replace('<div data-testid="videoPlayer"><video id="vidEl"></video></div>', '');
const wWideMedia = createWindow(HTML_WIDE_MEDIA);
const wideIcon = wWideMedia.document.getElementById('vidIcon');
Object.defineProperty(wideIcon, 'naturalWidth', { configurable: true, value: 1200 });
Object.defineProperty(wideIcon, 'naturalHeight', { configurable: true, value: 600 });
wWideMedia.eval(script);
await sleep(240);
expect(
  '宽图（896/2 = 448 ≤ 预算）不参与等比，交回 X 满宽',
  wWideMedia.document.getElementById('vidPhoto').style.width,
  '',
);

// ================= 实例三十三：已钳行里又长出一张图（轮播成型）走增量路径 =================
// 旧版增量路径分两套：新增节点的 applyOne 撞上 `media.closest(FLAG_SELECTOR)` 会直接返回，
// 于是「宿主里从 1 张图变成 2 张图（轮播成型）」这类情况在增量路径上被漏掉，只能等下一次
// 全量对账 —— 期间那一行还留着按单图等比钉下的尺寸。现在两条来源合成一种「种子」，
// 任何种子都先解锁它所在的链再重新钳制。
const wGrow = createWindow(HTML_FIT);
const growImg = wGrow.document.getElementById('fitImg');
Object.defineProperty(growImg, 'naturalWidth', { configurable: true, value: 900 });
Object.defineProperty(growImg, 'naturalHeight', { configurable: true, value: 895 });
wGrow.eval(script);
await sleep(240);
expect('初始为单图：进入等比', wGrow.document.getElementById('fitPhoto').dataset.teMediaFit, '1');
// X 现在把第二张图渲染进同一行
const growPhoto = wGrow.document.createElement('div');
growPhoto.setAttribute('data-testid', 'tweetPhoto');
growPhoto.id = 'growPhoto';
growPhoto.style.cssText = 'width:100%;height:100%';
growPhoto.innerHTML = '<img id="growImg2" />';
wGrow.document.getElementById('fitHost').appendChild(growPhoto);
await sleep(500); // dom-watch 合并 + rAF 帧任务 + 去抖全量对账
expect('轮播成型后不再按单图等比（等比重排交给 X）', wGrow.document.getElementById('fitPhoto').dataset.teMediaFit, undefined);
expect('轮播成型后行仍被钳制', wGrow.document.getElementById('fitHost').dataset.teMediaCapped, '1');
expect(
  '整行不再残留任何 fit 尺寸',
  wGrow.document.querySelectorAll('[data-te-media-fit]').length,
  0,
);
expect('新加入的那张图不被当成等比目标', growPhoto.dataset.teMediaFit, undefined);

// ================= 实例三十四：SPA 导航重挂主列时，不能把我们自己的宽度当成原生列宽 =========
// 真机缺陷（2026-09-14 用户实测）：SPA 导航到另一个三栏页时，上一页的 data-te-timeline='wide'
// 还在，新主列一挂载就被 CSS 写成目标宽 —— 若此刻去「实测原生列宽」，读到的是脚本自己的输出
// （这里用 data-w="980" 模拟），解锁器判据区间被挪到 [930,1030] → 列容器不再被放开 →
// 时间线内容退回 600px，且一直坏到整页刷新。
const wSpa = createWindow();
wSpa.eval(script);
await sleep(200);
expect('SPA 前：列容器已解锁', wSpa.document.getElementById('timeline').dataset.teWidthUnlocked, 'max');
const spaOldPrimary = wSpa.document.querySelector('[data-testid="primaryColumn"]');
const spaNewPrimary = wSpa.document.createElement('div');
spaNewPrimary.setAttribute('data-testid', 'primaryColumn');
spaNewPrimary.setAttribute('data-w', '980'); // 已经是我们写进去的目标宽（CSS 仍生效）
spaNewPrimary.innerHTML =
  '<div style="width:100%"><div id="timeline2" style="max-width:600px"><div data-testid="cellInnerDiv">hi</div></div></div>';
spaOldPrimary.replaceWith(spaNewPrimary);
wSpa.history.pushState({}, '', '/indiezhou');
await sleep(400);
expect('SPA 后：新主列里的列容器仍被解锁（判据区间没被自己的宽度带偏）', wSpa.document.getElementById('timeline2').dataset.teWidthUnlocked, 'max');

// ================= 实例三十五：窄媒体被 X 逐层 shrink-wrap 时，中间包裹层也要钉住 =========
// 真机缺陷（2026-09-14 用户实测，Ford_R_plus 竖长单图 292×680）：X 自己把竖长图 letterbox 到
// 510 高（宽只剩 219），媒体列上每一层包裹都窄于 lockWidth —— findHost 只能一路抬到整行
// （978）才命中宿主，于是这些包裹层落在宿主**内部**、逃出 run。只钉宿主与媒体时，媒体盒被
// 钉成 249×580、外面几层仍是 219×510（其中一层还带 X 自己的内联 width:218.875px;height:510px），
// 图片从容器右下溢出 30×70px、卡片圆角边框横切图片中下部 ——「包裹它的容器和图片不匹配」复现。
const HTML_SHRINK = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home">主页</a></nav>
  <div id="row" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div id="shrinkRow" data-w="978" data-h="891">
          <div id="shrinkCard" data-w="219" data-h="510" style="width: 218.875px; height: 510px; max-width: 180px;">
            <div id="shrinkInner" data-w="219" data-h="510">
              <div id="shrinkPhoto" data-testid="tweetPhoto" data-w="219" data-h="510" style="margin: 0px"><img id="shrinkImg" /></div>
            </div>
          </div>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;
const wShrink = createWindow(HTML_SHRINK);
const shrinkImg = wShrink.document.getElementById('shrinkImg');
Object.defineProperty(shrinkImg, 'naturalWidth', { configurable: true, value: 292 });
Object.defineProperty(shrinkImg, 'naturalHeight', { configurable: true, value: 680 });
wShrink.eval(script);
await sleep(220);
const shrinkRow = wShrink.document.getElementById('shrinkRow');
const shrinkCard = wShrink.document.getElementById('shrinkCard');
const shrinkInner = wShrink.document.getElementById('shrinkInner');
const shrinkPhoto = wShrink.document.getElementById('shrinkPhoto');
const shrinkWidth = Math.round((budgetOf(wShrink) * 292) / 680);
expect('窄媒体（竖长图）的宿主被抬到整行并钳制', shrinkRow.dataset.teMediaCapped, '1');
expect(
  '等比尺寸按整行宽 × 固有比例判定（不被 219 宽的包裹层带偏）',
  `${shrinkPhoto.style.width}×${shrinkPhoto.style.height}`,
  `${shrinkWidth}px×${budgetOf(wShrink)}px`,
);
expect(
  '媒体到宿主之间每一层包裹都钉到同一尺寸（容器与图片闭合，无溢出）',
  [shrinkPhoto, shrinkInner, shrinkCard].map((el) => `${el.style.width}×${el.style.height}`).join(','),
  Array(3).fill(`${shrinkWidth}px×${budgetOf(wShrink)}px`).join(','),
);
expect(
  '中间包裹层也带 fit 标记（解锁器与解锁路径都覆盖到它们）',
  `${shrinkCard.dataset.teMediaFit}/${shrinkInner.dataset.teMediaFit}`,
  '1/1',
);
// X 把「自己那 510px 高度上限」写成内联 max-width（= 510 × 固有比例）：它会小于我们算出的
// 等比宽度，只钉 width 会被它卡住 —— 真机 /home 实测我们写 width:433px、X 的
// max-width:380.8px 把盒子卡在 381，图片比容器宽出 52px。max-width 必须一起解除。
expect('解除了 X 内联 max-width 的宽度上限（否则宽度被卡住、图片溢出）', shrinkCard.style.maxWidth, 'none');
expect('媒体盒上的 max-width 上限也解除', shrinkPhoto.style.maxWidth, 'none');
expect('解除了 X 内联 max-height 的高度上限', shrinkCard.style.maxHeight, 'none');
// 关闭等比：中间层常带 X 自己的内联宽高，必须逐字还原而不是 removeProperty
toggleSetting(wShrink, 'media-fit');
await sleep(80);
expect('关闭等比后 X 的内联比例盒宽度逐字还原', shrinkCard.style.width, '218.875px');
expect('关闭等比后 X 的内联比例盒高度逐字还原', shrinkCard.style.height, '510px');
expect('关闭等比后 X 的内联 max-width 逐字还原', shrinkCard.style.maxWidth, '180px');
expect(
  '关闭等比后媒体保留自己的其它内联样式（整条 style 快照回写）',
  shrinkPhoto.style.margin,
  '0px',
);
expect(
  '关闭等比后中间包裹层不再带 fit 标记',
  `${shrinkCard.dataset.teMediaFit}/${shrinkInner.dataset.teMediaFit}`,
  'undefined/undefined',
);

// ================= 实例三十六：「不搬节点」契约（排版只写属性） =================
// docs/architecture.md 的不变量：脚本不移动 / 不重建 React 管理的节点，排版类功能一律
// 只写属性、只插自己的 te- 前缀节点。这条红线目前只有约定，没有回归 —— 一旦有人把
// 「头像/名字/正文/操作栏搬进自建卡片壳」这类改法合进来，真实后果是：X 重渲染把节点放回去
// 留下半拆的树，且 cellInnerDiv 的高度输入被改坏（空白洞 / 重复推 / 滚不动），
// 而 jsdom 里所有属性断言都会照旧通过（属性是对的，树已经变了）。
// 所以这里直接对整条推文的**拓扑**做快照对比：跑脚本前后，每个节点的祖先链逐字相同。
const HTML_SHAPE = `<!doctype html><html><head></head><body>
  <nav aria-label="Primary"><a href="/home" aria-label="X">logo</a></nav>
  <div id="shapeRow" data-w="978" style="display:flex">
    <div data-testid="primaryColumn" style="width:800px">
      <div style="width:100%">
        <div data-testid="cellInnerDiv" id="shapeCell">
          <article data-testid="tweet" id="shapeTweet">
            <div data-testid="socialContext">某某转推</div>
            <div id="shapeCols" style="display:flex">
              <div data-testid="Tweet-User-Avatar" id="shapeAvatar"><img id="shapeAvatarImg" /></div>
              <div id="shapeBody">
                <div data-testid="User-Name">作者 <span>@alice</span> <time datetime="2026-09-15T00:00:00Z">9月15日</time></div>
                <div data-testid="tweetText">正文文本</div>
                <div id="shapeMedia" data-w="976" data-h="549">
                  <div id="shapeRatio" data-w="976" data-h="549" style="padding-bottom: 56.25%">
                    <div data-testid="tweetPhoto" id="shapePhoto" data-w="600" data-h="549"><img id="shapeImg" /></div>
                  </div>
                </div>
                <div role="group" id="shapeActions"><div data-testid="reply"></div><div data-testid="like"></div></div>
              </div>
            </div>
          </article>
        </div>
      </div>
    </div>
    <div data-testid="sidebarColumn"></div>
  </div>
</body></html>`;

/**
 * 拓扑签名：每个元素的祖先链 + 自己的标签/class。
 * 只取**结构**不取属性值，所以脚本写内联样式或 data-te-* 都不会让它变；
 * 但只要有人把一个节点挪走 / 包一层自建壳 / 新建容器，签名立刻不同。
 */
const structureSignature = (root) => {
  const parts = [];
  for (const el of root.querySelectorAll('*')) {
    const chain = [];
    for (let n = el.parentElement; n && n !== root.parentElement; n = n.parentElement) {
      chain.push(n.id || n.tagName);
    }
    parts.push(`${el.id || el.tagName}:${el.className}:${chain.join('<')}`);
  }
  return parts.join('|');
};

const wShape = createWindow(HTML_SHAPE);
const shapeTweet = wShape.document.getElementById('shapeTweet');
const shapeImg = wShape.document.getElementById('shapeImg');
Object.defineProperty(shapeImg, 'naturalWidth', { configurable: true, value: 1200 });
Object.defineProperty(shapeImg, 'naturalHeight', { configurable: true, value: 675 });
const shapeBefore = structureSignature(shapeTweet);
const shapeChildCount = shapeTweet.querySelectorAll('*').length;

wShape.eval(script);
await sleep(220);

// 签名本身很长，断言只比「是否逐字相同」，日志里不打印整棵树
const sameStructure = structureSignature(shapeTweet) === shapeBefore;
expect('排版契约：脚本没有改动推文里的节点拓扑（祖先链逐字相同）', sameStructure, true);
expect('排版契约：推文内元素数量不变（没有插入自建卡片壳）', shapeTweet.querySelectorAll('*').length, shapeChildCount);
// 反向对照：确认这一轮确实有功能写了东西 —— 否则上面两条「没变」是空跑（功能没生效也会通过）
expect(
  '排版契约的反向对照：媒体链已被钳制（说明脚本确实跑到了这一条）',
  wShape.document.getElementById('shapeRatio').dataset.teMediaCapped ? '1' : '未命中',
  '1',
);
expect(
  '排版契约的反向对照：正文语义分类已写入（内容列排版确实跑到了）',
  shapeTweet.dataset.teCaption,
  'short',
);

// ================= 输出 =================
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  →  实际=${String(r.actual)}`);
}
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);


