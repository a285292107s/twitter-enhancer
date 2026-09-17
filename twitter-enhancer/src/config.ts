/** 全局可调参数：改这里即可调整脚本行为，改完重新 `npm run build`。 */
export const CONFIG: {
  /**
   * 时间线主列宽度上限（px）——**只在右栏显示时生效**。
   * 右栏显示时三栏空间紧张，主列按「视口可用宽」收敛，最多放宽到该值。
   * 右栏隐藏时主列不按此值，而是直接铺满 X 的内容区（与 /i/grok 页一致），
   * 详见 features/timeline-width.ts 头部「右栏隐藏 = 铺满内容区」。
   */
  timelineWidth: number;
  /** 是否默认开启「宽时间线」（开启后主列铺满内容区 / 右栏显示时放宽到上限） */
  timelineWide: boolean;
  /**
   * X 自己的窄屏断点（px）：低于该值保持 X 原生布局。
   * 这是 X 的断点而不是我们的取舍，X 改版后要重新实测（见 docs/design-notes.md）。
   */
  timelineBreakpoint: number;
  /**
   * 宽度解锁器的**兜底**锁宽区间（px）。
   *
   * 主判据不是这个区间，而是「X 原生列宽 ± 半宽（= (max-min)/2）」——原生列宽由
   * `timeline-width.ts` 在宽列生效前实测后传给解锁器（实测 600），所以 X 改断点 /
   * 改列宽时判据跟着走。这个常量只在**读不到**原生列宽时兜底。
   */
  lockedWidthRange: [number, number];
  /** 右侧栏显隐（详见 features/sidebar.ts） */
  sidebar: {
    /** 是否默认隐藏右侧栏（可用 Alt+B 在页面上实时切换） */
    hiddenByDefault: boolean;
    /**
     * 右栏显示时把它钉在主列右侧（固定 30px 间距，左对齐而非 space-between）。
     * 左导航条**不**由脚本摆放：X 自己的 fixed 定位已经与主列左缘对齐，
     * 覆盖它只会让 /home 与 /i/grok 的导航条走两套机制（2026-09-08 真机复核）。
     */
    anchorSidebar: boolean;
    /**
     * 主列右缘与右栏左缘的间距（px）—— X 原生 30。
     * 两处消费它：sidebar 把右栏钉在主列右侧（margin-left），宽时间线算行的 min-width
     * （`目标宽 + 右栏可见外宽`）。同一个事实写两份必然漂，所以它是配置项。
     */
    gap: number;
  };
  /** 媒体高度钳制（详见 features/media-cap.ts）：宽列下超高竖图/轮播行不超出一屏 */
  media: {
    /** 是否默认开启（可在页内设置面板实时切换） */
    cap: boolean;
    /**
     * 单图超预算时的处理方式：
     * fit —— 等比缩到预算内并水平居中（宽度跟着比例收缩，不裁不压扁，留白用 matte 衬底）；
     * clamp —— 只压宿主高度，交给 X 自己的媒体盒子重排（旧行为，方图/横图会被压扁）。
     * 2026-09-14 实测：/home 方图 900×895 在 980 宽列下被旧行为渲染成 896×540（比例 1.66）。
     */
    fit: boolean;
    /** 宿主识别宽度下限（px）：媒体祖先 ≥ 该宽才视为「整行媒体区」而非单格/单图 */
    lockWidth: number;
    /**
     * 媒体行最大显示高度（px）——**上限**，实际预算还要看视口：
     * `budget = clamp(视口高 − chromeAllowance, minHeight, maxHeight)`。
     *
     * 2026-09-14 实测（1440 宽、4 图竖图轮播）重定这两个值：旧值 `min(540, vh−220)`
     * 在小屏做不到一屏（视口 720 时给 500，帖子高 855、操作栏底边 771 出屏 51px），
     * 在大屏又被 540 顶死（视口 1080/1400 时空着 300–600px 不用）。
     * 现在按「焦点帖操作栏必须落在视口内」推导：媒体行之外上下共约 254px（实测 143+111），
     * 再留 ~50px 给更长的正文，故取 `vh − 320`；上限 700 允许高屏/竖屏拿到更大的图
     *（轮播格宽 ≈ 行高 × 格比例，700 行高 → 格宽 383 > X 原生 600 列下的 356）。
     * 注意 X 原生 600 列的轮播行高是 650（每格 356 宽）—— 在 900 视口下要给到 650
     * 就会让操作栏出屏，这是「一屏看全」的硬取舍点，不是实现问题。
     */
    maxHeight: number;
    /** 预算里留给「媒体行之外的帖子部分（顶栏 + 作者行 + 正文 + 元信息 + 操作栏）」的高度（px） */
    chromeAllowance: number;
    /** 预算下限（px）：视口极矮时仍保证媒体可见 */
    minHeight: number;
    /**
     * 「宽列真的生效了」的宽度下限（px）：主列实测宽于该值才钳制。
     *
     * 为什么门控属性之外还要一条宽度条件：`html[data-te-timeline='wide']` 是开关的**意图**，
     * 而 SPA 导航的一瞬间新主列可能还没被我们的 CSS 写成目标宽 —— 那时按预算钳制会
     * 拿原生列宽算出一个错误的自然高度。它是判据的一部分，所以与其它门槛一样登记在这里，
     * 不要留在功能文件里当魔数。
     */
    minActiveColumnWidth: number;
  };
  /**
   * 内容列排版（详见 features/content-column.ts 与 docs/content-column-design.md）。
   * 只锚定 data-testid / 自身写入的属性，只写属性不搬节点。
   */
  column: {
    /** 是否默认开启 */
    enabledByDefault: boolean;
    /** 操作栏图标成组后的组内间距（px）：764 版心内 6 个图标不拥挤 */
    actionGap: number;
    /** 多图轮播在媒体右上角显示「3/4」序号（独立开关 `carousel-index` 的默认值） */
    carouselIndex: boolean;
  };
  /** 页内设置面板（右下角设置按钮 + 弹窗，取代旧版油猴菜单开关） */
  settings: {
    /** 设置按钮距视口右边（px）：与 X 的 Grok / 私信悬浮按钮同列（2026-09-13 实测 20） */
    right: number;
    /** 设置按钮与右下角抽屉容器上缘的间距（px）；X 自己两个悬浮按钮之间也是 12 */
    gap: number;
    /**
     * 页面里没有右下角抽屉容器时（如 /i/grok）退回的距底边距离（px）。
     * 数值 = Grok 收起态按钮距底边 79 + 按钮高 55 + 间距 12（2026-09-13 实测），
     * 让「有 Grok 按钮」与「没有」的页面位置一致，导航时不跳动。
     */
    fallbackBottom: number;
    /**
     * 设置按钮几何兜底值（2026-09-13 实测 X 自己的 Grok / 私信按钮：55×55、圆角 16、图标 32）。
     * 页面里能读到 X 的悬浮按钮时（绝大多数页面）会直接镜像它的实时几何，见 settings-panel.ts。
     */
    fab: {
      size: number;
      radius: number;
      iconSize: number;
    };
  };
} = {
  timelineWidth: 800,
  timelineWide: true,
  timelineBreakpoint: 1095,
  lockedWidthRange: [560, 660],
  sidebar: {
    hiddenByDefault: true,
    anchorSidebar: true,
    gap: 30,
  },
  media: {
    cap: true,
    fit: true,
    lockWidth: 566,
    maxHeight: 700,
    chromeAllowance: 320,
    minHeight: 320,
    minActiveColumnWidth: 640,
  },
  column: {
    enabledByDefault: true,
    actionGap: 32,
    carouselIndex: true,
  },
  settings: {
    right: 20,
    gap: 12,
    fallbackBottom: 146,
    fab: {
      size: 55,
      radius: 16,
      iconSize: 32,
    },
  },
};
