import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { Bluetooth, X } from "lucide-react";

import { Button } from "./button";
import { MuseContactLights } from "./muse-contact-lights";
import { cn } from "@/lib/utils";
import type { MuseStatus } from "@/hooks/useMuse";
import type { EegChannel } from "@/muse";

/** Which start action raised the prompt — only the wording differs between them. */
export type EegPairVariant = "start" | "new" | "continue";

const MESSAGES: Record<EegPairVariant, string> = {
    start: "Your EEG headband isn't connected. Pair it now to record EEG during this assessment, or continue without it.",
    new: "Your EEG headband isn't connected. Pair it now to record EEG during this new assessment, or continue without it.",
    continue: "Your EEG headband isn't connected. Pair it now to record EEG for the remaining questions, or continue without it."
};

export type EegPairModalProps = {
    /** The prompt to show, or null when closed. Visibility is owned by the parent. */
    variant: EegPairVariant | null;
    status: MuseStatus;
    error: string | null;
    /** Fit lights shown once paired, so the band can be adjusted before starting. */
    contactChannels: readonly EegChannel[];
    getChannelSamples: (ch: EegChannel) => Float32Array;
    getEegRateHz: () => number | null;
    /** Must run inside the Pair button's click — Web Bluetooth needs a user gesture. */
    onConnect: (consentAcceptedAt: string) => void;
    /** Proceed with the start action — with EEG once paired, otherwise without it. */
    onProceed: () => void;
    /** X button, Escape, or a backdrop click — abandon the start action. */
    onCancel: () => void;
};

/**
 * Pre-start prompt for the optional Muse EEG headband, shown by Start / Start New /
 * Continue only when the headband isn't connected. Pairing happens here rather than in
 * the biometrics card. Once paired, the four fit lights show so the band can be adjusted,
 * and Start resumes the start action. EEG stays optional — "Continue without EEG" always works.
 */
export default function EegPairModal({
    variant,
    status,
    error,
    contactChannels,
    getChannelSamples,
    getEegRateHz,
    onConnect,
    onProceed,
    onCancel
}: EegPairModalProps) {
    const isOpen = variant !== null;
    const [consented, setConsented] = useState(false);
    const consentAcceptedAtRef = useRef<string | null>(null);
    const panelRef = useRef<HTMLDivElement>(null);
    const isBusy = status === "connecting";
    const isPaired = status === "streaming" || status === "paused";

    // Reset per-open so every showing requires ticking the box again.
    useEffect(() => {
        if (isOpen) {
            setConsented(false);
            consentAcceptedAtRef.current = null;
        }
    }, [isOpen]);

    // Escape cancels, same as the X button / backdrop click.
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onCancel();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isOpen, onCancel]);

    useEffect(() => {
        if (isOpen) panelRef.current?.focus();
    }, [isOpen]);

    const handleConsentChange = (checked: boolean) => {
        setConsented(checked);
        consentAcceptedAtRef.current = checked ? new Date().toISOString() : null;
    };

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={onCancel}
                >
                    <motion.div
                        ref={panelRef}
                        initial={{ opacity: 0, scale: 0.95, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 16 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="eeg-pair-modal-title"
                        aria-describedby="eeg-pair-modal-body"
                        tabIndex={-1}
                        className="flex w-full max-w-md flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none"
                        onClick={e => e.stopPropagation()}
                    >
                        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--ciq-divider)] px-6 py-5">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[color:var(--ciq-accent-blue)]">
                                    <Bluetooth className="h-5 w-5 text-[#0a0c0e]" />
                                </span>
                                <h2 id="eeg-pair-modal-title" className="text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                                    EEG headband
                                </h2>
                            </div>
                            <button
                                type="button"
                                aria-label="Cancel"
                                onClick={onCancel}
                                className="rounded-md p-1 text-[color:var(--ciq-text-muted)] transition-colors hover:bg-[color:var(--ciq-hover)] hover:text-[color:var(--ciq-text-body)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        <div id="eeg-pair-modal-body" className="space-y-4 px-6 py-5 text-sm leading-relaxed">
                            {isPaired ? (
                                <>
                                    <p className="text-[color:var(--ciq-text-body)]">
                                        Headband paired. Adjust the band until all four sensors show good contact, then press Start.
                                    </p>
                                    <MuseContactLights channels={contactChannels} getChannelSamples={getChannelSamples} getEegRateHz={getEegRateHz} />
                                </>
                            ) : (
                                <>
                                    <p className="text-[color:var(--ciq-text-body)]">{MESSAGES[variant]}</p>
                                    {error && <p className="text-xs text-[color:var(--ciq-accent-red)]">{error}</p>}
                                    <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[color:var(--ciq-text-body)]">
                                        <input
                                            type="checkbox"
                                            checked={consented}
                                            disabled={isBusy}
                                            onChange={e => handleConsentChange(e.target.checked)}
                                            className="mt-0.5 h-4 w-4 flex-none rounded border-[color:var(--ciq-border)] accent-[color:var(--ciq-accent-purple)]"
                                        />
                                        <span>I consent to my EEG being recorded during this assessment.</span>
                                    </label>
                                    <Button
                                        type="button"
                                        onClick={() => onConnect(consentAcceptedAtRef.current!)}
                                        disabled={!consented || isBusy}
                                        className={cn("ciq-btn-primary ciq-touch w-full", "disabled:opacity-40")}
                                    >
                                        <Bluetooth className="mr-2 h-4 w-4" />
                                        {isBusy ? "Connecting…" : "Pair headband"}
                                    </Button>
                                </>
                            )}
                        </div>

                        <div className="flex justify-end gap-2 border-t border-[color:var(--ciq-divider)] px-6 py-4">
                            <Button type="button" variant="outline" onClick={onCancel}>
                                Cancel
                            </Button>
                            {isPaired ? (
                                <Button type="button" onClick={onProceed} className="ciq-btn-primary ciq-touch">
                                    Start
                                </Button>
                            ) : (
                                <Button type="button" variant="outline" onClick={onProceed} disabled={isBusy}>
                                    Continue without EEG
                                </Button>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
