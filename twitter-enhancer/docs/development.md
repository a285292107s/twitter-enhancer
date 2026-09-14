# 开发与门禁

## 命令

在 `twitter-enhancer/` 下执行：

| 命令 | 作用 |
| --- | --- |
| `npm run verify` | **交付前必跑**：`tsc` + `vite build` + jsdom 回归 `scripts/verify.mjs`，全绿才算完成 |
| `npm run build` | 只构建（`tsc && vite build`） |
| `npm run dev` | `vite build --watch`，只重建 dist 产物 |
| `npm run e2e:real` | 真机几何 E2E，见 [browser-automation.md](./browser-automation.md) |

## 新增 / 修改一个功能

1. 在 `src/features/` 下建模块，导出 `enableXxx()`；共享工具放 `src/lib/`。
2. 可调数值加进 `src/config.ts`（**不要**散落在功能文件里写魔数）。
3. 在 `src/features/index.ts` 登记。`settings-panel` 必须排最后 —— 各功能先把开关登记进
   设置注册表，面板首帧渲染才是完整列表。
4. 开关走 `src/lib/settings.ts` 的 `registerSetting()`（自动出现在页内设置面板），
   持久化走 `src/lib/store.ts` 的 `readFlag` / `writeFlag`（GM + localStorage 双写，key 前缀
   `twitter-enhancer:`，读取时 GM 优先）。toggle 后调 `notifySettingsChanged()`，
   面板据此同步 `aria-checked`。
5. 在 `scripts/verify.mjs` 补断言。**面板开关的计数与顺序是硬断言**：实例五里的
   `'五个功能共登记六个开关'` 与 `'开关顺序为 布局三项 + 内容三项'`（`data-te-setting` 顺序列表）
   每加一个开关都要同步改；新开关还要断言「在面板里点它真的改变状态」。
6. 改完跑 `npm run verify`；涉及真实布局几何的改动再跑 `npm run e2e:real`。

## 迭代与分发

**不要用 vite-plugin-monkey 的 dev 模式**（裸 `vite` / `vite dev`，或预览页里那个 `server:` 开头的
"安装"按钮）：它把 `<script type="module" src="http://127.0.0.1:5173/__vite-plugin-monkey.entry.js">`
注入页面，而 x.com 的 CSP 不含 localhost，注入被浏览器直接拦掉 —— 页面上等于没加载脚本，
控制台只剩一条 CSP violation。本地迭代就是 `npm run dev`（只重建 dist）→ 把
`dist/twitter-enhancer.user.js` 重新导入脚本管理器（手动一步，无 HMR）。

分发：构建产物交给脚本管理器（用户用脚本猫，自动同步 dist，刷新即生效）。
`grant` 由 `vite.config.ts` 声明（当前 `GM_addStyle` / `GM_getValue` / `GM_setValue`），
新增 `GM_*` 能力要同步改这里。

## 什么时候要读别的文档

- 动 DOM 观察器、路由 hook、宽度 / 布局门控 → [architecture.md](./architecture.md)
- 动列宽、媒体钳制、推文与设置面板外观 / 尺寸 → [design-notes.md](./design-notes.md)
- 需要浏览器里验证或修登录态 → [browser-automation.md](./browser-automation.md)

## 硬编码来源

新增选择器优先用 `data-testid`，其次是稳定 `aria-*` / `role`；绝不用 `css-xxxx` 这类哈希 class
（X 每次发版都换）。任何从真机量出来的数值（宽度、间距、时长）都要在注释里写明「实测 + 日期」，
来源和分析结论进 `docs/design-notes.md`、`docs/architecture.md` 或源码头部注释，别只留在对话里。
