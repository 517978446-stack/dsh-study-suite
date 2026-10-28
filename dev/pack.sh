#!/usr/bin/env bash
# Build both release zips and refuse to publish anything personal.
#
#   ./dev/pack.sh            # 从 app/ 组装到 packages/
#
# 仓库布局：
#   app/service/           共享核心（翻译、检测、CN 抓取、smoke）
#   app/platform/windows/  只有 Windows 用（install.ps1、watchdog、OCR 桥接）
#   app/platform/macos/    只有 macOS 用（install.sh、doctor.command、start.command）
#   app/*.md               用户文档
#
# 构建完会跑 dev/check-privacy.py 和 dev/check-encoding.py；不通过就中止。
set -euo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(dirname "$HERE")"
SRC="${STUDY_SUITE_DIST:-$REPO/app}"
# 两个平台各自维护版本号：发布节奏不同，不必互相牵制
MAC_VERSION="${MAC_VERSION:-$(cat "$REPO/app/platform/macos/VERSION" 2>/dev/null || echo 0.0.0)}"
WIN_VERSION="${WIN_VERSION:-$(cat "$REPO/app/platform/windows/VERSION" 2>/dev/null || echo 0.0.0)}"
MAC_VERSION="${MAC_VERSION#v}"
WIN_VERSION="${WIN_VERSION#v}"
OUT="$REPO/packages"

[ -d "$SRC/service" ] || { echo "找不到源码目录: $SRC/service（用 STUDY_SUITE_DIST 指定）"; exit 1; }

rm -rf "$OUT" && mkdir -p "$OUT"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

PKG="$TMP/study-suite"
mkdir -p "$PKG/plugin" "$PKG/service"

# 共享核心
cp -R "$SRC/service/." "$PKG/service/"
# 本机编译出来的 .pyc 会带上绝对路径，隐私检查会拦，直接清掉
find "$PKG" -name "__pycache__" -type d -prune -exec rm -rf {} + 2>/dev/null || true

# Windows：脚本摊到根，OCR 桥接跟 service 走（服务端从 service/ 取）
cp "$SRC"/platform/windows/{install.ps1,doctor.ps1,check-win.ps1,remind-windows.ps1,watchdog.ps1} "$PKG/"
cp "$SRC"/platform/windows/{ocr.py,pdfocr.py} "$PKG/service/"

# macOS 入口
cp "$SRC"/platform/macos/{install.sh,doctor.command,start.command} "$PKG/"

# 用户文档
cp "$SRC"/{README.md,INSTALL.md,CHANGELOG.md} "$PKG/"

# 面板：仓库根就是插件源码，包里需要「本地插件」形态的 package.json
cp "$REPO"/{client.js,index.js,cordis.patch.yml,icon.svg} "$PKG/plugin/"
cp -R "$REPO/locale" "$PKG/plugin/"
cp "$REPO/package.json" "$PKG/plugin/package.json"
python3 "$HERE/set-plugin-version.py" "$PKG/plugin" "$MAC_VERSION"

# macOS + Windows 通用包
(cd "$TMP" && zip -qr "$OUT/study-suite-$MAC_VERSION-macos-win.zip" study-suite \
  -x "*.DS_Store" -x "*__pycache__*" -x "*.pyc")

# 纯 macOS 包：只保留 mac 入口（Windows 包由维护者自行发布）
mkdir -p "$TMP/mac"
cp -R "$PKG" "$TMP/mac/study-suite"
rm -f "$TMP/mac/study-suite/install.ps1" "$TMP/mac/study-suite/doctor.ps1" \
      "$TMP/mac/study-suite/check-win.ps1" "$TMP/mac/study-suite/remind-windows.ps1" \
      "$TMP/mac/study-suite/watchdog.ps1"
(cd "$TMP/mac" && zip -qr "$OUT/study-suite-macos-$MAC_VERSION.zip" study-suite \
  -x "*.DS_Store" -x "*__pycache__*" -x "*.pyc")

# Windows 专用包：去掉 macOS 专属入口
mkdir -p "$TMP/win"
cp -R "$PKG" "$TMP/win/study-suite"
rm -f "$TMP/win/study-suite/install.sh" "$TMP/win/study-suite/doctor.command" "$TMP/win/study-suite/start.command"
python3 "$HERE/set-plugin-version.py" "$TMP/win/study-suite/plugin" "$WIN_VERSION"
(cd "$TMP/win" && zip -qr "$OUT/study-suite-windows-$WIN_VERSION.zip" study-suite \
  -x "*.DS_Store" -x "*__pycache__*" -x "*.pyc")

echo "已构建（macOS ${MAC_VERSION} / Windows ${WIN_VERSION}）:"
ls -lh "$OUT" | tail -2

echo
python3 "$HERE/check-privacy.py" "$OUT"/*.zip
python3 "$HERE/check-encoding.py" .
echo "隐私检查、编码检查都通过，可以发布。"
