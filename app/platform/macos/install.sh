#!/bin/bash
# 学习助手 · 本地服务安装脚本（仅 macOS）
#
#   ./install.sh            最小安装：快速翻译 + 文本检测（约 200MB）
#   ./install.sh --full     完整安装：加语音识别、说话人分离、7B 精准翻译（约 5GB）
#   ./install.sh --uninstall 卸载
set -euo pipefail

BASE="${STUDY_SUITE_HOME:-$HOME/.dsh-study-suite}"
LABEL="com.local.study-suite"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
HERE="$(cd "$(dirname "$0")" && pwd)"
FULL=0
NO_REMIND=0
FORCE_REMIND=0

for arg in "$@"; do
  case "$arg" in
    --full) FULL=1 ;;
    --no-remind) NO_REMIND=1 ;;
    --remind) FORCE_REMIND=1 ;;
    --uninstall)
      launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
      launchctl bootout "gui/$(id -u)/$LABEL.remind" 2>/dev/null || true
      rm -f "$PLIST" "$HOME/Library/LaunchAgents/$LABEL.remind.plist" "$BASE/run-service.sh" "$BASE/remind.sh"
      rm -rf "$BASE"
      echo "已卸载：服务、模型、登录项都已删除。"
      exit 0
      ;;
    *) echo "未知参数: $arg"; exit 1 ;;
  esac
done

echo "== 安装目录: $BASE"
mkdir -p "$BASE"/{secrets,notes,models,audio,pylibs}
cp "$HERE/service/serve_translate.py" "$HERE/service/cn_api.py" "$HERE/service/glossary.json" "$HERE/service/smoke.py" "$HERE/service/remind.py" "$BASE/"
chmod 700 "$BASE/secrets"

PY="$(command -v python3 || true)"
if [ -z "$PY" ]; then echo "找不到 python3，请先安装（xcode-select --install 或 python.org）"; exit 1; fi
echo "== Python: $PY ($($PY -V 2>&1))"

echo "== 安装 Python 依赖（可能需要几分钟）"
"$PY" -m pip install --quiet --upgrade --target "$BASE/pylibs" \
  ctranslate2 sentencepiece pypdf python-docx playwright 2>&1 | tail -3 || true

if [ "$FULL" = "1" ]; then
  "$PY" -m pip install --quiet --upgrade --target "$BASE/pylibs" \
    faster-whisper sherpa-onnx mlx-lm 2>&1 | tail -3 || true
fi

echo "== 检查一键登录的浏览器（复用系统 Edge/Chrome，不下载内核）"
for cand in "/Applications/Microsoft Edge.app" "/Applications/Google Chrome.app" "/Applications/Chromium.app"; do
  if [ -d "$cand" ]; then echo "   找到: $cand"; FOUND_BROWSER=1; fi
done
if [ "${FOUND_BROWSER:-0}" != "1" ]; then
  echo "   没找到 Edge/Chrome：一键登录会失败，可以在面板里手动粘贴 token"
fi

echo "== 下载翻译模型（约 164MB）"
mkdir -p "$BASE/models"
for pair in en_zh zh_en; do
  if [ ! -d "$BASE/models/$pair" ]; then
    url="https://argos-net.com/v1/translate-${pair}-1_9.argosmodel"
    echo "   $pair ..."
    curl -sL --max-time 900 -o "/tmp/$pair.argosmodel" "$url"
    unzip -oq "/tmp/$pair.argosmodel" -d "$BASE/models/$pair"
    rm -f "/tmp/$pair.argosmodel"
  fi
done

if [ "$FULL" = "1" ]; then
  echo "== 下载说话人分离模型（约 34MB）"
  mkdir -p "$BASE/models/diar"
  if [ ! -f "$BASE/models/diar/campplus.onnx" ]; then
    curl -sL --max-time 600 -o "$BASE/models/diar/campplus.onnx" \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models/3dspeaker_speech_campplus_sv_zh_en_16k-common_advanced.onnx"
  fi
  if [ ! -d "$BASE/models/diar/sherpa-onnx-pyannote-segmentation-3-0" ]; then
    curl -sL --max-time 600 -o /tmp/seg.tar.bz2 \
      "https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-segmentation-models/sherpa-onnx-pyannote-segmentation-3-0.tar.bz2"
    tar xjf /tmp/seg.tar.bz2 -C "$BASE/models/diar" && rm -f /tmp/seg.tar.bz2
  fi
  echo "== 语音识别模型会在首次使用时自动下载（约 460MB）"
  echo "== 7B 精准翻译模型请单独执行："
  echo "   $PY -c \"from huggingface_hub import snapshot_download; snapshot_download('mlx-community/Qwen2.5-7B-Instruct-4bit', local_dir='$BASE/models/qwen25-7b-4bit')\""
fi

echo "== 编译 OCR 工具（图片 / 扫描版 PDF 需要）"
if command -v swiftc >/dev/null 2>&1; then
  swiftc -O "$HERE/service/swift/ocr.swift" -o "$BASE/audio/ocr" 2>/dev/null && echo "   ocr 编译成功" || echo "   ocr 编译失败（图片识别将不可用）"
  swiftc -O "$HERE/service/swift/pdfocr.swift" -o "$BASE/audio/pdfocr" 2>/dev/null && echo "   pdfocr 编译成功" || echo "   pdfocr 编译失败（扫描版 PDF 将不可用）"
else
  echo "   没有 swiftc，跳过（安装 Xcode 命令列工具后可重新运行本脚本）"
fi

echo "== 注册登录项（开机自启 + 崩溃自动重启）"
# 解码线程：半核数封顶 8（24 核实测 8 最优，10 核 5 最优，核数全开反而更慢）
case "$CN_MT_THREADS" in
  ''|*[!0-9]*) MT_THREADS=0 ;;
  *) MT_THREADS="$CN_MT_THREADS" ;;
esac
if [ "$MT_THREADS" -lt 1 ]; then
  MT_CORES=$(sysctl -n hw.ncpu 2>/dev/null || echo 4)
  MT_THREADS=$((MT_CORES / 2))
  [ "$MT_THREADS" -lt 1 ] && MT_THREADS=1
  [ "$MT_THREADS" -gt 8 ] && MT_THREADS=8
fi
echo "== 解码线程: $MT_THREADS"

# 启动包装：日志超过 5MB 就轮转，然后 exec 到 python（保持 launchd 的进程语义）
cat > "$BASE/run-service.sh" <<RUNNER
#!/bin/sh
LOG="$BASE/service.log"
if [ -f "\$LOG" ] && [ "\$(wc -c < "\$LOG")" -gt 5242880 ]; then
  mv -f "\$LOG" "\$LOG.1"
fi
exec "$PY" "$BASE/serve_translate.py" >> "\$LOG" 2>&1
RUNNER
chmod +x "$BASE/run-service.sh"

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$BASE/run-service.sh</string></array>
  <key>WorkingDirectory</key><string>$BASE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STUDY_SUITE_WORKSPACE</key><string>$BASE</string>
    <key>STUDY_SUITE_TOOLS</key><string>$BASE</string>
    <key>STUDY_SUITE_SECRETS</key><string>$BASE/secrets</string>
    <key>STUDY_SUITE_NOTES</key><string>$BASE/notes</string>
    <key>STUDY_SUITE_MODELS</key><string>$BASE/models</string>
    <key>PYTHONPATH</key><string>$BASE/pylibs</string>
    <key>CN_INTERPRETER_PORT</key><string>8791</string>
    <key>CN_MT_THREADS</key><string>$MT_THREADS</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$BASE/service.log</string>
  <key>StandardErrorPath</key><string>$BASE/service.log</string>
</dict>
</plist>
PLIST

launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 6
if curl -s --max-time 5 http://127.0.0.1:8791/health | grep -q '"ok": true'; then
  echo "== 服务已启动：http://127.0.0.1:8791"
else
  echo "== 服务没起来，看日志： tail -30 $BASE/service.log"
fi

# ---- 提醒任务（每 5 分钟一次，对应 Windows 的计划任务 StudySuiteRemind）----
# 和 Windows 一致：用户删过就一直关，升级不会自己回来
PREF_FILE="$BASE/remind.json"
PREF_ENABLED=""
if [ -f "$PREF_FILE" ]; then
  PREF_ENABLED=$(grep -o '"enabled"[[:space:]]*:[[:space:]]*false' "$PREF_FILE" >/dev/null 2>&1 && echo "false" || echo "true")
fi
if [ "$NO_REMIND" -eq 1 ]; then
  printf '{"enabled": false}\n' > "$PREF_FILE"
  echo "== 已记住：提醒关闭（重装也不会自动开；要恢复加 --remind）"
  NO_REMIND=1
elif [ "$PREF_ENABLED" = "false" ] && [ "$FORCE_REMIND" -eq 0 ]; then
  echo "== 提醒之前被你关掉了（$PREF_FILE），这次跳过；要恢复加 --remind"
  NO_REMIND=1
fi

if [ "$NO_REMIND" -eq 0 ]; then
  printf '{"enabled": true}\n' > "$PREF_FILE"
  cat > "$BASE/remind.sh" <<RUNNER
#!/bin/sh
LOG="$BASE/remind.log"
if [ -f "\$LOG" ] && [ "\$(wc -c < "\$LOG")" -gt 5242880 ]; then
  mv -f "\$LOG" "\$LOG.1"
fi
exec "$PY" "$BASE/remind.py" >> "\$LOG" 2>&1
RUNNER
  chmod +x "$BASE/remind.sh"

  cat > "$HOME/Library/LaunchAgents/$LABEL.remind.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL.remind</string>
  <key>ProgramArguments</key>
  <array><string>/bin/sh</string><string>$BASE/remind.sh</string></array>
  <key>WorkingDirectory</key><string>$BASE</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>STUDY_SUITE_WORKSPACE</key><string>$BASE</string>
    <key>STUDY_SUITE_SECRETS</key><string>$BASE/secrets</string>
    <key>PATH</key><string>/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
  <key>StartInterval</key><integer>300</integer>
  <key>RunAtLoad</key><false/>
  <key>StandardOutPath</key><string>$BASE/remind.log</string>
  <key>StandardErrorPath</key><string>$BASE/remind.log</string>
</dict>
</plist>
PLIST

  launchctl bootout "gui/$(id -u)/$LABEL.remind" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$HOME/Library/LaunchAgents/$LABEL.remind.plist" 2>/dev/null     && echo "== 提醒任务已注册（每 5 分钟，日志 $BASE/remind.log）"     || echo "== 提醒任务注册失败（不影响翻译与检测）"
fi

cat <<EOF

下一步（在 DeepSeek Harness 里）：
  1. 打开 设置 → 插件 → 从文件夹安装
  2. 选择这个目录：$HERE/plugin
  3. 侧栏出现「学习助手」图标

课程功能（可选）：
  需要用你自己的 CN 账号登录一次，登录态会存到 $BASE/secrets/cn-state.json。
  没有登录也能用：翻译、语音、AI 率检测。

卸载：
  $HERE/install.sh --uninstall
EOF
