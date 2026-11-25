const fs = require('node:fs');
const path = require('node:path');
const {ANALYSIS_BUDGET_MS} = require('./requirements');

function normalizeTitle(text) {
  return text.normalize('NFKC').replace(/\s+/g, '').replace(/\(\d+\)$/, '').toLowerCase();
}

module.exports = function createQueue(dir, readOCR, analyzeRows) {
  const records = new Map();
  const running = new Set();
  function save(item) {
    const dest = path.join(dir, item.file + '.json');
    fs.writeFileSync(dest + '.tmp', JSON.stringify(item));
    fs.renameSync(dest + '.tmp', dest);
    records.set(item.file, item);
  }
  for (const file of fs.readdirSync(dir).filter(name => /^(?:wechat-\d+\.png|upload-[\da-f-]+\.(?:png|jpg|webp))\.json$/.test(name))) {
    const item = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
    if (item.stage === 'ocr') item.stage = 'saved';
    if (item.stage === 'analyzing') item.stage = 'ready';
    if (item.stage === 'ready' && !item.readyAt) item.readyAt = Date.now();
    records.set(item.file, item);
  }
  async function drain(stage) {
    if (running.has(stage)) return;
    running.add(stage);
    try {
      for (;;) {
        const pending = Array.from(records.values()).filter(record => record.stage === stage);
        if (stage === 'ready') pending.sort((a,b) => a.readyAt - b.readyAt);
        const item = pending[0];
        if (!item) break;
        const started = Date.now();
        const isOCR = stage === 'saved';
        item.stage = isOCR ? 'ocr' : 'analyzing';
        item.started = started;
        try {
          if (isOCR) {
            const scan = await readOCR(path.join(dir, item.file));
            const headers = scan.lines.filter(l => l.y < scan.height * .16 && l.x >= scan.width * .18);
            const title = headers.find(l => normalizeTitle(l.text) === normalizeTitle(item.group));
            item.title = title?.text || headers.map(l => l.text).join(' / ');
            item.text = scan.lines.map(l => l.text).join('\n');
            const rows = item.upload ? scan.lines : scan.lines.filter(l => title ? l.y > title.y + 12 && l.x >= title.x - 5 : l.x >= scan.width * .2 && l.y > scan.height * .08);
            item.rows = rows.map(l => l.text);
            item.ocrMs = Date.now() - started;
            item.stage = item.upload || title ? 'transcribed' : 'review';
          } else {
            Object.assign(item, await analyzeRows(item.model, item.rows.map(text => ({text})), item.readyAt + ANALYSIS_BUDGET_MS));
            item.modelMs = Date.now() - started;
            item.stage = 'done';
          }
        } catch (error) {
          item.stage = isOCR ? 'ocrError' : 'modelError';
          item.error = error.message;
        }
        save(item);
        if (isOCR && item.stage === 'ready') void drain('ready');
      }
    } finally { running.delete(stage); }
  }
  function add(item) {
    item.stage = 'saved';
    save(item);
    void drain('saved');
  }
  function decide(file, action, project, model) {
    const item = records.get(file);
    if (!item || item.project !== project) throw Error('找不到项目截图');
    if (item.stage === 'transcribed' && action === 'analyze') item.stage = 'ready';
    else if (item.stage === 'review' && action === 'confirm') {
      item.manual = true;
      item.stage = 'transcribed';
    } else if (item.stage === 'review' && action === 'exclude') item.stage = 'excluded';
    else if (action === 'retry' && ['ocrError','modelError'].includes(item.stage)) item.stage = item.stage === 'ocrError' ? 'saved' : 'ready';
    else throw Error('截图状态已变化，请刷新后重试');
    if (item.stage === 'ready') {item.readyAt = Date.now(); item.model = model || item.model || 'qwen3:4b';}
    delete item.error;
    save(item);
    void drain('saved');
    void drain('ready');
  }
  void drain('saved');
  void drain('ready');
  return {records, add, decide};
};
