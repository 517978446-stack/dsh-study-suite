# 学习助手 · 数据备份脚本（Windows）
#
#   powershell -ExecutionPolicy Bypass -File backup.ps1
#   powershell -ExecutionPolicy Bypass -File backup.ps1 -Out D:\backup
#
# 只复制“删了就没了”的东西：笔记、登录态、待办、课表。
# 模型和依赖不备份（可以重新下载）。

param(
  [string]$Out = (Join-Path ([Environment]::GetFolderPath("MyDocuments")) "study-suite-backup")
)

$ErrorActionPreference = "Stop"
$Base = if ($env:STUDY_SUITE_HOME) { $env:STUDY_SUITE_HOME } else { Join-Path $env:USERPROFILE ".dsh-study-suite" }

if (-not (Test-Path $Base)) {
  Write-Host "找不到安装目录: $Base"
  exit 1
}

$stamp = Get-Date -Format "yyyyMMdd-HHmm"
$target = Join-Path $Out "study-suite-$stamp"
New-Item -ItemType Directory -Force -Path $target | Out-Null

$items = @("notes", "secrets", "plan.json", "timetable.json", "course-filters.json", "hidden-courses.json")
$copied = 0
foreach ($item in $items) {
  $source = Join-Path $Base $item
  if (Test-Path $source) {
    Copy-Item $source -Destination $target -Recurse -Force
    $copied++
    Write-Host "  [OK]   $item"
  }
}

if ($copied -eq 0) {
  Write-Host "没有可备份的内容（安装目录里只有模型？）"
  exit 0
}

$size = "{0:N1} MB" -f ((Get-ChildItem $target -Recurse -File | Measure-Object Length -Sum).Sum / 1MB)
Write-Host ""
Write-Host "已备份 $copied 项到: $target ($size)"
Write-Host "恢复方式：把这些文件复制回 $Base 即可（先停服务）。"
