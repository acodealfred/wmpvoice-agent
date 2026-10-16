import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { ReportQrDialog } from "./report-qr-dialog";

describe("ReportQrDialog", () => {
    it("starts by asking for the username, with no QR code yet", () => {
        const html = renderToStaticMarkup(<ReportQrDialog surveyRunId="run-1" onClose={() => {}} />);
        expect(html).toContain("Download your report");
        expect(html).toContain('placeholder="Username"');
        expect(html).not.toContain('type="password"');
        expect(html).toContain("Continue");
        expect(html).not.toContain("<svg");
        expect(html).toContain('role="dialog"');
    });
});
