import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { EegConnectPanel } from "./eeg-connect-panel";

const render = (hasRecording: boolean, assessmentComplete: boolean) =>
    renderToStaticMarkup(
        <EegConnectPanel
            status="idle"
            device={null}
            error={null}
            available={true}
            hasRecording={hasRecording}
            batteryPercent={null}
            assessmentStarted={false}
            assessmentComplete={assessmentComplete}
            channels={[]}
            getChannelSamples={() => new Float32Array(0)}
            showContact={false}
            contactChannels={[]}
            getEegRateHz={() => null}
            onDisconnect={() => {}}
            onSave={() => {}}
        />
    );

describe("EegConnectPanel when the headband is not connected", () => {
    it("says the recording is saved only once the assessment completed", () => {
        expect(render(true, true)).toContain("Recording complete and saved");
    });

    it("never claims a save after a mid-assessment drop or Pause", () => {
        const html = render(true, false);
        expect(html).not.toContain("Recording complete");
        expect(html).toContain("offered to pair it when you start or continue");
    });
});
