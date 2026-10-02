/** Where the agent's speech was cut off by stop(): its conversation item and how much of it was heard. */
export type PlaybackPosition = { itemId: string; playedMs: number };

// If the worklet never answers a stop (audio context closed), resolve without a position.
const STOP_REPLY_TIMEOUT_MS = 500;

export class Player {
    private playbackNode: AudioWorkletNode | null = null;
    private analyserNode: AnalyserNode | null = null;
    private sampleRate = 24000;
    // Samples queued so far for the agent's current audio item (reset when a new item starts).
    private currentItemId: string | null = null;
    private queuedForItem = 0;
    private pendingStop: ((unplayed: number) => void) | null = null;

    // `onDrained` fires each time all queued agent audio has finished playing (or was
    // cleared by stop()) — the moment the agent has actually stopped speaking.
    async init(sampleRate: number, onDrained?: () => void) {
        this.sampleRate = sampleRate;
        const audioContext = new AudioContext({ sampleRate });
        await audioContext.audioWorklet.addModule("audio-playback-worklet.js");

        this.playbackNode = new AudioWorkletNode(audioContext, "audio-playback-worklet");
        this.playbackNode.port.onmessage = event => {
            if (event.data === "drained") {
                onDrained?.();
            } else if (event.data?.type === "stopped") {
                this.pendingStop?.(event.data.unplayed ?? 0);
                this.pendingStop = null;
            }
        };

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

    play(buffer: Int16Array, itemId?: string) {
        if (this.playbackNode) {
            if (itemId && itemId !== this.currentItemId) {
                this.currentItemId = itemId;
                this.queuedForItem = 0;
            }
            this.queuedForItem += buffer.length;
            this.playbackNode.port.postMessage(buffer);
        }
    }

    /** Stops playback at once. Resolves with where the current item was cut off, if known. */
    stop(): Promise<PlaybackPosition | null> {
        const node = this.playbackNode;
        if (!node) return Promise.resolve(null);
        const itemId = this.currentItemId;
        const queued = this.queuedForItem;
        return new Promise(resolve => {
            const timer = setTimeout(() => {
                this.pendingStop = null;
                resolve(null);
            }, STOP_REPLY_TIMEOUT_MS);
            this.pendingStop = unplayed => {
                clearTimeout(timer);
                if (!itemId) return resolve(null);
                const played = Math.max(0, queued - unplayed);
                resolve({ itemId, playedMs: Math.round((played / this.sampleRate) * 1000) });
            };
            node.port.postMessage(null);
        });
    }
}
