#!/usr/bin/env bash
# Build both release zips and refuse to publish anything personal.
#
#   ./dev/pack.sh            # 从 ../study-suite 构建到 ./packages
#
# 构建完会跑 dev/check-privacy.py；发现课程代码、登录 token、家目录路径就中止。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
SRC="${STUDY_SUITE_DIST:-$REPO/../study-suite}"
VERSION="${VERSION:-$(python3 -c "import json,sys;print(json.load(open('$REPO/package.json'))['version'])")}"
OUT="$REPO/packages"

[ -d "$SRC" ] || { echo "找不到源目录: $SRC（用 STUDY_SUITE_DIST 指定）"; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

# macOS + Windows 通用包（就是 study-suite 目录本身）
(cd "$SRC/.." && zip -qr "$OUT/study-suite-$VERSION-macos-win.zip" "$(basename "$SRC")" -x "*.DS_Store")

# Windows 专用包：把脚本摊到根目录
mkdir -p "$TMP/win/study-suite"
cp -R "$SRC/plugin" "$SRC/service" "$TMP/win/study-suite/"
cp "$SRC"/{install.ps1,remind-windows.ps1,doctor.ps1,check-win.ps1,README.md,INSTALL.md,CHANGELOG.md} "$TMP/win/study-suite/"
(cd "$TMP/win" && zip -qr "$OUT/study-suite-windows-$VERSION.zip" study-suite -x "*.DS_Store")

echo "已构建:"
ls -lh "$OUT" | tail -2

echo
python3 "$HERE/check-privacy.py" "$OUT"/*.zip
echo "隐私检查通过，可以发布。"
