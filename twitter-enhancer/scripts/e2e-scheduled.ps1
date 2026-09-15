# 漂移探测器：定期在真实 x.com 上跑一遍门禁。
#
# 为什么需要它：`npm run verify` 跑的是**我们自己的 jsdom 夹具** —— X 改锚点、改结构，
# 它一条断言都不会红。唯一能发现「X 改版导致功能静默失效」的检测器是
# `scripts/e2e-real.mjs`（真实布局引擎 + 当前 DOM），而它只在有人敲命令时才跑。
# 这个脚本就是让它定时跑起来的那一层；Windows 计划任务的注册方式见
# docs/browser-automation.md「定时漂移探测」。
#
# 先 verify 再 e2e，是为了**归因**：verify 红 = 我们自己的代码/夹具坏了；
# verify 绿而 e2e 红 = X 漂移，或登录态过期（两者都会留下日志与 LAST-FAILURE.txt）。
#
# 退出码：0 全绿，1 有失败（计划任务的「上次运行结果」即据此显示）。

$ErrorActionPreference = 'Continue'

$root = Split-Path -Parent $PSScriptRoot                                    # twitter-enhancer/
$logDir = Join-Path (Split-Path -Parent $root) 'browser-profiles\e2e-logs'  # 仓库根，已 gitignore
New-Item -ItemType Directory -Force -Path $logDir | Out-Null

$stamp = Get-Date -Format 'yyyy-MM-dd-HHmm'
$log = Join-Path $logDir "e2e-$stamp.log"

Push-Location $root
try {
  "=== $stamp  verify ===" | Tee-Object -FilePath $log
  npm run verify 2>&1 | Tee-Object -FilePath $log -Append
  $verifyOk = $LASTEXITCODE -eq 0

  "=== $stamp  e2e:real ===" | Tee-Object -FilePath $log -Append
  npm run e2e:real 2>&1 | Tee-Object -FilePath $log -Append
  $e2eOk = $LASTEXITCODE -eq 0
} finally {
  Pop-Location
}

# 只留最近 20 份日志，避免无限增长
Get-ChildItem $logDir -Filter 'e2e-*.log' |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip 20 |
  Remove-Item -Force -ErrorAction SilentlyContinue

$marker = Join-Path $logDir 'LAST-FAILURE.txt'
if ($verifyOk -and $e2eOk) {
  Remove-Item $marker -Force -ErrorAction SilentlyContinue
  exit 0
}

# 失败要在「下次打开这个目录时」看得见，而不是只躺在计划任务历史里
@(
  "$stamp 失败：verify=$verifyOk e2e=$e2eOk"
  "日志：$log"
  if ($verifyOk -and -not $e2eOk) { '（verify 绿而 e2e 红 ⇒ 先排查 X 漂移与 x-te-e2e 登录态）' }
) | Set-Content -Path $marker
exit 1
