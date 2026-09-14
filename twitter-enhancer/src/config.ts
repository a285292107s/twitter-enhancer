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
   * 需要解除的「写死宽度」区间（px）。
   * X 给时间线 / 推文容器写死了固定上限（当前为 600px），
   * 落在该区间内且明显窄于主列的元素会被放开到 100%。
   */
  lockedWidthRange: [number, number];
  /** 推文 UI 重设计（令牌与约束见 features/tweet-ui.css 头部，取值理由见 docs/design-notes.md） */
  tweetUi: {
    /** 是否默认启用（可用 Alt+U 在页面上实时切换） */
    enabledByDefault: boolean;
    /** 正文正文字号（px），X 默认 15 */
    bodyFontSize: number;
    /** 正文行高，X 默认约 1.3125，宽列下偏紧 */
    bodyLineHeight: number;
    /** 正文最大行长，用于兜住宽列下的可读性上限；设为 'none' 则不限制 */
    measure: string;
  };
  /** 右侧栏与搜索（详见 features/sidebar.ts） */
  sidebar: {
    /** 是否默认隐藏右侧栏（可用 Alt+B 在页面上实时切换） */
    hiddenByDefault: boolean;
    /**
     * 右栏显示时把它钉在主列右侧（固定 30px 间距，左对齐而非 space-between）。
     * 左导航条**不**由脚本摆放：X 自己的 fixed 定位已经与主列左缘对齐，
     * 覆盖它只会让 /home 与 /i/grok 的导航条走两套机制（2026-09-08 真机复核）。
     */
    anchorSidebar: boolean;
  };
  /** 媒体高度钳制（详见 features/media-cap.ts）：宽列下超高竖图/轮播行不超出一屏 */
  media: {
    /** 是否默认开启（可在页内设置面板实时切换） */
    cap: boolean;
    /** 宿主识别宽度下限（px）：媒体祖先 ≥ 该宽才视为「整行媒体区」而非单格/单图 */
    lockWidth: number;
    /** 媒体行最大显示高度（px）：超高媒体被钳到该值，整幅一屏内可看全 */
    maxHeight: number;
  };
  /** 搜索框迁移到左侧导航条 */
  search: {
    /** 是否在导航条 logo 右侧显示搜索框（可在页内设置面板开关） */
    enabled: boolean;
    /**
     * custom：自建输入框，回车跳转到 /search?q= —— 稳定，不触碰 X 的 React 树（默认）
     * move：把 X 原生搜索框（含实时建议下拉）搬进左栏 —— 功能更强，
     *       但移动 React 管理的节点，在 X 重渲染侧栏时存在 DOM 冲突的小概率风险
     */
    mode: 'custom' | 'move';
    /** 占位文案 */
    placeholder: string;
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
  lockedWidthRange: [560, 660],
  tweetUi: {
    enabledByDefault: true,
    bodyFontSize: 16,
    bodyLineHeight: 1.5,
    measure: '72ch',
  },
  sidebar: {
    hiddenByDefault: true,
    anchorSidebar: true,
  },
  media: {
    cap: true,
    lockWidth: 566,
    maxHeight: 540,
  },
  search: {
    enabled: true,
    mode: 'custom',
    placeholder: '搜索',
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
