import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ShieldCheck, X } from "lucide-react";

import { Button } from "./button";
import { cn } from "@/lib/utils";

/**
 * Identifies the exact wording below. Sent with every acceptance (POST /consent) and
 * stored in consent_events — bump it whenever the text changes, so each recorded
 * acceptance says which wording the participant actually agreed to.
 */
export const CONSENT_VERSION = "2026-10-01";

export const CONSENT_INTRO = "CIQ uses your camera to read physiological signals from your face. By continuing, you agree that:";

export const CONSENT_POINTS: string[] = [
    "Your biometric data will be used to train and improve CIQ's machine learning models.",
    "Your current burnout score is based on the BAT-4 and CBI questionnaires.",
    "Camera frames are deleted straight after processing. We never store photos or video of you.",
    "Your data is stored under a participant code, not your name.",
    "CIQ is in development and does not provide a medical diagnosis.",
    "Data already used to train our models cannot be removed from them."
];

export type ConsentModalProps = {
    /** Visibility is owned by the parent — gate the assessment page on this. */
    isOpen: boolean;
    /** Fires when the user ticks the box and presses Agree & Continue. */
    onAgree: () => void;
    /** Fires on the X button, Escape, or a backdrop click — the user did not agree. */
    onDecline: () => void;
    title?: string;
};

/**
 * Blocking consent dialog shown each time the user enters the assessment page (PILOT).
 * "Agree & Continue" stays disabled until "I understand and agree." is ticked.
 */
export default function ConsentModal({ isOpen, onAgree, onDecline, title = "Before we begin" }: ConsentModalProps) {
    const [checked, setChecked] = useState(false);
    const panelRef = useRef<HTMLDivElement>(null);

    // Reset per-open so every showing requires ticking the box again.
    useEffect(() => {
        if (isOpen) setChecked(false);
    }, [isOpen]);

    // Lock page scroll while the modal is open.
    useEffect(() => {
        if (!isOpen) return;
        const original = document.body.style.overflow;
        document.body.style.overflow = "hidden";
        return () => {
            document.body.style.overflow = original;
        };
    }, [isOpen]);

    // Escape declines, same as the X button / backdrop click.
    useEffect(() => {
        if (!isOpen) return;
        const onKeyDown = (e: KeyboardEvent) => {
            if (e.key === "Escape") onDecline();
        };
        window.addEventListener("keydown", onKeyDown);
        return () => window.removeEventListener("keydown", onKeyDown);
    }, [isOpen, onDecline]);

    // Basic focus management: move focus into the dialog on open.
    useEffect(() => {
        if (isOpen) panelRef.current?.focus();
    }, [isOpen]);

    return (
        <AnimatePresence>
            {isOpen && (
                <motion.div
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    exit={{ opacity: 0 }}
                    className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
                    onClick={onDecline}
                >
                    <motion.div
                        ref={panelRef}
                        initial={{ opacity: 0, scale: 0.95, y: 16 }}
                        animate={{ opacity: 1, scale: 1, y: 0 }}
                        exit={{ opacity: 0, scale: 0.95, y: 16 }}
                        transition={{ duration: 0.18, ease: "easeOut" }}
                        role="dialog"
                        aria-modal="true"
                        aria-labelledby="consent-modal-title"
                        aria-describedby="consent-modal-body"
                        tabIndex={-1}
                        className="flex max-h-[85vh] w-full max-w-xl flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--ciq-divider)] px-6 py-5">
                            <div className="flex items-center gap-3">
                                <span className="flex h-9 w-9 flex-none items-center justify-center rounded-full bg-[color:var(--ciq-accent-blue)]">
                                    <ShieldCheck className="h-5 w-5 text-[#0a0c0e]" />
                                </span>
                                <h2 id="consent-modal-title" className="text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                                    {title}
                                </h2>
                            </div>
                            <button
                                type="button"
                                aria-label="Close without agreeing"
                                onClick={onDecline}
                                className="rounded-md p-1 text-[color:var(--ciq-text-muted)] transition-colors hover:bg-[color:var(--ciq-hover)] hover:text-[color:var(--ciq-text-body)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Consent text */}
                        <div id="consent-modal-body" className="flex-1 overflow-y-auto px-6 py-5 text-sm leading-relaxed">
                            <p className="mb-3 text-[color:var(--ciq-text-body)]">{CONSENT_INTRO}</p>
                            <ul className="list-disc space-y-1.5 pl-5 text-[color:var(--ciq-text-68)]">
                                {CONSENT_POINTS.map(point => (
                                    <li key={point}>{point}</li>
                                ))}
                            </ul>
                        </div>

                        {/* Acknowledgement + action */}
                        <div className="space-y-4 border-t border-[color:var(--ciq-divider)] px-6 py-5">
                            <label className="flex cursor-pointer items-center gap-2.5 text-sm text-[color:var(--ciq-text-body)]">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={e => setChecked(e.target.checked)}
                                    className="h-4 w-4 flex-none rounded border-[color:var(--ciq-border)] accent-[color:var(--ciq-accent-purple)]"
                                />
                                <span>I understand and agree.</span>
                            </label>
                            <div className="flex justify-end">
                                <Button type="button" onClick={onAgree} disabled={!checked} className={cn("ciq-btn-primary ciq-touch", "disabled:opacity-40")}>
                                    Agree & Continue
                                </Button>
                            </div>
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}
