/**
 * Feature 注册表。
 * 后续新增优化项：在 features/ 下建一个模块，导出 enableXxx()，在此处登记即可。
 */
import { enableTimelineWidth } from './timeline-width';
import { enableTweetUi } from './tweet-ui';
import { enableSidebarSearch } from './sidebar';
import { enableMediaLock } from './media-lock';

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
  { name: 'media-lock', enabled: true, enable: enableMediaLock },
];
