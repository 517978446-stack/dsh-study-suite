# 学习助手 · Windows 服务看门狗
#
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1           # 跑一次（任务计划每 1 分钟调它）
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Install  # 注册计划任务
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Remove   # 删任务
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Pause    # 暂停看门狗（手动停服务前用）
#   powershell -ExecutionPolicy Bypass -File watchdog.ps1 -Resume   # 恢复
#
# 对应 macOS 的 launchd KeepAlive：服务退出后 1 分钟内自动拉起。
param(
  [switch]$Install,
  [switch]$Remove,
  [switch]$Pause,
  [switch]$Resume
)

$ErrorActionPreference = "Stop"
$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }
$Runner = Join-Path $Base "run-service.cmd"
$Log = Join-Path $Base "service.log"
$Paused = Join-Path $Base ".watchdog-paused"
$TaskName = "StudySuiteWatchdog"
$Port = 8791

function Test-Healthy {
  try {
    $r = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 4
    return [bool]$r.ok
  } catch {
    return $false
  }
}

function Write-Log([string]$msg) {
  $line = "[watchdog " + (Get-Date -Format "yyyy-MM-dd HH:mm:ss") + "] " + $msg
  Add-Content -Path $Log -Value $line -Encoding UTF8
}

function Start-StudyService {
  # 用 WMI 启动，避免落进调用者的 Job 对象（DSH/任务计划都可能带 job）
  $cmd = 'cmd.exe /c ""' + $Runner + '""'
  $r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = $cmd }
  if ($r.ReturnValue -ne 0) {
    Write-Log ("WMI 启动失败，返回码 " + $r.ReturnValue)
    Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$Runner`"" -WindowStyle Hidden
  }
}

function Register-Task {
  $action = New-ScheduledTaskAction -Execute "powershell.exe" `
    -Argument ('-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File "' + $PSCommandPath + '"')
  # 立即开始、每 1 分钟一次、持续 10 年（任务计划里 1 分钟是可用的最小间隔）
  $trigger = New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) `
    -RepetitionInterval (New-TimeSpan -Minutes 1) `
    -RepetitionDuration (New-TimeSpan -Days 3650)
  $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
    -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 5)
  $principal = New-ScheduledTaskPrincipal -UserId $env:USERNAME -LogonType Interactive -RunLevel Limited
  Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Principal $principal `
    -Description "学习助手：服务退出后 1 分钟内自动拉起（对应 macOS 的 launchd KeepAlive）" | Out-Null
  Write-Host "已注册计划任务 $TaskName（每 1 分钟检查一次）"
}

switch ($true) {
  { $Install } {
    if (-not (Test-Path $Runner)) { Write-Host "没有找到 $Runner，请先跑 install.ps1"; exit 1 }
    Register-Task
    exit 0
  }
  { $Remove } {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "已移除计划任务 $TaskName"
    exit 0
  }
  { $Pause } {
    New-Item -ItemType File -Path $Paused -Force | Out-Null
    Write-Host "看门狗已暂停（服务退出后不会再被拉起）。恢复用 -Resume"
    exit 0
  }
  { $Resume } {
    Remove-Item $Paused -Force -ErrorAction SilentlyContinue
    Write-Host "看门狗已恢复"
    exit 0
  }
}

# 默认：跑一次检查
if (Test-Path $Paused) { exit 0 }
if (Test-Healthy) { exit 0 }
if (-not (Test-Path $Runner)) { exit 1 }

Write-Log "服务无响应，正在拉起"
Start-StudyService
for ($i = 0; $i -lt 15; $i++) {
  Start-Sleep -Seconds 2
  if (Test-Healthy) { Write-Log "已恢复（等了 $(($i + 1) * 2) 秒）"; exit 0 }
}
Write-Log "拉起失败，最后 8 行日志见下"
exit 1
