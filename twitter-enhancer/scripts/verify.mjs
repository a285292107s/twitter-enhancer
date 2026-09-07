/**
 * 用 jsdom 回归验证脚本运行时行为（无需打开 x.com）。
 *
 * 覆盖：
 * 1. 宽度解锁器 unlock-width：按计算值识别并解除被写死的 600px 容器；
 * 2. 推文 UI tweet-ui：主题检测、设计令牌注入、Alt+U 开关与持久化；
 * 3. 侧栏与搜索 sidebar：右栏隐藏、搜索宿主挂载、居中补偿、Alt+B 双向切换。
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
          <div id="tweet" style="width:600px">tweet body</div>
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

function createWindow(html = HTML) {
  const virtualConsole = new VirtualConsole();
  virtualConsole.on('jsdomError', (e) => console.error('[jsdom]', e.message));
  const dom = new JSDOM(html, {
    runScripts: 'outside-only',
    pretendToBeVisual: true,
    url: 'https://x.com/home',
    virtualConsole,
  });
  const { window } = dom;
  // jsdom 默认视口 1024，低于脚本的 1095 断点会直接走「不放大」分支；放宽到 1440
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: 1440 });
  // 媒体锁定用 offsetWidth / offsetHeight 判断宿主与计算占位补偿；
  // 带 data-w / data-h 的元素返回指定值（jsdom 无布局引擎，默认为 0）
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
  // jsdom 无布局引擎，clientWidth 恒为 0；这里让主列返回真实宽度 800，
  // 带 data-w 的元素返回指定宽度（用于模拟内栏收窄）。
  Object.defineProperty(window.HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get() {
      const forced = this.getAttribute?.('data-w');
      if (forced) return Number(forced);
      return this.getAttribute('data-testid') === 'primaryColumn' ? 800 : 0;
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
      // 主列：按「右栏隐藏且已居中」的真实几何（1920 视口实测）
      if (this.matches?.('[data-testid="primaryColumn"]')) {
        return { left: 720, right: 1520, top: 0, bottom: 100, width: 800, height: 100 };
      }
      // 左栏：X 用 fixed 钉在视口左侧
      if (this.matches?.('#rail')) {
        return { left: 320, right: 595, top: 0, bottom: 100, width: 275, height: 100 };
      }
      return { left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 };
    },
  });
  return window;
}

const press = (window, code) =>
  window.dispatchEvent(
    new window.KeyboardEvent('keydown', { code, altKey: true, bubbles: true, cancelable: true }),
  );

// ================= 实例一：默认状态 =================
const w1 = createWindow();
w1.eval(script);
await sleep(120);

const q = (id) => w1.document.getElementById(id);
expect('timeline（max-width:600px）应被解锁', q('timeline').dataset.teWidthUnlocked, 'max');
expect('tweet（width:600px）应被解锁', q('tweet').dataset.teWidthUnlocked, 'fixed');
expect('avatar（48px）不应被误伤', q('avatar').dataset.teWidthUnlocked, undefined);
expect(
  '主列宽度变量写入 800px',
  w1.document.documentElement.style.getPropertyValue('--te-timeline-width'),
  '800px',
);

const root1 = w1.document.documentElement;
expect('推文 UI 默认开启', root1.dataset.teUi, 'on');
expect('主题已检测', typeof root1.dataset.teTheme, 'string');
expect('正文字号令牌 16px', root1.style.getPropertyValue('--te-body-size'), '16px');
expect('行高令牌 1.5', root1.style.getPropertyValue('--te-body-lh'), '1.5');
expect('行长令牌 72ch', root1.style.getPropertyValue('--te-measure'), '72ch');
expect('宽时间线默认开启', root1.dataset.teTimeline, 'wide');
expect('三栏行被撑开以容纳主列', w1.document.getElementById('row').style.minWidth, '800px');
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
expect('三栏行已居中', q('row').style.justifyContent, 'center');
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
// 右栏显示时改为「左对齐 + 右栏固定 30px 间距」的锚定布局，不再是居中补偿
expect('显示右栏时不做居中补偿', row3.style.justifyContent, 'flex-start');

press(w3, 'KeyB');
await sleep(60);
expect('Alt+B 隐藏右栏', root3.dataset.teSidebar, 'off');
expect('隐藏后加居中补偿', row3.style.justifyContent, 'center');

press(w3, 'KeyB');
await sleep(60);
expect('再次 Alt+B 恢复右栏', root3.dataset.teSidebar, 'on');
expect('恢复后撤销居中补偿', row3.style.justifyContent, 'flex-start');

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

// ================= 实例五：油猴菜单开关（mock GM API） =================
const w5 = createWindow();
const menu = new Map();
let nextId = 1;
w5.GM_registerMenuCommand = (label, fn) => {
  const id = nextId++;
  menu.set(id, { label, fn });
  return id;
};
w5.GM_unregisterMenuCommand = (id) => {
  menu.delete(id);
};
w5.eval(script);
await sleep(120);

const labels = () => [...menu.values()].map((item) => item.label);
expect('注册了五个菜单开关', menu.size, 5);
expect('菜单含推文新样式开关', labels().some((l) => l.includes('推文新样式：开')), true);
expect('菜单含右侧栏开关', labels().some((l) => l.includes('右侧栏：隐藏')), true);
expect('菜单含宽时间线开关', labels().some((l) => l.includes('宽时间线（800px）：开')), true);
expect('菜单含导航条搜索框开关', labels().some((l) => l.includes('导航条搜索框：开')), true);
expect('菜单含图片锁定开关', labels().some((l) => l.includes('图片锁定原生尺寸：开')), true);

const sidebarItem = [...menu.values()].find((item) => item.label.includes('右侧栏'));
sidebarItem.fn();
await sleep(30);
expect('点击菜单后右栏变为显示', w5.document.documentElement.dataset.teSidebar, 'on');
expect('菜单文案随状态刷新', labels().some((l) => l.includes('右侧栏：显示')), true);
expect('刷新后菜单项数量不变', menu.size, 5);

// 宽时间线开关：关闭后主列交回 X 原生，行不再被撑开
const wideItem = [...menu.values()].find((item) => item.label.includes('宽时间线'));
wideItem.fn();
await sleep(30);
expect('关闭宽时间线后属性转为 off', w5.document.documentElement.dataset.teTimeline, 'off');
expect('关闭宽时间线后撤销行的 min-width', w5.document.getElementById('row').style.minWidth, '');
expect('宽时间线菜单文案刷新', labels().some((l) => l.includes('宽时间线（800px）：关')), true);
wideItem.fn();
await sleep(30);
expect('再次点击恢复宽时间线', w5.document.documentElement.dataset.teTimeline, 'wide');

// 导航条搜索框开关
const searchItem = [...menu.values()].find((item) => item.label.includes('导航条搜索框'));
searchItem.fn();
await sleep(30);
expect('关闭导航条搜索框', w5.document.documentElement.dataset.teSearch, 'off');
expect('关闭后宿主仍在 DOM（可随时再开）', Boolean(w5.document.querySelector('.te-search-host')), true);
expect('搜索框菜单文案刷新', labels().some((l) => l.includes('导航条搜索框：关')), true);
searchItem.fn();
await sleep(30);
expect('再次点击恢复搜索框', w5.document.documentElement.dataset.teSearch, 'on');

// 图片锁定开关：关闭后清除缩放样式
const lockItem = [...menu.values()].find((item) => item.label.includes('图片锁定原生尺寸'));
lockItem.fn();
await sleep(30);
expect('关闭图片锁定后属性清除', Boolean(w5.document.querySelector('[data-te-media-locked]')), false);
expect('图片锁定菜单文案刷新', labels().some((l) => l.includes('图片锁定原生尺寸：关')), true);
lockItem.fn();
await sleep(30);
expect('再次点击恢复图片锁定', labels().some((l) => l.includes('图片锁定原生尺寸：开')), true);

// ================= 实例十一：媒体宿主缩放计算 =================
const HTML_MEDIA = `<!doctype html><html><head></head><body>
  <div data-testid="primaryColumn" style="width:800px">
    <article>
      <div id="carousel" data-w="766" data-h="792">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
      <div id="singleWrap" data-w="718" data-h="512">
        <div data-testid="videoPlayer"></div>
      </div>
      <div id="tall" data-w="566" data-h="900">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
      <div id="small" data-w="500" data-h="300">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
      <div id="giant" data-w="400" data-h="9604">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
      <div id="giantWide" data-w="766" data-h="9604">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
    </article>
  </div>
</body></html>`;

const w11 = createWindow(HTML_MEDIA);
w11.eval(script);
await sleep(120);
const carousel = w11.document.getElementById('carousel');
const singleWrap = w11.document.getElementById('singleWrap');
const tall = w11.document.getElementById('tall');
const small = w11.document.getElementById('small');
const scaleOf = (el) => Number.parseFloat((el.style.transform.match(/scale\(([\d.]+)\)/) || [])[1] || '0');
// 缩放因子 = min(1, 566/宽, 540/高)
expect(
  '轮播被高度钳制（min(0.739, 0.682) = 0.682）',
  Math.round(scaleOf(carousel) * 1000) / 1000,
  Math.round(Math.min(566 / 766, 540 / 792) * 1000) / 1000,
);
expect(
  '单图/视频按宽度钳制（高未超限）',
  Math.round(scaleOf(singleWrap) * 1000) / 1000,
  Math.round((566 / 718) * 1000) / 1000,
);
expect('竖长图被高度钳到 0.6（900 → 540）', Math.round(scaleOf(tall) * 1000) / 1000, 0.6);
expect('不超限的媒体不被缩放', scaleOf(small), 0);
// 虚拟列表类超高容器不是媒体区：窄的不命中宿主，宽的触发 2.5 屏护栏
const giant = w11.document.getElementById('giant');
const giantWide = w11.document.getElementById('giantWide');
expect('窄而超高的容器不被识别为宿主', giant.dataset.teMediaLocked, undefined);
expect('超 2.5 屏高的宿主被护栏跳过', giantWide.style.transform, '');
expect('竖长图无缩放残留标记外样式', tall.style.transformOrigin, 'top left');
expect(
  '轮播占位高度补偿为负 margin',
  carousel.style.marginBottom,
  `${-Math.round(792 * (1 - Math.min(566 / 766, 540 / 792)))}px`,
);
expect('竖长图占位补偿', tall.style.marginBottom, `${-Math.round(900 * 0.4)}px`);

// ================= 实例十二：轮播复合锁定（真机踩坑） =================
// 轮播行 766 内同时有大图格（716，自身够格被锁）与小图格（306，不够格、
// 向上爬会命中轮播行）——若两层都锁，缩放叠加 0.79 × 0.74 图片被压到一半。
// 规则：嵌套锁定只保留最外层，外层锁内层解锁；已被外层覆盖的媒体跳过。
const HTML_CAROUSEL = `<!doctype html><html><head></head><body>
  <div data-testid="primaryColumn"><article>
    <div id="crow" data-w="766" data-h="510">
      <div id="cbig" data-w="716" data-h="500">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
      <div id="csmall" data-w="306" data-h="510">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
    </div>
  </article></div>
</body></html>`;
const w12 = createWindow(HTML_CAROUSEL);
w12.eval(script);
await sleep(120);
const crow = w12.document.getElementById('crow');
const cbig = w12.document.getElementById('cbig');
const csmall = w12.document.getElementById('csmall');
expect('轮播行被锁定（最外层生效）', crow.dataset.teMediaLocked, '1');
expect(
  '轮播行缩放为宽度钳制（566/766）',
  Math.round(scaleOf(crow) * 1000) / 1000,
  Math.round((566 / 766) * 1000) / 1000,
);
expect('行内大图的宿主冗余锁定被解除', cbig.dataset.teMediaLocked, undefined);
expect('大图宿主无缩放残留', cbig.style.transform, '');
expect('小图格自身不锁（由外层覆盖）', csmall.dataset.teMediaLocked, undefined);
expect(
  '页面内不存在嵌套锁定',
  w12.document.querySelectorAll('[data-te-media-locked] [data-te-media-locked]').length,
  0,
);

// ================= 实例十三：历史嵌套锁定归一化 + 关闭开关真正清除 =================
// 修复前可能残留「内外各锁一层」的坏状态；新版本扫描时必须归一化。
// 另外 resetMediaLock 的选择器曾写成 [data-teMediaLocked]（匹配不到
// data-te-media-locked），关闭开关后缩放残留——这里一并回归。
const HTML_NESTED = `<!doctype html><html><head></head><body>
  <div data-testid="primaryColumn"><article>
    <div id="outerStale" data-w="766" data-h="510" data-te-media-locked="1"
         style="transform: scale(0.695); margin-bottom: -237px">
      <div id="innerStale" data-w="716" data-h="500" data-te-media-locked="1"
           style="transform: scale(0.7905); margin-bottom: -105px">
        <div data-testid="tweetPhoto"><img /></div>
      </div>
    </div>
  </article></div>
</body></html>`;
const w13 = createWindow(HTML_NESTED);
w13.eval(script);
await sleep(120);
const outerStale = w13.document.getElementById('outerStale');
const innerStale = w13.document.getElementById('innerStale');
expect('外层锁定保留', outerStale.dataset.teMediaLocked, '1');
expect('内层冗余锁定被解除', innerStale.dataset.teMediaLocked, undefined);
expect('内层缩放样式被清除', innerStale.style.transform, '');
expect('内层占位补偿被清除', innerStale.style.marginBottom, '');

// 关闭状态持久化：localStorage 预置 media-lock=false，脚本加载后不得加锁
const HTML_PREF = `<!doctype html><html><head></head><body>
  <div data-testid="primaryColumn"><article>
    <div id="pwrap" data-w="716" data-h="500">
      <div data-testid="tweetPhoto"><img /></div>
    </div>
  </article></div>
</body></html>`;
const w14 = createWindow(HTML_PREF);
w14.localStorage.setItem('twitter-enhancer:media-lock', 'false');
w14.eval(script);
await sleep(150);
const pwrap = w14.document.getElementById('pwrap');
expect('关闭状态下加载脚本不锁定媒体', pwrap.dataset.teMediaLocked, undefined);
expect('关闭状态下无缩放样式', pwrap.style.transform, '');

const uiItem = [...menu.values()].find((item) => item.label.includes('推文新样式'));
uiItem.fn();
await sleep(30);
expect('点击菜单后推文样式关闭', w5.document.documentElement.dataset.teUi, 'off');
expect('推文样式菜单文案刷新', labels().some((l) => l.includes('推文新样式：关')), true);

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

// ================= 实例九：左栏以主列为锚点（右栏隐藏） =================
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
expect('左栏按 fixed 定位特征被识别', rail9.style.width, '275px');
expect('左栏 right 放开（否则宽度会被 left/right 反推）', rail9.style.right, 'auto');
expect('左栏锚到主列左侧（720-275）', rail9.style.left, '445px');
expect('右栏隐藏时不动右栏外边距', sb9.style.marginLeft, '');
expect('右栏隐藏时主列仍然居中', row9.style.justifyContent, 'center');

// ================= 实例十：右栏显示时也锚在主列右侧 =================
const w10 = createWindow(HTML_RAIL);
// false = 不隐藏右栏（即显示）
w10.localStorage.setItem('twitter-enhancer:sidebar', 'false');
w10.eval(script);
await sleep(120);
const rail10 = w10.document.getElementById('rail');
const row10 = w10.document.getElementById('row');
const sb10 = w10.document.querySelector('[data-testid="sidebarColumn"]');
expect('右栏显示时左栏同样锚在主列左侧', rail10.style.left, '445px');
expect('右栏显示时三栏行改为左对齐', row10.style.justifyContent, 'flex-start');
expect('右栏紧贴主列右侧（固定 30px）', sb10.style.marginLeft, '30px');

// ================= 输出 =================
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  →  实际=${String(r.actual)}`);
}
console.log(failed === 0 ? `\n全部通过（${results.length} 项）` : `\n${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
