# Timeline Page Overrides — 推文流（X / Twitter 时间线）

> **PROJECT:** Twitter Enhancer
> **Generated:** 2026-09-07
> **Page Type:** 第三方页面增强（覆写 X 现有 DOM，非自建页面）

> ⚠️ **IMPORTANT:** 本文件规则 **override** `../MASTER.md`。
> 只记录与 Master 的偏离；未列出的部分沿用 Master。

---

## 0. 上下文约束（最高优先级，决定所有取舍）

这是**注入到第三方站点**的样式层，不是自建页面，因此：

1. **不改字体族**——X 使用 TwitterChirp，替换字体会破坏视觉一致性并引入额外字体加载（违反 Performance / consistency）。
2. **不替换品牌色**——MASTER 的 rose `#E11D48` 调色板 **不适用**，改品牌色会破坏识别度与功能色的肌肉记忆。
3. **选择器必须锚定 `data-testid`**——class 是哈希值（css-xxxx），随时会变；`data-testid` 是 X 最稳定的属性。
4. **必须可关闭**——提供 `Alt+U` 开关，默认开启，状态持久化到 localStorage。
5. **必须适配 X 三套主题**（Light / Dim / Dark），由 JS 检测 body 背景色写入 `html[data-te-theme]`。

---

## 1. 设计令牌

### 间距（8px 网格，密度 5/10 标准档）

| Token | 值 | 用途 |
|-------|-----|------|
| `--te-space-1` | 4px | 徽标与文字间隙 |
| `--te-space-2` | 8px | 头像与正文、操作栏按钮间距 |
| `--te-space-3` | 12px | 正文与媒体、引用卡内边距 |
| `--te-space-4` | 16px | 推文单元格左右内边距、正文与操作栏 |
| `--te-space-6` | 24px | 置顶标签与内容分隔 |

### 排版

| Token | 值 | 说明 |
|-------|-----|------|
| 正文 | 16px / line-height 1.5 | X 默认 15px/1.3125 过紧；宽列（800px）下更需行距 |
| 用户名 | 15px / 700 | 保持 X 原值，不抢正文焦点 |
| handle · 时间戳 | 15px / secondary | 层级靠颜色与字重，不靠缩小字号 |
| 正文行长 | `max-width: 72ch` | 列宽放大到 800px 后，英文行长会从 ~65 字符涨到 ~90；72ch 兜住可读性上限（中文约 36 字/行，同样舒适） |
| 数字 | `font-variant-numeric: tabular-nums` | 计数变化时防跳动（CLS / layout-shift-avoid） |

### 颜色（沿用 X 语义色，仅修正对比度）

| 用途 | Light | Dim / Dark |
|------|-------|-----------|
| 正文文字 | `#0F1419` | `#E7E9EA` |
| 次要文字 | `#536471`（≈7.4:1） | `#8B98A5`（原 `#71767B` 仅 4.6:1，提升至 ≈7:1） |
| 分隔线 | `rgba(0,0,0,.08)` | `rgba(255,255,255,.09)` |
| hover 底色 | `rgba(0,0,0,.03)` | `rgba(255,255,255,.04)` |
| Reply / 分享 | `#1D9BF0` | 同 |
| Like | `#F91880` | 同 |
| Repost | `#00BA7C` | 同 |

> 所有前景/背景对在亮暗两态下均 ≥4.5:1（`color-accessible-pairs`）。

### 动效（motion 2/10 克制档）

- 时长 `180ms`，曲线 `cubic-bezier(.2,0,0,1)`（deceleration）
- 只动 `color / background-color / border-color / opacity`——**禁止动画 width/height**（transform-performance）
- `@media (prefers-reduced-motion: reduce)` 下全部压到 0.01ms

### 圆角

- 媒体 16px（沿用 X）、引用卡 16px、hover 操作区 9999px（沿用 X）

---

## 2. 组件规范

### 推文单元格 `article[data-testid="tweet"]`
- 内边距 `12px 16px`；分隔线替换为 token 色（在 `cellInnerDiv` 上覆盖，不新增元素）
- 正文与操作栏间距 16px，正文与媒体 12px

### 正文 `[data-testid="tweetText"]`
- 16px / 1.5 / `max-width: 72ch` / `text-wrap: pretty` / `overflow-wrap: anywhere`
- 优先换行而非截断（truncation-strategy）

### 操作栏
- 命中区域 ≥36×36（Web 场景 WCAG 24px 底线之上留余量），相邻按钮间距 ≥8px（touch-spacing）
- hover：图标切语义色 + 圆形容器染 10% 语义色底（state-clarity）
- **不依赖 hover 作为唯一反馈**——X 原有点击反馈保留（hover-vs-tap）

### 媒体 `tweetPhoto` / `videoPlayer`
- 圆角 16px；深色模式加 1px hairline 边框补足边界（暗背景下图边界不可辨）

### 引用推文 `div[role="link"]`
- 转为卡片：1px 边框 + 16px 圆角 + 12px 内边距 + hover 底色
- 明确"可点击整块"的 affordance（cursor-pointer 由 X 提供）

### 焦点
- 保留并强化 `focus-visible`：2px `#1D9BF0` outline + 2px offset
- **绝不移除 focus ring**（Accessibility CRITICAL）

---

## 3. 明确不做（Avoid）

- 换字体族 / 换品牌主色 / 给每条推文加投影卡片（会与 X 的列表密度冲突，造成视觉噪音）
- 动画 width/height、一次性长动画、无限动效
- 依赖 `:hover` 承载唯一信息
- 隐藏 X 原生功能元素（除非走独立开关）
- 硬编码哈希 class 选择器

---

## 4. 验收清单

- [ ] 亮 / 暗 / Dim 三套主题下正文与次要文字对比度 ≥4.5:1
- [ ] 键盘 Tab 到操作栏按钮时焦点环可见
- [ ] `prefers-reduced-motion: reduce` 下无过渡动画
- [ ] 开关 `Alt+U` 可切换，状态刷新后保持
- [ ] 列宽 800px 下正文行长不超过 ~72 字符
- [ ] 长列表滚动时无布局跳动（计数使用 tabular-nums）
