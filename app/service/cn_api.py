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


def strip_html(text):
    """CN 的 description 是整段 HTML，抽成纯文本给"要点"用。"""
    text = re.sub(r"<(script|style)[^>]*>[\s\S]*?</\1>", " ", text or "", flags=re.I)
    text = re.sub(r"<[^>]+>", " ", text)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#39;", "'")
    )
    return re.sub(r"\s+", " ", text).strip()


# 课程章节里这几种页面才是「要交的东西」：
# assignment_submission 交文件，create_post 交帖子，view_quiz 做测验
ASSIGNMENT_ASSETS = ("assignment_submission", "create_post", "view_quiz")

_WEEKDAY_RE = re.compile(r"\b(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\b", re.I)
_CLOCK_RE = re.compile(r"\b\d{1,2}\s*(?:am|pm)\b", re.I)


def assignment_key(title):
    """同一份作业常被拆成十几个按小组/时间段分开的提交入口，归并成一个。

    「A1 - Monday: Group A (3 pm - 5 pm)」和「A1 - Tuesday: Group B (10 am - 12 pm)」
    是同一个 A1，只是入口不同；不去重的话一门课能刷出几十条重复。
    """
    text = (title or "").lower()
    text = re.sub(r"\([^)]*\)", " ", text)
    text = _WEEKDAY_RE.sub(" ", text)
    text = _CLOCK_RE.sub(" ", text)
    text = re.sub(r"\bgroup\s*[a-z]\b", " ", text)
    text = re.sub(r"\blecture\s*\d+\b", " ", text)
    # 时间范围 3-5pm / 2 pm - 4 pm
    text = re.sub(r"\b\d{1,2}\s*[-\u2013]\s*\d{1,2}\s*(?:am|pm)\b", " ", text)
    # ass / assign / assignment / assessment 归一：老师的写法五花八门
    text = re.sub(r"\b(ass|asg|assign|assignment|assessment)\b", "assessment", text)
    text = re.sub(r"[^a-z0-9\u4e00-\u9fff]+", " ", text)
    return " ".join(text.split())[:40]


def assignments():
    """每门课要交的作业。

    以前只读 /api/course_gradebook_item/，那其实是成绩册条目 —— 大部分学校的
    真正的作业在课程章节的 assignment_submission 页面里，成绩册反而只有测验。
    现在以章节页面为主、成绩册条目补充，截止时间从 gradebook_item_id 关联取，
    是否已交看 dropbox 提交记录。
    """
    from concurrent.futures import ThreadPoolExecutor

    def one(entry):
        internal = entry["internal_id"]
        result = {"number": entry["number"], "name": entry["name"], "error": "", "items": []}
        # 三个请求互不依赖，并发发出去：串行会让同步慢一倍
        fetch = {
            "pages": lambda: call("/api/course_path_page/", {"course_id": internal}).get("data") or [],
            "grade": lambda: call("/api/course_gradebook_item/", {"course_id": internal}).get("data") or [],
            "dropbox": lambda: call("/api/course_dropbox_item/", {"course_id": internal}).get("data") or [],
        }
        with ThreadPoolExecutor(max_workers=3) as pool:
            futures = {key: pool.submit(fn) for key, fn in fetch.items()}
            try:
                pages = futures["pages"].result()
                grade = futures["grade"].result()
                dropbox = futures["dropbox"].result()
            except Exception as err:
                result["error"] = str(err)[:120]
                return result

        by_id = {}
        by_name = {}
        for item in grade:
            by_id[item.get("id")] = item
            name = (item.get("name") or "").strip().lower()
            if name:
                by_name[name] = item

        submitted = set()
        for sub in dropbox:
            linked = (sub.get("gradebook_item") or {}).get("id")
            if linked:
                submitted.add(linked)

        items = []
        seen = set()
        for page in pages:
            asset = page.get("asset") or {}
            kind = asset.get("type") or ""
            if kind not in ASSIGNMENT_ASSETS:
                continue
            title = (page.get("title") or "").strip()
            if not title:
                continue
            key = assignment_key(title) or title.lower()
            if key in seen:
                continue
            seen.add(key)

            linked_item = by_id.get(page.get("gradebook_item_id") or "") or by_name.get(key) or {}
            due = linked_item.get("final_end_time") or linked_item.get("end_time") or None
            linked_id = linked_item.get("id") or ""
            items.append(
                {
                    "id": page.get("id"),
                    "title": title,
                    "type": kind,
                    "due": due,
                    "description": strip_html(page.get("description") or "")[:400],
                    "submitted": bool(linked_id) and linked_id in submitted,
                }
            )

        # 成绩册里有、章节页面里没有的条目（有些课直接拿测验当作业）
        for item in grade:
            name = (item.get("name") or "").strip()
            if not name:
                continue
            key = assignment_key(name) or name.lower()
            if key in seen:
                continue
            seen.add(key)
            items.append(
                {
                    "id": item.get("id"),
                    "title": name,
                    "type": item.get("content_type") or "",
                    "due": item.get("final_end_time") or item.get("end_time") or None,
                    "description": (item.get("description") or "")[:400],
                    "submitted": item.get("id") in submitted,
                }
            )

        result["items"] = items
        return result

    entries = courses()
    with ThreadPoolExecutor(max_workers=6) as pool:
        return list(pool.map(one, entries))


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
    elif cmd == "assignments":
        print(json.dumps(assignments(), ensure_ascii=False, indent=2))
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
