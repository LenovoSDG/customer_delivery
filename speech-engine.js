/* PCM stays on this machine: browser preview plus optional loopback Whisper recognition. */
(function (root) {
  const clean = text => String(text || '').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
  class SpeechEngine {
    constructor(callbacks = {}) { this.callbacks = callbacks; this.generation = 0; this.pending = 0; this.text = ''; this.holding = false; this.held = []; this.heldSamples = 0; this.muted = false; this.audio = []; this.audioSamples = 0; this.audioRate = 16000; this.limitNotified = false; }
    async prepare() {
      const generation = ++this.generation;
      this.resetTurn();return generation;
    }
    resetTurn(){this.audio=[];this.audioSamples=0;this.text='';this.startedSpeaking=false;this.limitNotified=false;}
    setMuted(value) { this.muted = value; }
    feed(data, rate) {
      
      let sum = 0; for (const value of data) sum += value * value;
      this.callbacks.level?.(Math.min(1, Math.sqrt(sum / data.length) * 5));
      if (this.muted) return;
      if (this.holding) {
        this.heldSamples += data.length;
        if (this.heldSamples > rate * 30) { this.callbacks.error?.(new Error('语音收尾超时，已停止录音，请重试')); return; }
        this.held.push({ data, rate }); return;
      }
      const speaking=Math.sqrt(sum/data.length)>0.018;
      this.audio.push(data.slice());this.audioSamples+=data.length;this.audioRate=rate;
      if(speaking&&!this.startedSpeaking){this.startedSpeaking=true;this.callbacks.partial?.('正在听…');}
      if(!this.startedSpeaking && this.audioSamples>rate){this.audioSamples-=this.audio.shift().length;}
      if(this.audioSamples>=rate*25&&!this.limitNotified){this.limitNotified=true;this.callbacks.limit?.();}
    }
    async start() {
      const generation = await this.prepare();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法录音，请使用 Chrome、Edge 或导入音频');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true }, video: false });
      if (generation !== this.generation) { stream.getTracks().forEach(track => track.stop()); return false; }
      this.stream = stream;
      stream.getAudioTracks().forEach(track => track.addEventListener('ended', () => { if (generation === this.generation) this.callbacks.error?.(new Error('麦克风已断开，已保留识别文字，请重新连接后重试')); }));
      this.context = new (root.AudioContext || root.webkitAudioContext)({ sampleRate: 16000 });
      await this.context.resume();
      if (generation !== this.generation) return false;
      this.source = this.context.createMediaStreamSource(stream);
      if (this.context.audioWorklet && root.AudioWorkletNode) {
        await this.context.audioWorklet.addModule('/audio-capture-worklet.js');
        if (generation !== this.generation) return false;
        this.node = new AudioWorkletNode(this.context, 'voice-capture');
        this.node.port.onmessage = event => {
          if (generation !== this.generation) return;
          if (event.data.type === 'pcm') this.feed(event.data.data, this.context.sampleRate);
          if (event.data.type === 'flushed') this.flushResolve?.();
        };
      } else {
        this.node = this.context.createScriptProcessor(4096, 1, 1);
        this.node.onaudioprocess = event => { if (generation === this.generation) this.feed(new Float32Array(event.inputBuffer.getChannelData(0)), this.context.sampleRate); };
      }
      this.source.connect(this.node); this.node.connect(this.context.destination); return true;
    }
    async drain(generation) {
      if(this.node?.port)await new Promise(resolve=>{const timer=setTimeout(resolve,400);this.flushResolve=()=>{clearTimeout(timer);resolve()};this.node.port.postMessage({type:'flush'})});
    }
    async refine(generation) {
      if(!this.audioSamples)return '';
      const pcm=new Float32Array(this.audioSamples);let offset=0;
      for(const chunk of this.audio){pcm.set(chunk,offset);offset+=chunk.length}
      const wav=encodeSpeech(pcm);
      this.callbacks.refining?.(); const controller = this.refineController = new AbortController();
      const timer = setTimeout(() => controller.abort(), 180000);
      try {
        const response = await fetch('/api/transcribe', { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({wav}), signal: controller.signal });
        const result = await response.json();
        if (generation !== this.generation) return;
        if (!response.ok) throw new Error(result.error || '本机高精度语音识别失败，请重试');
        this.text = clean(result.text); this.callbacks.text?.(this.text); this.callbacks.partial?.('');
        return this.text;
      } finally { clearTimeout(timer); if (this.refineController === controller) this.refineController = null; }
    }
    async finishUtterance() {
      // Rotate only the recognizer. Keep the same MediaStream, AudioContext and capture node.
      const generation = this.generation;
      this.holding = true; this.held = []; this.heldSamples = 0;
      try {
        await this.drain(generation);
        if (generation !== this.generation) return;
        await this.refine(generation);
        if (generation !== this.generation) return;
        const answer = this.text;
        this.callbacks.boundary?.(answer);
        this.resetTurn();
        const buffered = this.held; this.held = []; this.heldSamples = 0; this.holding = false;
        for (const chunk of buffered) this.feed(chunk.data, chunk.rate);
        return answer;
      } finally { if (generation === this.generation) this.holding = false; }
    }
    async stop() {
      const generation = this.generation;
      this.stream?.getTracks().forEach(track => track.stop());
      try {
        if (this.node?.port) await new Promise(resolve => {
          const timer = setTimeout(resolve, 1000); this.flushResolve = () => { clearTimeout(timer); resolve(); }; this.node.port.postMessage({ type: 'flush' });
        });
        this.source?.disconnect(); this.node?.disconnect();
        await this.drain(generation);
        if (generation === this.generation) await this.refine(generation);
      } finally { if (generation === this.generation) this.cancel(); }
    }
    async importFile(file) {
      if (!file || file.size > 20 * 1024 * 1024) throw new Error('音频文件上限为20 MB');
      const generation = await this.prepare();
      const context = new (root.AudioContext || root.webkitAudioContext)({ sampleRate: 16000 }); this.context = context;
      try {
        const buffer = await context.decodeAudioData(await file.arrayBuffer());
        if (buffer.duration > (120)) throw new Error('请导入2分钟以内的音频');
        const mono = new Float32Array(buffer.length);
        for (let c = 0; c < buffer.numberOfChannels; c++) { const channel = buffer.getChannelData(c); for (let i = 0; i < mono.length; i++) mono[i] += channel[i] / buffer.numberOfChannels; }
        for (let i = 0; i < mono.length && generation === this.generation; i += 8192) {
          this.feed(mono.slice(i, i + 8192), buffer.sampleRate);
          const deadline = Date.now() + 20000;
          while (this.pending > 4 && generation === this.generation) {
            if (Date.now() > deadline) throw new Error('音频识别超时，请分段导入或刷新重试');
            await new Promise(resolve => setTimeout(resolve, 25));
          }
        }
        await this.drain(generation);
        if (generation === this.generation) await this.refine(generation);
      } finally { if (generation === this.generation) this.cancel(); }
    }
    cancel() {
      this.generation++; this.refineController?.abort(); this.refineController = null; this.audio = []; this.audioSamples = 0; this.holding = false; this.held = []; this.heldSamples = 0; this.muted = false; this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      this.source?.disconnect(); this.node?.disconnect(); this.source = this.node = null;
      this.context?.close().catch(() => {}); this.context = null;
      this.recognizer?.remove(); this.recognizer = null; this.finalResolve?.(); this.finalResolve = null; this.callbacks.level?.(0);
    }
  }
  root.SpeechEngine = SpeechEngine;
  if (typeof module !== 'undefined') module.exports = { SpeechEngine, clean };
})(typeof window !== 'undefined' ? window : globalThis);
