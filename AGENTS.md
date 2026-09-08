# AGENTS.md — 仓库协作约定

> 本文件写给所有在此仓库工作的 agent。中文为主（与仓库注释语言一致）。
> 规则按优先级排序：**浏览器自动化铁律 > 代码门禁 > 风格/文档**。

---

## 1. 项目是什么

- **twitter-enhancer**：油猴脚本（vite + vite-plugin-monkey + TS），优化 x.com 网页。
  源码在 `twitter-enhancer/src/`，构建产物 `twitter-enhancer/dist/twitter-enhancer.user.js`。
- 主要功能：宽时间线（主列 600→800）、推文 UI 重设计、右栏搜索迁移、媒体高度钳制
  （`media-cap`：宽列下超高轮播/竖图缩到一屏内，只改 layout height、链式压纯媒体祖先）。

## 2. 代码门禁（改代码前先读）

- 回归门禁：在 `twitter-enhancer/` 下运行 **`npm run verify`**（= `tsc && vite build` + jsdom 回归 `scripts/verify.mjs`），提交/交付前必须全绿。
- 新增功能必须注册进 `src/features/index.ts` 并**在 `verify.mjs` 补断言**（含菜单数量：每个带菜单开关的功能都会 +1）。
- 菜单/存储：开关经 `src/lib/menu.ts`（GM 菜单，label 带状态文案）与 `src/lib/store.ts`
  （GM+localStorage 双写，key 前缀 `twitter-enhancer:`）。
- 不要硬编码 X 的哈希 class（css-xxxx）；选择器锚定 `data-testid` 等稳定属性。
- 大版本重构删除旧功能时，同步清理 `config.ts` / `index.ts` / `verify.mjs` 中对应引用。

## 3. 浏览器自动化 —— 铁律（优先级最高）

### 为什么

之前用 **kimi-webbridge 驱动用户的主 Chrome**：打开/滚动标签会**抢用户控制权**；
而且**后台标签页会被浏览器冻结**（rAF 全停、定时器被压到 1s 甚至 1/min），长循环探测会超时。

### 规则

1. **默认禁止**用 kimi-webbridge / 用户主浏览器做任何自动化（导航、滚动、长探测）。
2. **一律使用本地 playwright-cli 的独立环境**（见下）。它 headless、有自己的 profile、
   不碰用户浏览器、不影响用户当前工作。
3. kimi-webbridge 仅允许两种用途：
   - **一次性 cookie 迁移**（把用户已登录的 x.com 会话导入独立 profile，见「一次性登录」）；
   - 用户**明确要求**看"当前正在浏览的页面"做诊断——此时用短批量探测、用完即走、
     不滚动长列表、不开一串新标签，并在结束后询问是否关闭相关标签。
4. 探测纪律：单次 evaluate 批量收集 → 立刻还原页面样式 → 不搞长循环；需要"前台真实
   行为"（如登录、滚轮手感）时，先请用户把对应窗口切到前台再动手。

### 独立环境（已就绪）

- CLI：全局 `playwright-cli`（`npx --no-install playwright cli` 亦可用）。
- 专用持久会话：**`x-te`**，user-data-dir = `browser-profiles/x-te`（仓库根，已 gitignore，存放登录态，勿提交）。
- 运行方式 headless（`list` 显示 `headed: false`），不抢焦点；浏览器内核已在本地缓存。

常用命令（都在仓库根执行，会话名恒为 `x-te`）：

```powershell
# 打开（复用持久登录态；已开着会直接复用）
playwright-cli -s=x-te open https://x.com --persistent --profile="$PWD\browser-profiles\x-te"
# 导航 / 读页面 / 执行 JS（批量、短）
playwright-cli -s=x-te goto https://x.com/i/history/likes
playwright-cli -s=x-te --raw eval "document.title"
playwright-cli -s=x-te eval "JSON.stringify(...)"          # 大 JSON 用 --raw + 文件
playwright-cli -s=x-te snapshot
# 结束探测：关闭会话（保留 profile，登录态不丢）
playwright-cli -s=x-te close
# 查看会话 / 彻底删 profile
playwright-cli -s=x-te list
playwright-cli -s=x-te delete-data
```

> 每次开 `open` 会新起一个进程；`close` 后再次 `open` 复用一个 profile，登录态仍在。
> 常用验证链路：改 `media-cap` → `npm run verify`（jsdom 回归）→ 真机 DOM 几何验证走 `x-te`
> （需要登录态且 x.com 布局以登录为准）。

#### 真机 E2E（自动注入 dist 产物，替代手动探测几何）

`playwright-cli` 没有 addInitScript / 扩展通道，几何断言无法自动化。仓库提供
`twitter-enhancer/scripts/e2e-real.mjs`（方案 B，2026-09 引入）：直接驱动全局
`@playwright/cli` 内置的 playwright 模块 + 缓存内核，headless 起独立持久 profile
`browser-profiles/x-te-e2e`（已 gitignore），用 addInitScript 在 document-start 时序
**先注入 `scripts/e2e/gm-shim.js`（只补 GM_addStyle，见文件头注释）再注入
`dist/twitter-enhancer.user.js`**，然后断言真实布局几何（宽列 800 / 右栏隐藏 /
Alt+B 切换 / 媒体钳制与解锁）。

```powershell
# 先构建，再跑（登录态自动从仓库根 auth.json 导入；之后随 profile 持久化）
cd twitter-enhancer
npm run verify
npm run e2e:real
```

- 覆盖/不覆盖：能验真实布局引擎下的几何、结构兼容与 document-start 时序；
  **不覆盖油猴菜单 UI 与真 GM_* 语义**（有意只 shim GM_addStyle，其余走仓库
  localStorage / no-op 降级路径）。发布冒烟仍需装一次真 Tampermonkey。
- 浏览器铁律同 `x-te`：headless、独立 profile、不碰用户浏览器。脚本依赖全局
  `@playwright/cli`，迁移机器时需改 `resolvePlaywright()`。

### 一次性登录（已完成 —— 保持可用的维护说明）

状态：仓库根的 `auth.json`（Playwright storageState，含 `auth_token`/`ct0`/`twid`，**已 gitignore**）
已通过 `playwright-cli -s=x-te state-load` 导入，登录态持久化在 `browser-profiles/x-te/`，
`close` 后重开依然有效（已实测）。

- **Cookie 保护说明**：Chrome 的应用绑定加密只拦"直接拷贝 profile 数据库文件"；
  浏览器级导出（CDP / storageState）拿到的已是解密明文，再经 playwright `state-load`/
  `cookie-set` 由浏览器本体写回，迁移可靠。
- **会话过期维护**：若 `x-te` 里 x.com 掉登录，请用户重新导出登录态再导入——
  两种来源均可：
  1. Playwright storageState 文件（形如当前 `auth.json`：`{cookies:[...], origins:[...]}`），
     命令：`playwright-cli -s=x-te state-load <path>`；
  2. kimi-webbridge CDP 读 cookies（`Network.getAllCookies`，一次性只读、需用户同意）逐个
     `cookie-set`。
  导入后验证：`x-te` 里 goto x.com/home，应无 `loginButton` 且出现 `primaryColumn`。

## 4. 媒体钳制（media-cap）关键结论（防重复踩坑）

- X 单图竖长图**自带**约 ≤510px 高度钳制，不需要处理；
- 真失控的是**多图横向轮播的竖长行**：800 宽列下实测行高 774~898px。
- X 轮播格带内联 `aspect-ratio`，**只把行 layout height 压到预算**（min(540, 视口高−220)），
  格子会自动等比重排（比例不变、不裁剪、scroll-snap 正常）。
- **不要**再叠加 `transform: scale` —— 与 height 一起会造成 `原高×k²` 双重缩小（likes 页踩过）。
- 冗余空白来自宿主之上的纯媒体包裹祖先链，其中可能有 **`padding-bottom: calc(…%)` 比例盒**
  （高度 = 宽×组内比例，与格子无关）：链式把整条纯媒体祖先压到预算，比例盒 padding 归零
  （原值记录在 WeakMap，解锁还原）。爬升边界：到 `article`/`cellInnerDiv`/`primaryColumn` 停，
  含 `tweetText` 或操作栏 testid 即停。

## 5. 文档与注释

- 新文件/关键逻辑写中文注释，注明"实测数值/结构"出处与版本时间（如 `2026-09`）。
- 分析结论如果进仓库，放在 `twitter-enhancer/design-system/` 或源码头部注释，别只留在对话里。
- 涉及登录态/隐私的路径（`browser-profiles/`、`.workbuddy/`、`.agents/`）永不提交。
