const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { pipeline } = require('node:stream/promises');
const { Readable } = require('node:stream');
const { unzipSync } = require('fflate');
const tar = require('tar');

const URL = 'https://alphacephei.com/vosk/models/vosk-model-small-cn-0.22.zip';
const ZIP_SHA256 = '3af8b0e7e0f835ae9d414ce5df580237a3cfb08d586c9fbbb0f7ff29ad5b14ba';
const root = path.join(__dirname, '..', 'voice-models');
const sha = bytes => crypto.createHash('sha256').update(bytes).digest('hex');

async function main() {
  fs.mkdirSync(root, { recursive: true });
  const archiveArgument = process.argv.find(a => a.startsWith('--archive='));
  const archive = archiveArgument ? path.resolve(archiveArgument.slice('--archive='.length)) : path.join(root, 'download.zip');
  const staging = path.join(root, `.setup-${process.pid}`);
  try {
    if (!fs.existsSync(archive)) {
      console.log('正在从 Vosk 官方站点下载中文离线模型（约42MB）…');
      const response = await fetch(URL, { signal: AbortSignal.timeout(300000) });
      if (!response.ok) throw new Error(`模型下载失败：HTTP ${response.status}`);
      await pipeline(Readable.fromWeb(response.body), fs.createWriteStream(archive));
    }
    const bytes = fs.readFileSync(archive);
    if (sha(bytes) !== ZIP_SHA256) throw new Error('模型 SHA-256 校验失败，请删除下载文件后重试');
    const entries = unzipSync(bytes);
    const prefix = 'vosk-model-small-cn-0.22/';
    for (const [name, data] of Object.entries(entries)) {
      if (!name.startsWith(prefix) || name.endsWith('/')) continue;
      const relative = name.slice(prefix.length);
      if (relative.split('/').includes('..') || relative.includes('\\')) throw new Error('模型压缩包路径无效');
      const dest = path.join(staging, 'model', relative);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, data);
    }
    for (const required of ['am/final.mdl', 'conf/model.conf', 'conf/mfcc.conf', 'graph/HCLr.fst', 'graph/Gr.fst']) {
      if (!fs.existsSync(path.join(staging, 'model', required))) throw new Error(`模型缺少必要文件：${required}`);
    }
    const output = path.join(root, 'chinese.tar.gz');
    await tar.c({ cwd: staging, file: output + '.tmp', gzip: true, portable: true, mtime: new Date(0) }, ['model']);
    fs.renameSync(output + '.tmp', output);
    fs.writeFileSync(path.join(root, 'manifest.json'), JSON.stringify({ name: 'Vosk 中文 small-cn-0.22', source: URL,
      license: 'Apache-2.0', sha256: sha(fs.readFileSync(output)), bytes: fs.statSync(output).size }, null, 2) + '\n');
    console.log('浏览器离线预览模型已准备好。高精度识别可继续运行 npm run setup:voice-hq；音频不发送到模型网关。');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
    if (!archiveArgument && fs.existsSync(archive)) fs.unlinkSync(archive);
  }
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
