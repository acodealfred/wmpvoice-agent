// PILOT report screen: tracks the agent's spoken explanation of the report so Pause can
// cut it off precisely and Continue can resume it from that point.
//
//   idle ──start()──▶ explaining ──pause()──▶ paused ──resume()──▶ explaining
//                         │
//                         └─ response done + audio played out ──▶ done
//
// Pause returns a conversation.item.truncate target (the explanation item + how much of
// it was heard), so the model's memory of what it said ends where the user stopped
// hearing it; resume() then asks it to carry on ("report_continue"). If the realtime
// session was replaced meanwhile (reconnect), that item no longer exists, so resume()
// restarts the explanation ("report_explain") instead.

import type { PlaybackPosition } from "@/components/audio/player";
import type { ReportCue } from "@/types";

export type ReportSpeechState = "idle" | "explaining" | "paused" | "done";

export class ReportSpeech {
    private state: ReportSpeechState = "idle";
    private itemId: string | null = null;
    private generated = false;
    private contextLost = false;

    constructor(private readonly onChange: (state: ReportSpeechState) => void = () => {}) {}

    getState(): ReportSpeechState {
        return this.state;
    }

    /** Start pressed: the cue to send. */
    start(): ReportCue {
        this.itemId = null;
        this.generated = false;
        this.contextLost = false;
        this.setState("explaining");
        return "report_explain";
    }

    /** A chunk of agent audio was played. */
    agentAudio(itemId: string | undefined): void {
        if (this.state !== "explaining") return;
        if (itemId) this.itemId = itemId;
        this.generated = false;
    }

    /** The agent's response finished generating. */
    responseDone(): void {
        if (this.state === "explaining" && this.itemId) this.generated = true;
    }

    /** All queued agent audio has played out. */
    drained(): void {
        if (this.state === "explaining" && this.generated) this.setState("done");
    }

    /**
     * Pause pressed, with where playback was cut off. Returns the truncate target, or null
     * when there is nothing to truncate (not explaining, or the position isn't this item).
     */
    pause(position: PlaybackPosition | null): PlaybackPosition | null {
        if (this.state !== "explaining") return null;
        this.setState("paused");
        if (position && this.itemId && position.itemId === this.itemId) return position;
        // Cut off before any of the explanation was heard (or position unknown): start over.
        this.contextLost = true;
        return null;
    }

    /** The realtime session was replaced: the explanation item is gone from its memory. */
    sessionReset(): void {
        this.itemId = null;
        if (this.state === "paused") this.contextLost = true;
    }

    /** Continue pressed: the cue to send, or null when there is nothing left to explain. */
    resume(): ReportCue | null {
        if (this.state !== "paused") return null;
        const cue: ReportCue = this.contextLost ? "report_explain" : "report_continue";
        this.contextLost = false;
        this.generated = false;
        this.setState("explaining");
        return cue;
    }

    /** Finish / leaving the report screen. */
    reset(): void {
        this.itemId = null;
        this.generated = false;
        this.contextLost = false;
        this.setState("idle");
    }

    private setState(next: ReportSpeechState): void {
        if (this.state === next) return;
        this.state = next;
        this.onChange(next);
    }
}
