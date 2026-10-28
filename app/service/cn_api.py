#!/usr/bin/env python3
"""CourseNetworking read-only API client (no browser needed).

Auth is the `token` header taken from the saved browser session, so every call
is a plain HTTPS request: fast, low memory, and safe to run in a loop.

  python3 cn_api.py me
  python3 cn_api.py courses
  python3 cn_api.py course <course_id>
  python3 cn_api.py digest
"""
import json
import os
import re
import sys
import urllib.parse
import urllib.request

_HERE = os.path.dirname(os.path.abspath(__file__))
# 布局 A: <workspace>/.tools/cn_api.py；布局 B: <base>/cn_api.py（env 由安装脚本给出）
WORKSPACE = os.environ.get("STUDY_SUITE_WORKSPACE") or os.path.dirname(_HERE)
SECRETS = os.environ.get("STUDY_SUITE_SECRETS", WORKSPACE + "/.secrets")
STATE = os.path.join(SECRETS, "cn-state.json")
BASE = "https://www.thecn.com"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/126.0 Safari/537.36")


def credentials():
    state = json.load(open(STATE, encoding="utf-8"))
    token = ""
    for origin in state.get("origins", []):
        for item in origin.get("localStorage", []):
            if item.get("name") == "cn_token":
                token = item.get("value", "").strip('"')
    cookies = "; ".join(
        "%s=%s" % (c["name"], c["value"])
        for c in state.get("cookies", [])
        if "thecn.com" in c.get("domain", "")
    )
    return token, cookies


def call(path, params=None, method="GET", payload=None):
    token, cookies = credentials()
    url = BASE + path
    if params:
        url += "?" + urllib.parse.urlencode(params)
    data = None
    headers = {
        "accept": "application/json, text/plain, */*",
        "cookie": cookies,
        "referer": BASE + "/user",
        "user-agent": UA,
        "token": token,
        "x-requested-with": "XMLHttpRequest",
    }
    if method != "GET":
        data = json.dumps(payload or {}).encode("utf-8")
        headers["content-type"] = "application/json"
    request = urllib.request.Request(url, data=data, headers=headers, method=method)
    with urllib.request.urlopen(request, timeout=25) as response:
        body = response.read().decode("utf-8", "replace")
    try:
        return json.loads(body)
    except Exception:
        return {"raw": body[:500], "url": url}


def me():
    return call("/api/me/", {"with_user_count": 1})


def courses(include_expired=False):
    """Enrolled courses as {number, name, internal_id, type}."""
    data = call("/api/user_menu_course_conexus/")
    out = []
    for item in data.get("data") or []:
        if item.get("type") != "course":
            continue
        name = item.get("name") or ""
        if not include_expired and re.search(r"CET", name, re.I):
            continue
        out.append({
            "number": item.get("short_id"),
            "name": name,
            "internal_id": item.get("id"),
            "url": "%s/course/%s" % (BASE, item.get("short_id")),
        })
    return out


def course(number):
    return call("/api/course_number/%s" % number)


def course_path(internal_id):
    return call("/api/course_path/", {"course_id": internal_id})


def announcements(internal_id):
    return call("/api/course_announcement/", {"course_id": internal_id})


def course_bundle(entry):
    """Everything the study panel needs for one course, in 4 API calls.

    A single failing course must not sink the whole refresh, so errors are
    reported per course instead of propagating.
    """
    internal = entry["internal_id"]
    try:
        return _course_bundle(entry)
    except Exception as err:
        return {
            "number": entry.get("number"),
            "name": entry.get("name"),
            "url": entry.get("url"),
            "error": str(err)[:200],
            "sections": [],
            "announcements": 0,
            "page_count": 0,
        }


def _course_bundle(entry):
    internal = entry["internal_id"]
    info = (course(entry["number"]).get("data") or {})
    sections = (course_path(internal).get("data") or [])
    pages = (call("/api/course_path_page/", {"course_id": internal}).get("data") or [])
    news = (announcements(internal).get("data") or [])

    by_section = {}
    for page in pages:
        by_section.setdefault(page.get("course_path_id"), []).append(page.get("title"))

    return {
        "number": entry["number"],
        "name": entry["name"],
        "url": entry["url"],
        "about": (info.get("about") or "")[:200],
        "sections": [
            {
                "title": section.get("title"),
                "pages": [t for t in by_section.get(section.get("id"), []) if t][:15],
            }
            for section in sections
        ],
        "announcements": len(news),
        "page_count": len(pages),
    }


def digest():
    """Parallel fetch of every enrolled course. Uses threads, no browser."""
    from concurrent.futures import ThreadPoolExecutor

    entries = courses()
    with ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(course_bundle, entries))


def snapshot(path=None):
    """Write the digest to JSON for other tools (default: .secrets/cn-digest.json)."""
    path = path or os.path.join(SECRETS, "cn-digest.json")
    rows = digest()
    payload = {"fetchedAt": __import__("datetime").datetime.now().isoformat(timespec="seconds"),
               "courses": rows}
    # 原子写：面板可能同时读这个文件，直接覆盖会读到半个 JSON
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(payload, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    return path, rows


if __name__ == "__main__":
    cmd = sys.argv[1] if len(sys.argv) > 1 else "me"
    if cmd == "me":
        print(json.dumps(me(), ensure_ascii=False, indent=2)[:800])
    elif cmd == "courses":
        print(json.dumps(courses(), ensure_ascii=False, indent=2)[:1500])
    elif cmd == "course":
        print(json.dumps(course(sys.argv[2]), ensure_ascii=False, indent=2)[:1200])
    elif cmd == "digest":
        print(json.dumps(digest(), ensure_ascii=False, indent=2))
    elif cmd == "snapshot":
        path, rows = snapshot()
        print("已写入 %s（%d 门课）" % (path, len(rows)))
        for row in rows:
            print("  %-52s 章节 %2d · 页面 %2d · 公告 %d" % (
                row["name"][:50], len(row["sections"]), row["page_count"], row["announcements"]))
    else:
        print(__doc__)
