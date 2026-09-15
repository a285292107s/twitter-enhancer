/**
 * 帧任务队列 —— 「DOM 批次回调只收集，真正的工作放到下一个渲染帧」的唯一实现。
 *
 * ## 为什么要有这个模块
 *
 * 这套模板只有三行（一个 `frameQueued` 标志 + rAF 合并 + 没有 rAF 时的 setTimeout 回退），
 * 所以「就地抄一遍」看不出问题；但模板里那两条判断都是有牙齿的：
 *
 * 1. **同一帧内只跑一次** —— 一批 120ms 的 DOM 变更可能塞进几十个待处理单元，
 *    每个都同步测量就是几十次强制 layout（滚动掉帧的主因，见 media-cap 的文件头）；
 * 2. **没有 requestAnimationFrame 时要退回 setTimeout**（非浏览器环境 / 老引擎）。
 *
 * 代价不在行数，而在「下一个写第五条队列的人会漏掉哪一条」——漏掉第 1 条是掉帧，
 * 漏掉第 2 条是功能在特定环境下彻底不生效。
 *
 * ## 用法
 *
 * ```ts
 * const queue = createFrameQueue('media-cap')
 * queue.schedule('seeds', runFrameWork)        // 同 key 重复排队只保留最后一次
 * queue.schedule(someElement, () => work(el))  // key 可以是任意对象：按元素去重
 * ```
 *
 * key 是**去重身份**而不是顺序：同一帧里对同一个 key 排两次，只有最后一次的 work 会跑。
 * 这正是各处需要「后到的状态覆盖先到的」时想要的语义（例如轮播序号：同一个列表
 * 在同一帧里被滚动事件更新多次，只需按最后的位置算一次）。
 *
 * ## 与相邻模块的分工
 *
 * - `lib/dom-watch.ts` 决定「什么时候有一批变更」（120ms 节流 + 锚点被替换时同步冲刷）；
 *   本模块决定「这批变更引起的测量/写样式放到哪一帧」。两者都只属于调度层。
 * - `lib/wait-for.ts` 不用本模块：它要的是**反复轮询直到条件成立**，而不是「一帧内
 *   合并一次工作」；后台标签页里 rAF 被完全冻结，所以它必须自己退回 setTimeout 轮询
 *   （见该文件「后台标签页 rAF 被完全冻结」）。
 * - 后台标签页里本模块的 rAF 同样不会触发，待办会留在队列里等回前台后的第一帧 ——
 *   这是可接受的：后台不渲染，不需要按帧对齐；各功能回前台时另有整树补扫
 *   （`visibilitychange` 订阅）兜底。
 */

/** 没有 requestAnimationFrame 时的兜底帧间隔（ms） */
const FALLBACK_FRAME_MS = 16;

export interface FrameQueue {
  /**
   * 把一项工作排进下一个渲染帧。
   * @param key 去重身份（字符串 / 元素 / 任何对象）：同 key 已排队时**替换**为这次的 work。
   * @param work 帧任务。抛错只记日志，不影响同批其它任务。
   */
  schedule(key: unknown, work: () => void): void;
}

export function createFrameQueue(label: string): FrameQueue {
  const jobs = new Map<unknown, () => void>();
  let frameQueued = false;

  const run = (): void => {
    // 先解锁再执行：任务自己又排了新工作（例如分类时又生成一批种子）时能排进下一帧
    frameQueued = false;
    const batch = [...jobs.values()];
    jobs.clear();
    for (const work of batch) {
      try {
        work();
      } catch (error) {
        console.error(`[twitter-enhancer] ${label} 帧任务执行失败`, error);
      }
    }
  };

  return {
    schedule(key: unknown, work: () => void): void {
      jobs.set(key, work);
      if (frameQueued) return;
      frameQueued = true;
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(run);
      else setTimeout(run, FALLBACK_FRAME_MS);
    },
  };
}
