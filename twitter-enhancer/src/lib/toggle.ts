/**
 * 持久化开关 —— 「一个设置项」的完整生命周期，只在这里实现一次。
 *
 * ## 为什么要有这个模块
 *
 * 从前每个功能各自抄一遍同一条协议：默认值 → 异步 hydrate（`readFlag().then`）→
 * 写属性生效 → 写盘 → `notifySettingsChanged()` → 组装七个字段的 `registerSetting`。
 * 七个开关抄了七遍，于是「协议」本身只存在于七份副本里：写盘与广播的先后、
 * 首帧渲染与存储读取的关系、面板开关方向与存储值方向是否一致，全靠每一份各自记得。
 * 已经因此漂出过分歧（右栏开关只在该属性真的变化时才广播 `te:layout`；媒体钳制切换要
 * 额外做一次全量对账；推文新样式的切换不重跑主题与令牌）—— 那些分歧都是对的，
 * 但在没有共享协议时**它们是看不见的**：谁也不知道别人的那一条是不是也这么写。
 *
 * 现在功能只提供一个 `apply(值)`。值怎么来、什么时候写盘、什么时候让面板刷新，
 * 全部由这里负责；新增一个开关 = 一次 `createToggle()`。
 *
 * ## 生命周期（顺序是有意的，与旧实现逐条对应）
 *
 * 1. 构造时立刻用**默认值** `apply` 一次 —— 首帧就要有正确布局，不能等异步存储；
 * 2. 立刻 `registerSetting()` —— 面板最后启用，读的就是这张注册表（见 features/index.ts）；
 * 3. 异步读到用户设置后，与当前值不同再 `apply` 一次**并广播** —— 面板那时可能已经挂起来了
 *    （旧实现漏了这一步，存储值与面板显示会短暂不一致，直到下一次有人切换开关）。
 *
 * ## 存储 key 与历史取值语义都不能改
 *
 * key 默认等于 id（历史实现里两者恰好同名），那是用户机器上已经写下的数据。
 * `sidebar` 的存储值是「右栏隐藏」，而面板问的是「显示右侧栏」——方向相反，
 * 用 `isEnabled` 翻转**面板语义**，而不是去翻转存储值。
 */
import { notifySettingsChanged, registerSetting } from './settings';
import { readFlag, writeFlag } from './store';

export interface ToggleSpec {
  /** 稳定 id：同时是面板 DOM 的 `data-te-setting` 与默认存储 key */
  id: string;
  /** 分组小标题：同名分组在面板里合并成一段（顺序按首次出现） */
  group: string;
  label: string;
  description: string;
  /** 键盘快捷键提示（可选，如 'Alt+U'） */
  shortcut?: string;
  /** 默认值（通常来自 CONFIG）；首帧先按它渲染 */
  default: boolean;
  /**
   * 值变化时生效 —— 构造时的初始值也会走一次。
   * 功能在这里写 `html[data-te-*]` 属性 / 重算布局 / 打标记，不要在这里读面板。
   */
  apply: (value: boolean) => void;
  /**
   * 面板开关方向：把内部值映射成「开关是否打开」。默认恒等。
   * 只在存储值语义与面板语义相反时传（当前只有 `sidebar`，见文件头）。
   */
  isEnabled?: (value: boolean) => boolean;
  /** 存储 key；默认与 id 相同（显式传参只为将来能分叉） */
  flag?: string;
}

export interface Toggle {
  readonly id: string;
  /** 面板语义下的开关状态 */
  isEnabled(): boolean;
  /** 设为指定值；与当前值相同时什么都不做（幂等，避免多余重算） */
  set(value: boolean): void;
  /** 翻转（面板点击与页面快捷键共用这一条路径） */
  toggle(): void;
}

export function createToggle(spec: ToggleSpec): Toggle {
  const key = spec.flag ?? spec.id;
  const display = spec.isEnabled ?? ((value: boolean): boolean => value);
  let value = spec.default;
  /**
   * 用户是否已经手动切换过。
   * 存储读取是异步的（脚本管理器可能返回 Promise）；如果用户在它落地之前就点了开关，
   * 那份**旧值**不该把用户刚做的选择覆盖掉 —— 而用户的选择已经写回存储了，
   * 所以这时直接放弃 hydrate 就是正确的。
   */
  let touched = false;

  const set = (next: boolean): void => {
    if (next === value) return;
    touched = true;
    value = next;
    spec.apply(next);
    void writeFlag(key, next);
    notifySettingsChanged();
  };

  // 首帧：默认值先渲染一次，再把这一行登记进设置面板
  spec.apply(value);
  registerSetting({
    id: spec.id,
    group: spec.group,
    label: spec.label,
    description: spec.description,
    shortcut: spec.shortcut,
    isEnabled: () => display(value),
    toggle: () => set(!value),
  });

  // 存储读取是异步的（GM 与 localStorage 双写，见 lib/store.ts）：读到用户设置后覆盖一次
  void readFlag(key).then((stored) => {
    if (touched || stored === null || stored === value) return;
    value = stored;
    spec.apply(stored);
    notifySettingsChanged();
  });

  return {
    id: spec.id,
    isEnabled: () => display(value),
    set,
    toggle: () => set(!value),
  };
}
