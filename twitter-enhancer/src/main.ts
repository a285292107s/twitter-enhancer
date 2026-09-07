import { features } from './features';

for (const feature of features) {
  if (!feature.enabled) continue;
  try {
    feature.enable();
  } catch (error) {
    console.error(`[twitter-enhancer] 功能 ${feature.name} 启用失败`, error);
  }
}
