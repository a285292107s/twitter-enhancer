/**
 * SPA 路由感知（社区标准做法的收敛实现）。
 *
 * X 是 React SPA：站内导航不会触发 load / DOMContentLoaded / pageshow，
 * 任何只靠「页面生命周期事件」的初始化都只跑一次，路由切换后布局相关的
 * 测量与锚定全部失效。社区脚本（control-panel-for-twitter 等）的通用做法
 * 是 hook history.pushState / replaceState，再补上 popstate 与 hashchange。
 *
 * 这里收敛为全站唯一的路由观察入口：
 * - hook 是「包一层后放行」，不改参数、不吞返回值，对 X 的 React Router 透明；
 * - 派发 CustomEvent('te:route')，detail 携带切换后的 URL；
 * - 各功能自行订阅并决定要不要重算（路由切换是低频事件，直接同步处理即可）。
 */

export interface RouteDetail {
  /** 切换后的完整 URL */
  url: string;
}

export type RouteListener = (detail: RouteDetail) => void;

const ROUTE_EVENT = 'te:route';

/** 订阅 SPA 路由切换；返回取消函数 */
export function onRouteChanged(listener: RouteListener): () => void {
  const handler = (event: Event): void => {
    const detail = (event as CustomEvent<RouteDetail>).detail;
    listener({ url: detail?.url ?? location.href });
  };
  document.addEventListener(ROUTE_EVENT, handler);
  return () => {
    document.removeEventListener(ROUTE_EVENT, handler);
  };
}

/** 启动路由观察（幂等）。history hook 只包一次。 */
let started = false;

export function startRouteWatch(): void {
  if (started) return;
  started = true;

  const notify = (): void => {
    try {
      document.dispatchEvent(new CustomEvent<RouteDetail>(ROUTE_EVENT, {
        detail: { url: location.href },
      }));
    } catch {
      // 极早期 document 未就绪时忽略
    }
  };

  for (const method of ['pushState', 'replaceState'] as const) {
    const original = history[method];
    if (typeof original !== 'function') continue;
    history[method] = function patched(this: History, ...args: Parameters<History['pushState']>) {
      const result = original.apply(this, args);
      notify();
      return result;
    };
  }

  window.addEventListener('popstate', notify);
  window.addEventListener('hashchange', notify);
}
