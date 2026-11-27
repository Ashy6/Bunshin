from __future__ import annotations

import re
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.enums import TA_CENTER, TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import (
    BaseDocTemplate,
    Flowable,
    Frame,
    KeepTogether,
    PageBreak,
    PageTemplate,
    Paragraph,
    Preformatted,
    Spacer,
    Table,
    TableStyle,
)

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "docs" / "ai-runtime-architecture.md"
OUTPUT = ROOT / "output" / "pdf" / "ai-runtime-architecture.pdf"
FONT = "/System/Library/Fonts/Supplemental/Arial Unicode.ttf"

INK = colors.HexColor("#17212B")
MUTED = colors.HexColor("#5E6C7A")
BLUE = colors.HexColor("#245B78")
LIGHT_BLUE = colors.HexColor("#EAF3F8")
PALE = colors.HexColor("#F5F7F9")
LINE = colors.HexColor("#D8E0E6")
GREEN = colors.HexColor("#2D7A57")

pdfmetrics.registerFont(TTFont("CJK", FONT))


class ArchitectureDiagram(Flowable):
    def __init__(self, width: float):
        super().__init__()
        self.width = width
        self.height = 91 * mm

    def _box(self, canvas, x, y, w, h, title, subtitle="", fill=colors.white):
        canvas.setStrokeColor(LINE)
        canvas.setFillColor(fill)
        canvas.roundRect(x, y, w, h, 5, stroke=1, fill=1)
        canvas.setFillColor(INK)
        canvas.setFont("CJK", 9)
        canvas.drawCentredString(x + w / 2, y + h - 13, title)
        if subtitle:
            canvas.setFillColor(MUTED)
            canvas.setFont("CJK", 7)
            canvas.drawCentredString(x + w / 2, y + 8, subtitle)

    def _arrow(self, canvas, x1, y1, x2, y2, label=""):
        canvas.setStrokeColor(BLUE)
        canvas.setFillColor(BLUE)
        canvas.setLineWidth(1.2)
        canvas.line(x1, y1, x2, y2)
        angle = 5
        canvas.line(x2, y2, x2 - angle, y2 + 2.5)
        canvas.line(x2, y2, x2 - angle, y2 - 2.5)
        if label:
            canvas.setFont("CJK", 6.5)
            canvas.setFillColor(MUTED)
            canvas.drawCentredString((x1 + x2) / 2, y1 + 5, label)

    def draw(self):
        c = self.canv
        w = self.width
        c.setFillColor(PALE)
        c.roundRect(0, 0, w, self.height, 8, stroke=0, fill=1)
        box_w, box_h = 31 * mm, 15 * mm
        y_top = self.height - 28 * mm
        self._box(c, 8 * mm, y_top, box_w, box_h, "访客浏览器", "只访问 twin-ai.online")
        self._box(c, 50 * mm, y_top, box_w, box_h, "Web Worker", "Turnstile / 限流 / RAG", LIGHT_BLUE)
        self._box(c, 94 * mm, y_top, box_w, box_h, "AI Runtime", "固定区域 / HMAC", colors.HexColor("#E8F4EE"))
        self._box(c, 138 * mm, y_top, box_w, box_h, "模型厂商", "OpenAI / 兼容渠道")
        self._arrow(c, 39 * mm, y_top + box_h / 2, 50 * mm, y_top + box_h / 2, "POST /api/chat")
        self._arrow(c, 81 * mm, y_top + box_h / 2, 94 * mm, y_top + box_h / 2, "签名请求")
        self._arrow(c, 125 * mm, y_top + box_h / 2, 138 * mm, y_top + box_h / 2, "服务端 Key")

        y_bottom = 18 * mm
        self._box(c, 25 * mm, y_bottom, box_w, box_h, "Admin Worker", "上传 / Queue / 渠道测试", LIGHT_BLUE)
        self._box(c, 72 * mm, y_bottom, 25 * mm, box_h, "D1 / R2", "业务数据")
        self._box(c, 108 * mm, y_bottom, 25 * mm, box_h, "Vectorize", "向量索引")
        self._arrow(c, 56 * mm, y_bottom + box_h / 2, 72 * mm, y_bottom + box_h / 2)
        self._arrow(c, 97 * mm, y_bottom + box_h / 2, 108 * mm, y_bottom + box_h / 2)
        c.setStrokeColor(BLUE)
        c.line(41 * mm, y_bottom + box_h, 41 * mm, y_top - 5 * mm)
        c.line(41 * mm, y_top - 5 * mm, 109 * mm, y_top - 5 * mm)
        c.line(109 * mm, y_top - 5 * mm, 109 * mm, y_top)
        c.setFont("CJK", 6.5)
        c.setFillColor(MUTED)
        c.drawString(47 * mm, y_top - 3 * mm, "测试模型与文档 Embedding")


def esc(text: str) -> str:
    return (
        text.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
    )


def inline(text: str) -> str:
    text = esc(text)
    text = re.sub(r"`([^`]+)`", r'<font name="CJK" color="#245B78">\1</font>', text)
    text = re.sub(r"\*\*([^*]+)\*\*", r"<b>\1</b>", text)
    text = re.sub(r"\[([^]]+)\]\(([^)]+)\)", r'<link href="\2" color="#245B78">\1</link>', text)
    return text


def make_styles():
    styles = getSampleStyleSheet()
    common = dict(fontName="CJK", splitLongWords=True)
    return {
        "title": ParagraphStyle("TitleCJK", **common, fontSize=28, leading=38, textColor=INK, alignment=TA_LEFT, spaceAfter=8 * mm),
        "subtitle": ParagraphStyle("SubtitleCJK", **common, fontSize=12, leading=20, textColor=MUTED),
        "h1": ParagraphStyle("H1CJK", **common, fontSize=20, leading=28, textColor=BLUE, spaceBefore=6 * mm, spaceAfter=4 * mm, keepWithNext=True),
        "h2": ParagraphStyle("H2CJK", **common, fontSize=14, leading=21, textColor=INK, spaceBefore=4 * mm, spaceAfter=2.5 * mm, keepWithNext=True),
        "h3": ParagraphStyle("H3CJK", **common, fontSize=11, leading=17, textColor=BLUE, spaceBefore=3 * mm, spaceAfter=2 * mm, keepWithNext=True),
        "body": ParagraphStyle("BodyCJK", **common, fontSize=9.2, leading=15.5, textColor=INK, spaceAfter=2.2 * mm, alignment=TA_LEFT),
        "bullet": ParagraphStyle("BulletCJK", **common, fontSize=9, leading=14.5, textColor=INK, leftIndent=5 * mm, firstLineIndent=-3 * mm, spaceAfter=1.2 * mm),
        "quote": ParagraphStyle("QuoteCJK", **common, fontSize=8.8, leading=14.5, textColor=MUTED, backColor=LIGHT_BLUE, borderColor=BLUE, borderWidth=0, borderPadding=6, leftIndent=2 * mm, rightIndent=2 * mm, spaceAfter=3 * mm),
        "code": ParagraphStyle("CodeCJK", fontName="CJK", fontSize=7.4, leading=11, textColor=INK, backColor=PALE, borderColor=LINE, borderWidth=0.5, borderPadding=7, leftIndent=0, rightIndent=0, spaceAfter=3 * mm),
        "small": ParagraphStyle("SmallCJK", **common, fontSize=7.5, leading=11, textColor=MUTED),
    }


def page_decor(canvas, doc):
    canvas.saveState()
    width, height = A4
    canvas.setStrokeColor(LINE)
    canvas.line(18 * mm, height - 14 * mm, width - 18 * mm, height - 14 * mm)
    canvas.setFont("CJK", 7)
    canvas.setFillColor(MUTED)
    canvas.drawString(18 * mm, height - 10 * mm, "BUNSHIN · AI RUNTIME ARCHITECTURE")
    canvas.drawRightString(width - 18 * mm, 10 * mm, f"{doc.page}")
    canvas.restoreState()


def markdown_flowables(markdown: str, styles, content_width: float):
    lines = markdown.splitlines()[1:]
    story = []
    paragraph = []
    in_code = False
    code_lang = ""
    code_lines = []

    def flush_paragraph():
        if paragraph:
            story.append(Paragraph(inline(" ".join(part.strip() for part in paragraph)), styles["body"]))
            paragraph.clear()

    index = 0
    while index < len(lines):
        line = lines[index]
        if line.startswith("```"):
            if not in_code:
                flush_paragraph()
                in_code = True
                code_lang = line[3:].strip()
                code_lines = []
            else:
                if code_lang == "mermaid":
                    story.append(ArchitectureDiagram(content_width))
                    story.append(Spacer(1, 3 * mm))
                else:
                    story.append(Preformatted("\n".join(code_lines), styles["code"], maxLineLength=95))
                in_code = False
            index += 1
            continue
        if in_code:
            code_lines.append(line)
            index += 1
            continue
        if not line.strip():
            flush_paragraph()
            index += 1
            continue
        if line.startswith("## "):
            flush_paragraph()
            story.append(Paragraph(inline(line[3:]), styles["h1"]))
        elif line.startswith("### "):
            flush_paragraph()
            story.append(Paragraph(inline(line[4:]), styles["h2"]))
        elif line.startswith("#### "):
            flush_paragraph()
            story.append(Paragraph(inline(line[5:]), styles["h3"]))
        elif line.startswith("> "):
            flush_paragraph()
            story.append(Paragraph(inline(line[2:].replace("  ", " · ")), styles["quote"]))
        elif re.match(r"^- ", line):
            flush_paragraph()
            story.append(Paragraph("• " + inline(line[2:]), styles["bullet"]))
        elif re.match(r"^\d+\. ", line):
            flush_paragraph()
            number, text = line.split(". ", 1)
            story.append(Paragraph(f"{number}. " + inline(text), styles["bullet"]))
        elif line.startswith("|") and index + 1 < len(lines) and re.match(r"^\|?\s*:?-+", lines[index + 1]):
            flush_paragraph()
            rows = []
            while index < len(lines) and lines[index].startswith("|"):
                cells = [cell.strip() for cell in lines[index].strip("|").split("|")]
                if not all(re.fullmatch(r":?-+:?", cell.replace(" ", "")) for cell in cells):
                    rows.append([Paragraph(inline(cell), styles["small"]) for cell in cells])
                index += 1
            columns = len(rows[0]) if rows else 1
            widths = [content_width / columns] * columns
            table = Table(rows, colWidths=widths, repeatRows=1, hAlign="LEFT")
            table.setStyle(TableStyle([
                ("BACKGROUND", (0, 0), (-1, 0), BLUE),
                ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("VALIGN", (0, 0), (-1, -1), "TOP"),
                ("LEFTPADDING", (0, 0), (-1, -1), 5),
                ("RIGHTPADDING", (0, 0), (-1, -1), 5),
                ("TOPPADDING", (0, 0), (-1, -1), 5),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
                ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, PALE]),
            ]))
            story.append(table)
            story.append(Spacer(1, 3 * mm))
            continue
        else:
            paragraph.append(line)
        index += 1
    flush_paragraph()
    return story


def build():
    OUTPUT.parent.mkdir(parents=True, exist_ok=True)
    styles = make_styles()
    width, height = A4
    left = right = 18 * mm
    top = 20 * mm
    bottom = 16 * mm
    content_width = width - left - right
    doc = BaseDocTemplate(
        str(OUTPUT),
        pagesize=A4,
        leftMargin=left,
        rightMargin=right,
        topMargin=top,
        bottomMargin=bottom,
        title="Bunshin 固定区域 AI Runtime 技术方案",
        author="ai-bunshin",
        subject="模型执行后端拆分、鉴权、迁移与部署",
    )
    frame = Frame(left, bottom, content_width, height - top - bottom - 2 * mm, id="main")
    doc.addPageTemplates(PageTemplate(id="architecture", frames=[frame], onPage=page_decor))

    story = [
        Spacer(1, 22 * mm),
        Paragraph("BUNSHIN TECHNICAL DESIGN", styles["subtitle"]),
        Spacer(1, 4 * mm),
        Paragraph("固定区域 AI Runtime<br/>拆分与迁移方案", styles["title"]),
        Paragraph("在不迁移 D1、R2、Vectorize 和公开 API 的前提下，将 Chat、Embedding 与渠道测试抽离到固定区域模型执行层。", styles["subtitle"]),
        Spacer(1, 12 * mm),
        ArchitectureDiagram(content_width),
        Spacer(1, 10 * mm),
        Table(
            [
                [Paragraph("版本", styles["small"]), Paragraph("0.1.x", styles["small"]), Paragraph("日期", styles["small"]), Paragraph("2026-11-27", styles["small"])],
                [Paragraph("状态", styles["small"]), Paragraph("代码完成 · 待绑定固定区域平台", styles["small"]), Paragraph("范围", styles["small"]), Paragraph("Web / Admin / Runtime", styles["small"])],
            ],
            colWidths=[22 * mm, 54 * mm, 22 * mm, 58 * mm],
            style=TableStyle([
                ("GRID", (0, 0), (-1, -1), 0.4, LINE),
                ("BACKGROUND", (0, 0), (0, -1), LIGHT_BLUE),
                ("BACKGROUND", (2, 0), (2, -1), LIGHT_BLUE),
                ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
                ("LEFTPADDING", (0, 0), (-1, -1), 6),
                ("TOPPADDING", (0, 0), (-1, -1), 6),
                ("BOTTOMPADDING", (0, 0), (-1, -1), 6),
            ]),
        ),
        PageBreak(),
        Paragraph("内容导航", styles["h1"]),
    ]
    sections = re.findall(r"^## (.+)$", SOURCE.read_text(encoding="utf-8"), flags=re.MULTILINE)
    for number, section in enumerate(sections, 1):
        section = re.sub(r"^\d+\.\s*", "", section)
        story.append(Paragraph(f"{number:02d}　{inline(section)}", styles["body"]))
    story.append(PageBreak())
    story.extend(markdown_flowables(SOURCE.read_text(encoding="utf-8"), styles, content_width))
    doc.build(story)
    print(OUTPUT)


if __name__ == "__main__":
    build()
