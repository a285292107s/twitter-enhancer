/**
 * 油猴菜单开关。
 *
 * GM_registerMenuCommand 注册的菜单文字是静态的，而开关需要显示当前状态，
 * 因此每次切换后先注销旧项再重新注册（GM_unregisterMenuCommand 不可用时退化为固定文案）。
 */
import { GM_registerMenuCommand } from '$';

declare const GM_unregisterMenuCommand: ((id: number | string) => void) | undefined;

export interface ToggleMenuOptions {
  /** 菜单文案，参数 enabled 为当前是否处于「开启」状态 */
  label: (enabled: boolean) => string;
  isEnabled: () => boolean;
  /** 切换状态（内部会在切换后刷新菜单文案） */
  toggle: () => void;
}

export function registerToggleMenu({ label, isEnabled, toggle }: ToggleMenuOptions): void {
  if (typeof GM_registerMenuCommand !== 'function') return;

  let id: number | string | undefined;
  const refresh = (): void => {
    if (id !== undefined && typeof GM_unregisterMenuCommand === 'function') {
      GM_unregisterMenuCommand(id);
    }
    id = GM_registerMenuCommand(label(isEnabled()), () => {
      toggle();
      refresh();
    });
  };
  refresh();
}
