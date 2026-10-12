import { describe, expect, it } from "vitest";
import { markPrintTree, PRINT_ANCESTOR, PRINT_TARGET, type PrintNode } from "./print-report";

function node(parent: PrintNode | null = null): PrintNode & { attrs: Set<string> } {
    const attrs = new Set<string>();
    return {
        attrs,
        parentElement: parent,
        setAttribute: name => void attrs.add(name),
        removeAttribute: name => void attrs.delete(name)
    };
}

describe("markPrintTree", () => {
    it("tags the report and every ancestor, and undoes it", () => {
        const html = node();
        const body = node(html);
        const dialog = node(body);
        const report = node(dialog);
        const sibling = node(body);

        const undo = markPrintTree(report);
        expect([...report.attrs]).toEqual([PRINT_TARGET]);
        for (const el of [dialog, body, html]) expect([...el.attrs]).toEqual([PRINT_ANCESTOR]);
        expect(sibling.attrs.size).toBe(0);

        undo();
        for (const el of [report, dialog, body, html]) expect(el.attrs.size).toBe(0);
    });
});
