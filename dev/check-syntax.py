#!/usr/bin/env python3
"""CI：检查脚本语法（bash -n / py_compile / PowerShell 解析）。

    python3 dev/check-syntax.py

PowerShell 的解析需要 pwsh，只在有它的 runner 上跑（ubuntu 默认没有，
所以这里跳过 .ps1 的语法检查——编码检查已经覆盖 BOM/CRLF 这类问题）。
"""
import pathlib
import shutil
import subprocess
import sys


def main() -> int:
    bad = 0

    # .ps1 需要 PowerShell 才能解析；GitHub 的 windows runner 有 pwsh
    shell = shutil.which("pwsh") or shutil.which("powershell")
    if shell:
        sample = (
            "$tokens = $null; $errors = $null; "
            "[System.Management.Automation.Language.Parser]::ParseFile('%s', [ref]$tokens, [ref]$errors) | Out-Null; "
            "if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Output $_.Message }; exit 1 }"
        )
        for path in sorted(pathlib.Path("app").rglob("*.ps1")):
            result = subprocess.run([shell, "-NoProfile", "-Command", sample % path.resolve()],
                                    capture_output=True, text=True)
            if result.returncode != 0:
                print("PowerShell 解析失败: %s\n%s" % (path, result.stdout + result.stderr))
                bad = 1

    for path in sorted(pathlib.Path("app").rglob("*.sh")):
        result = subprocess.run(["bash", "-n", str(path)], capture_output=True, text=True)
        if result.returncode != 0:
            print("bash -n 失败: %s\n%s" % (path, result.stderr))
            bad = 1

    for path in sorted(pathlib.Path("app").rglob("*.py")) + sorted(pathlib.Path("dev").rglob("*.py")):
        result = subprocess.run([sys.executable, "-m", "py_compile", str(path)],
                                capture_output=True, text=True)
        if result.returncode != 0:
            print("py_compile 失败: %s\n%s" % (path, result.stderr))
            bad = 1

    # py_compile 会在源码旁边留下 __pycache__，别让它混进安装包
    for cache in pathlib.Path("app").rglob("__pycache__"):
        shutil.rmtree(cache, ignore_errors=True)

    if bad:
        return 1
    print("语法检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
