# 学习助手 · 学习数据备份（Windows）
#
#   powershell -ExecutionPolicy Bypass -File dev\backup.ps1
#   powershell -ExecutionPolicy Bypass -File dev\backup.ps1 -Dest "D:\backup" -Keep 30
#   powershell -ExecutionPolicy Bypass -File dev\backup.ps1 -IncludeSecrets   # 含登录态，慎用
#
# 默认只备份笔记 / 待办 / 课表 / 术语，不含 secrets/（cn-state.json 是明文登录 cookie，
# 传到网盘等于把账号交出去）。
param(
  [string]$Base = (Join-Path $env:USERPROFILE ".dsh-study-suite"),
  [string]$Dest = "",
  [int]$Keep = 14,
  [switch]$IncludeSecrets
)

$ErrorActionPreference = "Stop"

if (-not (Test-Path $Base)) {
  Write-Host "找不到安装目录：$Base"
  exit 1
}

if (-not $Dest) {
  $oneDrive = $env:OneDrive
  if (-not $oneDrive) {
    Write-Host "没检测到 OneDrive。用 -Dest 指定一个目录，例如 -Dest D:\backup"
    exit 1
  }
  $Dest = Join-Path $oneDrive "study-suite-backup"
}
New-Item -ItemType Directory -Force -Path $Dest | Out-Null

# 只挑数据，不碰模型和依赖（几百 MB，没必要）
$items = @("notes", "plan.json", "timetable.json", "course-filters.json", "hidden-courses.json")
if ($IncludeSecrets) {
  Write-Host "[警告] -IncludeSecrets：secrets/cn-state.json 是明文登录 cookie，"
  Write-Host "       传到网盘等于泄露账号。确认目标目录可信再继续。"
  $items += "secrets"
}

$stage = Join-Path $env:TEMP ("ss-backup-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $stage | Out-Null

$copied = 0
foreach ($item in $items) {
  $src = Join-Path $Base $item
  if (-not (Test-Path $src)) { continue }
  # 空目录没什么可备份的，跳过，否则 Compress-Archive 会生成一个空包
  if (Test-Path $src -PathType Container) {
    $hasContent = @(Get-ChildItem $src -Recurse -Force -ErrorAction SilentlyContinue).Count -gt 0
    if (-not $hasContent) { continue }
  }
  Copy-Item $src -Destination $stage -Recurse -Force
  $copied++
}

if ($copied -eq 0) {
  Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue
  Write-Host "没有可备份的数据（$Base 下还没有笔记或待办）。"
  exit 0
}

$stamp = Get-Date -Format "yyyyMMdd-HHmmss"
$zip = Join-Path $Dest "study-suite-$stamp.zip"
Compress-Archive -Path (Join-Path $stage "*") -DestinationPath $zip -Force
Remove-Item $stage -Recurse -Force -ErrorAction SilentlyContinue

if (-not (Test-Path $zip)) {
  Write-Host "压缩失败，没有生成 $zip"
  exit 1
}

$size = [math]::Round((Get-Item $zip).Length / 1KB, 1)
Write-Host "已备份：$zip（$size KB，$copied 项）"

# 只保留最近 N 份
$old = Get-ChildItem $Dest -Filter "study-suite-*.zip" |
  Sort-Object LastWriteTime -Descending |
  Select-Object -Skip $Keep
foreach ($f in $old) {
  Remove-Item $f.FullName -Force
}
if ($old) { Write-Host "清理了 $($old.Count) 份旧备份（保留最近 $Keep 份）" }