/**
 * 按开关 / 配置拼装的样式表（做法取自社区标准实现 control-panel-for-twitter 的
 * `addStyle(css)` + 各 `configureXxxCss()`：规则先 push 进数组，再 `style.textContent = css`）。
 *
 * ## 什么规则该放这里
 *
 * 判断标准只有一条：**规则的取值来自 CONFIG 或运行时测量**。
 * 典型是「CSS 里写死 55px，config.ts 里也写着 55」这种双份事实 —— 两份迟早会漂。
 * 放进这里之后 `config.ts` 是唯一事实来源，改配置即重建样式表。
 *
 * ## 什么规则**不该**放这里（本项目的取舍，与参考项目不同）
 *
 * 1. **开关门控**不用「删规则 / 加规则」，而是继续用单一属性
 *    （`html[data-te-timeline='wide']` 等）。参考项目按开关拼 CSS 文本是因为它的开关
 *    也要控制「有没有这条规则」；本项目的门控已有唯一入口，属性方案还能避免
 *    「JS 没跑起来时 CSS 已经生效 / JS 跑起来后 CSS 才生效」的时序裂缝
 *    （见 docs/architecture.md 不变量「单一布局门控点」）。
 * 2. **首屏就必须生效的令牌**不放这里。document-start 注入时 `<head>` 可能还不存在，
 *    运行时样式表最快也只能挂到 `documentElement`（本模块会这么做，并在 head 就绪后
 *    搬进去），但首帧渲染仍可能早于 JS 执行 —— 正文令牌这类东西继续走
 *    `style.setProperty('--te-*')` 写在 `:root` 上（见 features/tweet-ui.ts）。
 *
 * ## 用法
 *
 * ```ts
 * const sheet = createStyleSheet('settings-fab')
 * sheet.set(`.te-settings-fab { width: ${CONFIG.settings.fab.size}px }`)
 * sheet.remove()   // 功能关闭 / 还原
 * ```
 *
 * 同一个 id 重复 `createStyleSheet` 返回同一个句柄（幂等，避免重复挂载时留多个 style 节点）。
 */

export interface StyleSheetHandle {
  /** 用新的规则文本替换整个样式表；空串等价于 `remove()` */
  set(css: string): void;
  /** 移除样式表（句柄仍然可用：再次 `set()` 会按同一个 id 重新挂载） */
  remove(): void;
}

const STYLE_ATTR = 'data-te-style';
const registry = new Map<string, StyleSheetHandle>();

/** document-start 时 head 还不存在：先挂到 documentElement，head 就绪后再搬进去 */
function mount(id: string): HTMLStyleElement | null {
  const root = document.documentElement;
  if (!root) return null; // 极端早期：连 html 都没有，交给 set() 的下一次调用
  const style = document.createElement('style');
  style.setAttribute(STYLE_ATTR, id);
  if (document.head) {
    document.head.appendChild(style);
    return style;
  }
  root.appendChild(style);
  const moveToHead = (): void => {
    if (style.isConnected && document.head && style.parentElement !== document.head) {
      document.head.appendChild(style);
    }
  };
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', moveToHead, { once: true });
  } else {
    moveToHead();
  }
  return style;
}

export function createStyleSheet(id: string): StyleSheetHandle {
  const existing = registry.get(id);
  if (existing) return existing;

  let element: HTMLStyleElement | null = null;
  /** 待写入的规则：document-start 时连 `<html>` 都可能还没生成，此时先把文本留着 */
  let pending = '';
  let retryScheduled = false;

  const apply = (): void => {
    if (!pending) return;
    if (!element) element = mount(id);
    if (!element) return; // 还没有落点，交由 DOMContentLoaded 重试
    if (element.textContent !== pending) element.textContent = pending;
  };

  const handle: StyleSheetHandle = {
    set(next: string): void {
      pending = next;
      if (!next) {
        handle.remove();
        return;
      }
      apply();
      if (!element && !retryScheduled) {
        retryScheduled = true;
        const retry = (): void => {
          retryScheduled = false;
          apply();
        };
        if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', retry, { once: true });
        else setTimeout(retry, 0);
      }
    },
    remove(): void {
      pending = '';
      if (element) {
        element.remove();
        element = null;
      }
      // 句柄继续留在注册表里：功能关闭后再开启时会复用同一个句柄重新挂载，
      // 若在这里 delete，重新 createStyleSheet(id) 会造出第二个 style 节点。
    },
  };

  registry.set(id, handle);
  return handle;
}
