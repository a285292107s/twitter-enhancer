/**
 * 命名观察器作用域（做法取自社区标准实现 control-panel-for-twitter 的 `observers` Map +
 * `observeElement` 包装）。
 *
 * 解决的问题：写在**具体节点**上的观察器必须跟着节点的生命周期走，而 X 的 SPA 导航 /
 * 重渲染会把节点整棵换掉。裸写 `new MutationObserver(...).observe(node, ...)` 的后果是：
 * - 观察器盯着一个已经脱离文档的旧节点（永远收不到回调、也不会被回收）；
 * - 新节点没人观察（功能静默失效，直到刷新页面）；
 * - 重复挂载时同一个节点上叠了 N 个观察器（每次导航多一个，长会话里越来越慢）。
 *
 * 本模块用**名字**当键：
 * - 同名重复登记 → 先断开旧的再登记新的（「重新绑定到新节点」就只是一次同名登记）；
 * - 离开这一组工作时 `disconnectAll()` 一次拆干净 —— 功能不必自己维护
 *   `let observer: MutationObserver | null` 这类状态，也就不会漏断开。
 *
 * 只管「可断开对象」而不是只管 MutationObserver：`ResizeObserver` 同样有 `disconnect()`，
 * 而且它最容易踩「盯住被替换的旧节点」这个坑（本项目 sidebar 的内栏宽度观察就是这么漏的）。
 *
 * 注意：**全站仍只有一个 childList+subtree 观察器**（`lib/dom-watch.ts`，见
 * docs/architecture.md 不变量）。本模块用来管「挂在具体节点上的窄观察器」——
 * 属性过滤 / 单节点 childList / ResizeObserver，不要拿它去加第二个全树观察器。
 */

/** 任何能断开的观察器（MutationObserver / ResizeObserver / IntersectionObserver …） */
export interface Disconnectable {
  disconnect(): void;
}

export interface ObserverScope {
  /** 作用域名字，用于日志与验证脚本辨认 */
  readonly label: string;
  /** 观察节点上的 MutationObserver（同名重复登记会先断开旧的） */
  observe(
    target: Node,
    name: string,
    callback: MutationCallback,
    mutations?: MutationObserverInit,
  ): MutationObserver;
  /** 登记任意可断开对象（同名重复登记会先断开旧的），返回对象本身便于链式使用 */
  track<T extends Disconnectable>(name: string, observer: T): T;
  /** 断开并移除一个登记项 */
  disconnect(name: string): void;
  /** 断开并移除全部登记项 */
  disconnectAll(): void;
}

export function createObserverScope(label: string): ObserverScope {
  const items = new Map<string, Disconnectable>();

  /** 断开旧项并让位给新项；同步重复登记同一个对象时保持原样（幂等） */
  function track<T extends Disconnectable>(name: string, observer: T): T {
    const previous = items.get(name);
    if (previous === observer) return observer;
    if (previous) {
      items.delete(name);
      try {
        previous.disconnect();
      } catch (error) {
        console.error(`[twitter-enhancer] 断开 ${label}/${name} 观察器失败`, error);
      }
    }
    items.set(name, observer);
    return observer;
  }

  function disconnect(name: string): void {
    const item = items.get(name);
    if (!item) return;
    items.delete(name);
    try {
      item.disconnect();
    } catch (error) {
      console.error(`[twitter-enhancer] 断开 ${label}/${name} 观察器失败`, error);
    }
  }

  return {
    label,
    observe(target, name, callback, mutations = { childList: true }) {
      const observer = new MutationObserver(callback);
      const rawDisconnect = observer.disconnect.bind(observer);
      let disconnected = false;
      // 断开时把自己从登记表里摘掉（否则表里留着一个已经断开的尸体，
      // 下一次同名登记会去 disconnect 它 —— 无害，但会让「谁还活着」变得不可信）
      observer.disconnect = () => {
        if (disconnected) return;
        disconnected = true;
        rawDisconnect();
        if (items.get(name) === observer) items.delete(name);
      };
      track(name, observer);
      observer.observe(target, mutations);
      return observer;
    },
    track,
    disconnect,
    disconnectAll() {
      for (const name of [...items.keys()]) disconnect(name);
    },
  };
}
