/**
 * 订阅覆盖审计：逐条摘掉一个事件订阅，跑 jsdom 门禁，回答「摘掉它，门禁还红不红」。
 *
 * ## 判据
 *
 * - 变红 ⇒ 这条接线**被门禁覆盖**，是承重的（脚本会记下第一个失败的断言名，那就是它的保护场景）；
 * - 保持绿 ⇒ 门禁**看不见**它。注意这**不等于多余**：多数接线走的是真实浏览器里才有的路径
 *   （tab 切换、视口变化、字体就绪、回前台、SPA 导航），jsdom 根本走不到。
 *   绿的含义是「没测到」，不是「不需要」。2026-09-15 的实测结论与用法见
 *   docs/development.md「事件接线的门禁覆盖现状」。
 *
 * ## 安全约束（改这个脚本前先读）
 *
 * 它靠 `git checkout -- <文件>` 还原实验补丁，所以**要求工作树干净**（脚本自己会检查并拒绝运行）。
 * 中断（Ctrl-C / 超时）可能留下一个 `if (false) ` 补丁：`git status` 一眼可见，
 * `git checkout -- src/features` 即可还原。
 *
 * ## 行号会漂
 *
 * 实验表按**行号**定位，并校验该行包含预期片段；对不上就报 SKIP（不会静默跳过）。
 * 所以每次动过这几个功能文件的行数，先重跑一次、把漂了的行号改对。
 *
 * 用法：node scripts/audit-subscriptions.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// 仓库路径含中文：URL.pathname 会百分号编码，必须走 fileURLToPath
const ROOT = fileURLToPath(new URL('..', import.meta.url));

/** [id, 文件, 行号(1-based), 该行必须包含的片段] */
const EXPERIMENTS = [
  ['cc-domcontentloaded', 'content-column.ts', 295, "DOMContentLoaded', scheduleFullScan"],
  ['cc-load', 'content-column.ts', 297, "addEventListener('load', scheduleFullScan"],
  ['cc-layout', 'content-column.ts', 313, "addEventListener('te:layout'"],
  ['cc-route', 'content-column.ts', 316, 'onRouteChanged('],
  ['cc-timeline', 'content-column.ts', 322, 'onTimelineChanged('],
  ['mc-domcontentloaded', 'media-cap.ts', 636, "DOMContentLoaded', reconcileMediaCap"],
  ['mc-load', 'media-cap.ts', 638, "addEventListener('load', reconcileMediaCap"],
  ['mc-layout', 'media-cap.ts', 658, "addEventListener('te:layout', onLayout"],
  ['mc-route', 'media-cap.ts', 659, 'onRouteChanged(onLayout'],
  ['mc-media-load', 'media-cap.ts', 675, "addEventListener('load', onMediaLoad, true"],
  ['mc-media-loadeddata', 'media-cap.ts', 676, "'loadeddata'"],
  ['mc-resize', 'media-cap.ts', 678, "addEventListener('resize', scheduleReconcile"],
  ['mc-visibility', 'media-cap.ts', 680, "'visibilitychange'"],
  ['sb-domcontentloaded', 'sidebar.ts', 481, "DOMContentLoaded', sync"],
  ['sb-load', 'sidebar.ts', 484, "addEventListener('load', sync"],
  ['sb-route', 'sidebar.ts', 521, 'onRouteChanged'],
  ['sb-layout', 'sidebar.ts', 525, "addEventListener('te:layout', applySidebarGap"],
  ['tw-domcontentloaded', 'timeline-width.ts', 365, "DOMContentLoaded', scheduleLayout"],
  ['tw-load', 'timeline-width.ts', 367, "addEventListener('load', scheduleLayout"],
  ['tw-resize', 'timeline-width.ts', 368, "addEventListener('resize', scheduleLayout"],
  ['tw-layout', 'timeline-width.ts', 370, "addEventListener('te:layout', scheduleLayout"],
  ['tw-route', 'timeline-width.ts', 373, 'onRouteChanged'],
  ['tw-page', 'timeline-width.ts', 376, 'onPageKindChanged'],
  ['tu-load', 'tweet-ui.ts', 163, "addEventListener('load', () => publishSpine"],
  ['tu-fonts', 'tweet-ui.ts', 165, 'fonts?.ready'],
  ['tu-domcontentloaded', 'tweet-ui.ts', 174, "DOMContentLoaded', applyTheme"],
];

const run = (cmd, args) => spawnSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf8' });

const dirty = run('git', ['status', '--porcelain']).stdout.trim();
if (dirty) {
  console.error('工作树不干净，拒绝运行（本脚本用 git checkout 还原实验补丁，会冲掉你的改动）：\n' + dirty);
  process.exit(2);
}

const results = [];
for (const [id, file, lineNo, needle] of EXPERIMENTS) {
  const path = `src/features/${file}`;
  run('git', ['checkout', '--', path]);

  const lines = readFileSync(join(ROOT, path), 'utf8').split('\n');
  const target = lines[lineNo - 1];
  if (!target || !target.includes(needle)) {
    results.push({ id, verdict: 'SKIP', detail: `第 ${lineNo} 行与预期不符：${JSON.stringify(target)}` });
    console.log(`SKIP  ${id}（行号漂了，请更新实验表）`);
    continue;
  }
  lines[lineNo - 1] = target.replace(/^(\s*)/, '$1if (false) ');
  writeFileSync(join(ROOT, path), lines.join('\n'));

  const build = run('npm', ['run', 'build']);
  if (build.status !== 0) {
    const tsError = (build.stdout + build.stderr).split('\n').find((l) => l.includes('error TS')) ?? '构建失败';
    results.push({ id, verdict: 'TSC', detail: tsError.trim() });
    console.log(`TSC   ${id}  ← ${tsError.trim()}`);
  } else {
    const verify = run('node', ['scripts/verify.mjs']);
    const out = verify.stdout.split('\n');
    const firstFail = out.find((l) => l.startsWith('FAIL')) ?? '';
    const summary = out.find((l) => l.includes('项失败') || l.includes('全部通过')) ?? '';
    results.push({
      id,
      verdict: verify.status === 0 ? 'GREEN' : 'RED',
      detail: `${summary.trim()} ${firstFail.trim()}`.trim(),
    });
    console.log(`${verify.status === 0 ? 'GREEN' : 'RED  '} ${id}  ${summary.trim()}`);
    if (firstFail) console.log(`      ${firstFail.trim()}`);
  }
  run('git', ['checkout', '--', path]);
}

const outFile = join(tmpdir(), 'twitter-enhancer-audit-result.json');
writeFileSync(outFile, JSON.stringify(results, null, 2));

const red = results.filter((r) => r.verdict === 'RED');
console.log(`\n=== 汇总：${results.length} 条订阅点，门禁覆盖 ${red.length} 条 ===`);
for (const r of results) console.log(`${r.verdict.padEnd(6)} ${r.id.padEnd(22)} ${r.detail}`);
console.log(`\n完整结果：${outFile}`);
