import { useRef } from "react";

import { Player } from "@/components/audio/player";

const SAMPLE_RATE = 24000;

export default function useAudioPlayer() {
    const audioPlayer = useRef<Player>();

    const reset = () => {
        audioPlayer.current = new Player();
        audioPlayer.current.init(SAMPLE_RATE);
    };

    const play = (base64Audio: string) => {
        const binary = atob(base64Audio);
        const bytes = Uint8Array.from(binary, c => c.charCodeAt(0));
        const pcmData = new Int16Array(bytes.buffer);

        audioPlayer.current?.play(pcmData);
    };

    const stop = () => {
        audioPlayer.current?.stop();
    };

    // Returns the current player's analyser (recreated on each reset), or null before
    // a session starts. Consumers poll this so they always read the live agent output.
    const getAnalyser = () => audioPlayer.current?.getAnalyser() ?? null;

    return { reset, play, stop, getAnalyser };
}
