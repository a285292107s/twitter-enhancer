# 开发与门禁

## 命令

在 `twitter-enhancer/` 下执行：

| 命令 | 作用 |
| --- | --- |
| `npm run verify` | **交付前必跑**：`tsc` + `vite build` + jsdom 回归 `scripts/verify.mjs`，全绿才算完成 |
| `npm run build` | 只构建（`tsc && vite build`） |
| `npm run dev` | `vite build --watch`，只重建 dist 产物 |
| `npm run e2e:real` | 真机几何 E2E，见 [browser-automation.md](./browser-automation.md) |
| `scripts/e2e-scheduled.ps1` | 计划任务调用的包装（verify + e2e + 日志与失败标记），同一文档 |
| `node scripts/audit-subscriptions.mjs` | 逐条摘掉事件订阅、看门禁是否变红（回答「这条接线被测到了吗」，见下「夹具的已知边界」） |

## 新增 / 修改一个功能

1. 在 `src/features/` 下建模块，导出 `enableXxx()`；共享工具放 `src/lib/`。
   先看 `src/lib/` 里有没有能用的地基（下表），别自己再造一遍：

   | 要干的事 | 用哪个 |
   | --- | --- |
   | 判断「现在在哪一页」（Home / Profile / Status / Chat …） | `lib/page.ts` 的 `currentPageKind()` / `onPageKindChanged()` / `pagePathChanged()` |
   | 等 X 的某个元素出现（路由切走就放弃） | `lib/wait-for.ts` 的 `waitFor` / `waitForElement`（**必须给 `stopIf: pagePathChanged(path)`**） |
   | 观察具体节点（属性变化 / ResizeObserver） | 自己 `new` 并管好生命周期；**目标可能被 X 替换时必须能重新绑定**（三个现成形态：`media-cap` 的宿主 RO、`unlock-width` 的列容器 RO、`settings-panel` 的抽屉 RO） |
   | 知道时间线出现 / 被整层替换（标签页切换） | `lib/timeline.ts` 的 `onTimelineChanged()` |
   | 要一个 X 的选择器 | `lib/selectors.ts` 登记后引用，**不要**在功能里写字面量 |
   | 加一个可持久化的开关 | `lib/toggle.ts` 的 `createToggle()`（面板行 / 存储 / 首帧渲染 / 广播一起包掉） |
   | 读另一个功能的门控状态（宽列是否生效、右栏是否被隐藏） | `lib/gate.ts`；**不要**自己读写 `html[data-te-*]` 字面量 |
   | 把一批 DOM 变更引起的测量 / 写样式推迟到下一帧 | `lib/frame-work.ts` 的 `createFrameQueue()`（同帧合并 + 无 rAF 时的回退） |
   | 取值来自 CONFIG 的 CSS 规则 | `lib/style-sheet.ts` 的 `createStyleSheet()`（判据见 architecture.md「样式放在哪」） |
2. 可调数值加进 `src/config.ts`（**不要**散落在功能文件里写魔数 —— 门槛值也算，
   例如「主列宽到多少才算宽列真的生效」在 `CONFIG.media.minActiveColumnWidth`）。
3. 在 `src/features/index.ts` 登记。`settings-panel` 必须排最后 —— 各功能先把开关登记进
   设置注册表，面板首帧渲染才是完整列表。
4. 开关走 `src/lib/toggle.ts` 的 `createToggle()`：它把「默认值 → 首帧渲染 → 面板登记 →
   异步读取存储覆盖 → 写盘 → 广播面板刷新」包成一条协议，功能只提供一个 `apply(值)`。
   存储仍走 `src/lib/store.ts`（GM + localStorage 双写，key 前缀 `twitter-enhancer:`，
   key 默认等于开关 id）。**不要**再手写 `registerSetting` + `readFlag` 那一套 ——
   七个开关各抄一遍时，「协议」只存在于七份副本里（见 lib/toggle.ts 文件头）。
5. 在 `scripts/verify.mjs` 补断言。夹具在 `scripts/harness.mjs`（jsdom 布局补偿的桩、实测几何、
   会话辅助、结果收集与输出），场景按 `// ===== 段落名 =====` 分段 —— 不再用「实例N」编号：
   编号会随插入重排，名字才是稳定地址。
   新开关要做两件事：加进 `EXPECTED_SETTINGS`（那是**词汇表回归锁**，只在设置项集合真的变了时
   才动），以及别的都不用做 —— 「面板的每一行都由设置注册表推导」与「每一行都能翻转并复位」
   两条属性断言会自动覆盖它（注册表经 `__twitterEnhancer.settings()` 读出来，门禁不抄第二份清单）。
   排版类功能另要满足「不搬节点」契约（拓扑签名 + 元素数量在跑脚本前后一致），
   该段带反向对照，若功能没生效会报失败而不是静默通过。
   注意它的射程：只对「改变推文内部拓扑」的改法有牙齿（那种改法必然让签名变化）；
   若新排版只在特定条件下才动节点，要把它自己的条件复现进这个夹具。
6. 改完跑 `npm run verify`；涉及真实布局几何的改动再跑 `npm run e2e:real`。

## 验证出口（`window.__twitterEnhancer`）

jsdom 回归跑的是打包后的 IIFE，没有模块导出 —— 纯逻辑（页面类型分类的十几条分支、
`waitFor` 的 `stopIf` 语义）只能靠 DOM 副作用间接观察，分支覆盖不到。因此 `main.ts` 把一组
**只读纯函数**挂在 `window.__twitterEnhancer` 上（`classifyPath` / `currentPageKind` /
`isTimelinePage` / `getTimelineRoot` / `settings`（开关 id + 分组）/ `waitFor` /
`waitForElement`），门禁直接断言它们。

`settings` 是给「面板是设置注册表的纯函数」那条属性断言用的：没有它，门禁只能自己抄一份
开关清单，那份副本会随每次新增开关过期 —— 于是「面板漏渲染了某个开关」反而测不出来。

新增字段前先读这条约束：**只能挂无副作用的查询函数，绝不挂开关或写入口** ——
脚本的行为入口只有「页内设置面板 + 快捷键」两条，不能因为这个出口多出第三条。

## 夹具的已知边界

### 事件接线的门禁覆盖现状（2026-09-15 实测）

`node scripts/audit-subscriptions.mjs` 会逐条摘掉一个事件订阅、跑门禁，回答
「摘掉它，门禁还红不红」。当时 **26 个订阅点里只有 2 条被 jsdom 门禁覆盖**：
`media-cap` 的 `te:layout`（连带 5 项失败，首要断言「媒体回落到预算内自动解锁」）
与媒体 `load` 捕获（2 项失败，「宿主 A 图片回落预算内后解锁」）。

也就是说：**其余 24 条接线（路由 / 页面类型 / 时间线整层替换 / resize / visibilitychange /
DOMContentLoaded / window load / fonts.ready）在 jsdom 里没有任何测试会在它被删掉或写坏时变红。**
它们**不是多余的** —— 多数走的是真实浏览器里才有的路径（tab 切换、视口变化、字体就绪、回前台、SPA 导航），
jsdom 根本走不到。绿的含义是**未覆盖**，不是不需要。三条结论：

- **不要因为「摘掉它门禁还是绿的」就删订阅** —— 那是把「没测到」当成「不需要」；
- 这些路径的第二个检测器是真机 E2E；`scripts/e2e-scheduled.ps1` + 计划任务让它定时跑起来
  （见 [browser-automation.md](./browser-automation.md)「定时漂移探测」）；
- 想给某条接线补覆盖：先用这个脚本确认它当前是否已被覆盖，再决定补断言还是删掉它。

### 场景之间的顺序耦合

`scripts/verify.mjs` 的场景之间**有顺序耦合**：末尾几段读的是前面建出来的 window
（「按 CONFIG 拼装的样式表」那段读第一个窗口），另有若干共享的 HTML 夹具与辅助函数
（`inject` / `installFakeResizeObserver` / `structureSignature`）。所以它还不能按场景单独运行，
也不能把它们拆成互不依赖的文件 —— 拆之前要先解开这些耦合（把共享夹具提到夹具模块、
让每段自己建窗口），那是一件独立的事，不是顺手能做的重构。

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

- 动 DOM 观察器、路由 hook、页面类型、时间线包装层、宽度 / 布局门控 → [architecture.md](./architecture.md)
- 动列宽、媒体钳制、推文与设置面板外观 / 尺寸 → [design-notes.md](./design-notes.md)
- 需要浏览器里验证或修登录态 → [browser-automation.md](./browser-automation.md)

## 硬编码来源

新增选择器优先用 `data-testid`，其次是稳定 `aria-*` / `role`；绝不用 `css-xxxx` 这类哈希 class
（X 每次发版都换）。稳定锚点统一登记在 `src/lib/selectors.ts`，功能模块里只写引用。
任何从真机量出来的数值（宽度、间距、时长）都要在注释里写明「实测 + 日期」，
来源和分析结论进 `docs/design-notes.md`、`docs/architecture.md` 或源码头部注释，别只留在对话里。
