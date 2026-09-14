# 浏览器自动化

本项目所有浏览器验证都在**本地 playwright-cli 的独立环境**里做。铁律只有一句：
**不要用 kimi-webbridge 或用户自己的浏览器做自动化。**

## 为什么

早期用 kimi-webbridge 驱动用户的主 Chrome：打开 / 滚动标签会**抢用户控制权**；后台标签页还会被
浏览器冻结（rAF 全停、定时器被压到 1s 甚至 1/min），长循环探测必然超时、结论不可信。

## 独立环境（已就绪，勿重建）

- CLI：全局 `playwright-cli`（`npx --no-install playwright cli` 亦可用）。
- 持久会话：**`x-te`**，`user-data-dir = browser-profiles/x-te`（仓库根，已 gitignore，含登录态）。
- headless 运行（`list` 显示 `headed: false`），不抢焦点；内核已在本地缓存。

以下命令都在**仓库根**执行，会话名恒为 `x-te`：

```powershell
# 打开（复用持久登录态；已开着会直接复用）
playwright-cli -s=x-te open https://x.com --persistent --profile="$PWD\browser-profiles\x-te"
# 导航 / 读页面 / 执行 JS
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

> `open` 每次新起一个进程；`close` 后再 `open` 复用同一个 profile，登录态仍在。

**探测纪律**：单次 `eval` 批量收集 → 立刻还原页面样式 → 不搞长循环（超长 eval 会让 CLI 超时无响应）。
需要「前台真实行为」（登录、滚轮手感、窗口尺寸）时，先请用户把对应窗口切到前台再动手；窗口最小化时
`innerWidth=0`、几何全是 0，这时得出的结论无效。

## 真机 E2E（自动注入 dist 产物，替代手动探测几何）

`playwright-cli` 没有 addInitScript / 扩展通道，几何断言无法经它自动化。`scripts/e2e-real.mjs`
直接驱动全局 `@playwright/cli` 内置的 playwright 模块 + 缓存内核，headless 起独立持久 profile
`browser-profiles/x-te-e2e`（已 gitignore），用 addInitScript 在 document-start 时序**先注入
`scripts/e2e/gm-shim.js`（只补 `GM_addStyle`，原因见文件头注释）再注入 dist 产物**，然后断言真实
布局几何：右栏隐藏时主列铺满内容区 980 / 左缘不动 / Alt+B 切换右栏 / 媒体钳制与解锁 /
home↔grok 切 tab 逐帧零布局变化 / 设置按钮落在 Grok 悬浮按钮正上方且弹窗开关真的改变布局。

```powershell
cd twitter-enhancer
npm run verify      # 先构建，本脚本读 dist 产物
npm run e2e:real
```

- 覆盖：真实布局引擎下的几何、与当前 X DOM 的结构兼容性、document-start 时序。
- **不覆盖真 `GM_*` 语义**：有意只 shim `GM_addStyle`，其余走仓库 localStorage / no-op 降级路径
  （`src/lib/store.ts` 的 `GM_*` 未定义时自动回落，与 jsdom 回归一致）。发布冒烟仍需人工装一次真 Tampermonkey。
- 浏览器铁律同 `x-te`。脚本依赖全局 `@playwright/cli` 与 `ms-playwright` 缓存内核，
  迁移机器时要改 `resolvePlaywright()` / `resolveExecutable()`（也可用 `TE_E2E_EXECUTABLE` 指定内核）。

## 登录态维护

状态：仓库根 `auth.json`（Playwright storageState，含 `auth_token`/`ct0`/`twid`，**已 gitignore**）
已通过 `playwright-cli -s=x-te state-load` 导入，登录态持久化在 `browser-profiles/x-te/`，
`close` 后重开依然有效（已实测）。

**为什么可以这样迁移**：Chrome 的应用绑定加密只拦「直接拷贝 profile 数据库文件」；浏览器级导出
（CDP / storageState）拿到的已是解密明文，再经 playwright `state-load` / `cookie-set` 由浏览器本体
写回，迁移可靠。

**会话过期时**（`x-te` 里 x.com 掉登录）请用户重新导出登录态，两种来源均可：

1. Playwright storageState 文件（形如 `auth.json`：`{cookies:[...], origins:[...]}`）→
   `playwright-cli -s=x-te state-load <path>`；
2. kimi-webbridge CDP 读 cookies（`Network.getAllCookies`，**一次性只读、需用户同意**）→ 逐个 `cookie-set`。

导入后验证：`x-te` 里 `goto https://x.com/home`，应**无 `loginButton`** 且出现 `primaryColumn`。
