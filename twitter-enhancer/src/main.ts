import { startDomWatch } from './lib/dom-watch';
import { startRouteWatch } from './lib/spa-route';
import { startPageWatch, classifyPath, currentPageKind, isTimelinePage } from './lib/page';
import { startTimelineWatch, getTimelineRoot } from './lib/timeline';
import { waitFor, waitForElement } from './lib/wait-for';
import { features } from './features';

/**
 * 验证 / 调试出口：`window.__twitterEnhancer`。
 *
 * 为什么要有这个全局：jsdom 回归（`scripts/verify.mjs`）跑的是打包后的 IIFE，没有模块导出，
 * 于是**纯逻辑**（页面类型分类的十几条分支、等待器的 stopIf 语义）只能靠 DOM 副作用间接
 * 观察 —— 分支根本覆盖不到。这里把只读的纯函数挂出来，让门禁能直接断言它们。
 *
 * 约束（新增字段前先读这条）：只挂**无副作用**的查询函数，绝不挂开关 / 写入口 ——
 * 脚本的行为入口只有「页内设置面板 + 快捷键」两条，不能因为这个出口多出第三条。
 */
function exposeDebugSurface(): void {
  try {
    Object.defineProperty(window, '__twitterEnhancer', {
      configurable: true,
      value: Object.freeze({
        classifyPath,
        currentPageKind,
        isTimelinePage,
        getTimelineRoot,
        waitFor,
        waitForElement,
      }),
    });
  } catch (error) {
    console.error('[twitter-enhancer] 无法挂载验证出口', error);
  }
}

// 全站只挂一个 childList+subtree 观察器，随后各功能订阅它派发的合并批次
// （旧版每个功能各自注册 MutationObserver，滚动时重复派发、浪费 CPU）。
startDomWatch();
// SPA 路由感知：hook history API，站内导航时广播 te:route（X 导航不触发页面生命周期事件）
startRouteWatch();
// 页面类型检测（Home / Profile / Status …）：广播 te:page，并把类型写在 html[data-te-page]。
// 必须在功能之前启动 —— 功能 enable() 时会直接读当前类型来决定初始行为。
startPageWatch();
// 时间线包装层解析（占位层 / 新旧结构 / 标签页切换）：广播 te:timeline。
// 消费的是上面那个观察器的批次，自己不新建观察器。
startTimelineWatch();
exposeDebugSurface();

for (const feature of features) {
  if (!feature.enabled) continue;
  try {
    feature.enable();
  } catch (error) {
    console.error(`[twitter-enhancer] 功能 ${feature.name} 启用失败`, error);
  }
}
