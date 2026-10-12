// "Download PDF" for a report: the browser's own print → "Save as PDF", limited to
// one element. The element and its ancestors are tagged so the print styles in
// index.css hide everything else; the element is pinned to A4 width first (and the
// charts given a moment to redraw at that width) so the page matches the screen.

/** Minimal element shape — the real DOM in the app, a fake in tests. */
export interface PrintNode {
    parentElement: PrintNode | null;
    setAttribute(name: string, value: string): void;
    removeAttribute(name: string): void;
}

export const PRINT_TARGET = "data-print-target";
export const PRINT_ANCESTOR = "data-print-ancestor";

/** Tag `target` and every ancestor for printing; returns the undo. */
export function markPrintTree(target: PrintNode): () => void {
    const ancestors: PrintNode[] = [];
    target.setAttribute(PRINT_TARGET, "");
    for (let el = target.parentElement; el; el = el.parentElement) {
        el.setAttribute(PRINT_ANCESTOR, "");
        ancestors.push(el);
    }
    return () => {
        target.removeAttribute(PRINT_TARGET);
        ancestors.forEach(el => el.removeAttribute(PRINT_ANCESTOR));
    };
}

const nextFrame = () => new Promise<void>(r => requestAnimationFrame(() => r()));

/**
 * Open the print dialog for `target` only. `fileTitle` becomes the suggested PDF
 * file name (browsers use document.title). Everything is restored afterwards.
 */
export async function printReport(target: HTMLElement, fileTitle: string): Promise<void> {
    const unmark = markPrintTree(target);
    const prevTitle = document.title;
    document.title = fileTitle;

    let restored = false;
    const restore = () => {
        if (restored) return;
        restored = true;
        unmark();
        document.title = prevTitle;
        window.removeEventListener("afterprint", restore);
    };
    window.addEventListener("afterprint", restore);

    // Let the A4-width layout apply and the charts (ResizeObserver) redraw before printing.
    await nextFrame();
    await new Promise(r => setTimeout(r, 200));
    await nextFrame();
    try {
        window.print();
    } catch {
        restore();
    }
}
