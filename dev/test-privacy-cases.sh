#!/usr/bin/env bash
# 隐私检查自身的回归用例：跑完应该「该报的报、不该报的不报」。
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
fail=0

expect_report() {   # 名称 内容 期望命中标签
  local name="$1" body="$2" label="$3"
  printf '%s\n' "$body" > "$TMP/case.txt"
  local out; out="$(python3 "$HERE/check-privacy.py" "$TMP/case.txt" 2>&1)"
  if echo "$out" | grep -qF "[$label]"; then
    echo "  [OK]   ${name} 命中"
  else
    echo "  [FAIL] ${name} 没命中，期望 ${label}"; fail=1
  fi
}

expect_clean() {    # 名称 内容
  local name="$1" body="$2"
  printf '%s\n' "$body" > "$TMP/case.txt"
  local out; out="$(python3 "$HERE/check-privacy.py" "$TMP/case.txt" 2>&1)"
  if echo "$out" | grep -q "未发现个人信息"; then
    echo "  [OK]   ${name} 放行"
  else
    echo "  [FAIL] ${name} 被误报"; fail=1
  fi
}

echo "隐私检查回归："
expect_report "Windows 单反斜杠路径" 'p = "C:\Users\alice\x.txt"'        "Windows 绝对路径"  # privacy:ignore
expect_report "Windows 双反斜杠路径" 'p = "C:\\\\Users\\\\alice\\\\x"'  "Windows 绝对路径"  # privacy:ignore
expect_report "Windows 正斜杠路径"   'p = "C:/Users/alice/x.txt"'        "Windows 绝对路径"  # privacy:ignore
expect_report "macOS 路径"           'p = /Users/alice/x.txt'            "macOS 绝对路径"  # privacy:ignore
expect_report "学号（中文语境）"      '学号: 1002580997'                  "学号"  # privacy:ignore
expect_report "学号（student_id）"   'student_id = 1002580997'           "学号"  # privacy:ignore
expect_clean  "Unix 时间戳"          'ts = 1793168346'
expect_clean  "时间戳数组"           'created = [1700000000, 1793168346]'
expect_clean  "普通十位数字无语境"    'id = 9999999999'
expect_clean  "行内豁免"             '/Users/alice/x  # privacy:ignore'

if [ "$fail" -ne 0 ]; then
  echo "结论：有用例失败"
  exit 1
fi
echo "结论：全部通过"
