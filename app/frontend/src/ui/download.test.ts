import { describe, it, expect, vi } from "vitest";
import { downloadJson, sessionFilename } from "./download";

describe("sessionFilename", () => {
    it("is sortable and filesystem-safe", () => {
        expect(sessionFilename(new Date("2026-08-22T09:14:03.218Z"), "Muse-7F2A")).toBe("muse-session-2026-08-22T09-14-03Z-Muse-7F2A.json");
    });
});

describe("downloadJson", () => {
    it("creates a blob URL, clicks an anchor with the filename, then revokes", () => {
        const clicked: { href: string; download: string }[] = [];
        const anchor = {
            href: "",
            download: "",
            click() {
                clicked.push({ href: this.href, download: this.download });
            }
        };
        const doc = { createElement: vi.fn(() => anchor) };
        const url = { createObjectURL: vi.fn(() => "blob:abc"), revokeObjectURL: vi.fn() };
        downloadJson({ a: 1 }, "x.json", { doc, url, blob: (parts, type) => ({ parts, type }) as unknown as Blob });
        expect(doc.createElement).toHaveBeenCalledWith("a");
        expect(clicked).toEqual([{ href: "blob:abc", download: "x.json" }]);
        expect(url.revokeObjectURL).toHaveBeenCalledWith("blob:abc");
    });
});
