/**
 * Feature 注册表。
 * 后续新增优化项：在 features/ 下建一个模块，导出 enableXxx()，在此处登记即可。
 *
 * 这里只决定**启用顺序**，没有 enabled 字段：每个功能的开关都在页内设置面板里
 * （见 lib/toggle.ts）。注册表上再挂一个开关就是第二个真相，而它更坏的一面是
 * **诱人** —— 下一个人会以为改这里是「关掉某个功能」的正路，实际上没有任何路径会写它。
 */
import { enableTimelineWidth } from './timeline-width';
import { enableTheme } from './theme';
import { enableSidebar } from './sidebar';
import { enableMediaCap } from './media-cap';
import { enableContentColumn } from './content-column';
import { enableSettingsPanel } from './settings-panel';

export interface Feature {
  /** 功能名：只用于启用失败时的日志 */
  name: string;
  enable: () => void;
}

export const features: Feature[] = [
  { name: 'timeline-width', enable: enableTimelineWidth },
  { name: 'theme', enable: enableTheme },
  { name: 'sidebar', enable: enableSidebar },
  { name: 'media-cap', enable: enableMediaCap },
  { name: 'content-column', enable: enableContentColumn },
  // 页内设置面板放最后：先让各功能把开关登记进设置注册表，面板首次渲染就是完整列表
  // （即便顺序变了也只是重绘一次，见 settings-panel.ts 的 renderRows）。
  { name: 'settings-panel', enable: enableSettingsPanel },
];
