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
 * 1. 功能激活：宽列 800 / 右栏隐藏 / 行居中 / 导航条搜索框 / tweet-ui 令牌；
 * 2. 真实键盘监听：Alt+B 双向切换右栏显隐；
 * 3. 媒体钳制机制：注入超高媒体行 → rAF 帧任务钳到预算高度；回落后宿主粒度解锁。
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
    const initScript = `${shimSource}
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
      return {
        teTimeline: root.dataset.teTimeline,
        primaryW: primary ? parseFloat(cs(primary, 'width')) : 0,
        teSidebar: root.dataset.teSidebar,
        sidebarDisplay: sidebar ? cs(sidebar, 'display') : '(none)',
        rowJustify: row ? cs(row, 'justifyContent') : '',
        teSearch: root.dataset.teSearch,
        hasNavInput: !!document.querySelector('.te-search-host input[type="search"]'),
        teUi: root.dataset.teUi,
        teTheme: root.dataset.teTheme,
        bodySize: root.style.getPropertyValue('--te-body-size').trim(),
        lh: root.style.getPropertyValue('--te-body-lh').trim(),
        measure: root.style.getPropertyValue('--te-measure').trim(),
        teRowData: row?.dataset.teRow ?? '',
      };
    });
    expect('宽时间线已激活（data-te-timeline=wide）', activation.teTimeline, 'wide');
    const wideOk = activation.primaryW >= 780 && activation.primaryW <= 802;
    console.log(`[info] 主列实测宽度 = ${activation.primaryW}px`);
    expect('主列宽度被放宽到 800（±2）', wideOk, true);
    expect('右栏默认隐藏（data-te-sidebar=off）', activation.teSidebar, 'off');
    expect('右栏计算样式为 display:none', activation.sidebarDisplay, 'none');
    expect('右栏隐藏后行居中补偿（justify-content:center）', activation.rowJustify, 'center');
    expect('导航条搜索框默认开启', activation.teSearch, 'on');
    expect('左栏已挂载自建搜索输入框', activation.hasNavInput, true);
    expect('推文 UI 默认开启', activation.teUi, 'on');
    expect('主题已检测并写入', ['light', 'dim', 'dark'].includes(activation.teTheme), true);
    expect('字号令牌 16px', activation.bodySize, '16px');
    expect('行高令牌 1.5', activation.lh, '1.5');
    expect('行长令牌 72ch', activation.measure, '72ch');
    expect('三栏行已被撑开（data-te-row=1）', activation.teRowData, '1');

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
      const row = document.querySelector('[data-testid="primaryColumn"]')?.parentElement;
      return {
        teSidebar: document.documentElement.dataset.teSidebar,
        display: s ? getComputedStyle(s).display : '(none)',
        rowJustify: row ? getComputedStyle(row).justifyContent : '',
      };
    });
    expect('Alt+B → 右栏显示（data-te-sidebar=on）', afterOn.teSidebar, 'on');
    expect('Alt+B 后右栏可见', afterOn.display === 'none' ? 'none' : 'visible', 'visible');
    expect('右栏显示后行改左对齐锚定', afterOn.rowJustify, 'flex-start');
    await pressAltB();
    await sleep(300);
    const afterOff = await page.evaluate(() => document.documentElement.dataset.teSidebar);
    expect('再次 Alt+B → 右栏隐藏', afterOff, 'off');

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
