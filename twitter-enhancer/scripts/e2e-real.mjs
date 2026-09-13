#!/usr/bin/env node
/**
 * e2e-real.mjs —— 真机 E2E（方案 B：addInitScript 直注 + GM shim）。
 *
 * 为什么存在：playwright-cli 只暴露 open/goto/eval 等命令，没有 addInitScript /
 * --load-extension 通道；x-te profile 也未装 Tampermonkey。而 jsdom 无布局引擎，
 * 「真实布局几何 / 与当前 X DOM 结构兼容 / document-start 时序」只能在真浏览器验证。
 * 本脚本绕开 CLI 直接驱动 Playwright（同一全局 @playwright/cli 内置的 playwright
 * 模块、同一缓存内核），用 addInitScript 在 document-start 时序先注入 GM shim
 * 再注入 dist 产物 —— 与 @run-at document-start 等价的注入位。
 *
 * 验证范围（几何层，全部确定性断言）：
 * 1. 功能激活：右栏隐藏时主列铺满 X 内容区（1440 视口 980 = 行 1050 − 右栏右边距 70）、
 *    左缘不动、行不被改写 / 导航条搜索框 / tweet-ui 令牌；
 * 2. 真实键盘监听：Alt+B 双向切换右栏显隐（显示时主列 600–800、行被撑开锚定）；
 * 3. 左导航条全程零改写：/home 与 /i/grok 都由 X 自己的 fixed 定位摆放（无脚本内联样式）；
 * 4. 媒体钳制机制：注入超高媒体行 → rAF 帧任务钳到预算高度；回落后宿主粒度解锁；
 * 5. tab 切换 /home ↔ /i/grok：逐帧断言主列几何与左栏位置零变化（两页共用同一个
 *    内容区盒子，这是「切 tab 不跳布局」的验收点）；
 * 6. 页内设置面板：右下角设置按钮落在 X 的 Grok 悬浮按钮正上方（同列、不重叠）、
 *    点击打开弹窗、弹窗里的开关真的改变布局（用「显示右侧栏」验证）。
 *
 * 明确不覆盖：油猴菜单 UI、真 GM_* 语义（本脚本有意只 shim GM_addStyle，
 * 其余走仓库 localStorage / no-op 降级路径，与 jsdom 回归一致）。
 * 发布前的「真实 Tampermonkey」冒烟仍建议人工装一次 dist 确认。
 *
 * 前置：先 `npm run verify`（本脚本读 dist/twitter-enhancer.user.js）。
 * 运行：npm run e2e:real
 *
 * 浏览器铁律（AGENTS.md）：headless + 独立持久 profile（browser-profiles/x-te-e2e，
 * 已 gitignore），不碰用户浏览器；登录态来自仓库根 auth.json（storageState），
 * 一次性 addCookies 导入后随 profile 持久化。内核优先取 ms-playwright 缓存中现存
 * 最新 headless shell（驱动注册表 revision 可能与缓存不一致），可用环境变量
 * TE_E2E_EXECUTABLE 显式指定；迁移机器时需调整 resolvePlaywright()/resolveExecutable()。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const enhancerRoot = path.resolve(__dirname, '..');
const repoRoot = path.resolve(__dirname, '../..');
const distFile = path.join(enhancerRoot, 'dist', 'twitter-enhancer.user.js');
const shimFile = path.join(__dirname, 'e2e', 'gm-shim.js');
const authFile = path.join(repoRoot, 'auth.json');
const profileDir = path.join(repoRoot, 'browser-profiles', 'x-te-e2e');

const VIEWPORT = { width: 1440, height: 900 };

/* ---------------- Playwright 解析（复用全局 @playwright/cli 内置模块） ---------------- */
function resolvePlaywright() {
  const appData = process.env.APPDATA || '';
  const candidates = [
    // npm 默认全局前缀（Windows）
    path.join(appData, 'npm', 'node_modules', '@playwright', 'cli', 'node_modules', 'playwright'),
  ];
  for (const dir of candidates) {
    if (existsSync(path.join(dir, 'package.json'))) return dir;
  }
  throw new Error(
    '找不到全局 playwright 模块（@playwright/cli 内置）。' +
      '本仓库验证环境把它装在 npm 全局前缀下；若迁移到其他机器请调整 resolvePlaywright()。',
  );
}
const playwrightDir = resolvePlaywright();
const requireGlobal = createRequire(path.join(playwrightDir, 'package.json'));
const { chromium } = requireGlobal(playwrightDir);

/* ---------------- 浏览器内核解析 ---------------- */
// 驱动模块的注册表 revision 可能与本地缓存不一致（如 CLI 模块期望 1243、缓存最高 1234），
// 此时默认路径会启动失败。这里优先用 ms-playwright 缓存里现存的最新 headless shell
// （与 CLI 实际使用的内核同源），也接受 TE_E2E_EXECUTABLE 环境变量显式指定。
function resolveExecutable() {
  if (process.env.TE_E2E_EXECUTABLE) return process.env.TE_E2E_EXECUTABLE;
  const cacheRoot = path.join(process.env.LOCALAPPDATA || '', 'ms-playwright');
  if (!existsSync(cacheRoot)) return null;
  const shells = readdirSync(cacheRoot)
    .filter((n) => /^chromium_headless_shell-\d+$/.test(n))
    .map((n) => Number.parseInt(n.split('-').pop(), 10))
    .sort((a, b) => b - a);
  for (const rev of shells) {
    const exe = path.join(
      cacheRoot,
      `chromium_headless_shell-${rev}`,
      'chrome-headless-shell-win64',
      'chrome-headless-shell.exe',
    );
    if (existsSync(exe)) return exe;
  }
  return null;
}
const executablePath = resolveExecutable();

/* ---------------- 断言收集 ---------------- */
const results = [];
const expect = (name, actual, wanted) => {
  results.push({ name, actual, wanted, ok: Object.is(actual, wanted) });
};

/* ---------------- 登录态 ---------------- */
function authCookies() {
  if (!existsSync(authFile)) return [];
  try {
    const state = JSON.parse(readFileSync(authFile, 'utf8'));
    const list = Array.isArray(state?.cookies) ? state.cookies : [];
    return list.filter((c) => {
      const d = String(c?.domain ?? '');
      return d.endsWith('x.com') || d.endsWith('twitter.com');
    });
  } catch (error) {
    console.warn('[e2e] auth.json 解析失败，跳过 cookie 导入：', error.message);
    return [];
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function run() {
  if (!existsSync(distFile)) throw new Error(`未找到 ${distFile}，请先运行 npm run verify（构建 dist）`);
  if (!existsSync(shimFile)) throw new Error(`未找到 GM shim ${shimFile}`);

  const context = await chromium.launchPersistentContext(profileDir, {
    headless: true,
    viewport: VIEWPORT,
    locale: 'zh-CN',
    ...(executablePath ? { executablePath } : {}),
  });
  if (executablePath) console.log(`[info] 使用缓存内核：${executablePath}`);
  try {
    const cookies = authCookies();
    if (cookies.length > 0) await context.addCookies(cookies);
    else console.warn('[e2e] 未导入任何 x.com cookie（auth.json 缺失或为空）——断言可能因未登录失败');

    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(20000);
    // 页面侧日志转发：只保留脚本相关错误（X 自身有大量 CSP/内部噪音，避免刷屏）；
    // 脚本启用失败会以 [twitter-enhancer] 前缀打到 console
    page.on('console', (msg) => {
      if (msg.type() === 'error' && msg.text().includes('twitter-enhancer')) {
        console.log(`[page.error] ${msg.text().slice(0, 600)}`);
      }
    });
    page.on('pageerror', (err) => console.log(`[pageerror] ${String(err?.message ?? err).slice(0, 600)}`));

    // document-start 时序：单个 init 脚本 = 硬化 GM shim + 等待 documentElement 存在后
    // 再执行 dist 产物。注意 Playwright 的 addInitScript 在 document 刚创建时运行，
    // 此时 documentElement 可能尚未生成（dom-watch observe / tweet-ui 等会因此崩溃；
    // 真 TM 的 document-start 同样不保证 documentElement 已存在）—— 必须先等根节点。
    const shimSource = readFileSync(shimFile, 'utf8');
    const bundle = readFileSync(distFile, 'utf8');
    // 测试确定性：profile 是持久化的，人工探测或上一次运行留下的开关值
    // （twitter-enhancer:* 由 store.ts 双写 localStorage）会让断言从非默认状态起跑
    // —— 例如上轮结束在「显示右栏」，本轮 readFlag 异步回读后会把刚写好的默认值改掉，
    // Alt+B 的奇偶就整体错位。每轮开跑前清掉自己的键，X 自身的存储不动。
    const clearSettings = `;(function () {
  try {
    var keys = [];
    for (var i = 0; i < localStorage.length; i += 1) {
      var k = localStorage.key(i);
      if (k && k.indexOf('twitter-enhancer:') === 0) keys.push(k);
    }
    for (var j = 0; j < keys.length; j += 1) localStorage.removeItem(keys[j]);
  } catch (e) {}
})();`;
    const initScript = `${shimSource}
${clearSettings}
;(function () {
  'use strict';
  function boot() {
    try {
      (function () {
${bundle}
      })();
    } catch (error) {
      console.error('[twitter-enhancer] e2e bundle 执行失败', error);
    }
  }
  if (document.documentElement) {
    boot();
  } else {
    var mo = new MutationObserver(function () {
      if (document.documentElement) {
        mo.disconnect();
        boot();
      }
    });
    mo.observe(document, { childList: true });
  }
})();
`;
    await context.addInitScript({ content: initScript });

    await page.goto('https://x.com/home', { waitUntil: 'domcontentloaded', timeout: 60000 });

    // 等 React 挂载主列 + 我们的宽列生效（store 异步读回默认值也在此后稳定）
    await page.waitForFunction(
      () =>
        !!document.querySelector('[data-testid="primaryColumn"]') &&
        document.documentElement.dataset.teTimeline === 'wide',
      { timeout: 40000 },
    );
    // 布局测量前多等一拍，等 rAF / 120ms dom-watch 批次收敛
    await sleep(800);

    /* ============ 1. 功能激活（几何层） ============ */
    const activation = await page.evaluate(() => {
      const root = document.documentElement;
      const primary = document.querySelector('[data-testid="primaryColumn"]');
      const row = primary?.parentElement;
      const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
      const cs = (el, prop) => (el ? getComputedStyle(el)[prop] : '');
      const logo = document.querySelector('a[aria-label="X"]');
      let rail = logo ? logo.parentElement : null;
      while (rail && rail !== document.body && getComputedStyle(rail).position !== 'fixed') {
        rail = rail.parentElement;
      }
      const railBox = rail ? rail.getBoundingClientRect() : null;
      // 右栏隐藏时主列应铺满 X 内容区 = 行宽 − 右栏保留的右边距（与 /i/grok 同宽）
      const contentBox = row
        ? Math.round(row.clientWidth - (Number.parseFloat(cs(sidebar, 'marginRight')) || 0))
        : 0;
      return {
        teTimeline: root.dataset.teTimeline,
        primaryW: primary ? Math.round(primary.getBoundingClientRect().width) : 0,
        primaryX: primary ? Math.round(primary.getBoundingClientRect().left) : -1,
        rowX: row ? Math.round(row.getBoundingClientRect().left) : -1,
        contentBox,
        teSidebar: root.dataset.teSidebar,
        sidebarDisplay: sidebar ? cs(sidebar, 'display') : '(none)',
        rowJustify: row ? cs(row, 'justifyContent') : '',
        rowMinWidth: row ? row.style.minWidth : '',
        // 左导航条：脚本必须一个字节都不写（X 自己的 fixed 定位与主列左缘对齐）
        railInline: rail ? (rail.getAttribute('style') ?? '') : '(none)',
        railRight: railBox ? Math.round(railBox.right) : -1,
        railX: railBox ? Math.round(railBox.left) : -1,
        railW: railBox ? Math.round(railBox.width) : -1,
        teSearch: root.dataset.teSearch,
        hasNavInput: !!document.querySelector('.te-search-host input[type="search"]'),
        teUi: root.dataset.teUi,
        teTheme: root.dataset.teTheme,
        bodySize: root.style.getPropertyValue('--te-body-size').trim(),
        lh: root.style.getPropertyValue('--te-body-lh').trim(),
        measure: root.style.getPropertyValue('--te-measure').trim(),
        teRowData: row?.dataset.teRow,
      };
    });
    expect('宽时间线已激活（data-te-timeline=wide）', activation.teTimeline, 'wide');
    console.log(
      `[info] 主列实测宽 ${activation.primaryW}px（左缘 ${activation.primaryX}）= X 内容区 ${activation.contentBox}px（行左缘 ${activation.rowX}）；左导航条 x=${activation.railX} w=${activation.railW} inline="${activation.railInline}"`,
    );
    // 右栏隐藏 → 主列铺满 X 内容区（1440 视口 = 1050 − 70 = 980，与 /i/grok 原生主列同宽同左缘）
    expect('主列宽度 = 行宽 − 右栏保留的右边距（铺满内容区）', activation.primaryW >= activation.contentBox - 2 && activation.primaryW <= activation.contentBox, true);
    expect('主列左缘与行左缘重合（不居中）', Math.abs(activation.primaryX - activation.rowX) <= 2, true);
    // 左导航条完全不被脚本改写：没有内联样式，且它的右缘与主列左缘天然对齐（RAIL_GAP=0）
    expect('左导航条无任何脚本内联样式', activation.railInline, '');
    expect('左导航条右缘与主列左缘对齐（X 自身定位，与 /i/grok 同一套逻辑）', Math.abs(activation.railRight - activation.primaryX) <= 1, true);
    expect('右栏默认隐藏（data-te-sidebar=off）', activation.teSidebar, 'off');
    expect('右栏计算样式为 display:none', activation.sidebarDisplay, 'none');
    // 铺满内容区时行不需要任何补偿样式：保持 X 原生的 space-between（单子节点 == 左对齐）
    expect('右栏隐藏时行保持 X 原生对齐', activation.rowJustify, 'space-between');
    expect('右栏隐藏时不写行的 min-width', activation.rowMinWidth, '');
    expect('右栏隐藏时不给行打补偿标记', activation.teRowData, undefined);
    expect('导航条搜索框默认开启', activation.teSearch, 'on');
    expect('左栏已挂载自建搜索输入框', activation.hasNavInput, true);
    expect('推文 UI 默认开启', activation.teUi, 'on');
    expect('主题已检测并写入', ['light', 'dim', 'dark'].includes(activation.teTheme), true);
    expect('字号令牌 16px', activation.bodySize, '16px');
    expect('行高令牌 1.5', activation.lh, '1.5');
    expect('行长令牌 72ch', activation.measure, '72ch');

    /* ============ 2. 真实键盘监听：Alt+B 双向切换右栏 ============ */
    const pressAltB = () =>
      page.evaluate(() => {
        window.dispatchEvent(
          new KeyboardEvent('keydown', { code: 'KeyB', altKey: true, bubbles: true, cancelable: true }),
        );
      });
    await pressAltB();
    await sleep(300);
    const afterOn = await page.evaluate(() => {
      const s = document.querySelector('[data-testid="sidebarColumn"]');
      const p = document.querySelector('[data-testid="primaryColumn"]');
      const row = p?.parentElement;
      const logo = document.querySelector('a[aria-label="X"]');
      let rail = logo ? logo.parentElement : null;
      while (rail && rail !== document.body && getComputedStyle(rail).position !== 'fixed') {
        rail = rail.parentElement;
      }
      return {
        teSidebar: document.documentElement.dataset.teSidebar,
        display: s ? getComputedStyle(s).display : '(none)',
        rowJustify: row ? getComputedStyle(row).justifyContent : '',
        rowMinWidth: row ? row.style.minWidth : '',
        teRow: row?.dataset.teRow,
        primaryW: p ? Math.round(p.getBoundingClientRect().width) : 0,
        railInline: rail ? (rail.getAttribute('style') ?? '') : '(none)',
      };
    });
    expect('Alt+B → 右栏显示（data-te-sidebar=on）', afterOn.teSidebar, 'on');
    expect('Alt+B 后右栏可见', afterOn.display === 'none' ? 'none' : 'visible', 'visible');
    expect('右栏显示后行改左对齐锚定', afterOn.rowJustify, 'flex-start');
    expect('右栏显示时行被撑开（data-te-row=1）', afterOn.teRow, '1');
    expect('右栏显示时主列在 600–800 之间（不吃掉右栏位置）', afterOn.primaryW >= 600 && afterOn.primaryW <= 800, true);
    expect('右栏显示时左导航条依旧不被改写', afterOn.railInline, '');
    await pressAltB();
    await sleep(300);
    const afterOff = await page.evaluate(() => {
      const p = document.querySelector('[data-testid="primaryColumn"]');
      const row = p?.parentElement;
      const logo = document.querySelector('a[aria-label="X"]');
      let rail = logo ? logo.parentElement : null;
      while (rail && rail !== document.body && getComputedStyle(rail).position !== 'fixed') {
        rail = rail.parentElement;
      }
      return {
        teSidebar: document.documentElement.dataset.teSidebar,
        rowJustify: row ? getComputedStyle(row).justifyContent : '',
        rowMinWidth: row ? row.style.minWidth : '',
        teRow: row?.dataset.teRow,
        railInline: rail ? (rail.getAttribute('style') ?? '') : '(none)',
      };
    });
    expect('再次 Alt+B → 右栏隐藏', afterOff.teSidebar, 'off');
    expect('右栏再隐藏后行还原 X 原生对齐', afterOff.rowJustify, 'space-between');
    expect('右栏再隐藏后清掉行的 min-width', afterOff.rowMinWidth, '');
    expect('右栏再隐藏后清掉行补偿标记', afterOff.teRow, undefined);
    expect('右栏再隐藏后左导航条仍无脚本样式', afterOff.railInline, '');

    /* ============ 3. 媒体钳制机制（确定性注入，走真实布局） ============ */
    // 注入与 X 轮播同构的行：宿主 718 宽 + aspect-ratio 撑出 ~1077 自然高，
    // 内部媒体格 height:100%（压宿主高度后会随之重排 → 布局校验通过，不会触发还原）。
    await page.evaluate(() => {
      const cell = document.querySelector('[data-testid="cellInnerDiv"]');
      if (!cell) throw new Error('页面没有 cellInnerDiv，无法注入测试宿主');
      const host = document.createElement('div');
      host.id = 'te-e2e-host';
      host.style.width = '718px';
      host.style.aspectRatio = '1 / 1.5'; // 自然高 ≈ 718*1.5 ≈ 1077 > 预算
      const media = document.createElement('div');
      media.setAttribute('data-testid', 'tweetPhoto');
      media.style.width = '100%';
      media.style.height = '100%';
      host.appendChild(media);
      cell.appendChild(host);
    });

    const budget = await page.evaluate(
      () => Math.max(120, Math.min(540, window.innerHeight - 220)),
    );
    const clamped = await page
      .waitForFunction(
        (b) => {
          const host = document.getElementById('te-e2e-host');
          return !!host && host.dataset.teMediaCapped === '1' && host.style.height === `${b}px`;
        },
        budget,
        { timeout: 10000 },
      )
      .then(() => true)
      .catch(() => false);
    expect(`超高媒体行被钳到预算高度 ${budget}px`, clamped, true);
    const clampState = await page.evaluate(() => {
      const host = document.getElementById('te-e2e-host');
      return host ? { h: host.style.height, flag: host.dataset.teMediaCapped } : null;
    });
    expect('钳制只写宿主 layout height', clampState?.h, `${budget}px`);
    expect('宿主已打钳制标记', clampState?.flag, '1');

    // 媒体自然高回落到预算内 → 宿主粒度解锁（只动这一条链）
    await page.evaluate(() => {
      const host = document.getElementById('te-e2e-host');
      if (!host) throw new Error('测试宿主已被虚拟滚动移除');
      host.style.aspectRatio = '718 / 200'; // 自然高 ≈ 200 ≤ 预算
      document.dispatchEvent(new CustomEvent('te:layout'));
    });
    const unlocked = await page
      .waitForFunction(() => {
        const host = document.getElementById('te-e2e-host');
        return !!host && host.dataset.teMediaCapped === undefined && host.style.height === '';
      }, { timeout: 10000 })
      .then(() => true)
      .catch(() => false);
    expect('媒体回落预算内后自动解锁', unlocked, true);

    /* ============ 4. tab 切换 /home ↔ /i/grok：主区几何逐帧不变 ============ */
    // 这是本功能的验收核心：X 的 /i/grok 只是「把右栏那一份横向空间让给主列」——
    // 主列左缘与 /home 相同、右缘接到右栏右缘，左导航条一点不动。脚本在 /home
    // 隐藏右栏后必须产出同一个盒子（行宽 − 右栏保留的右边距），否则两个 tab 之间
    // 切换会出现「主列横移 + 宽度变化 + 左栏跳位」。
    // 这里逐帧记录两页往返的几何：主列存在的每一帧都必须是同一个矩形，且左栏右缘
    // 始终贴着主列左缘（RAIL_GAP=0，留 2px 取整容差）、右栏从未可见。
    // 用左栏的两个 tab（Grok / 主页）做真实 SPA 导航，与用户操作路径一致。
    await page.evaluate(() => {
      const frames = [];
      let last = null;
      const rec = () => {
        const p = document.querySelector('[data-testid="primaryColumn"]');
        const s = document.querySelector('[data-testid="sidebarColumn"]');
        const row = p ? p.parentElement : null;
        const pr = p ? p.getBoundingClientRect() : null;
        const logo = document.querySelector('a[aria-label="X"]');
        let rail = logo ? logo.parentElement : null;
        while (rail && rail !== document.body && getComputedStyle(rail).position !== 'fixed') {
          rail = rail.parentElement;
        }
        const rr = rail ? rail.getBoundingClientRect() : null;
        const snap = {
          path: location.pathname,
          pE: !!p,
          sVis: !!(s && s.getClientRects().length),
          px: pr ? Math.round(pr.left) : -1,
          pw: pr ? Math.round(pr.width) : -1,
          jc: row ? getComputedStyle(row).justifyContent : '',
          railLeft: rr ? Math.round(rr.left) : -1,
          railRight: rr ? Math.round(rr.right) : -1,
          railInline: rail ? (rail.getAttribute('style') ?? '') : '',
          te: document.documentElement.dataset.teTimeline ?? '',
        };
        const key = JSON.stringify(snap);
        if (key !== last) {
          last = key;
          frames.push(snap);
        }
        requestAnimationFrame(rec);
      };
      window.__teNavFrames = frames;
      requestAnimationFrame(rec);
    });
    const clickRailLink = (href) =>
      page
        .evaluate((h) => {
          const logo = document.querySelector('a[aria-label="X"]');
          let rail = logo ? logo.parentElement : null;
          while (rail && rail !== document.body && getComputedStyle(rail).position !== 'fixed') {
            rail = rail.parentElement;
          }
          const link = (rail || document).querySelector(`a[href="${h}"]`);
          if (!link) return false;
          link.click();
          return true;
        }, href)
        .catch(() => false);
    const waitPath = (p) =>
      page
        .waitForFunction(
          (want) => location.pathname === want && !!document.querySelector('[data-testid="primaryColumn"]'),
          p,
          { timeout: 20000 },
        )
        .then(() => true)
        .catch(() => false);

    const toGrok = (await clickRailLink('/i/grok')) && (await waitPath('/i/grok'));
    expect('左栏 Grok 标签可点开（SPA 导航）', toGrok, true);
    await sleep(700); // 多录几帧，确保过渡已结束
    const toHome = (await clickRailLink('/home')) && (await waitPath('/home'));
    expect('左栏 主页 标签可点回（SPA 导航）', toHome, true);
    await sleep(700);

    const navFrames = await page.evaluate(() => window.__teNavFrames ?? []);
    const withPrimary = navFrames.filter((f) => f.pE);
    // 1) 主列几何与左栏位置在整段往返里不得变化
    const boxes = new Set(withPrimary.map((f) => `${f.px},${f.pw},${f.railLeft}`));
    console.log(`[info] 切换过程记录 ${navFrames.length} 个状态帧，含主列 ${withPrimary.length} 帧，不同几何 ${boxes.size} 种`);
    if (boxes.size > 1) console.log(`[info] 几何变化：${JSON.stringify(withPrimary)}`);
    expect('切换过程中主列几何与左栏位置零变化', boxes.size, 1);
    // 2) 该矩形就是 X 内容区（1440 视口实测：左缘 363、宽 980 = 行 1050 − 右栏右边距 70）
    const settled = withPrimary[withPrimary.length - 1];
    expect('主列左缘保持 X 原生位置 363（与 /i/grok 相同）', Math.abs(settled.px - 363) <= 2, true);
    expect('主列宽度 = X 内容区 980（与 /i/grok 原生主列同宽）', Math.abs(settled.pw - 980) <= 2, true);
    // 3) 左栏始终贴着主列左缘、右栏全程不可见、导航条全程不被脚本改写
    const badFrames = withPrimary.filter(
      (f) => Math.abs(f.railRight - f.px) > 2 || f.sVis || f.railInline !== '',
    );
    if (badFrames.length > 0) console.log(`[info] 异常帧样例：${JSON.stringify(badFrames.slice(0, 3))}`);
    expect('每一帧左栏右缘都贴主列左缘、右栏全程不可见、导航条无脚本样式', badFrames.length, 0);
    // 4) 终态：回到 /home 且宽列开启
    const finalState = await page.evaluate(() => ({
      path: location.pathname,
      teTimeline: document.documentElement.dataset.teTimeline,
    }));
    expect('往返后回到 /home', finalState.path, '/home');
    expect('往返后宽时间线仍开启', finalState.teTimeline, 'wide');

    /* ============ 5. 页内设置面板（右下角设置按钮 + 弹窗） ============ */
    // 位置验收：按钮与 X 的 Grok 悬浮按钮同列（右缘距视口 20px），且底边落在 Grok
    // 抽屉容器上缘之上 12px（= 悬在 Grok 按钮正上方，不重叠）。抽屉在 /i/grok 等
    // 页面不渲染，那时退回配置里的固定偏移 146px（= 79 + 55 + 12）。
    const fabState = await page.evaluate(() => {
      const fab = document.querySelector('.te-settings-fab');
      const drawer = document.querySelector('[data-testid="GrokDrawer"]');
      const grokBtn = document.querySelector('[data-testid="GrokDrawerHeader"]');
      const box = (el) => (el && el.getClientRects().length ? el.getBoundingClientRect() : null);
      const icon = (el) => {
        const svg = el?.querySelector('svg');
        const r = svg ? svg.getBoundingClientRect() : null;
        return r && r.width > 0 ? Math.round(r.width) : -1;
      };
      const fabBox = box(fab);
      const drawerBox = box(drawer);
      const grokBox = box(grokBtn);
      // 收起态的 Grok 按钮才是那个 55×55 的悬浮按钮；抽屉展开时同一 testid 是整条 350 宽的头
      const grokIsButton =
        !!grokBtn && grokBtn.tagName === 'BUTTON' && !!grokBox && Math.abs(grokBox.width - grokBox.height) <= 1;
      return {
        hasFab: !!fab,
        hasDialog: !!document.querySelector('.te-settings-dialog'),
        fab: fabBox && {
          w: Math.round(fabBox.width),
          h: Math.round(fabBox.height),
          right: Math.round(window.innerWidth - fabBox.right),
          radius: getComputedStyle(fab).borderRadius,
          icon: icon(fab),
        },
        grok: grokIsButton && {
          w: Math.round(grokBox.width),
          h: Math.round(grokBox.height),
          right: Math.round(window.innerWidth - grokBox.right),
          radius: getComputedStyle(grokBtn).borderRadius,
          icon: icon(grokBtn),
        },
        gapToDrawer: fabBox && drawerBox ? Math.round(drawerBox.top - fabBox.bottom) : null,
        bottom: fab ? Math.round(Number.parseFloat(fab.style.bottom)) : -1,
      };
    });
    console.log(
      `[info] 设置按钮 ${fabState.fab?.w}×${fabState.fab?.h} 圆角 ${fabState.fab?.radius} 图标 ${fabState.fab?.icon}px；` +
        `Grok 按钮 ${fabState.grok ? `${fabState.grok.w}×${fabState.grok.h} 圆角 ${fabState.grok.radius} 图标 ${fabState.grok.icon}px` : '(无)'}`,
    );
    expect('右下角出现设置按钮', fabState.hasFab, true);
    expect('设置按钮有弹窗节点', fabState.hasDialog, true);
    expect('设置按钮与 Grok 按钮同列（右缘距视口 20px）', fabState.fab?.right, 20);
    if (fabState.grok) {
      // 用户验收点：设置按钮必须和它下方的 Grok 按钮一样大（同尺寸 / 同圆角 / 同图标）
      expect(
        '设置按钮与 Grok 按钮同尺寸',
        `${fabState.fab.w}×${fabState.fab.h}`,
        `${fabState.grok.w}×${fabState.grok.h}`,
      );
      expect('设置按钮与 Grok 按钮同圆角', fabState.fab.radius, fabState.grok.radius);
      expect('设置按钮图标与 Grok 按钮图标同大', fabState.fab.icon, fabState.grok.icon);
    } else {
      expect('无 Grok 按钮的页面用配置兜底尺寸 55×55', `${fabState.fab.w}×${fabState.fab.h}`, '55×55');
    }
    if (fabState.gapToDrawer === null) {
      expect('无 Grok 抽屉的页面用固定偏移 146px', fabState.bottom, 146);
    } else {
      expect('设置按钮底边在 Grok 抽屉上缘之上 12px（正上方、不重叠）', fabState.gapToDrawer, 12);
    }

    const opened = await page.evaluate(async () => {
      document.querySelector('.te-settings-fab').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      const overlay = document.querySelector('.te-settings-overlay');
      const dialog = document.querySelector('.te-settings-dialog');
      const box = dialog ? dialog.getBoundingClientRect() : null;
      return {
        open: overlay ? overlay.getAttribute('data-te-settings-open') : '(none)',
        display: overlay ? getComputedStyle(overlay).display : '(none)',
        rows: document.querySelectorAll('.te-settings-row').length,
        width: box ? Math.round(box.width) : -1,
        top: box ? Math.round(box.top) : -1,
      };
    });
    expect('点击设置按钮打开弹窗', opened.open, 'true');
    expect('弹窗真的显示（display:flex）', opened.display, 'flex');
    expect('弹窗里渲染出 5 个开关', opened.rows, 5);
    expect('弹窗宽度不超过 420px 且已居中', opened.width > 0 && opened.width <= 420, true);

    // 弹窗里的开关必须真的改变布局：点「显示右侧栏」→ 右栏从隐藏变可见
    const toggled = await page.evaluate(async () => {
      const sw = document.querySelector('.te-settings-row[data-te-setting="sidebar"] .te-settings-switch');
      sw.click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      const sidebar = document.querySelector('[data-testid="sidebarColumn"]');
      return {
        checked: sw.getAttribute('aria-checked'),
        teSidebar: document.documentElement.dataset.teSidebar,
        sidebarVisible: !!(sidebar && sidebar.getClientRects().length),
      };
    });
    expect('弹窗开关「显示右侧栏」→ 右栏显示', toggled.teSidebar, 'on');
    expect('右栏真的可见（有布局盒）', toggled.sidebarVisible, true);
    expect('开关状态标记与功能一致', toggled.checked, 'true');

    // Esc 关闭弹窗（面板捕获阶段处理，不惊动 X 自己的浮层），再把右栏切回隐藏
    await page.keyboard.press('Escape');
    await sleep(200);
    const closed = await page.evaluate(() => ({
      open: document.querySelector('.te-settings-overlay')?.getAttribute('data-te-settings-open'),
      expanded: document.querySelector('.te-settings-fab')?.getAttribute('aria-expanded'),
    }));
    expect('Esc 关闭弹窗', closed.open, 'false');
    expect('关闭后设置按钮标记复位', closed.expanded, 'false');
    const restored = await page.evaluate(async () => {
      document.querySelector('.te-settings-fab').click();
      await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
      document
        .querySelector('.te-settings-row[data-te-setting="sidebar"] .te-settings-switch')
        .click();
      await new Promise((resolve) => setTimeout(resolve, 400));
      return document.documentElement.dataset.teSidebar;
    });
    expect('再次点击开关把右栏切回隐藏', restored, 'off');
  } finally {
    await context.close();
  }
}

run()
  .catch((error) => {
    console.error('[e2e] 失败：', error?.message ?? error);
    results.push({ name: '脚本运行（无异常）', actual: error?.message, wanted: '无异常', ok: false });
  })
  .finally(() => {
    let failed = 0;
    for (const r of results) {
      if (!r.ok) failed += 1;
      console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}  →  实际=${String(r.actual)}`);
    }
    console.log(failed === 0 ? `\n真机 E2E 全部通过（${results.length} 项）` : `\n${failed} 项失败`);
    process.exit(failed === 0 ? 0 : 1);
  });
