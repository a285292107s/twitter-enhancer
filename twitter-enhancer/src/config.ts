/** 全局可调参数：改这里即可调整脚本行为，改完重新 `npm run build`。 */
export const CONFIG: {
  /** 时间线主列目标宽度（px） */
  timelineWidth: number;
  /** 是否默认开启「宽时间线」（开启后主列按 timelineWidth 放宽，右栏显示时也生效） */
  timelineWide: boolean;
  /**
   * 需要解除的「写死宽度」区间（px）。
   * X 给时间线 / 推文容器写死了固定上限（当前为 600px），
   * 落在该区间内且明显窄于主列的元素会被放开到 100%。
   */
  lockedWidthRange: [number, number];
  /** 推文 UI 重设计（详见 features/tweet-ui.ts 与设计文档 pages/timeline.md） */
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
    /** 右栏隐藏后让主内容区重新居中（补偿原右栏占位的空白） */
    recenter: boolean;
    /**
     * 左/右栏以主列（时间线）为锚点：左栏右缘贴主列左缘、右栏左缘距主列 30px。
     * X 把左栏 fixed 在视口左侧，主列一旦居中就会脱节，开启后左栏随主列移动。
     */
    anchor: boolean;
  };
  /** 媒体（图片 / 视频）尺寸（详见 features/media-lock.ts） */
  media: {
    /** 锁定媒体显示尺寸：主列加宽后图片 / 视频保持原生（600 布局）大小 */
    lock: boolean;
    /** 锁定的媒体区宽度（px）。600 = X 原生主列宽，566 = 600 布局的推文内容宽（600 − 32 padding） */
    lockWidth: number;
    /** 媒体最大显示高度（px）：竖图再长也被钳到该值内，无需滚动页面即可看全 */
    maxHeight: number;
  };
  /** 搜索框迁移到左侧导航条 */
  search: {
    /** 是否在导航条 logo 右侧显示搜索框（可在油猴菜单里开关） */
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
    recenter: true,
    anchor: true,
  },
  media: {
    lock: true,
    lockWidth: 566,
    maxHeight: 540,
  },
  search: {
    enabled: true,
    mode: 'custom',
    placeholder: '搜索',
  },
};
