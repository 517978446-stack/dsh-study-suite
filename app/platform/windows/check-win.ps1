# 学习助手 · Windows 环境预检（只读，不安装任何东西）
#
# 用法：右键 → 使用 PowerShell 运行；或者
#   powershell -ExecutionPolicy Bypass -File check-win.ps1
#
# 它只做检查，不改动系统。把整段输出复制发给开发者即可。

$ErrorActionPreference = "Continue"
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

try {
  $OutputEncoding = [System.Text.Encoding]::UTF8
  [Console]::OutputEncoding = [System.Text.Encoding]::UTF8
} catch { }

$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }
$Port = 8791
$script:Bad = 0
$script:Warn = 0

function Ok($m)   { Write-Host "  [OK]   $m" -ForegroundColor Green }
function Bad($m)  { Write-Host "  [MISS] $m" -ForegroundColor Red; $script:Bad++ }
function Warn($m) { Write-Host "  [WARN] $m" -ForegroundColor Yellow; $script:Warn++ }
function Info($m) { Write-Host "  .      $m" -ForegroundColor Gray }

Write-Host "=================================================="
Write-Host " 学习助手 · Windows 环境预检"
Write-Host " $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
Write-Host "=================================================="

Write-Host "`n[1] 系统"
Info "Windows: $([System.Environment]::OSVersion.VersionString)"
Info "架构: $env:PROCESSOR_ARCHITECTURE"
Info "PowerShell: $($PSVersionTable.PSVersion)"
try { Info "执行策略: $(Get-ExecutionPolicy)" } catch { Info "执行策略: 读取失败" }
try {
  $ram = [math]::Round((Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory / 1GB, 1)
  Info "内存: $ram GB"
  if ($ram -lt 4) { Warn "内存偏小，翻译能跑，语音会比较吃力" }
} catch { Warn "读不到内存信息" }
try {
  $root = [System.IO.Path]::GetPathRoot($env:USERPROFILE)
  $free = (Get-PSDrive -Name $root.Substring(0, 1)).Free / 1GB
  Info ("磁盘可用: {0:N1} GB" -f $free)
  if ($free -lt 2) { Warn "磁盘不足 2GB，模型放不下" }
} catch { Warn "读不到磁盘信息" }

Write-Host "`n[2] Python"
$found = $null
foreach ($cand in @(@("python"), @("py", "-3"), @("python3"))) {
  $exe = $cand[0]
  $pre = @()
  if ($cand.Length -gt 1) { $pre = $cand[1..($cand.Length - 1)] }
  try {
    $v = & $exe @pre -c "import sys; print(sys.version.split()[0])" 2>$null
    if ($LASTEXITCODE -eq 0 -and $v) { $found = "$exe $($pre -join ' ') ($v)"; break }
  } catch { }
}
if ($found) {
  Ok "找到 Python: $found"
  $bits = & python -c "import struct; print(struct.calcsize('P')*8)" 2>$null
  if ($bits) { Info "位数: $bits 位" }
  & python -m pip --version *> $null
  if ($LASTEXITCODE -eq 0) { Ok "pip 可用" } else { Warn "pip 不可用，安装会失败" }
} else {
  Bad "没有 Python。去 https://www.python.org/downloads/ 装 3.12 或 3.13，勾选 Add python.exe to PATH"
  Info "注意：where python 若只指向 ...\WindowsApps\python.exe，那是商店占位符，不算装好"
}

Write-Host "`n[3] 网络（装依赖和模型都要用）"
$probes = @(
  @{ Name = "PyPI（装依赖）"; Url = "https://pypi.org/simple/"; Expect = 200 },
  @{ Name = "翻译模型站（下模型）"; Url = "https://argos-net.com/v1/translate-en_zh-1_9.argosmodel"; Expect = 200 }
)
foreach ($p in $probes) {
  try {
    $r = Invoke-WebRequest -Uri $p.Url -Method Head -TimeoutSec 15 -UseBasicParsing
    if ($r.StatusCode -eq $p.Expect) { Ok "$($p.Name) 可访问 ($($r.StatusCode))" }
    else { Warn "$($p.Name) 返回 $($r.StatusCode)（预期 $($p.Expect)）" }
  } catch {
    Bad "$($p.Name) 访问失败：$($_.Exception.Message)"
  }
}

Write-Host "`n[4] 浏览器（导出中英对照 PDF 需要）"
$browsers = @(
  "$env:ProgramFiles\Microsoft\Edge\Application\msedge.exe",
  "${env:ProgramFiles(x86)}\Microsoft\Edge\Application\msedge.exe",
  "$env:LOCALAPPDATA\Microsoft\Edge\Application\msedge.exe",
  "$env:ProgramFiles\Google\Chrome\Application\chrome.exe",
  "$env:LOCALAPPDATA\Google\Chrome\Application\chrome.exe"
) | Where-Object { $_ -and (Test-Path $_) }
if ($browsers) {
  Ok "找到浏览器: $(Split-Path $browsers[0] -Leaf)"
} else {
  Warn "没找到 Edge/Chrome。Windows 一般自带 Edge，若确实没有，对照 PDF 导出会不可用"
}

Write-Host "`n[5] 端口"
$inUse = Get-NetTCPConnection -LocalPort $Port -ErrorAction SilentlyContinue
if ($inUse) {
  try {
    $h = Invoke-RestMethod -Uri "http://127.0.0.1:$Port/health" -TimeoutSec 5
    Ok "端口 $Port 被占用，但健康检查通过 —— 服务已经在运行（$($h.platform)）"
  } catch {
    Warn "端口 $Port 被别的程序占用（不是本服务）"
  }
} else { Ok "端口 $Port 空闲" }

Write-Host "`n[6] 当前安装状态"
if (Test-Path $Base) {
  Info "安装目录已存在: $Base"
  foreach ($sub in @("models\en_zh", "models\zh_en", "pylibs")) {
    if (Test-Path (Join-Path $Base $sub)) { Ok "$sub 在" } else { Warn "缺少 $sub" }
  }
} else {
  Info "还没安装（正常，首次安装前跑这个检查就是这样）"
}

Write-Host "`n[7] 已经装了的 Harness 面板？"
Info "面板在 DeepSeek Harness → 设置 → 插件 里查看「学习助手」是否存在"

Write-Host "`n=================================================="
if ($script:Bad -eq 0) {
  Write-Host " 结论：可以安装（$script:Warn 项提醒）" -ForegroundColor Green
} else {
  Write-Host " 结论：有 $script:Bad 项缺失，先解决再安装" -ForegroundColor Red
}
Write-Host " 把以上全部内容复制发给开发者"
Write-Host "=================================================="
Read-Host "按回车关闭"
