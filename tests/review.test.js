const test = require('node:test');
const assert = require('node:assert/strict');
const { prepareDocuments, normalizeChecks, reviewProject } = require('../review');

const docs = prepareDocuments([{ name: '方案.md', text: '# 方案\n支持本地化部署。\n\n统计周期为十月。' }]);
const point = (status, evidence = []) => ({ criterion: '本地部署', status, evidence, reason: '说明', suggestion: '补充' });

test('accepts literal evidence and computes source lines; rejects fabricated evidence', () => {
  const [valid, invalid] = normalizeChecks({ checks: [
    point('covered', [{ documentId: 'F-1', quote: '支持本地化部署。' }]),
    point('covered', [{ documentId: 'F-1', quote: '采用私有云和容器化部署。' }])
  ] }, docs);
  assert.equal(valid.status, 'covered');
  assert.equal(valid.evidence[0].lineStart, 2);
  assert.equal(valid.evidence[0].file, '方案.md');
  assert.equal(invalid.status, 'uncertain');
  assert.equal(invalid.rejectedEvidence, 1);
});

test('unknown filenames and empty positive evidence cannot become a pass', () => {
  const result = normalizeChecks({ checks: [point('partial', [{ documentId: '不存在', quote: '支持本地化部署。' }]), point('covered')] }, docs);
  assert.ok(result.every(c => c.status === 'uncertain'));
});

test('unreadable attachments and empty input cannot be confidently marked missing', () => {
  const unreadable = prepareDocuments([{ name: '附件.png', text: '' }]);
  for (const input of [[], unreadable, [...docs, ...unreadable]]) {
    assert.equal(normalizeChecks({ checks: [point('missing')] }, input)[0].status, 'uncertain');
  }
});

test('every requirement remains in the report, including failed model calls', async () => {
  let calls = 0;
  const report = await reviewProject({ requirements: [
    { id: 'R-1', detail: '本地部署' }, { id: 'R-2', detail: '提供操作手册' }, { id: 'R-3', detail: '提供指南' }
  ], documents: [{ name: '方案.md', text: docs[0].text }], rules: '注明来源' }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['检查点'] };
    calls++;
    if (calls === 2) throw new Error('模型连接失败');
    return { checks: [{ ...point('missing'), criterionId: 'C-1' }] };
  });
  assert.equal(calls, 4);
  assert.deepEqual(report.report.units.map(r => r.id), ['R-1', 'R-2', 'R-3', 'S-01']);
  assert.equal(report.report.units[1].reviewed, false);
  assert.equal(report.report.units[1].status, 'uncertain');
  assert.equal(report.report.summary.reviewed, 3);
  assert.match(report.answer, /核验未完成/);
});

test('an entirely failed run is not presented as a model review or rule fallback', async () => {
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '要求' }] }, async () => { throw new Error('离线'); });
  assert.equal(result.mode, 'unavailable');
  assert.equal(result.report.summary.reviewed, 0);
});

test('oversized material is flagged explicitly rather than silently truncated', async () => {
  let called = false;
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '要求' }], documents: [{ name: '长文.txt', text: '数据'.repeat(10000) }] }, async () => { called = true; });
  assert.equal(called, false);
  assert.equal(result.report.units[0].status, 'uncertain');
  assert.match(result.answer, /超过本机单轮核验范围/);
});

test('a missing model row is visible and cannot silently omit an atomic criterion', async () => {
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '提供A和B' }], documents: [{ name: '文档', text: '已提供A' }] }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['提供A', '提供B'] };
    return { checks: [{ criterionId: 'C-1', ...point('covered', [{ documentId: 'F-1', quote: '已提供A' }]) }] };
  });
  assert.equal(result.report.units[0].checks.length, 2);
  assert.equal(result.report.units[0].checks[1].status, 'uncertain');
  assert.equal(result.report.units[0].reviewed, false);
});

test('a delivery deadline without execution records is not declared missed or completed', async () => {
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '周五前交付' }], documents: [{ name: '文档', text: '周五前交付' }] }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['周五前交付'] };
    return { checks: [{ criterionId: 'C-1', ...point('missing') }] };
  });
  assert.equal(result.report.units[0].checks[0].status, 'uncertain');
  assert.match(result.report.units[0].checks[0].reason, /实际履约时间/);
});

test('grading isolates the current criterion from sibling requirement text', async () => {
  const seen = [];
  await reviewProject({ requirements: [{ id: 'R-1', detail: '检查安装指南和维护手册' }], documents: [{ name: '方案', text: '方案说明' }] }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['检查安装指南', '检查维护手册'] };
    const data = JSON.parse(content);
    seen.push(data);
    return { checks: [{ ...point('missing'), criterionId: data.criterion.id }] };
  });
  assert.equal(seen.length, 2);
  assert.ok(seen.every(data => !Object.hasOwn(data, 'requirement')));
  assert.equal(seen[0].criterion.name, '检查安装指南');
  assert.equal(seen[1].criterion.name, '检查维护手册');
});

test('an explicit deadline survives model decomposition and citations are source-constrained', async () => {
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '周五前交付方案，并说明接口版本' }], documents: [{ name: '方案', text: '# 方案标题\n版本为3.0\n说明正文' }] }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['交付方案', '说明接口版本'] };
    const data = JSON.parse(content);
    const citation = schema.properties.checks.items.properties.evidence.items.properties;
    assert.deepEqual(citation.documentId.enum, ['F-1']);
    assert.deepEqual(citation.quote.enum, ['版本为3.0', '说明正文']);
    return { checks: [{ ...point('missing'), criterionId: data.criterion.id }] };
  });
  assert.ok(result.report.units[0].checks.some(c => c.criterion === '周五前交付方案' && c.status === 'uncertain'));
});

test('similarly named artifacts are not silently merged as substring duplicates', async () => {
  const result = await reviewProject({ requirements: [{ id: 'R-1', detail: '提供用户手册和高级用户手册' }], documents: [{ name: '方案', text: '交付说明' }] }, async (system, content, schema) => {
    if (schema.properties.criteria) return { criteria: ['用户手册', '高级用户手册'] };
    const data = JSON.parse(content);
    return { checks: [{ ...point('missing'), criterionId: data.criterion.id }] };
  });
  assert.deepEqual(result.report.units[0].checks.map(c => c.criterion), ['用户手册', '高级用户手册']);
});
