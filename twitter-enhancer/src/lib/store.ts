/**
 * 开关状态持久化。
 *
 * 写入：GM 存储与 localStorage **双写**——曾出现「GM_setValue 调用成功但刷新后读不回」
 * 的环境差异（脚本猫的 GM 行为与 Tampermonkey 不完全一致），单写 GM 会导致开关每次刷新失效。
 * 读取：GM 与 localStorage 都尝试，两边只要有一处写过即可恢复。
 * 兼容：localStorage 里旧版本写过 'on' / 'off' 格式的值，读取时一并识别。
 */
import { GM_getValue, GM_setValue } from '$';

const KEY_PREFIX = 'twitter-enhancer:';

function gmAvailable(): boolean {
  return typeof GM_getValue === 'function' && typeof GM_setValue === 'function';
}

/** 把任意存储值解析为布尔；解析不了返回 null */
function parseValue(value: unknown): boolean | null {
  if (typeof value === 'boolean') return value;
  if (value === 'true' || value === 'on') return true;
  if (value === 'false' || value === 'off') return false;
  return null;
}

/** 读取开关，未设置过返回 null */
export async function readFlag(name: string): Promise<boolean | null> {
  const key = KEY_PREFIX + name;
  if (gmAvailable()) {
    try {
      const parsed = parseValue(await GM_getValue(key, null));
      if (parsed !== null) return parsed;
    } catch {
      // 脚本管理器存储不可用时继续读 localStorage
    }
  }
  try {
    return parseValue(localStorage.getItem(key));
  } catch {
    return null;
  }
}

/** 写入开关（GM 与 localStorage 双写，不提前 return） */
export async function writeFlag(name: string, value: boolean): Promise<void> {
  const key = KEY_PREFIX + name;
  if (gmAvailable()) {
    try {
      await GM_setValue(key, value);
    } catch {
      // GM 写失败时 localStorage 仍可兜底
    }
  }
  try {
    localStorage.setItem(key, String(value));
  } catch {
    // 隐私模式下忽略
  }
}
