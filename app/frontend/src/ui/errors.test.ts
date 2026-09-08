import { describe, it, expect } from "vitest";
import { explainConnectError, explainStartError } from "./errors";

describe("explainConnectError", () => {
    it("treats a dismissed chooser as nothing chosen, not a failure", () => {
        // Chrome's own wording when the picker is closed without a selection.
        expect(explainConnectError(new Error("User cancelled the requestDevice() chooser."))).toMatch(/Pair headband/);
        expect(explainConnectError(new Error("Must be handling a user gesture to show a permission request."))).toMatch(/Pair headband/);
    });

    it("tells the operator to power-cycle when the headband never answers v1", () => {
        expect(explainConnectError(new Error("No reply to v1 from the headband."))).toMatch(/did not answer/);
    });

    it("passes anything else through verbatim", () => {
        expect(explainConnectError(new Error("This device does not expose a GATT server."))).toBe("Could not connect: This device does not expose a GATT server.");
    });

    it("survives a non-Error being thrown", () => {
        expect(explainConnectError("adapter off")).toBe("Could not connect: adapter off");
    });
});

describe("explainStartError", () => {
    it("names a connection lost between pairing and streaming", () => {
        const dropped = "GATT Server is disconnected. Cannot perform GATT operations. (Re)connect first with device.gatt.connect().";
        expect(explainStartError(new Error(dropped))).toMatch(/dropped the connection/);
        expect(explainStartError(new Error("NetworkError: Connection Attempt Failed."))).toMatch(/dropped the connection/);
        expect(explainStartError(new Error("Not connected."))).toMatch(/dropped the connection/);
    });

    it("passes anything else through verbatim", () => {
        expect(explainStartError(new Error("GATT operation failed for unknown reason."))).toBe("Could not start streaming: GATT operation failed for unknown reason.");
    });

    it("survives a non-Error being thrown", () => {
        expect(explainStartError("boom")).toBe("Could not start streaming: boom");
    });
});
