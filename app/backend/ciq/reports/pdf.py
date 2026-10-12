"""Participant report PDF (reportlab) from export.report_content(). Returns bytes.

Text is always escaped before it reaches reportlab's paragraph markup, and the AI
summary's Markdown is mapped to a small safe subset (paragraphs, headings, lists,
bold / italic) — raw HTML in it is never interpreted. The built-in PDF fonts only
cover Windows-1252, so other characters are swapped for plain equivalents instead
of rendering as black boxes.
"""
import io
from xml.sax.saxutils import escape

from markdown_it import MarkdownIt
from reportlab.lib import colors
from reportlab.lib.enums import TA_LEFT
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import (
    KeepTogether,
    Paragraph,
    SimpleDocTemplate,
    Spacer,
    Table,
    TableStyle,
)

TITLE = "Wellbeing Check-in Report"
NO_SUMMARY = "A written summary was not generated for this check-in."
# Optional closing note under the summary (e.g. a "not a medical diagnosis" line) —
# left empty until its wording is approved.
DISCLAIMER = ""

_RISK_COLOURS = {"low": "#1f8a5b", "moderate": "#b7791f", "high": "#c53030"}
_REPLACEMENTS = {"↔": "<->", "→": "->", "←": "<-", "≥": ">=", "≤": "<=", "✓": "-", "✔": "-", " ": " "}

_md = MarkdownIt("commonmark", {"html": False})


def pdf_safe(text: str) -> str:
    """Swap characters the built-in fonts (Windows-1252) can't draw."""
    out = []
    for ch in text:
        ch = _REPLACEMENTS.get(ch, ch)
        try:
            ch.encode("cp1252")
        except UnicodeEncodeError:
            ch = ""
        out.append(ch)
    return "".join(out)


def _text(value) -> str:
    return escape(pdf_safe(str(value)))


def _styles() -> dict:
    base = getSampleStyleSheet()
    body = ParagraphStyle("body", parent=base["BodyText"], fontName="Helvetica", fontSize=10.5, leading=15, alignment=TA_LEFT)
    return {
        "title": ParagraphStyle("title", parent=base["Title"], fontName="Helvetica-Bold", fontSize=20, leading=24, spaceAfter=4, alignment=TA_LEFT),
        "meta": ParagraphStyle("meta", parent=body, fontSize=10, textColor=colors.HexColor("#555555")),
        "h2": ParagraphStyle("h2", parent=body, fontName="Helvetica-Bold", fontSize=13.5, leading=18, spaceBefore=14, spaceAfter=6),
        "h3": ParagraphStyle("h3", parent=body, fontName="Helvetica-Bold", fontSize=11.5, leading=16, spaceBefore=8, spaceAfter=3),
        "body": body,
        "bullet": ParagraphStyle("bullet", parent=body, leftIndent=12, bulletIndent=2),
        "small": ParagraphStyle("small", parent=body, fontSize=8.5, leading=12, textColor=colors.HexColor("#666666")),
    }


def _inline(token) -> str:
    """One markdown-it inline token → reportlab paragraph markup (escaped)."""
    parts = []
    for child in token.children or []:
        t = child.type
        if t == "text":
            parts.append(_text(child.content))
        elif t == "code_inline":
            parts.append(f'<font face="Courier">{_text(child.content)}</font>')
        elif t in ("softbreak", "hardbreak"):
            parts.append("<br/>")
        elif t == "strong_open":
            parts.append("<b>")
        elif t == "strong_close":
            parts.append("</b>")
        elif t == "em_open":
            parts.append("<i>")
        elif t == "em_close":
            parts.append("</i>")
        # links / images: their text children carry the content; markup is dropped.
    return "".join(parts)


def markdown_flowables(source: str, st: dict) -> list:
    flow, lists = [], []  # lists: stack of [kind, counter]
    heading_style = None
    for tok in _md.parse(source):
        if tok.type in ("bullet_list_open", "ordered_list_open"):
            lists.append(["ol" if tok.type == "ordered_list_open" else "ul", 0])
        elif tok.type in ("bullet_list_close", "ordered_list_close"):
            lists.pop()
        elif tok.type == "list_item_open" and lists:
            lists[-1][1] += 1
        elif tok.type == "heading_open":
            heading_style = st["h3"]
        elif tok.type == "heading_close":
            heading_style = None
        elif tok.type in ("fence", "code_block"):
            flow.append(Paragraph(_text(tok.content).replace("\n", "<br/>"), st["body"]))
        elif tok.type == "inline":
            markup = _inline(tok)
            if not markup.strip():
                continue
            if heading_style is not None:
                flow.append(Paragraph(markup, heading_style))
            elif lists:
                kind, n = lists[-1]
                bullet = f"{n}." if kind == "ol" else "•"
                flow.append(Paragraph(markup, st["bullet"], bulletText=bullet))
            else:
                flow.append(Paragraph(markup, st["body"]))
                flow.append(Spacer(1, 4))
    return flow


def _risk_chip(level: str | None) -> str:
    if not level:
        return "—"
    colour = _RISK_COLOURS.get(level.lower(), "#333333")
    return f'<font color="{colour}"><b>{_text(level)}</b></font>'


def _num(value):
    """3.0 → 3 (as the app shows it); other values unchanged."""
    return int(value) if isinstance(value, float) and value.is_integer() else value


def _score_text(score, maximum) -> str:
    if score is None:
        return "—"
    return f"<b>{_text(_num(score))}</b>" + (f" / {_text(_num(maximum))}" if maximum is not None else "")


def _result_block(r: dict, st: dict):
    head = Table(
        [[Paragraph(f"<b>{_text(r['label'])}</b>", st["body"]),
          Paragraph(_score_text(r["score"], r["max"]), st["body"]),
          Paragraph(_risk_chip(r["riskLevel"]), st["body"])]],
        colWidths=[70 * mm, 45 * mm, 50 * mm],
    )
    head.setStyle(TableStyle([
        ("BACKGROUND", (0, 0), (-1, -1), colors.HexColor("#f3f4f6")),
        ("VALIGN", (0, 0), (-1, -1), "MIDDLE"),
        ("LEFTPADDING", (0, 0), (-1, -1), 6),
        ("TOPPADDING", (0, 0), (-1, -1), 5),
        ("BOTTOMPADDING", (0, 0), (-1, -1), 5),
    ]))
    parts = [head, Spacer(1, 4)]
    if r.get("interpretation"):
        parts.append(Paragraph(_text(r["interpretation"]), st["body"]))
    parts.append(Spacer(1, 10))
    return KeepTogether(parts)


def render_report_pdf(content: dict) -> bytes:
    st = _styles()
    buf = io.BytesIO()
    doc = SimpleDocTemplate(
        buf, pagesize=A4, leftMargin=20 * mm, rightMargin=20 * mm, topMargin=18 * mm, bottomMargin=18 * mm,
        title=pdf_safe(f"{TITLE} - {content['name']}"), author="CIQ",
    )
    flow = [
        Paragraph(_text(TITLE), st["title"]),
        Paragraph(f"<b>{_text(content['name'])}</b>", st["body"]),
        Paragraph(f"Completed: {_text(content['completed'])} \u00b7 {_text(content['surveyType'])}", st["meta"]),
        Spacer(1, 6),
        Paragraph("Your results", st["h2"]),
    ]
    if content["results"]:
        flow.extend(_result_block(r, st) for r in content["results"])
    else:
        flow.append(Paragraph("No scores were saved for this check-in.", st["body"]))

    flow.append(Paragraph("Your summary", st["h2"]))
    if content["summary"]:
        flow.extend(markdown_flowables(content["summary"], st))
    kb = content.get("kbReport")
    if kb:
        flow.append(Paragraph("Research-based summary", st["h3"]))
        flow.extend(markdown_flowables(kb["answer"], st))
        if kb["citations"]:
            flow.append(Paragraph("References", st["h3"]))
            for c in kb["citations"]:
                page = f", p. {_text(c['paperPage'])}" if c.get("paperPage") not in (None, "") else ""
                flow.append(Paragraph(f"{_text(c.get('paperTitle') or c.get('paperId') or 'Source')}{page}", st["bullet"], bulletText="•"))
    if not content["summary"] and not kb:
        flow.append(Paragraph(_text(NO_SUMMARY), st["body"]))
    if DISCLAIMER:
        flow.extend([Spacer(1, 12), Paragraph(_text(DISCLAIMER), st["small"])])

    def footer(canvas, _doc):
        canvas.saveState()
        canvas.setFont("Helvetica", 8)
        canvas.setFillColor(colors.HexColor("#888888"))
        canvas.drawString(20 * mm, 10 * mm, pdf_safe(f"{TITLE} - {content['name']}"))
        canvas.drawRightString(A4[0] - 20 * mm, 10 * mm, f"Page {canvas.getPageNumber()}")
        canvas.restoreState()

    doc.build(flow, onFirstPage=footer, onLaterPages=footer)
    return buf.getvalue()
