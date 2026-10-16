// The report as shown on screen, captured to an A4 PDF in the browser and stored
// on the server once (POST /me/reports/{runId}/pdf — ciq/reports/pdf_store_routes.py)
// for the QR download. The capture is a picture of the report (html-to-image), cut
// into A4 pages between cards rather than through them (pageBreaks), then wrapped
// in a PDF (jsPDF). See components/ui/report-pdf-capture.tsx for when it runs.

import { toCanvas } from "html-to-image";
import { jsPDF } from "jspdf";

import { apiFetch } from "@/lib/api";

/** A vertical span (CSS px from the top of the report) that should stay on one page. */
export type KeepRange = { top: number; bottom: number };

const A4_W_MM = 210;
const A4_H_MM = 297;
// Browsers cap canvas size (iOS Safari is the tightest); keep the full capture under it.
const MAX_CANVAS_PX = 16000;
const JPEG_QUALITY = 0.85;

/**
 * Where each page starts, in CSS px. A page ends early, at the top of a card, when
 * that card would otherwise be cut — unless the card is taller than a page, which
 * has to be cut anyway. Nested cards are handled by repeating until nothing moves.
 */
export function pageBreaks(totalHeight: number, pageHeight: number, keep: KeepRange[]): number[] {
    const starts = [0];
    if (pageHeight <= 0) return starts;
    const fitting = keep.filter(r => r.bottom - r.top <= pageHeight);
    let start = 0;
    while (start + pageHeight < totalHeight) {
        let end = start + pageHeight;
        let moved = true;
        while (moved) {
            moved = false;
            for (const r of fitting) {
                if (r.top > start && r.top < end && r.bottom > end) {
                    end = r.top;
                    moved = true;
                }
            }
        }
        starts.push(end);
        start = end;
    }
    return starts;
}

function keepRanges(el: HTMLElement): KeepRange[] {
    const top = el.getBoundingClientRect().top;
    return Array.from(el.querySelectorAll<HTMLElement>(".ciq-print-keep, tr"))
        .map(n => n.getBoundingClientRect())
        .filter(r => r.height > 0)
        .map(r => ({ top: r.top - top, bottom: r.bottom - top }));
}

async function snapshot(el: HTMLElement, pixelRatio: number, backgroundColor: string): Promise<HTMLCanvasElement> {
    try {
        return await toCanvas(el, { pixelRatio, backgroundColor });
    } catch {
        // Embedding the web fonts can fail (e.g. the font host blocked); system fonts are fine.
        return await toCanvas(el, { pixelRatio, backgroundColor, skipFonts: true });
    }
}

/** Capture `el` (already laid out at its PDF width) as a multi-page A4 PDF. */
export async function captureReportPdf(el: HTMLElement): Promise<Blob> {
    await document.fonts?.ready;
    const width = el.offsetWidth;
    const total = el.scrollHeight;
    const background = getComputedStyle(el).backgroundColor || "#ffffff";
    const scale = Math.min(2, MAX_CANVAS_PX / Math.max(total, 1));

    const keep = keepRanges(el);
    const canvas = await snapshot(el, scale, background);

    const pageHeight = Math.floor((width * A4_H_MM) / A4_W_MM);
    const starts = pageBreaks(total, pageHeight, keep);
    const mmPerPx = A4_W_MM / width;

    const pdf = new jsPDF({ unit: "mm", format: "a4", orientation: "portrait", compress: true });
    starts.forEach((start, i) => {
        const end = i + 1 < starts.length ? starts[i + 1] : total;
        const slice = document.createElement("canvas");
        slice.width = canvas.width;
        slice.height = Math.max(1, Math.round((end - start) * scale));
        const ctx = slice.getContext("2d");
        if (!ctx) throw new Error("Canvas is not available");
        ctx.fillStyle = background;
        ctx.fillRect(0, 0, slice.width, slice.height);
        ctx.drawImage(canvas, 0, Math.round(start * scale), canvas.width, slice.height, 0, 0, slice.width, slice.height);

        if (i > 0) pdf.addPage();
        pdf.addImage(slice.toDataURL("image/jpeg", JPEG_QUALITY), "JPEG", 0, 0, A4_W_MM, (end - start) * mmPerPx);
    });
    return pdf.output("blob");
}

/** Store the PDF for the run. The server keeps the first upload and ignores later ones. */
export async function uploadReportPdf(surveyRunId: string, pdf: Blob): Promise<void> {
    const resp = await apiFetch(`/me/reports/${encodeURIComponent(surveyRunId)}/pdf`, {
        method: "POST",
        headers: { "Content-Type": "application/pdf" },
        body: pdf
    });
    if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
}
