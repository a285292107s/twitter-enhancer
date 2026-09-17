# AGENTS.md

**twitter-enhancer**：优化 x.com 网页体验的油猴脚本（Vite + vite-plugin-monkey + TS，中文注释）。
源码 `twitter-enhancer/src/`，产物 `twitter-enhancer/dist/twitter-enhancer.user.js`，包管理器 **npm**（图标 / 私信 / 媒体高度 / 内容列排版 / 主题令牌）。

## 红线

- 改代码后必须 `cd twitter-enhancer && npm run verify` 全绿（`tsc` + 构建 + jsdom 回归），
  新增功能同时在 `scripts/verify.mjs` 补断言 —— 细节见 `twitter-enhancer/docs/development.md`。
- **浏览器操作一律走本地 playwright-cli 的 headless 独立环境，绝不碰用户自己的浏览器。**
  kimi-webbridge 只允许两种情况：一次性 cookie 迁移；用户明确要求看"当前正在浏览的页面"。
  完整规则与登录态维护见 `twitter-enhancer/docs/browser-automation.md`。
- 不要硬编码 X 的哈希 class（`css-xxxx`）；选择器锚定 `data-testid` 等稳定属性。
- 开关一律登记进页内设置面板（`registerSetting`），**不要**往油猴菜单挂（`grant` 里已无
  `GM_registerMenuCommand`）；状态经 `lib/store` 双写。
- `browser-profiles/`、`auth*.json`、`.workbuddy/`、`.agents/` 永不提交。

## 按需阅读

| 什么时候读 | 文档 |
| --- | --- |
| 要用浏览器验证 / 处理登录态 | `twitter-enhancer/docs/browser-automation.md` |
| 改功能、加开关、跑门禁、发版 | `twitter-enhancer/docs/development.md` |
| 动 DOM 观察、路由 / 页面类型 / 时间线包装层、宽度 / 布局门控 | `twitter-enhancer/docs/architecture.md` |
| 改列宽、媒体钳制、推文与设置面板外观 | `twitter-enhancer/docs/design-notes.md` |
| 改内容列排版（版心 / 焦点帖 / 轮播序号 / 单图等比） | `twitter-enhancer/docs/content-column-design.md` |
