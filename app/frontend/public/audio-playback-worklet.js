class AudioPlaybackWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.port.onmessage = this.handleMessage.bind(this);
        this.buffer = [];
        // True while queued agent audio is being played; flips back (and posts
        // "drained") once the queue has fully played out — see Player.onDrained.
        this.playing = false;
    }

    handleMessage(event) {
        if (event.data === null) {
            // Report how much queued audio was never played, so the caller can tell the
            // model exactly where its speech was cut off (conversation.item.truncate).
            this.port.postMessage({ type: "stopped", unplayed: this.buffer.length });
            this.buffer = [];
            if (this.playing) {
                this.playing = false;
                this.port.postMessage("drained");
            }
            return;
        }
        this.buffer.push(...event.data);
        this.playing = true;
    }

    process(inputs, outputs, parameters) {
        const output = outputs[0];
        const channel = output[0];

        if (this.buffer.length > channel.length) {
            const toProcess = this.buffer.slice(0, channel.length);
            this.buffer = this.buffer.slice(channel.length);
            channel.set(toProcess.map(v => v / 32768));
        } else {
            channel.set(this.buffer.map(v => v / 32768));
            this.buffer = [];
            if (this.playing) {
                this.playing = false;
                this.port.postMessage("drained");
            }
        }

        return true;
    }
}

registerProcessor("audio-playback-worklet", AudioPlaybackWorklet);
