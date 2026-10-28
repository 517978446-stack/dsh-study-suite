#!/usr/bin/env python3
"""Refuse to ship anything that belongs to one person.

The package is shared with classmates, but the local machine holds real course
lists, deadline dates, a CN token and absolute home paths. This script scans the
built zips (or a source tree) and exits 1 when any of that leaks through.

Two layers:
  * generic patterns that are always wrong in a shipped file
  * local facts read from ~/.secrets and plan.json / timetable.json, so a course
    code is caught only because it is really *your* course

A line containing ``privacy:ignore`` is skipped, so documentation can quote
examples without failing the build.

Run:
  python3 dev/check-privacy.py                      # packages/*.zip
  python3 dev/check-privacy.py path/to.zip ...      # specific archives
  python3 dev/check-privacy.py .                    # a source tree (CI)
  python3 dev/check-privacy.py --generic-only .     # CI: no local files there

Exit: 0 clean / 1 leak found
"""
import json
import os
import pathlib
import re
import sys
import zipfile

GENERIC = [
    (r"/Users/[A-Za-z0-9._-]+", "macOS 绝对路径"),
    (r"[A-Za-z]:\\\\Users\\\\[^\\\\\s\"']+", "Windows 绝对路径"),
    (r"学习区", "个人工作区目录名"),
    (r"[\w.+-]+@(?:ucsiuniversity|gmail|qq|163|outlook)\.\w+", "个人邮箱"),
    (r"\b\d{10}\b", "学号样式的十位数字"),
]

SELF = pathlib.Path(__file__).resolve()
SKIP_EXT = {".png", ".jpg", ".jpeg", ".gif", ".ico", ".woff", ".woff2", ".zip", ".pdf"}
SKIP_MAX = 3 * 1024 * 1024


def local_facts():
    """Read the things that are true only on this machine."""
    facts = []
    home = pathlib.Path.home()
    candidates = [
        home / "学习区" / ".secrets" / "cn-state.json",
        home / ".dsh-study-suite" / "secrets" / "cn-state.json",
    ]
    for path in candidates:
        if not path.exists():
            continue
        try:
            state = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            continue
        for origin in state.get("origins") or []:
            for item in origin.get("localStorage") or []:
                if item.get("name") == "cn_token" and item.get("value"):
                    facts.append((re.escape(item["value"].strip('"')), "CN token 原值"))
    for name in ("plan.json", "timetable.json", "course-filters.json", "hidden-courses.json"):
        for base in (home / "学习区" / ".tools", home / ".dsh-study-suite"):
            path = base / name
            if not path.exists():
                continue
            try:
                text = path.read_text(encoding="utf-8")
            except Exception:
                continue
            for code in set(re.findall(r"\b[A-Z]{2,4}\d{3,4}\b", text)):
                facts.append((re.escape(code), "你的课程代码"))
            for course in set(re.findall(r'"name"\s*:\s*"([^"]{8,60})"', text)):
                facts.append((re.escape(course), "你的课程名"))
    # 去重，保持稳定顺序
    seen, out = set(), []
    for pattern, label in facts:
        if pattern not in seen:
            seen.add(pattern)
            out.append((pattern, label))
    return out


def scan_text(text, rules, where):
    hits = []
    lines = text.splitlines()
    for pattern, label in rules:
        for match in re.finditer(pattern, text):
            line = text.count("\n", 0, match.start()) + 1
            # 行内豁免：文档里写明示例是安全的，就在那一行加 privacy:ignore
            if 0 < line <= len(lines) and "privacy:ignore" in lines[line - 1]:
                continue
            sample = text[max(0, match.start() - 30):match.end() + 30].replace("\n", " ")
            hits.append((where, line, label, match.group(0)[:60], sample[:90]))
            break
    return hits


def scan_zip(path, rules):
    hits = []
    with zipfile.ZipFile(path) as archive:
        for info in archive.infolist():
            if info.is_dir():
                continue
            ext = os.path.splitext(info.filename)[1].lower()
            if ext in SKIP_EXT or info.file_size > SKIP_MAX:
                continue
            try:
                text = archive.read(info).decode("utf-8", "replace")
            except Exception:
                continue
            hits += scan_text(text, rules, "%s:%s" % (os.path.basename(path), info.filename))
    return hits


def scan_tree(root, rules):
    hits = []
    for path in pathlib.Path(root).rglob("*"):
        if not path.is_file() or ".git" in path.parts:
            continue
        if path.resolve() == SELF:      # 本脚本里写着规则本身，别自己告自己
            continue
        if path.suffix.lower() in SKIP_EXT or path.stat().st_size > SKIP_MAX:
            continue
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except Exception:
            continue
        hits += scan_text(text, rules, str(path))
    return hits


def main():
    args = [a for a in sys.argv[1:] if not a.startswith("--")]
    generic_only = "--generic-only" in sys.argv
    rules = list(GENERIC)
    if not generic_only:
        rules += local_facts()

    if not args:
        args = [str(p) for p in sorted(pathlib.Path("packages").glob("*.zip"))]

    hits = []
    for target in args:
        if os.path.isdir(target):
            hits += scan_tree(target, rules)
        elif target.endswith(".zip"):
            hits += scan_zip(target, rules)
        elif os.path.isfile(target):
            text = open(target, encoding="utf-8", errors="replace").read()
            hits += scan_text(text, rules, target)
        else:
            print("跳过（不存在）:", target)

    if not hits:
        print("隐私检查：%d 个目标，%d 条规则，未发现个人信息" % (len(args), len(rules)))
        return 0

    print("隐私检查：发现 %d 处可能泄漏" % len(hits))
    for where, line, label, value, sample in hits[:40]:
        print("  [%s] %s:%d  %s  →  %r" % (label, where, line, value, sample))
    print("\n把这些内容从发布包里去掉后再打包。")
    return 1


if __name__ == "__main__":
    sys.exit(main())
