/* Browser-only PCM recognition. No audio is sent to the application server. */
(function (root) {
  const clean = text => String(text || '').replace(/([\u3400-\u9fff])\s+(?=[\u3400-\u9fff])/g, '$1').trim();
  let modelPromise;
  async function loadModel() {
    if (!modelPromise) modelPromise = (async () => {
      const status = await (await fetch('/api/voice/status')).json();
      if (!status.ready) throw new Error('中文识别模型未安装，请在项目目录运行 npm run setup:voice');
      if (!root.Vosk) await new Promise((resolve, reject) => {
        const script = document.createElement('script'); script.src = '/vendor/vosk.js';
        script.onload = resolve; script.onerror = () => { script.remove(); reject(new Error('识别引擎加载失败，请刷新重试')); }; document.head.append(script);
      });
      return new Promise((resolve, reject) => {
        const model = new root.Vosk.Model(new URL('/voice-model/chinese.tar.gz?v=' + status.sha256, location.href).href, -1);
        const timer = setTimeout(() => { model.terminate(); reject(new Error('识别模型加载超时，请刷新重试')); }, 120000);
        model.on('load', result => { clearTimeout(timer); if (result.result) resolve(model); else { model.terminate(); reject(new Error('识别模型初始化失败')); } });
        model.on('error', () => { clearTimeout(timer); reject(new Error('本地识别引擎异常，请刷新重试')); });
      });
    })().catch(error => { modelPromise = null; throw error; });
    return modelPromise;
  }
  class SpeechEngine {
    constructor(callbacks = {}) { this.callbacks = callbacks; this.generation = 0; this.pending = 0; this.text = ''; this.holding = false; this.held = []; this.heldSamples = 0; this.muted = false; }
    async prepare() {
      const generation = ++this.generation;
      const model = await loadModel();
      if (generation !== this.generation) throw new Error('已取消语音准备');
      this.model = model; this.createRecognizer(generation); return generation;
    }
    createRecognizer(generation) {
      const recognizer = this.recognizer = new this.model.KaldiRecognizer(16000); this.pending = 0; this.text = '';
      this.recognizer.on('result', message => {
        if (generation !== this.generation || recognizer !== this.recognizer) return;
        this.pending = Math.max(0, this.pending - 1);
        const part = clean(message.result?.text);
        if (part) { this.text += (this.text ? '，' : '') + part; this.callbacks.text?.(this.text); }
        this.callbacks.partial?.('');
        if (this.finalResolve) { this.finalResolve(); this.finalResolve = null; }
      });
      this.recognizer.on('partialresult', message => {
        if (generation !== this.generation || recognizer !== this.recognizer) return;
        this.pending = Math.max(0, this.pending - 1); this.callbacks.partial?.(clean(message.result?.partial));
      });
      this.recognizer.on('error', () => { if (generation === this.generation && recognizer === this.recognizer) this.callbacks.error?.(new Error('语音识别失败，请停止后重试')); });
    }
    setMuted(value) { this.muted = value; }
    feed(data, rate) {
      if (!this.recognizer) return;
      let sum = 0; for (const value of data) sum += value * value;
      this.callbacks.level?.(Math.min(1, Math.sqrt(sum / data.length) * 5));
      if (this.muted) return;
      if (this.holding) {
        this.heldSamples += data.length;
        if (this.heldSamples > rate * 30) { this.callbacks.error?.(new Error('语音收尾超时，已停止录音，请重试')); return; }
        this.held.push({ data, rate }); return;
      }
      this.pending++; this.recognizer.acceptWaveformFloat(data, rate);
    }
    async start() {
      const generation = await this.prepare();
      if (!navigator.mediaDevices?.getUserMedia) throw new Error('当前浏览器无法录音，请使用 Chrome、Edge 或导入音频');
      const stream = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true }, video: false });
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
      const deadline = Date.now() + 20000;
      while (this.pending > 0 && generation === this.generation) {
        if (Date.now() > deadline) throw new Error('转写处理超时，已保留确认的文字；请分段录音');
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      if (generation !== this.generation || !this.recognizer) return;
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { this.finalResolve = null; reject(new Error('转写收尾超时，请检查已识别文字')); }, 10000);
        this.finalResolve = () => { clearTimeout(timer); resolve(); }; this.recognizer.retrieveFinalResult();
      });
    }
    async finishUtterance() {
      // Rotate only the recognizer. Keep the same MediaStream, AudioContext and capture node.
      const generation = this.generation;
      this.holding = true; this.held = []; this.heldSamples = 0;
      try {
        await this.drain(generation);
        if (generation !== this.generation) return;
        const answer = this.text;
        this.callbacks.boundary?.(answer);
        this.recognizer.remove(); this.createRecognizer(generation);
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
      } finally { if (generation === this.generation) this.cancel(); }
    }
    async importFile(file) {
      if (!file || file.size > 20 * 1024 * 1024) throw new Error('音频文件上限为20 MB');
      const generation = await this.prepare();
      const context = new (root.AudioContext || root.webkitAudioContext)({ sampleRate: 16000 }); this.context = context;
      try {
        const buffer = await context.decodeAudioData(await file.arrayBuffer());
        if (buffer.duration > 300) throw new Error('请导入5分钟以内的音频');
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
      } finally { if (generation === this.generation) this.cancel(); }
    }
    cancel() {
      this.generation++; this.holding = false; this.held = []; this.heldSamples = 0; this.muted = false; this.stream?.getTracks().forEach(track => track.stop()); this.stream = null;
      this.source?.disconnect(); this.node?.disconnect(); this.source = this.node = null;
      this.context?.close().catch(() => {}); this.context = null;
      this.recognizer?.remove(); this.recognizer = null; this.finalResolve?.(); this.finalResolve = null; this.callbacks.level?.(0);
    }
  }
  root.SpeechEngine = SpeechEngine;
  if (typeof module !== 'undefined') module.exports = { SpeechEngine, clean };
})(typeof window !== 'undefined' ? window : globalThis);
