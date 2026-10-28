# 学习助手 · 本地服务安装脚本（Windows PowerShell）
#
#   powershell -ExecutionPolicy Bypass -File install.ps1
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Full        # 加语音转写
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall   # 卸载（保留笔记与登录态）
#   powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall -Purge   # 连笔记一起删
param(
  [switch]$Full,
  [switch]$Uninstall,
  [switch]$Purge,
  [switch]$NoReminders,
  [switch]$NoWatchdog
)

$ErrorActionPreference = "Stop"
try {
  $OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }
$Here = Split-Path -Parent $MyInvocation.MyCommand.Path
$StartupDir = [Environment]::GetFolderPath("Startup")
$StartCmd = Join-Path $StartupDir "study-suite.cmd"

function Stop-Server {
  $targets = @(Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
    Where-Object { $_.CommandLine -like "*serve_translate.py*" -and $_.CommandLine -like "*$Base*" })
  foreach ($proc in $targets) {
    Stop-Process -Id $proc.ProcessId -Force -ErrorAction SilentlyContinue
  }
  # 等进程真正退出：Windows 上 ctranslate2.dll 的句柄要等进程结束才释放
  for ($i = 0; $i -lt 20; $i++) {
    $still = @(Get-CimInstance Win32_Process -Filter "Name like '%python%'" -ErrorAction SilentlyContinue |
      Where-Object { $_.CommandLine -like "*serve_translate.py*" -and $_.CommandLine -like "*$Base*" })
    if ($still.Count -eq 0) { break }
    Start-Sleep -Milliseconds 500
  }
}

if ($Uninstall) {
  Stop-Server
  foreach ($f in @($StartCmd, (Join-Path $StartupDir "study-suite.vbs"))) {
    if (Test-Path $f) { Remove-Item $f -Force }
  }
  $runner = Join-Path $Base "run-service.cmd"
  if (Test-Path $runner) { Remove-Item $runner -Force }
  $remindRunner = Join-Path $Base "run-remind.cmd"
  if (Test-Path $remindRunner) { Remove-Item $remindRunner -Force }
  $remindLog = Join-Path $Base "remind.log"
  if (Test-Path $remindLog) { Remove-Item $remindLog -Force }
  $remindTask = Get-ScheduledTask -TaskName "StudySuiteRemind" -ErrorAction SilentlyContinue
  if ($remindTask) {
    Unregister-ScheduledTask -TaskName "StudySuiteRemind" -Confirm:$false
    Write-Host "已移除提醒计划任务 StudySuiteRemind"
  }
  foreach ($sub in @("models", "pylibs")) {
    $path = Join-Path $Base $sub
    if (Test-Path $path) { Remove-Item $path -Recurse -Force }
  }
  $watchdogTask = Get-ScheduledTask -TaskName "StudySuiteWatchdog" -ErrorAction SilentlyContinue
  if ($watchdogTask) {
    Unregister-ScheduledTask -TaskName "StudySuiteWatchdog" -Confirm:$false
    Write-Host "已移除服务看门狗 StudySuiteWatchdog"
  }
  foreach ($file in @("serve_translate.py", "cn_api.py", "glossary.json", "remind.py", "watchdog.ps1", "timetable.json", "plan.json", "course-filters.json", "hidden-courses.json")) {
    $path = Join-Path $Base $file
    if (Test-Path $path) { Remove-Item $path -Force }
  }
  if ($Purge) {
    if (Test-Path $Base) { Remove-Item $Base -Recurse -Force }
    Write-Host "已卸载，并删除了全部数据（含笔记与登录态）。"
  } else {
    Write-Host "已卸载服务和模型。以下内容保留着，需要时手动删除："
    foreach ($sub in @("notes", "secrets")) {
      $path = Join-Path $Base $sub
      if (Test-Path $path) { Write-Host "  $path" }
    }
  }
  exit 0
}

Write-Host "== 安装目录: $Base"
foreach ($sub in @("secrets", "notes", "models", "pylibs", "audio")) {
  New-Item -ItemType Directory -Force -Path (Join-Path $Base $sub) | Out-Null
}
Copy-Item (Join-Path $Here "service\serve_translate.py") $Base -Force
Copy-Item (Join-Path $Here "service\cn_api.py") $Base -Force
Copy-Item (Join-Path $Here "service\glossary.json") $Base -Force
Copy-Item (Join-Path $Here "service\smoke.py") $Base -Force
Copy-Item (Join-Path $Here "service\remind.py") $Base -Force
# Windows 没有 Swift，OCR 用 Python 桥接顶上（服务端会自动识别 .py）
foreach ($ocrFile in @("ocr.py", "pdfocr.py")) {
  $src = Join-Path $Here "service\$ocrFile"
  if (Test-Path $src) { Copy-Item $src (Join-Path $Base "audio\$ocrFile") -Force }
}

# ---- 找 Python ----
$Py = $null
$PyArgs = @()
foreach ($candidate in @(@("python"), @("py", "-3"), @("python3"))) {
  if ($Py) { break }
  $exe = $candidate[0]
  $pre = @()
  if ($candidate.Length -gt 1) { $pre = $candidate[1..($candidate.Length - 1)] }
  try {
    $version = & $exe @pre -c "import sys; print('%d.%d' % sys.version_info[:2])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $version) {
      $Py = $exe
      $PyArgs = $pre
      $PyVersion = $version
    }
  } catch { }
}
if (-not $Py) {
  Write-Host "找不到 Python。请先从 https://www.python.org/downloads/ 安装（勾选 Add python.exe to PATH），再重跑本脚本。"
  exit 1
}
if ([version]$PyVersion -lt [version]"3.9") {
  Write-Host "Python 版本太低（$PyVersion），需要 3.9 或更新。"
  exit 1
}
Write-Host "== Python: $Py $PyArgs ($PyVersion)"

# ---- 依赖 ----
Write-Host "== 安装 Python 依赖（几分钟）"
$Pylibs = Join-Path $Base "pylibs"
# 旧服务正在运行时会占用 pylibs 里的 ctranslate2.dll，pip 换文件会报 WinError 5，所以先停
Write-Host "== 停止正在运行的服务"
Stop-Server
& $Py @PyArgs -m pip install --quiet --upgrade --target $Pylibs ctranslate2 sentencepiece pypdf python-docx
if ($LASTEXITCODE -ne 0) {
  # 杀毒软件可能还短暂占着文件，稍等重试一次
  Write-Host "== 依赖安装失败，3 秒后重试（常见原因是文件被占用）"
  Start-Sleep -Seconds 3
  & $Py @PyArgs -m pip install --upgrade --force-reinstall --target $Pylibs ctranslate2 sentencepiece pypdf python-docx
}
if ($LASTEXITCODE -ne 0) {
  Write-Host "依赖安装失败。若是 WinError 5（拒绝访问），说明还有进程占着 pylibs："
  Write-Host "   Get-CimInstance Win32_Process -Filter "Name like '%python%'" | Select ProcessId, CommandLine"
  Write-Host "   taskkill /PID <上面看到的PID> /F"
  Write-Host "然后重跑本脚本。"
  exit 1
}
# ---- OCR 依赖（图片 / 扫描件 PDF）----
Write-Host "== 安装 OCR 依赖"
& $Py @PyArgs -m pip install --quiet --upgrade --target $Pylibs rapidocr_onnxruntime pymupdf wordninja playwright
if ($LASTEXITCODE -ne 0) {
  Write-Host "OCR 依赖安装失败：图片和扫描件识别不可用（翻译、检测不受影响）"
}

if ($Full) {
  Write-Host "== 安装语音依赖"
  & $Py @PyArgs -m pip install --quiet --upgrade --target $Pylibs faster-whisper
  if ($LASTEXITCODE -ne 0) { Write-Host "语音依赖安装失败，翻译仍可使用。" }
}

# ---- 翻译模型 ----
function Get-Model($Pair) {
  $target = Join-Path $Base "models\$Pair"
  if (Test-Path (Join-Path $target "translate-$Pair-1_9\model")) {
    Write-Host "   $Pair 已存在，跳过"
    return
  }
  $zip = Join-Path $env:TEMP "argos-$Pair.zip"
  Write-Host "   下载 $Pair ..."
  Invoke-WebRequest -Uri "https://argos-net.com/v1/translate-$Pair-1_9.argosmodel" -OutFile $zip -UseBasicParsing
  New-Item -ItemType Directory -Force -Path $target | Out-Null
  Expand-Archive -Path $zip -DestinationPath $target -Force
  Remove-Item $zip -Force
  if (-not (Test-Path (Join-Path $target "translate-$Pair-1_9\model"))) {
    throw "模型解压后结构不对：$target"
  }
}

Write-Host "== 下载翻译模型（约 164MB）"
Get-Model "en_zh"
Get-Model "zh_en"

# ---- 开机启动 ----
Write-Host "== 注册开机启动"
# 解码线程：半核数封顶 8（24 核实测 8 最优，10 核 5 最优，按核数全开反而慢 2 倍）
$MtThreads = 0
if ($env:CN_MT_THREADS -match '^\d+$') {
  $MtThreads = [int]$env:CN_MT_THREADS
}
if ($MtThreads -lt 1) {
  $cores = [int]$env:NUMBER_OF_PROCESSORS
  if ($cores -lt 2) { $cores = 2 }
  $MtThreads = [int][math]::Floor($cores / 2)
  if ($MtThreads -gt 8) { $MtThreads = 8 }
  if ($MtThreads -lt 1) { $MtThreads = 1 }
}
Write-Host "== 解码线程: $MtThreads"

# 默认安装目录用 %USERPROFILE% 变量表示，避免中文用户名把 .cmd 编码搞乱
$DefaultBase = Join-Path $env:USERPROFILE ".dsh-study-suite"
$CmdBase = if ($Base -eq $DefaultBase) { "%USERPROFILE%\.dsh-study-suite" } else { $Base }

# 用 pythonw.exe：没有控制台窗口，就不会被人关掉窗口带走整个服务
# （Intel Fortran/MKL 在控制台收到 CLOSE 事件时会直接 abort 进程，不留 traceback）
$PyExe = ((& $Py @PyArgs -c "import sys; print(sys.executable)" 2>$null) -join '').Trim()
$PyW = ""
if ($PyExe) {
  $candidate = Join-Path (Split-Path $PyExe) "pythonw.exe"
  if (Test-Path $candidate) { $PyW = $candidate }
}
$Runner = if ($PyW) { $PyW } else { $PyExe }
if (-not $Runner) { $Runner = $Py }
Write-Host "== 启动程序: $Runner$(if (-not $PyW) { '（没有 pythonw.exe，退回普通 python）' })"

# 真正的启动脚本：设环境变量、跑服务、日志写文件
$RunCmd = Join-Path $Base "run-service.cmd"
$runBody = @"
@echo off
chcp 65001 >nul
set STUDY_SUITE_WORKSPACE=$CmdBase
set STUDY_SUITE_TOOLS=$CmdBase
set STUDY_SUITE_SECRETS=$CmdBase\secrets
set STUDY_SUITE_NOTES=$CmdBase\notes
set STUDY_SUITE_MODELS=$CmdBase\models
set PYTHONPATH=$CmdBase\pylibs
set CN_INTERPRETER_PORT=8791
set CN_MT_THREADS=$MtThreads
rem 日志超过 5MB 就轮转，避免只涨不减
if exist "$CmdBase\service.log" for %%F in ("$CmdBase\service.log") do if %%~zF GTR 5242880 move /y "$CmdBase\service.log" "$CmdBase\service.log.1" >nul 2>&1
"$Runner" "$CmdBase\serve_translate.py" >> "$CmdBase\service.log" 2>&1
"@
# .cmd/.vbs 必须是 CRLF：cmd.exe 解析 LF-only 批处理时，遇到 rem + if ... for %%~zF
# 这类结构会错位，把下一行吞进上一条命令（实测会导致 set PYTHONPATH 失效）
function ConvertTo-Crlf($text) {
  if ($text -match "(?<!`r)`n") {
    $text = $text -replace "(?<!`r)`n", "`r`n"
  }
  if (-not $text.EndsWith("`r`n")) { $text += "`r`n" }
  return $text
}

$runBody = ConvertTo-Crlf $runBody
[System.IO.File]::WriteAllText($RunCmd, $runBody, (New-Object System.Text.UTF8Encoding($false)))

# 开机启动用 .vbs（Windows 运行它不弹控制台），它再把 run-service.cmd 隐藏起来跑
$StartVbs = Join-Path $StartupDir "study-suite.vbs"
$vbs = @'
Set sh = CreateObject("WScript.Shell")
sh.Run "cmd /c """ & "{0}" & """", 0, False
'@ -f $RunCmd
$vbs = ConvertTo-Crlf $vbs
[System.IO.File]::WriteAllText($StartVbs, $vbs, (New-Object System.Text.UTF8Encoding($false)))

# 清掉旧版遗留的启动项
if (Test-Path $StartCmd) { Remove-Item $StartCmd -Force }

# 用 WMI 创建进程：Start-Process 起的进程会落在调用者的 Job 对象里，
# DSH 一重启整棵进程树就被带走（Windows 特有）。WMI 起的进程挂在 WmiPrvSE 下。
$launched = $false
try {
  $wmi = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{
    CommandLine = 'cmd.exe /c "' + $RunCmd + '"'
  }
  if ($wmi.ReturnValue -eq 0) {
    $launched = $true
    Write-Host "== 已通过 WMI 启动服务（不随 DSH 退出）"
  }
} catch { }
if (-not $launched) {
  Write-Host "== WMI 启动不可用，退回 Start-Process（注意：重启 DSH 可能带走服务）"
  Start-Process -FilePath "cmd.exe" -ArgumentList "/c `"$RunCmd`"" -WindowStyle Hidden
}

# WMI 启动比 Start-Process 慢 1~2 秒，加上导入库和杀毒扫描，给到 40 秒
$health = $null
for ($i = 1; $i -le 20; $i++) {
  Start-Sleep -Seconds 2
  try {
    $health = Invoke-RestMethod -Uri "http://127.0.0.1:8791/health" -TimeoutSec 3
    Write-Host "== 服务响应正常（等了 $($i * 2) 秒）"
    break
  } catch {
    if ($i % 5 -eq 0) { Write-Host "   等待服务启动… 已等 $($i * 2) 秒" }
  }
}

if ($health) {
  Write-Host "== 服务已启动（平台: $($health.platform)）"
  Write-Host "   能力: $($health.capabilities | ConvertTo-Json -Compress)"
} else {
  Write-Host "== 服务没起来。先看真实报错（这步最关键）："
  Write-Host "   cd `"$Base`""
  Write-Host "   `$env:PYTHONPATH = `"$Base\pylibs`""
  Write-Host "   $Py serve_translate.py"
  Write-Host ""
  Write-Host "   如果是 ModuleNotFoundError，多半是依赖没装全："
  Write-Host "     $Py -m pip install --target `"$Base\pylibs`" ctranslate2 sentencepiece pypdf python-docx"
  Write-Host "   其他常见原因：杀毒拦截、8791 被占用、装了多个 Python 导致 pylibs 与解释器不匹配。"
  $logPath = Join-Path $Base "service.log"
  if (Test-Path $logPath) {
    Write-Host ""
    Write-Host "== 服务日志最后 12 行："
    Get-Content $logPath -Tail 12 | ForEach-Object { Write-Host "   $_" }
  } else {
    Write-Host "   日志文件还没生成: $logPath"
  }
}

# ---- 提醒任务（截止 / 上课推送到 Bark）----
# 是否开启由 $Base\remind.json 决定：用户删过就一直是关，升级不会自己回来
if (-not $NoReminders) {
  $remindScript = Join-Path $Here "remind-windows.ps1"
  if (Test-Path $remindScript) {
    try {
      & powershell -ExecutionPolicy Bypass -File $remindScript
    } catch {
      Write-Host "!! 提醒任务没装上（不影响翻译和课程功能）：$($_.Exception.Message)"
      Write-Host "   可以稍后手动重试： powershell -ExecutionPolicy Bypass -File `"$remindScript`""
    }
  } else {
    Write-Host "== 跳过提醒任务（包内没有 remind-windows.ps1）"
  }
} else {
  $prefFile = Join-Path $Base "remind.json"
  [System.IO.File]::WriteAllText($prefFile, '{"enabled": false}', (New-Object System.Text.UTF8Encoding($false)))
  $existing = Get-ScheduledTask -TaskName "StudySuiteRemind" -ErrorAction SilentlyContinue
  if ($existing) {
    Unregister-ScheduledTask -TaskName "StudySuiteRemind" -Confirm:$false
    Write-Host "== 按 -NoReminders 跳过提醒任务，并移除了已有的任务"
  } else {
    Write-Host "== 按 -NoReminders 跳过提醒任务（已记住这个选择）"
  }
}

if (-not $NoWatchdog) {
  $watchdogScript = Join-Path $Here "watchdog.ps1"
  if (Test-Path $watchdogScript) {
    Copy-Item $watchdogScript $Base -Force
    try {
      & powershell -ExecutionPolicy Bypass -File (Join-Path $Base "watchdog.ps1") -Install
    } catch {
      Write-Host "!! 看门狗没装上（不影响使用，但服务退出后要手动启动）：$($_.Exception.Message)"
    }
  }
} else {
  $watchdogPref = Join-Path $Base "watchdog.json"
  [System.IO.File]::WriteAllText($watchdogPref, '{"enabled": false}', (New-Object System.Text.UTF8Encoding($false)))
  $existingTask = Get-ScheduledTask -TaskName "StudySuiteWatchdog" -ErrorAction SilentlyContinue
  if ($existingTask) {
    Unregister-ScheduledTask -TaskName "StudySuiteWatchdog" -Confirm:$false
    Write-Host "== 按 -NoWatchdog 跳过看门狗，并移除了已有的任务"
  } else {
    Write-Host "== 按 -NoWatchdog 跳过看门狗（已记住这个选择）"
  }
}

@"

下一步（在 DeepSeek Harness 里）：
  1. 设置 → 插件 → 从文件夹安装
  2. 选择： $Here\plugin
  3. 侧栏出现「学习助手」

Windows 能用到什么：
  可用    翻译（快速引擎）、AI 率检测（文本/Word/文字版 PDF）、课程功能（需自己登录 CN）
  可用    图片 / 扫描件 OCR（RapidOCR，纯本地）
  可用    语音转写：需要 -Full 安装，首次使用会下载约 500MB 模型
  可选    精准翻译 7B：装 Ollama 后自动启用（ollama pull qwen2.5:7b-instruct-q4_K_M）
  不可用  说话人 A/B 分离（缺 sherpa-onnx 模型，Windows 未打包）

提醒（截止前 3 天 / 1 天、逾期、上课前 30 分钟，推到手机 Bark）：
  已随安装注册计划任务 StudySuiteRemind（每 5 分钟）
  试跑： powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Test
  移除： powershell -ExecutionPolicy Bypass -File remind-windows.ps1 -Remove

服务守护（退出后 1 分钟内自动拉起，对应 macOS 的 launchd KeepAlive）：
  已注册计划任务 StudySuiteWatchdog（每 1 分钟探活）
  想手动停服务前先暂停： powershell -ExecutionPolicy Bypass -File "$Base\watchdog.ps1" -Pause
  恢复： powershell -ExecutionPolicy Bypass -File "$Base\watchdog.ps1" -Resume

自检（装好后随时可以跑）：
  python "$Base\smoke.py"

卸载： powershell -ExecutionPolicy Bypass -File install.ps1 -Uninstall
"@
