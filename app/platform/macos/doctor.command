#!/bin/bash
# 学习助手 · 自检脚本（macOS）
# 用法：双击运行，或  ./doctor.command
# 出问题时把整段输出复制发给开发者即可（不会包含你的登录凭据）。
BASE="${STUDY_SUITE_HOME:-$HOME/.dsh-study-suite}"
PORT="${CN_INTERPRETER_PORT:-8791}"
FAIL=0
WARN=0

ok()   { printf "  ✓ %s\n" "$*"; }
bad()  { printf "  ✗ %s\n" "$*"; FAIL=$((FAIL+1)); }
warn() { printf "  ! %s\n" "$*"; WARN=$((WARN+1)); }
info() { printf "  · %s\n" "$*"; }

echo "=============================================="
echo " 学习助手 自检报告"
echo " 时间: $(date '+%Y-%m-%d %H:%M:%S')"
echo "=============================================="

echo
echo "[1] 系统"
sw_vers 2>/dev/null | sed 's/^/  · /'
info "架构: $(uname -m)"
DF=$(df -h "$HOME" | tail -1 | awk '{print $4}')
info "磁盘可用: $DF"
MEM=$(( $(sysctl -n hw.memsize 2>/dev/null || echo 0) / 1024 / 1024 / 1024 ))
info "内存: ${MEM}GB"

echo
echo "[2] Python"
PLIST="$HOME/Library/LaunchAgents/com.local.cn-interpreter.plist"
PY_FROM_PLIST=$(/usr/bin/python3 - "$PLIST" <<'PYEOF' 2>/dev/null
import plistlib, sys
try:
    d = plistlib.load(open(sys.argv[1], 'rb'))
except Exception:
    sys.exit(0)
args = d.get('ProgramArguments') or []
env = d.get('EnvironmentVariables') or {}
print(args[0] if args else '')
print(env.get('PYTHONHOME', ''))
print(env.get('PYTHONPATH', ''))
PYEOF
)
SERVICE_PY=$(echo "$PY_FROM_PLIST" | sed -n '1p')
SERVICE_PYHOME=$(echo "$PY_FROM_PLIST" | sed -n '2p')
SERVICE_PYPATH=$(echo "$PY_FROM_PLIST" | sed -n '3p')
[ -n "$SERVICE_PY" ] && info "服务解释器: $SERVICE_PY" || warn "读不到登录项，回退系统 python3"

PY="${SERVICE_PY:-$(command -v python3 || true)}"
PYHOME_ENV=""
[ -n "$SERVICE_PYHOME" ] && PYHOME_ENV="PYTHONHOME=$SERVICE_PYHOME"
PYPATH_ENV="PYTHONPATH=$BASE/pylibs"
[ -n "$SERVICE_PYPATH" ] && PYPATH_ENV="$PYPATH_ENV:$SERVICE_PYPATH"
svc() { env $PYHOME_ENV $PYPATH_ENV "$PY" "$@"; }

if [ -z "$PY" ]; then
  bad "找不到 python3"
else
  ok "解释器: $PY ($(svc -V 2>&1))"
  svc -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)' \
    && ok "版本 >= 3.9" || bad "版本低于 3.9，部分依赖装不上"
fi

echo
echo "[3] 安装目录"
if [ -d "$BASE" ]; then
  ok "目录存在: $BASE"
  for d in secrets notes models pylibs; do
    [ -d "$BASE/$d" ] && info "$d/ ✓" || warn "缺少 $d/"
  done
else
  bad "目录不存在：$BASE（安装脚本没跑过？）"
fi

echo
echo "[4] Python 依赖"
if [ -n "$PY" ] && [ -d "$BASE/pylibs" ]; then
  for mod in ctranslate2 sentencepiece pypdf docx numpy; do
    svc -c "import $mod" 2>/dev/null && ok "$mod" || bad "$mod 缺失"
  done
  for mod in faster_whisper sherpa_onnx mlx_lm; do
    svc -c "import $mod" 2>/dev/null && ok "${mod}（可选）" || warn "${mod} 未安装（可选功能）"
  done
else
  bad "无法检查依赖（Python 或 pylibs 缺失）"
fi

echo
echo "[5] 模型文件"
for pair in en_zh zh_en; do
  if [ -d "$BASE/models/$pair" ]; then
    ok "翻译模型 $pair"
  else
    bad "翻译模型 $pair 缺失（核心功能）"
  fi
done
[ -f "$BASE/models/diar/campplus.onnx" ] && ok "声纹分离模型" || warn "声纹分离模型缺失（说话人 A/B 不可用）"
[ -d "$BASE/models/whisper" ] && ok "语音识别模型" || warn "语音识别模型未下载（首次使用会自动下）"
[ -d "$BASE/models/qwen25-7b-4bit" ] && ok "7B 精准模型" || warn "7B 模型未安装（只能用快速引擎）"

echo
echo "[6] OCR 组件"
for bin in ocr pdfocr; do
  if [ -x "$BASE/audio/$bin" ]; then
    ok "$bin 可执行"
  else
    warn "$bin 缺失（图片 / 扫描版 PDF 不可用）"
  fi
done

echo
echo "[7] 服务进程"
PID=$(pgrep -f "serve_translate.py" | head -1 || true)
if [ -n "$PID" ]; then ok "进程在跑 (pid $PID)"; else bad "没有进程在跑"; fi
STATE=$(launchctl print "gui/$(id -u)/com.local.cn-interpreter" 2>/dev/null | awk -F'= ' '/state =/{print $2; exit}')
[ -n "$STATE" ] && info "LaunchAgent 状态: $STATE" || warn "没有注册 LaunchAgent（开机不会自启）"

echo
echo "[8] 端口与健康检查"
if curl -s --max-time 5 "http://127.0.0.1:$PORT/health" -o /tmp/_suite_health.json; then
  ok "端口 $PORT 有响应"
  svc - "$PORT" <<'PYEOF' 2>/dev/null || true
import json, sys
d = json.load(open('/tmp/_suite_health.json'))
print("  · 平台:", d.get('platform'))
caps = d.get('capabilities') or {}
print("  · 能力:", ", ".join(f"{k}={'✓' if v else '✗'}" for k, v in caps.items()))
print("  · 术语表:", (d.get('glossary') or {}))
PYEOF
else
  bad "端口 $PORT 无响应（服务没起来）"
fi

echo
echo "[9] 功能自测"
RESP=$(curl -s --max-time 60 -X POST "http://127.0.0.1:$PORT/translate" \
  -H 'content-type: application/json' \
  -d '{"text":"The literature review must synthesise sources.","to":"zh","engine":"fast"}' || true)
if echo "$RESP" | grep -q '"text"'; then
  ok "翻译: $(echo "$RESP" | sed -n 's/.*"text": *"\([^"]*\)".*/\1/p' | head -c 60)"
else
  bad "翻译失败: $(echo "$RESP" | head -c 120)"
fi

DET=$(curl -s --max-time 120 -X POST "http://127.0.0.1:$PORT/aidetect" \
  -H 'content-type: application/json' \
  -d '{"text":"In today digital landscape, effective communication plays a crucial role. Furthermore, technology transformed engagement. Moreover, media literacy matters."}' || true)
if echo "$DET" | grep -q '"score"'; then
  ok "AI 检测: $(echo "$DET" | sed -n 's/.*"score": *\([0-9]*\).*/\1/p' | head -1) 分"
elif echo "$DET" | grep -q '"error"'; then
  warn "AI 检测返回错误: $(echo "$DET" | head -c 120)"
else
  bad "AI 检测无响应"
fi

echo
echo "[10] CORS（面板上传文件依赖）"
PRE=$(curl -s -i -X OPTIONS "http://127.0.0.1:$PORT/aidetect" \
  -H "Origin: http://127.0.0.1:1234" \
  -H "Access-Control-Request-Headers: x-filename" | tr -d '\r')
if echo "$PRE" | grep -qi "x-filename"; then
  ok "预检允许 x-filename"
else
  bad "预检没放行 x-filename，面板上传文件会 Failed to fetch"
fi

echo
echo "[11] 最近日志"
LOG="$BASE/service.log"
if [ -f "$LOG" ]; then
  tail -6 "$LOG" | sed 's/^/  · /'
else
  warn "没有日志文件: $LOG"
fi

echo
echo "=============================================="
if [ "$FAIL" -eq 0 ]; then
  echo " 结论：全部通过（$WARN 项可选功能缺失）"
else
  echo " 结论：$FAIL 项失败，$WARN 项警告"
fi
echo " 把以上全部内容复制发给开发者即可"
echo "=============================================="
