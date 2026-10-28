# 学习助手 · 自检脚本（Windows PowerShell）
# 用法：右键 → 使用 PowerShell 运行；或
#   powershell -ExecutionPolicy Bypass -File doctor.ps1
# 出问题时把整段输出复制发给开发者（不含登录凭据）。

$ErrorActionPreference = "Continue"
try {
  $OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }
$Port = if ($env:CN_INTERPRETER_PORT) { $env:CN_INTERPRETER_PORT } else { 8791 }
$script:Fail = 0
$script:Warn = 0

function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [FAIL] $m" -ForegroundColor Red; $script:Fail++ }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:Warn++ }
function Info($m) { Write-Host "  . $m" -ForegroundColor Gray }

Write-Host "=============================================="
Write-Host " 学习助手 自检报告 (Windows)"
Write-Host " 时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=============================================="

Write-Host "`n[1] 系统"
Info "版本: $([System.Environment]::OSVersion.VersionString)"
Info "架构: $env:PROCESSOR_ARCHITECTURE"
try {
  $root = [System.IO.Path]::GetPathRoot($env:USERPROFILE)
  $drive = (Get-PSDrive -Name $root.Substring(0, 1)).Free / 1GB
  Info ("磁盘可用: {0:N1} GB" -f $drive)
} catch {
  Info "磁盘可用: 无法读取（可能是网络盘）"
}
$ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
Info "内存: $ram GB"

Write-Host "`n[2] Python"
$Py = $null
foreach ($c in @("python", "py")) {
  try {
    $v = & $c -c "import sys; print(sys.version.split()[0])" 2>$null
    if ($v) { $Py = $c; break }
  } catch { }
}
if (-not $Py) {
  Bad "找不到 Python。请装 python.org 版本并勾选 Add to PATH"
} else {
  Ok "解释器: $Py ($v)"
  & $Py -c "import sys; sys.exit(0 if sys.version_info >= (3,9) else 1)" 2>$null
  if ($LASTEXITCODE -eq 0) { Ok "版本 >= 3.9" } else { Bad "版本低于 3.9" }
}

Write-Host "`n[3] 安装目录"
if (Test-Path $Base) {
  Ok "目录存在: $Base"
  foreach ($d in @("secrets", "notes", "models", "pylibs")) {
    if (Test-Path (Join-Path $Base $d)) { Info "$d/ 在" } else { Warn "缺少 $d/" }
  }
} else {
  Bad "目录不存在: $Base（安装脚本没跑过？）"
}

Write-Host "`n[4] Python 依赖"
if ($Py -and (Test-Path (Join-Path $Base "pylibs"))) {
  $env:PYTHONPATH = Join-Path $Base "pylibs"
  foreach ($m in @("ctranslate2", "sentencepiece", "pypdf", "docx", "numpy")) {
    & $Py -c "import $m" 2>$null
    if ($LASTEXITCODE -eq 0) { Ok $m } else { Bad "$m 缺失" }
  }
  foreach ($m in @("faster_whisper")) {
    & $Py -c "import $m" 2>$null
    if ($LASTEXITCODE -eq 0) { Ok "$m（可选）" } else { Warn "$m 未安装（语音功能不可用）" }
  }
} else {
  Bad "无法检查依赖（Python 或 pylibs 缺失）"
}

Write-Host "`n[5] 模型文件"
foreach ($pair in @("en_zh", "zh_en")) {
  if (Test-Path (Join-Path $Base "models\$pair")) { Ok "翻译模型 $pair" } else { Bad "翻译模型 $pair 缺失（核心功能）" }
}
if (Test-Path (Join-Path $Base "models\whisper\models--Systran--faster-whisper-small.en")) {
  Ok "语音识别模型已下载"
} else {
  Warn "语音识别模型未下载（首次使用语音时会自动下载约 500MB）"
}
Info "精准翻译 7B 仅 macOS 支持，Windows 忽略"

Write-Host "`n[6] OCR 组件"
Info "Windows 版不含图片 / 扫描版 PDF 识别（需要另装 OCR 引擎）"

Write-Host "`n[7] 服务进程"
$procs = Get-CimInstance Win32_Process -Filter "Name like '%python%'" |
  Where-Object { $_.CommandLine -like "*serve_translate.py*" }
if ($procs) { Ok "进程在跑 (pid $($procs[0].ProcessId))" } else { Bad "没有进程在跑" }
$startupDir = [Environment]::GetFolderPath("Startup")
$hasVbs = Test-Path (Join-Path $startupDir "study-suite.vbs")
$hasCmd = Test-Path (Join-Path $startupDir "study-suite.cmd")
if ($hasVbs) { Ok "开机启动项已注册（隐藏窗口方式）" }
elseif ($hasCmd) { Warn "启动项是旧版 .cmd（开着控制台，关窗口会导致服务退出），建议重跑 install.ps1" }
else { Warn "没有开机启动项（重启后不会自动启动）" }
if (Test-Path (Join-Path $Base "run-service.cmd")) { Info "启动脚本: run-service.cmd" } else { Warn "缺少 run-service.cmd" }

Write-Host "`n[8] 端口与健康检查"
try {
  $health = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
  Ok "端口 $Port 有响应"
  Info "平台: $($health.platform)"
  Info ("能力: " + (($health.capabilities.PSObject.Properties | ForEach-Object { "$($_.Name)=$($_.Value)" }) -join ", "))
  Info "术语表: $($health.glossary.en_zh) 条"
} catch {
  Bad "端口 $Port 无响应（服务没起来）"
}

Write-Host "`n[9] 功能自测"
try {
  $body = '{"text":"The literature review must synthesise sources.","to":"zh","engine":"fast"}'
  $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/translate" -Method Post -ContentType "application/json" -Body $body -TimeoutSec 60
  if ($r.text) { Ok "翻译: $($r.text)" } else { Bad "翻译返回空" }
} catch { Bad "翻译失败: $($_.Exception.Message)" }

try {
  $body2 = '{"text":"In today digital landscape, effective communication plays a crucial role. Furthermore, technology transformed engagement. Moreover, media literacy matters."}'
  $d = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/aidetect" -Method Post -ContentType "application/json" -Body $body2 -TimeoutSec 120
  Ok "AI 检测: $($d.score) 分 ($($d.band))"
} catch { Warn "AI 检测失败: $($_.Exception.Message)" }

Write-Host "`n[10] CORS（面板上传文件依赖）"
try {
  $resp = Invoke-WebRequest -Uri "http://127.0.0.1:$Port/aidetect" -Method Options -TimeoutSec 10 `
    -Headers @{ "Origin" = "http://127.0.0.1:1234"; "Access-Control-Request-Headers" = "x-filename" } -UseBasicParsing
  if ($resp.Headers["Access-Control-Allow-Headers"] -match "x-filename") { Ok "预检允许 x-filename" } else { Bad "预检没放行 x-filename" }
} catch { Warn "无法检查预检: $($_.Exception.Message)" }

Write-Host "`n[11] 最近日志"
$log = Join-Path $Base "service.log"
if (Test-Path $log) {
  Get-Content $log -Tail 6 | ForEach-Object { Info $_ }
  # 只统计“最后一次启动之后”的重置，历史记录不应该一直挂着吓人
  $lines = Get-Content $log -ErrorAction SilentlyContinue
  $lastStart = -1
  for ($i = $lines.Count - 1; $i -ge 0; $i--) {
    if ($lines[$i] -match "listening on") { $lastStart = $i; break }
  }
  $recent = if ($lastStart -ge 0) { $lines[$lastStart..($lines.Count - 1)] } else { $lines }
  $resets = @($recent | Where-Object { $_ -match "ConnectionResetError|WinError 10054" }).Count
  if ($resets -gt 0) {
    Info "本次启动后有 $resets 条连接重置记录（面板取消请求导致，不影响使用）"
  } else {
    Info "本次启动后没有连接重置记录"
  }
} else { Info "没有日志文件: $log" }

Write-Host "`n[12] 提醒任务（截止 / 上课推送）"
$remindTask = Get-ScheduledTask -TaskName "StudySuiteRemind" -ErrorAction SilentlyContinue
$prefFile = Join-Path $Base "remind.json"
$pref = $null
if (Test-Path $prefFile) {
  try { $pref = (Get-Content $prefFile -Raw | ConvertFrom-Json).enabled } catch { $pref = $null }
}
if ($remindTask) {
  $info = Get-ScheduledTaskInfo -TaskName "StudySuiteRemind" -ErrorAction SilentlyContinue
  Ok "计划任务已注册（每 5 分钟）"
  if ($info -and $info.LastRunTime) { Info "上次运行: $($info.LastRunTime)" }
  if ($info -and $info.LastTaskResult -ne 0) { Warn "上次运行结果码: $($info.LastTaskResult)" }
} elseif ($pref -eq $false) {
  Info "提醒已被你关闭（$prefFile 记着这个选择），重装也不会自动开"
  Info "恢复：powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Force"
} else {
  Warn "没有注册提醒任务；需要的话运行 remind-windows.ps1"
}
$remindLog = Join-Path $Base "remind.log"
if (Test-Path $remindLog) {
  $tail = Get-Content $remindLog -Tail 3 -ErrorAction SilentlyContinue
  if ($tail) { $tail | ForEach-Object { Info "_ $_" } }
}

Write-Host "`n=============================================="
if ($script:Fail -eq 0) {
  Write-Host " 结论：全部通过（$script:Warn 项警告）" -ForegroundColor Green
} else {
  Write-Host " 结论：$script:Fail 项失败，$script:Warn 项警告" -ForegroundColor Red
}
Write-Host " 把以上全部内容复制发给开发者即可"
Write-Host "=============================================="
Read-Host "按回车关闭"
