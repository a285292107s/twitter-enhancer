# 运行时架构

改这块之前先读对应的源码头注释 —— 不变量和「为什么」都写在文件里，本文只做索引与红线。

## 启动链路

```
main.ts
├─ startDomWatch()    lib/dom-watch.ts   全站唯一 childList+subtree 观察器，派发 te:layout
├─ startRouteWatch()  lib/spa-route.ts   hook history API，派发 te:route
└─ for features       features/index.ts  按注册顺序 enable()
```

各功能只订阅事件、不自己 `new MutationObserver(document.documentElement)`。新增共享观察入口时也
收敛到这两个单例里（X 的虚拟滚动会让节点高频增删，观察器一多就是重复派发 + 掉帧）。

## 不变量

- **单一布局门控点**：`html[data-te-timeline='wide']` 一个属性同时决定三件事是否生效 ——
  CSS 宽度覆盖（`src/features/timeline-width.css`）、媒体高度钳制（`src/features/media-cap.ts` 的 `isActive()`）、
  宽度解锁器（`src/lib/unlock-width.ts` 的 `isActive()`）。所以「宽列不适用」的判定**只允许写在一处**
  （`src/features/timeline-width.ts`），撤销路径统一走 `disableTimelineLayout()`；不要在 CSS 里加 `:not()`、
  也不要在各模块里重复排除条件。
- **只放宽、从不收窄**：主列已经宽于目标时不碰（兜底判据 `alreadyWiderThanTarget()`）。
  必须在写 `data-te-timeline='wide'` **之前**读宽度 —— 那时 CSS 还没生效，读到的才是原生宽度。
- **适用页面按 DOM 结构判**：主列所在行里有右栏兄弟节点才算三栏页面，`/i/grok`（980 单栏）
  与 `/i/chat`（1187 双栏）交回 X 原生。不要改用「主列当前宽度」判据：SPA 切到 grok 时新主列
  会先以非原生宽度挂载，宽度判据在那一个瞬间会把它钉成 800。
- **左导航条不写任何样式**：X 自己的 fixed 定位已经与主列左缘对齐（`/home` 与 `/i/grok` 逐像素一致），
  覆盖它会让两个页面走两套摆放机制。
- **不移动/不重建 React 管理的节点**（除了 `CONFIG.search.mode = 'move'` 这条已知有风险的路径）。
  自建节点用 `te-` 前缀的 class 与 `data-te-*` 标记，撤销时按标记清理（注意 dataset 驼峰会转成
  连字符，选择器写 `[data-te-media-capped]` 而不是 `[data-teMediaCapped]`）。

## 已修掉的坑（别人已经踩过，别再踩）

- **SPA 导航闪烁**：切路由时 X 整棵重挂 app shell，功能写在旧节点上的内联样式随之丢失。
  锚点节点身份变化必须在 MO 回调里**同步**冲刷（早于渲染帧），等 120ms 节流就会出现
  「主列左移又回弹、左栏跳位」。
- **`/i/chat` 会 302**：`/messages` 跳到 `/i/chat/*`，其主列原生 1187px，旧逻辑的「放宽到 800」
  会把它压窄。路由判定要放在最前（不等主列挂载就先撤销开关），避免导航中聊天列被宽列样式画一帧。
- **document-start 时序**：`document.head` / `documentElement` 可能还没生成，样式无处可挂；
  真 TM 与 e2e 的注入位都在这时，必须先排队、等根节点出现再补挂。
- **主题检测**：document-start 时页面可能还是透明背景，不能据此误判成暗色主题。
- **后台标签页**：rAF 被冻结、定时器被压到 1s 甚至 1/min，所以调度器用 `setTimeout` 节流并在
  `visibilitychange` 回前台时补一次冲刷；长循环探测在这种环境下必然超时。
- **旧实现的教训**：「向上爬祖先找宿主」这类启发式必须考虑同一子树多次命中不同层级造成的
  叠加副作用（曾经的媒体双层缩放就是这么来的）。
