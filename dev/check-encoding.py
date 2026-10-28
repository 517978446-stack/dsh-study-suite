#!/usr/bin/env python3
"""Guard against the two Windows script traps we keep hitting.

  1. .ps1 without a UTF-8 BOM  -> PowerShell 5.1 decodes as GBK, param() breaks
  2. .cmd / .vbs with LF ending -> cmd.exe swallows the next line, env vars lost

Run:  python3 dev/check-encoding.py [目录...]      默认检查仓库根
Exit: 0 全部合格 / 1 有问题
"""
import pathlib
import sys

BOM = b"\xef\xbb\xbf"

# .ps1 必须有 BOM 且以 CRLF 结尾；.cmd/.vbs 只要求 CRLF（cmd 默认代码页，不需要 BOM）
NEEDS_BOM = {".ps1"}
NEEDS_CRLF = {".ps1", ".cmd", ".vbs"}
SKIP_DIRS = {".git", "node_modules", "packages"}


def check(path: pathlib.Path):
    raw = path.read_bytes()
    problems = []
    ext = path.suffix.lower()
    if ext in NEEDS_BOM and not raw.startswith(BOM):
        problems.append("缺少 UTF-8 BOM（PowerShell 5.1 会按 GBK 解码）")
    body = raw[3:] if ext in NEEDS_BOM and raw.startswith(BOM) else raw
    lone_lf = body.count(b"\n") - body.count(b"\r\n")
    if ext in NEEDS_CRLF and lone_lf:
        problems.append("%d 处裸 LF（cmd/PowerShell 解析会错位）" % lone_lf)
    try:
        body.decode("utf-8")
    except UnicodeDecodeError:
        problems.append("不是合法 UTF-8")
    return problems


def check_zip(zip_path: pathlib.Path):
    """The scripts that actually reach users live inside the packages, so scan those too."""
    import zipfile

    problems = 0
    with zipfile.ZipFile(zip_path) as zf:
        for info in zf.infolist():
            ext = pathlib.Path(info.filename).suffix.lower()
            if ext not in NEEDS_CRLF:
                continue
            raw = zf.read(info)
            issues = []
            if ext in NEEDS_BOM and not raw.startswith(BOM):
                issues.append("缺少 UTF-8 BOM")
            body = raw[3:] if ext in NEEDS_BOM and raw.startswith(BOM) else raw
            lone_lf = body.count(b"\n") - body.count(b"\r\n")
            if lone_lf:
                issues.append("%d 处裸 LF" % lone_lf)
            try:
                body.decode("utf-8")
            except UnicodeDecodeError:
                issues.append("不是合法 UTF-8")
            if issues:
                problems += 1
                print("  [FAIL] %s :: %s" % (zip_path.name, info.filename))
                for item in issues:
                    print("         - %s" % item)
    return problems


def main(roots):
    failed = 0
    checked = 0
    for root in roots:
        base = pathlib.Path(root)
        for path in sorted(base.rglob("*")):
            if not path.is_file():
                continue
            if any(part in SKIP_DIRS for part in path.parts):
                continue
            if path.suffix.lower() not in NEEDS_CRLF:
                continue
            checked += 1
            issues = check(path)
            if issues:
                failed += 1
                print("  [FAIL] %s" % path)
                for item in issues:
                    print("         - %s" % item)
    zips = sorted(pathlib.Path("packages").glob("*.zip")) if pathlib.Path("packages").is_dir() else []
    for zip_path in zips:
        failed += check_zip(zip_path)
    print(" 检查 %d 个仓库脚本 + %d 个安装包，%s" % (
        checked, len(zips), "全部合格" if failed == 0 else "%d 个不合格" % failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:] or ["."]))
