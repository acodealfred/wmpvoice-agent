import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

import { MuseBattery, MuseBatteryWarning, batteryLevel } from "./muse-battery";

describe("batteryLevel", () => {
    it("is ok above 20 %", () => {
        expect(batteryLevel(100)).toBe("ok");
        expect(batteryLevel(21)).toBe("ok");
    });

    it("is low at 20 % and below, critical at 10 % and below", () => {
        expect(batteryLevel(20)).toBe("low");
        expect(batteryLevel(11)).toBe("low");
        expect(batteryLevel(10)).toBe("critical");
        expect(batteryLevel(0)).toBe("critical");
    });
});

describe("MuseBattery", () => {
    it("renders nothing before the first telemetry packet", () => {
        expect(renderToStaticMarkup(<MuseBattery percent={null} />)).toBe("");
    });

    it("shows the percentage", () => {
        expect(renderToStaticMarkup(<MuseBattery percent={87} />)).toContain("87%");
    });

    it("colours by level", () => {
        expect(renderToStaticMarkup(<MuseBattery percent={87} />)).toContain("--ciq-accent-green");
        expect(renderToStaticMarkup(<MuseBattery percent={15} />)).toContain("--ciq-accent-amber");
        expect(renderToStaticMarkup(<MuseBattery percent={10} />)).toContain("--ciq-accent-red");
    });
});

describe("MuseBatteryWarning", () => {
    it("is silent when the charge is fine or unknown", () => {
        expect(renderToStaticMarkup(<MuseBatteryWarning percent={50} />)).toBe("");
        expect(renderToStaticMarkup(<MuseBatteryWarning percent={null} />)).toBe("");
    });

    it("warns when low", () => {
        expect(renderToStaticMarkup(<MuseBatteryWarning percent={18} />)).toContain("Charge it before starting");
    });
});
