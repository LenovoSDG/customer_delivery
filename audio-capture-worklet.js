class VoiceCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.samples = new Float32Array(2048);
    this.position = 0;
    this.recording = true;
    this.port.onmessage = event => {
      if (event.data?.type === 'flush') {
        this.recording = false;
        this.send();
        this.port.postMessage({ type: 'flushed' });
      }
    };
  }
  send() {
    if (!this.position) return;
    const data = this.samples.slice(0, this.position);
    this.port.postMessage({ type: 'pcm', data }, [data.buffer]);
    this.position = 0;
  }
  process(inputs, outputs) {
    for (const channel of outputs[0] || []) channel.fill(0);
    if (!this.recording) return true;
    const channels = inputs[0];
    if (!channels?.length) return true;
    for (let i = 0; i < channels[0].length; i++) {
      let sample = 0;
      for (const channel of channels) sample += channel[i] || 0;
      this.samples[this.position++] = sample / channels.length;
      if (this.position === this.samples.length) this.send();
    }
    return true;
  }
}
registerProcessor('voice-capture', VoiceCapture);
