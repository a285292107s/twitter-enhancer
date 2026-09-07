import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

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
        version: '0.0.2',
        description: '推特（X）网页体验优化：时间线列宽调整等',
        author: 'twitter-enhancer',
        match: [
          'https://x.com/*',
          'https://www.x.com/*',
          'https://twitter.com/*',
          'https://www.twitter.com/*',
          'https://mobile.twitter.com/*',
        ],
        'run-at': 'document-start',
        grant: [
          'GM_addStyle',
          'GM_getValue',
          'GM_setValue',
          'GM_registerMenuCommand',
          'GM_unregisterMenuCommand',
        ],
        noframes: true,
      },
    }),
  ],
});
