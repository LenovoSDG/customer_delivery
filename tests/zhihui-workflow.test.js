const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runInContext } = require('node:vm');
const { JSDOM } = require('jsdom');

const {
  UNSPECIFIED,
  normalizeAnalyzedRequirements,
  ruleAnalyzeRequirements,
  analyzeRequirements
} = require('../requirements-analyzer');
const { createKnowledgeStore } = require('../knowledge-store');

function setupDom(t, { fetchMock } = {}) {
  const dom = new JSDOM(fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:4174/'
  });
  const win = dom.window;
  win.scrollTo = () => {};
  for (const id of ['projectDialog', 'requirementDialog', 'deliverableDialog', 'knowledgeDialog', 'settingsDialog']) {
    const dlg = win.document.getElementById(id);
    if (dlg) {
      dlg.showModal = () => { dlg.open = true; };
      dlg.close = () => { dlg.open = false; };
    }
  }
  win.ModelSettings = {
    providerLabel: () => '本机 Ollama',
    destinationLabel: () => '本机 Ollama',
    selection: async () => ({ provider: 'ollama', model: 'qwen3:4b' })
  };
  if (fetchMock) win.fetch = fetchMock;
  t.after(() => win.close());
  for (const filename of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'app.js', 'report-ui.js', 'rehearsal-ui.js']) {
    runInContext(fs.readFileSync(path.join(__dirname, '..', filename), 'utf8'), dom.getInternalVMContext(), { filename });
  }
  return { win, el: id => win.document.getElementById(id) };
}

test('requirements analyzer preserves sources and fills missing fields with 未说明', async () => {
  const messages = [
    { source: '微信群', date: '2026-11-20 10:00', speaker: '客户王总', text: '周五前把预算明细表发过来，注意按含税口径，用 Excel。' },
    { source: '会议纪要', date: '2026-11-20 14:00', speaker: '产品经理', text: '需要补充安全架构说明。' }
  ];
  const analyzed = await analyzeRequirements(messages, async () => ({
    requirements: [
      { sourceIds: ['M-1'], description: '提交项目预算明细表', notes: '按含税口径', deliverable: '预算明细表', dueTime: '周五前', format: 'Excel' },
      { sourceIds: ['M-2'], description: '补充安全架构说明', notes: '', deliverable: '无', dueTime: '未提及', format: 'N/A' }
    ]
  }));

  assert.equal(analyzed.length, 2);
  assert.equal(analyzed[0].evidence, '微信群 · 2026-11-20 10:00 · 客户王总');
  assert.equal(analyzed[0].dueTime, '周五前');
  assert.equal(analyzed[0].format, 'Excel');
  assert.equal(analyzed[1].notes, UNSPECIFIED);
  assert.equal(analyzed[1].deliverable, UNSPECIFIED);
  assert.equal(analyzed[1].dueTime, UNSPECIFIED);
  assert.equal(analyzed[1].format, UNSPECIFIED);

  const fallback = ruleAnalyzeRequirements(messages);
  assert.equal(fallback[0].dueTime, '周五前');
  assert.equal(fallback[0].format, 'Excel');
  assert.equal(fallback[1].dueTime, UNSPECIFIED);
  assert.equal(fallback[1].format, UNSPECIFIED);
});

test('knowledge store persists, updates, and deletes notes safely on disk', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'zhihui-kb-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'knowledge-base.json');
  const store = createKnowledgeStore(file);

  const created = store.upsert({
    title: '含税报价口径追问',
    audience: '客户商务负责人',
    tags: '含税口径, 报价',
    question: '为什么采用含税口径？',
    takeaway: '先说明按 6% 增值税口径，再给出明细表位置。',
    projectName: '凌云项目'
  });
  assert.ok(created.id);
  assert.deepEqual(created.tags, ['含税口径', '报价']);
  assert.equal(store.list().length, 1);

  const updated = store.upsert({ ...created, title: '含税报价口径追问（更新）' });
  assert.equal(updated.id, created.id);
  assert.equal(store.list()[0].title, '含税报价口径追问（更新）');

  assert.equal(store.remove(created.id), true);
  assert.equal(store.list().length, 0);
});

test('OCR demo and raw paste enter requirement candidates directly, and AI analyze populates 5 fields', async t => {
  const { win, el } = setupDom(t, {
    fetchMock: async url => {
      if (url === '/api/knowledge-base') return new Response(JSON.stringify({ items: [] }));
      if (url === '/api/analyze-requirements') {
        return new Response(JSON.stringify({
          mode: 'ollama',
          requirements: [{
            id: 'R-01',
            description: '提供项目预算明细表',
            notes: '按含税口径计算',
            deliverable: '预算明细表',
            dueTime: '周五前',
            format: 'Excel',
            evidence: '微信聊天记录 · 第 1 行 · 客户王总',
            rawText: '周五前按含税口径发 Excel 预算明细表',
            status: '待确认',
            analyzedBy: 'ai'
          }]
        }));
      }
      return new Response('{}');
    }
  });

  // Paste raw transcript directly
  el('pasteSpeaker').value = '客户王总';
  el('pasteRawInput').value = '周五前按含税口径发 Excel 预算明细表';
  el('addRawPaste').click();
  assert.equal(el('reqCount').textContent, '1');

  // Demo OCR directly adds candidate
  el('loadScreenshotDemo').click();
  assert.equal(el('reqCount').textContent, '2');

  // Click "分析客户需求"
  await el('extractBtn').onclick();
  assert.match(el('requirementsList').textContent, /提供项目预算明细表/);
  assert.match(el('requirementsList').textContent, /按含税口径计算/);
  assert.match(el('requirementsList').textContent, /周五前/);
  assert.match(el('requirementsList').textContent, /Excel/);

  // Confirm into deliverables
  win.document.querySelector('[data-confirm]').click();
  assert.equal(el('deliverableCount').textContent, '1');
  assert.match(el('deliverablesList').textContent, /预算明细表/);
});

test('material filters work, and structured quality report links to line-numbered material preview', async t => {
  const { win, el } = setupDom(t, {
    fetchMock: async url => {
      if (url === '/api/knowledge-base') return new Response(JSON.stringify({ items: [] }));
      if (url === '/api/review') {
        return new Response(JSON.stringify({
          provider: 'ollama',
          model: 'qwen3:4b',
          answer: '## 核验概览\n完成',
          report: {
            elapsedMs: 1200,
            summary: { reviewed: 1, total: 1, requirements: 1, rules: 0, checks: 2, covered: 1, partial: 1, missing: 0, uncertain: 0 },
            units: [{
              id: 'R-01',
              type: 'requirement',
              detail: '首页展示团队协同效率',
              evidence: '演示记录',
              status: 'partial',
              reviewed: true,
              checks: [
                {
                  criterion: '展示任务按时完成率',
                  status: 'covered',
                  reason: '已写明 92%',
                  suggestion: '无需修改',
                  evidence: [{ documentId: 'F-1', file: '项目汇报稿_演示.md', lineStart: 10, lineEnd: 10, quote: '试点团队任务按时完成率提升至 92%。' }]
                },
                {
                  criterion: '展示跨部门协作时长',
                  status: 'partial',
                  reason: '缺少具体时长口径',
                  suggestion: '补充跨部门协作平均时长及统计周期。',
                  evidence: []
                }
              ]
            }]
          }
        }));
      }
      return new Response('{}');
    }
  });

  el('loadSample').click();
  win.document.querySelector('[data-confirm]').click();
  assert.equal(el('materialCount').textContent, '1');
  assert.equal(el('materialPendingCount').textContent, '1');
  assert.equal(el('materialDoneCount').textContent, '0');

  // Filter to 已检查 -> should show empty filtered message
  win.document.querySelector('[data-mat-filter="已检查"]').click();
  assert.match(el('materialsList').textContent, /当前筛选下没有材料/);
  win.document.querySelector('[data-mat-filter="all"]').click();
  assert.match(el('materialsList').textContent, /项目汇报稿_演示\.md/);

  // Run quality review
  await el('runReview').onclick();
  assert.match(el('report').textContent, /展示任务按时完成率/);
  assert.match(el('report').textContent, /第 10 行/);

  // Click citation button -> opens line preview drawer at line 10
  win.document.querySelector('[data-cite-file]').click();
  assert.equal(el('materialPreviewDrawer').classList.contains('hidden'), false);
  assert.equal(el('previewDrawerTitle').textContent, '项目汇报稿_演示.md');
  assert.ok(el('previewDrawerBody').querySelector('.preview-line.highlighted'));
});

test('rehearsal supports structured feedback, saving to knowledge base, and citing in next turn', async t => {
  const requests = [];
  let savedRecord = null;
  const { win, el } = setupDom(t, {
    fetchMock: async (url, options = {}) => {
      if (url === '/api/knowledge-base' && !options.method) {
        return new Response(JSON.stringify({ items: [] }));
      }
      if (url === '/api/knowledge-base' && options.method === 'POST') {
        const body = JSON.parse(options.body);
        savedRecord = { ...body, id: 'kb-1', tags: ['含税口径'], createdAt: '2026-11-25T10:00:00Z' };
        return new Response(JSON.stringify({ item: savedRecord }));
      }
      if (url === '/api/rehearsal') {
        const body = JSON.parse(options.body);
        requests.push(body);
        if (!body.turns.length) {
          return new Response(JSON.stringify({ question: '请说明预算为何采用含税口径？', feedback: '' }));
        }
        return new Response(JSON.stringify({
          question: '那如果不含税对照表何时能给到商务组？',
          feedback: '回答口径清晰，但缺少具体文件位置。',
          strengths: ['直接给出 6% 增值税口径'],
          improvements: ['补充预算明细表.xlsx 的对应工作表页码'],
          evidenceTip: '可引用项目汇报稿或预算表第 2 页'
        }));
      }
      return new Response('{}');
    }
  });

  await Promise.resolve();
  await el('startRehearsal').onclick();
  assert.match(el('conversation').textContent, /请说明预算为何采用含税口径/);

  el('answerInput').value = '我们统一按 6% 增值税含税测算。';
  el('answerInput').dispatchEvent(new win.Event('input'));
  await el('sendAnswer').onclick();

  assert.match(el('feedback').textContent, /回答口径清晰/);
  assert.match(el('feedback').textContent, /直接给出 6% 增值税口径/);
  assert.equal(el('saveToKnowledge').disabled, false);

  // Open knowledge modal and save
  el('saveToKnowledge').click();
  assert.equal(el('knowledgeDialog').open, true);
  el('kbFieldTitle').value = '含税口径答辩复盘';
  el('kbFieldTakeaway').value = '先给 6% 税率口径，再指明预算明细表.xlsx 位置。';
  el('knowledgeForm').dispatchEvent(new win.SubmitEvent('submit', { cancelable: true }));
  await new Promise(r => setTimeout(r, 10));

  assert.equal(el('kbTopCount').textContent, '1');
  assert.match(el('citedKbChips').textContent, /含税口径答辩复盘/);

  // Next rehearsal turn carries knowledgeRefs
  el('answerInput').value = '周四前可在预算明细表.xlsx 第 2 页附不含税对照列。';
  el('answerInput').dispatchEvent(new win.Event('input'));
  await el('sendAnswer').onclick();

  const lastPayload = requests[requests.length - 1];
  assert.equal(lastPayload.knowledgeRefs.length, 1);
  assert.equal(lastPayload.knowledgeRefs[0].title, '含税口径答辩复盘');
});
