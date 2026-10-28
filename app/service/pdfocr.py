"""扫描版 PDF 的 OCR 桥接：代替 macOS 上编译出来的 audio/pdfocr.exe

服务端调用约定（见 serve_translate.py）：
    pdfocr <pdf 路径> <dpi?>     → 逐页识别结果从 stdout 输出，退出码 0

做法：PyMuPDF 把每页渲染成图片，再交给 RapidOCR。纯本地、离线。
"""
import re
import sys

import fitz  # PyMuPDF
from rapidocr_onnxruntime import RapidOCR

try:
    import wordninja
except Exception:
    wordninja = None

CJK = re.compile(r"[\u4e00-\u9fff]")
PUNCT_HEAD = "([{'\"“‘"
PUNCT_TAIL = ")]}'\"”’。，、；：！？.,;:!?"


def fix_spacing(line: str) -> str:
    """与 ocr.py 相同的英文分词补偿。"""
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
        sys.stderr.write("用法: pdfocr.py <pdf 路径> [dpi]\n")
        return 2
    path = sys.argv[1]
    dpi = 200
    if len(sys.argv) > 2:
        try:
            dpi = max(72, min(400, int(sys.argv[2]) * 40))
        except ValueError:
            pass

    engine = RapidOCR()
    pages = []
    with fitz.open(path) as doc:
        for index, page in enumerate(doc):
            if index >= 60:  # 与 macOS 版一致：最多 60 页
                break
            pix = page.get_pixmap(dpi=dpi)
            png = pix.tobytes("png")
            result, _elapse = engine(png)
            lines = []
            for item in result or []:
                text = (item[1] or "").strip()
                if text:
                    lines.append(fix_spacing(text))
            if lines:
                pages.append("\n".join(lines))

    sys.stdout.write("\n\n".join(pages))
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
