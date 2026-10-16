import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";

// Renders `children` (a read-only copy of the report) off-screen, at A4 width and in
// light colours (data-pdf-capture / data-pdf-light, index.css), waits for the charts
// to finish drawing, captures it to a PDF and stores it for the QR download — once,
// in the background. Any failure is only logged: that run's QR download then falls
// back to the server-rendered PDF.

// Recharts animates the charts in (~1.5s); capture after they settle.
const CHART_SETTLE_MS = 2500;

interface ReportPdfCaptureProps {
    surveyRunId: string;
    children: ReactNode;
}

export function ReportPdfCapture({ surveyRunId, children }: ReportPdfCaptureProps) {
    const ref = useRef<HTMLDivElement>(null);
    const [done, setDone] = useState(false);

    useEffect(() => {
        let cancelled = false;
        (async () => {
            try {
                // Loaded only when a capture runs — jsPDF + html-to-image are large.
                const [{ captureReportPdf, uploadReportPdf }] = await Promise.all([
                    import("@/lib/report-pdf"),
                    new Promise(r => setTimeout(r, CHART_SETTLE_MS))
                ]);
                const report = ref.current?.firstElementChild;
                if (cancelled || !(report instanceof HTMLElement)) return;
                const pdf = await captureReportPdf(report);
                if (cancelled) return;
                await uploadReportPdf(surveyRunId, pdf);
            } catch (err) {
                console.warn("[ReportPdf] capture/upload failed — the QR download will use the server PDF", err);
            } finally {
                if (!cancelled) setDone(true);
            }
        })();
        return () => {
            cancelled = true;
        };
    }, [surveyRunId]);

    if (done) return null;
    return createPortal(
        <div ref={ref} data-pdf-capture="" data-pdf-light="" aria-hidden="true">
            {children}
        </div>,
        document.body
    );
}
