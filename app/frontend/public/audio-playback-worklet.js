// Plays the agent's voice: PCM16 chunks posted by Player (components/audio/player.ts).
//
// Queued audio is kept as the chunks it arrived in plus a read position into the first
// one — never as one flat array. Azure streams speech faster than real time, so during a
// long reply (e.g. the report explanation) many seconds pile up here; re-copying that
// whole backlog on every 128-sample render tick made the audio thread miss its deadlines,
// and the agent's speech came out skipped and garbled ("sped up"). Now each tick only
// touches the samples it plays, however long the backlog is.
class AudioPlaybackWorklet extends AudioWorkletProcessor {
    constructor() {
        super();
        this.port.onmessage = this.handleMessage.bind(this);
        this.chunks = []; // Int16Array chunks, oldest first
        this.offset = 0; // read position inside chunks[0]
        this.queued = 0; // samples not yet played
        // True while queued agent audio is being played; flips back (and posts
        // "drained") once the queue has fully played out — see Player.onDrained.
        this.playing = false;
    }

    handleMessage(event) {
        if (event.data === null) {
            // Report how much queued audio was never played, so the caller can tell the
            // model exactly where its speech was cut off (conversation.item.truncate).
            this.port.postMessage({ type: "stopped", unplayed: this.queued });
            this.chunks = [];
            this.offset = 0;
            this.queued = 0;
            if (this.playing) {
                this.playing = false;
                this.port.postMessage("drained");
            }
            return;
        }
        const chunk = event.data;
        if (!chunk || chunk.length === 0) return;
        this.chunks.push(chunk);
        this.queued += chunk.length;
        this.playing = true;
    }

    process(inputs, outputs, parameters) {
        const channel = outputs[0][0];
        let written = 0;

        while (written < channel.length && this.chunks.length > 0) {
            const chunk = this.chunks[0];
            const n = Math.min(channel.length - written, chunk.length - this.offset);
            for (let k = 0; k < n; k++) channel[written + k] = chunk[this.offset + k] / 32768;
            written += n;
            this.offset += n;
            this.queued -= n;
            if (this.offset >= chunk.length) {
                this.chunks.shift();
                this.offset = 0;
            }
        }
        // Silence for whatever this tick couldn't fill.
        if (written < channel.length) channel.fill(0, written);

        if (this.queued === 0 && this.playing) {
            this.playing = false;
            this.port.postMessage("drained");
        }

        return true;
    }
}

registerProcessor("audio-playback-worklet", AudioPlaybackWorklet);
