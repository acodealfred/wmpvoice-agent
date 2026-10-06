import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import type { MuseStatus } from "@/hooks/useMuse";
import EegPairModal, { type EegPairVariant } from "./eeg-pair-modal";

const render = (variant: EegPairVariant | null, status: MuseStatus = "idle", error: string | null = null) =>
    renderToStaticMarkup(
        <EegPairModal
            variant={variant}
            status={status}
            error={error}
            contactChannels={[]}
            getChannelSamples={() => new Float32Array()}
            getEegRateHz={() => null}
            onConnect={() => {}}
            onProceed={() => {}}
            onCancel={() => {}}
        />
    );

describe("EegPairModal", () => {
    it("renders nothing when closed", () => {
        expect(render(null)).toBe("");
    });

    it("offers consent, pairing and continuing without EEG", () => {
        const html = render("start");
        expect(html).toContain("I consent to my EEG being recorded");
        expect(html).toContain("Pair headband");
        expect(html).toContain("Continue without EEG");
        expect(html).toContain("Cancel");
    });

    it("words the prompt for the action that raised it", () => {
        expect(render("start")).toContain("during this assessment");
        expect(render("new")).toContain("during this new assessment");
        expect(render("continue")).toContain("for the remaining questions");
    });

    it("shows the pairing error inline", () => {
        expect(render("new", "error", "No headband was chosen.")).toContain("No headband was chosen.");
    });

    it("shows progress while connecting", () => {
        expect(render("new", "connecting")).toContain("Connecting…");
    });

    it("swaps pairing for the fit lights and Start once paired", () => {
        const html = render("new", "streaming");
        expect(html).toContain("all four sensors");
        expect(html).toContain("Start");
        expect(html).not.toContain("Pair headband");
        expect(html).not.toContain("Continue without EEG");
    });
});
