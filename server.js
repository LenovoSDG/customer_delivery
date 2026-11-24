const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
const { PDFParse } = require('pdf-parse');
const { reviewProject } = require('./review');
const { coachTurn } = require('./rehearsal');
const { createModelGateway } = require('./model-gateway');

const PORT = Number(process.env.PORT || 4174);
const ROOT = __dirname;
const gateway = createModelGateway({ configFile: path.join(ROOT, '.env.local') });
const MAX_BODY = 12 * 1024 * 1024;
const CAPTURE_DIR = path.join(ROOT, 'captures');
const capture = { active: false, timer: null, busy: false, hwnd: '', title: '', group: '', model: '', intervalSec: 15, startedAt: '', lastCheck: '', lastError: '', saved: 0, events: [], nextEventId: 1, lastSignature: '' };
fs.mkdirSync(CAPTURE_DIR, { recursive: true });

function json(res, status, value) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(value));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', chunk => {
      body += chunk;
      if (body.length > MAX_BODY) {
        reject(new Error('请求内容太大（上限 12 MB）'));
        req.destroy();
      }
    });
    req.on('end', () => {
      try { resolve(JSON.parse(body || '{}')); } catch { reject(new Error('请求 JSON 格式无效')); }
    });
    req.on('error', reject);
  });
}

function runPowerShell(script, timeout = 12000) {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('Windows 截图命令超时')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr.trim() || `PowerShell 退出码 ${code}`)); else resolve(stdout.trim()); });
  });
}

async function listWechatWindows() {
  const script = `$ErrorActionPreference='Stop'; Get-Process | Where-Object { $_.ProcessName -match 'WeChat|Weixin' -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ hwnd=$_.MainWindowHandle.ToInt64().ToString(); title=$_.MainWindowTitle; process=$_.ProcessName } } | ConvertTo-Json -Compress`;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed]).filter(x => x.hwnd && /^\d+$/.test(String(x.hwnd))).map(x => ({ hwnd: String(x.hwnd), title: String(x.title || '微信窗口'), process: String(x.process || 'WeChat') }));
}

function captureWindow(hwnd, destination) {
  if (!/^\d+$/.test(String(hwnd))) return Promise.reject(new Error('微信窗口句柄无效'));
  const safePath = destination.replace(/'/g, "''");
  const script = `Add-Type -AssemblyName System.Drawing; Add-Type @'
using System; using System.Runtime.InteropServices;
public static class WinCapture {
 [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left; public int Top; public int Right; public int Bottom; }
 [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
 [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
 [DllImport("user32.dll")] public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
}
'@; $h=[IntPtr]::new([long]${hwnd}); if(-not [WinCapture]::IsWindowVisible($h)){throw '微信窗口当前不可见'}; $r=New-Object WinCapture+RECT; if(-not [WinCapture]::GetWindowRect($h,[ref]$r)){throw '无法读取微信窗口区域'}; $w=$r.Right-$r.Left; $hh=$r.Bottom-$r.Top; if($w -lt 200 -or $hh -lt 150){throw '微信窗口尺寸过小或已最小化'}; $bmp=New-Object System.Drawing.Bitmap($w,$hh); $g=[System.Drawing.Graphics]::FromImage($bmp); $hdc=$g.GetHdc(); try{$ok=[WinCapture]::PrintWindow($h,$hdc,2); if(-not $ok){[void][WinCapture]::PrintWindow($h,$hdc,0)}}finally{$g.ReleaseHdc($hdc);$g.Dispose()}; $bmp.Save('${safePath}',[System.Drawing.Imaging.ImageFormat]::Png); $bmp.Dispose(); Write-Output "$w,$hh"`;
  return runPowerShell(script, 20000);
}

async function recognizeGroupScreenshot(filePath, model, group) {
  const data = fs.readFileSync(filePath).toString('base64');
  const response = await fetch('http://127.0.0.1:11434/api/generate', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, images: [data], prompt: `这是微信聊天窗口截图。请判断当前聊天标题/群名是否对应目标群“${group}”。只输出严格 JSON，不要 markdown：{"group_match":true或false,"group_name":"识别到的标题","messages":[{"time":"可见时间或未知","speaker":"发言人或未知","text":"可见消息原文"}]}。只有明确看见目标群标题且匹配时 group_match 才能为 true。不要推测遮挡文字；不匹配或看不清标题时 messages 返回空数组。` }),
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`视觉模型返回 HTTP ${response.status}`);
  const result = await response.json();
  const raw = String(result.response || '').trim();
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error('模型没有返回有效的群聊识别结果');
  return JSON.parse(jsonText);
}

async function captureTick() {
  if (!capture.active || capture.busy) return;
  capture.busy = true;
  capture.lastCheck = new Date().toISOString();
  const tempFile = path.join(CAPTURE_DIR, `.pending-${Date.now()}.png`);
  try {
    const windows = await listWechatWindows();
    const target = windows.find(w => w.hwnd === capture.hwnd);
    if (!target) throw new Error('所选微信窗口已关闭；监测已暂停，请重新选择窗口');
    await captureWindow(capture.hwnd, tempFile);
    const recognized = await recognizeGroupScreenshot(tempFile, capture.model, capture.group);
    if (!recognized.group_match) {
      capture.lastError = `未确认目标群“${capture.group}”，本次截图未保存`;
      return;
    }
    const messages = Array.isArray(recognized.messages) ? recognized.messages.filter(m => m && m.text).map(m => ({ time: String(m.time || '未知'), speaker: String(m.speaker || '未知'), text: String(m.text) })) : [];
    const signature = JSON.stringify(messages);
    if (!messages.length || signature === capture.lastSignature) {
      capture.lastError = messages.length ? '群聊已匹配，内容没有变化；未重复保存' : '群聊已匹配，但画面中没有可识别的新消息';
      return;
    }
    capture.lastSignature = signature;
    const file = `wechat-${Date.now()}.png`;
    const dest = path.join(CAPTURE_DIR, file);
    fs.renameSync(tempFile, dest);
    capture.saved += 1;
    capture.lastError = '';
    capture.events.push({ id: capture.nextEventId++, at: new Date().toISOString(), file, url: `/captures/${file}`, group: String(recognized.group_name || capture.group), messages });
    if (capture.events.length > 100) capture.events.shift();
  } catch (error) {
    capture.lastError = error.message;
    if (/所选微信窗口已关闭/.test(error.message)) stopCapture();
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    capture.busy = false;
  }
}

function startCapture(config) {
  stopCapture();
  capture.active = true;
  capture.hwnd = String(config.hwnd);
  capture.title = String(config.title || '微信窗口');
  capture.group = String(config.group).trim();
  capture.model = String(config.model);
  capture.intervalSec = Math.max(10, Math.min(120, Number(config.intervalSec) || 15));
  capture.startedAt = new Date().toISOString();
  capture.lastCheck = '';
  capture.lastError = '';
  capture.saved = 0;
  capture.events = [];
  capture.nextEventId = 1;
  capture.lastSignature = '';
  capture.timer = setInterval(captureTick, capture.intervalSec * 1000);
  captureTick();
}

function stopCapture() {
  if (capture.timer) clearInterval(capture.timer);
  capture.timer = null;
  capture.active = false;
}

function parseLines(text, source) {
  return text.split(/\r?\n/).map((line, index) => {
    const clean = line.trim();
    if (!clean) return null;
    const matched = clean.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s*[|｜,，\t]\s*([^|｜,，\t]+)\s*[|｜,，\t]\s*(.*)$/);
    return { date: matched?.[1] || `第 ${index + 1} 行`, speaker: matched?.[2]?.trim() || source, text: matched?.[3]?.trim() || clean, source, line: index + 1 };
  }).filter(Boolean);
}

const requirementHints = ['需要', '要求', '必须', '希望', '支持', '提供', '交付', '完成', '上线', '验收', '修改', '增加', '删除', '优化', '截至', '时间', '数据', '格式', '客户'];
function extractRequirements(messages) {
  return messages.filter(m => requirementHints.some(word => m.text.includes(word))).map((m, i) => ({
    id: `R-${String(i + 1).padStart(2, '0')}`, title: m.text.slice(0, 96), detail: m.text,
    source: m.source, date: m.date, speaker: m.speaker, status: '待确认', evidence: `${m.source} · ${m.date} · ${m.speaker}`
  }));
}

async function askOllama(model, system, content, schema, signal) {
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false, format: schema,
      options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1200 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: content + '\n输出JSON schema：' + JSON.stringify(schema) }] }),
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90000)]) : AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`);
  const result = await response.json();
  if (result.done_reason === 'length') throw new Error('本条模型输出被截断，请重试或拆分需求');
  if (!result.message?.content) throw new Error('本地模型未返回检查意见');
  return result.message.content;
}

const server = http.createServer(async (req, res) => {
  const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (!origins.includes(`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin))) {
    return json(res, 403, { error: '仅允许从本机项目页面访问' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/api/voice/status' && req.method === 'GET') {
    try { const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'voice-models/manifest.json'))); return json(res, 200, { ...manifest, ready: fs.existsSync(path.join(ROOT, 'voice-models/chinese.tar.gz')) }); }
    catch { return json(res, 200, { ready: false }); }
  }
  if (url.pathname === '/voice-model/chinese.tar.gz' && req.method === 'GET') {
    const archive = path.join(ROOT, 'voice-models/chinese.tar.gz');
    if (!fs.existsSync(archive)) return json(res, 404, { error: '请运行 npm run setup:voice' });
    res.writeHead(200, { 'content-type': 'application/gzip', 'content-length': fs.statSync(archive).size, 'cache-control': 'no-cache' });
    const stream = fs.createReadStream(archive); stream.on('error', () => res.destroy()); res.on('close', () => stream.destroy()); return stream.pipe(res);
  }
  if (url.pathname === '/api/rehearsal' && req.method === 'POST') {
    const controller = new AbortController();
    const cancel = () => { if (!res.writableEnded) controller.abort(); }; res.once('close', cancel);
    try {
      const input = await readBody(req);
      if (!['ollama', 'bohrium'].includes(input.provider)) throw new Error('请选择本地模型或 API 模型');
      const model = String(input.model || '').trim();
      if (!model || model === 'rules') throw new Error('汇报教练需要语言模型，请在模型设置中选择本地或 API 模型');
      if (input.provider === 'bohrium' && !gateway.publicConfig().keyConfigured) throw new Error('请先配置 API 密钥');
      if (res.destroyed) controller.abort();
      const result = await coachTurn(input, (system, content, schema) => input.provider === 'bohrium'
        ? gateway.ask(model, system, content, schema, { signal: controller.signal })
        : askOllama(model, system, content, schema, controller.signal));
      if (!res.destroyed) json(res, 200, { ...result, provider: input.provider, model });
    } catch (error) { if (!res.destroyed) json(res, 400, { error: error.message }); }
    finally { res.off('close', cancel); }
    return;
  }
  if (url.pathname === '/api/model-config' && req.method === 'GET') return json(res, 200, gateway.publicConfig());
  if (url.pathname === '/api/model-config' && req.method === 'POST') {
    try { return json(res, 200, gateway.saveConfig(await readBody(req))); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/api-models' && req.method === 'POST') {
    try { const { apiKey } = await readBody(req); return json(res, 200, await gateway.listModels(apiKey)); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname === '/api/health') {
    try {
      const response = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(1500) });
      const data = await response.json();
      return json(res, 200, { ollama: true, models: (data.models || []).map(m => m.name) });
    } catch { return json(res, 200, { ollama: false, models: [] }); }
  }
  if (url.pathname === '/api/wechat/windows' && req.method === 'GET') {
    try { return json(res, 200, { windows: await listWechatWindows() }); }
    catch (error) { return json(res, 200, { windows: [], error: `读取微信窗口失败：${error.message}` }); }
  }
  if (url.pathname === '/api/wechat/capture/status' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return json(res, 200, { active: capture.active, title: capture.title, group: capture.group, intervalSec: capture.intervalSec, startedAt: capture.startedAt, lastCheck: capture.lastCheck, lastError: capture.lastError, saved: capture.saved, events: capture.events.filter(event => event.id > after) });
  }
  if (url.pathname === '/api/wechat/capture/start' && req.method === 'POST') {
    try {
      const config = await readBody(req);
      if (!/^\d+$/.test(String(config.hwnd || ''))) return json(res, 400, { error: '请先选择微信窗口' });
      const group = String(config.group || '').trim();
      if (group.length < 2 || group.length > 120) return json(res, 400, { error: '请填写准确的微信群聊名称' });
      const windows = await listWechatWindows();
      const target = windows.find(window => window.hwnd === String(config.hwnd));
      if (!target) return json(res, 404, { error: '所选微信窗口已关闭，请刷新窗口列表' });
      const tags = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
      if (!tags.ok) return json(res, 503, { error: '无法连接本机 Ollama' });
      const data = await tags.json();
      const models = (data.models || []).map(item => item.name);
      const visionModels = models.filter(name => /vl|vision|llava|minicpm-v|moondream/i.test(name));
      if (!visionModels.includes(config.model)) return json(res, 400, { error: '请选择已安装的本地视觉模型，例如 qwen3-vl；普通文本模型不能识别截图' });
      startCapture({ ...config, title: target.title || '微信窗口', group });
      return json(res, 200, { active: true, title: capture.title, group: capture.group, intervalSec: capture.intervalSec });
    } catch (error) { return json(res, 400, { error: `启动微信监测失败：${error.message}` }); }
  }
  if (url.pathname === '/api/wechat/capture/stop' && req.method === 'POST') {
    stopCapture();
    return json(res, 200, { active: false });
  }
  if (url.pathname.startsWith('/captures/')) {
    const name = path.basename(url.pathname);
    if (!/^wechat-\d+\.png$/.test(name)) return json(res, 404, { error: '截图不存在' });
    const filePath = path.join(CAPTURE_DIR, name);
    return fs.readFile(filePath, (error, data) => {
      if (error) return json(res, 404, { error: '截图不存在' });
      res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'no-store' });
      res.end(data);
    });
  }
  if (url.pathname === '/api/parse-file' && req.method === 'POST') {
    try {
      const { name, data } = await readBody(req);
      if (!name || !data) return json(res, 400, { error: '缺少文件内容' });
      const buffer = Buffer.from(data, 'base64');
      if (buffer.length > 8 * 1024 * 1024) return json(res, 413, { error: '聊天文件上限为 8 MB' });
      const ext = path.extname(name).toLowerCase();
      let text = '';
      if (ext === '.docx') {
        const result = await mammoth.extractRawText({ buffer });
        text = result.value;
      } else if (ext === '.pdf') {
        const parser = new PDFParse({ data: buffer });
        try { text = (await parser.getText()).text; } finally { await parser.destroy(); }
      } else if (ext === '.xlsx') {
        const workbook = new ExcelJS.Workbook();
        await workbook.xlsx.load(buffer);
        text = workbook.worksheets.map(sheet => {
          const rows = [];
          sheet.eachRow({ includeEmpty: false }, row => rows.push(row.values.slice(1).map(value => {
            if (value && typeof value === 'object' && 'text' in value) return value.text;
            if (value && typeof value === 'object' && 'result' in value) return value.result;
            return value == null ? '' : String(value);
          }).join(',')));
          return `【工作表：${sheet.name}】\n${rows.join('\n')}`;
        }).join('\n\n');
      } else if (['.txt', '.md', '.csv', '.json'].includes(ext)) {
        text = buffer.toString('utf8');
      } else return json(res, 415, { error: '暂不支持该聊天文件格式' });
      const clean = text.replace(/\u0000/g, '').trim();
      return json(res, 200, { text: clean, empty: !clean, warning: !clean && ext === '.pdf' ? 'PDF 中没有可提取文字，可能是扫描件；当前 Demo 尚未接入 OCR。' : undefined });
    } catch (error) { return json(res, 422, { error: `文件解析失败：${error.message}` }); }
  }
  if (url.pathname === '/api/recognize-image' && req.method === 'POST') {
    try {
      const { model, data, source } = await readBody(req);
      if (!model || !data) return json(res, 400, { error: '请选择本机视觉模型并添加截图' });
      const result = await fetch('http://127.0.0.1:11434/api/generate', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          model, stream: false, images: [data],
          prompt: `你是本地聊天截图 OCR 助手。请只识别截图中可见的聊天消息，按时间顺序逐行输出，格式为“时间 | 发言人 | 消息原文”。来源备注：${source || '用户手动截图'}。不要推测被遮挡或看不清的内容，不要提取无关系统通知。无法确认时间或发言人时写“未知”。只输出识别结果，不要总结。`
        }), signal: AbortSignal.timeout(120000)
      });
      if (!result.ok) throw new Error(`Ollama 返回 HTTP ${result.status}`);
      const payload = await result.json();
      return json(res, 200, { text: payload.response || '', model });
    } catch (error) {
      return json(res, 422, { error: `截图识别失败：${error.message}。请确认已安装支持图片的视觉模型（如 qwen3-vl），并在页面选择该模型。` });
    }
  }
  if (url.pathname === '/api/review' && req.method === 'POST') {
    try {
      const input = await readBody(req);
      const { model, requirements, documents, rules } = input;
      const provider = input.provider || 'ollama';
      if (!['ollama', 'bohrium'].includes(provider)) return json(res, 400, { error: '未知的模型来源' });
      if (provider === 'bohrium') {
        const config = gateway.publicConfig();
        if (!config.keyConfigured) return json(res, 400, { error: '请先在模型设置中配置玻尔 API 密钥' });
        const selected = String(model || config.apiModel).trim();
        if (!selected) return json(res, 400, { error: '请先选择 API 模型' });
        const controller = new AbortController();
        const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancelOnDisconnect);
        if (res.destroyed) controller.abort();
        try {
          const result = await reviewProject(input, (system, content, schema) => gateway.ask(selected, system, content, schema, { signal: controller.signal }));
          if (!res.destroyed) return json(res, 200, { ...result, mode: result.report.summary.reviewed ? 'api' : 'unavailable', provider, model: selected });
          return;
        } finally { res.off('close', cancelOnDisconnect); }
      }
      if (model && model !== 'rules') {
        const result = await reviewProject(input, (system, content, schema) => askOllama(model, system, content, schema));
        return json(res, 200, { ...result, provider: 'ollama', model });
      }
      return json(res, 200, { mode: 'rules', items: ruleReview(requirements || [], documents || [], rules || '') });
    } catch (error) { return json(res, 400, { error: error.message }); }
  }
  const vendors = { '/vendor/vosk.js': 'node_modules/vosk-browser/dist/vosk.js', '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js', '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js' };
  const assets = new Set(['/', '/index.html', '/app.js', '/style.css', '/report.css', '/report-ui.js', '/model-settings.js', '/model-settings.css', '/speech-engine.js', '/rehearsal-ui.js', '/rehearsal.css', '/audio-capture-worklet.js', ...Object.keys(vendors)]);
  if (!assets.has(url.pathname)) return json(res, 404, { error: '未找到页面' });
  const file = url.pathname === '/' ? 'index.html' : path.basename(url.pathname);
  const filePath = path.join(ROOT, vendors[url.pathname] || file);
  if (!filePath.startsWith(ROOT)) return json(res, 403, { error: '禁止访问' });
  fs.readFile(filePath, (error, data) => {
    if (error) return json(res, 404, { error: '未找到页面' });
    const type = file.endsWith('.css') ? 'text/css; charset=utf-8' : file.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'text/html; charset=utf-8';
    res.writeHead(200, { 'content-type': type, 'cache-control': 'no-store' });
    res.end(data);
  });
});

function ruleReview(requirements, documents, rules) {
  const corpus = documents.map(d => d.text).join('\n').toLowerCase();
  const checks = requirements.map(r => {
    const keywords = [...new Set(r.detail.replace(/[，。；：、,.!?\s]+/g, ' ').split(' ').filter(w => w.length >= 2))];
    const hit = keywords.filter(w => corpus.includes(w.toLowerCase()));
    return { title: r.title, requirement: r.id, status: hit.length ? '找到相关内容，建议人工核对' : '可能缺失', evidence: hit.length ? `命中关键词：${hit.slice(0, 6).join('、')}` : '在已导入材料中未找到明显对应内容', suggestion: hit.length ? '核对材料是否完整满足该要求，并补充验收证据。' : '补充对应交付内容，或确认此要求已取消/不适用。', source: r.evidence };
  });
  if (rules.trim()) checks.push({ title: '用户自定义检查规范', status: corpus.includes(rules.trim().slice(0, 10).toLowerCase()) ? '发现相似文本' : '需人工逐项核对', evidence: '规则核对模式不会理解复杂语义或保证数据准确', suggestion: '连接本地模型后可结合规范生成逐条审查意见。', source: '用户输入规范' });
  if (!documents.length) checks.unshift({ title: '尚未导入交付材料', status: '无法检查', evidence: '请添加 TXT、MD 或 CSV 文件', suggestion: '选择项目交付物后重新检查。', source: '系统提示' });
  return checks;
}

server.listen(PORT, '127.0.0.1', () => console.log(`本地交付核验 Demo 已启动：http://127.0.0.1:${PORT}`));
