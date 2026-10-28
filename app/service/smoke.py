#!/usr/bin/env python3
"""End-to-end smoke test for the local service.

    python3 smoke.py            # 默认 127.0.0.1:8791
    CN_INTERPRETER_PORT=8797 python3 smoke.py

Exits non-zero if any check fails. No third-party dependencies.
"""
import json
import os
import sys
import urllib.error
import urllib.request

PORT = os.environ.get("CN_INTERPRETER_PORT", "8791")
HOST = os.environ.get("CN_INTERPRETER_HOST", "127.0.0.1")
BASE = "http://%s:%s" % (HOST, PORT)

results = []


def check(name, fn):
    try:
        detail = fn()
        results.append((True, name, detail or ""))
    except Exception as err:
        results.append((False, name, str(err)[:160]))


def get(path, timeout=15):
    with urllib.request.urlopen(BASE + path, timeout=timeout) as resp:
        return json.load(resp)


def post(path, payload, timeout=120):
    data = json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(BASE + path, data=data, headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.load(resp)


def _beam_case(post):
    """beam 越界应被收敛或拒绝，不能抛 500。"""
    try:
        post("/translate", {"text": "hello world", "to": "zh", "beam": -5}, timeout=30)
    except urllib.error.HTTPError as err:
        if err.code == 400:
            return "HTTP 400"
        raise AssertionError("beam=-5 返回 %s，既不是 200 也不是 400" % err.code)
    return "已收敛"


def extract_check():
    """文档解析：给一段纯文本，应该返回正文字数。"""
    body = b"This is a test document used by the smoke check."
    req = urllib.request.Request(
        BASE + "/extract", data=body,
        headers={"content-type": "application/octet-stream", "x-filename": "smoke.txt"},
    )
    with urllib.request.urlopen(req, timeout=30) as resp:
        data = json.load(resp)
    chars = data.get("chars") or 0
    if chars < 10:
        raise AssertionError("解析结果太短: %r" % data)
    return "%d 字" % chars


def check_short_draft():
    """评审提的 68 字节样例：必须能查，不能因为门槛不一致被拒。"""
    body = b"Plastic waste is a big problem. Fish eat it and people eat fish. "
    req = urllib.request.Request(
        BASE + "/check?targetWords=250", data=body,
        headers={"content-type": "text/plain", "x-filename": "draft.txt"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    if not data.get("chars"):
        raise AssertionError("没有返回字数: %r" % data)
    return "%d 字 / %d 词" % (data["chars"], data["words"])


def check_draft():
    """提交前检查：上传一段草稿，应该给出字数与问题清单。"""
    body = (b"Literature review draft. The issue is complex and many studies "
            b"discuss it, but only a few explain why it matters for students. "
            b"We compare three sources and draw a conclusion for the report. " * 3)
    req = urllib.request.Request(
        BASE + "/check", data=body,
        headers={"content-type": "application/octet-stream", "x-filename": "smoke.txt"},
    )
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.load(resp)
    if not data.get("words"):
        raise AssertionError("没有返回字数: %r" % data)
    return "%d 词 / %d 条问题" % (data["words"], len(data.get("issues") or []))


def main():
    health = {}

    def do_health():
        nonlocal health
        health = get("/health")
        if not health.get("ok"):
            raise AssertionError("健康检查未返回 ok")
        caps = health.get("capabilities") or {}
        return "平台 %s · 线程 %s · 术语 %s" % (
            health.get("platform"), caps.get("mtThreads"), (health.get("glossary") or {}).get("en_zh"))

    check("GET /health", do_health)

    check("POST /translate en→zh", lambda: post(
        "/translate", {"text": "Submit the literature review before Week 6.", "to": "zh", "engine": "fast"}
    )["text"][:40])

    check("POST /translate zh→en", lambda: post(
        "/translate", {"text": "请在第六周之前提交文献综述。", "to": "en", "engine": "fast"}
    )["text"][:40])

    check("POST /translate/batch", lambda: "%d 行" % len(post(
        "/translate/batch", {"lines": ["Assessment 3 is due in Week 6.", "Submit it on CN."], "to": "zh"}
    )["lines"]))

    check("POST /aidetect", lambda: "评分 %s" % post(
        "/aidetect", {"text": "Plastic waste breaks into small pieces and stays in the ocean for decades. "
                              "Fish mistake it for food, and plastic enters the food chain."}
    )["score"])

    def expect_field(path, field):
        data = get(path)
        if field not in data:
            raise AssertionError("%s 没有返回 %s 字段（得到 %s）" % (path, field, sorted(data)))
        value = data[field]
        if value is None:
            raise AssertionError("%s.%s 是 null" % (path, field))
        return value

    check("POST /summary", lambda: "%d 条要点" % len(post(
        "/summary", {"segments": [
            {"text": "Marine plastic waste breaks into small pieces."},
            {"text": "Coastal communities depend on clean beaches."},
        ]}
    )["bullets"]))

    check("POST /extract", extract_check)

    check("POST /check", check_draft)

    check("POST /check（68 字节）", check_short_draft)

    check("GET /plan", lambda: "%d 条待办" % len(expect_field("/plan", "items") or []))
    check("GET /timetable", lambda: "%d 节课" % len(expect_field("/timetable", "classes") or []))
    check("GET /filters", lambda: "%d 条过滤" % len(expect_field("/filters", "filters") or {}))
    check("GET /hidden", lambda: "%d 门隐藏" % len(expect_field("/hidden", "names") or []))

    def expect_400(path, payload, label):
        try:
            post(path, payload, timeout=30)
        except urllib.error.HTTPError as err:
            if err.code != 400:
                raise AssertionError("%s 应返回 400，实际 %s" % (label, err.code))
            return "HTTP 400"
        raise AssertionError("%s 没有被拒绝" % label)

    check("非法 to 被拒", lambda: expect_400("/translate", {"text": "hello", "to": "klingon"}, "非法 to"))
    check("beam=-5 被拒/收敛", lambda: _beam_case(post))

    caps = (health.get("capabilities") or {})
    if caps.get("llm"):
        check("POST /translate (7B)", lambda: post(
            "/translate", {"text": "Write the literature review section.", "to": "zh", "engine": "llm"}, timeout=300
        )["text"][:40])
    else:
        try:
            post("/translate", {"text": "test", "to": "zh", "engine": "llm"}, timeout=30)
            results.append((False, "7B 应被拒绝却没拒绝", ""))
        except urllib.error.HTTPError as err:
            results.append((err.code == 400, "7B 在无 MLX 平台返回 400", "HTTP %s" % err.code))
        except Exception as err:
            results.append((False, "7B 平台检查", str(err)[:80]))

    print("=" * 56)
    for ok, name, detail in results:
        print("  %s %-28s %s" % ("[OK]  " if ok else "[FAIL]", name, detail))
    failed = sum(1 for ok, _, _ in results if not ok)
    print("=" * 56)
    print(" 结论：%s" % ("全部通过" if failed == 0 else "%d 项失败" % failed))
    return 0 if failed == 0 else 1


if __name__ == "__main__":
    sys.exit(main())
