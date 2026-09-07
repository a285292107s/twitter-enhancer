import { startDomWatch } from './lib/dom-watch';
import { features } from './features';

// 全站只挂一个 childList+subtree 观察器，随后各功能订阅它派发的合并批次
// （旧版每个功能各自注册 MutationObserver，滚动时重复派发、浪费 CPU）。
startDomWatch();

for (const feature of features) {
  if (!feature.enabled) continue;
  try {
    feature.enable();
  } catch (error) {
    console.error(`[twitter-enhancer] 功能 ${feature.name} 启用失败`, error);
  }
}
