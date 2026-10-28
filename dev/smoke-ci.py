import json
import os
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request

"""CI 冒烟：不下载模型、不装系统组件，只验证服务能起来、基本路由正常。

    python dev/smoke-ci.py

覆盖：启动不崩、/health、/timetable（空）、/health 能力位、非法参数返回 400。
翻译需要模型文件，留给真正的 smoke.py（本地跑）。
"""

# Windows 的 CI runner 控制台是 cp1252，直接 print 中文会 UnicodeEncodeError
for stream in (sys.stdout, sys.stderr):
    try:
        stream.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SERVICE = os.path.join(ROOT, "app", "service")
PORT = "8799"
BASE = "http://127.0.0.1:%s" % PORT


def wait_health(timeout=40):
    deadline = time.time() + timeout
    while time.time() < deadline:
        try:
            with urllib.request.urlopen(BASE + "/health", timeout=2) as resp:
                return json.loads(resp.read().decode())
        except Exception:
            time.sleep(0.5)
    raise SystemExit("服务 40 秒内没有响应")


def post(path, payload):
    data = json.dumps(payload).encode()
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=15) as resp:
            return resp.status, resp.read().decode()
    except urllib.error.HTTPError as err:
        return err.code, err.read().decode()


def main():
    home = tempfile.mkdtemp(prefix="ss-ci-")
    for sub in ("models", "pylibs", "secrets", "notes", "audio"):
        os.makedirs(os.path.join(home, sub), exist_ok=True)
    # 服务需要 glossary.json 与脚本同目录
    for name in ("serve_translate.py", "cn_api.py", "glossary.json"):
        src = os.path.join(SERVICE, name)
        if os.path.exists(src):
            open(os.path.join(home, name), "wb").write(open(src, "rb").read())

    env = dict(os.environ)
    env.update({
        "STUDY_SUITE_WORKSPACE": home,
        "STUDY_SUITE_TOOLS": home,
        "STUDY_SUITE_SECRETS": os.path.join(home, "secrets"),
        "STUDY_SUITE_NOTES": os.path.join(home, "notes"),
        "STUDY_SUITE_MODELS": os.path.join(home, "models"),
        "CN_INTERPRETER_PORT": PORT,
        "PYTHONPATH": os.path.join(home, "pylibs") + os.pathsep + os.environ.get("PYTHONPATH", ""),
    })

    proc = subprocess.Popen([sys.executable, os.path.join(home, "serve_translate.py")],
                            cwd=home, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
    try:
        health = wait_health()
        failures = []

        if not health.get("ok"):
            failures.append("/health 没有返回 ok")

        caps = health.get("capabilities") or {}
        for key in ("imageOcr", "pdfOcr", "llm", "asr", "mtThreads"):
            if key not in caps:
                failures.append("capabilities 缺 %s" % key)

        code, body = post("/translate", {"text": "hello", "to": "klingon"})
        if code != 400:
            failures.append("非法 to 应返回 400，实际 %s %s" % (code, body[:60]))

        code, body = post("/translate", {"text": "hello", "to": 5})
        if code != 400:
            failures.append("to 非字符串应返回 400，实际 %s %s" % (code, body[:60]))

        with urllib.request.urlopen(BASE + "/timetable", timeout=10) as resp:
            if resp.status != 200:
                failures.append("/timetable 应返回 200")

        if failures:
            print("冒烟失败：")
            for item in failures:
                print("  - " + item)
            return 1

        print("冒烟通过：platform=%s mtThreads=%s" % (health.get("platform"), caps.get("mtThreads")))
        return 0
    finally:
        proc.terminate()
        try:
            proc.wait(timeout=10)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
