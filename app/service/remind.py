#!/usr/bin/env python3
"""Push study reminders to the phone via Bark.

Covers two things:
  * assignment deadlines: 3 days before, 1 day before, and daily while overdue
  * classes: 30 minutes before they start

Run by a LaunchAgent every 5 minutes. Every reminder is de-duplicated by
(item, kind, date), so a 5-minute tick never spams the phone.

  python3 remind.py              normal run
  python3 remind.py --dry-run    print decisions, send nothing
  python3 remind.py --now 09:00  pretend it is this time (for testing)
  python3 remind.py --force      ignore the de-dupe store
"""
import datetime
import json
import os
import sys
import urllib.parse
import urllib.request

# pythonw.exe 下 stdout 是 None，print 会直接抛异常；先兜住再谈逻辑
if sys.stdout is None:
    sys.stdout = open(os.devnull, "w", encoding="utf-8")
if sys.stderr is None:
    sys.stderr = sys.stdout

HERE = os.path.dirname(os.path.abspath(__file__))
WORKSPACE = os.environ.get("STUDY_SUITE_WORKSPACE") or os.path.dirname(HERE)
SECRETS = os.environ.get("STUDY_SUITE_SECRETS") or os.path.join(WORKSPACE, ".secrets")
PLAN_FILE = os.environ.get("STUDY_SUITE_PLAN") or os.path.join(HERE, "plan.json")
TIMETABLE_FILE = os.environ.get("STUDY_SUITE_TIMETABLE") or os.path.join(HERE, "timetable.json")
STATE_FILE = os.path.join(SECRETS, "reminders.json")
def _bark_url():
    """BARK_URL 环境变量 > .secrets/bark.txt > 内置默认。"""
    if os.environ.get("BARK_URL"):
        return os.environ["BARK_URL"].strip()
    try:
        with open(os.path.join(SECRETS, "bark.txt"), encoding="utf-8") as handle:
            value = handle.read().strip()
        if value.startswith("http"):
            return value
    except Exception:
        pass
    return "https://api.day.app/TDowbgt6HKm6Szk5PD4CPh"


BARK = _bark_url()

DRY_RUN = "--dry-run" in sys.argv
FORCE = "--force" in sys.argv
NOW_OVERRIDE = None
if "--now" in sys.argv:
    NOW_OVERRIDE = sys.argv[sys.argv.index("--now") + 1]

DUE_WINDOW = 3      # days before the deadline to start reminding
CLASS_LEAD = 30     # minutes before class
QUIET_START, QUIET_END = "22:00", "07:30"
WEEKDAY_NAMES = ["", "周一", "周二", "周三", "周四", "周五", "周六", "周日"]


def load(path, default):
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception:
        return default


def save_state(state):
    os.makedirs(SECRETS, exist_ok=True)
    tmp = STATE_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, STATE_FILE)


def push(title, body):
    # safe="" 很关键：正文里的 "/" 不转义会被当成路径分隔符，Bark 返回 404
    url = "%s/%s/%s?group=study" % (
        BARK.rstrip("/"),
        urllib.parse.quote(title, safe=""),
        urllib.parse.quote(body, safe=""),
    )
    with urllib.request.urlopen(url, timeout=15) as resp:
        return resp.status


def in_quiet_hours(now):
    current = now.strftime("%H:%M")
    return current >= QUIET_START or current < QUIET_END


def parse_date(text):
    try:
        return datetime.date.fromisoformat(text)
    except Exception:
        return None


def deadline_reminders(plan, today, now):
    """3 天前 / 1 天前 / 逾期，各自每天最多一次。"""
    out = []
    for item in plan.get("items", []):
        if item.get("done"):
            continue
        due = parse_date(item.get("due") or "")
        if not due:
            continue
        left = (due - today).days
        course = item.get("course") or ""
        title = item.get("title") or ""
        if left == 3:
            out.append(("due3", item["id"], "还剩 3 天",
                        "%s %s\n截止 %s" % (course, title, due.isoformat()), 9 * 60))
        elif left == 1:
            out.append(("due1", item["id"], "明天截止",
                        "%s %s\n%s" % (course, title, due.isoformat()), 9 * 60))
        elif left < 0:
            out.append(("overdue", item["id"], "已逾期 %d 天" % (-left),
                        "%s %s\n原定 %s" % (course, title, due.isoformat()), 9 * 60))
    return out


def class_reminders(timetable, now):
    """开课前 30 分钟。"""
    out = []
    weekday = now.isoweekday()
    minutes_now = now.hour * 60 + now.minute
    for lesson in timetable.get("classes", []):
        if int(lesson.get("day") or 0) != weekday:
            continue
        start = (lesson.get("start") or "00:00").split(":")
        try:
            start_minutes = int(start[0]) * 60 + int(start[1])
        except Exception:
            continue
        delta = start_minutes - minutes_now
        if 0 < delta <= CLASS_LEAD:
            key = "%s-%s" % (lesson.get("start"), lesson.get("course"))
            body = "%s · %s\n%s" % (lesson.get("course"), lesson.get("title") or "",
                                    lesson.get("room") or "")
            out.append(("class", key, "%d 分钟后上课" % delta, body, start_minutes))
    return out


def main():
    now = datetime.datetime.now()
    if NOW_OVERRIDE:
        hour, minute = NOW_OVERRIDE.split(":")
        now = now.replace(hour=int(hour), minute=int(minute), second=0, microsecond=0)
    today = now.date()

    state = load(STATE_FILE, {})
    sent = state.get("sent", {})

    plan = load(PLAN_FILE, {"items": []})
    timetable = load(TIMETABLE_FILE, {"classes": []})

    candidates = deadline_reminders(plan, today, now) + class_reminders(timetable, now)
    if in_quiet_hours(now):
        print("[remind] 静默时段，跳过 %d 条" % len(candidates))
        return 0

    sent_count = 0
    for kind, key, title, body, earliest in candidates:
        if now.hour * 60 + now.minute < earliest - 120:  # 太早不推（比如凌晨的 9 点提醒）
            continue
        dedupe = "%s:%s:%s" % (kind, key, today.isoformat())
        if not FORCE and dedupe in sent:
            continue
        if DRY_RUN:
            print("[dry] %s | %s | %s" % (title, body.replace("\n", " / "), dedupe))
            continue
        try:
            push(title, body)
            sent[dedupe] = now.isoformat(timespec="seconds")
            sent_count += 1
            print("[sent] %s | %s" % (title, body.replace("\n", " / ")))
        except Exception as err:
            print("[fail] %s: %s" % (dedupe, err))

    # 只保留最近 30 天的去重记录
    cutoff = (today - datetime.timedelta(days=30)).isoformat()
    sent = {k: v for k, v in sent.items() if k.split(":")[-1] >= cutoff}
    if not DRY_RUN:
        save_state({"sent": sent})
    print("[remind] 候选 %d 条，发送 %d 条" % (len(candidates), sent_count))
    return 0


if __name__ == "__main__":
    sys.exit(main())
