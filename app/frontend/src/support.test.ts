import { describe, it, expect } from "vitest";
import { isWebBluetoothAvailable } from "./support";

describe("isWebBluetoothAvailable", () => {
    it("is true only when navigator.bluetooth is an object", () => {
        expect(isWebBluetoothAvailable({ bluetooth: {} })).toBe(true);
        expect(isWebBluetoothAvailable({})).toBe(false);
        expect(isWebBluetoothAvailable({ bluetooth: undefined })).toBe(false);
        expect(isWebBluetoothAvailable(undefined)).toBe(false);
    });
});
