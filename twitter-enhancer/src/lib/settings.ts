/**
 * 设置项注册表 —— 页内设置面板（features/settings-panel.ts）的数据源。
 *
 * 旧版每个功能各自用 GM_registerMenuCommand 往油猴菜单里挂一条「xxx：开 / 关」：
 * 改个开关要先点开脚本管理器，菜单项只能是一行纯文本（写不下说明、也没法分组），
 * 而且菜单文案要「先注销再重注册」才能跟着状态刷新。现在功能把开关登记到这张表，
 * 页内面板统一渲染成弹窗里的开关行；面板只读这张表，不反向依赖任何功能模块 ——
 * 新增功能只要 registerSetting 一条，就自动出现在设置里。
 *
 * 状态刷新：开关可能从面板点击切换，也可能从页面快捷键（Alt+U / Alt+B）切换，
 * 两条路径都经过 notifySettingsChanged()，面板据此同步开关的 aria-checked。
 *
 * **新增开关不要直接调 registerSetting**：走 `lib/toggle.ts` 的 `createToggle()` ——
 * 它把「默认值 / 异步存储读取 / 写盘 / 面板刷新」和这里的登记一起包成一条协议。
 * 本模块只负责「登记 + 广播」这一层，面板是它唯一的消费者。
 */

export interface SettingItem {
  /** 稳定 id：同时用作面板 DOM 的 data-te-setting 与验证脚本的锚点 */
  id: string;
  /** 分组小标题：同名分组在面板里合并成一段（顺序按首次出现） */
  group: string;
  /** 开关名 */
  label: string;
  /** 一句话说明「开了会怎样」，不写「是否…」式问句 */
  description: string;
  /** 键盘快捷键提示（可选，如 'Alt+U'） */
  shortcut?: string;
  /** 当前是否开启 */
  isEnabled: () => boolean;
  /** 切换开关（功能自己负责生效与持久化） */
  toggle: () => void;
}

const items: SettingItem[] = [];
const listeners = new Set<() => void>();

/** 登记一个设置项（同 id 重复登记时覆盖，保证重复 enable 幂等） */
export function registerSetting(item: SettingItem): void {
  const index = items.findIndex((existing) => existing.id === item.id);
  if (index >= 0) items[index] = item;
  else items.push(item);
  notifySettingsChanged();
}

/** 当前登记的全部设置项（面板按登记顺序渲染） */
export function getSettings(): readonly SettingItem[] {
  return items;
}

/** 订阅设置项变化（面板挂载时调用一次即可，返回取消函数） */
export function onSettingsChanged(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * 广播「设置项或其状态变了」。
 * 功能在每次 toggle 后调用（面板点击与页面快捷键都覆盖），面板收到后重绘。
 * 单个订阅方抛错不影响其它订阅方。
 */
export function notifySettingsChanged(): void {
  for (const listener of [...listeners]) {
    try {
      listener();
    } catch (error) {
      console.error('[twitter-enhancer] 设置面板刷新失败', error);
    }
  }
}
