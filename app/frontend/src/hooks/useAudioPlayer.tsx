import { useRef } from "react";

import { Player, type PlaybackPosition } from "@/components/audio/player";

const SAMPLE_RATE = 24000;

type Parameters = {
    // Called whenever the agent's queued audio has fully played out (or was stopped).
    onDrained?: () => void;
};

export default function useAudioPlayer({ onDrained }: Parameters = {}) {
    const audioPlayer = useRef<Player>();
    // Read through a ref so a fresh callback each render is used without re-creating the player.
    const onDrainedRef = useRef(onDrained);
    onDrainedRef.current = onDrained;

    const reset = () => {
        audioPlayer.current = new Player();
        audioPlayer.current.init(SAMPLE_RATE, () => onDrainedRef.current?.());
    };

    // `itemId` (the response.audio.delta's item_id) lets stop() report where that
    // item's speech was cut off.
    const play = (base64Audio: string, itemId?: string) => {
        const binary = atob(base64Audio);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);

        audioPlayer.current?.play(pcmData, itemId);
    };

    /** Stops playback. Resolves with where the agent's current item was cut off, if known. */
    const stop = (): Promise<PlaybackPosition | null> => audioPlayer.current?.stop() ?? Promise.resolve(null);

    // Returns the current player's analyser (recreated on each reset), or null before
    // a session starts. Consumers poll this so they always read the live agent output.
    const getAnalyser = () => audioPlayer.current?.getAnalyser() ?? null;

    return { reset, play, stop, getAnalyser };
}
