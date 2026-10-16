import { describe, expect, it } from "vitest";

import { pageBreaks } from "./report-pdf";

describe("pageBreaks", () => {
    it("one page when everything fits, and for an empty report", () => {
        expect(pageBreaks(800, 1000, [])).toEqual([0]);
        expect(pageBreaks(0, 1000, [])).toEqual([0]);
    });

    it("cuts at the page height when nothing needs keeping together", () => {
        expect(pageBreaks(2500, 1000, [])).toEqual([0, 1000, 2000]);
    });

    it("moves the break up to the top of a card that would be cut", () => {
        // Card 900–1200 straddles the 1000 line → page 2 starts at the card.
        expect(pageBreaks(1500, 1000, [{ top: 900, bottom: 1200 }])).toEqual([0, 900]);
    });

    it("never cuts through any card", () => {
        const cards = [
            { top: 0, bottom: 400 },
            { top: 420, bottom: 820 },
            { top: 840, bottom: 1240 },
            { top: 1260, bottom: 1660 },
            { top: 1680, bottom: 2080 }
        ];
        const starts = pageBreaks(2100, 1000, cards);
        for (const s of starts) {
            expect(cards.some(c => s > c.top && s < c.bottom)).toBe(false);
        }
    });

    it("follows nested cards up to the outer one", () => {
        // Inner 950–1050 sits inside outer 800–1100: the break goes above the outer card.
        expect(
            pageBreaks(1500, 1000, [
                { top: 950, bottom: 1050 },
                { top: 800, bottom: 1100 }
            ])
        ).toEqual([0, 800]);
    });

    it("cuts a card taller than a page, since it can't fit anywhere", () => {
        expect(pageBreaks(2500, 1000, [{ top: 100, bottom: 2400 }])).toEqual([0, 1000, 2000]);
    });
});
