import { describe, it, expect } from "vitest";
import {
    MUSE_SERVICE,
    CONTROL_UUID,
    EEG_UUIDS,
    PPG_UUIDS,
    channelsForPreset,
    presetHasPpg,
    eegChannelForUuid,
    ppgChannelForUuid,
    encodeCommand,
    decodeControlChunk,
    ControlAssembler
} from "./protocol";

describe("protocol constants", () => {
    it("uses the Muse GATT service", () => {
        expect(MUSE_SERVICE).toBe(0xfe8d);
    });

    it("builds characteristic UUIDs on the Muse base", () => {
        expect(CONTROL_UUID).toBe("273e0001-4c4d-454d-96be-f03bac821358");
        expect(EEG_UUIDS.TP9).toBe("273e0003-4c4d-454d-96be-f03bac821358");
        expect(EEG_UUIDS.AUX).toBe("273e0007-4c4d-454d-96be-f03bac821358");
        expect(PPG_UUIDS.red).toBe("273e0011-4c4d-454d-96be-f03bac821358");
    });

    it("maps UUIDs back to channels, case-insensitively", () => {
        expect(eegChannelForUuid(EEG_UUIDS.AF8)).toBe("AF8");
        expect(eegChannelForUuid(EEG_UUIDS.AF8.toUpperCase())).toBe("AF8");
        expect(eegChannelForUuid(CONTROL_UUID)).toBeUndefined();
        expect(ppgChannelForUuid(PPG_UUIDS.infrared)).toBe("infrared");
    });
});

describe("presets", () => {
    it.each([
        ["p21", ["TP9", "AF7", "AF8", "TP10"], false],
        ["p20", ["TP9", "AF7", "AF8", "TP10", "AUX"], false],
        ["p50", ["TP9", "AF7", "AF8", "TP10"], true]
    ] as const)("%s streams %j, ppg=%s", (preset, channels, ppg) => {
        expect(channelsForPreset(preset)).toEqual(channels);
        expect(presetHasPpg(preset)).toBe(ppg);
    });
});

describe("command framing", () => {
    it("frames a command as [len+1, ascii, newline]", () => {
        expect(Array.from(encodeCommand("p21"))).toEqual([4, 0x70, 0x32, 0x31, 0x0a]);
        expect(Array.from(encodeCommand("s"))).toEqual([2, 0x73, 0x0a]);
    });

    it("decodes a length-prefixed reply chunk", () => {
        const chunk = new Uint8Array([5, 0x7b, 0x22, 0x72, 0x63, 0x22, 0x00, 0x00]);
        expect(decodeControlChunk(chunk)).toBe('{"rc"');
    });

    it("assembles JSON objects across chunks and ignores leading garbage", () => {
        const asm = new ControlAssembler();
        expect(asm.push('{"fw":"1.2')).toEqual([]);
        expect(asm.push('.13","rc":0}')).toEqual([{ fw: "1.2.13", rc: 0 }]);
        expect(asm.push('xx{"rc":1}{"rc":2}')).toEqual([{ rc: 1 }, { rc: 2 }]);
    });

    it("drops a malformed object without throwing", () => {
        const asm = new ControlAssembler();
        expect(asm.push("{oops}")).toEqual([]);
        expect(asm.push('{"rc":0}')).toEqual([{ rc: 0 }]);
    });
});
