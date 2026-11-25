const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { spawn } = require('node:child_process');
const mammoth = require('mammoth');
const ExcelJS = require('exceljs');
if (!globalThis.DOMMatrix) globalThis.DOMMatrix = class DOMMatrix {};
const { PDFParse } = require('pdf-parse');
const { reviewProject } = require('./review');
const { createModelGateway } = require('./model-gateway');
const { analyzeRequirements, ruleAnalyzeRequirements } = require('./requirements-analyzer');
const { createKnowledgeStore } = require('./knowledge-store');

const PORT = Number(process.env.PORT || 4174);
const ROOT = __dirname;
const gateway = createModelGateway({ configFile: path.join(ROOT, '.env.local') });
const knowledgeStore = createKnowledgeStore(path.join(ROOT, 'data', 'knowledge-base.json'));
const MAX_BODY = 12 * 1024 * 1024;
const CAPTURE_DIR = path.join(ROOT, 'captures');
let capture = { active: false, projectId: 'demo' };
const captureEvents = [];
let nextCaptureEventId = Date.now();
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

const IS_MAC = process.platform === 'darwin';
const MAC_PERMISSION_HINT = '请确认已打开微信或 Teams 窗口；若确认已打开，请检查系统设置 → 隐私与安全性 → 屏幕录制，为运行 Demo 的终端开启权限后重启 Demo。';
const DESKTOP_APP_RE = /wechat|weixin|microsoft teams|ms-teams|\bteams\b/i;

function detectAppLabel(name) {
  return /teams/i.test(String(name || '')) ? 'Teams' : '微信';
}

function runProcess(command, args, timeout, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => stdout += chunk);
    child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
    const timer = setTimeout(() => { child.kill(); reject(new Error('截图命令超时')); }, timeout);
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => { clearTimeout(timer); if (code !== 0) reject(new Error(stderr.trim() || `${command} 退出码 ${code}`)); else resolve(stdout.trim()); });
  });
}

function runPowerShell(script, timeout = 12000) {
  if (process.platform !== 'win32') return Promise.reject(new Error('当前系统不是 Windows，无法使用 PowerShell 读取窗口'));
  return runProcess('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script], timeout, { windowsHide: true });
}

function runOsascript(script, timeout = 12000) {
  return runProcess('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script], timeout);
}

async function listWechatWindows() {
  if (IS_MAC) return listMacWechatWindows();
  if (process.platform !== 'win32') throw new Error('当前系统暂不支持桌面窗口检测（仅支持 Windows 与 macOS）');
  const script = `$ErrorActionPreference='Stop'; Get-Process | Where-Object { $_.ProcessName -match 'WeChat|Weixin|Teams|ms-teams' -and $_.MainWindowHandle -ne 0 } | ForEach-Object { [pscustomobject]@{ hwnd=$_.MainWindowHandle.ToInt64().ToString(); title=$_.MainWindowTitle; process=$_.ProcessName } } | ConvertTo-Json -Compress`;
  const output = await runPowerShell(script);
  if (!output) return [];
  const parsed = JSON.parse(output);
  return (Array.isArray(parsed) ? parsed : [parsed])
    .filter(x => x.hwnd && /^\d+$/.test(String(x.hwnd)))
    .map(x => {
      const processName = String(x.process || 'WeChat');
      const app = detectAppLabel(processName);
      return { hwnd: String(x.hwnd), title: String(x.title || `${app}窗口`), process: processName, app };
    });
}

function listMacWechatWindows() {
  const script = `ObjC.import('CoreGraphics');
function run(argv) {
  const opts = $.kCGWindowListOptionOnScreenOnly | $.kCGWindowListExcludeDesktopElements;
  const raw = $.CGWindowListCopyWindowInfo(opts, $.kCGNullWindowID);
  const list = ObjC.deepUnwrap(raw);
  const arr = (list && typeof list.length === 'number') ? Array.prototype.slice.call(list) : [];
  const hits = arr
    .filter(w => /wechat|weixin|microsoft teams|ms-teams|\\bteams\\b/i.test(String(w.kCGWindowOwnerName || '')))
    .map(w => ({
      hwnd: String(w.kCGWindowNumber || 0),
      title: String(w.kCGWindowName || ''),
      process: String(w.kCGWindowOwnerName || 'WeChat'),
      layer: Number(w.kCGWindowLayer || 0),
      width: Number((w.kCGWindowBounds || {}).Width || 0),
      height: Number((w.kCGWindowBounds || {}).Height || 0)
    }))
    .filter(w => w.hwnd !== '0' && w.layer === 0 && w.width >= 150 && w.height >= 100)
    .sort((a, b) => (b.width * b.height) - (a.width * a.height))
    .map((w, index) => {
      const app = /teams/i.test(w.process) ? 'Teams' : '微信';
      return { hwnd: w.hwnd, title: w.title || (app + '窗口 ' + (index + 1)), process: w.process, app };
    });
  return JSON.stringify(hits);
}`;
  return runOsascript(script).then(output => {
    if (!output) return [];
    const parsed = JSON.parse(output);
    return (Array.isArray(parsed) ? parsed : [])
      .filter(x => x.hwnd && /^\d+$/.test(String(x.hwnd)))
      .map(x => {
        const processName = String(x.process || 'WeChat');
        return { hwnd: String(x.hwnd), title: String(x.title || '桌面窗口'), process: processName, app: detectAppLabel(processName) };
      });
  });
}

function captureWindow(hwnd, destination) {
  if (!/^\d+$/.test(String(hwnd))) return Promise.reject(new Error('微信窗口句柄无效'));
  if (IS_MAC) {
    return new Promise((resolve, reject) => {
      const child = spawn('/usr/sbin/screencapture', ['-x', `-l${hwnd}`, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
      let stderr = '';
      child.stderr.setEncoding('utf8').on('data', chunk => stderr += chunk);
      const timer = setTimeout(() => { child.kill(); reject(new Error('macOS 截图命令超时')); }, 20000);
      child.on('error', error => { clearTimeout(timer); reject(error); });
      child.on('close', code => {
        clearTimeout(timer);
        if (code !== 0) return reject(new Error(stderr.trim() || '无法截取微信窗口；窗口可能已最小化或被关闭'));
        try {
          if (!fs.existsSync(destination) || fs.statSync(destination).size < 1000) {
            return reject(new Error(`微信窗口截图失败：${MAC_PERMISSION_HINT}`));
          }
        } catch { return reject(new Error(`微信窗口截图失败：${MAC_PERMISSION_HINT}`)); }
        resolve();
      });
    });
  }
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
    body: JSON.stringify({ model, stream: false, images: [data], prompt: `这是办公沟通软件（微信或 Microsoft Teams）聊天窗口截图。请判断当前聊天标题/群名/频道名是否对应目标会话“${group}”。只输出严格 JSON，不要 markdown：{"group_match":true或false,"group_name":"识别到的标题","messages":[{"time":"可见时间或未知","speaker":"发言人或未知","text":"可见消息原文"}]}。只有明确看见目标群/频道标题且匹配时 group_match 才能为 true。不要推测遮挡文字；不匹配或看不清标题时 messages 返回空数组。` }),
    signal: AbortSignal.timeout(90000)
  });
  if (!response.ok) throw new Error(`视觉模型返回 HTTP ${response.status}`);
  const result = await response.json();
  const raw = String(result.response || '').trim();
  const jsonText = raw.match(/\{[\s\S]*\}/)?.[0];
  if (!jsonText) throw new Error('模型没有返回有效的群聊识别结果');
  return JSON.parse(jsonText);
}

async function captureTick(capture) {
  if (!capture.active || capture.busy) return;
  capture.busy = true;
  capture.lastCheck = new Date().toISOString();
  const tempFile = path.join(CAPTURE_DIR, `.pending-${randomUUID()}.png`);
  try {
    const windows = await listWechatWindows();
    if (!capture.active) return;
    const target = windows.find(w => w.hwnd === capture.hwnd);
    if (!target) throw new Error('所选微信窗口已关闭；监测已暂停，请重新选择窗口');
    await captureWindow(capture.hwnd, tempFile);
    if (!capture.active) return;
    const recognized = await recognizeGroupScreenshot(tempFile, capture.model, capture.group);
    if (!capture.active) return;
    if (!recognized.group_match) {
      capture.lastError = `未确认目标群“${capture.group}”，本次截图未保存` + (IS_MAC ? '；若微信画面正常却持续不匹配，请检查系统设置 → 隐私与安全性 → 屏幕录制，确认运行 Demo 的终端已开启权限并重启 Demo。' : '');
      return;
    }
    const messages = Array.isArray(recognized.messages) ? recognized.messages.filter(m => m && m.text).map(m => ({ time: String(m.time || '未知'), speaker: String(m.speaker || '未知'), text: String(m.text) })) : [];
    const signature = JSON.stringify(messages);
    if (!messages.length || signature === capture.lastSignature) {
      capture.lastError = messages.length ? '群聊已匹配，内容没有变化；未重复保存' : '群聊已匹配，但画面中没有可识别的新消息';
      return;
    }
    capture.lastSignature = signature;
    nextCaptureEventId = Math.max(nextCaptureEventId + 1, Date.now());
    const file = `wechat-${nextCaptureEventId}.png`;
    const dest = path.join(CAPTURE_DIR, file);
    fs.renameSync(tempFile, dest);
    capture.saved += 1;
    capture.lastError = '';
    captureEvents.push({ id: nextCaptureEventId, projectId: capture.projectId, at: new Date().toISOString(), file, url: `/captures/${file}`, group: String(recognized.group_name || capture.group), messages });
    if (captureEvents.length > 100) captureEvents.shift();
  } catch (error) {
    capture.lastError = error.message;
    if (capture.active && /所选微信窗口已关闭/.test(error.message)) stopCapture();
  } finally {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    capture.busy = false;
  }
}

function startCapture(config) {
  stopCapture();
  const session = {
    active: true, busy: false, projectId: config.projectId, hwnd: String(config.hwnd),
    title: config.title, group: config.group, model: config.model,
    intervalSec: Math.max(10, Math.min(120, Number(config.intervalSec) || 15)),
    startedAt: new Date().toISOString(), lastCheck: '', lastError: '', saved: 0, lastSignature: ''
  };
  capture = session;
  session.timer = setInterval(() => captureTick(session), session.intervalSec * 1000);
  captureTick(session);
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
  const timeout = AbortSignal.timeout(90000);
  const response = await fetch('http://127.0.0.1:11434/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, stream: false, think: false, format: schema,
      options: { temperature: 0, seed: 42, num_ctx: 8192, num_predict: 1200 },
      messages: [{ role: 'system', content: system }, { role: 'user', content: content + '\n输出JSON schema：' + JSON.stringify(schema) }] }),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout
  });
  if (!response.ok) throw new Error(`Ollama 返回 HTTP ${response.status}`);
  const result = await response.json();
  if (result.done_reason === 'length') throw new Error('本条模型输出被截断，请重试或拆分需求');
  if (!result.message?.content) throw new Error('本地模型未返回检查意见');
  return result.message.content;
}

const COACH_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['question', 'feedback'],
  properties: {
    question: { type: 'string' },
    feedback: { type: 'string' },
    strengths: { type: 'array', maxItems: 3, items: { type: 'string' } },
    improvements: { type: 'array', maxItems: 3, items: { type: 'string' } },
    evidenceTip: { type: 'string' }
  }
};

function limitedText(value, limit) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

async function coachTurn(input, ask) {
  const { project, audience, duration, focus, requirements, documents, rules, turns, knowledgeRefs } = input;
  const context = {
    project: limitedText(project, 120),
    audience: limitedText(audience, 80),
    duration: limitedText(duration, 40),
    focus: limitedText(focus, 400),
    rules: limitedText(rules, 600),
    requirements: (Array.isArray(requirements) ? requirements : []).slice(0, 10).map(item => limitedText(item, 180)),
    documents: (Array.isArray(documents) ? documents : []).slice(0, 4).map(item => ({
      name: limitedText(item?.name, 120), text: limitedText(item?.text, 500)
    })),
    knowledgeRefs: (Array.isArray(knowledgeRefs) ? knowledgeRefs : []).slice(0, 5).map(ref => ({
      title: limitedText(ref?.title, 100),
      audience: limitedText(ref?.audience, 60),
      takeaway: limitedText(ref?.takeaway, 300)
    })).filter(ref => ref.title && ref.takeaway),
    turns: (Array.isArray(turns) ? turns : []).slice(-4).map(turn => ({
      question: limitedText(turn?.question, 260), answer: limitedText(turn?.answer, 1200)
    })).filter(turn => turn.question && turn.answer)
  };
  const followUp = context.turns.length > 0;
  const stage = followUp
    ? '针对最新回答指出做得好的地方（strengths，最多2条）和具体缺口/修改建议（improvements，最多2条），指出可援引或需补齐的材料出处（evidenceTip），汇总到 feedback（160字内），并提出一个承接回答的追问（question）。如果用户引用了历史复盘（knowledgeRefs），请检查本次回答是否避免了历史失误或踩中相同弱点。答不上来时，给提示并缩小问题范围。'
    : '按听众视角、项目需求和重点提出一个切中要害的首问（question）；如有引用历史复盘（knowledgeRefs），可结合历史常见追问设计首问。首问轮次 feedback、evidenceTip 返回空字符串，strengths/improvements 返回空数组。缺少材料与需求时，从项目目标或进展问起。';
  const system = `你是智汇中文项目汇报教练。扮演指定听众（客户负责人、公司领导或评审团队）进行实战提问与复盘。
只使用已提供的项目需求、材料、规范和历史复盘作为依据，不要编造不存在的材料内容；缺少信息时请提醒用户补齐。
${stage}`;
  const raw = await ask(system, JSON.stringify(context), COACH_SCHEMA);
  let result;
  try { result = typeof raw === 'string' ? JSON.parse(raw) : raw; }
  catch { throw new Error('模型返回的演练格式无效，请重试'); }
  const question = limitedText(result?.question, 300);
  const feedback = followUp ? limitedText(result?.feedback, 450) : '';
  const strengths = followUp && Array.isArray(result?.strengths)
    ? result.strengths.map(s => limitedText(s, 140)).filter(Boolean).slice(0, 3) : [];
  const improvements = followUp && Array.isArray(result?.improvements)
    ? result.improvements.map(s => limitedText(s, 160)).filter(Boolean).slice(0, 3) : [];
  const evidenceTip = followUp ? limitedText(result?.evidenceTip, 220) : '';
  if (!question || (followUp && !feedback)) throw new Error('模型返回的题目或反馈不完整，请重试');
  return { question, feedback, strengths, improvements, evidenceTip };
}

const server = http.createServer(async (req, res) => {
  const origins = [`http://127.0.0.1:${PORT}`, `http://localhost:${PORT}`];
  if (!origins.includes(`http://${req.headers.host}`) || (req.headers.origin && !origins.includes(req.headers.origin))) {
    return json(res, 403, { error: '仅允许从本机项目页面访问' });
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'access-control-allow-methods': 'GET,POST,DELETE,OPTIONS', 'access-control-allow-headers': 'content-type' });
    return res.end();
  }
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  if (url.pathname === '/api/knowledge-base' && req.method === 'GET') {
    return json(res, 200, { items: knowledgeStore.list() });
  }
  if (url.pathname === '/api/knowledge-base' && req.method === 'POST') {
    try { return json(res, 200, { item: knowledgeStore.upsert(await readBody(req)) }); }
    catch (error) { return json(res, 400, { error: error.message }); }
  }
  if (url.pathname.startsWith('/api/knowledge-base/') && req.method === 'DELETE') {
    try {
      const id = decodeURIComponent(url.pathname.slice('/api/knowledge-base/'.length));
      return json(res, 200, { deleted: knowledgeStore.remove(id) });
    } catch (error) { return json(res, 400, { error: error.message }); }
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
  if ((url.pathname === '/api/wechat/windows' || url.pathname === '/api/desktop/windows') && req.method === 'GET') {
    try {
      const windows = await listWechatWindows();
      if (IS_MAC && windows.length === 0) return json(res, 200, { windows: [], error: `未发现已打开的微信或 Teams 窗口：${MAC_PERMISSION_HINT}` });
      return json(res, 200, { windows });
    }
    catch (error) { return json(res, 200, { windows: [], error: `读取桌面窗口失败：${error.message}` }); }
  }
  if (url.pathname === '/api/wechat/capture/status' && req.method === 'GET') {
    const after = Number(url.searchParams.get('after') || 0);
    return json(res, 200, { active: capture.active, projectId: capture.projectId, title: capture.title, group: capture.group, intervalSec: capture.intervalSec, startedAt: capture.startedAt, lastCheck: capture.lastCheck, lastError: capture.lastError, saved: capture.saved, events: captureEvents.filter(event => event.id > after) });
  }
  if (url.pathname === '/api/wechat/capture/start' && req.method === 'POST') {
    try {
      const config = await readBody(req);
      const projectId = config.projectId || 'demo';
      if (typeof projectId !== 'string' || !/^(?:demo|[0-9a-f-]{36})$/.test(projectId)) return json(res, 400, { error: '项目编号无效' });
      if (!/^\d+$/.test(String(config.hwnd || ''))) return json(res, 400, { error: '请先选择微信或 Teams 窗口' });
      const group = String(config.group || '').trim();
      if (group.length < 2 || group.length > 120) return json(res, 400, { error: '请填写准确的群聊或频道名称' });
      const windows = await listWechatWindows();
      const target = windows.find(window => window.hwnd === String(config.hwnd));
      if (!target) return json(res, 404, { error: '所选桌面窗口已关闭，请刷新窗口列表' });
      const tags = await fetch('http://127.0.0.1:11434/api/tags', { signal: AbortSignal.timeout(2000) });
      if (!tags.ok) return json(res, 503, { error: '无法连接本机 Ollama' });
      const data = await tags.json();
      const models = (data.models || []).map(item => item.name);
      const visionModels = models.filter(name => /vl|vision|llava|minicpm-v|moondream/i.test(name));
      if (!visionModels.includes(config.model)) return json(res, 400, { error: '请选择已安装的本地视觉模型，例如 qwen3-vl；普通文本模型不能识别截图' });
      if (capture.active && capture.projectId !== projectId) return json(res, 409, { error: '另一项目正在监测桌面窗口，请先在该项目中停止监测。' });
      startCapture({ ...config, projectId, title: target.title || `${target.app || '桌面'}窗口`, group });
      return json(res, 200, { active: true, projectId, title: capture.title, group: capture.group, intervalSec: capture.intervalSec });
    } catch (error) { return json(res, 400, { error: `启动桌面监测失败：${error.message}` }); }
  }
  if (url.pathname === '/api/wechat/capture/stop' && req.method === 'POST') {
    const projectId = url.searchParams.get('projectId') || 'demo';
    if (capture.active && capture.projectId !== projectId) return json(res, 409, { error: '请在启动监测的项目中停止监测。' });
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
  if (url.pathname === '/api/analyze-requirements' && req.method === 'POST') {
    let input;
    try { input = await readBody(req); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const messages = Array.isArray(input?.messages) ? input.messages : [];
    if (!messages.length) return json(res, 400, { error: '请先导入聊天记录、会议纪要或识别截图后再分析' });
    const provider = input?.provider || 'ollama';
    const api = gateway.apiConfig(provider);
    if (provider !== 'ollama' && !api) return json(res, 400, { error: '未知的模型来源' });
    if (api?.error) return json(res, 400, { error: api.error });
    const model = limitedText(input?.model || api?.model, 200);
    if (provider === 'ollama' && model === 'rules') {
      return json(res, 200, { mode: 'rules', provider: 'ollama', model: 'rules', requirements: ruleAnalyzeRequirements(messages) });
    }
    if (!model) return json(res, 400, { error: '请在模型设置中选择或填写可用的语言模型' });
    const controller = new AbortController();
    const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancelOnDisconnect);
    if (res.destroyed) controller.abort();
    try {
      const ask = api
        ? gateway.createChat(provider, model, { signal: controller.signal, expectedBaseUrl: input.customBaseUrl })
        : (system, content, schema) => askOllama(model, system, content, schema, controller.signal);
      const requirements = await analyzeRequirements(messages, ask);
      if (!res.destroyed) return json(res, 200, { mode: api ? 'api' : 'ollama', provider, model, requirements });
    } catch (error) {
      const message = !api && error.message === 'fetch failed' ? '无法连接本机 Ollama，请启动服务或切换至规则整理模式'
        : !api && error.message === 'Ollama 返回 HTTP 404' ? `Ollama 未找到模型 ${model}，请在模型设置中选用已安装的模型`
        : error.message;
      if (!res.destroyed) return json(res, 502, { error: message });
    } finally { res.off('close', cancelOnDisconnect); }
    return;
  }
  if (url.pathname === '/api/rehearsal' && req.method === 'POST') {
    let input;
    try { input = await readBody(req); }
    catch (error) { return json(res, 400, { error: error.message }); }
    const provider = input?.provider;
    const api = gateway.apiConfig(provider);
    if (provider !== 'ollama' && !api) return json(res, 400, { error: '请选择演练使用的模型来源' });
    if (api?.error) return json(res, 400, { error: api.error });
    const model = limitedText(input?.model || api?.model, 200);
    if (!model || (provider === 'ollama' && model === 'rules')) return json(res, 400, { error: '请在模型设置中选择支持文本对话的模型' });
    const controller = new AbortController();
    const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
    res.once('close', cancelOnDisconnect);
    if (res.destroyed) controller.abort();
    try {
      const ask = api
        ? gateway.createChat(provider, model, { signal: controller.signal, expectedBaseUrl: input.customBaseUrl })
        : (system, content, schema) => askOllama(model, system, content, schema, controller.signal);
      const turn = await coachTurn(input, ask);
      if (!res.destroyed) return json(res, 200, turn);
    } catch (error) {
      const message = !api && error.message === 'fetch failed' ? '无法连接本机 Ollama，请启动服务后重试'
        : !api && error.message === 'Ollama 返回 HTTP 404' ? `Ollama 未找到模型 ${model}，请在模型设置中选用已安装的模型`
        : error.message;
      if (!res.destroyed) return json(res, 502, { error: message });
    } finally { res.off('close', cancelOnDisconnect); }
    return;
  }
  if (url.pathname === '/api/review' && req.method === 'POST') {
    try {
      const input = await readBody(req);
      const { model, requirements, documents, rules } = input;
      const provider = input.provider || 'ollama';
      const api = gateway.apiConfig(provider);
      if (provider !== 'ollama' && !api) return json(res, 400, { error: '未知的模型来源' });
      if (api) {
        if (api.error) return json(res, 400, { error: api.error });
        const selected = String(model || api.model).trim();
        if (!selected) return json(res, 400, { error: '请先选择 API 模型' });
        const controller = new AbortController();
        const cancelOnDisconnect = () => { if (!res.writableEnded) controller.abort(); };
        res.once('close', cancelOnDisconnect);
        if (res.destroyed) controller.abort();
        try {
          const ask = gateway.createChat(provider, selected, { signal: controller.signal, expectedBaseUrl: input.customBaseUrl });
          const result = await reviewProject(input, ask);
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
  const vendors = { '/vendor/marked.js': 'node_modules/marked/lib/marked.umd.js', '/vendor/purify.js': 'node_modules/dompurify/dist/purify.min.js' };
  const assets = new Set(['/', '/index.html', '/app.js', '/style.css', '/report.css', '/report-ui.js', '/rehearsal-ui.js', '/model-settings.js', '/model-settings.css', ...Object.keys(vendors)]);
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
