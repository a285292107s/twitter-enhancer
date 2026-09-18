/**
 * 宽列媒体高度钳制（宽时间线真正放宽后生效）。
 *
 * 背景（真机实测 2026-09）：横排轮播的竖长图行有时超过一屏高，必须滚动滚轮
 * 才能完整浏览——800 宽列下实测轮播行高 774~898px（列铺满内容区后按宽度比例更高），
 * 加正文/操作栏后必然超出一屏。单图竖长图 X 自己会钳到约 510 高，不在此列。
 *
 * 方案：对「媒体行宿主」只钳 **layout height**，不施加 transform——
 * 实测确认 X 的媒体行（轮播格带内联 aspect-ratio）会按行高自动重排：
 * 792px 高的 2:1 轮播行压到 540 后，格从 425×786 自动变成 289×534，
 * 比例不变、整幅可见、无裁剪、无缩放副作用、scroll-snap 吸附依然准确。
 * 加 transform 反而会双重缩小（height×k 再 scale(k) → 视觉变成原高×k²，
 * 这是上一版在 likes 页「表现不对」的根因），所以只改布局高度这一条路。
 *
 * 1. 宿主 = 从媒体元素向上找到的第一个宽度 ≥ lockWidth 的祖先：宽度下限把
 *    定位抬到「整行」（单图媒体区宽 = 内容列宽；轮播列表宽 = 行宽），而不是
 *    轮播里的某一格；候选层含正文（data-testid=tweetText）则不是媒体区
 *    （是整条推文列），跳过继续上溯；长文（X 的「文章」）正文视图里的媒体整体
 *    排除 —— 那里的正文不是 tweetText，钳制的祖先链会穿过整篇文章（见 findHost）；
 * 2. 预算 = clamp(视口高 − chromeAllowance, minHeight, maxHeight)：保证焦点帖的元信息\n *    与操作栏落在当前屏内（推导见 CONFIG.media 注释与 heightBudget）；
 * 3. 钳制后做一次布局校验：若内容没跟着行高重排（罕见：固定像素高的媒体），
 *    立刻还原、保持 X 原生观感，绝不裁剪/重叠；
 * 4. 只写宿主的 inline height，不插入/移动 React 节点；列宽回落或媒体变小
 *    （自然高 ≤ 预算）后自动解锁还原。
 *
 * 监听策略（性能版，复用 dom-watch 单例）：
 * - 滚动新增/恢复的媒体走共享新增节点池增量处理：dom-watch 冲刷回调只负责
 *   收集节点，扫描 / 钳制推迟到下一个 rAF 帧统一执行 —— 滚动路径上的同步
 *   layout 读（offsetWidth / getBoundingClientRect）是掉帧主因，收进帧任务
 *   后同一帧内的布局读只触发一次 layout，且多个来源可合并；
 * - 宿主挂 ResizeObserver 只按「宽度变化」触发（我们只改高度，不会自触发）；
 * - 图片/视频加载完成只做「宿主粒度对账」：解锁并重测受影响的这一条链，
 *   不做全列 reset+重钳（旧版在首屏图片并发加载时整列媒体反复回流两次）；
 * - 结构性变化（te:layout / te:route / 宿主宽度变化 / 窗口 resize / 回前台
 *   visibilitychange / dom-watch overflow）仍走 120ms 去抖的全量对账。
 */
import { CONFIG } from '../config';
import { createToggle } from '../lib/toggle';
import { createFrameQueue } from '../lib/frame-work';
import { isWideTimeline } from '../lib/gate';
import { onDomChanged } from '../lib/dom-watch';
import { onRouteChanged } from '../lib/spa-route';
import { markScriptSized, unmarkScriptSized } from '../lib/script-sized';
import { SEL } from '../lib/selectors';

/** 媒体元素：图片与视频 */
const MEDIA_SELECTOR = `${SEL.tweetPhoto},${SEL.videoPlayer}`;
/** 轮播作用域：格宽由「行高 × 内联 aspect-ratio」推出，必须由 X 自己算 */
const CAROUSEL_SCOPE = SEL.scrollSnapList;
/** 宿主上记录已钳制 / 已挂 ResizeObserver 的标记 */
const FLAG = 'teMediaCapped';
const OBSERVED = 'teMediaObserved';
const FLAG_SELECTOR = '[data-te-media-capped]';
/** fit 模式标记（宿主与图片容器都打）：解锁器据此放过这些元素（见 unlock-width.ts） */
const FIT = 'teMediaFit';
const FIT_SELECTOR = '[data-te-media-fit]';
/** ResizeObserver 触发重算的宽度变化容差（px），过滤普通抖动 */
const RESIZE_TOLERANCE = 10;
/** 对账去抖时长（ms）：图片加载 / 视口变化等高频事件合并为一次全量对账 */
const RECONCILE_DEBOUNCE = 120;
/** 钳制后内容底部允许超出宿主的容差（px）：超出说明内容没跟着重排 */
const CROP_TOLERANCE = 4;

/** 媒体钳制开关的当前值 —— 与 createToggle 同步的镜像（理由见 timeline-width.ts 同类注释） */
let locked = CONFIG.media.cap;
/** fit 模式：超预算单图等比缩宽度（true）还是只压宿主高度（false，旧行为）—— 同上，createToggle 的镜像 */
let fitEnabled = CONFIG.media.fit;
/**
 * 脚本改写过的元素 → **被改写属性的原值**（解锁时只把这些属性写回）。
 *
 * 记的是「我们动过哪些属性」而不是整条 `style`：链上的元素随时可能被别处改写别的属性，
 * 整条写回会连那些新值一起抹掉 —— 实测宿主被钳制后 `aspect-ratio` 被更新（媒体自然高
 * 回落到预算内），解锁时整条写回把它还原成旧比例，行高又超预算，表现为「怎么都不解锁」。
 * 只回写自己写过的属性，就与「别人改了别的属性」无关；`getPropertyValue('')`（原本没有
 * 这条属性）在还原时走 `removeProperty`，不会留下空串。
 */
const inlineOriginals = new WeakMap<HTMLElement, Map<string, string>>();

/** 写入一个内联属性，并在首次写入前记下它的原值 */
function writeInline(el: HTMLElement, property: string, value: string): void {
  let record = inlineOriginals.get(el);
  if (!record) {
    record = new Map();
    inlineOriginals.set(el, record);
  }
  if (!record.has(property)) record.set(property, el.style.getPropertyValue(property));
  el.style.setProperty(property, value);
}

/** 把写过的属性按原值写回并清掉记录（幂等，可重复调用） */
function restoreInline(el: HTMLElement): void {
  const record = inlineOriginals.get(el);
  if (!record) return;
  for (const [property, value] of record) {
    if (value === '') el.style.removeProperty(property);
    else el.style.setProperty(property, value);
  }
  inlineOriginals.delete(el);
  // 还原后 style 为空串（我们写过的属性都清掉了，且原本也没有别的内联样式）→ 连属性一起删，
  // 让元素与「从未被脚本碰过」完全一致
  if (el.getAttribute('style') === '') el.removeAttribute('style');
}

/**
 * 布局是否处于「需要钳制」的状态：宽时间线开启，且主列真的被放宽了。
 *
 * 两个条件各管一件事（见 lib/gate.ts 与 CONFIG.media.minActiveColumnWidth）：
 * 门控属性是开关的**意图**，实测宽度是它**真的生效了** ——
 * SPA 导航的一瞬间新主列还没被 CSS 写成目标宽，那时按原生列宽算自然高度会钳错。
 */
function isActive(): boolean {
  if (!isWideTimeline()) return false;
  const primary = document.querySelector<HTMLElement>(SEL.primaryColumn);
  return !!primary && primary.clientWidth > CONFIG.media.minActiveColumnWidth;
}

/**
 * 高度预算（px）：让焦点帖的**操作栏**落在一屏内的最高媒体行高。
 *
 * `clamp(视口高 − chromeAllowance, minHeight, maxHeight)`：
 * - 下限项保证小视口不会把媒体压到不可见（旧版 `vh−220` 在 720 视口给 500，
 *   帖子高 855、操作栏出屏 51px —— 实测 2026-09-14）；
 * - 上限项允许高屏 / 竖屏拿到更大的图（旧版被 540 顶死，1080/1400 视口下白白空着）。
 * 预算同时写进 `documentElement.dataset.teMediaBudget`，供验证脚本读取（避免多处复算公式）。
 */
function heightBudget(): number {
  const { maxHeight, minHeight, chromeAllowance } = CONFIG.media;
  const budget = Math.max(minHeight, Math.min(maxHeight, window.innerHeight - chromeAllowance));
  if (document.documentElement.dataset.teMediaBudget !== String(budget)) {
    document.documentElement.dataset.teMediaBudget = String(budget);
  }
  return budget;
}

let reconcileTimer: ReturnType<typeof setTimeout> | null = null;
/** 去抖后的全量对账（结构性变化 / 视口变化 / RO 宽度变化时调用） */
function scheduleReconcile(): void {
  if (reconcileTimer !== null) return;
  reconcileTimer = setTimeout(() => {
    reconcileTimer = null;
    reconcileMediaCap();
  }, RECONCILE_DEBOUNCE);
}


/* ------------------------------------------------------------------ *
 * 帧任务合并（性能版）
 *
 * dom-watch 的冲刷回调运行在滚动路径上（每 120ms 一批）。任何同步的子树
 * 扫描 / offsetWidth 布局读都会抢主线程并强制 layout，是滚动掉帧的来源。
 * 因此订阅回调只做一件廉价的事：把「这一行的媒体可能要重排」的种子塞进
 * `pendingSeeds`；真正的测量与钳制推迟到下一个渲染帧统一执行 ——
 * 每帧至多跑一次，帧内多次几何读只触发一次 layout，其余命中浏览器布局缓存。
 * 队列本身（同帧合并 / 无 rAF 时退回 setTimeout）由 lib/frame-work.ts 提供。
 * ------------------------------------------------------------------ */

/** 帧任务队列（见 lib/frame-work.ts） */
const frameQueue = createFrameQueue('media-cap');
/** 待重排的种子：媒体元素，或已经是宿主的元素（见 runFrameWork） */
const pendingSeeds = new Set<Element>();

/** 塞入一个种子（幂等；同一帧内多次塞入只处理一次） */
function queueSeed(el: Element): void {
  if (!el.isConnected) return;
  pendingSeeds.add(el);
  frameQueue.schedule('seeds', runFrameWork);
}

/**
 * 帧任务：把这一批「种子」逐个换算成宿主，重算这一条链。
 *
 * 种子只有一种含义 ——「这一行的媒体可能要重新安排」，来源有三：滚动新增的媒体、
 * 加载完成的媒体、以及**已经是宿主**的元素。旧版按来源分成两套机制
 * （`pendingAdded` + `processAdded`/`applyOne` 与 `pendingLoadedHosts` + `reconcileHostChain`），
 * 结果是「宿主内部又长出一张图（轮播成型）」这类情况在增量路径上被
 * `media.closest(FLAG_SELECTOR)` 提前挡掉、只能等下一次全量对账。合并成一条路径后，
 * 任何种子都会先解锁它所在的那条链再重新钳制，语义只剩一种。
 */
function runFrameWork(): void {
  if (!locked || !isActive()) return;
  const seeds = [...pendingSeeds];
  pendingSeeds.clear();
  for (const seed of seeds) {
    if (seed.isConnected && seed instanceof HTMLElement) reconcileSeed(seed);
  }
}

/**
 * 媒体元素的固有尺寸（决定等比缩放后的宽度）。
 *
 * 取**面积最大**的那个候选，而不是「第一个 img」：X 的播放器里还挂着 240×240 之类的
 * 装饰图 / 图标，按 DOM 顺序取会把它们当成内容（实测 akaoni2gou 的 GIF 帖上
 * `querySelector('img')` 命中一张 240×240 的小图）。图片用 naturalWidth，
 * 视频 / GIF 用 videoWidth —— GIF 在 X 里也是 `<video>`。
 * 都读不到（元数据还没解码出来）时返回 null，等 load / loadeddata 事件再试。
 */
function intrinsicSize(el: HTMLElement): { width: number; height: number } | null {
  let best: { width: number; height: number } | null = null;
  const consider = (width: number, height: number): void => {
    if (!(width > 0) || !(height > 0)) return;
    if (!best || width * height > best.width * best.height) best = { width, height };
  };
  for (const image of el.querySelectorAll('img')) {
    consider(image.naturalWidth, image.naturalHeight);
  }
  for (const video of el.querySelectorAll('video')) {
    consider(video.videoWidth, video.videoHeight);
  }
  return best;
}

/**
 * 宿主里的「唯一媒体」：取**最外层**媒体元素（X 会把 videoPlayer / tweetPhoto 嵌套起来，
 * 按元素个数数会误判成多个），且不在轮播里、能读到固有尺寸。
 * 判据取「媒体自己是否在轮播里」而不是「宿主内部有没有轮播」—— 宿主可能**就是**
 * 某张格（比例盒在未钳制时可能宽于 lockWidth），此时轮播在它的**祖先**里。
 */
function soleMedia(host: HTMLElement): HTMLElement | null {
  if (!fitEnabled) return null;
  const medias = [...host.querySelectorAll<HTMLElement>(MEDIA_SELECTOR)];
  if (medias.length === 0) return null;
  const outer = medias.filter((m) => !medias.some((other) => other !== m && other.contains(m)));
  if (outer.length !== 1) return null;
  const media = outer[0];
  if (media.closest(CAROUSEL_SCOPE)) return null;
  return intrinsicSize(media) ? media : null;
}

/**
 * 等比方案：媒体在整列宽下是否会高过预算？会，就按比例把盒子缩到预算内。
 *
 * 判据用**固有比例 × 行宽**推出高度，而不是读宿主当前高度（`host.offsetHeight`）：
 * X 自己会把媒体盒钳到某个高度（实测这条 GIF 的 `padding-bottom: 55.33%` 让行高
 * **正好等于**预算），于是「当前高度 ≤ 预算」会把一行永远判成「无需处理」——
 * 等比永远不生效，画面被 contain 在两旁留黑边。用固有比例算就不受 X 已钳高度的影响。
 *
 * 盒子高度**恒取预算**，不掺 X 当前的盒子高度：那个值可能由我们上一轮写的宽度推出来
 * （X 的比例盒按盒宽算高度），掺进来就把「脚本自己的输出」当成输入 —— 正是本文件
 * 反复踩的那类循环依赖。代价是竖图会比 X 自带的 510px 上限略大 30px（同一屏内，可接受）。
 */
function planFit(host: HTMLElement, budget: number): { media: HTMLElement; width: number; height: number } | null {
  const media = soleMedia(host);
  if (!media) return null;
  const size = intrinsicSize(media);
  if (!size) return null;
  const rowWidth = host.offsetWidth;
  if (rowWidth <= 0) return null;
  // 整列宽下按比例应有的高度；不超过预算就交给 X 原生（满宽、不裁、无黑边）
  const aspectHeight = (rowWidth * size.height) / size.width;
  if (aspectHeight <= budget) return null;
  const height = Math.max(1, Math.round(budget));
  const width = Math.round((height * size.width) / size.height);
  if (width <= 0 || width >= rowWidth) return null;
  return { media, width, height };
}

/**
 * 媒体元素与宿主之间的包裹层（不含媒体自身与宿主）。
 *
 * 为什么必须单独收集：X 会**逐层收缩包裹窄媒体** —— 竖长图（292×680）在 X 自己的
 * 510px 高度上限下被 letterbox 成 219×510，于是媒体列上每一层包裹都窄于
 * `CONFIG.media.lockWidth`，`findHost` 只能一路抬到整行（978）才命中宿主；
 * 这些包裹层因此落在宿主**内部**，不在 `run`（宿主 + 宿主的纯媒体祖先）里。
 *
 * 只钉宿主与媒体、放过中间层，实测 2026-09-14（Ford_R_plus 竖长单图）：
 * 媒体盒被钉在 249×580，外面几层仍是 219×510 —— 其中一层还带着 X 自己的
 * 内联 `width:218.875px;height:510px` 比例盒，图片从容器右下溢出 30×70px，
 * 卡片圆角边框横切在图片中下部（用户报的「单图容器表现异常」）。
 */
function mediaWrappers(host: HTMLElement, media: HTMLElement): HTMLElement[] {
  const wrappers: HTMLElement[] = [];
  let el = media.parentElement;
  while (el && el !== host && wrappers.length < 24) {
    wrappers.push(el);
    el = el.parentElement;
  }
  // 宿主不是媒体的祖先（理论上不会发生）：不钉任何中间层，避免误伤无关元素
  return el === host ? wrappers : [];
}

/**
 * 「纯包裹层」判据：容器里除了承载这条媒体链的那一支，不能**并排着别的内容**。
 *
 * 为什么需要（2026-09-18 用户实测反馈「推文较长时，也会显示异常」，标本
 * x.com/dotey/status/2100767963737727267）：X 把「推文自己的媒体行」与「引用卡 / 文章卡」
 * 并排放在**同一个容器**里 —— 实测该容器 946×1054 = 媒体行 946×512 + 卡片 946×538。
 * 旧的祖先链爬升只认 `tweetText`，认不出卡片，于是这条链一路爬到那个容器，把容器连同
 * 里面的卡片一起钉成 438×580：整张卡片被压瘪（推文高度 1742 → 1268，差的 474px 就是
 * 被吞掉的卡片），而且冷加载时好时坏 —— 取决于等比判定与卡片渲染谁先到。
 *
 * 「别的内容」＝ 带可见文字，或带**不属于推文媒体容器**（`tweetPhoto` / `videoPlayer`）
 * 的图片 / 视频。两条例外都是有真机依据的，不是放宽：
 * - 同一条媒体行的**另一片媒体**（轮播逐格渲染时先后到达）不算别的内容 —— 否则
 *   「宿主里从 1 张图变成 2 张图」这条增量路径会整条失效（实测夹具：轮播成型后行仍被钳制）；
 * - 纯装饰兄弟（轮播两侧的翻页按钮 `ScrollSnap-prev/nextButtonWrapper`，纯 SVG、无文字、
 *   无 img）不算。
 * 判据是**结构**，不是尺寸（与「轮播内部不作为宿主」「长文正文整体排除」同一类）。
 * 边界：偏保守（X 若把某段屏读文字放进媒体块，那一层就不再受压），保守的代价只是少压一层、
 * 留一点空白；反过来误判的代价是整块内容被压瘪。
 */
function hasContentSibling(container: HTMLElement, carrier: Element): boolean {
  for (const child of container.children) {
    // 承载媒体链的那一支（自己或祖先）不算兄弟
    if (child.contains(carrier)) continue;
    // 另一片媒体（轮播格）：同一行的媒体，不是「别的内容」
    if (child.matches(MEDIA_SELECTOR)) continue;
    if ((child.textContent ?? '').trim().length > 0) return true;
    // 卡片封面 / 头像这类图片不在媒体容器里 → 是别的内容
    for (const image of child.querySelectorAll('img,video')) {
      if (!image.closest(MEDIA_SELECTOR)) return true;
    }
  }
  return false;
}

/**
 * 应用等比方案：媒体盒子、宿主到媒体之间的每一层包裹、以及整条媒体链，全部按算出来的尺寸写死。
 *
 * **整条媒体链一起收**（`run` = 宿主 + 宿主之上的纯媒体祖先）：只缩媒体与宿主时，
 * 链上更外层的包裹仍是整列宽 —— 用户实测看到的正是「包裹图片的容器比图片宽出一大截」，
 * 在暗色下那块空盒会显成一个白色方块。
 *
 * **中间包裹层一起收**（`wrappers`）：窄媒体被 X 逐层 shrink-wrap 时 `findHost` 会越过
 * 这些层抬到整行，它们于是落在宿主内部、逃出 `run` —— 见 mediaWrappers 注释。
 * 判据是「媒体到宿主之间的每一层」，与宿主定位无关，所以两种形态（宿主紧贴媒体 /
 * 宿主被窄包裹层隔开）都闭合。
 */
function applyFit(
  run: HTMLElement[],
  wrappers: HTMLElement[],
  plan: { media: HTMLElement; width: number; height: number },
): void {
  const { media, width, height } = plan;
  /**
   * 钉一个盒子：宽高写死，并解除 X 的 `max-width` / `max-height` 上限。
   *
   * X 把「自己那 510px 高度上限」写成**内联 max-width**（`max-width = 510 × 固有宽高比`）：
   * 竖长图上它会小于我们算出的等比宽度，于是宽度被卡住、图片溢出容器 —— 实测 /home
   * 一条竖图帖：我们写 `width: 433px`，X 的 `max-width: 380.8px` 把盒子卡在 381，
   * 图片比容器宽出 52px。只钉宽高不解约束，等于没钉。
   */
  const pinBox = (el: HTMLElement): void => {
    writeInline(el, 'width', `${width}px`);
    writeInline(el, 'height', `${height}px`);
    writeInline(el, 'max-width', 'none');
    writeInline(el, 'max-height', 'none');
    el.dataset[FIT] = '1';
    markScriptSized(el);
  };
  /**
   * 媒体盒**以及盒内嵌套的媒体元素**（X 把 `videoPlayer` 嵌在 `tweetPhoto` 里）全部写死成
   * 同一个盒子。只钉外层盒子不够：播放器的高度来自 X 那层「按盒宽算高度」的比例盒
   * （`padding-bottom: 55%`），一收窄宽度它就跟着变小 —— 实测同一个 GIF 帖在
   * 648×540 / 648×359 / 648×0 三种状态之间飘，取决于谁先落笔（我们 vs X 的重渲染）。
   * 把内层盒子也钉死，播放器尺寸就与 X 的比例盒无关。
   */
  for (const box of [media, ...media.querySelectorAll<HTMLElement>(MEDIA_SELECTOR)]) {
    pinBox(box);
  }
  /** 中间包裹层：常带 X 自己的比例盒 padding，一样归零并钉住 */
  for (const el of wrappers) {
    if (/calc|%/.test(el.style.paddingBottom ?? '')) {
      writeInline(el, 'padding-bottom', '0px');
    }
    pinBox(el);
  }
  for (const el of run) {
    writeInline(el, 'width', `${width}px`);
    writeInline(el, 'max-width', 'none');
    el.dataset[FIT] = '1';
    // 登记进「脚本自写尺寸」表：宽度解锁器按尺寸推断，不能把这里写下的宽度
    // 当成「X 写死的 600px 容器」（见 lib/script-sized.ts）
    markScriptSized(el);
  }
}

/** 还原 fit / 钳制改动过的内联尺寸 */
function clearFit(el: HTMLElement): void {
  restoreInline(el);
  delete el.dataset[FIT];
  unmarkScriptSized(el);
}

/** 解除单个宿主的钳制（含清理标记、ResizeObserver、还原被改写的内联属性） */
function unlockHost(host: HTMLElement): void {
  restoreInline(host);
  delete host.dataset[FLAG];
  delete host.dataset[OBSERVED];
  resizeObserver?.unobserve(host);
  for (const fitted of host.querySelectorAll<HTMLElement>(FIT_SELECTOR)) clearFit(fitted);
  if (host.matches(FIT_SELECTOR)) clearFit(host);
}

/**
 * 单个种子（媒体元素）的宿主粒度对账：解锁它所在的钳制链，再用**同一个媒体元素**
 * 重新定位宿主并钳制。
 *
 * 旧版对任何变化都做全量 reconcile（先 resetMediaCap 放开全列所有钳制、
 * 再全部重钳）—— 首屏图片并发加载时会反复让整列媒体先回原高再压回预算，
 * 等于每批加载都做两次整列布局回流，肉眼可见地闪。逐链解锁重测即可：
 * 自然高仍超预算则重新钳制，已回落则保持解锁。
 *
 * 重新定位必须从**同一个媒体元素**起算（`findHost(media)`）。曾经是从「上一轮的宿主」
 * 起算的，而 `findHost` 是从入参的父节点开始找 —— 同一条行会在两级之间来回漂移
 * （第一轮钳 `fitHost`，增量重算却钳它的父层 `fitWrap`），断言与排查都跟着变玄学。
 */
function reconcileSeed(seed: HTMLElement): void {
  if (!locked || !isActive()) return;
  const flagged = seed.closest<HTMLElement>(FLAG_SELECTOR);
  const media = seed.matches(MEDIA_SELECTOR) ? seed : seed.querySelector<HTMLElement>(MEDIA_SELECTOR);
  const chain: HTMLElement[] = [];
  let el: HTMLElement | null = flagged;
  while (el && el !== document.body && el.dataset[FLAG]) {
    chain.push(el);
    el = el.parentElement;
  }
  for (const item of chain) unlockHost(item);
  // 有媒体元素 → 与首轮同一起点重新定位；没有（例如宿主里刚加载完的图片不属于任何
  // 媒体容器）→ 退回上一轮选出的那个宿主本身。
  const host = (media ? findHost(media) : null) ?? (flagged?.isConnected ? flagged : null);
  if (host) applyCap(host);
}

/**
 * 媒体行宿主：媒体元素向上第一个宽度 ≥ lockWidth 的祖先，且内部不含正文。
 * 宽度下限保证定位到「整行」（单图媒体区宽 = 内容列宽；轮播列表宽 = 行宽），
 * 而不是轮播里的某一格；含正文的祖先（整条推文列）跳过，避免误缩文字。
 *
 * 轮播内部（ScrollSnap-List 的子孙）一律不作为宿主 —— 2026-09-14 实测：
 * 某张格的「比例盒」在未钳制状态下宽度可达 591px（≥ lockWidth），于是它被当成行宿主
 * 单独钳制，格高 540、而其余格由行宿主钳制后是 534：同一轮播里首格比其它格大一圈。
 * 轮播列表自身仍可作宿主（整行一起压，X 会让所有格按行高等比重排）。
 */
function findHost(el: Element): HTMLElement | null {
  // 长文（X 的「文章」）正文里的媒体不是「媒体行的媒体」：正文区没有 tweetText 锚点，
  // 所以「不含正文」这条判据在这里失效 —— 正文图片的行宿主会被正常选中，而钳制时那条
  // **祖先链**（宿主 → … → article/cellInnerDiv 为止）上就有承载整篇文章的容器。
  // 实测 2026-09-17（标本 x.com/yupi996/status/2100405798681862604，1440 视口）：
  // 图片行宿主写前 oh=653（躲过了「超过 2.5 屏不是媒体区」那条保护），祖先链上的正文容器
  // （158 个子块、写前 oh=23177）被写成 height 580px → 正文从盒子里溢出、虚拟列表按
  // 被压短的 cell 摆放后续位置 → 回复盖在文章上、文章显示不全（docH 4444 而非 24590+）。
  // 正文是**文档**而不是推文的媒体行，与「轮播内部不作为宿主」同属结构排除：
  // 判据是稳定 testid，不是尺寸 / 高度 / 内容多少。
  if (el.closest(SEL.articleReadView)) return null;
  let p = el.parentElement;
  while (p && p !== document.body) {
    const carousel = p.closest(CAROUSEL_SCOPE);
    if (carousel && carousel !== p) {
      p = p.parentElement;
      continue;
    }
    if (p.offsetWidth >= CONFIG.media.lockWidth) {
      // 含正文（tweetText）→ 是整条推文列；并排着别的内容（引用卡 / 文章卡 / 另一条媒体）
      // → 是「媒体 + 卡片」的混合块（见 hasContentSibling）。两者都不是这条媒体的行宿主，
      // 继续上溯（更高的祖先只会更宽、更不可能是媒体行），最终返回 null 交回 X 原生。
      if (!p.querySelector(SEL.tweetText) && !hasContentSibling(p, el)) return p;
    }
    p = p.parentElement;
  }
  return null;
}

/**
 * 钳制后的内容底边（相对宿主顶，布局坐标）：读一次同步布局来校验内容是否
 * 随行高重排。校验时宿主应处于钳制后的状态（height 已写入、无 transform）。
 */
function contentBottomAfterClamp(host: HTMLElement): number {
  const top = host.getBoundingClientRect().top;
  let bottom = 0;
  for (const media of host.querySelectorAll(MEDIA_SELECTOR)) {
    const rect = media.getBoundingClientRect();
    if (rect.width <= 0) continue;
    if (rect.bottom - top > bottom) bottom = rect.bottom - top;
  }
  return Math.round(bottom);
}

/**
 * 对单个宿主执行高度钳制（幂等、只缩不放、只改布局高度）。
 *
 * 除宿主本身外，把「宿主与正文列之间的整条纯媒体祖先链」一起压到预算——
 * X 在轮播行与内容列之间常有多层包裹，其中：
 * - 某些层高度由 React 写死；
 * - 最典型的是「百分比 padding 比例盒」（style="padding-bottom: calc(…%)"），
 *   其高度 = 宽×组内比例，与行内格子的实际高度无关——只压行会在这类盒里
 *   留下整段冗余空白。
 * 爬升边界（防误伤）：
 * - 到 article / cellInnerDiv 为止；
 * - 含正文（tweetText）或操作栏（reply/like 等 data-testid）即停，
 *   绝不压缩文字与计数栏；
 * - 与「引用卡 / 文章卡 / 另一条媒体」并排的容器即停（`hasContentSibling`）：
 *   那一层不是纯媒体包裹，压它等于把卡片一起压瘪（2026-09-18 实测）。
 * 百分比 padding 盒在压高时把 padding-bottom 临时归零（记录原值、解锁还原）。
 * 钳住后同步校验行内媒体底边：若内容没随行高重排（会超界被裁），整链还原。
 */
function applyCap(host: HTMLElement): void {
  if (!locked || !isActive()) return;
  // 已被外层钳制的宿主不再处理（外层已统一覆盖整行内容）
  if (host.closest(FLAG_SELECTOR)) return;
  // X 逐格渲染轮播：第一格先到时宿主里只有一张图，fit 判定成立并钉了尺寸；
  // 其余几格随后到达、轮播成型，那一次 fit 就不再成立（实测 4 格竖图里
  // 首格 295×540、其余 291×534，行框被撑到 1010px）。整列对账一次，
  // reset 会把所有 fit 还原，再按当前结构重钳。
  if (host.querySelector(FIT_SELECTOR) && !soleMedia(host)) {
    scheduleReconcile();
    return;
  }
  const natural = host.offsetHeight;
  if (natural === 0) return;
  // 超过 2.5 屏的宿主不是媒体区（虚拟列表 / 超长占位容器），跳过以防误伤
  if (natural > window.innerHeight * 2.5) return;
  const budget = heightBudget();

  // 收集与宿主一起压的纯媒体祖先链（含宿主自身，最多 10 层）
  const run: HTMLElement[] = [host];
  let p = host.parentElement;
  while (p && p !== document.body && run.length < 10) {
    const te = p.getAttribute('data-testid');
    if (p.tagName === 'ARTICLE' || te === 'cellInnerDiv') break;
    if (te === 'primaryColumn' || te === 'sidebarColumn') break;
    if (p.querySelector(SEL.tweetText)) break;
    if (p.querySelector(SEL.actionBar)) {
      break;
    }
    // 并排着别的内容（引用卡 / 文章卡 / 另一条媒体）→ 这一层不是「纯媒体包裹」：
    // 继续往上写尺寸会把卡片一起压瘪（2026-09-18 实测，见 hasContentSibling）
    if (hasContentSibling(p, host)) break;
    run.push(p);
    p = p.parentElement;
  }

  /**
   * 写入链上的高度（+ 可选宽度），并打钳制标记。
   * 第一次改写前整条内联样式入账（解锁时逐字还原）；百分比 padding 比例盒的高度
   * 来自 padding，光压 height 无效 → 一并归零；X 用内联 `max-height` 表达自己那
   * 510px 高度上限时，我们的 height 会被它卡住 → 一并解除。
   */
  const writeChain = (height: number, width: number | null): void => {
    for (const el of run) {
      writeInline(el, 'height', `${height}px`);
      writeInline(el, 'max-height', 'none');
      if (/calc|%/.test(el.style.paddingBottom ?? '')) {
        writeInline(el, 'padding-bottom', '0px');
      }
      if (width !== null) {
        writeInline(el, 'width', `${width}px`);
        writeInline(el, 'max-width', 'none');
        markScriptSized(el);
      }
      el.dataset[FLAG] = '1';
    }
  };

  // 单媒体等比：先于「高度是否超预算」判断 —— 盒子该多大由媒体比例决定，
  // 而不是由 X 当前给的（可能已经被它自己钳过的）高度决定。见 planFit 注释。
  const plan = planFit(host, budget);
  if (plan) {
    const wrappers = mediaWrappers(host, plan.media);
    writeChain(plan.height, plan.width);
    applyFit(run, wrappers, plan);
    // 尺寸由比例算出，理论上必然贴合；仍做一次校验兜住「固定像素高的媒体」
    if (contentBottomAfterClamp(host) > plan.height + CROP_TOLERANCE) {
      for (const el of run) unlockHost(el);
      return;
    }
    observeHost(host);
    return;
  }

  if (natural <= budget) {
    // 自然高度在预算内（列宽回落 / 媒体变小），清掉可能残留的钳制
    if (host.dataset[FLAG]) unlockHost(host);
    return;
  }
  // 已钳住的宿主：offsetHeight 现在返回预算值，直接返回避免重复处理
  if (host.dataset[FLAG]) return;

  writeChain(budget, null);
  // 布局校验：内容底边超出预算（且超出容差）说明没有随行高重排，
  // 此时硬压会裁图/重叠 → 整链还原，保持 X 原生观感
  if (contentBottomAfterClamp(host) > budget + CROP_TOLERANCE) {
    for (const el of run) unlockHost(el);
    return;
  }
  observeHost(host);
}

/** 挂 ResizeObserver 并记录钳制时的布局宽度（RO 首次回调与此一致，不会自触发重算） */
function observeHost(host: HTMLElement): void {
  if (resizeObserver && !host.dataset[OBSERVED]) {
    resizeObserver.observe(host);
    host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
  }
}

/** ResizeObserver 回调：只看宽度变化（我们的钳制只改高度，不会自触发） */
function onHostResize(host: HTMLElement): void {
  if (!locked || !isActive()) return;
  const width = Math.round(host.offsetWidth);
  const last = Number(host.dataset[OBSERVED] ?? -1);
  if (Number.isFinite(last) && Math.abs(width - last) < RESIZE_TOLERANCE) return;
  // 行宽真的变了（列宽调整 / 内容变化）：全量对账重测自然高度
  scheduleReconcile();
}

const resizeObserver =
  typeof ResizeObserver !== 'undefined'
    ? new ResizeObserver((entries) => {
        for (const entry of entries) onHostResize(entry.target as HTMLElement);
      })
    : null;

/**
 * 全量对账：先解除所有钳制（重测自然高度），再对当前所有媒体重新钳制。
 * 宿主数量 = 屏上媒体数，代价可忽略；te:layout / te:route / overflow /
 * 宿主宽度变化 / 窗口 resize / 回前台时调用（滚动新增与媒体加载完成走
 * 帧任务里的宿主粒度路径，不经过这里，避免整列反复回流）。
 */
function reconcileMediaCap(): void {
  if (!locked || !isActive()) {
    resetMediaCap();
    return;
  }
  resetMediaCap();
  for (const media of document.querySelectorAll(MEDIA_SELECTOR)) {
    if (!media.isConnected) continue;
    const host = findHost(media);
    if (!host) continue;
    applyCap(host);
  }
  // 记录已观察宿主的当前布局宽度，供 RO 宽度变化判定
  for (const host of document.querySelectorAll<HTMLElement>(FLAG_SELECTOR)) {
    host.dataset[OBSERVED] = String(Math.round(host.offsetWidth));
  }
}

/** 把一批新增节点里的媒体元素收成种子（一个媒体可能作为节点本身、也可能在子树里） */
function collectSeeds(nodes: Element[]): void {
  for (const node of nodes) {
    if (!node.isConnected) continue;
    if (node.matches(MEDIA_SELECTOR)) pendingSeeds.add(node);
    for (const media of node.querySelectorAll(MEDIA_SELECTOR)) {
      if (media.isConnected) pendingSeeds.add(media);
    }
  }
  if (pendingSeeds.size > 0) frameQueue.schedule('seeds', runFrameWork);
}

/** 撤销所有钳制（功能关闭 / 布局回原生时还原 X 原生观感） */
function resetMediaCap(): void {
  for (const el of document.querySelectorAll(FLAG_SELECTOR)) {
    unlockHost(el as HTMLElement);
  }
  // 兜底：宿主已不在钳制集合、但 fit 标记残留的元素（React 换过子树）
  for (const el of document.querySelectorAll<HTMLElement>(FIT_SELECTOR)) {
    clearFit(el);
  }
}

export function enableMediaCap(): void {
  // 两个开关：默认值 / 存储读取 / 写盘 / 面板登记与刷新全部交给 createToggle（见 lib/toggle.ts）。
  // 构造时的第一次 apply 就是首屏对账（旧实现里那句独立的 reconcileMediaCap()），
  // 所以这两行必须排在下面那些事件订阅之前 —— 首帧要有正确的媒体高度，不能等异步存储。
  // 注册顺序（media-cap → media-fit）就是面板里的行序，不要调换。
  createToggle({
    id: 'media-cap',
    group: '内容',
    label: '媒体高度钳制',
    description: `超高竖图 / 轮播压到 ${CONFIG.media.maxHeight}px 内，一屏看全`,
    default: CONFIG.media.cap,
    apply: (value) => {
      locked = value;
      reconcileMediaCap();
    },
  });
  createToggle({
    id: 'media-fit',
    group: '内容',
    label: '单图等比',
    description: '超预算的单图按比例缩到预算内并居中，不裁切、不压扁（关：只压高度）',
    default: CONFIG.media.fit,
    apply: (value) => {
      // fit 改的是图片内联尺寸，必须走一次整体还原再按新模式重钳
      fitEnabled = value;
      reconcileMediaCap();
    },
  });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', reconcileMediaCap, { once: true });
  }
  window.addEventListener('load', reconcileMediaCap, { once: true });

  // 增量：订阅 dom-watch 单例的共享新增节点池（滚动恢复的媒体从这里来）。
  // 冲刷回调只收集种子、绝不做事 —— 扫描 / 钳制全部推迟到下一个 rAF 帧统一执行
  //（滚动路径上的同步 layout 读是掉帧主因）。overflow 说明单批新增超上限、
  // 池可能丢节点：结构性缺失，走去抖全量对账兜底。
  onDomChanged(({ added, overflow: hadOverflow }) => {
    if (!locked || !isActive()) return;
    if (hadOverflow) {
      scheduleReconcile();
      return;
    }
    if (added.length === 0) return;
    collectSeeds(added);
  });

  // 宽时间线开关 / 右栏显隐 / SPA 路由都会重建或移动媒体子树，全量对账一次。
  const onLayout = (): void => {
    if (locked) scheduleReconcile();
  };
  document.addEventListener('te:layout', onLayout);
  onRouteChanged(onLayout);

  // 图片 / 视频加载完成后自然尺寸才会就绪（占位 → 真实比例），媒体行高随之重排：
  // 捕获阶段监听 load / loadeddata，把承载它的元素收成种子交给帧任务 —— 帧任务里
  // 统一换算成宿主并重算这一条链，不做整列 reset+重钳（首屏并发加载时那样会闪）。
  const onMediaLoad = (event: Event): void => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (!(target instanceof HTMLImageElement || target instanceof HTMLVideoElement)) return;
    if (!locked || !isActive()) return;
    // 只关心媒体容器里的图片 / 视频（头像之类两者都不属于，直接跳过）：
    // 优先落到媒体容器，其次落到已钳宿主（宿主里可能还有不属于媒体容器的图，如占位图）
    const seed =
      target.closest<HTMLElement>(MEDIA_SELECTOR) ?? target.closest<HTMLElement>(FLAG_SELECTOR);
    if (seed) queueSeed(seed);
  };
  document.addEventListener('load', onMediaLoad, true);
  document.addEventListener('loadeddata', onMediaLoad, true);
  // 视口高度变化会改变高度预算（clamp(视口高 − chromeAllowance, minHeight, maxHeight)）
  window.addEventListener('resize', scheduleReconcile);
  // 后台标签页定时器被冻结：回到前台时主动补一次对账
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && locked) scheduleReconcile();
  });
}








