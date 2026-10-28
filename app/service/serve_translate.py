#!/usr/bin/env python3
"""Local, fully offline EN<->ZH translation service (CTranslate2 + Argos models).

Runs on 127.0.0.1 only. Model files live in .tools/models, so no network is
needed after the one-time download.

Two engines:
  * fast  — CTranslate2 opus-mt, no glossary (placeholder masking does not
            survive this engine: markers return shredded);
  * llm   — Qwen2.5-7B via MLX, macOS only; the glossary is injected into the
            system prompt as required terminology.

Accuracy features:
  * paragraph-level translation: a paragraph is translated as one unit, which
    keeps pronouns and connectives coherent;
  * configurable beam size (4 for documents, 2 for live dialogue);
  * hallucination guard: output far longer than the input is retried, then
    falls back to the fast engine.

    POST /translate       {"text","to","beam"?,"engine"?,"glossary"?}
                          glossary only affects engine=llm; the response reports
                          glossaryUsed so callers can tell whether it applied.
    POST /translate/batch {"lines":[...],"to"}               -> {lines, ms}
    GET  /health                                             -> {ok, pairs, glossary}
"""
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import difflib
import datetime
import hashlib
import pathlib
import gc
import io
import json
import math
import statistics
import os
import re
import sys
import threading
import time
import urllib.parse
import urllib.request
import wave

import ctranslate2
import numpy as np
import sentencepiece as spm

# 语音识别依赖是可选的：最小安装只有翻译/检测，缺了不能拖垮整个服务
try:
    from faster_whisper import WhisperModel
except Exception:  # ModuleNotFoundError 或加载失败
    WhisperModel = None

# ---- 可配置路径：环境变量优先；没设就按脚本自身位置推断（不含任何个人信息）----
HERE = os.path.dirname(os.path.abspath(__file__))


def _pick(env_name, *candidates):
    """Use the env var if set, else the first candidate that exists, else the first."""
    value = os.environ.get(env_name)
    if value:
        return value
    for path in candidates:
        if path and os.path.isdir(path):
            return path
    return candidates[0]


# 布局 A（macOS 开发/默认）: <workspace>/.tools/serve_translate.py
# 布局 B（安装版）: <base>/serve_translate.py，环境变量由安装脚本显式给出
WORKSPACE = _pick("STUDY_SUITE_WORKSPACE", os.path.dirname(HERE), HERE)
TOOLS = _pick("STUDY_SUITE_TOOLS", os.path.join(WORKSPACE, ".tools"), HERE)
SECRETS_DIR = _pick("STUDY_SUITE_SECRETS", os.path.join(WORKSPACE, ".secrets"), os.path.join(WORKSPACE, "secrets"))
NOTES_DIR = _pick("STUDY_SUITE_NOTES", os.path.join(WORKSPACE, "notes"), os.path.join(WORKSPACE, "notes"))
MODELS_DIR = _pick("STUDY_SUITE_MODELS", os.path.join(TOOLS, "models"), os.path.join(WORKSPACE, "models"))
BASE = MODELS_DIR
GLOSSARY_FILE = os.path.join(HERE, "glossary.json")
PORT = int(os.environ.get("CN_INTERPRETER_PORT", "8791"))
HOST = os.environ.get("CN_INTERPRETER_HOST", "127.0.0.1")
ASR_MODEL_NAME = os.environ.get("CN_ASR_MODEL", "small.en")
ASR_DRAFT_MODEL = os.environ.get("CN_ASR_DRAFT_MODEL", "base.en")

# 自检类功能统一的最小字数：/check 与 /aidetect 用同一口径，
# 否则同一份文档会在一个页面能查、另一个页面不能查
MIN_CHECK_CHARS = 40
LLM_DIR = os.path.join(MODELS_DIR, "qwen25-7b-4bit")
LLM_HTTP_BASE = os.environ.get("CN_LLM_BASE", "http://127.0.0.1:11434").rstrip("/")
LLM_HTTP_MODEL = os.environ.get("CN_LLM_MODEL", "qwen2.5:7b-instruct-q4_K_M")
DIAR_DIR = os.path.join(MODELS_DIR, "diar")

DIGEST_FILE = os.path.join(SECRETS_DIR, "cn-digest.json")
FILE_ROOTS = [os.path.expanduser("~"), os.path.join(WORKSPACE, "notes")]
FILE_EXTS = {".pdf", ".png", ".jpg", ".jpeg", ".webp", ".txt", ".md", ".docx", ".pptx", ".xlsx"}
PLAN_FILE = os.path.join(HERE, "plan.json")
TIMETABLE_FILE = os.path.join(HERE, "timetable.json")
FILTER_FILE = os.path.join(HERE, "course-filters.json")
HIDDEN_FILE = os.path.join(HERE, "hidden-courses.json")
def _ocr_binary(name):
    """优先用编译好的可执行文件；没有就退回同名 .py（Windows 上用 RapidOCR 桥接）。"""
    exe = os.path.join(HERE, "audio", name + (".exe" if os.name == "nt" else ""))
    if os.path.exists(exe):
        return exe
    py = os.path.join(HERE, "audio", name + ".py")
    if os.path.exists(py):
        return py
    return exe


OCR_BIN = _ocr_binary("ocr")
PDF_OCR_BIN = _ocr_binary("pdfocr")
PLATFORM = "windows" if os.name == "nt" else ("macos" if sys.platform == "darwin" else "linux")


_OCR_LOCK = threading.Lock()
_OCR_ENGINE = None


def _ocr_engine():
    """进程内复用 RapidOCR 引擎：每次新建都重新加载 ONNX 模型，实测慢 3 秒。"""
    global _OCR_ENGINE
    with _OCR_LOCK:
        if _OCR_ENGINE is None:
            from rapidocr_onnxruntime import RapidOCR

            _OCR_ENGINE = RapidOCR()
        return _OCR_ENGINE


def _ocr_lines(result):
    lines = []
    for item in result or []:
        text = (item[1] or "").strip()
        if text:
            lines.append(text)
    return lines


def ocr_image(path):
    """进程内识别图片；引擎不可用时抛异常，让调用方回退到子进程。"""
    result, _elapse = _ocr_engine()(path)
    return "\n".join(_ocr_lines(result))


def ocr_pdf(path, dpi=240):
    """进程内识别扫描版 PDF：PyMuPDF 渲染 + 同一套 OCR 引擎。"""
    import fitz

    engine = _ocr_engine()
    pages = []
    with fitz.open(path) as doc:
        for index, page in enumerate(doc):
            if index >= 60:
                break
            png = page.get_pixmap(dpi=dpi).tobytes("png")
            result, _elapse = engine(png)
            lines = _ocr_lines(result)
            if lines:
                pages.append("\n".join(lines))
    return "\n\n".join(pages)


def _ocr_argv(binary, *args):
    """把 [binary, *args] 变成可直接交给 subprocess 的列表（.py 需要先用解释器跑）。"""
    if binary.endswith(".py"):
        return [sys.executable, binary] + list(args)
    return [binary] + list(args)
IDLE_SECONDS = int(os.environ.get("CN_IDLE_SECONDS", "300"))  # 5 分钟无请求即卸载
IDLE = {
    # name: seconds of inactivity before the weights are released
    "llm": int(os.environ.get("CN_LLM_IDLE_SECONDS", IDLE_SECONDS)),
    "asr": int(os.environ.get("CN_ASR_IDLE_SECONDS", IDLE_SECONDS)),
    "diar": int(os.environ.get("CN_DIAR_IDLE_SECONDS", IDLE_SECONDS * 2)),
    "mt": int(os.environ.get("CN_MT_IDLE_SECONDS", IDLE_SECONDS * 2)),
}
_LAST_USED = {}

MAX_UNIT_CHARS = 600  # longer paragraphs are split before translating

# 每种模型一把锁：语音识别再慢也不该挡住翻译
_LOCK_MT = threading.Lock()          # 只保护引擎加载，不包解码
_LOCK_LLM = threading.Lock()
_MT_STATE = threading.Lock()
_MT_ACTIVE = 0                        # 正在解码的翻译请求数


class mt_session:
    """标记一次翻译正在进行：闲置卸载不会抽走正在用的模型。"""

    def __enter__(self):
        global _MT_ACTIVE
        with _MT_STATE:
            _MT_ACTIVE += 1

    def __exit__(self, *exc):
        global _MT_ACTIVE
        with _MT_STATE:
            _MT_ACTIVE -= 1
        return False


def _mt_quiet():
    with _MT_STATE:
        return _MT_ACTIVE == 0
_LOCK_ASR = threading.Lock()
_LOCK_DIAR = threading.Lock()
_LOCK = _LOCK_MT  # 兼容旧引用
_ENGINES = {}
_GLOSSARY = {"mtime": None, "en_zh": [], "zh_en": []}
_ASR = {}
_DIAR = {}
_SPEAKER_LABELS = "ABCDEFGH"
_LLM = {"model": None, "tokenizer": None, "last": 0.0, "system_en_zh": "", "system_zh_en": ""}


def relevant_terms(text, to, limit=80):
    """Glossary entries that actually occur in the text, then general fillers.

    Feeding only the first N entries meant freshly extracted course terms never
    reached the model, so match against the passage first.
    """
    pairs = glossary("en_zh" if to == "zh" else "zh_en")
    haystack = text.lower()
    hit, rest = [], []
    for source, target in pairs:
        pattern = term_pattern(source)
        if pattern and pattern.search(haystack):
            hit.append((source, target))
        else:
            rest.append((source, target))
    return (hit + rest)[:limit]


def build_system_prompt(to, text="", use_glossary=True):
    """Translation instruction with the relevant glossary inlined."""
    pairs = relevant_terms(text, to) if use_glossary else []
    table = "\n".join("%s => %s" % (src, dst) for src, dst in pairs)
    target = "Simplified Chinese" if to == "zh" else "English"
    rules = [
        "You are a professional academic translator.",
        "Translate the user's message into %s." % target,
        "Output ONLY the translation. Never add commentary, headings, preambles or extra paragraphs.",
        "If the input is a title, label or instruction, translate it literally and stop.",
        "Keep course codes, abbreviations and proper nouns unchanged (e.g. APA, UCSI, ENGL1010).",
        "Preserve numbers, percentages, week numbers, bullets and line breaks exactly.",
        "Write in formal written %s suitable for university coursework." % target,
        "Use the glossary consistently; translate anything unlisted naturally.",
    ]
    if table:
        rules.append("Glossary:\n" + table)
    return "\n".join(rules)


_LLM_PROBE = {"at": 0.0, "ok": False, "ttl": 10.0}


def _http_llm_ready():
    """本地推理服务是否在线。结果缓存 10 秒：/health 会被面板频繁调用，
    每次都去连一遍 Ollama 的话，Ollama 重启窗口里 /health 会卡 2 秒。"""
    now = time.time()
    ttl = _LLM_PROBE.get("ttl", 10.0)
    if ttl > 0 and now - _LLM_PROBE["at"] < ttl:
        return _LLM_PROBE["ok"]
    try:
        with urllib.request.urlopen(LLM_HTTP_BASE + "/api/tags", timeout=0.4) as resp:
            ok = 200 <= resp.status < 300
    except Exception:
        ok = False
    _LLM_PROBE.update(at=now, ok=ok, ttl=10.0 if ok else 30.0)
    return ok


def _http_chat(system, text, budget):
    payload = {
        "model": LLM_HTTP_MODEL,
        "messages": [
            {"role": "system", "content": system},
            {"role": "user", "content": text},
        ],
        "stream": False,
        "options": {"temperature": 0.2, "num_predict": budget},
    }
    req = urllib.request.Request(
        LLM_HTTP_BASE + "/api/chat",
        data=json.dumps(payload).encode("utf-8"),
        headers={"content-type": "application/json"},
    )
    try:
        with urllib.request.urlopen(req, timeout=300) as resp:
            data = json.loads(resp.read().decode("utf-8"))
    except Exception as err:
        raise BadRequest("本地推理服务没有响应（%s）：%s" % (LLM_HTTP_BASE, err))
    return ((data.get("message") or {}).get("content") or "").strip()


def llm_engine():
    """优先用本地 HTTP 推理服务；没有就退回 macOS 的 MLX。"""
    if _LLM.get("mode") == "http" and _LLM.get("model"):
        _LLM["last"] = time.time()
        _LAST_USED["llm"] = time.time()
        return _LLM
    if _LLM["model"] is None:
        if _http_llm_ready():
            _LLM.update(model="http:" + LLM_HTTP_MODEL, mode="http", tokenizer=None)
            _LLM["last"] = time.time()
            _LAST_USED["llm"] = time.time()
            return _LLM
        if PLATFORM != "macos":
            raise BadRequest(
                "精准翻译（7B）目前在 macOS 上用 MLX 运行；这台机器是 %s，请改用「快速」引擎。" % PLATFORM
            )
        if not os.path.isdir(LLM_DIR):
            raise BadRequest("没有找到 7B 模型（%s）。请先下载，或改用「快速」引擎。" % LLM_DIR)
        try:
            from mlx_lm import load
        except Exception as err:
            raise BadRequest("这台机器缺少 MLX 运行时（%s），请改用「快速」引擎。" % err)

        model, tokenizer = load(LLM_DIR)
        _LLM.update(model=model, tokenizer=tokenizer)
        _LLM["system_en_zh"] = build_system_prompt("zh")
        _LLM["system_zh_en"] = build_system_prompt("en")
    _LLM["last"] = time.time()
    _LAST_USED["llm"] = time.time()
    return _LLM


MLX_UNAVAILABLE = "精准翻译（7B）仅 macOS（Apple 芯片）支持，请改用快速引擎：engine=fast"


def llm_translate(text, to, beam_unused=None, use_glossary=True):
    state = llm_engine()
    system = build_system_prompt(to, text, use_glossary)
    budget = max(64, min(1024, int(len(text) * 2) + 64))
    if state.get("mode") == "http":
        output = _http_chat(system, text, budget)
        _LLM["last"] = time.time()
        return output
    try:
        from mlx_lm import generate
    except Exception as err:
        raise BadRequest("%s（%s）" % (MLX_UNAVAILABLE, err))
    messages = [
        {"role": "system", "content": system},
        {"role": "user", "content": text},
    ]
    prompt = state["tokenizer"].apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    output = generate(state["model"], state["tokenizer"], prompt=prompt, max_tokens=budget, verbose=False)
    _LLM["last"] = time.time()
    return output.strip()


def llm_translate_batch(pieces, max_items=5, max_chars=900, use_glossary=True):
    """Translate several short paragraphs in one 7B call (much faster than one by one)."""
    try:
        from mlx_lm import generate
    except Exception as err:
        raise BadRequest("%s（%s）" % (MLX_UNAVAILABLE, err))

    if not pieces:
        return []
    state = llm_engine()
    numbered = "\n".join("%d. %s" % (index + 1, text) for index, text in enumerate(pieces))
    terms = relevant_terms(" ".join(pieces), "zh") if use_glossary else []
    system = ("你是学术语境下的英译中翻译器。只输出中文译文，保留原有编号；"
              "不要解释、不要补充、不要续写。")
    if terms:
        system += "\n术语必须按以下译法：" + "；".join("%s => %s" % (a, b) for a, b in terms)
    messages = [
        {"role": "system", "content": system},
        {
            "role": "user",
            "content": "把下面每一条英文分别翻译成简体中文，保持编号，每条译文单独一行，"
                       "不要合并、不要解释：\n\n" + numbered,
        },
    ]
    prompt = state["tokenizer"].apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    budget = max(96, min(1200, int(sum(len(p) for p in pieces) * 2) + 96))
    output = generate(state["model"], state["tokenizer"], prompt=prompt, max_tokens=budget, verbose=False)
    _LLM["last"] = time.time()

    parts = re.split(r"(?m)^\s*(\d{1,2})[.、)）]\s*", output.strip())
    parsed = {}
    if len(parts) >= 3:
        for index in range(1, len(parts) - 1, 2):
            try:
                number = int(parts[index])
            except ValueError:
                continue
            parsed[number] = parts[index + 1].strip()
    if len(parsed) != len(pieces):
        return None
    return [parsed[i + 1] for i in range(len(pieces))]


def looks_hallucinated(source, output):
    """A translation shouldn't balloon far beyond the source length."""
    if not output:
        return False
    return len(output) > max(120, len(source) * 4)


def llm_translate_pieces(pieces, progress=None, use_glossary=True):
    """Batch, verify, fall back to one-by-one or the fast engine."""
    results = [""] * len(pieces)
    index = 0
    if progress:
        progress(0, len(pieces))
    while index < len(pieces):
        batch = []
        chars = 0
        while index + len(batch) < len(pieces) and len(batch) < 5 and chars < 900:
            candidate = pieces[index + len(batch)]
            if batch and chars + len(candidate) > 900:
                break
            batch.append(candidate)
            chars += len(candidate)
        try:
            translated = llm_translate_batch(batch, use_glossary=use_glossary)
        except Exception:
            translated = None
        if translated is None:
            for offset, text in enumerate(batch):
                try:
                    single = llm_translate(text, "zh")
                    if looks_hallucinated(text, single):
                        single = translate_units([text], "en_zh", 2)[0]
                    results[index + offset] = single
                except Exception:
                    results[index + offset] = ""
        else:
            for offset, text in enumerate(translated):
                results[index + offset] = text
        index += len(batch)
        if progress:
            progress(min(index, len(pieces)), len(pieces))
    return results


def sweep_idle(now=None):
    """Release idle models. Never unloads something another thread is using:
    each check holds the matching lock (non-blocking) before freeing."""
    now = now or time.time()
    freed = []

    def idle(key):
        return now - _LAST_USED.get(key, 0) >= IDLE[key]

    if _LLM["model"] is not None and idle("llm") and _LOCK_LLM.acquire(blocking=False):
        try:
            if _LLM["model"] is not None and idle("llm"):
                _LLM["model"] = None
                _LLM["tokenizer"] = None
                _LLM["mode"] = None
                try:
                    import mlx.core as mx

                    if hasattr(mx, "clear_cache"):
                        mx.clear_cache()
                except Exception:
                    pass
                freed.append("llm")
        finally:
            _LOCK_LLM.release()

    if _ASR.get("models") and idle("asr") and _LOCK_ASR.acquire(blocking=False):
        try:
            if _ASR.get("models") and idle("asr"):
                _ASR.pop("models", None)
                freed.append("asr")
        finally:
            _LOCK_ASR.release()

    # 说话人分离只在 ASR 线程里用，所以用 ASR 的锁判断是否在用
    if "pipe" in _DIAR and idle("diar") and _LOCK_ASR.acquire(blocking=False):
        try:
            if "pipe" in _DIAR and idle("diar"):
                _DIAR.pop("pipe", None)
                freed.append("diar")
        finally:
            _LOCK_ASR.release()

    if _ENGINES and idle("mt") and _mt_quiet() and _LOCK_MT.acquire(blocking=False):
        try:
            if _ENGINES and idle("mt") and _mt_quiet():
                _ENGINES.clear()
                freed.append("mt")
        finally:
            _LOCK_MT.release()

    if freed:
        gc.collect()
        sys.stderr.write("[interpreter] idle unload: %s\n" % ", ".join(freed))
    return freed


def release_all():
    """Force-release every model right now (used by the panel's button)."""
    now = time.time()
    for key in IDLE:
        _LAST_USED[key] = 0
    return sweep_idle(now)


def idle_watchdog():
    while True:
        time.sleep(30)
        sweep_idle()


MINUTES_PROMPT = """你是课堂记录助手。根据下面的转写，生成中文课堂纪要。
只输出一个 JSON 对象，不要任何解释、不要 Markdown 代码块。格式：
{"标题": "一句话概括这堂课讲了什么", "要点": ["3-6 条要点"], "待办": ["学生要做的事，没有就留空数组"], "疑问": ["课上未解决的问题，没有就留空数组"], "术语": [["英文术语", "中文译法"]]}
转写中若出现多个说话人，注意区分老师的讲解和学生的提问。"""


STOPWORDS = set("""the a an and or but if then than that this these those to of in on at for with from by as is are was were be been being it its we you they he she them us our your their this there here what which who whom whose when where why how not no yes do does did done have has had can could should would may might will just very really also more most much many some any such only own same so too s t""".split())


def quick_summary(segments, max_bullets=5):
    """Fast, model-free live summary: key sentences plus repeated terms.

    The 7B summary (/minutes) takes tens of seconds and writes a file, which is
    fine for the final minutes but useless while someone is still talking.
    """
    texts = []
    for item in segments:
        if not isinstance(item, dict):
            continue
        text = (item.get("text") or item.get("src") or "").strip()
        if len(text) > 12:
            texts.append(text)
    if not texts:
        return {"bullets": [], "keywords": []}

    words = re.findall(r"[A-Za-z]{4,}", " ".join(texts).lower())
    counts = {}
    for word in words:
        if word in STOPWORDS:
            continue
        counts[word] = counts.get(word, 0) + 1
    keywords = [w for w, _n in sorted(counts.items(), key=lambda kv: -kv[1])[:8]]

    # 句子打分：长度适中 + 含关键词，取前几条
    scored = []
    for index, text in enumerate(texts):
        lowered = text.lower()
        score = sum(1 for k in keywords if k in lowered)
        score += min(len(text), 200) / 200.0
        score += index / max(1, len(texts))          # 新内容略微加权
        scored.append((score, text))
    scored.sort(key=lambda pair: -pair[0])
    bullets = []
    for _score, text in scored:
        clean = re.sub(r"\s+", " ", text).strip()
        if any(clean[:40] == b[:40] for b in bullets):
            continue
        bullets.append(clean[:160])
        if len(bullets) >= max_bullets:
            break
    return {"bullets": bullets, "keywords": keywords}



def run_check(path, target_words=None, pattern=""):
    real, raw = local_file_bytes(path)
    return check_text(extract_text(os.path.basename(real), raw), os.path.basename(real),
                      target_words=target_words, pattern=pattern)


def run_check_bytes(filename, raw, target_words=None, pattern=""):
    return check_text(extract_text(filename, raw), filename,
                      target_words=target_words, pattern=pattern)


BRIEF_CACHE = os.path.join(SECRETS_DIR, "brief-cache")

BRIEF_PROMPT = """You read an assignment brief and answer in Simplified Chinese.
Return ONLY a JSON object:
{"字数要求": "...",
 "必须包含": ["..."],
 "评分点": [{"项": "...", "占比": "..."}],
 "提交格式": "...",
 "注意事项": ["..."]}

Hard rules:
- FACTS below were extracted by regex from the same document. They are authoritative.
  Use their word counts and percentages exactly; never invent numbers and never
  make every criterion an equal share.
- 评分点 must copy the rubric rows and their real weights. If FACTS.rubric is empty,
  use the weight table in the document; if there is still none, use "未说明".
- 必须包含 lists REQUIRED sections or deliverables only. Ignore logistics such as
  packing lists, transport, schedules, sign-in sheets, or equipment checklists.
- 字数要求: copy the range from FACTS verbatim. If the brief only gives per-section
  counts, sum them and name the sections, but use the real numbers from FACTS.
  If FACTS has no word data at all, answer exactly 未说明 — never reuse numbers
  from these instructions.
- Every item under 40 Chinese characters. No markdown, no prose outside JSON."""


def header_text(value):
    """Decode an x-filename header.

    Browsers send percent-encoded UTF-8; curl may send raw bytes that the HTTP
    layer reads back as latin-1, so try that path too and fall back to the raw
    value instead of failing.
    """
    if not value:
        return ""
    decoded = urllib.parse.unquote(value)
    try:
        return decoded.encode("latin-1").decode("utf-8")
    except Exception:
        return decoded


def local_file_bytes(path):
    """Read an allowed local file (same roots as the panel can open)."""
    real = os.path.realpath(path)
    for root in FILE_ROOTS:
        if real.startswith(os.path.realpath(root) + os.sep) and os.path.exists(real):
            with open(real, "rb") as handle:
                return real, handle.read()
    raise BadRequest("路径不在允许范围内或文件不存在")



def brief_facts(text):
    """Pull hard numbers out of the brief so the model cannot invent them."""
    facts = {"wordRanges": [], "wordCounts": [], "rubric": [], "dates": [], "formats": []}

    for low, high in re.findall(r"(\d{2,5})\s*(?:-|–|—|to)\s*(\d{2,5})\s*words", text, re.I):
        facts["wordRanges"].append("%s-%s words" % (low, high))
    for single in re.findall(r"(\d{3,5})\s*words", text, re.I):
        if single not in facts["wordCounts"]:
            facts["wordCounts"].append(single + " words")

    # 百分比 + 它前面那段文字里的标签
    for match in re.finditer(r"(\d{1,3})\s*%", text):
        weight = match.group(1) + "%"
        if match.group(1) in ("100", "0"):
            continue          # 总分/占位不是评分项
        before = text[max(0, match.start() - 160):match.start()]
        before = re.sub(r"\s+", " ", before).strip(" .:-")
        label = before.split(".")[-1].split(":")[-1].strip()
        label = " ".join(label.split()[-8:]).strip(" (")
        if not label or label.endswith("(") or len(label) < 4:
            continue          # 只剩表头/括号的残片
        if not re.search(r"[A-Za-z\u4e00-\u9fff]{3,}", label):
            continue
        if any(row["项"] == label[:40] for row in facts["rubric"]):
            continue
        facts["rubric"].append({"项": label[:40], "占比": weight})

    for date in re.findall(r"\b(\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2})\b", text):
        if date not in facts["dates"]:
            facts["dates"].append(date)
    for fmt in ("PDF", "DOCX", "DOC", "MP4", "PPTX"):
        if re.search(r"\b%s\b" % fmt, text, re.I) and fmt not in facts["formats"]:
            facts["formats"].append(fmt)
    return facts


def run_brief(path):
    real, raw = local_file_bytes(path)
    text = extract_text(os.path.basename(real), raw).strip()
    if len(text) < 120:
        raise BadRequest("这份文件里的文字太少（%d 字），可能不是作业说明" % len(text))

    facts = brief_facts(text)

    cache_key = "%s-%d" % (hashlib.sha1(real.encode()).hexdigest()[:12], int(os.path.getmtime(real)))
    cache_path = os.path.join(BRIEF_CACHE, cache_key + ".json")
    try:
        with open(cache_path, encoding="utf-8") as handle:
            cached = json.load(handle)
        cached["cached"] = True
        return cached
    except Exception:
        pass

    # 平台检查放在 import 之前：Windows 上 ImportError 会变成 500
    state = llm_engine()
    from mlx_lm import generate

    messages = [
        {"role": "system", "content": BRIEF_PROMPT},
        {"role": "user", "content": text[:7000]},
    ]
    messages[1]["content"] = text[:12000] + "\n\nFACTS:\n" + json.dumps(facts, ensure_ascii=False)
    prompt = state["tokenizer"].apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    raw_out = generate(state["model"], state["tokenizer"], prompt=prompt, max_tokens=700, verbose=False)

    data = None
    start, end = raw_out.find("{"), raw_out.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(raw_out[start:end + 1])
        except Exception:
            data = None
    if not isinstance(data, dict):
        data = {"字数要求": "未解析", "必须包含": [], "评分点": [], "提交格式": "", "注意事项": [raw_out.strip()[:300]]}

    # 模型可能仍然写“未说明”：用正则事实兜底
    if not (facts["wordRanges"] or facts["wordCounts"]):
        data["字数要求"] = "未说明"
    else:
        # 模型给的数字和原文对不上时，以正则抽到的为准（实测模型会把 200-250 写成 250-450）
        # 有区间就不要再列单个数字：区间里的 250/450 会被重复抓出来
        parts = facts["wordRanges"] if facts["wordRanges"] else facts["wordCounts"]
        expected = set()
        for part in parts:
            expected.update(re.findall(r"\d+", part))
        answer_numbers = set(re.findall(r"\d+", str(data.get("字数要求") or "")))
        if expected and answer_numbers != expected:
            cleaned = []
            for part in parts:
                value = part.replace(" words", "").strip()
                if value not in cleaned:
                    cleaned.append(value)
            data["字数要求"] = " + ".join(cleaned) + " 词"
    rubric = [row for row in (data.get("评分点") or []) if isinstance(row, dict)]
    if facts["rubric"]:
        if len(rubric) == len(facts["rubric"]):
            # 条数一致：保留模型给的项名，权重换成原文里的真实百分比
            for row, fact_row in zip(rubric, facts["rubric"]):
                row["占比"] = fact_row["占比"]
        data["评分点"] = rubric
    logistics = ("装备", "着装", "补水", "后勤", "日程", "签到", "交通", "住宿",
                 "保险", "packing", "transport", "schedule", "checklist")
    keep = []
    for item in data.get("必须包含") or []:
        text_item = str(item)
        if any(word in text_item.lower() or word in text_item for word in logistics):
            continue
        if text_item not in keep:
            keep.append(text_item)
    data["必须包含"] = keep[:8]
    data["facts"] = facts
    data["filename"] = os.path.basename(real)
    data["chars"] = len(text)
    data["cached"] = False
    try:
        os.makedirs(BRIEF_CACHE, exist_ok=True)
        with open(cache_path, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=2)
    except Exception:
        pass
    return data


def check_text(text, name, target_words=None, pattern=""):
    text = (text or "").strip()
    if len(text) < MIN_CHECK_CHARS:
        raise BadRequest(
            "文件里可读文字太少（%d 字），至少 %d 字才能检查" % (len(text), MIN_CHECK_CHARS)
        )

    # 参考文献也算进字数会虚高，先切掉再数
    body = text
    ref_match = None
    for ref_pattern in (r"\breferences\b", r"参考文献"):
        found = list(re.finditer(ref_pattern, text, re.I))
        if found:
            ref_match = found[-1]
            break
    if ref_match and ref_match.start() > len(text) * 0.3:
        body = text[:ref_match.start()]

    english = re.findall(r"[A-Za-z][A-Za-z'\-]*", body)
    chinese = re.findall(r"[\u4e00-\u9fff]", body)
    words = len(english)

    # 括号式 (Smith, 2020) + 叙述式 Smith (2020) 都算引用
    inline = re.findall(r"\([A-Z][A-Za-z .&'\-]{1,40},\s*\d{4}[a-z]?\)", body)
    inline += re.findall(r"\b[A-Z][A-Za-z\-]{2,30}\s+(?:et al\.\s*)?\((?:19|20)\d{2}[a-z]?\)", body)
    references = 0
    marker = ref_match.start() if ref_match else -1
    if marker >= 0:
        tail = text[marker:]
        # 只数“像参考文献”的行：长度够且带年份，避免把正文段落算进来
        references = len([
            line for line in tail.splitlines()[1:]
            if len(line.strip()) > 15 and re.search(r"\b(19|20)\d{2}\b", line)
        ])

    issues = []
    if target_words:
        low, high = target_words if isinstance(target_words, (list, tuple)) else (target_words, None)
        if words < low:
            issues.append({"level": "warn", "text": "字数 %d，低于要求 %d，还差 %d 词" % (words, low, low - words)})
        elif high and words > high:
            issues.append({"level": "warn", "text": "字数 %d，超过上限 %d（会被扣分）" % (words, high)})
        else:
            issues.append({"level": "ok", "text": "字数 %d，符合要求" % words})
    else:
        issues.append({"level": "info", "text": "字数 %d（英文词）/ %d（汉字）" % (words, len(chinese))})

    if inline:
        issues.append({"level": "ok", "text": "文内引用 %d 处" % len(inline)})
    else:
        issues.append({"level": "warn", "text": "没检测到 APA 形式的文内引用，如 (Smith, 2020)"})
    if references:
        issues.append({"level": "ok", "text": "参考文献 %d 条" % references})
    else:
        issues.append({"level": "warn", "text": "没找到 References 段落"})

    if pattern:
        token = pattern.replace("NAME", "").replace("ID", "").strip("_- ")
        issues.append({
            "level": "ok" if (not token or all(part.lower() in name.lower() for part in token.split("_"))) else "warn",
            "text": "文件名 %s（要求 %s）" % (name, pattern),
        })

    result = {
        "filename": name,
        "words": words,
        "chars": len(text),
        "inlineCitations": len(inline),
        "references": references,
        "issues": issues,
    }
    try:
        detection = ai_rate(text)
        result["aiRate"] = detection.get("score")
        result["aiBand"] = detection.get("band")
    except Exception as err:
        result["aiRate"] = None
        result["aiError"] = str(err)[:80]
    return result



def cn_login_browser(timeout=300):
    """弹出系统 Edge 让用户登录 CN，读 localStorage 里的 cn_token。

    用 playwright 的 channel="msedge" 复用系统浏览器，不下载 chromium。
    登录过程中页面会跳转（登录页 -> 首页），evaluate 会抛 "Execution context was destroyed"，
    这不是窗口关闭——所以要先判断浏览器连接是否还在，再决定继续还是退出。
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception as err:
        raise BadRequest("没有安装 playwright（%s）。可以手动粘贴 token，或 pip install playwright 后重试。" % err)

    token = ""
    closed = False
    try:
        with sync_playwright() as pw:
            browser = pw.chromium.launch(channel="msedge", headless=False)
            try:
                context = browser.new_context()
                page = context.new_page()
                try:
                    page.goto("https://www.thecn.com/", wait_until="domcontentloaded", timeout=60000)
                except Exception:
                    pass  # 首次打开慢一点没关系，继续轮询

                deadline = time.time() + timeout
                while time.time() < deadline:
                    if not browser.is_connected():
                        closed = True
                        break
                    for tab in context.pages:
                        try:
                            value = tab.evaluate("localStorage.getItem('cn_token') || ''")
                        except Exception:
                            continue  # 这个标签正在导航，换下一个 / 下一轮
                        if value:
                            token = value
                            break
                    if token:
                        break
                    time.sleep(0.8)
            finally:
                try:
                    browser.close()
                except Exception:
                    pass
    except BadRequest:
        raise
    except Exception as err:
        raise BadRequest("启动浏览器失败：%s" % err)

    if not token:
        if closed:
            raise BadRequest("窗口被关闭了，登录取消")
        raise BadRequest("等了 %d 秒还没登录成功，已取消" % timeout)

    name = cn_verify_token(token)
    cn_save_token(token)
    return name


def cn_verify_token(token):
    """Call /api/me/ with this token before saving it.

    Saving first would let a typo overwrite a working login state.
    """
    sys.path.insert(0, HERE)
    import cn_api as cn_module
    request = urllib.request.Request(
        "https://www.thecn.com/api/me/?with_user_count=1",
        headers={
            "accept": "application/json, text/plain, */*",
            "token": token,
            "referer": "https://www.thecn.com/user",
            "user-agent": cn_module.UA,
            "x-requested-with": "XMLHttpRequest",
        },
    )
    with urllib.request.urlopen(request, timeout=25) as response:
        payload = json.load(response)
    if not payload.get("result"):
        raise BadRequest("CN 返回未登录")
    data = payload.get("data") or {}
    return data.get("name") or data.get("nickname") or data.get("username") or ""


def cn_save_token(token):
    """Save a CN token in the same shape cn_api.py expects.

    Only the token is needed: /api/me/ authenticates on the `token` header
    alone (verified), so we do not have to capture browser cookies.
    """
    token = (token or "").strip().strip('"')
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,128}", token or ""):
        raise BadRequest("token 看起来不对（应为 16-128 位字母/数字/-/_）")
    state = {
        "cookies": [],
        "origins": [{
            "origin": "https://www.thecn.com",
            "localStorage": [{"name": "cn_token", "value": token}],
        }],
    }
    os.makedirs(SECRETS_DIR, exist_ok=True)
    path = os.path.join(SECRETS_DIR, "cn-state.json")
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(state, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    try:
        os.chmod(path, 0o600)
    except Exception:
        pass
    return path


def build_minutes(segments):
    """Ask the local chat model for a structured summary, then save it."""
    if not isinstance(segments, list):
        raise BadRequest("segments 必须是数组")
    segments = [item for item in segments if isinstance(item, dict)]
    if not segments:
        raise BadRequest("没有可用的转写内容")
    lines = []
    for item in segments:
        speaker = item.get("speaker") or "说话人A"
        text = (item.get("text") or "").strip()
        if text:
            lines.append("[%s] %s" % (speaker, text))
    transcript = "\n".join(lines)
    if not transcript:
        raise BadRequest("没有可用的转写内容")

    from mlx_lm import generate

    state = llm_engine()
    messages = [
        {"role": "system", "content": MINUTES_PROMPT},
        {"role": "user", "content": transcript[:6000]},
    ]
    prompt = state["tokenizer"].apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
    raw = generate(state["model"], state["tokenizer"], prompt=prompt, max_tokens=900, verbose=False)

    data = None
    start, end = raw.find("{"), raw.rfind("}")
    if start >= 0 and end > start:
        try:
            data = json.loads(raw[start : end + 1])
        except Exception:
            data = None
    if not isinstance(data, dict):
        data = {"标题": "课堂记录", "要点": [raw.strip()[:500]], "待办": [], "疑问": [], "术语": []}

    stamp = datetime.datetime.now().strftime("%Y-%m-%d-%H%M")
    os.makedirs(NOTES_DIR, exist_ok=True)
    path = os.path.join(NOTES_DIR, "%s-课堂纪要.md" % stamp)
    markdown = ["# %s" % data.get("标题", "课堂记录"), "", "> %s ｜ %s" % (stamp, "本地离线生成"), ""]
    markdown.append("## 要点")
    for point in data.get("要点") or []:
        markdown.append("- %s" % point)
    for key in ("待办", "疑问"):
        items = data.get(key) or []
        if items:
            markdown.append("")
            markdown.append("## %s" % key)
            for item in items:
                markdown.append("- [ ] %s" % item if key == "待办" else "- %s" % item)
    terms = data.get("术语") or []
    if terms:
        markdown.append("")
        markdown.append("## 术语")
        for pair in terms:
            if isinstance(pair, (list, tuple)) and len(pair) >= 2:
                markdown.append("- %s → %s" % (pair[0], pair[1]))
    markdown.append("")
    markdown.append("---")
    markdown.append("")
    markdown.append("## 原始转写")
    markdown.extend("**%s**：%s" % (item.get("speaker", ""), item.get("text", "")) for item in segments)
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(markdown))

    return {"minutes": data, "path": path, "transcript": transcript}


def load_plan():
    if not os.path.exists(PLAN_FILE):
        return {"items": [], "updatedAt": ""}
    try:
        with open(PLAN_FILE, encoding="utf-8") as handle:
            return json.load(handle)
    except Exception as err:
        sys.stderr.write("[interpreter] plan read failed: %s\n" % err)
        return {"items": [], "updatedAt": ""}


def save_plan(plan):
    tmp = PLAN_FILE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as handle:
        json.dump(plan, handle, ensure_ascii=False, indent=2)
    os.replace(tmp, PLAN_FILE)


def extract_text(filename, data):
    """Pull plain text out of txt / docx / pdf / image bytes."""
    ext = os.path.splitext((filename or "").lower())[1]
    if ext in (".txt", ".md", ".csv", ".json", ".text", ""):
        return data.decode("utf-8", "replace")
    if ext == ".docx":
        import docx

        document = docx.Document(io.BytesIO(data))
        parts = [p.text for p in document.paragraphs]
        for table in document.tables:
            for row in table.rows:
                parts.append(" ".join(cell.text for cell in row.cells))
        return "\n".join(x for x in parts if x.strip())
    if ext == ".pdf":
        import pypdf

        text = ""
        try:
            reader = pypdf.PdfReader(io.BytesIO(data))
            text = "\n".join((page.extract_text() or "") for page in reader.pages)
        except Exception as err:
            sys.stderr.write("[interpreter] pypdf failed: %s\n" % err)
        if len(text.strip()) >= 40:
            return text
        # 扫描版 PDF 没有文字层：渲染成图片再 OCR
        if not os.path.exists(PDF_OCR_BIN):
            raise BadRequest(
                "这个 PDF 没有文字层（多半是扫描件），而本机没有安装 PDF OCR 组件。"
                "请改用文字版 PDF、Word，或直接粘贴文字。"
            )
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=".pdf", delete=False) as handle:
            handle.write(data)
            path = handle.name
        try:
            try:
                text = ocr_pdf(path)
                if text.strip():
                    return text
            except Exception as err:
                sys.stderr.write("[interpreter] 进程内 PDF OCR 失败，回退子进程: %s\n" % err)
            out = subprocess.run(_ocr_argv(PDF_OCR_BIN, path, "6", capture_output=True, text=True, timeout=180))
            ocr_text = out.stdout or ""
            if len(ocr_text.strip()) >= 40:
                return ocr_text
            raise BadRequest("这个 PDF 抽不出文字（可能是加密的、或扫描件 OCR 失败）")
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
    if ext in (".png", ".jpg", ".jpeg", ".webp", ".heic", ".tiff", ".bmp"):
        if not os.path.exists(OCR_BIN):
            raise BadRequest(
                "这台机器没有安装 OCR 组件，图片识别不可用。"
                "可以先用 .txt / .docx / 文字版 PDF；或安装 Xcode 命令列工具后重跑安装脚本（macOS）。"
            )
        import subprocess
        import tempfile

        with tempfile.NamedTemporaryFile(suffix=ext, delete=False) as handle:
            handle.write(data)
            path = handle.name
        try:
            try:
                return ocr_image(path)
            except BadRequest:
                raise
            except Exception as err:
                sys.stderr.write("[interpreter] 进程内 OCR 失败，回退子进程: %s\n" % err)
            out = subprocess.run(_ocr_argv(OCR_BIN, path, capture_output=True, text=True, timeout=60))
            if out.returncode != 0:
                raise ValueError("图片识别失败: %s" % (out.stdout or out.stderr)[:80])
            return out.stdout
        finally:
            try:
                os.unlink(path)
            except OSError:
                pass
    raise BadRequest("不支持的文件类型: %s" % (ext or "(无扩展名)"))


def clamp01(value):
    return max(0.0, min(1.0, value))


def perplexity_windows(text, window_tokens=110, max_windows=3):
    """Perplexity over consecutive windows, so uniformity can be measured.

    AI prose tends to sit at a suspiciously constant perplexity; human writing
    drifts. Returns a list of {ppl, sample} from longest to shortest.
    """
    try:
        import mlx.core as mx
    except Exception:
        return []
    try:
        state = llm_engine()
        ids = state["tokenizer"].encode(text)
        if len(ids) < 60:
            return []
        windows = max(1, min(max_windows, len(ids) // window_tokens or 1))
        size = max(60, len(ids) // windows)
        out = []
        for index in range(windows):
            piece = ids[index * size : (index + 1) * size]
            if len(piece) < 30:
                continue
            arr = mx.array(piece)[None, :]
            with _LOCK_LLM:
                logits = state["model"](arr)[:, :-1, :]
                targets = arr[:, 1:]
                logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
                picked = mx.take_along_axis(logprobs, targets[..., None], axis=-1).squeeze(-1)
                nll = float(-mx.mean(picked))
            _LAST_USED["llm"] = time.time()
            out.append({
                "ppl": round(math.exp(nll), 2),
                "sample": state["tokenizer"].decode(piece)[:120].strip(),
            })
        return out
    except Exception as err:
        sys.stderr.write("[interpreter] perplexity windows failed: %s\n" % err)
        return []


def text_perplexity(text, max_tokens=400):
    """Perplexity under the local chat model (lower usually means machine-like)."""
    try:
        import mlx.core as mx
    except Exception:
        return None
    try:
        state = llm_engine()
        ids = state["tokenizer"].encode(text)
        if len(ids) < 12:
            return None
        ids = ids[:max_tokens]
        arr = mx.array(ids)[None, :]
        # MLX 模型不是线程安全的：和翻译共用一把锁，避免并发前向把进程打崩
        with _LOCK_LLM:
            logits = state["model"](arr)[:, :-1, :]
            targets = arr[:, 1:]
            logprobs = logits - mx.logsumexp(logits, axis=-1, keepdims=True)
            picked = mx.take_along_axis(logprobs, targets[..., None], axis=-1).squeeze(-1)
            nll = float(-mx.mean(picked))
        _LAST_USED["llm"] = time.time()
        return round(math.exp(nll), 2)
    except Exception as err:
        sys.stderr.write("[interpreter] perplexity failed: %s\n" % err)
        return None


AI_CONNECTIVES = [
    "首先", "其次", "再者", "综上所述", "总的来说", "值得注意的是", "不难发现",
    "至关重要", "发挥着重要作用", "在不断发展的", "随着科技的", "深入探讨",
    "comprehensive overview", "it is worth noting", "in the realm of", "navigate the complexities",
    "furthermore", "moreover", "in addition", "additionally", "in conclusion",
    "it is important to note", "plays a crucial role", "in today's", "underscores",
    "delve into", "rich tapestry", "multifaceted", "comprehensive understanding",
    "significant role", "vital component", "rapidly evolving", "in summary",
    "overall,", "consequently", "therefore,", "notably",
]


def connective_density(text):
    """AI-flavoured discourse markers per 100 words (LLMs overuse them)."""
    # 中文按 1 字 ≈ 0.6 词折算，否则密度会被英文词数除成天量
    english = len(re.findall(r"[A-Za-z']+", text))
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    words = max(1, english + int(chinese / 1.6))
    lowered = text.lower()
    hits = sum(lowered.count(marker) for marker in AI_CONNECTIVES)
    return round(hits * 100.0 / words, 2)


def opening_transition_ratio(sentences):
    """Share of sentences that open with a discourse marker.

    LLM prose leans on "Furthermore, ..." / "Moreover, ..." openings far more
    than people do, so this separates cleanly without punishing short texts.
    """
    if not sentences:
        return 0.0
    starters = ("furthermore", "moreover", "additionally", "in addition", "however",
                "therefore", "consequently", "in conclusion", "notably", "overall",
                "首先", "其次", "此外", "然而", "因此", "总之", "综上")
    hits = 0
    for sentence in sentences:
        head = sentence.strip().lower()[:24]
        if any(head.startswith(word) for word in starters):
            hits += 1
    return round(hits / len(sentences), 3)


AI_CLICHES = [
    "in today's fast-paced world", "it is important to note", "delve into", "in the realm of",
    "navigate the complexities", "plays a crucial role", "plays a vital role", "ever-evolving",
    "in conclusion", "to sum up", "landscape of", "tapestry", "testament to", "not only",
    "furthermore", "moreover", "additionally", "consequently", "a myriad of", "seamless",
    "unlock the potential", "harness the power", "at the forefront", "paradigm shift",
    # 中文常见 AI 腔
    "在当今", "值得注意的是", "发挥着至关重要的作用", "起着重要作用", "综上所述",
    "随着.*的不断发展", "本文旨在", "赋能", "深度融合", "进一步提升",
]


def cliche_hits(text):
    """Hits per 100 words of stock LLM phrasing."""
    english = len(re.findall(r"[A-Za-z']+", text))
    chinese = len(re.findall(r"[\u4e00-\u9fff]", text))
    words = max(1, english + int(chinese / 1.6))
    lower = text.lower()
    hits = 0
    for phrase in AI_CLICHES:
        if ".*" in phrase:
            hits += len(re.findall(phrase, lower))
        else:
            hits += lower.count(phrase)
    return round(hits / words * 100, 2), hits


def ai_rate(text):
    """Heuristic AI-likelihood score. An indicator, never a verdict."""
    clean = re.sub(r"\s+", " ", text).strip()
    sentences = [s.strip() for s in re.split(r"(?<=[.!?。！？])\s+", clean) if len(s.strip()) > 6]
    lengths = [len(s) for s in sentences]
    mean_len = statistics.mean(lengths) if lengths else 0
    cv = None
    if len(lengths) >= 6 and 40 <= mean_len <= 180:
        cv = round(statistics.pstdev(lengths) / mean_len, 3)

    density = connective_density(clean)
    windows = perplexity_windows(clean)
    ppls = [w["ppl"] for w in windows]
    mean_ppl = round(statistics.mean(ppls), 2) if ppls else None
    ppl_cv = None
    if len(ppls) >= 2 and statistics.mean(ppls):
        ppl_cv = round(statistics.pstdev(ppls) / statistics.mean(ppls), 3)

    parts = {}
    if mean_ppl is not None:
        # 实测：学生写作 11–16，7B 自生成 3.8；拐点取 10，斜率 6
        parts["perplexity"] = {
            "label": "困惑度（越低越像机器生成）",
            "value": mean_ppl,
            "aiHint": round(clamp01((10 - mean_ppl) / 6), 3),
            "weight": 0.5,
        }
    parts["connectives"] = {
        "label": "AI 惯用连接词密度（每百词）",
        "value": density,
        "aiHint": round(clamp01(density / 3.0), 3),
        "weight": 0.15,
    }
    cliche_density, cliche_count = cliche_hits(clean)
    if cliche_density:
        parts["cliches"] = {
            "label": "AI 套话密度（每百词）",
            "value": cliche_density,
            "aiHint": round(clamp01(cliche_density / 4.0), 3),
            "weight": 0.2,
        }
    opening = opening_transition_ratio(sentences)
    parts["openings"] = {
        "label": "句子以连接词开头的比例",
        "value": opening,
        "aiHint": round(clamp01((opening - 0.12) / 0.35), 3),
        "weight": 0.15,
    }
    if cv is not None:
        parts["burstiness"] = {
            "label": "句长波动（越均匀越像机器）",
            "value": cv,
            "aiHint": round(clamp01((0.45 - cv) / 0.35), 3),
            "weight": 0.15,
        }

    total_weight = sum(p["weight"] for p in parts.values()) or 1
    score = int(round(sum(p["aiHint"] * p["weight"] for p in parts.values()) / total_weight * 100))

    # 困惑度极低是决定性证据：模型自己的产出通常低于 5，人写的很少低于 8
    if mean_ppl is not None:
        if mean_ppl < 5:
            score = max(score, 82)
        elif mean_ppl < 6.5:
            score = max(score, 65)

    # 证据不足（太短，拿不到困惑度）时不给高置信结论
    confident = "perplexity" in parts
    if not confident and score > 55:
        score = 55
    if confident:
        band = "很像 AI 生成" if score >= 70 else "可能含 AI 成分" if score >= 45 else "更像人工撰写"
    else:
        band = "样本偏短，仅供参考"

    suspects = []
    if len(windows) >= 2:
        worst = min(windows, key=lambda w: w["ppl"])
        suspects.append({"ppl": worst["ppl"], "text": worst["sample"]})

    return {
        "score": score,
        "band": band,
        "components": parts,
        "suspects": suspects,
        "sentences": len(sentences),
        "words": len(words_of(clean)),
        "chars": len(clean),
        "caveat": "本地启发式指标（困惑度 + 连接词密度 + 句首连接词比例 + 句长波动），只能当参考，不等于 Turnitin 等权威判定。",
    }


def words_of(text):
    return re.findall(r"[A-Za-z']+|[\u4e00-\u9fff]", text)


def asr_model(name=None):
    """Lazy-load a Whisper model (English, int8, CPU). Cached per model name."""
    if WhisperModel is None:
        raise BadRequest(
            "语音识别未安装。请用 -Full 参数重跑安装脚本："
            " powershell -ExecutionPolicy Bypass -File install.ps1 -Full"
        )
    wanted = name or ASR_MODEL_NAME
    models = _ASR.setdefault("models", {})
    if wanted not in models:
        models[wanted] = WhisperModel(
            wanted,
            device="cpu",
            compute_type="int8",
            download_root=os.path.join(MODELS_DIR, "whisper"),
        )
    _LAST_USED["asr"] = time.time()
    return models[wanted]


def read_wav_bytes(body):
    """Decode 16-bit mono WAV bytes into float32 mono audio."""
    with wave.open(io.BytesIO(body), "rb") as handle:
        if handle.getsampwidth() != 2:
            raise ValueError("只支持 16-bit PCM WAV")
        channels = handle.getnchannels()
        rate = handle.getframerate()
        raw = handle.readframes(handle.getnframes())
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16000:
        # linear resample keeps this dependency-free
        target = int(round(len(audio) * 16000 / rate))
        audio = np.interp(
            np.linspace(0, len(audio) - 1, target, dtype=np.float32),
            np.arange(len(audio), dtype=np.float32),
            audio,
        ).astype(np.float32)
    return audio


def diarizer():
    """Lazy-load the offline speaker diarization pipeline."""
    if "pipe" not in _DIAR:
        import sherpa_onnx

        config = sherpa_onnx.OfflineSpeakerDiarizationConfig(
            segmentation=sherpa_onnx.OfflineSpeakerSegmentationModelConfig(
                pyannote=sherpa_onnx.OfflineSpeakerSegmentationPyannoteModelConfig(
                    model=os.path.join(DIAR_DIR, "sherpa-onnx-pyannote-segmentation-3-0", "model.onnx")
                ),
                num_threads=2,
            ),
            embedding=sherpa_onnx.SpeakerEmbeddingExtractorConfig(
                model=os.path.join(DIAR_DIR, "campplus.onnx"), num_threads=2
            ),
            clustering=sherpa_onnx.FastClusteringConfig(num_clusters=-1, threshold=0.6),
            min_duration_on=0.25,
            min_duration_off=0.35,
        )
        _DIAR["pipe"] = sherpa_onnx.OfflineSpeakerDiarization(config)
    _LAST_USED["diar"] = time.time()
    return _DIAR["pipe"]


def speaker_turns(audio):
    """Return [(start, end, speaker_index)] for the whole clip."""
    result = diarizer().process(audio)
    return [(seg.start, seg.end, seg.speaker) for seg in result.sort_by_start_time()]


def assign_speakers(segments, turns):
    """Give each Whisper segment the speaker with the largest time overlap."""
    if not turns:
        return segments, 1
    order = []
    for _, _, speaker in turns:
        if speaker not in order:
            order.append(speaker)
    if len(order) == 1:
        for segment in segments:
            segment["speaker"] = "说话人" + _SPEAKER_LABELS[0]
        return segments, 1

    for segment in segments:
        best_speaker = None
        best_overlap = 0.0
        for start, end, speaker in turns:
            overlap = min(segment["end"], end) - max(segment["start"], start)
            if overlap > best_overlap:
                best_overlap = overlap
                best_speaker = speaker
        if best_speaker is None:
            midpoint = (segment["start"] + segment["end"]) / 2
            best_speaker = min(turns, key=lambda t: abs((t[0] + t[1]) / 2 - midpoint))[2]
        index = order.index(best_speaker)
        segment["speaker"] = "说话人" + _SPEAKER_LABELS[min(index, len(_SPEAKER_LABELS) - 1)]
    return segments, len(order)


def run_asr(body, prompt="", use_vad=True, beam=5, model=None, context=""):
    try:
        audio = read_wav_bytes(body)
    except Exception as err:
        raise BadRequest("音频格式不支持（需要 16-bit PCM WAV）: %s" % err)
    duration = len(audio) / 16000.0
    if duration < 0.35:
        return {"text": "", "segments": [], "duration": round(duration, 2), "reason": "too-short"}

    # 客户端已经按静音切好片时跳过内部 VAD：双重门限会把 1-2 秒的短句整段吞掉
    options = {
        "beam_size": max(1, min(5, int(beam))),
        "language": "en",
        "condition_on_previous_text": False,
        "vad_filter": bool(use_vad),
    }
    if use_vad:
        options["vad_parameters"] = {"min_silence_duration_ms": 400, "threshold": 0.5}
    if prompt == "auto":
        # 术语给词汇，上文给语境。两者必须并到同一行并且总长受控：
        # 术语表 40 条约 990 字符，先占满就会把上文挤出 800 字符的窗口（实测 WER 10.5% vs 7.4%）
        terms = [src for src, _dst in glossary("en_zh")][:40]
        tail = context[-280:].strip()
        budget = max(120, 760 - len(tail) - 1)
        term_text = ", ".join(terms)
        if len(term_text) > budget:
            term_text = term_text[:budget].rsplit(",", 1)[0]
        prompt = (term_text + (" " + tail if tail else "")).strip()
    if prompt:
        options["initial_prompt"] = prompt[:800]

    segments, info = asr_model(model).transcribe(audio, **options)
    items = []
    for segment in segments:
        text = segment.text.strip()
        if not text:
            continue
        items.append({"start": round(segment.start, 2), "end": round(segment.end, 2), "text": text})

    speaker_count = 1
    if items:
        try:
            turns = speaker_turns(audio)
            items, speaker_count = assign_speakers(items, turns)
        except Exception as err:
            sys.stderr.write("[interpreter] diarization failed: %s\n" % err)

    return {
        "text": " ".join(item["text"] for item in items),
        "segments": items,
        "speakers": speaker_count,
        "duration": round(duration, 2),
        "vadFiltered": True,
    }


def mt_threads():
    """Pick the decoder thread count.

    Benchmarks on a 24-core Ultra 9: 1 thread 88ms, 4 → 40ms, 8 → 35ms, 24 → 48ms.
    Going above 8 makes short single-batch requests slower, so cap it.
    """
    override = os.environ.get("CN_MT_THREADS")
    if override:
        try:
            return max(1, int(override))
        except ValueError:
            pass
    cores = os.cpu_count() or 4
    # 半核数封顶 8：24 核 → 8（实测最优），10 核 → 5，8 核 → 4
    return max(1, min(8, max(1, cores // 2)))


def engine(direction):
    """direction: 'en_zh' or 'zh_en' (lazily loaded, cached).

    锁只覆盖加载：解码本身是线程安全的，长文档不该挡住另一条短句。
    """
    cached = _ENGINES.get(direction)
    if cached is not None:
        _LAST_USED["mt"] = time.time()
        return cached
    with _LOCK_MT:
        cached = _ENGINES.get(direction)
        if cached is not None:
            _LAST_USED["mt"] = time.time()
            return cached
        root = os.path.join(BASE, direction, "translate-%s-1_9" % direction)
        translator = ctranslate2.Translator(
            os.path.join(root, "model"),
            device="cpu",
            compute_type="int8",
            inter_threads=1,
            intra_threads=mt_threads(),
        )
        sp = spm.SentencePieceProcessor(model_file=os.path.join(root, "sentencepiece.model"))
        _ENGINES[direction] = (translator, sp)
        _LAST_USED["mt"] = time.time()
        return _ENGINES[direction]


def glossary(direction):
    """Load/reload glossary.json when it changes; longest terms first."""
    try:
        mtime = os.path.getmtime(GLOSSARY_FILE)
    except OSError:
        return []
    if _GLOSSARY["mtime"] != mtime:
        with open(GLOSSARY_FILE, "r", encoding="utf-8") as handle:
            raw = json.load(handle)
        for key in ("en_zh", "zh_en"):
            pairs = [tuple(pair) for pair in raw.get(key, []) if len(pair) == 2]
            pairs.sort(key=lambda pair: len(pair[0]), reverse=True)
            _GLOSSARY[key] = pairs
        _GLOSSARY["mtime"] = mtime
    return _GLOSSARY.get(direction, [])


def term_pattern(source):
    """Regex for a glossary term that also matches its common inflections.

    Only the final word is inflected (source -> sources, study -> studies,
    analysis -> analyses) so multi-word terms stay precise. Letter-boundary
    lookarounds keep "media" from matching inside "median".
    """
    words = source.split()
    if not words:
        return None
    head = " ".join(re.escape(word) for word in words[:-1])
    last = words[-1]
    if re.search(r"[^A-Za-z]$", last):
        stem = re.escape(last)
    elif last.endswith("y") and len(last) > 1 and last[-2].lower() not in "aeiou":
        stem = re.escape(last[:-1]) + "(?:y|ies)"
    elif last.endswith("is") and len(last) > 2:
        stem = re.escape(last[:-2]) + "(?:is|es)"
    elif last.endswith(("s", "x", "ch", "sh")):
        stem = re.escape(last) + "(?:es)?"
    else:
        stem = re.escape(last) + "(?:s|es)?"
    body = (head + r"\s+" if head else "") + stem
    return re.compile(r"(?<![A-Za-z])" + body + r"(?![A-Za-z])", re.IGNORECASE)


def similarity(source, back):
    """Word-level similarity between the original and the back-translation."""
    def tokens(text):
        return re.findall(r"[a-z0-9']+", text.lower())

    a, b = tokens(source), tokens(back)
    if not a or not b:
        return 0.0
    return round(difflib.SequenceMatcher(None, " ".join(a), " ".join(b)).ratio(), 3)


def back_check(text, translated, direction, beam):
    """Translate the result back to the source language and score agreement."""
    reverse = "zh_en" if direction == "en_zh" else "en_zh"
    units = split_units(translated) if translated.strip() else []
    if not units:
        return {"back": "", "similarity": 0.0}
    back_units = translate_units(units, reverse, beam)
    back = " ".join(back_units) if reverse == "en_zh" else "".join(back_units)
    return {"back": back, "similarity": similarity(text, back)}


def split_units(text):
    """Paragraphs first; over-long ones fall back to sentence splitting."""
    units = []
    for block in re.split(r"\n\s*\n", text):
        block = block.strip()
        if not block:
            continue
        for line in block.splitlines():
            line = line.strip()
            if not line:
                continue
            if len(line) <= MAX_UNIT_CHARS:
                units.append(line)
                continue
            for piece in re.split(r"(?<=[.!?;:])\s+", line):
                piece = piece.strip()
                while len(piece) > MAX_UNIT_CHARS:
                    cut = piece.rfind(" ", 0, MAX_UNIT_CHARS)
                    cut = cut if cut > 0 else MAX_UNIT_CHARS
                    units.append(piece[:cut].strip())
                    piece = piece[cut:].strip()
                if piece:
                    units.append(piece)
    return units or ([text.strip()] if text.strip() else [])


def normalize_english(text):
    """Tidy spacing the small model leaves around apostrophes and punctuation."""
    text = re.sub(r"\s*'\s*", "'", text)
    text = re.sub(r"\s+([,.;:!?])", r"\1", text)
    text = re.sub(r"\(\s+", "(", text)
    text = re.sub(r"\s+\)", ")", text)
    return re.sub(r"\s{2,}", " ", text).strip()


JUNK_RE = re.compile(r"access-date=|\|help\||\(帮助\)|请检查\s*\|")


def looks_like_garbage(text):
    """opus-mt occasionally regurgitates Wikipedia template syntax."""
    return bool(JUNK_RE.search(text or ""))


def clean_unit_output(text, unit, to):
    """Repair a garbage unit: retry with the chat model, else strip artefacts."""
    if not looks_like_garbage(text):
        return text
    try:
        fixed = llm_translate(unit, to)
        if fixed and not looks_like_garbage(fixed):
            return fixed
    except Exception:
        pass
    return re.sub(r"(access-date=\S*|\(帮助\)|\|help\||请检查)", "", text).strip()


# 模型固定会翻错的几个词：不做占位符，直接事后纠正（只影响英译中）
EN_ZH_FIXES = [
    ("氯化萘", "CN"),
    ("总体重", "权重"),
    ("文学评论", "文献综述"),
    ("文献评论", "文献综述"),
    ("文献审查", "文献综述"),
    ("帆布", "Canvas"),
    ("教官", "讲师"),
    ("考官", "讲师"),
]


def fix_en_zh(text):
    for wrong, right in EN_ZH_FIXES:
        if wrong in text:
            text = text.replace(wrong, right)
    return text


def translate_units(units, direction, beam, with_source=False, batch_size=8):
    """Translate units in batches with the fast engine (no glossary).

    The glossary is only injected into the 7B prompt — masking terms as
    placeholders does not survive CTranslate2 (markers come back shredded),
    so this engine translates raw text.
    """
    translator, sp = engine(direction)
    results = [""] * len(units)
    pending = []

    for index, unit in enumerate(units):
        tokens = sp.encode(unit, out_type=str)
        if not tokens:
            results[index] = ""
            continue
        pending.append((index, tokens, unit))

    for offset in range(0, len(pending), batch_size):
        chunk = pending[offset : offset + batch_size]
        translated = translator.translate_batch(
            [item[1] for item in chunk], beam_size=beam, max_batch_size=batch_size
        )
        for (index, _tokens, unit), result in zip(chunk, translated):
            piece = sp.decode(result.hypotheses[0])
            if "\u2581" in piece:
                piece = piece.replace("\u2581", " ").strip()
            cleaned = piece
            if direction == "zh_en":
                cleaned = normalize_english(cleaned)
            if looks_like_garbage(cleaned):
                cleaned = clean_unit_output(cleaned, unit, "zh" if direction == "en_zh" else "en")
            if direction == "en_zh":
                cleaned = fix_en_zh(cleaned)
            results[index] = cleaned

    if with_source:
        return results, [{"src": unit, "dst": dst} for unit, dst in zip(units, results)]
    return results


def extract_blocks(path):
    """Split a document into paragraph-ish blocks for side-by-side reading."""
    ext = os.path.splitext(path)[1].lower()
    blocks = []
    if ext == ".docx":
        import docx

        document = docx.Document(path)
        for para in document.paragraphs:
            text = para.text.strip()
            if text:
                blocks.append(text)
        for table in document.tables:
            for row in table.rows:
                cells = [c.text.strip() for c in row.cells if c.text.strip()]
                if cells:
                    blocks.append(" | ".join(cells))
    elif ext == ".pdf":
        import pypdf

        raw = "\n".join((pg.extract_text() or "") for pg in pypdf.PdfReader(path).pages)
        chunks = [c.strip() for c in re.split(r"\n\s*\n", raw) if c.strip()]
        if len(chunks) <= 3:
            chunks = [l.strip() for l in raw.splitlines() if l.strip()]
        blocks = chunks
    else:
        blocks = [l.strip() for l in open(path, encoding="utf-8", errors="replace").read().splitlines() if l.strip()]
    return blocks


HEADING_WORDS = (
    "purpose", "task", "assessment", "introduction", "literature review", "methodology",
    "conclusion", "references", "rubric", "criteria", "submission", "objective",
    "part a", "part b", "part c", "part d", "week", "appendix", "overview", "requirements",
)


def looks_like_heading(block):
    text = block.strip()
    if not text or len(text) > 90:
        return False
    lowered = text.lower()
    if any(lowered.startswith(word) for word in HEADING_WORDS):
        return True
    if text.endswith((".", "。", "!", "?", ":", ";", "：")):
        return False
    return len(text) <= 40


def split_sections(blocks):
    """Group blocks into (heading, [paragraphs]) buckets."""
    sections = []
    current = None
    for block in blocks:
        if looks_like_heading(block) or current is None:
            current = {"heading": block if looks_like_heading(block) else "", "body": []}
            if not looks_like_heading(block):
                current["body"].append(block)
            sections.append(current)
        else:
            current["body"].append(block)
    return sections


READING_CACHE = os.path.join(SECRETS_DIR, "reading-cache")
READING_JOBS = {}
READING_JOBS_LOCK = threading.Lock()
READING_CACHE_LOCK = threading.Lock()


def split_for_mt(text, limit=280):
    """Split a long paragraph into sentence chunks the model can handle."""
    parts = re.split(r"(?<=[.!?;:])\s+", text.strip())
    chunks, buf = [], ""
    for part in parts:
        if not part:
            continue
        if len(buf) + len(part) + 1 <= limit:
            buf = (buf + " " + part).strip()
        else:
            if buf:
                chunks.append(buf)
            buf = part
    if buf:
        chunks.append(buf)
    return chunks or [text[:limit]]


def tidy_translation(text):
    """Clean small artifacts from chunked machine translation."""
    text = re.sub(r"\?{2,}", "", text)
    text = re.sub(r"[+＋]\s*[+＋]", "+", text)
    text = re.sub(r"\s*~\s*", " ", text)
    text = re.sub(r"[ \t]{2,}", " ", text)
    return text.strip()


def trim_repetition(text):
    """Cut runaway repeats like 环相机、环相机、环相机…"""
    match = re.search(r"(.{4,12}?)(?:[、，,]?\1){4,}", text)
    if not match:
        return text
    keep = text[: match.start() + len(match.group(1))]
    return keep if len(keep) > 12 else text[: max(12, len(text) // 3)]


def reading_pairs(path, progress=None, engine="llm"):
    """Paragraph-aligned original + Chinese translation (cached by file mtime)."""
    stat = os.stat(path)
    cache_file = os.path.join(READING_CACHE, reading_job_key(path, engine) + ".json")
    with READING_CACHE_LOCK:
        if os.path.exists(cache_file):
            try:
                return json.load(open(cache_file, encoding="utf-8"))
            except Exception:
                pass

    blocks = extract_blocks(path)
    paragraphs = [b for b in blocks if len(b) >= 2]

    def fast_path():
        pieces, owners = [], []
        for index, block in enumerate(paragraphs):
            for piece in split_for_mt(block):
                pieces.append(piece)
                owners.append(index)
        if progress:
            progress(0, len(pieces))
        try:
            with mt_session():
                fast = translate_units(pieces, "en_zh", 2)
        except Exception as err2:
            sys.stderr.write("[interpreter] reading fast failed: %s\n" % err2)
            fast = [""] * len(pieces)
        if progress:
            progress(len(pieces), len(pieces))
        out = [""] * len(paragraphs)
        for index, piece in zip(owners, fast):
            out[index] += tidy_translation(trim_repetition(piece or ""))
        return out

    translated = [""] * len(paragraphs)
    if paragraphs and engine == "llm":
        try:
            with _LOCK_LLM:
                out = llm_translate_pieces(paragraphs, progress=progress)
            for index, text in enumerate(out):
                translated[index] = tidy_translation(trim_repetition(text or ""))
        except Exception as err:
            sys.stderr.write("[interpreter] reading 7B failed, fallback: %s\n" % err)
            translated = fast_path()
    elif paragraphs:
        translated = fast_path()


    payload = {
        "title": os.path.basename(path),
        "source": path,
        "pairs": [{"en": a, "zh": b} for a, b in zip(paragraphs, translated)],
    }
    os.makedirs(READING_CACHE, exist_ok=True)
    tmp = cache_file + ".tmp"
    json.dump(payload, open(tmp, "w", encoding="utf-8"), ensure_ascii=False)
    os.replace(tmp, cache_file)
    return payload


BROWSER_CANDIDATES = [
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    r"C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Microsoft\Edge\Application\msedge.exe",
    r"C:\Program Files\Google\Chrome\Application\chrome.exe",
    os.path.expandvars(r"%LOCALAPPDATA%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%LOCALAPPDATA%\Google\Chrome\Application\chrome.exe"),
    os.path.expandvars(r"%PROGRAMFILES%\Microsoft\Edge\Application\msedge.exe"),
    os.path.expandvars(r"%PROGRAMFILES(X86)%\Microsoft\Edge\Application\msedge.exe"),
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/google-chrome",
]


def find_browser():
    for path in BROWSER_CANDIDATES:
        if os.path.exists(path):
            return path
    return ""


def html_to_pdf(html):
    """Print HTML to PDF with a headless browser (Edge/Chrome ship on macOS & Windows)."""
    import subprocess
    import tempfile

    browser = find_browser()
    if not browser:
        raise RuntimeError("找不到 Edge/Chrome，无法生成 PDF")
    with tempfile.TemporaryDirectory() as tmp:
        src = os.path.join(tmp, "doc.html")
        out = os.path.join(tmp, "doc.pdf")
        with open(src, "w", encoding="utf-8") as handle:
            handle.write(html)
        last_error = b""
        for mode in ("--headless=new", "--headless"):
            if os.path.exists(out):
                break
            result = subprocess.run(
                [browser, mode, "--disable-gpu", "--no-pdf-header-footer",
                 "--print-to-pdf=" + out, pathlib.Path(src).as_uri()],
                capture_output=True, timeout=120,
            )
            last_error = result.stderr or b""
        if not os.path.exists(out):
            raise RuntimeError("打印失败: %s" % last_error[:200])
        with open(out, "rb") as handle:
            return handle.read()


def reading_print_page(payload):
    """A4 friendly layout: original on the left, translation on the right."""
    from html import escape

    rows = []
    for index, pair in enumerate(payload["pairs"], start=1):
        rows.append(
            "<tr><td class='n'>%d</td><td class='en'>%s</td><td class='zh'>%s</td></tr>"
            % (index, escape(pair["en"]), escape(pair["zh"]))
        )
    title = escape(payload["title"])
    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8"><title>%s</title>
<style>
@page { size: A4; margin: 14mm 12mm; }
body{margin:0;color:#111;font:10.5pt/1.55 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
h1{font-size:14pt;margin:0 0 2mm}
.meta{font-size:8.5pt;color:#666;margin-bottom:4mm}
table{width:100%%;border-collapse:collapse}
th{background:#eef2ff;font-size:8.5pt;text-align:left;padding:2mm;border:0.4pt solid #c9d2e3}
td{border:0.4pt solid #d8dee9;padding:2.2mm;vertical-align:top;font-size:10pt}
td.n{width:8mm;color:#888;text-align:right;font-size:8.5pt}
td.en{width:50%%;white-space:pre-wrap}
td.zh{width:42%%;white-space:pre-wrap;background:#fafbfd}
tr{break-inside:auto}
thead{display:table-header-group}
</style></head><body>
<h1>%s</h1>
<div class="meta">英文原文 + 中文翻译 · 共 %d 段 · 本地生成</div>
<table><thead><tr><th>#</th><th>English</th><th>中文</th></tr></thead><tbody>%s</tbody></table>
</body></html>""" % (title, title, len(payload["pairs"]), "".join(rows))


def reading_pdf(path, engine="llm"):
    """Cached bilingual PDF for a source document."""
    cache_file = os.path.join(READING_CACHE, reading_job_key(path) + ".pdf")
    if os.path.exists(cache_file):
        with open(cache_file, "rb") as handle:
            return handle.read()
    payload = reading_pairs(path, engine=engine)
    pdf = html_to_pdf(reading_print_page(payload))
    os.makedirs(READING_CACHE, exist_ok=True)
    tmp = cache_file + ".tmp"
    with open(tmp, "wb") as handle:
        handle.write(pdf)
    os.replace(tmp, cache_file)
    return pdf


def default_engine():
    """7B (MLX) only exists on Apple silicon; other platforms use the fast engine."""
    return "llm" if (sys.platform == "darwin" and PLATFORM == "macos") else "fast"


def reading_job_key(path, engine="llm"):
    stat = os.stat(path)
    return hashlib.sha1(
        ("%s-%d-%d-%s" % (os.path.basename(path), int(stat.st_mtime), stat.st_size, engine)).encode("utf-8")
    ).hexdigest()[:16]


def ensure_reading_pdf(path, engine="llm"):
    """Start (or report) background PDF generation for a document."""
    key = reading_job_key(path, engine)
    pdf_path = os.path.join(READING_CACHE, key + ".pdf")
    if os.path.exists(pdf_path):
        return "ready", READING_JOBS.get(key, {"done": 1, "total": 1})
    with READING_JOBS_LOCK:
        job = READING_JOBS.get(key)
        if job and job.get("status") == "running":
            return "running", job
        READING_JOBS[key] = {"status": "running", "done": 0, "total": 0}
        job = READING_JOBS[key]

    def report(done, total):
        job["done"] = done
        job["total"] = total

    def worker():
        try:
            payload = reading_pairs(path, progress=report, engine=engine)
            pdf = html_to_pdf(reading_print_page(payload))
            os.makedirs(READING_CACHE, exist_ok=True)
            tmp = pdf_path + ".tmp"
            with open(tmp, "wb") as handle:
                handle.write(pdf)
            os.replace(tmp, pdf_path)
            job["status"] = "ready"
        except Exception as err:
            sys.stderr.write("[interpreter] reading job failed: %s\n" % err)
            job["status"] = "error"
            job["error"] = str(err)

    threading.Thread(target=worker, daemon=True).start()
    return "running", job


def reading_progress_page(path, key):
    from html import escape

    title = escape(os.path.basename(path))
    pdf_url = "/reading.pdf?path=" + urllib.parse.quote(path)
    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<title>生成中 · %s</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#f7f8fa;color:#1b1d22;font:15px/1.8 -apple-system,"PingFang SC",sans-serif}
.box{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:26px 30px;max-width:520px;width:90%%}
h1{font-size:16px;margin:0 0 6px}small{color:#6b7280}
.bar{height:8px;background:#e9edf3;border-radius:6px;overflow:hidden;margin:14px 0 8px}
.fill{height:100%%;width:0;background:#2d5bff;transition:width .3s}
.row{display:flex;justify-content:space-between;font-size:12px;color:#6b7280}
@media (prefers-color-scheme:dark){
 body{background:#101215;color:#e9eaec}.box{background:#16181c;border-color:#2a2d33}
 .bar{background:#23262c}
}
</style></head><body><div class="box">
<h1>正在生成中英对照 PDF</h1>
<small>%s · 用本机 7B 模型逐段翻译，首次需要一两分钟，之后会缓存</small>
<div class="bar"><div class="fill" id="fill"></div></div>
<div class="row"><span id="count">准备中…</span><span>完成后自动打开</span></div>
<p style="font-size:12px;color:#6b7280;margin:14px 0 0">等不及？
<a href="%s" style="color:#2d5bff">用快速引擎生成（几秒，质量略低）</a></p>
</div>
<script>
const key = %s;
const pdfUrl = %s;
async function poll() {
  try {
    const r = await fetch('/reading/status?key=' + key, {cache: 'no-store'});
    const d = await r.json();
    if (d.status === 'ready') { location.replace(pdfUrl); return; }
    if (d.status === 'error') { document.getElementById('count').textContent = '生成失败：' + (d.error || '未知错误'); return; }
    const total = d.total || 0, done = d.done || 0;
    document.getElementById('fill').style.width = total ? Math.round(done / total * 100) + '%%' : '8%%';
    document.getElementById('count').textContent = total ? '已翻译 ' + done + ' / ' + total + ' 段' : '正在准备…';
  } catch (e) {}
  setTimeout(poll, 1500);
}
poll();
</script></body></html>""" % (title, title, json.dumps(key), json.dumps(pdf_url),
       pdf_url.replace("reading.pdf", "reading.pdf") + "&engine=fast")


def reading_page(payload):
    """Bilingual page: original paragraph, then its Chinese translation."""
    from html import escape

    rows = []
    for index, pair in enumerate(payload["pairs"], start=1):
        rows.append(
            "<section>"
            "<div class='num'>%d</div>"
            "<p class='en'>%s</p>"
            "<p class='zh'>%s</p>"
            "</section>" % (index, escape(pair["en"]), escape(pair["zh"]))
        )
    title = escape(payload["title"])
    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>%s · 中英对照</title>
<style>
:root{color-scheme:light dark}
body{margin:0;background:#f7f8fa;color:#1b1d22;font:15px/1.7 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e3e6ea;padding:12px 18px;z-index:2}
h1{margin:0 0 3px;font-size:16px}.meta{font-size:12px;color:#6b7280}
main{max-width:900px;margin:0 auto;padding:16px 18px 60px}
section{position:relative;background:#fff;border:1px solid #e3e6ea;border-radius:10px;padding:12px 14px 12px 46px;margin-bottom:10px}
.num{position:absolute;left:10px;top:13px;width:26px;text-align:right;color:#9aa1ab;font-size:12px}
p{margin:0;white-space:pre-wrap}
p.en{color:#111827}
p.zh{margin-top:8px;padding-top:8px;border-top:1px dashed #e5e7eb;color:#1f2937;background:#fcfcfd}
@media (prefers-color-scheme:dark){
 body{background:#101215;color:#e9eaec}header{background:#16181c;border-color:#2a2d33}
 section{background:#16181c;border-color:#2a2d33}
 p.en{color:#e9eaec}p.zh{color:#dfe3e8;border-color:#2a2d33;background:#14171b}
}
</style></head><body>
<header><h1>%s</h1>
<div class="meta">共 %d 段 · 每段下方是本地翻译的中文（不是摘要，逐段对应）</div></header>
<main>%s</main></body></html>""" % (
        title, title, len(payload["pairs"]), "".join(rows),
    )


def compare_page(en_path, zh_path):
    """Full text, section by section, English above Chinese."""
    from html import escape

    en_sections = split_sections(extract_blocks(en_path))
    zh_sections = split_sections(extract_blocks(zh_path))

    rows = []
    total = max(len(en_sections), len(zh_sections))
    note = ""
    if abs(len(en_sections) - len(zh_sections)) > max(3, int(total * 0.4)):
        note = ("<p class='warn'>两份文档的小节结构差异较大（英文 %d 节 / 中文 %d 节），"
                "下面按各自顺序并列展示完整内容。</p>" % (len(en_sections), len(zh_sections)))

    number = 0
    for index in range(total):
        en_sec = en_sections[index] if index < len(en_sections) else {"heading": "", "body": []}
        zh_sec = zh_sections[index] if index < len(zh_sections) else {"heading": "", "body": []}
        number += 1
        rows.append(
            "<tr class='sec'><td class='n'>%d</td><td colspan='2'><b>%s</b>%s</td></tr>"
            % (number,
               escape(en_sec["heading"] or zh_sec["heading"] or "（未命名小节）"),
               "" if not zh_sec["heading"] or zh_sec["heading"] == en_sec["heading"]
               else " <span class='zh-head'>／ %s</span>" % escape(zh_sec["heading"]))
        )
        body_total = max(len(en_sec["body"]), len(zh_sec["body"]))
        for line in range(body_total):
            left = en_sec["body"][line] if line < len(en_sec["body"]) else ""
            right = zh_sec["body"][line] if line < len(zh_sec["body"]) else ""
            rows.append(
                "<tr><td class='n'></td><td class='en'>%s</td><td class='zh'>%s</td></tr>"
                % (escape(left), escape(right))
            )

    title_en = escape(os.path.basename(en_path))
    title_zh = escape(os.path.basename(zh_path))
    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>%s · 对照</title>
<style>
:root{color-scheme:light dark}
body{margin:0;background:#f7f8fa;color:#1b1d22;font:15px/1.75 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
header{position:sticky;top:0;background:#fff;border-bottom:1px solid #e3e6ea;padding:12px 18px;z-index:2}
h1{margin:0 0 4px;font-size:16px}
.meta{font-size:12px;color:#6b7280}
main{max-width:1100px;margin:0 auto;padding:16px}
table{width:100%%;border-collapse:collapse;background:#fff}
th,td{border:1px solid #e3e6ea;padding:9px 12px;vertical-align:top;font-size:14px}
th{background:#f2f4f7;text-align:left;font-size:12px;color:#4b5563}
tr.sec td{background:#eef2ff;font-size:13px}
.zh-head{color:#6b7280;font-weight:400}
td.n{width:34px;color:#9aa1ab;text-align:right;font-size:12px}
td.en{width:50%%;white-space:pre-wrap}
td.zh{width:50%%;white-space:pre-wrap;background:#fcfcfd}
.warn{background:#fff7ed;border:1px solid #fed7aa;color:#9a3412;padding:8px 12px;border-radius:8px;font-size:13px}
@media (prefers-color-scheme:dark){
 body{background:#101215;color:#e9eaec}header{background:#16181c;border-color:#2a2d33}
 table{background:#16181c}th,td{border-color:#2a2d33}th{background:#1d2025;color:#aab1bb}
 tr.sec td{background:#1a2130}
 td.zh{background:#14171b;color:#e9eaec}
 .warn{background:#251a0c;border-color:#6b4415;color:#f4c08a}
}
@media (max-width:720px){td.en,td.zh{display:block;width:auto}td.n{display:none}}
</style></head><body>
<header><h1>%s ／ %s</h1>
<div class="meta">英文 %d 节 · 中文 %d 节 · 每节内逐段并列</div></header>
<main>%s<table><thead><tr><th>#</th><th>English（完整原文）</th><th>中文（完整译文）</th></tr></thead><tbody>%s</tbody></table></main>
</body></html>""" % (
        title_en, title_en, title_zh, len(en_sections), len(zh_sections), note, "".join(rows),
    )


WELCOME_PAGE = r"""<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>学习助手 · 本地服务</title>
<style>
:root{color-scheme:light dark}
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;
 background:#f7f8fa;color:#1b1d22;font:15px/1.8 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
.card{background:#fff;border:1px solid #e3e6ea;border-radius:14px;padding:26px 30px;max-width:520px}
h1{font-size:17px;margin:0 0 6px}
p{margin:6px 0;color:#4b5563;font-size:13px}
code{background:#eef2ff;padding:1px 5px;border-radius:4px;font-size:12px}
@media (prefers-color-scheme:dark){
 body{background:#101215;color:#e9eaec}.card{background:#16181c;border-color:#2a2d33}
 p{color:#aab1bb}code{background:#1a2130}
}
</style></head><body><div class="card">
<h1>学习助手 · 本地服务在运行</h1>
<p>启用位置：DeepSeek Harness → 设置 → 插件 → 学习助手</p>
<p>健康检查：<code>/health</code>　自检：<code>python3 service/smoke.py</code></p>
<p>服务只监听本机，翻译与检测全部离线完成。</p>
</div></body></html>"""


def docx_to_html(path):
    """Render a Word document as a readable HTML page (browser can show it inline)."""
    import docx
    from html import escape

    document = docx.Document(path)
    parts = []
    for para in document.paragraphs:
        text = escape(para.text.strip())
        if not text:
            continue
        style = (para.style.name or "").lower() if para.style is not None else ""
        if "heading 1" in style or "title" in style:
            parts.append("<h2>%s</h2>" % text)
        elif "heading" in style:
            parts.append("<h3>%s</h3>" % text)
        else:
            parts.append("<p>%s</p>" % text)
    for table in document.tables:
        rows = []
        for row in table.rows:
            cells = "".join("<td>%s</td>" % escape(cell.text.strip()) for cell in row.cells)
            rows.append("<tr>%s</tr>" % cells)
        parts.append("<table>%s</table>" % "".join(rows))
    title = escape(os.path.basename(path))
    return """<!DOCTYPE html><html lang="zh-CN"><head><meta charset="utf-8">
    <meta name="viewport" content="width=device-width,initial-scale=1">
    <title>%s</title><style>
    :root{color-scheme:light dark}
    body{margin:0;padding:28px 20px 60px;background:#fbfbfc;color:#1b1d22;
     font:16px/1.85 -apple-system,"PingFang SC","Microsoft YaHei",sans-serif}
    main{max-width:820px;margin:0 auto}
    h1{font-size:15px;font-weight:500;color:#8a8f98;margin:0 0 18px}
    h2{font-size:20px;margin:26px 0 10px}h3{font-size:17px;margin:20px 0 8px}
    p{margin:0 0 12px;white-space:pre-wrap}
    table{border-collapse:collapse;width:100%%;margin:12px 0;font-size:14px}
    td{border:1px solid #e3e6ea;padding:6px 10px;vertical-align:top}
    @media (prefers-color-scheme:dark){
     body{background:#141518;color:#e9eaec}h1{color:#9aa1ab}td{border-color:#2f3238}
    }
    </style></head><body><main><h1>%s</h1>%s</main></body></html>""" % (title, title, "".join(parts))


class BadRequest(Exception):
    """Client-side error: reported as 400, never as a server fault."""


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _origin_allowed(self):
        """只有本机页面可以调用这个服务。

        面板跑在 http://127.0.0.1:<port>，但服务对 127.0.0.1 完全开放且回
        Access-Control-Allow-Origin: *，结果任意网站都能读到 /plan、/timetable、
        /digest（个人课程与截止日期），也能让 /brief 读本地 PDF。这里按 Origin
        收紧：非本机来源直接 403，且不再回 ACAO。
        """
        origin = self.headers.get("Origin") or ""
        if not origin:
            return True          # curl / 本机脚本不带 Origin
        try:
            host = (urllib.parse.urlparse(origin).hostname or "").lower()
        except Exception:
            return False
        return host in ("127.0.0.1", "localhost", "::1")

    def _cors(self):
        origin = self.headers.get("Origin")
        if origin and self._origin_allowed():
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")
        # 把浏览器实际请求的头原样放行：上传文件会带 x-filename，只写 content-type 会导致 Failed to fetch
        requested = self.headers.get("Access-Control-Request-Headers")
        self.send_header("Access-Control-Allow-Headers", requested or "content-type, x-filename")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Max-Age", "86400")
        self.send_header("Cache-Control", "no-store")

    def _json(self, payload, status=200):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._cors()
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        if not self._origin_allowed():
            self.send_response(403)
            self.send_header("Content-Length", "0")
            self.end_headers()
            return
        self.send_response(204)
        self._cors()
        self.send_header("Content-Length", "0")
        self.end_headers()

    def do_GET(self):
        route = self.path.split("?")[0].rstrip("/") or "/"
        if not self._origin_allowed() and route not in ("/health",):
            self._json({"error": "来源不被允许"}, 403)
            return
        if route in ("/", "/index.html"):
            body = WELCOME_PAGE.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        if route == "/reading/status":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            key = (query.get("key") or [""])[0]
            path_q = (query.get("path") or [""])[0]
            if not key and path_q:
                # 面板只知道文件路径，key 由路径+修改时间算出来
                real = os.path.realpath(urllib.parse.unquote(path_q))
                if os.path.exists(real):
                    engine_q = (query.get("engine") or [default_engine()])[0]
                    key = reading_job_key(real, engine_q)
            job = READING_JOBS.get(key) or {}
            self._json({
                "status": job.get("status", "unknown"),
                "done": job.get("done", 0),
                "total": job.get("total", 0),
                "error": job.get("error", ""),
            })
            return
        if route == "/reading/prepare":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            path_q = os.path.realpath(urllib.parse.unquote((query.get("path") or [""])[0]))
            engine_q = (query.get("engine") or [default_engine()])[0]
            if not path_q or not any(path_q.startswith(os.path.realpath(root) + os.sep) for root in FILE_ROOTS):
                self._json({"error": "路径不在允许范围内"}, 403)
                return
            if not os.path.exists(path_q):
                self._json({"error": "文件不存在: %s" % path_q}, 404)
                return
            status, job = ensure_reading_pdf(path_q, engine_q)
            self._json({
                "status": status,
                "done": job.get("done", 0),
                "total": job.get("total", 0),
                "key": reading_job_key(path_q, engine_q),
                "pdf": "/reading.pdf?path=" + urllib.parse.quote(path_q) + "&engine=" + engine_q,
            })
            return
        if route in ("/reading", "/reading.pdf"):
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            path = os.path.realpath(urllib.parse.unquote((query.get("path") or [""])[0]))
            if not path or not any(path.startswith(os.path.realpath(root) + os.sep) for root in FILE_ROOTS):
                self._json({"error": "路径不在允许范围内"}, 403)
                return
            if not os.path.exists(path):
                self._json({"error": "文件不存在: %s" % path}, 404)
                return
            wants_pdf = route.endswith(".pdf") or (query.get("format") or [""])[0] == "pdf"
            engine = (query.get("engine") or [default_engine()])[0]
            try:
                if wants_pdf:
                    body = reading_pdf(path, engine)
                else:
                    status, job = ensure_reading_pdf(path, engine)
                    if status == "ready":
                        target = "/reading.pdf?path=" + urllib.parse.quote(path)
                        self.send_response(302)
                        self.send_header("Location", target)
                        self.send_header("Content-Length", "0")
                        self.end_headers()
                        return
                    body = reading_progress_page(path, reading_job_key(path, engine)).encode("utf-8")
            except Exception as err:
                self._json({"error": "生成对照失败: %s" % err}, 500)
                return
            self.send_response(200)
            self.send_header("Content-Type", "application/pdf" if wants_pdf else "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/compare":
            query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
            en_path = os.path.realpath(urllib.parse.unquote((query.get("en") or [""])[0]))
            zh_path = os.path.realpath(urllib.parse.unquote((query.get("zh") or [""])[0]))
            for path in (en_path, zh_path):
                if not path or not any(path.startswith(os.path.realpath(root) + os.sep) for root in FILE_ROOTS):
                    self._json({"error": "路径不在允许范围内"}, 403)
                    return
                if not os.path.exists(path):
                    self._json({"error": "文件不存在: %s" % path}, 404)
                    return
            body = compare_page(en_path, zh_path).encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return
        if route == "/file":
            self.serve_local_file()
            return
        if route == "/cn/token":
            try:
                payload_in = json.loads(raw.decode("utf-8") or "{}")
                token = payload_in.get("token") or ""
                cn_save_token(token)
                sys.path.insert(0, HERE)
                import cn_api as cn_module
                info = cn_module.me() or {}
                name = info.get("name") or info.get("nickname") or (info.get("data") or {}).get("name") or ""
                self._json({"ok": True, "name": name})
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                # 保存了但验证失败：告诉用户 token 可能过期
                self._json({"ok": False, "error": "token 验证失败：%s" % err}, 400)
            return

        if route == "/cn-status":
            try:
                import cn_api
                info = cn_api.me()
                name = (info or {}).get("name") or (info or {}).get("nickname") or ""
                self._json({"ok": True, "name": name})
            except Exception as err:
                self._json({"ok": False, "error": str(err)})
            return
        if route == "/hidden":
            try:
                self._json(json.load(open(HIDDEN_FILE, encoding="utf-8")))
            except FileNotFoundError:
                self._json({"names": []})
            except Exception as err:
                self._json({"names": [], "error": str(err)}, 500)
            return
        if route == "/filters":
            try:
                self._json(json.load(open(FILTER_FILE, encoding="utf-8")))
            except FileNotFoundError:
                self._json({"filters": {}})
            except Exception as err:
                self._json({"filters": {}, "error": str(err)}, 500)
            return
        if route in ("/timetable", "/schedule"):
            try:
                self._json(json.load(open(TIMETABLE_FILE, encoding="utf-8")))
            except FileNotFoundError:
                # 200 + 空列表：没配课表和路由不存在要区分开，否则面板会当成接口挂了
                self._json({"classes": [], "error": "还没有课表（可在面板里手动添加，或等安装脚本写入）"})
            except Exception as err:
                self._json({"classes": [], "error": str(err)}, 500)
            return
        if route == "/plan":
            self._json(load_plan())
            return
        if route == "/digest":
            if not os.path.exists(DIGEST_FILE):
                self._json({"error": "还没有抓取过，先点刷新", "courses": []})
                return
            try:
                self._json(json.load(open(DIGEST_FILE, encoding="utf-8")))
            except Exception as err:
                self._json({"error": str(err), "courses": []}, 500)
            return
        if self.path.startswith("/health"):
            self._json(
                {
                    "ok": True,
                    "pairs": ["en_zh", "zh_en"],
                    "loaded": sorted(_ENGINES),
                    "glossary": {"en_zh": len(glossary("en_zh")), "zh_en": len(glossary("zh_en"))},
                    "platform": PLATFORM,
                    "capabilities": {
                        "imageOcr": os.path.exists(OCR_BIN),
                        "pdfOcr": os.path.exists(PDF_OCR_BIN),
                        "llm": os.path.isdir(LLM_DIR) or _http_llm_ready(),
                        "mtThreads": mt_threads(),
                        # 能不能用只看依赖装没装；模型目录是首次调用时才创建的，
                        # 拿它判断能力会让“刚装完 -Full 还没说过话”的用户永久锁死
                        "asr": WhisperModel is not None,
                        "asrModelReady": os.path.isdir(os.path.join(MODELS_DIR, "whisper")),
                        "asrModel": ASR_MODEL_NAME,
                        "asrDraftModel": ASR_DRAFT_MODEL,
                    },
                    "asr": {"model": ASR_MODEL_NAME, "draft": ASR_DRAFT_MODEL, "loaded": sorted((_ASR.get("models") or {}).keys())},
                    "llm": {
                        "model": "Qwen2.5-7B-Instruct-4bit",
                        "loaded": _LLM["model"] is not None,
                    },
                    "idleUnload": {
                        "seconds": IDLE,
                        "loaded": {
                            "llm": _LLM["model"] is not None,
                            "asr": bool(_ASR.get("models")),
                            "diar": "pipe" in _DIAR,
                            "mt": sorted(_ENGINES),
                        },
                    },
                }
            )
        else:
            self._json({"error": "not found"}, 404)

    def do_POST(self):
        try:
            self._handle_post()
        except BadRequest as err:
            self._json({"error": str(err)}, 400)
        except Exception as err:
            sys.stderr.write("[interpreter] unhandled POST error: %s\n" % err)
            try:
                self._json({"error": "internal: %s" % err}, 500)
            except Exception:
                pass

    def serve_local_file(self):
        """Serve an allowed local document, loopback clients only.

        面板在本机浏览器里打开，用这个接口才能"点进去看到 PDF 内容"；
        文件系统和浏览器之间有沙箱，file:// 链接是打不开的。
        """
        if self.client_address[0] not in ("127.0.0.1", "::1"):
            self._json({"error": "本地文件只允许本机访问"}, 403)
            return
        query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        raw_path = (query.get("path") or [""])[0]
        if not raw_path:
            self._json({"error": "缺少 path 参数"}, 400)
            return
        path = os.path.realpath(urllib.parse.unquote(raw_path))
        if not any(path.startswith(os.path.realpath(root) + os.sep) for root in FILE_ROOTS):
            self._json({"error": "不在允许的目录内"}, 403)
            return
        ext = os.path.splitext(path)[1].lower()
        if ext not in FILE_EXTS:
            self._json({"error": "不支持的文件类型: %s" % ext}, 400)
            return
        if not os.path.exists(path):
            self._json({"error": "文件不存在: %s" % path}, 404)
            return
        if ext == ".docx":
            try:
                html = docx_to_html(path)
            except Exception as err:
                self._json({"error": "读取 Word 失败: %s" % err}, 500)
                return
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(body)
            return

        ctype = {
            ".pdf": "application/pdf",
            ".png": "image/png",
            ".jpg": "image/jpeg",
            ".jpeg": "image/jpeg",
            ".webp": "image/webp",
            ".txt": "text/plain; charset=utf-8",
            ".md": "text/plain; charset=utf-8",
            ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
            ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        }.get(ext, "application/octet-stream")
        try:
            with open(path, "rb") as handle:
                body = handle.read()
        except Exception as err:
            self._json({"error": str(err)}, 500)
            return
        self.send_response(200)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Content-Disposition", "inline; filename*=UTF-8''%s" % urllib.parse.quote(os.path.basename(path)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def _handle_post(self):
        if not self._origin_allowed():
            self._json({"error": "来源不被允许"}, 403)
            return
        length = int(self.headers.get("Content-Length") or 0)
        raw = self.rfile.read(length) if length else b""
        route = self.path.split("?")[0].rstrip("/") or "/"
        post_path = urllib.parse.urlparse(self.path).path
        if post_path.endswith("/hidden/toggle"):
            try:
                payload_in = json.loads(raw.decode("utf-8") or "{}")
                name = payload_in.get("name")
                if not name:
                    raise BadRequest("缺少课程名")
                try:
                    data = json.load(open(HIDDEN_FILE, encoding="utf-8"))
                except FileNotFoundError:
                    data = {"note": "", "names": []}
                names = data.get("names") or []
                if payload_in.get("hidden", True):
                    if name not in names:
                        names.append(name)
                else:
                    names = [n for n in names if n != name]
                data["names"] = names
                tmp = HIDDEN_FILE + ".tmp"
                with open(tmp, "w", encoding="utf-8") as handle:
                    json.dump(data, handle, ensure_ascii=False, indent=2)
                os.replace(tmp, HIDDEN_FILE)
                self._json({"ok": True, "names": names})
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        known = ("/translate", "/translate/batch", "/asr", "/minutes", "/summary", "/extract",
                 "/brief", "/check", "/cn/token", "/cn/login", "/cn/logout",
                 "/hidden/toggle",
                 "/aidetect", "/digest/refresh", "/release", "/plan/toggle")
        if route not in known:
            self._json({"error": "unknown endpoint: %s" % route}, 404)
            return

        route_path = self.path.split("?")[0].rstrip("/")

        if route_path.endswith("/cn/logout"):
            try:
                removed = []
                for name in ("cn-state.json", "cn-digest.json"):
                    path = os.path.join(SECRETS_DIR, name)
                    if os.path.exists(path):
                        os.remove(path)
                        removed.append(name)
                self._json({"ok": True, "removed": removed})
            except Exception as err:
                self._json({"ok": False, "error": str(err)}, 500)
            return

        if route_path.endswith("/cn/login"):
            started = time.time()
            try:
                name = cn_login_browser()
                self._json({"ok": True, "name": name, "ms": round((time.time() - started) * 1000)})
            except BadRequest as err:
                self._json({"ok": False, "error": str(err)}, 400)
            except Exception as err:
                self._json({"ok": False, "error": str(err)}, 500)
            return

        if route_path.endswith("/cn/token"):
            try:
                payload_in = json.loads(raw.decode("utf-8") or "{}")
                token = (payload_in.get("token") or "").strip()
                name = cn_verify_token(token)      # 先验证，失败就不动已有登录态
                cn_save_token(token)
                self._json({"ok": True, "name": name})
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"ok": False, "error": "token 验证失败：%s" % err}, 400)
            return

        if route_path.endswith("/plan/toggle"):
            try:
                payload_in = json.loads(raw.decode("utf-8") or "{}")
                item_id = payload_in.get("id")
                if not item_id:
                    raise BadRequest("缺少 id")
                plan = load_plan()
                found = False
                for item in plan.get("items", []):
                    if item.get("id") == item_id:
                        item["done"] = bool(payload_in.get("done"))
                        found = True
                        break
                if not found:
                    raise BadRequest("没有这条待办: %s" % item_id)
                plan["updatedAt"] = datetime.datetime.now().isoformat(timespec="seconds")
                save_plan(plan)
                self._json({"ok": True, "items": plan["items"]})
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if route_path.endswith("/brief"):
            started = time.time()
            try:
                payload_in = json.loads(raw.decode("utf-8") or "{}")
                path = payload_in.get("path") or ""
                if not path:
                    raise BadRequest("缺少 path")
                result = run_brief(path)
                result["ms"] = round((time.time() - started) * 1000)
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if route_path.endswith("/check"):
            started = time.time()
            try:
                content_type = (self.headers.get("content-type") or "").lower()
                if "application/json" in content_type:
                    payload_in = json.loads(raw.decode("utf-8") or "{}")
                    path = payload_in.get("path") or ""
                    if not path:
                        raise BadRequest("缺少 path")
                    result = run_check(
                        path,
                        target_words=payload_in.get("targetWords"),
                        pattern=payload_in.get("pattern") or "",
                    )
                else:
                    # 面板直接上传草稿文件（还没保存到课程文件夹时也能自查）
                    query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                    target_raw = (query.get("targetWords") or [""])[0]
                    target = [int(target_raw), None] if target_raw.isdigit() else None
                    filename = header_text(self.headers.get("x-filename")) or "draft.txt"
                    if len(raw) < 20:
                        raise BadRequest("文件只有 %d 字节，太小了" % len(raw))
                    result = run_check_bytes(filename, raw, target_words=target)
                result["ms"] = round((time.time() - started) * 1000)
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if route_path.endswith("/aidetect"):
            started = time.time()
            try:
                filename = header_text(self.headers.get("x-filename"))
                content_type = (self.headers.get("content-type") or "").lower()
                if "application/json" in content_type:
                    payload_in = json.loads(raw.decode("utf-8") or "{}")
                    text = payload_in.get("text") or ""
                    filename = filename or "inline.txt"
                else:
                    text = extract_text(filename, raw)
                text = (text or "").strip()
                if len(text) < MIN_CHECK_CHARS:
                    self._json({"error": "提取到的文字太少（%d 字），至少 %d 字才能判断"
                                % (len(text), MIN_CHECK_CHARS)}, 400)
                    return
                result = ai_rate(text)
                result.update({
                    "filename": filename or "(粘贴文本)",
                    "preview": text[:400],
                    "ms": round((time.time() - started) * 1000),
                })
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if route_path.endswith("/digest/refresh"):
            started = time.time()
            try:
                sys.path.insert(0, HERE)
                import cn_api

                path, rows = cn_api.snapshot()
                self._json({"ok": True, "count": len(rows), "path": path,
                            "ms": round((time.time() - started) * 1000)})
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if self.path.startswith("/release"):
            self._json({"freed": release_all()})
            return

        if self.path.startswith("/summary"):
            started = time.time()
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
                segments = payload.get("segments") or []
                if not isinstance(segments, list):
                    raise BadRequest("segments 必须是数组")
                result = quick_summary(segments)
                result["ms"] = round((time.time() - started) * 1000)
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if self.path.startswith("/extract"):
            started = time.time()
            try:
                if len(raw) < 5:
                    raise BadRequest("文件为空或只有几个字节")
                filename = header_text(self.headers.get("x-filename"))
                ext = os.path.splitext(filename.lower())[1]
                text = extract_text(filename, raw).strip()
                if not text:
                    raise BadRequest("没从文件里读到文字（可能是纯图片或空文档）")
                # 纯文本文件一个字都算有效；PDF/Word 抽出来太少才说明是扫描件或空文档
                if ext in (".pdf", ".docx") and len(text) < 15:
                    raise BadRequest("文件里的文字太少（%d 字），可能是扫描件或空文档" % len(text))
                self._json({
                    "text": text,
                    "chars": len(text),
                    "filename": filename,
                    "ms": round((time.time() - started) * 1000),
                })
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": "解析失败: %s" % err}, 400)
            return

        if self.path.startswith("/minutes"):
            started = time.time()
            try:
                payload = json.loads(raw.decode("utf-8") or "{}")
                result = build_minutes(payload.get("segments") or [])
                result["ms"] = round((time.time() - started) * 1000)
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        if self.path.startswith("/asr"):
            started = time.time()
            try:
                if len(raw) < 100:
                    raise BadRequest("音频为空或太短（%d 字节）" % len(raw))
                query = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
                prompt = urllib.parse.unquote((query.get("prompt") or [""])[0])
                use_vad = (query.get("vad") or ["1"])[0] != "0"
                try:
                    beam = int((query.get("beam") or ["5"])[0])
                except ValueError:
                    beam = 5
                model = (query.get("model") or [""])[0] or None
                context = urllib.parse.unquote((query.get("context") or [""])[0])
                with _LOCK_ASR:
                    result = run_asr(raw, prompt=prompt, use_vad=use_vad, beam=beam,
                                     model=model, context=context)
                result["ms"] = round((time.time() - started) * 1000)
                self._json(result)
            except BadRequest as err:
                self._json({"error": str(err)}, 400)
            except Exception as err:
                self._json({"error": str(err)}, 500)
            return

        raw = raw or b"{}"
        try:
            payload = json.loads(raw.decode("utf-8"))
        except Exception as err:
            self._json({"error": "请求体不是合法 JSON: %s" % err}, 400)
            return
        if not isinstance(payload, dict):
            self._json({"error": "请求体必须是 JSON 对象"}, 400)
            return

        started = time.time()
        # to 白名单：以前 to=zh-cn 会被当成 zh_en（英文反被翻成中文）
        to_raw = payload.get("to")
        if to_raw is None:
            to_raw = "zh"
        if not isinstance(to_raw, str):
            self._json({"error": "to 必须是字符串：\"zh\" 或 \"en\""}, 400)
            return
        to_key = to_raw.strip().lower().replace("_", "-")
        if to_key in ("zh", "zh-cn", "zh-hans", "zh-hant", "cn", "chinese"):
            direction = "en_zh"
        elif to_key in ("en", "en-us", "en-gb", "english"):
            direction = "zh_en"
        else:
            self._json({"error": "不支持的 to=%r，只接受 zh / en" % to_raw}, 400)
            return
        # 规范化后的目标语言，供下游（llm_translate / 响应字段）使用
        to = "zh" if direction == "en_zh" else "en"

        beam_raw = payload.get("beam")
        default_beam = 4 if self.path.startswith("/translate/batch") else 2
        if beam_raw is None or beam_raw == "":
            beam = default_beam
        else:
            try:
                beam = int(beam_raw)
            except (TypeError, ValueError):
                self._json({"error": "beam 必须是整数（1-8）"}, 400)
                return
            # 越界收敛而不是抛错，避免一个参数把整个请求打成 500
            beam = max(1, min(8, beam))
        use_glossary = payload.get("glossary", True) is not False

        try:
            with _LOCK_LLM if (payload.get("engine") or "").lower() == "llm" else mt_session():
                if self.path.startswith("/translate/batch"):
                    lines = payload.get("lines") or []
                    if not isinstance(lines, list):
                        raise BadRequest("lines 必须是数组")
                    translated = translate_units([str(x) for x in lines], direction, beam)
                    self._json(
                        {
                            "lines": translated,
                            "text": "\n".join(translated),
                            "direction": direction,
                            "ms": round((time.time() - started) * 1000),
                        }
                    )
                else:
                    text = payload.get("text") or ""
                    if not isinstance(text, str):
                        raise BadRequest("text 必须是字符串")
                    engine_kind = (payload.get("engine") or "fast").lower()
                    else_llm = engine_kind == "llm"
                    # 两种引擎都按“段”对齐，双语对照才能逐句落位
                    units = split_units(text)
                    pairs_out = []
                    translated = []
                    if units:
                        if else_llm:
                            translated = [llm_translate(unit, to) for unit in units]
                            pairs_out = [{"src": u, "dst": d} for u, d in zip(units, translated)]
                        else:
                            translated, pairs_out = translate_units(
                                units, direction, beam, with_source=True
                            )
                    joined = "\n\n".join(translated) if to == "zh" else " ".join(translated)
                    payload_out = {
                        "text": joined,
                        "lines": translated,
                        "pairs": pairs_out,
                        "direction": direction,
                        "beam": beam,
                        "glossary": use_glossary,
                        "glossaryUsed": bool(use_glossary and else_llm and relevant_terms(text, to)),
                        "engine": "llm" if else_llm else "fast",
                        "model": "Qwen2.5-7B-Instruct-4bit" if else_llm else "opus-mt-en-zh",
                        "ms": round((time.time() - started) * 1000),
                    }
                    if payload.get("verify"):
                        payload_out.update(back_check(text, joined, direction, 2))
                    self._json(payload_out)
        except BadRequest as err:
            self._json({"error": str(err)}, 400)
        except Exception as err:
            self._json({"error": str(err)}, 500)

    def log_message(self, fmt, *args):
        sys.stderr.write("[interpreter] %s\n" % (fmt % args))


def main():
    try:
        engine("en_zh")
        glossary("en_zh")
    except Exception as err:
        sys.stderr.write("[interpreter] warmup failed: %s\n" % err)
    threading.Thread(target=idle_watchdog, daemon=True).start()
    class Server(ThreadingHTTPServer):
        daemon_threads = True
        allow_reuse_address = True
        request_queue_size = 128

        def handle_error(self, request, client_address):
            """Panel health probes abort mid-flight; that is normal, not an error."""
            exc = sys.exc_info()[1]
            if isinstance(exc, (ConnectionResetError, ConnectionAbortedError, BrokenPipeError)):
                return
            sys.stderr.write("[interpreter] request error from %s: %s\n" % (client_address, exc))

    server = Server((HOST, PORT), Handler)
    sys.stderr.write("[interpreter] listening on http://%s:%d\n" % (HOST, PORT))
    if HOST == "0.0.0.0":
        sys.stderr.write("[interpreter] 已监听所有网卡（手机端已移除）\n")
    server.serve_forever()


if __name__ == "__main__":
    main()
