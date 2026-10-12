class SmashPcmPlayer extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = [];
    this.offset = 0;
    this.queuedFrames = 0;
    this.port.onmessage = ({ data }) => {
      if (!(data instanceof Float32Array) || data.length % 2) return;
      const maxFrames = sampleRate * 0.25;
      if (this.queuedFrames + data.length / 2 > maxFrames) {
        while (this.queue.length && this.queuedFrames + data.length / 2 > maxFrames) {
          const dropped = this.queue.shift();
          this.queuedFrames -= dropped.length / 2;
        }
      }
      this.queue.push(data);
      this.queuedFrames += data.length / 2;
    };
  }

  process(_inputs, outputs) {
    const [left, right] = outputs[0];
    left.fill(0);
    right.fill(0);
    let written = 0;
    while (written < left.length && this.queue.length) {
      const packet = this.queue[0];
      const frames = Math.min(left.length - written, packet.length / 2 - this.offset);
      for (let i = 0; i < frames; i++) {
        left[written + i] = packet[(this.offset + i) * 2];
        right[written + i] = packet[(this.offset + i) * 2 + 1];
      }
      this.offset += frames;
      this.queuedFrames -= frames;
      written += frames;
      if (this.offset === packet.length / 2) {
        this.queue.shift();
        this.offset = 0;
      }
    }
    return true;
  }
}

registerProcessor("smash-pcm-player", SmashPcmPlayer);
