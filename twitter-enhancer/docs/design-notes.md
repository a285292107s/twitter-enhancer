# 尺寸与设计实测结论

数值都是真机量出来的（1440 视口为主），改之前先看这段，别凭感觉调。
设计令牌与取值理由只住在这里和源码注释里 —— 早期生成过一份 `design-system/` 设计稿
（玫红配色 + Playfair Display + 卡片 / GSAP 动效），那套东西对"注入 x.com 的样式层"不适用，
已整体删除，别再重建。

## 内容区与列宽（2026-09-08 实测）

X 三栏的内容区是一个固定盒子：主列 600 + 间距 30 + 右栏 350，右栏自带 `margin-right`
（1440 视口 70px，1024/1280 视口 10px）。`/i/grok` 就是 X 自己的「单栏版」这个盒子 ——
它把右栏那份横向空间整个让给主列，**主列左缘与 `/home` 完全相同**，左导航条（fixed，275px）一点没动。

| 视口 | 三栏行左缘 | 内容区宽（= grok 主列宽） | `/i/grok` 主列 | `/home` 主列 + 右栏 |
| --- | --- | --- | --- | --- |
| 1024 | 96 | 920 − 10 = 910 | 910 @96 | 600 @96 + 290 @716 |
| 1440 | 363 | 1050 − 70 = 980 | 980 @363 | 600 @363 + 350 @993 |
| 2560 | 923 | 1050 − 70 = 980 | 980 @923 | 600 @923 + 350 @1553 |

结论：**右栏隐藏 = 主列铺满这个盒子**（`行宽 − 右栏保留的右边距`），不居中、不移左缘，
于是 `/home` ↔ `/i/grok` 切换时主区几何逐像素相同。右栏显示时才按 `CONFIG.timelineWidth`（800）封顶。

- 断点 `BREAKPOINT = 1095`（`src/features/timeline-width.ts`）；视口更窄时整个功能交回 X 原生。
  不要照抄 minimal-twitter 的 988/1000px，那是它自己的两处断点。
- X 给时间线 / 推文容器写死过 600px 上限（`CONFIG.lockedWidthRange = [560, 660]`），
  落在这个区间且明显窄于主列的元素由 `src/lib/unlock-width.ts` 放开到 100%。
- 竞品（typefully/minimal-twitter）的宽度控制是纯声明式 CSS（5 档硬编码 + `@media`），
  它**不处理推文内媒体**，800 宽下超高轮播纯等比放大 —— 这是本项目 `media-cap` 存在的理由。
  可借鉴的一手：给内层包裹 `div:last-child` 打 `max-width: unset` 顶开 X 自带的内层宽度上限。

## media-cap：媒体高度钳制

现象与边界（真机实测）：

- 单图竖长图 X **自带**约 ≤510px 高度钳制，不用管。
- 真失控的是**多图横向轮播的竖长行**：800 宽列下实测行高 774~898px，加正文/操作栏必然超一屏。

做法与铁律：

- 只压**宿主行的 layout height** 到预算 `min(CONFIG.media.maxHeight=540, 视口高 − 220)`。
  轮播格带内联 `aspect-ratio`，压行高后格子会**自动等比重排**（792px 高的 2:1 行压到 540，
  格从 425×786 变成 289×534）：比例不变、无裁剪、scroll-snap 依然准确。
- **绝不要再叠加 `transform: scale`**：height 与 scale 会双重缩小成 `原高 × k²`（likes 页踩过，
  表现为图片被压到 391px + 两层负 margin 导致布局错位）。
- 冗余空白来自宿主之上的**纯媒体包裹祖先链**，里面可能有 `padding-bottom: calc(…%)` 的比例盒
  （高度 = 宽 × 组内比例，与格子无关）：链式把整条纯媒体祖先压到预算，比例盒 padding 归零，
  原值记在 WeakMap 里、解锁时还原。爬升边界：到 `article` / `cellInnerDiv` / `primaryColumn` 停，
  遇到含 `tweetText` 或操作栏 testid 也停。
- 宿主判据：从媒体元素向上找到的第一个宽度 ≥ `CONFIG.media.lockWidth = 566` 的祖先
  （把定位抬到「整行」而不是轮播里的某一格）。
- 压完做一次布局校验：内容没跟着重排（罕见：固定像素高的媒体）就立刻还原，绝不裁剪 / 重叠。
- **不要对推文内部媒体做缩放/占位补偿类调整**（2026-09-08 用户决议）：800 宽下媒体随主列放大
  是用户接受的代价，`media-lock` 那套已整体移除，别再提。

## 解锁器与轮播格的冲突（2026-09-14 实测）

现象：推文详情页（3 张竖图的横向轮播）里竖图被放大**铺满整列宽**并裁切，观感像
「图片宽高都不再受限制」；同一页面反复冷加载时好时坏。

- X 的横向轮播（`data-testid="ScrollSnap-List"`）每一格的宽度 = **行高 × 内联
  `aspect-ratio`**：3 张竖图（原图 1521×2048，比例 0.74248）在 978 宽列、行高 757 时
  格宽 **562px**（格内 `tweetPhoto` 560px）。
- 562 正好落在 `CONFIG.lockedWidthRange = [560, 660]`（本意是抓 X 写死的 600px 容器），
  于是 `src/lib/unlock-width.ts` 把轮播格放开成 `width: 100%`（946px）。`media-cap` 只压
  行高（757 → 540），格宽仍是整列 → 竖图被放大铺满、上下裁切。
- 命中与否是**竞态**：解锁器每帧 300 节点的 BFS 先扫到该格（格宽还是 562）就中招；
  `media-cap` 的 rAF 钳制先把它压到 398（< 560）就正常。冷加载实测 8 次：4 次坏、4 次好。
- 结论：**轮播子树（`ScrollSnap-List`）一律不参与宽度解锁**（见 `unlock-width.ts` 的
  `CAROUSEL_SCOPE`）。判据取作用域而不是宽度值 —— 轮播之外写死 600px 的容器照旧放开，
  「媒体随列宽放大」这条不变。

## 右下角设置按钮（2026-09-13 实测）

镜像 X 自己悬浮按钮的实时几何，读不到时用 `CONFIG.settings.fab` 兜底：
55×55、圆角 16、图标 32；与 Grok / 私信按钮同列（距右 `right: 20`）、间距 `gap: 12`；
页面没有右下角抽屉容器时（如 `/i/grok`）退回 `fallbackBottom = 146`（= Grok 收起态距底 79 + 按钮高 55 + 间距 12），
保证有 / 没有 Grok 按钮的页面位置一致、导航时不跳动。

## 推文 UI：令牌与硬约束

令牌定义在 `src/features/tweet-ui.css`（`:root` 亮色默认 + `html[data-te-theme='light|dim|dark']` 分支），
取值集中在 `src/config.ts` 的 `tweetUi` 段。这是注入第三方站点的样式层，不是自建页面：

- **不换字体族**（X 用 TwitterChirp）、**不换品牌语义色**（Reply `#1d9bf0` / Repost `#00ba7c` /
  Like `#f91880` 必须在 Light / Dim / Dark 三套主题下都是 X 的原值，可动的是次要文字的对比度）。
- 主题由 `tweet-ui.ts` 检测 `body` 背景色后写入 `html[data-te-theme]`，CSS 分支消费；
  规则统一挂在 `html[data-te-ui='on']` 下，`Alt+U` 可整体关闭。
- 只锚定 `data-testid`；只动 `color / background-color / border-color / opacity / 圆角`，
  **不动画 `width` / `height`**；动效 `--te-dur: 180ms` + `--te-ease: cubic-bezier(.2,0,0,1)`，
  `prefers-reduced-motion: reduce` 下全部压掉。
- 正文 `16px / 1.5`、行长 `--te-measure: 72ch`：列宽铺满后英文行长会涨到约 110 字符，
  72ch 兜住可读性上限（中文约 36 字/行）；媒体仍铺满整列，只有正文限宽。
  计数数字用 `tabular-nums`，避免刷新时跳动。
- 操作栏命中区域 ≥36×36；**绝不移除 focus ring**（`--te-focus` 2px outline + 2px offset）。
