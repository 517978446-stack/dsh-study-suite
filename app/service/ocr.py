"""图片 OCR 桥接：代替 macOS 上编译出来的 audio/ocr.exe

服务端调用约定（见 serve_translate.py 的 extract_text）：
    ocr <图片路径>          → 识别结果从 stdout 输出，退出码 0

Windows 上没有 Swift，这里用 RapidOCR（PaddleOCR 的 ONNX 版，纯本地、离线）。
RapidOCR 对英文会丢掉词间空格（"Theliteraturereview..."），这里用 wordninja 补回来，
否则字数统计和翻译都会被带偏。
"""
import re
import sys

from rapidocr_onnxruntime import RapidOCR

try:
    import wordninja
except Exception:  # 没装就退回原样，不影响中文
    wordninja = None

CJK = re.compile(r"[\u4e00-\u9fff]")
PUNCT_HEAD = "([{'\"“‘"
PUNCT_TAIL = ")]}'\"”’。，、；：！？.,;:!?"


def fix_spacing(line: str) -> str:
    """把挤在一起的英文重新分词；含中文或本身有空格的句子不动。"""
    if wordninja is None or CJK.search(line) or " " in line:
        return line
    head, body, tail = "", line, ""
    while body and body[0] in PUNCT_HEAD:
        head, body = head + body[0], body[1:]
    while body and body[-1] in PUNCT_TAIL:
        tail, body = body[-1] + tail, body[:-1]
    if len(body) < 8 or not body.isascii():
        return line
    return head + " ".join(wordninja.split(body)) + tail


def main() -> int:
    if len(sys.argv) < 2:
        sys.stderr.write("用法: ocr.py <图片路径>\n")
        return 2
    engine = RapidOCR()
    result, _elapse = engine(sys.argv[1])
    if not result:
        return 0
    lines = []
    for item in result:
        # RapidOCR 的每项是 [box, text, score]
        text = (item[1] or "").strip()
        if text:
            lines.append(fix_spacing(text))
    sys.stdout.write("\n".join(lines))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
