import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowDown, ShieldCheck, X } from "lucide-react";

import { Button } from "./button";
import { cn } from "@/lib/utils";

export type ConsentSection = {
    heading: string;
    /** A single paragraph, or several rendered as separate <p> tags. */
    body: string | string[];
};

export type ConsentModalProps = {
    /** Visibility is owned by the parent — gate survey/conversation start on this. */
    isOpen: boolean;
    /** Fires when the user explicitly agrees. Parent should unlock the flow here. */
    onAgree: () => void;
    /** Fires on Decline, the X button, Escape, or a backdrop click. Keep the flow locked. */
    onDecline: () => void;
    title?: string;
    studyName?: string;
    sections?: ConsentSection[];
    /** How close to the bottom (px) counts as "reached the end" of the scroll area. */
    scrollThresholdPx?: number;
};

export const DEFAULT_CONSENT_SECTIONS: ConsentSection[] = [
    {
        heading: "Purpose of this study",
        body: "This pilot survey is part of a research study evaluating workplace burnout using the Burnout Assessment Tool (BAT), voice interaction, and optional biometric signals (e.g. blink rate, facial expression) captured through your device's camera. Your participation helps us validate and improve this assessment before wider release."
    },
    {
        heading: "What you will be asked to do",
        body: "You will have a short spoken conversation with an AI voice agent that asks a series of standardized questions about your work-related wellbeing. If you opt in to biometric capture, your webcam is used locally to estimate signals like blink rate and facial expression during the conversation."
    },
    {
        heading: "Data privacy & confidentiality",
        body: [
            "Your responses and any biometric readings are stored securely and used only for the purposes of this research study and generating your personal report.",
            "Audio is processed to generate your responses and is not retained beyond what is required to complete the assessment and produce your report, unless you are separately notified otherwise.",
            "We do not sell your data or share it with third parties outside the research and product team without your explicit consent."
        ]
    },
    {
        heading: "Anonymity & data use",
        body: "Where results are used for aggregate research or reporting, your data is de-identified so individual responses cannot be attributed to you by name. Your organization may see aggregate, de-identified trends but not your individual answers, unless you choose to share your report directly."
    },
    {
        heading: "Voluntary participation & withdrawal",
        body: "Your participation is entirely voluntary. You may decline to participate, skip questions, or withdraw at any time, for any reason, without penalty or effect on your employment or standing. If you withdraw mid-survey, your partial data will be discarded on request."
    },
    {
        heading: "Risks & support",
        body: "This assessment is not a medical or diagnostic tool. Some questions touch on stress and burnout, which may bring up difficult feelings. If you experience distress, please consider reaching out to your HR team, an Employee Assistance Program, or a mental health professional."
    }
];

/**
 * Blocking informed-consent modal. The primary action stays disabled until the user
 * either scrolls the consent text to its end or checks the acknowledgement box —
 * whichever comes first — so it can't be dismissed without reading (or explicitly
 * confirming they've read) the terms.
 */
export default function ConsentModal({
    isOpen,
    onAgree,
    onDecline,
    title = "Informed Consent",
    studyName = "Burnout Assessment Pilot Study",
    sections = DEFAULT_CONSENT_SECTIONS,
    scrollThresholdPx = 24
}: ConsentModalProps) {
    const [hasScrolledToEnd, setHasScrolledToEnd] = useState(false);
    const [checked, setChecked] = useState(false);
    const scrollRef = useRef<HTMLDivElement>(null);
    const panelRef = useRef<HTMLDivElement>(null);

    const canContinue = hasScrolledToEnd || checked;

    // Reset per-open so re-showing the modal (e.g. after a decline) requires reading
    // or checking again, rather than remembering a previous session's acceptance.
    useEffect(() => {
        if (isOpen) {
            setHasScrolledToEnd(false);
            setChecked(false);
        }
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

    const handleScroll = useCallback(() => {
        const el = scrollRef.current;
        if (!el) return;
        const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
        if (distanceFromBottom <= scrollThresholdPx) {
            setHasScrolledToEnd(true);
        }
    }, [scrollThresholdPx]);

    // Covers the case where the consent text is short enough to need no scrolling at all —
    // measure once layout has settled after the modal mounts.
    useEffect(() => {
        if (!isOpen) return;
        const id = requestAnimationFrame(handleScroll);
        return () => cancelAnimationFrame(id);
    }, [isOpen, handleScroll]);

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
                        className="flex max-h-[85vh] w-full max-w-lg flex-col overflow-hidden rounded-2xl border border-[color:var(--ciq-border)] bg-[color:var(--ciq-card)] shadow-2xl outline-none"
                        onClick={e => e.stopPropagation()}
                    >
                        {/* Header */}
                        <div className="flex items-start justify-between gap-4 border-b border-[color:var(--ciq-divider)] px-6 py-5">
                            <div className="flex items-start gap-3">
                                <span className="mt-0.5 flex h-9 w-9 flex-none items-center justify-center rounded-full bg-gradient-to-br from-[color:var(--ciq-accent-purple)] to-[color:var(--ciq-accent-blue)]">
                                    <ShieldCheck className="h-5 w-5 text-white" />
                                </span>
                                <div>
                                    <h2 id="consent-modal-title" className="text-lg font-semibold text-[color:var(--ciq-text-strong)]">
                                        {title}
                                    </h2>
                                    <p className="text-sm text-[color:var(--ciq-text-60)]">{studyName}</p>
                                </div>
                            </div>
                            <button
                                type="button"
                                aria-label="Close and decline"
                                onClick={onDecline}
                                className="rounded-md p-1 text-[color:var(--ciq-text-muted)] transition-colors hover:bg-[color:var(--ciq-hover)] hover:text-[color:var(--ciq-text-body)]"
                            >
                                <X className="h-5 w-5" />
                            </button>
                        </div>

                        {/* Scrollable consent body */}
                        <div
                            ref={scrollRef}
                            onScroll={handleScroll}
                            id="consent-modal-body"
                            className="flex-1 space-y-5 overflow-y-auto px-6 py-5 text-sm leading-relaxed"
                        >
                            {sections.map((section, i) => (
                                <section key={i}>
                                    <h3 className="mb-1.5 font-medium text-[color:var(--ciq-text-strong)]">{section.heading}</h3>
                                    {(Array.isArray(section.body) ? section.body : [section.body]).map((para, j) => (
                                        <p key={j} className="mb-2 text-[color:var(--ciq-text-68)] last:mb-0">
                                            {para}
                                        </p>
                                    ))}
                                </section>
                            ))}
                            <p className="pt-1 text-xs italic text-[color:var(--ciq-text-faint)]">— End of consent statement —</p>
                        </div>

                        {/* Scroll hint — disappears once the user has reached the bottom */}
                        {!hasScrolledToEnd && (
                            <div className="pointer-events-none -mt-9 flex justify-center pb-1">
                                <span className="flex items-center gap-1 rounded-full bg-[color:var(--ciq-tile-strong)] px-2.5 py-1 text-[11px] text-[color:var(--ciq-text-muted)] shadow">
                                    <ArrowDown className="h-3 w-3 animate-bounce" />
                                    Scroll to read all terms
                                </span>
                            </div>
                        )}

                        {/* Footer: acknowledgement + actions */}
                        <div className="space-y-4 border-t border-[color:var(--ciq-divider)] px-6 py-5">
                            <label className="flex cursor-pointer items-start gap-2.5 text-sm text-[color:var(--ciq-text-body)]">
                                <input
                                    type="checkbox"
                                    checked={checked}
                                    onChange={e => setChecked(e.target.checked)}
                                    className="mt-0.5 h-4 w-4 flex-none rounded border-[color:var(--ciq-border)] accent-[color:var(--ciq-accent-purple)]"
                                />
                                <span>I have read and accept the terms of this consent form.</span>
                            </label>

                            <div className="flex justify-end gap-3">
                                <Button type="button" variant="ghost" onClick={onDecline}>
                                    Decline
                                </Button>
                                <Button
                                    type="button"
                                    onClick={onAgree}
                                    disabled={!canContinue}
                                    className={cn(
                                        "bg-gradient-to-r from-[color:var(--ciq-accent-purple)] to-[color:var(--ciq-accent-blue)] text-white",
                                        "hover:opacity-90 disabled:opacity-40"
                                    )}
                                >
                                    Agree & Continue
                                </Button>
                            </div>

                            {!canContinue && (
                                <p className="text-xs text-[color:var(--ciq-text-faint)]">
                                    Scroll to the end of the consent text or check the box above to continue.
                                </p>
                            )}
                        </div>
                    </motion.div>
                </motion.div>
            )}
        </AnimatePresence>
    );
}

// ── Usage (in the parent that gates the survey/conversation) ────────────────────
//
// const [consentGiven, setConsentGiven] = useState(false);
// const [showConsent, setShowConsent] = useState(false);
//
// <ConsentModal
//     isOpen={showConsent}
//     onAgree={() => {
//         setConsentGiven(true);
//         setShowConsent(false);
//         onStartListening(); // unlock the gated action
//     }}
//     onDecline={() => setShowConsent(false)}
// />
//
// <Button
//     onClick={() => (consentGiven ? onStartListening() : setShowConsent(true))}
// >
//     Start Assessment
// </Button>
