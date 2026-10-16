import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import EegDropDialog, { type EegDropVariant } from "./eeg-drop-dialog";

const render = (variant: EegDropVariant | null) => renderToStaticMarkup(<EegDropDialog variant={variant} onDismiss={() => {}} onConnect={() => {}} />);

describe("EegDropDialog", () => {
    it("renders nothing when closed", () => {
        expect(render(null)).toBe("");
    });

    it("baseline: says the baseline must be redone, offers only OK", () => {
        const html = render("baseline");
        expect(html).toContain("EEG headband disconnected");
        expect(html).toContain("The baseline has to be recorded again");
        expect(html).toContain(">OK<");
        expect(html).not.toContain("Connect headband");
        expect(html).toContain('role="alertdialog"');
    });

    it("survey: says the assessment is paused, offers Connect headband and Close", () => {
        const html = render("survey");
        expect(html).toContain("assessment paused");
        expect(html).toContain("Connect headband");
        expect(html).toContain(">Close<");
    });
});
