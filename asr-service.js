const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const readline = require('node:readline');

function validateAudio(input) {
  const sampleRate = Number(input.sampleRate);
  if (!Number.isInteger(sampleRate) || sampleRate < 8000 || sampleRate > 48000) throw new Error('语音采样率无效');
  if (typeof input.pcm !== 'string' || !input.pcm || input.pcm.length > 12 * 1024 * 1024 || !/^[A-Za-z0-9+/]*={0,2}$/.test(input.pcm)) throw new Error('语音数据无效或过大');
  const audio = Buffer.from(input.pcm, 'base64');
  if (audio.length % 2 || audio.length < 2 || audio.length > sampleRate * 2 * 120) throw new Error('请将单次发言控制在2分钟以内');
  return { pcm: input.pcm, sampleRate, terms: String(input.terms || '').slice(0, 240) };
}
function createASRService(root, spawnImpl = spawn) {
  const python = path.join(root, '.venv-asr/bin/python');
  const model = path.join(root, 'voice-models/whisper-turbo-q4');
  let child, ready = false, starting, nextId = 1;
  const jobs = new Map();
  const available = () => process.platform === 'darwin' && process.arch === 'arm64' && fs.existsSync(python) && fs.existsSync(path.join(model, 'weights.npz'));
  const status = () => ({ available: available(), ready, engine: 'Whisper large-v3-turbo Q4 · Apple GPU' });
  function close() { child?.kill(); child = null; ready = false; }
  function start() {
    if (ready) return Promise.resolve();
    if (starting) return starting;
    if (!available()) return Promise.reject(new Error('请运行 npm run setup:voice-hq 安装本机高精度语音识别'));
    starting = new Promise((resolve, reject) => {
      child = spawnImpl(python, ['-u', path.join(root, 'scripts/asr-worker.py'), model], {
        stdio: ['pipe', 'pipe', 'ignore'], env: { ...process.env, HF_HUB_OFFLINE: '1', TOKENIZERS_PARALLELISM: 'false' }
      });
      const timer = setTimeout(() => { close(); reject(new Error('本机语音模型加载超时，请重启服务')); }, 60000);
      const lines = readline.createInterface({ input: child.stdout });
      lines.on('line', line => {
        let value; try { value = JSON.parse(line); } catch { return; }
        if (value.event === 'ready') { ready = true; clearTimeout(timer); resolve(); return; }
        const job = jobs.get(value.id); if (!job) return;
        jobs.delete(value.id); job.cleanup();
        if (value.error) job.reject(new Error(value.error)); else job.resolve({ text: String(value.text || ''), elapsedMs: value.elapsedMs, engine: 'Whisper large-v3-turbo Q4' });
      });
      const fail = () => {
        ready = false; clearTimeout(timer); lines.close(); child = null;
        const error = new Error('本机语音服务未就绪，请运行 npm run setup:voice-hq 后重启');
        reject(error); for (const job of jobs.values()) { job.cleanup(); job.reject(error); } jobs.clear(); starting = null;
      };
      child.once('error', fail); child.once('exit', fail);
      child.stdin.on('error', () => {});
    });
    return starting;
  }
  async function transcribe(input, { signal } = {}) {
    const audio = validateAudio(input);
    if (signal?.aborted) throw new Error('语音识别已取消');
    await start();
    if (signal?.aborted) throw new Error('语音识别已取消');
    if (jobs.size >= 4) throw new Error('本机语音识别忙，请稍后重试');
    return new Promise((resolve, reject) => {
      const id = nextId++;
      const cancel = () => { jobs.delete(id); cleanup(); reject(new Error('语音识别已取消')); };
      const timer = setTimeout(() => { jobs.delete(id); cleanup(); reject(new Error('本机语音识别超时，请缩短发言后重试')); }, 45000);
      const cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', cancel); };
      jobs.set(id, { resolve, reject, cleanup }); signal?.addEventListener('abort', cancel, { once: true });
      child.stdin.write(JSON.stringify({ id, ...audio }) + '\n', error => { if (error && jobs.has(id)) cancel(); });
    });
  }
  return { status, start, transcribe, close };
}
module.exports = { createASRService, validateAudio };
