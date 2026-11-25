const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const root = path.join(__dirname, '..');
const model = 'mlx-community/whisper-large-v3-turbo-q4';
const revision = '660c343bbf4e52ac257f0b7d952e5388e6f93bef';
const hashes = { 'config.json': '538e24557b8f9bc504700add5e7bbe32087c2353001ff563e64772ad4398671a', 'weights.npz': '862bbc832b05f3f4ec19dd632b701d61a6d3f5c7906360a10d72a79870642a80' };
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
async function main() {
  if (process.platform !== 'darwin' || process.arch !== 'arm64') throw new Error('此高精度引擎需要 Apple Silicon Mac；其他平台可使用浏览器离线识别');
  for (const args of [['venv', '.venv-asr', '--python', '3.12', '--allow-existing'], ['pip', 'sync', '--python', '.venv-asr/bin/python', 'scripts/requirements-asr.lock']]) {
    const result = spawnSync('uv', args, { cwd: root, stdio: 'inherit' });
    if (result.error || result.status !== 0) throw new Error('请先安装 uv 后重试（https://docs.astral.sh/uv/）');
  }
  const destination = path.join(root, 'voice-models/whisper-turbo-q4'); fs.mkdirSync(destination, { recursive: true });
  for (const [name, hash] of Object.entries(hashes)) {
    const target = path.join(destination, name);
    if (fs.existsSync(target) && sha(target) === hash) continue;
    console.log(`正在下载本机识别模型 ${name}（权重约464 MB）…`);
    const response = await fetch(`https://huggingface.co/${model}/resolve/${revision}/${name}`, { signal: AbortSignal.timeout(600000) });
    if (!response.ok) throw new Error(`下载失败：HTTP ${response.status}`);
    await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(target + '.tmp'));
    if (sha(target + '.tmp') !== hash) { fs.unlinkSync(target + '.tmp'); throw new Error('模型 SHA-256 校验失败，请重试'); }
    fs.renameSync(target + '.tmp', target);
  }
  console.log('高精度本机语音识别已安装，请重启 npm start。录音仅在本机内存中处理。');
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
