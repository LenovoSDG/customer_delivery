const ANALYZE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['requirements'],
  properties: {
    requirements: {
      type: 'array',
      maxItems: 30,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['sourceIds', 'description', 'notes', 'deliverable', 'dueTime', 'format'],
        properties: {
          sourceIds: { type: 'array', items: { type: 'string' } },
          description: { type: 'string' },
          notes: { type: 'string' },
          deliverable: { type: 'string' },
          dueTime: { type: 'string' },
          format: { type: 'string' }
        }
      }
    }
  }
};

const ANALYZE_PROMPT = `你是企业项目交付需求整理助手。请根据提供的客户沟通原文（聊天记录、会议纪要、转录稿、OCR 识别文本），提取每一条需要团队交付或落实的客户要求。
规则：
1. 只提取原文明确表达的要求、约定或变更；普通寒暄、纯粹回复“收到/好的”不要提取。
2. 每条要求必须保留原始出处，在 sourceIds 中填写对应的消息 ID（如 ["M-1"]）。
3. 每条要求包含 5 个结构化字段：
   - description（需求描述）：用简洁准确的中文概括客户要求。
   - notes（注意事项）：如统计口径、含税/不含税、覆盖范围、限制条件、重点强调内容等；原文未交代填“未说明”。
   - deliverable（交付物）：要求提交或展示的具体文档、页面、表格、清单或材料；原文未交代填“未说明”。
   - dueTime（交付时间）：原文提到的截止时间或时间节点（如“周五前”“下周三前”“12月上线前”）；原文未交代填“未说明”。
   - format（格式要求）：明确的文件格式或呈现形态（如“Excel”“PDF”“PPT”“移动端截图”）；原文未交代填“未说明”。
4. 严禁脑补或推测原文没有说明的时间、格式、交付物或注意事项，没有交代的一律填“未说明”。
5. 只输出符合给定 JSON schema 的结果。`;

const UNSPECIFIED = '未说明';

function cleanField(value, maxLen = 240) {
  const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
  if (!text || /^(无|暂无|没有|未提及|未交代|none|n\/a|null|-)$/i.test(text)) {
    return UNSPECIFIED;
  }
  return text.slice(0, maxLen);
}

function guessDeliverableField(text) {
  if (/预算.*表|报价.*表|费用.*明细/.test(text)) return '预算明细表';
  if (/上线计划|试点.*安排|排期/.test(text)) return '上线计划与试点安排';
  if (/操作手册|使用指南|上手指南|培训手册/.test(text)) return '操作手册与上手指南';
  if (/安全|权限.*说明|部署.*方式|架构/.test(text)) return '安全与部署说明';
  if (/数据|指标|统计口径|报表/.test(text)) return '数据指标与口径说明';
  if (/汇报|方案|PPT|演示文稿/.test(text)) return '项目方案与汇报材料';
  if (/截图|页面|原型|界面|效果图/.test(text)) return '界面截图与展示素材';
  return UNSPECIFIED;
}

function guessDueTimeField(text) {
  const m = text.match(/(?:本|下|这)?周[一二三四五六日天](?:前|之前|以前|以内)?|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?(?:前|之前)?|\d{1,2}月\d{1,2}[日号]?(?:前|之前)?|\d{1,2}月底(?:前)?|月底前|今天下班前|明天(?:前|之前)?|会前|汇报前/);
  return m ? m[0] : UNSPECIFIED;
}

function guessFormatField(text) {
  const formats = [];
  if (/excel|xlsx|xls|表格/i.test(text)) formats.push('Excel');
  if (/word|docx/i.test(text)) formats.push('Word');
  if (/ppt|pptx|幻灯片/i.test(text)) formats.push('PPT');
  if (/pdf/i.test(text)) formats.push('PDF');
  if (/markdown|\.md\b/i.test(text)) formats.push('Markdown');
  if (/截图|png|jpg|图片/i.test(text)) formats.push('图片 / 截图');
  if (/视频|mp4|录屏/i.test(text)) formats.push('视频');
  return formats.length ? [...new Set(formats)].join(' / ') : UNSPECIFIED;
}

function guessNotesField(text) {
  const notes = [];
  const tax = text.match(/[^，。；;]*(?:含税|不含税|口径|统计周期|来源)[^，。；;]*/);
  if (tax) notes.push(tax[0].trim());
  const scope = text.match(/[^，。；;]*(?:必须|重点突出|重点说明|覆盖|写清楚|注明|不能|不要)[^，。；;]*/);
  if (scope && (!tax || scope[0].trim() !== tax[0].trim())) notes.push(scope[0].trim());
  return notes.length ? notes.join('；').slice(0, 180) : UNSPECIFIED;
}

function prepareSourceMessages(messages = []) {
  return (Array.isArray(messages) ? messages : [])
    .filter(item => item && typeof item.text === 'string' && item.text.trim())
    .slice(0, 80)
    .map((item, index) => ({
      id: `M-${index + 1}`,
      text: item.text.trim().slice(0, 600),
      source: String(item.source || '导入资料').trim().slice(0, 120),
      date: String(item.date || '未知时间').trim().slice(0, 60),
      speaker: String(item.speaker || '未知').trim().slice(0, 60)
    }));
}

function formatEvidence(sources) {
  if (!sources.length) return '来源未标注';
  const first = sources[0];
  const base = `${first.source} · ${first.date} · ${first.speaker}`;
  return sources.length > 1 ? `${base} 等 ${sources.length} 条记录` : base;
}

function normalizeAnalyzedRequirements(raw, sourceMessages) {
  const list = Array.isArray(raw?.requirements) ? raw.requirements : [];
  if (!list.length) throw new Error('模型未提取出结构化需求条目');
  const byId = new Map(sourceMessages.map(m => [m.id, m]));
  const items = [];
  for (const entry of list) {
    const description = cleanField(entry?.description, 260);
    if (!description || description === UNSPECIFIED) continue;
    const ids = Array.isArray(entry?.sourceIds) ? entry.sourceIds.map(id => String(id).trim()) : [];
    const matched = ids.map(id => byId.get(id)).filter(Boolean);
    const sources = matched.length ? matched : sourceMessages.slice(0, 1);
    const primary = sources[0];
    items.push({
      id: `R-${String(items.length + 1).padStart(2, '0')}`,
      detail: description,
      description,
      notes: cleanField(entry?.notes, 200),
      deliverable: cleanField(entry?.deliverable, 120),
      dueTime: cleanField(entry?.dueTime, 80),
      format: cleanField(entry?.format, 80),
      evidence: formatEvidence(sources),
      source: primary?.source || '导入资料',
      date: primary?.date || '未知',
      speaker: primary?.speaker || '未知',
      rawText: sources.map(s => s.text).join(' / '),
      status: '待确认',
      analyzedBy: 'ai'
    });
  }
  if (!items.length) throw new Error('模型返回的需求描述为空');
  return items;
}

const HINT_WORDS = ['需要', '要求', '必须', '希望', '支持', '提供', '交付', '完成', '上线', '验收', '修改', '增加', '删除', '优化', '截至', '截止', '时间', '数据', '格式', '客户', '不要', '不能', '覆盖', '说明', '补充', '提交', '口径', '手册', '计划', '截图', '审批'];

function ruleAnalyzeRequirements(messages = []) {
  const prepared = prepareSourceMessages(messages);
  const candidates = prepared.filter(m =>
    HINT_WORDS.some(word => m.text.includes(word)) && !/^(收到|好的|明白|了解|ok)[，。!！]?$/i.test(m.text)
  );
  const selected = candidates.length ? candidates : prepared;
  return selected.map((m, index) => ({
    id: `R-${String(index + 1).padStart(2, '0')}`,
    detail: m.text,
    description: m.text,
    notes: guessNotesField(m.text),
    deliverable: guessDeliverableField(m.text),
    dueTime: guessDueTimeField(m.text),
    format: guessFormatField(m.text),
    evidence: formatEvidence([m]),
    source: m.source,
    date: m.date,
    speaker: m.speaker,
    rawText: m.text,
    status: '待确认',
    analyzedBy: 'rules'
  }));
}

async function analyzeRequirements(messages, ask) {
  const prepared = prepareSourceMessages(messages);
  if (!prepared.length) throw new Error('请先导入聊天记录、会议纪要或识别截图后再分析');
  const payload = {
    messages: prepared.map(m => ({ id: m.id, source: m.source, date: m.date, speaker: m.speaker, text: m.text }))
  };
  if (Buffer.byteLength(ANALYZE_PROMPT + JSON.stringify(payload) + JSON.stringify(ANALYZE_SCHEMA)) + 1200 > 18000) {
    // Split into chunks to avoid overflowing local model context.
    const chunks = [];
    for (let i = 0; i < prepared.length; i += 20) chunks.push(prepared.slice(i, i + 20));
    const merged = [];
    for (const chunk of chunks) {
      const raw = await ask(ANALYZE_PROMPT, JSON.stringify({ messages: chunk }), ANALYZE_SCHEMA);
      const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
      merged.push(...normalizeAnalyzedRequirements(parsed, chunk));
    }
    return merged.map((item, idx) => ({ ...item, id: `R-${String(idx + 1).padStart(2, '0')}` }));
  }
  const raw = await ask(ANALYZE_PROMPT, JSON.stringify(payload), ANALYZE_SCHEMA);
  const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
  return normalizeAnalyzedRequirements(parsed, prepared);
}

module.exports = {
  UNSPECIFIED,
  ANALYZE_SCHEMA,
  ANALYZE_PROMPT,
  prepareSourceMessages,
  normalizeAnalyzedRequirements,
  ruleAnalyzeRequirements,
  analyzeRequirements
};
