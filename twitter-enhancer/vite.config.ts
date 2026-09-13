import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

// 不要用 vite-plugin-monkey 的 dev 模式（裸 `vite` / `vite dev`）迭代本脚本：
// 它会把 `http://127.0.0.1:5173/__vite-plugin-monkey.entry.js` 以 <script type="module">
// 注入页面，而 x.com 的 CSP（`script-src` 不含 localhost）会直接拦掉这条注入，
// 页面上等于没加载脚本，控制台只会留一条 CSP violation（2026-09 实测）。
// 迭代流程：`npm run dev`（= vite build --watch）→ 重新导入 dist/twitter-enhancer.user.js。
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
        version: '0.0.3',
        description: '推特（X）网页体验优化：宽时间线、推文新样式、页内设置面板',
        author: 'twitter-enhancer',
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
