export class Player {
    private playbackNode: AudioWorkletNode | null = null;
    private analyserNode: AnalyserNode | null = null;

    async init(sampleRate: number) {
        const audioContext = new AudioContext({ sampleRate });
        await audioContext.audioWorklet.addModule("audio-playback-worklet.js");

        this.playbackNode = new AudioWorkletNode(audioContext, "audio-playback-worklet");

        // Tap the agent's output so visualizers (e.g. the avatar) can read its volume:
        // playback → analyser → speakers. The analyser is read-only for consumers.
        this.analyserNode = audioContext.createAnalyser();
        this.analyserNode.fftSize = 256;
        this.analyserNode.smoothingTimeConstant = 0.8;
        this.playbackNode.connect(this.analyserNode);
        this.analyserNode.connect(audioContext.destination);
    }

    getAnalyser(): AnalyserNode | null {
        return this.analyserNode;
    }

    play(buffer: Int16Array) {
        if (this.playbackNode) {
            this.playbackNode.port.postMessage(buffer);
        }
    }

    stop() {
        if (this.playbackNode) {
            this.playbackNode.port.postMessage(null);
        }
    }
}
