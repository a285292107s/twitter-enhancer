/**
 * Feature 注册表。
 * 后续新增优化项：在 features/ 下建一个模块，导出 enableXxx()，在此处登记即可。
 */
import { enableTimelineWidth } from './timeline-width';
import { enableTweetUi } from './tweet-ui';
import { enableSidebarSearch } from './sidebar';
import { enableMediaCap } from './media-cap';
import { enableSettingsPanel } from './settings-panel';

export interface Feature {
  /** 功能名，用于日志与未来做开关 */
  name: string;
  /** 是否启用 */
  enabled: boolean;
  enable: () => void;
}

export const features: Feature[] = [
  { name: 'timeline-width', enabled: true, enable: enableTimelineWidth },
  { name: 'tweet-ui', enabled: true, enable: enableTweetUi },
  { name: 'sidebar-search', enabled: true, enable: enableSidebarSearch },
  { name: 'media-cap', enabled: true, enable: enableMediaCap },
  // 页内设置面板放最后：先让各功能把开关登记进设置注册表，面板首次渲染就是完整列表
  // （即便顺序变了也只是重绘一次，见 settings-panel.ts 的 renderRows）。
  { name: 'settings-panel', enabled: true, enable: enableSettingsPanel },
];
