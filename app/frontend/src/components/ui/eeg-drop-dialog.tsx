import { useEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { BluetoothOff } from "lucide-react";

import { Button } from "./button";

/** Where the assessment was when the headband dropped (lib/eeg-alert.ts). */
export type EegDropVariant = "baseline" | "survey";

const COPY: Record<EegDropVariant, { title: string; body: string }> = {
    baseline: {
        title: "EEG headband disconnected",
        body: "The baseline has to be recorded again with the headband connected. Press OK, then Start to begin a new assessment."
    },
    survey: {
        title: "EEG headband disconnected — assessment paused",
        body: "Check the headband is on and switched on, then connect it to continue. Your answers so far are saved."
    }
};

export type EegDropDialogProps = {
    /** Which dialog to show, or null when closed. Visibility is owned by the parent. */
    variant: EegDropVariant | null;
    /** Baseline: OK. Survey: Close (stay paused). Also Escape. */
    onDismiss: () => void;
    /** Survey only: reconnect and continue (opens the pairing popup). */
    onConnect: () => void;
};

/**
 * Shown when the EEG headband drops out mid-assessment. By then the app has already
 * acted: a baseline drop closed the run (it must be recorded again), a survey drop
 * paused it. Unlike EegPairModal, a backdrop click does nothing — the participant has
 * to read this one.
 */
export default function EegDropDialog({ variant, onDismiss, onConnect }: EegDropDialogProps) {
    const isOpen = variant !== null;
    const panelRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!isOpen) return;
        panelRef.current?.focus();
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onDismiss();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isOpen, onDismiss]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                >
                    <motion.div
                        ref={panelRef}
                        initial={{ opacity: 0, scale: 0.95, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 16 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        role="alertdialog"
                        aria-modal="true"
                        aria-labelledby="eeg-drop-dialog-title"
                        aria-describedby="eeg-drop-dialog-body"
                        tabIndex={-1}
                        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none"
                    >
                        <div className="flex items-center gap-3 border-b border-[color:var(--ciq-divider)] px-6 py-5">
                            <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[color:var(--ciq-accent-amber)]">
                                <BluetoothOff className="h-5 w-5 text-[#0a0c0e]" />
                            </span>
                            <h2 id="eeg-drop-dialog-title" className="text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                                {COPY[variant].title}
                            </h2>
                        </div>

                        <p id="eeg-drop-dialog-body" className="px-6 py-5 text-sm leading-relaxed text-[color:var(--ciq-text-body)]">
                            {COPY[variant].body}
                        </p>

                        <div className="flex justify-end gap-2 border-t border-[color:var(--ciq-divider)] px-6 py-4">
                            {variant === "baseline" ? (
                                <Button type="button" onClick={onDismiss} className="ciq-btn-primary ciq-touch">
                                    OK
                                </Button>
                            ) : (
                                <>
                                    <Button type="button" variant="outline" onClick={onDismiss}>
                                        Close
                                    </Button>
                                    <Button type="button" onClick={onConnect} className="ciq-btn-primary ciq-touch">
                                        Connect headband
                                    </Button>
                                </>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
