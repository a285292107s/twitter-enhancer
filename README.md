# Twitter / X 页面优化（油猴脚本）

把 x.com 的时间线放宽、把推文排版理顺、把一屏放不下的超高媒体压回一屏。

**纯本地运行**：没有任何网络请求、没有统计埋点，只改页面的 DOM 和本机存储。开关都在页面里
（右下角设置按钮），随时可以逐个关掉对比效果。

## 功能

| 分组 | 开关 | 默认 | 作用 |
| --- | --- | --- | --- |
| 布局 | 宽时间线 | 开 | 主列铺满 X 的内容区（右栏显示时最多放宽到 800px），列宽从 600 → 980 |
| 布局 | 显示右侧栏 | 关 | 关掉后隐藏右栏，把横向空间让给主列；右栏显示时把它钉在主列右侧 30px |
| 布局 | 导航条搜索框 | 开 | 在左栏 logo 右侧放一个搜索框（回车跳搜索页），右栏隐藏后也能搜索；`/` 键聚焦它 |
| 内容 | 推文新样式 | 开 | 正文 16px / 行高 1.5 / 版心 72ch，重绘操作栏、引用卡片与媒体圆角；跟随 Light / Dim / Dark 三套主题 |
| 内容 | 媒体高度钳制 | 开 | 宽列下超高竖图 / 多图轮播按视口高度压到一屏内，不再需要滚动看完整张图 |
| 内容 | 单图等比 | 开 | 超预算的单图按原图比例缩到预算内并居中（不裁切、不压扁、不留黑边） |
| 内容 | 内容列排版 | 开 | 正文按内容分层（emoji / 短句 / 长文）、操作栏收进版心、焦点帖加结构分隔、多图轮播带 `3/4` 序号 |

页内快捷键：`Alt+U` 开关推文新样式，`Alt+B` 开关右侧栏（用来即时对比前后效果）。

设置即时生效并保存在本机：脚本管理器存储与 `localStorage` **双写**（换浏览器 / 清掉存储即恢复默认）。

## 安装

**前提**：桌面版 Chrome / Edge / Firefox + 一个脚本管理器
（[Tampermonkey 篡改猴](https://www.tampermonkey.net/) 或 [ScriptCat 脚本猫](https://scriptcat.org/)）。

### 在线安装（推荐）

打开这个地址，脚本管理器会弹出安装页，点「安装」即可：

```
https://raw.githubusercontent.com/a285292107s/twitter-enhancer/master/twitter-enhancer/dist/twitter-enhancer.user.js
```

然后打开 <https://x.com/home>。从在线地址安装的，脚本管理器会按这个地址检查更新
（后续修复能自动到手）；需要手动更新时重新打开上面的地址覆盖安装即可。

### 手动安装

1. 从仓库下载 [`twitter-enhancer/dist/twitter-enhancer.user.js`](./twitter-enhancer/dist/twitter-enhancer.user.js)；
2. 脚本管理器 → 新建脚本 → 把文件内容整体粘贴进去 → 保存；
3. 打开 <https://x.com/home>。

> 手动粘贴安装的**不会自动更新**（脚本管理器不知道更新源），需要重新下载覆盖。

## 生效范围与已知取舍

这些是实测后有意留下的边界，不是缺陷：

- **只改 X 自己渲染三栏的页面**（首页 / 个人主页 / 详情页 / 搜索 / 通知 / 探索）。
  `/i/grok`（X 自己的单栏版，原生 980px）与 X Chat 私信（原生双栏 1187px）**一律交回 X 原生**，
  不强行套用宽列。
- **视口窄于 1095px 时不动宽度**（这是 X 自己的断点），保持 X 原生布局。
- **不搬动 React 管理的节点**：所有排版改动都用 CSS + 属性完成，不把头像 / 正文 / 媒体
  搬进自建卡片壳。代价是「跨层级的大幅重排」这类改法在本项目里做不到 —— 这是有意的取舍，
  因为搬动之后没有便宜的还原路径，开关一关就是一地半拆的树。
- **不写左导航条的任何样式**：X 自己的定位已经与主列左缘对齐，覆盖它只会让不同页面走两套摆放机制。
- 媒体钳制会**测量视口高度**来定预算，所以「一屏能看全」在小屏上是有上限的取舍：
  X 原生 600 宽列下的轮播行高是 650，900 视口下要给到那个高度，操作栏就会出屏。

## 隐私

- `@grant` 只用 `GM_addStyle` / `GM_getValue` / `GM_setValue`，没有 `GM_xmlhttpRequest`；
  **脚本自身不发起任何网络请求**，也不上报任何数据。
- 唯一的网络行为是你自己触发的：在自建搜索框里回车会跳到 `https://x.com/search?q=...`。
- 设置只写在本机两处（脚本管理器存储 + 该站点的 `localStorage`），键名统一带
  `twitter-enhancer:` 前缀，手动删掉即恢复默认。

## 开发

技术栈：Vite + [vite-plugin-monkey](https://github.com/lisonge/vite-plugin-monkey) + TypeScript，
源码与注释均为中文。产物 `twitter-enhancer/dist/twitter-enhancer.user.js` 是**入库**的
（脚本管理器可以直接同步它）。

```bash
cd twitter-enhancer
npm install
npm run verify      # 交付前必跑：tsc + 构建 + jsdom 回归（310 项）
npm run dev         # 只重建 dist（vite build --watch）
npm run e2e:real    # 真机几何 E2E：headless 独立 profile 打开真实 x.com（89 项）
```

> **不要**用 `vite` / `vite dev` 的开发模式迭代：它注入的 `<script type="module" src="http://127.0.0.1:5173/...">`
> 会被 x.com 的 CSP 直接拦掉，页面上等于没加载脚本。

门禁有三层，各管一件事：

| 层 | 覆盖 | 命令 |
| --- | --- | --- |
| 类型 + 构建 | `tsc` 严格模式（`noUnusedLocals` 等）+ 打包 | `npm run verify` |
| jsdom 回归 | 页面类型分类、等待器、时间线包装层、宽度解锁、媒体钳制、内容列排版、设置面板契约（310 项） | 同上 |
| 真机几何 E2E | 真实布局引擎 + 当前 x.com DOM：列宽几何、SPA 切换零布局抖动、媒体钳制、版心（89 项） | `npm run e2e:real` |

**注意夹具的边界**：jsdom 回归跑的是我们自己的夹具，X 改版它一条都不会红 —— 能发现
「X 改版导致功能静默失效」的只有真机 E2E。仓库自带
`scripts/e2e-scheduled.ps1` + 一个每周运行的 Windows 计划任务来做这件事，日志在
`browser-profiles/e2e-logs/`。另外 `scripts/audit-subscriptions.mjs` 可以回答
「某条事件接线到底被测到了没有」。

改代码之前请先读：

| 文档 | 什么时候读 |
| --- | --- |
| [`AGENTS.md`](./AGENTS.md) | 仓库约定与红线（红线：改完必须 `npm run verify` 全绿；浏览器操作一律走 headless 独立环境；不硬编码 X 的哈希 class；开关一律登记进页内设置面板） |
| [`twitter-enhancer/docs/architecture.md`](./twitter-enhancer/docs/architecture.md) | 动 DOM 观察器、路由 / 页面类型 / 时间线包装层、宽度与布局门控 |
| [`twitter-enhancer/docs/development.md`](./twitter-enhancer/docs/development.md) | 加功能、加开关、跑门禁、发版 |
| [`twitter-enhancer/docs/design-notes.md`](./twitter-enhancer/docs/design-notes.md) | 列宽、媒体钳制、推文与设置面板外观（取值都带实测日期） |
| [`twitter-enhancer/docs/content-column-design.md`](./twitter-enhancer/docs/content-column-design.md) | 内容列排版（版心 / 内容语义 / 焦点帖 / 单图等比） |
| [`twitter-enhancer/docs/browser-automation.md`](./twitter-enhancer/docs/browser-automation.md) | 要用浏览器验证、处理登录态、或看定时漂移探测怎么跑 |

## 致谢

架构上参考了社区里维护得最好的同类实现
[control-panel-for-twitter](https://github.com/insin/control-panel-for-twitter) 的写法
（观察器 / 等待器 / 页面类型 / 选择器注册表），取舍按本项目的实测结论重做过，
差异逐条记在 `docs/architecture.md`。
