/**
 * X 的**稳定锚点**注册表（做法取自社区标准实现 control-panel-for-twitter 的 `Selectors` 枚举）。
 *
 * 为什么集中登记：
 * - 同一个锚点曾经在四个文件里各写一遍字符串（`[data-testid="primaryColumn"]`），
 *   X 改一次锚点要改四处，漏一处就是「某个功能静默失效」；
 * - 集中之后「只允许稳定锚点」这条红线可被审查 —— 这里看不到 `css-xxxx` 这类哈希 class，
 *   新增功能要选择器时先来这里加一条，而不是就地写字符串。
 *
 * 什么算稳定锚点（按优先级）：
 * 1. `data-testid`（X 的测试锚点，改名频率最低，也是官方 DOM 里唯一带语义的属性）；
 * 2. `aria-label` / `role` / `aria-*`（无障碍属性，会随界面语言变，所以登记成**数组**逐个回退）；
 * 3. 结构（父子 / 兄弟关系）—— 不登记在这里，它属于功能的「判据」，写在功能模块里
 *    （例如时间线滚动层见 `lib/timeline.ts`，导航条内栏见 `features/sidebar.ts`）。
 */

/** 单锚点：稳定属性直达 */
export const SEL = {
  /** 主列：所有布局功能的作用域根 */
  primaryColumn: '[data-testid="primaryColumn"]',
  /** 右栏：X 自己渲染的第三栏，宽列 / 锚定都以它的存在为前提 */
  sidebarColumn: '[data-testid="sidebarColumn"]',
  /** 时间线单元：虚拟列表的行容器（版心 / 解锁器都按它向上定位） */
  cell: '[data-testid="cellInnerDiv"]',
  /** 推文本体 */
  tweet: 'article[data-testid="tweet"]',
  /**
   * 长文（X 的「文章」）阅读视图：正文是它自己的富文本层，里面**没有** tweetText 锚点。
   * 媒体钳制据此把整块正文交回 X 原生（理由见 features/media-cap.ts 的 findHost）。
   */
  articleReadView: 'article[data-testid="twitterArticleReadView"]',
  /** 推文正文（媒体钳制用它排除「含正文的祖先」，内容列排版用它分类） */
  tweetText: '[data-testid="tweetText"]',
  /** 单图 / 多图媒体 */
  tweetPhoto: '[data-testid="tweetPhoto"]',
  /** 视频与 GIF */
  videoPlayer: '[data-testid="videoPlayer"]',
  /** 多图轮播的滚动列表 */
  scrollSnapList: '[data-testid="ScrollSnap-List"]',
  /** 右下角 Grok 抽屉容器（设置按钮以它的上缘定位） */
  grokDrawer: '[data-testid="GrokDrawer"]',
  /** Grok 抽屉头（收起态就是那个 55×55 的悬浮按钮，设置按钮镜像它的外观） */
  grokDrawerHeader: '[data-testid="GrokDrawerHeader"]',
  /** 私信抽屉容器 */
  chatDrawer: '[data-testid="chat-drawer-root"]',
  /** 操作栏：媒体钳制判断「媒体行的终点」时用它 */
  actionBar: '[data-testid="reply"],[data-testid="retweet"],[data-testid="like"],[data-testid="unlike"],[data-testid="bookmark"]',
} as const;

/**
 * logo 链接：`aria-label` 随品牌改过（Twitter → X），当前值是 `X`。
 *
 * 消费方只有一个 —— `lib/dom-watch.ts` 的结构性锚点判定（logo 身份变化 = 导航条被整体重建）。
 * 它只用于**身份比对**，不需要回退链：匹配不到时降级为「锚点未变化」，
 * 那批变更照旧走 120ms 节流冲刷，不会漏补偿（只是慢一拍）。
 * 另有 `a[href="/home"]` 这类更弱的候选，但按位置/宽度猜的判据一律不要写
 * （见 features/sidebar.ts 记的踩坑：猜错会把「主页」导航项当成导航条容器）。
 */
export const LOGO_SELECTOR = 'a[aria-label="X"]';
