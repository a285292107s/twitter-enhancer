import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

// 不要用 vite-plugin-monkey 的 dev 模式（裸 `vite` / `vite dev`）迭代本脚本：
// 它会把 `http://127.0.0.1:5173/__vite-plugin-monkey.entry.js` 以 <script type="module">
// 注入页面，而 x.com 的 CSP（`script-src` 不含 localhost）会直接拦掉这条注入，
// 页面上等于没加载脚本，控制台只会留一条 CSP violation（2026-09 实测）。
// 迭代流程：`npm run dev`（= vite build --watch）→ 重新导入 dist/twitter-enhancer.user.js。

// 产物的在线地址（raw 直链）：`@updateURL` / `@downloadURL` 都用它，README「安装」一节
// 给用户的也是这个地址。三处指的是同一份**已入库的** dist，改仓库名 / 路径要一起改，
// 否则在线安装的用户要么检查更新 404，要么被指到别处（见 docs/development.md「发版」）。
const RAW_DIST =
  'https://raw.githubusercontent.com/a285292107s/twitter-enhancer/master/twitter-enhancer/dist/twitter-enhancer.user.js';
const REPO_URL = 'https://github.com/a285292107s/twitter-enhancer';

/**
 * 脚本图标：`assets/icon.svg`（唯一真源）→ base64 data URI，构建时内联进产物头部的 `@icon`。
 *
 * 为什么内联而不是指向一条 raw 直链：`@icon` 写 URL 时，脚本管理器会在安装 / 检查更新时
 * 去取它一次 —— 那是脚本自身行为之外的一次网络行为，而 README 承诺「纯本地运行、
 * 没有任何网络请求」。data URI 让产物自包含：离线安装也有图标，也不会因为 CDN 401 / 抖动
 * 退化成默认图标。
 *
 * 为什么是 base64 而不是 `data:image/svg+xml;utf8,<svg ...>`：后者在 Violentmonkey 2.27
 * 被 URL 校验判成非法（violentmonkey#2214，同年修），base64 形式没有这个坑。
 *
 * 编码前剥掉 XML 注释、折叠标签间空白：源文件里的说明是写给人看的，不该占头部字节
 * （整份 SVG 直编会带进 1.4KB 的注释）。`scripts/verify.mjs` 有一条断言锁住
 * 「产物里的图标 = assets/icon.svg 的图形部分」，改了两边对不上会红。
 */
function readIcon(): string {
  // 配置文件被 Vite 打包后 import.meta.url 仍指向项目内（同目录），
  // cwd 兜底覆盖「从别处 --config 指过来」的跑法；两者都找不到时 readFileSync 会直接报错。
  const fromConfig = resolve(dirname(fileURLToPath(import.meta.url)), 'assets/icon.svg');
  const file = existsSync(fromConfig) ? fromConfig : resolve(process.cwd(), 'assets/icon.svg');
  const svg = readFileSync(file, 'utf8')
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/>\s+</g, '><')
    .trim();
  return `data:image/svg+xml;base64,${Buffer.from(svg, 'utf8').toString('base64')}`;
}

// https://vitejs.dev/config/
export default defineConfig({
  // 保留 min-width 写法，避免压缩成 (width>=...) 的较新媒体查询语法，
  // 保证稍旧版本的浏览器 / 脚本管理器也能生效。
  build: { cssTarget: 'chrome100' },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: 'Twitter / X 页面优化',
        namespace: 'twitter-enhancer',
        version: '0.0.6',
        // 这一行是用户在脚本管理器列表里看到的全部说明，功能集变了要跟着改
        description:
          '推特（X）网页体验优化：宽时间线 / 媒体高度钳制与单图等比 / 内容列排版（版心、焦点帖、轮播序号）/ 右侧栏显隐，开关在页内右下角设置面板',
        author: 'twitter-enhancer',
        // 图标：assets/icon.svg 内联成 data URI（见上面的 readIcon 注释）。
        // 默认图标是「什么都没有」的白纸，用户在管理器列表里认不出这个脚本。
        icon: readIcon(),
        // 与仓库根的 LICENSE 同源：许可证要跟着产物走 —— 用户拿到的是一份 .user.js，
        // 不是这个仓库，再分发时这条注释就是他的许可依据
        license: 'MIT',
        // 没有这两行时，脚本管理器只能拿「安装地址」当更新源：手动粘贴安装的用户永远
        // 收不到更新，换过安装地址的老用户也会断在旧地址上。`@updateURL` 是要检查的
        // 元数据，`@downloadURL` 是确认有新版本后取整份脚本的地方，都指向同一份产物。
        updateURL: RAW_DIST,
        downloadURL: RAW_DIST,
        supportURL: `${REPO_URL}/issues`,
        homepageURL: REPO_URL,
        match: [
          'https://x.com/*',
          'https://www.x.com/*',
          'https://twitter.com/*',
          'https://www.twitter.com/*',
          'https://mobile.twitter.com/*',
        ],
        'run-at': 'document-start',
        // 开关已从油猴菜单搬进页内设置面板（右下角设置按钮），不再需要菜单 API
        grant: ['GM_addStyle', 'GM_getValue', 'GM_setValue'],
        noframes: true,
      },
    }),
  ],
});
