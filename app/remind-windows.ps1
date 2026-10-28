# 学习助手 · Windows 提醒任务（截止 / 上课推送）
#
#   powershell -ExecutionPolicy Bypass -File remind-windows.ps1            安装（每 5 分钟检查一次）
#   powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Test      只跑一次，打印会推什么
#   powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Remove    移除任务
#
# 需要先装好服务（install.ps1）。任务用 pythonw.exe，不弹控制台窗口。
param(
  [switch]$Remove,
  [switch]$Test,
  [switch]$Force      # 忽略 remind.json 里记住的「已关闭」，强制装回来
)

$ErrorActionPreference = "Stop"
try {
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }
$TaskName = "StudySuiteRemind"
$RemindPy = Join-Path $Base "remind.py"
$RunCmd = Join-Path $Base "run-remind.cmd"
$LogFile = Join-Path $Base "remind.log"
# 记住用户的选择：删过就一直是关，除非再跑一次本脚本
$PrefFile = Join-Path $Base "remind.json"

function ConvertTo-Crlf($text) {
  if ($text -match "(?<!`r)`n") { $text = $text -replace "(?<!`r)`n", "`r`n" }
  if (-not $text.EndsWith("`r`n")) { $text += "`r`n" }
  return $text
}

function Unregister-RemindTask([switch]$Quiet) {
  $existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    if (-not $Quiet) { Write-Host "== 已移除计划任务 $TaskName" }
    return $true
  }
  if (-not $Quiet) { Write-Host "== 检查提醒任务…（当前未注册）" }
  return $false
}

function Write-Preference($enabled) {
  $json = if ($enabled) { '{"enabled": true}' } else { '{"enabled": false}' }
  try {
    [System.IO.File]::WriteAllText($PrefFile, $json, (New-Object System.Text.UTF8Encoding($false)))
  } catch {
    Write-Host "!! 没能写入 $PrefFile（不影响本次操作）"
  }
}

function Read-Preference {
  if (-not (Test-Path $PrefFile)) { return $null }
  try {
    $data = Get-Content $PrefFile -Raw | ConvertFrom-Json
    if ($null -ne $data.enabled) { return [bool]$data.enabled }
  } catch { }
  return $null
}

if ($Remove) {
  $removed = Unregister-RemindTask
  if (Test-Path $RunCmd) { Remove-Item $RunCmd -Force }
  Write-Preference $false
  Write-Host "== 提醒任务已关闭（remind.log 保留）"
  Write-Host "== 已记住这个选择：以后重装不会自动开启"
  Write-Host "== 想恢复：powershell -ExecutionPolicy Bypass -File remind-windows.ps1"
  exit 0
}

$pref = Read-Preference
if ($pref -eq $false -and -not $Force -and -not $Test) {
  Write-Host "== 提醒任务之前被你关掉了（$PrefFile），这次跳过"
  Write-Host "== 要重新开启：powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Force"
  exit 0
}

if (-not (Test-Path $RemindPy)) {
  Write-Host "!! 找不到 $RemindPy，请先运行 install.ps1"
  exit 1
}

# 找一个能跑 remind.py 的 python（优先 pythonw，避免闪窗）
$Py = $null
foreach ($candidate in @("pythonw.exe", "python.exe", "py.exe")) {
  $found = Get-Command $candidate -ErrorAction SilentlyContinue
  if ($found) { $Py = $found.Source; break }
}
if (-not $Py) {
  Write-Host "!! 没找到 Python，请先安装并加入 PATH"
  exit 1
}
if ($Py -like "*py.exe") {
  # py.exe 是启动器，不能用 pythonw 的话就用它带 -3 参数
  $Py = $Py
}

$CmdBase = if ($Base -eq (Join-Path $env:USERPROFILE ".dsh-study-suite")) {
  "%USERPROFILE%\.dsh-study-suite"
} else {
  $Base
}

$body = @"
@echo off
chcp 65001 >nul
set STUDY_SUITE_WORKSPACE=$CmdBase
set STUDY_SUITE_TOOLS=$CmdBase
set STUDY_SUITE_SECRETS=$CmdBase\secrets
set PYTHONPATH=$CmdBase\pylibs
set PYTHONIOENCODING=utf-8
rem 日志超过 2MB 就轮转
if exist "$CmdBase\remind.log" for %%F in ("$CmdBase\remind.log") do if %%~zF GTR 2097152 move /y "$CmdBase\remind.log" "$CmdBase\remind.log.1" >nul 2>&1
"$Py" "$CmdBase\remind.py" >> "$CmdBase\remind.log" 2>&1
"@
$body = ConvertTo-Crlf $body
# .cmd 不能带 BOM，否则 cmd.exe 会把 BOM 当成命令的一部分
[System.IO.File]::WriteAllText($RunCmd, $body, (New-Object System.Text.UTF8Encoding($false)))

if ($Test) {
  Write-Host "== 试跑一次（只打印，不推送）"
  & $Py $RemindPy --dry-run
  exit 0
}

# 每 5 分钟跑一次，开机后可用，电池上也照跑
$action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument ('/c "' + $RunCmd + '"')
$trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
  -RepetitionInterval (New-TimeSpan -Minutes 5) `
  -RepetitionDuration (New-TimeSpan -Days 3650)
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
  -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 10)
$principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited

Unregister-RemindTask -Quiet | Out-Null
Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
  -Settings $settings -Principal $principal -Description "学习助手：截止与上课提醒（每 5 分钟）" | Out-Null

Write-Preference $true
Write-Host "== 已注册计划任务 $TaskName（每 5 分钟，日志 $LogFile）"
Write-Host "== 想立刻验证：powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Test"
