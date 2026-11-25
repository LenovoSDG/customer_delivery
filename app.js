const state = {
  visionModels: [],
  model: localStorage.getItem('localModel') || 'qwen3:4b'
};

const projectStorageKey = 'deliveryProjects';
const demoProject = {
  id: 'demo',
  name: '凌云办公协同升级',
  customer: '联想办公软件团队',
  owner: '李明',
  savedRules: localStorage.getItem('projectRules') || ''
};

function readProjectMetadata() {
  try {
    const records = JSON.parse(localStorage.getItem(projectStorageKey));
    if (Array.isArray(records) && records.length) return records;
  } catch {}
  return [demoProject];
}

const projects = new Map();
let activeProject;
let activePageName = 'projects';
let reqFilter = 'all';
let materialFilter = 'all';
let pendingDeliverableLink = '';

function saveProjectMetadata(id, changes) {
  const records = new Map(readProjectMetadata().map(item => [item.id, item]));
  const record = { ...records.get(id), ...changes, id };
  records.set(id, record);
  localStorage.setItem(projectStorageKey, JSON.stringify([...records.values()]));
  return record;
}

const $ = selector => document.querySelector(selector);
const $$ = selector => [...document.querySelectorAll(selector)];
const escapeHtml = str => String(str).replace(/[&<>"']/g, ch => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function showToast(message, tone = 'info', durationMs = 3600) {
  const host = $('#toastContainer');
  if (!host) return;
  const item = document.createElement('div');
  item.className = `toast ${tone}`;
  const text = document.createElement('span');
  text.textContent = message;
  const close = document.createElement('button');
  close.type = 'button';
  close.setAttribute('aria-label', '关闭提示');
  close.textContent = '×';
  close.onclick = () => item.remove();
  item.append(text, close);
  host.append(item);
  setTimeout(() => item.remove(), durationMs);
}

function parseChat(text, name) {
  return text
    .split(/\r?\n/)
    .map((line, index) => {
      const trimmed = line.trim();
      if (!trimmed) return null;
      const match = trimmed.match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s*[|｜,，\t]\s*([^|｜,，\t]+)\s*[|｜,，\t]\s*(.*)$/);
      return {
        date: match?.[1] || `第 ${index + 1} 行`,
        speaker: match?.[2]?.trim() || name,
        text: match?.[3]?.trim() || trimmed,
        source: name,
        line: index + 1
      };
    })
    .filter(item => item && item.text);
}

async function fileText(file) {
  if (file.size > 8 * 1024 * 1024) throw new Error(`${file.name} 超过 8 MB 限制`);
  const ext = file.name.split('.').pop().toLowerCase();
  if (['txt', 'md', 'csv', 'json'].includes(ext)) return { text: await file.text() };
  if (!['docx', 'pdf', 'xlsx'].includes(ext)) {
    return { text: '', warning: '该格式只进入材料列表，当前版本不能提取文本参与核验。' };
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  const response = await fetch('/api/parse-file', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: file.name, data: btoa(binary) })
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '文件解析失败');
  if (result.empty) throw new Error(result.warning || `${file.name} 中未提取到文字`);
  return { text: result.text, warning: result.warning };
}

function guessDeliverable(text) {
  if (/预算|报价|费用/.test(text)) return '预算明细表';
  if (/上线|试点|排期|负责人/.test(text)) return '上线计划与试点安排';
  if (/数据|指标|统计|口径/.test(text)) return '数据指标与口径说明';
  if (/汇报|方案|PPT/i.test(text)) return '项目方案与汇报材料';
  if (/图片|页面|展示|截图|审批/.test(text)) return '页面设计与展示素材';
  if (/手册|指南/.test(text)) return '产品操作手册';
  if (/安全|部署|权限/.test(text)) return '安全与部署说明';
  return '客户要求对应交付材料';
}

function guessDueTime(text) {
  const m = String(text || '').match(/(?:本|下|这)?周[一二三四五六日天](?:前|之前|以前|以内)?|\d{4}[-/年]\d{1,2}[-/月]\d{1,2}[日号]?(?:前|之前)?|\d{1,2}月\d{1,2}[日号]?(?:前|之前)?|\d{1,2}月底(?:前)?|月底前|今天下班前|明天(?:前|之前)?|会前|汇报前/);
  return m ? m[0] : '未说明';
}

function guessFormat(text) {
  const formats = [];
  if (/excel|xlsx|xls|表格/i.test(text)) formats.push('Excel');
  if (/word|docx/i.test(text)) formats.push('Word');
  if (/ppt|pptx|幻灯片/i.test(text)) formats.push('PPT');
  if (/pdf/i.test(text)) formats.push('PDF');
  if (/截图|png|jpg|图片/i.test(text)) formats.push('图片 / 截图');
  if (/视频|mp4|录屏/i.test(text)) formats.push('视频');
  return formats.length ? [...new Set(formats)].join(' / ') : '未说明';
}

function guessNotes(text) {
  const notes = [];
  const tax = String(text || '').match(/[^，。；;]*(?:含税|不含税|口径|统计周期|来源)[^，。；;]*/);
  if (tax) notes.push(tax[0].trim());
  const scope = String(text || '').match(/[^，。；;]*(?:必须|重点突出|重点说明|覆盖|写清楚|注明|不要|不能)[^，。；;]*/);
  if (scope && (!tax || scope[0].trim() !== tax[0].trim())) notes.push(scope[0].trim());
  return notes.length ? notes.join('；') : '未说明';
}

function toStructuredRequirement(item, index, analyzedBy = 'rules') {
  const detail = String(item.description || item.detail || item.text || '').trim();
  const field = value => {
    const clean = typeof value === 'string' ? value.trim() : '';
    return clean || '未说明';
  };
  return {
    id: item.id || `R-${String(index + 1).padStart(2, '0')}`,
    detail,
    description: detail,
    notes: field(item.notes ?? (analyzedBy === 'rules' ? guessNotes(detail) : '')),
    deliverable: field(item.deliverable ?? (analyzedBy === 'rules' ? guessDeliverable(detail) : '')),
    dueTime: field(item.dueTime ?? (analyzedBy === 'rules' ? guessDueTime(detail) : '')),
    format: field(item.format ?? (analyzedBy === 'rules' ? guessFormat(detail) : '')),
    evidence: item.evidence || `${item.source || '导入资料'} · ${item.date || '未知'} · ${item.speaker || '未知'}`,
    source: item.source || '导入资料',
    date: item.date || '未知',
    speaker: item.speaker || '未知',
    rawText: item.rawText || detail,
    status: item.status === '已确认' ? '已确认' : '待确认',
    analyzedBy: item.analyzedBy || analyzedBy
  };
}

function requirementsFromChats(chats = activeProject.chats) {
  const hints = ['需要', '要求', '必须', '希望', '支持', '提供', '交付', '完成', '上线', '验收', '修改', '增加', '删除', '优化', '截至', '截止', '时间', '数据', '格式', '客户', '不要', '不能', '覆盖', '说明', '补充', '提交', '口径', '手册', '计划', '截图', '审批'];
  return chats
    .filter(m => hints.some(h => m.text.includes(h)) && !/^(收到|好的|明白|了解)/.test(m.text))
    .map((m, i) => toStructuredRequirement({
      ...m,
      notes: guessNotes(m.text),
      deliverable: /预算|上线|数据|汇报|截图|手册|安全|方案|计划|表/.test(m.text) ? guessDeliverable(m.text) : '未说明',
      dueTime: guessDueTime(m.text),
      format: guessFormat(m.text)
    }, i, 'rules'));
}

function addDirectCandidates(project, messages, analyzedBy = 'ocr') {
  const existing = new Set(project.requirements.map(req => req.rawText || req.detail));
  let added = 0;
  for (const m of messages) {
    const clean = String(m.text || '').trim();
    if (!clean || /^(收到|好的|明白|了解|ok)[，。!！]?$/i.test(clean) || existing.has(clean)) continue;
    const req = toStructuredRequirement({
      ...m,
      notes: '未说明',
      deliverable: '未说明',
      dueTime: guessDueTime(clean),
      format: guessFormat(clean),
      rawText: clean
    }, project.requirements.length, analyzedBy);
    project.requirements.push(req);
    existing.add(clean);
    added++;
  }
  return added;
}

async function addChats(files) {
  const project = activeProject;
  let importedLines = 0;
  for (const file of files) {
    try {
      const parsed = await fileText(file);
      if (parsed.warning) showToast(parsed.warning, 'warning');
      const lines = parseChat(parsed.text, file.name);
      project.chats.push(...lines);
      importedLines += lines.length;
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
  if (importedLines) {
    showToast(`已导入 ${importedLines} 条沟通原文记录，可前往「确认交付清单」分析整理`, 'success');
  }
  refreshProject(project);
}

async function addDocs(files, targetDeliverableId = '') {
  const project = activeProject;
  let addedCount = 0;
  for (const file of files) {
    try {
      const parsed = await fileText(file);
      if (parsed.warning) showToast(parsed.warning, 'warning');
      project.docs.push({
        name: file.name,
        text: parsed.text,
        size: file.size,
        type: file.type || '文件',
        status: '待检查',
        warning: parsed.warning,
        deliverable: targetDeliverableId || ''
      });
      addedCount++;
    } catch (error) {
      showToast(error.message, 'error');
    }
  }
  if (addedCount) {
    showToast(`已上传 ${addedCount} 份交付材料${targetDeliverableId ? '并关联到清单项' : ''}`, 'success');
  }
  refreshProject(project);
}

function projectProgress(project) {
  return {
    total: project.requirements.length,
    confirmed: project.requirements.filter(item => item.status === '已确认').length,
    docs: project.docs.length,
    done: project.docs.filter(item => item.status === '已检查').length
  };
}

function getProjectStatus({ docs, done }) {
  return docs && docs === done ? '待汇报' : '进行中';
}

function registerProject(metadata) {
  const card = $('#projectCardTemplate').content.firstElementChild.cloneNode(true);
  const project = {
    ...metadata,
    card,
    chats: [],
    docs: [],
    requirements: [],
    deliverables: [],
    screenshots: [],
    rules: metadata.savedRules,
    botConnected: false,
    botMessages: [],
    selectedScreenshot: null,
    screenshotPreviewUrl: '',
    screenshotResult: '',
    captureEvents: [],
    captureRoom: '',
    source: 'import',
    captureMode: 'manual'
  };
  card.dataset.projectId = project.id;
  card.querySelector('[data-open-project]').onclick = () => openProject(project);
  card.querySelector('[data-rename-project]').onclick = () => openProjectDialog('rename', project);
  card.querySelector('[data-edit-project]').onclick = () => openProjectDialog('edit', project);
  projects.set(project.id, project);
  $('#projectGrid').append(card);
  return project;
}

function filterProjects() {
  const query = $('#projectSearch').value.trim().toLowerCase();
  const status = $('#projectFilter').value;
  let count = 0;
  for (const project of projects.values()) {
    const { name, customer, card } = project;
    const matchesSearch = [name, customer].some(value => value.toLowerCase().includes(query));
    const visible = matchesSearch && (!status || status === card.querySelector('.project-status').textContent);
    card.classList.toggle('hidden', !visible);
    count += Number(visible);
  }
  $('#projectResultCount').textContent = `${count} 个项目`;
}

function renderProjectCard(project, { total, confirmed, docs, done }) {
  const { card, name, customer, owner } = project;
  card.querySelector('.project-avatar').textContent = String.fromCodePoint(name.codePointAt(0));
  card.querySelector('.project-status').textContent = getProjectStatus({ docs, done });
  card.querySelector('h2').textContent = name;
  card.querySelector('p').textContent = `客户：${customer || '未填写'}`;
  const metrics = card.querySelector('[data-card-metrics]');
  if (metrics) {
    metrics.innerHTML = `<span>资料 <b>${project.chats.length}</b> 条</span><span>清单 <b>${project.deliverables.length}</b> 项</span>`;
  }
  card.querySelector('.card-footer span').textContent = `负责人：${owner || '未分配'}`;
  card.querySelector('[data-open-project]').setAttribute('aria-label', `打开项目：${name}`);
  card.querySelector('[data-rename-project]').setAttribute('aria-label', `重命名项目：${name}`);
  card.querySelector('[data-edit-project]').setAttribute('aria-label', `编辑项目：${name}`);
  card.querySelector('[data-req-progress]').textContent = `${confirmed} / ${total}`;
  card.querySelector('[data-doc-progress]').textContent = `${done} / ${docs}`;
  card.querySelector('.progress-track i').style.width = total ? `${confirmed / total * 100}%` : '0%';
  card.querySelector('.progress-track.blue i').style.width = docs ? `${done / docs * 100}%` : '0%';
}

function renderSidebarSwitcher() {
  const switcher = $('#sideProjectSwitcher');
  if (!switcher) return;
  switcher.replaceChildren(...[...projects.values()].map(p => {
    const opt = new Option(p.name, p.id);
    opt.selected = p === activeProject;
    return opt;
  }));
}

function renderProjects(project = activeProject) {
  const progress = projectProgress(project);
  renderProjectCard(project, progress);
  filterProjects();
  renderSidebarSwitcher();
  if (project !== activeProject) return;

  const { name, customer, owner, chats, botConnected, deliverables } = project;
  const { total, confirmed, docs } = progress;
  const statusText = botConnected ? '聊天同步中' : getProjectStatus(progress);
  $('#sideProjectName').textContent = name;
  $('#projectTitle').textContent = name;
  if ($('#projectStatusInline')) $('#projectStatusInline').textContent = statusText;
  $('#requirementsProjectName').textContent = name;
  $('#projectMeta').textContent = `客户：${customer || '未填写'}　·　负责人：${owner || '未分配'}　·　${statusText}`;
  $('#overviewReqText').textContent = total ? `${confirmed} 项已确认，${total - confirmed} 项待确认` : (chats.length ? `已采集 ${chats.length} 条原文，点击整理清单` : '等待导入客户沟通资料');
  $('#overviewDocText').textContent = docs ? `${docs} 份材料已添加（关联 ${deliverables.length} 个清单项）` : '将材料上传到对应清单项';

  const sourceGroups = new Map();
  for (const msg of chats) {
    sourceGroups.set(msg.source, (sourceGroups.get(msg.source) || 0) + 1);
  }
  $('#chatSummary').textContent = chats.length
    ? `已导入 ${sourceGroups.size} 份资料来源，共 ${chats.length} 条原文记录`
    : '尚未导入聊天记录或会议纪要';

  const sourceList = $('#chatSourceList');
  if (sourceList) {
    sourceList.innerHTML = [...sourceGroups.entries()].map(([src, count]) =>
      `<span class="source-chip"><span>${escapeHtml(src)}</span><b>${count} 条</b></span>`
    ).join('');
  }

  // Update sidebar step badges
  if ($('#navBadgeChats')) $('#navBadgeChats').textContent = String(chats.length);
  if ($('#navBadgeReqs')) $('#navBadgeReqs').textContent = `${confirmed}/${total}`;
  if ($('#navBadgeDocs')) $('#navBadgeDocs').textContent = String(docs);
  if ($('#navBadgeQuality')) $('#navBadgeQuality').textContent = project.review?.issues || '—';
}

function renderFieldValue(value) {
  if (!value || value === '未说明') return '<span class="unspecified">未说明</span>';
  return `<span>${escapeHtml(value)}</span>`;
}

function renderRequirements() {
  const reqs = activeProject.requirements;
  $('#reqCount').textContent = reqs.length;
  $('#deliverableCount').textContent = activeProject.deliverables.length;

  $$('[data-req-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.reqFilter === reqFilter);
  });

  const filtered = reqFilter === 'all' ? reqs : reqs.filter(r => r.status === reqFilter);
  const modeLabels = { ai: 'AI 整理', ocr: 'OCR 原文', rules: '规则预整理', manual: '手动录入', imported: '演示样本' };

  $('#requirementsList').innerHTML = filtered.length
    ? filtered.map(r => `
      <article class="req-card ${r.status === '已确认' ? 'confirmed' : ''}">
        <div class="req-top">
          <div class="req-badges">
            <span class="req-id">${escapeHtml(r.id)}</span>
            <span class="mode-tag">${escapeHtml(modeLabels[r.analyzedBy] || '待审核')}</span>
          </div>
          <span class="status ${r.status === '已确认' ? 'ok' : ''}">${escapeHtml(r.status)}</span>
        </div>
        <div class="req-title">${escapeHtml(r.description || r.detail)}</div>
        <div class="req-fields-grid">
          <div class="req-field"><label>交付物</label>${renderFieldValue(r.deliverable)}</div>
          <div class="req-field"><label>交付时间</label>${renderFieldValue(r.dueTime)}</div>
          <div class="req-field"><label>格式要求</label>${renderFieldValue(r.format)}</div>
          <div class="req-field"><label>注意事项</label>${renderFieldValue(r.notes)}</div>
        </div>
        <div class="req-source">↳ 来源：${escapeHtml(r.evidence)}</div>
        ${r.rawText && r.rawText !== (r.description || r.detail)
          ? `<div class="req-raw-quote">原文：${escapeHtml(r.rawText)}</div>` : ''}
        <div class="req-actions">
          <button class="link-button" type="button" data-confirm="${escapeHtml(r.id)}">${r.status === '已确认' ? '✓ 已纳入清单' : '✓ 确认需求'}</button>
          <button class="link-button muted" type="button" data-edit-req="${escapeHtml(r.id)}">编辑字段</button>
          <button class="link-button muted" type="button" data-remove-req="${escapeHtml(r.id)}">移除</button>
        </div>
      </article>
    `).join('')
    : `<div class="empty-state compact"><div class="empty-symbol">☷</div><b>${reqs.length ? '当前筛选下没有需求' : '还没有需求候选'}</b><span>${reqs.length ? '切换筛选标签查看全部要求。' : '先导入聊天记录、会议纪要或识别截图，再点击「分析客户需求」。'}</span></div>`;

  $$('[data-confirm]').forEach(btn => {
    btn.onclick = () => confirmRequirement(btn.dataset.confirm);
  });
  $$('[data-remove-req]').forEach(btn => {
    btn.onclick = () => {
      activeProject.requirements = activeProject.requirements.filter(x => x.id !== btn.dataset.removeReq);
      update();
    };
  });
  $$('[data-edit-req]').forEach(btn => {
    btn.onclick = () => openRequirementDialog(btn.dataset.editReq);
  });

  renderDeliverables();
}

function confirmRequirement(reqId) {
  const r = activeProject.requirements.find(x => x.id === reqId);
  if (!r) return;
  r.status = '已确认';
  if (!activeProject.deliverables.some(d => d.requirement === r.id)) {
    const deliverableName = r.deliverable && r.deliverable !== '未说明'
      ? r.deliverable : guessDeliverable(r.detail);
    const stdParts = ['覆盖该客户要求，并提供可核验依据'];
    if (r.notes && r.notes !== '未说明') stdParts.push(`注意：${r.notes}`);
    activeProject.deliverables.push({
      id: `D-${String(activeProject.deliverables.length + 1).padStart(2, '0')}`,
      name: deliverableName,
      standard: stdParts.join('；'),
      dueTime: r.dueTime || '未说明',
      format: r.format || '未说明',
      owner: activeProject.owner,
      requirement: r.id,
      status: '待提交'
    });
  }
  update();
}

function renderDeliverables() {
  const deliverables = activeProject.deliverables;
  $('#deliverablesList').innerHTML = deliverables.length
    ? deliverables.map(d => {
        const linkedDocs = activeProject.docs.filter(doc => doc.deliverable === d.id);
        const statusLabel = linkedDocs.length
          ? (linkedDocs.every(doc => doc.status === '已检查') ? '已检查' : '已提交材料')
          : d.status;
        return `
          <article class="deliverable-card">
            <div class="deliverable-index">${escapeHtml(d.id)}</div>
            <div class="deliverable-body">
              <div class="deliverable-head">
                <b>${escapeHtml(d.name)}</b>
                <span class="status ${linkedDocs.length ? 'ok' : ''}">${escapeHtml(statusLabel)}</span>
              </div>
              <div class="deliverable-meta">
                <span>关联需求：${escapeHtml(d.requirement || '手动添加')}</span>
                <span>交付时间：${escapeHtml(d.dueTime || '未说明')}</span>
                <span>格式：${escapeHtml(d.format || '未说明')}</span>
                <span>负责人：${escapeHtml(d.owner || '待分配')}</span>
              </div>
              <p>验收标准：${escapeHtml(d.standard)} · <b>${linkedDocs.length ? `已关联 ${linkedDocs.length} 份材料` : '尚未上传材料'}</b></p>
              <div class="deliverable-actions">
                <button class="link-button" type="button" data-upload-for-del="${escapeHtml(d.id)}">＋ 上传材料至此项</button>
                <button class="link-button muted" type="button" data-edit-del="${escapeHtml(d.id)}">编辑清单项</button>
                <button class="link-button muted" type="button" data-remove-del="${escapeHtml(d.id)}">移除</button>
              </div>
            </div>
          </article>
        `;
      }).join('')
    : `<div class="empty-state compact"><div class="empty-symbol">☑</div><b>确认需求后生成交付清单</b><span>可设置交付物、交付时间、格式要求、负责人与验收标准。</span></div>`;

  $$('[data-edit-del]').forEach(btn => {
    btn.onclick = () => openDeliverableDialog(btn.dataset.editDel);
  });
  $$('[data-remove-del]').forEach(btn => {
    btn.onclick = () => {
      const id = btn.dataset.removeDel;
      activeProject.deliverables = activeProject.deliverables.filter(x => x.id !== id);
      activeProject.docs.forEach(doc => { if (doc.deliverable === id) doc.deliverable = ''; });
      update();
    };
  });
  $$('[data-upload-for-del]').forEach(btn => {
    btn.onclick = () => {
      pendingDeliverableLink = btn.dataset.uploadForDel;
      $('#docInput').click();
    };
  });
}

function renderMaterials() {
  const docs = activeProject.docs;
  const deliverables = activeProject.deliverables;

  $('#materialCount').textContent = docs.length;
  $('#qualityDocs').textContent = docs.length;
  if ($('#materialPendingCount')) $('#materialPendingCount').textContent = docs.filter(d => d.status === '待检查').length;
  if ($('#materialDoneCount')) $('#materialDoneCount').textContent = docs.filter(d => d.status === '已检查').length;
  if ($('#materialUnlinkedCount')) $('#materialUnlinkedCount').textContent = docs.filter(d => !d.deliverable).length;

  $$('[data-mat-filter]').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.matFilter === materialFilter);
  });

  // Render checklist slots matrix
  const slotsHost = $('#deliverableSlots');
  const slotSummary = $('#slotCoverageSummary');
  if (slotsHost && slotSummary) {
    if (!deliverables.length) {
      slotSummary.textContent = '尚未确认生成交付清单项';
      slotsHost.innerHTML = '<div class="muted-hint">可先在「确认交付清单」确认客户需求或手动添加清单项，再将材料挂载到对应清单项。</div>';
    } else {
      const coveredSlots = deliverables.filter(del => docs.some(doc => doc.deliverable === del.id)).length;
      slotSummary.textContent = `清单项材料覆盖：${coveredSlots} / ${deliverables.length}`;
      slotsHost.innerHTML = deliverables.map(del => {
        const linked = docs.filter(doc => doc.deliverable === del.id);
        return `
          <div class="slot-card ${linked.length ? 'covered' : ''}">
            <div class="slot-card-top">
              <b>${escapeHtml(del.id)} · ${escapeHtml(del.name)}</b>
              <span class="status ${linked.length ? 'ok' : ''}">${linked.length ? `${linked.length} 份` : '缺材料'}</span>
            </div>
            <div class="slot-files">${linked.length ? linked.map(f => escapeHtml(f.name)).join('、') : `要求格式：${escapeHtml(del.format || '未说明')} · 截止：${escapeHtml(del.dueTime || '未说明')}`}</div>
            <div><button class="link-button" type="button" data-slot-upload="${escapeHtml(del.id)}">＋ 上传到此清单项</button></div>
          </div>
        `;
      }).join('');
      $$('[data-slot-upload]').forEach(btn => {
        btn.onclick = () => {
          pendingDeliverableLink = btn.dataset.slotUpload;
          $('#docInput').click();
        };
      });
    }
  }

  const indexedDocs = docs.map((d, index) => ({ doc: d, index }));
  const filtered = indexedDocs.filter(({ doc }) => {
    if (materialFilter === '待检查') return doc.status === '待检查';
    if (materialFilter === '已检查') return doc.status === '已检查';
    if (materialFilter === 'unlinked') return !doc.deliverable;
    return true;
  });

  $('#materialsList').innerHTML = filtered.length
    ? filtered.map(({ doc: d, index: i }) => {
        const isImg = /image/i.test(d.type) || /\.(png|jpe?g|webp)$/i.test(d.name);
        const isVideo = /video/i.test(d.type) || /\.(mp4|webm)$/i.test(d.name);
        const lineCount = d.text?.trim() ? d.text.replace(/\r\n?/g, '\n').split('\n').length : 0;
        const extractBadge = lineCount ? `已提取 ${lineCount} 行文本` : (d.warning || '非文本附件，不参与正文核验');
        return `
          <article class="material-card">
            <div class="material-type">${isImg ? '▧' : isVideo ? '▷' : '▤'}</div>
            <div class="material-info">
              <b title="${escapeHtml(d.name)}">${escapeHtml(d.name)}</b>
              <small>${(d.size / 1024).toFixed(1)} KB · ${escapeHtml(extractBadge)}</small>
              <select data-link-doc="${i}" aria-label="关联交付清单项">
                <option value="">关联交付清单项（未指定）</option>
                ${deliverables.map(x => `<option ${d.deliverable === x.id ? 'selected' : ''} value="${escapeHtml(x.id)}">${escapeHtml(x.id)} · ${escapeHtml(x.name)}</option>`).join('')}
              </select>
            </div>
            <div class="material-card-actions">
              <span class="status ${d.status === '已检查' ? 'ok' : ''}">${escapeHtml(d.status)}</span>
              <div class="material-sub-actions">
                ${lineCount ? `<button class="link-button" type="button" data-preview-doc="${i}">预览行号</button>` : ''}
                <button class="link-button muted" type="button" data-remove-doc="${i}">移除</button>
              </div>
            </div>
          </article>
        `;
      }).join('')
    : `<div class="empty-state wide"><div class="empty-symbol">▤</div><b>${docs.length ? '当前筛选下没有材料' : '还没有上传交付材料'}</b><span>${docs.length ? '可切换其他材料筛选标签查看全部文件。' : '上传文件后，为材料关联清单项并运行质量检查。'}</span>${docs.length ? '' : '<button class="secondary" id="emptyUpload" type="button">选择项目文件</button>'}</div>`;

  $('#emptyUpload')?.addEventListener('click', () => $('#docInput').click());
  $$('[data-link-doc]').forEach(select => {
    select.onchange = () => {
      activeProject.docs[Number(select.dataset.linkDoc)].deliverable = select.value;
      update();
    };
  });
  $$('[data-remove-doc]').forEach(btn => {
    btn.onclick = () => {
      activeProject.docs.splice(Number(btn.dataset.removeDoc), 1);
      update();
    };
  });
  $$('[data-preview-doc]').forEach(btn => {
    btn.onclick = () => openMaterialPreview(Number(btn.dataset.previewDoc));
  });
}

function openMaterialPreview(docOrName, lineStart = 0, lineEnd = 0) {
  const drawer = $('#materialPreviewDrawer');
  if (!drawer) return;
  const doc = typeof docOrName === 'number'
    ? activeProject.docs[docOrName]
    : activeProject.docs.find(d => d.name === docOrName);
  if (!doc || !doc.text?.trim()) {
    showToast('当前材料无可预览的提取文本', 'warning');
    return;
  }
  const lines = doc.text.replace(/\r\n?/g, '\n').split('\n');
  $('#previewDrawerTitle').textContent = doc.name;
  $('#previewDrawerMeta').textContent = `共 ${lines.length} 行` + (lineStart ? ` · 已定位第 ${lineStart}${lineEnd > lineStart ? '–' + lineEnd : ''} 行` : '');
  $('#previewDrawerBody').innerHTML = lines.map((line, idx) => {
    const ln = idx + 1;
    const hit = lineStart && ln >= lineStart && ln <= (lineEnd || lineStart);
    return `<div class="preview-line ${hit ? 'highlighted' : ''}" data-line="${ln}"><span class="preview-ln">${ln}</span><span class="preview-text">${escapeHtml(line || ' ')}</span></div>`;
  }).join('');
  drawer.classList.remove('hidden');
  if (lineStart) {
    const target = drawer.querySelector(`[data-line="${lineStart}"]`);
    target?.scrollIntoView?.({ block: 'center', behavior: 'smooth' });
  }
}

$('#closePreviewDrawer')?.addEventListener('click', () => {
  $('#materialPreviewDrawer').classList.add('hidden');
});

window.openMaterialPreview = openMaterialPreview;
window.showToast = showToast;

function update() {
  renderProjects();
  renderRequirements();
  renderMaterials();
  $('#qualityReqs').textContent = activeProject.requirements.filter(r => r.status === '已确认').length;
}

function page(name) {
  activePageName = name;
  $$('.page').forEach(p => p.classList.toggle('active', p.id === `page-${name}`));
  $$('[data-page]').forEach(b => b.classList.toggle('active', b.dataset.page === name));
  const names = {
    projects: '项目列表',
    project: '采集客户需求',
    requirements: '确认交付清单',
    materials: '交付材料',
    quality: '质量检查',
    rehearsal: '演练与复盘'
  };
  $('#breadcrumbCurrent').textContent = names[name] || '项目概览';
  const contextBar = $('#projectContextBar');
  if (contextBar) {
    contextBar.classList.toggle('hidden', name === 'projects');
  }
  if (['project', 'requirements', 'materials', 'quality', 'rehearsal'].includes(name)) {
    $$('.step').forEach(s => s.classList.toggle('active', s.dataset.page === name));
  }
  window.scrollTo(0, 0);
}

$$('[data-page]').forEach(b => { b.onclick = () => page(b.dataset.page); });
$$('[data-next]').forEach(b => { b.onclick = () => page(b.dataset.next); });
$('#sideProjectSwitcher')?.addEventListener('change', event => {
  const target = projects.get(event.target.value);
  if (target) openProject(target, activePageName === 'projects' ? 'project' : activePageName);
});

function refreshProject(project) {
  if (activeProject === project) update();
  else renderProjects(project);
}

function openProject(project, targetPage = 'project') {
  if (activeProject !== project) {
    activeProject = project;
    $('#rules').value = project.rules;
    $('#saveRules').textContent = '保存规范';
    renderProjectSources();
    update();
    window.dispatchEvent(new Event('project-changed'));
  }
  page(targetPage);
}

// ---------- Dialog: Project Create / Rename / Edit ----------
const projectDialog = $('#projectDialog');
const projectForm = $('#projectForm');
const projectNameInput = $('#projectNameInput');
const projectCustomerInput = $('#projectCustomerInput');
const projectOwnerInput = $('#projectOwnerInput');
const projectFormError = $('#projectFormError');
const projectDialogTitles = { create: '新增项目', rename: '重命名项目', edit: '编辑项目' };
let projectBeingEdited = null;
let projectDialogMode = 'create';

$$('[data-close-project]').forEach(button => {
  button.onclick = () => projectDialog.close('cancel');
});

function openProjectDialog(mode, project = null) {
  projectDialogMode = mode;
  projectBeingEdited = project;
  $('#projectDialogTitle').textContent = projectDialogTitles[mode];
  $('#saveProject').textContent = project ? '保存' : '创建项目';
  projectNameInput.value = project?.name || '';
  projectCustomerInput.value = project?.customer || '';
  projectOwnerInput.value = project?.owner || '';
  $('#projectDetailsFields').hidden = mode === 'rename';
  projectFormError.hidden = true;
  projectDialog.showModal();
}

$('#newProject').onclick = () => openProjectDialog('create');
$('#editProject').onclick = () => openProjectDialog('edit', activeProject);
projectForm.addEventListener('submit', event => {
  event.preventDefault();
  const name = projectNameInput.value.trim();
  if (!name) return;

  const changes = { name };
  if (projectDialogMode !== 'rename') {
    changes.customer = projectCustomerInput.value.trim();
    changes.owner = projectOwnerInput.value.trim() || '待分配';
  }
  if (!projectBeingEdited) changes.savedRules = '';

  let record;
  try {
    record = saveProjectMetadata(projectBeingEdited?.id || crypto.randomUUID(), changes);
  } catch {
    projectFormError.textContent = '浏览器无法保存项目，请检查本地存储空间后重试。';
    projectFormError.hidden = false;
    return;
  }
  projectDialog.close();
  if (projectBeingEdited) {
    Object.assign(projectBeingEdited, record);
    renderProjects(projectBeingEdited);
  } else {
    const project = registerProject(record);
    $('#projectSearch').value = '';
    $('#projectFilter').value = '';
    openProject(project);
  }
});

// ---------- Dialog: Structured Requirement Edit / Add ----------
const requirementDialog = $('#requirementDialog');
let editingReqId = null;

$$('[data-close-req]').forEach(btn => {
  btn.onclick = () => requirementDialog.close('cancel');
});

function openRequirementDialog(reqId = null) {
  editingReqId = reqId;
  const req = reqId ? activeProject.requirements.find(r => r.id === reqId) : null;
  $('#requirementDialogTitle').textContent = req ? `编辑要求 ${req.id}` : '手动补充客户要求';
  $('#reqFieldDesc').value = req?.description || req?.detail || '';
  $('#reqFieldDeliverable').value = req?.deliverable && req.deliverable !== '未说明' ? req.deliverable : '';
  $('#reqFieldDueTime').value = req?.dueTime && req.dueTime !== '未说明' ? req.dueTime : '';
  $('#reqFieldFormat').value = req?.format && req.format !== '未说明' ? req.format : '';
  $('#reqFieldNotes').value = req?.notes && req.notes !== '未说明' ? req.notes : '';
  $('#reqFieldEvidence').value = req?.evidence || '手动录入';
  requirementDialog.showModal();
}

$('#addRequirementManual')?.addEventListener('click', () => openRequirementDialog(null));
$('#requirementForm')?.addEventListener('submit', event => {
  event.preventDefault();
  const desc = $('#reqFieldDesc').value.trim();
  if (!desc) return;
  const norm = v => v.trim() || '未说明';
  if (editingReqId) {
    const req = activeProject.requirements.find(r => r.id === editingReqId);
    if (req) {
      req.detail = desc;
      req.description = desc;
      req.deliverable = norm($('#reqFieldDeliverable').value);
      req.dueTime = norm($('#reqFieldDueTime').value);
      req.format = norm($('#reqFieldFormat').value);
      req.notes = norm($('#reqFieldNotes').value);
      req.evidence = $('#reqFieldEvidence').value.trim() || req.evidence;
    }
  } else {
    activeProject.requirements.push(toStructuredRequirement({
      description: desc,
      deliverable: norm($('#reqFieldDeliverable').value),
      dueTime: norm($('#reqFieldDueTime').value),
      format: norm($('#reqFieldFormat').value),
      notes: norm($('#reqFieldNotes').value),
      evidence: $('#reqFieldEvidence').value.trim() || '手动录入',
      rawText: desc
    }, activeProject.requirements.length, 'manual'));
  }
  requirementDialog.close();
  update();
  showToast('要求已保存', 'success');
});

// ---------- Dialog: Add / Edit Deliverable ----------
const deliverableDialog = $('#deliverableDialog');
let editingDelId = null;

$$('[data-close-del]').forEach(btn => {
  btn.onclick = () => deliverableDialog.close('cancel');
});

function openDeliverableDialog(delId = null) {
  editingDelId = delId;
  const del = delId ? activeProject.deliverables.find(d => d.id === delId) : null;
  $('#deliverableDialogTitle').textContent = del ? `编辑交付清单项 ${del.id}` : '添加交付清单项';
  $('#deliverableName').value = del?.name || '';
  $('#deliverableDueTime').value = del?.dueTime || '';
  $('#deliverableFormat').value = del?.format || '';
  $('#deliverableStandard').value = del?.standard || '';
  $('#deliverableOwner').value = del?.owner || activeProject.owner || '';
  deliverableDialog.showModal();
}

$('#addDeliverable').onclick = () => openDeliverableDialog(null);
$('#deliverableForm').addEventListener('submit', event => {
  event.preventDefault();
  const name = $('#deliverableName').value.trim();
  if (!name) return;
  const payload = {
    name,
    dueTime: $('#deliverableDueTime').value.trim() || '未说明',
    format: $('#deliverableFormat').value.trim() || '未说明',
    standard: $('#deliverableStandard').value.trim() || '待补充验收标准',
    owner: $('#deliverableOwner').value.trim() || '待分配'
  };
  if (editingDelId) {
    const target = activeProject.deliverables.find(d => d.id === editingDelId);
    if (target) Object.assign(target, payload);
  } else {
    activeProject.deliverables.push({
      id: `D-${String(activeProject.deliverables.length + 1).padStart(2, '0')}`,
      ...payload,
      status: '待提交'
    });
  }
  $('#deliverableForm').reset();
  deliverableDialog.close();
  update();
});

// ---------- Sources, Drag & Drop, Paste & OCR ----------
function renderProjectSources() {
  const project = activeProject;
  $$('.choice').forEach(button => button.classList.toggle('active', button.dataset.source === project.source));
  for (const source of ['import', 'bot', 'screenshot']) {
    $(`#${source}Panel`).classList.toggle('hidden', source !== project.source);
  }
  $$('input[name="captureMode"]').forEach(input => { input.checked = input.value === project.captureMode; });
  $('#targetCapture').classList.toggle('hidden', project.captureMode !== 'targeted');
  $('#captureRoom').value = project.captureRoom;
  $('#captureEvents').innerHTML = project.captureEvents.map(renderCaptureEvent).join('');
  $('#botConnection').classList.toggle('hidden', !project.botConnected);
  $('.bot-config').classList.toggle('hidden', project.botConnected);
  const rooms = [`${project.name}项目群`, `${project.name}评审群`];
  $('#botRoom').replaceChildren(...rooms.map(room => new Option(room)));
  $('#botDetail').textContent = `授权范围：${project.botRoom || rooms[0]}`;
  $('#botMessages').innerHTML = project.botMessages.length
    ? project.botMessages.map(message => `<article class="bot-message"><div><b>${escapeHtml(message.speaker)}</b><time>${escapeHtml(message.date)}</time></div><p>${escapeHtml(message.text)}</p><span class="message-tag">新消息 · 已进入需求候选区</span></article>`).join('')
    : '<div class="bot-empty">连接后，项目群新消息会显示在这里。</div>';
  renderScreenshot();
  renderCaptureStatus();
}

$$('.choice').forEach(button => {
  button.onclick = () => {
    activeProject.source = button.dataset.source;
    renderProjectSources();
    if (activeProject.source === 'screenshot') refreshVisionModels();
  };
});

$$('input[name="captureMode"]').forEach(input => {
  input.onchange = () => {
    activeProject.captureMode = input.value;
    $('#targetCapture').classList.toggle('hidden', input.value !== 'targeted');
  };
});

$('#captureRoom').oninput = event => { activeProject.captureRoom = event.target.value; };

for (const [button, input, upload] of [
  ['chatPick', 'chatInput', addChats],
  ['docPick', 'docInput', files => { const target = pendingDeliverableLink; pendingDeliverableLink = ''; return addDocs(files, target); }]
]) {
  $(`#${button}`).onclick = () => $(`#${input}`).click();
  $(`#${input}`).onchange = event => {
    const files = [...event.target.files];
    event.target.value = '';
    return upload(files);
  };
}
$('#docPickAlt')?.addEventListener('click', () => $('#docInput').click());

// Drag and drop zones
function bindDropzone(el, onFiles) {
  if (!el) return;
  ['dragenter', 'dragover'].forEach(ev => el.addEventListener(ev, e => {
    e.preventDefault();
    el.classList.add('drag-over');
  }));
  ['dragleave', 'drop'].forEach(ev => el.addEventListener(ev, e => {
    e.preventDefault();
    el.classList.remove('drag-over');
  }));
  el.addEventListener('drop', e => {
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length) onFiles(files);
  });
}

bindDropzone($('#chatDropzone'), addChats);
bindDropzone($('#materialDropzone'), files => addDocs(files));
bindDropzone($('#screenshotDropzone'), files => {
  const img = files.find(f => /^image\/(png|jpeg|webp)/i.test(f.type) || /\.(png|jpe?g|webp)$/i.test(f.name));
  if (img) selectScreenshotFile(img);
  else showToast('请拖入 PNG / JPG / WEBP 格式截图', 'warning');
});

// Direct text paste panel
$('#togglePasteBox')?.addEventListener('click', () => {
  $('#pasteSourceBox').classList.toggle('hidden');
});

$('#addRawPaste')?.addEventListener('click', () => {
  const raw = $('#pasteRawInput').value.trim();
  if (!raw) {
    showToast('请先粘贴聊天记录、会议纪要或转录内容', 'warning');
    return;
  }
  const sourceType = $('#pasteSourceType').value || '粘贴资料';
  const speaker = $('#pasteSpeaker').value.trim();
  const parsed = parseChat(raw, sourceType).map(m => ({
    ...m,
    speaker: speaker && m.speaker === sourceType ? speaker : m.speaker
  }));
  activeProject.chats.push(...parsed);
  const added = addDirectCandidates(activeProject, parsed, 'ocr');
  $('#pasteRawInput').value = '';
  refreshProject(activeProject);
  showToast(`已导入 ${parsed.length} 条原文（${added} 条已进入需求候选区）`, 'success');
});

// PRD file import & quick template chips
$('#prdPick')?.addEventListener('click', () => $('#prdInput').click());
$('#prdInput')?.addEventListener('change', async event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  try {
    const parsed = await fileText(file);
    if (parsed.warning) showToast(parsed.warning, 'warning');
    const current = $('#rules').value.trim();
    const next = current ? `${current}\n\n【PRD：${file.name}】\n${parsed.text}` : `【PRD：${file.name}】\n${parsed.text}`;
    $('#rules').value = activeProject.rules = next;
    showToast(`已导入 PRD 文件 ${file.name}`, 'success');
  } catch (error) {
    showToast(error.message, 'error');
  }
});

$$('[data-rule-tpl]').forEach(btn => {
  btn.onclick = () => {
    const tpl = btn.dataset.ruleTpl;
    const current = $('#rules').value.trim();
    if (current.includes(tpl)) return;
    $('#rules').value = activeProject.rules = current ? `${current}\n${tpl}` : tpl;
  };
});

// Screenshot handling & clipboard paste
function selectScreenshotFile(file) {
  if (file.size > 8 * 1024 * 1024) {
    showToast('截图最大支持 8 MB', 'error');
    return;
  }
  if (activeProject.screenshotPreviewUrl) {
    URL.revokeObjectURL?.(activeProject.screenshotPreviewUrl);
  }
  activeProject.selectedScreenshot = file;
  activeProject.screenshotPreviewUrl = typeof URL.createObjectURL === 'function' ? URL.createObjectURL(file) : '';
  activeProject.screenshotResult = '';
  renderScreenshot();
}

function renderScreenshot() {
  const { selectedScreenshot, screenshotPreviewUrl, screenshotResult, screenshotPending } = activeProject;
  $('#screenshotName').textContent = selectedScreenshot?.name || '支持选择、拖拽或直接 Ctrl/Cmd + V 粘贴截图';
  $('#screenshotPick').disabled = Boolean(screenshotPending);
  $('#recognizeScreenshot').disabled = !selectedScreenshot || Boolean(screenshotPending);
  $('#recognizeScreenshot').textContent = screenshotPending ? '正在本地识别…' : '本地 OCR 识别';
  const wrap = $('#screenshotPreviewWrap');
  const img = $('#screenshotPreviewImg');
  if (wrap && img) {
    wrap.classList.toggle('hidden', !screenshotPreviewUrl);
    if (screenshotPreviewUrl) img.src = screenshotPreviewUrl;
  }
  $('#screenshotResult').innerHTML = screenshotResult;
  $('#screenshotResult').classList.toggle('hidden', !screenshotResult);
}

$('#screenshotPick').onclick = () => $('#screenshotInput').click();
$('#screenshotInput').onchange = event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (file) selectScreenshotFile(file);
};

document.addEventListener('paste', event => {
  if (activePageName !== 'project' || activeProject.source !== 'screenshot') return;
  const items = [...(event.clipboardData?.items || [])];
  const imgItem = items.find(item => item.type.startsWith('image/'));
  if (!imgItem) return;
  const blob = imgItem.getAsFile();
  if (!blob) return;
  const file = new File([blob], `粘贴截图_${Date.now()}.png`, { type: blob.type || 'image/png' });
  selectScreenshotFile(file);
  showToast('已从剪贴板读取截图，点击「本地 OCR 识别」即可提取原文', 'info');
});

async function refreshVisionModels() {
  const select = $('#visionModel');
  select.innerHTML = '<option value="">正在检测本机视觉模型…</option>';
  try {
    const result = await (await fetch('/api/health')).json();
    state.visionModels = (result.models || []).filter(model => /vl|vision|llava|minicpm-v|moondream/i.test(model));
    select.innerHTML = state.visionModels.length
      ? state.visionModels.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')
      : '<option value="">未发现本机视觉模型</option>';
  } catch {
    select.innerHTML = '<option value="">无法连接 Ollama</option>';
  }
}

let lastCaptureEvent = 0;
let captureStatus = null;
let captureRequestPending = false;
let capturePollPending = false;

function renderCaptureStatus() {
  const { active, projectId, title, group, intervalSec, lastCheck, lastError } = captureStatus || {};
  const ownsCapture = active && projectId === activeProject.id;
  $('#globalCaptureBadge').classList.toggle('hidden', !active);
  $('#startWechatCapture').disabled = captureRequestPending || Boolean(active && !ownsCapture);
  $('#stopWechatCapture').disabled = captureRequestPending || !ownsCapture;
  if (ownsCapture) {
    $('#captureStatus').textContent = `监测中 · ${title} · 会话：${group} · 每 ${intervalSec} 秒` +
      (lastCheck ? ` · 最近检查 ${new Date(lastCheck).toLocaleTimeString()}` : '') + (lastError ? ` · ${lastError}` : '');
  } else if (active) {
    $('#captureStatus').textContent = '另一项目正在监测桌面窗口，请先在该项目中停止监测。';
  } else {
    $('#captureStatus').textContent = activeProject.captureMessage || '尚未开始监测';
  }
}

async function refreshWechatWindows() {
  const select = $('#wechatWindow');
  select.innerHTML = '<option value="">正在查找微信 / Teams 窗口…</option>';
  try {
    const result = await (await fetch('/api/wechat/windows')).json();
    select.innerHTML = result.windows?.length
      ? result.windows.map((win, index) => `<option value="${escapeHtml(win.hwnd)}">${win.app ? `[${escapeHtml(win.app)}] ` : ''}${escapeHtml(win.title || `桌面窗口 ${index + 1}`)} · ${escapeHtml(win.process)}</option>`).join('')
      : `<option value="">${escapeHtml(result.error || '未发现已打开的微信或 Teams 窗口')}</option>`;
  } catch {
    select.innerHTML = '<option value="">无法读取桌面窗口</option>';
  }
}

$('#refreshWechatWindows').onclick = refreshWechatWindows;
$('#startWechatCapture').onclick = async () => {
  const project = activeProject;
  const model = $('#visionModel').value;
  const hwnd = $('#wechatWindow').value;
  const group = project.captureRoom.trim();
  const error = !hwnd ? '请先刷新并选择微信或 Teams 窗口'
    : group.length < 2 ? '请填写准确的目标群聊或频道名称'
    : !model ? '需要先安装并选择本地视觉模型' : '';
  if (error) {
    $('#captureStatus').textContent = error;
    return;
  }

  captureRequestPending = true;
  renderCaptureStatus();
  try {
    const response = await fetch('/api/wechat/capture/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hwnd, group, model, intervalSec: $('#captureInterval').value, projectId: project.id })
    });
    const result = await response.json();
    if (!response.ok || !result.active) throw new Error(result.error || '监测未能启动');
    captureStatus = result;
    project.captureMessage = '';
    showToast(`已启动桌面窗口监测：${group}`, 'success');
  } catch (err) {
    project.captureMessage = err.message;
  } finally {
    captureRequestPending = false;
    renderCaptureStatus();
  }
};

$('#stopWechatCapture').onclick = async () => {
  const project = activeProject;
  captureRequestPending = true;
  renderCaptureStatus();
  try {
    const response = await fetch(`/api/wechat/capture/stop?projectId=${encodeURIComponent(project.id)}`, { method: 'POST' });
    if (!response.ok) throw new Error((await response.json()).error || '监测未能停止');
    captureStatus = { ...captureStatus, active: false };
    project.captureMessage = '监测已停止';
  } catch (err) {
    project.captureMessage = err.message;
    if (captureStatus) captureStatus.lastError = err.message;
  } finally {
    captureRequestPending = false;
    renderCaptureStatus();
  }
};

function renderCaptureEvent({ group, at, url, messages }) {
  const image = `<a href="${escapeHtml(url)}" target="_blank" rel="noreferrer">查看已保存截图</a>`;
  return `<article class="capture-event"><div><b>${escapeHtml(group)}</b><time>${new Date(at).toLocaleTimeString()}</time></div><small>${messages.length} 条新消息 · ${image}</small>${messages.map(message => `<p><b>${escapeHtml(message.speaker)}</b>：${escapeHtml(message.text)}</p>`).join('')}</article>`;
}

function addMessageRequirements(project, messages) {
  addDirectCandidates(project, messages, 'ocr');
}

async function pollCapture() {
  if (capturePollPending || captureRequestPending) return;
  capturePollPending = true;
  const previous = captureStatus;
  try {
    const status = await (await fetch(`/api/wechat/capture/status?after=${lastCaptureEvent}`)).json();
    if (!captureRequestPending && captureStatus === previous) {
      if (previous?.active && !status.active) {
        const project = projects.get(previous.projectId);
        if (project) project.captureMessage = status.lastError || '监测已停止';
      }
      captureStatus = status;
      renderCaptureStatus();
    }
    for (const event of status.events || []) {
      lastCaptureEvent = Math.max(lastCaptureEvent, event.id);
      const project = projects.get(event.projectId);
      if (!project) continue;
      const source = `桌面截图 · ${event.group}`;
      const messages = event.messages.map(message => ({
        date: message.time,
        speaker: message.speaker,
        text: message.text,
        source: `${source} · ${event.file}`
      }));
      project.chats.push(...messages);
      project.screenshots.push({ name: event.file, source, count: messages.length });
      addDirectCandidates(project, messages, 'ocr');
      project.captureEvents.unshift(event);
      if (project === activeProject) $('#captureEvents').insertAdjacentHTML('afterbegin', renderCaptureEvent(event));
      refreshProject(project);
    }
  } catch {
  } finally {
    capturePollPending = false;
  }
}

setInterval(pollCapture, 2500);
$('#refreshVisionModels').onclick = refreshVisionModels;

$('#recognizeScreenshot').onclick = async () => {
  const project = activeProject;
  const file = project.selectedScreenshot;
  const model = $('#visionModel').value;
  if (!file) return;
  if (!model) {
    project.screenshotResult = '<b>本机没有可用的视觉模型</b><p>请选择支持图片输入的 Ollama 模型，或载入演示 OCR 结果。</p>';
    renderScreenshot();
    return;
  }
  const source = project.captureMode === 'targeted' ? `桌面窗口 · ${project.captureRoom || '未填写群聊'}` : '用户手动截图';
  project.screenshotPending = true;
  renderScreenshot();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) {
      binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    }
    const response = await fetch('/api/recognize-image', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, data: btoa(binary), source })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const messages = parseChat(result.text, `截图：${source}`);
    project.chats.push(...messages);
    project.screenshots.push({ name: file.name, source, count: messages.length });
    const added = addDirectCandidates(project, messages, 'ocr');
    project.screenshotResult = `<b>OCR 识别完成 · ${escapeHtml(model)}</b><p>${escapeHtml(result.text || '未识别到清晰消息')}</p><small>来源：${escapeHtml(source)} · 识别 ${messages.length} 条原文，${added} 条已直接进入需求候选区</small>`;
    refreshProject(project);
  } catch (error) {
    project.screenshotResult = `<b>识别失败</b><p>${escapeHtml(error.message)}</p>`;
  } finally {
    project.screenshotPending = false;
    if (project === activeProject) renderScreenshot();
  }
};

$('#loadScreenshotDemo').onclick = () => {
  const project = activeProject;
  const source = project.captureMode === 'targeted' ? `桌面截图 · ${project.captureRoom || `${project.name}项目群`}` : '用户手动截图';
  const message = {
    date: '2026-11-22 10:24',
    speaker: '客户王经理',
    text: '汇报材料请增加移动端审批页面截图，预算明细表按含税口径用 Excel 在周五前发给我们。',
    source: `截图OCR：${source}`
  };
  project.chats.push(message);
  project.screenshots.push({ name: '本地截图_演示.png', source, count: 1 });
  addDirectCandidates(project, [message], 'ocr');
  project.screenshotResult = `<b>演示 OCR 结果 · 原文已直达需求候选区</b><p>${escapeHtml(message.text)}</p><small>来源：${escapeHtml(message.source)} · 点击「确认交付清单」中的「分析客户需求」可自动结构化字段</small>`;
  renderScreenshot();
  update();
};

$('#connectBot').onclick = () => {
  activeProject.botConnected = true;
  activeProject.botRoom = $('#botRoom').value;
  renderProjectSources();
  renderProjects();
};

const botSamples = [
  { speaker: '客户王经理', text: '再补充一项：汇报材料需要展示移动端审批页面截图，并标注审批时长数据的统计口径。' },
  { speaker: '客户李老师', text: '请在最终方案中增加管理员权限配置说明，周五前用 PDF 格式发我们确认。' },
  { speaker: '产品小林', text: '已收到，正在补充材料。' }
];
$('#simulateIncoming').onclick = () => {
  const project = activeProject;
  const sample = botSamples[project.botMessages.length % botSamples.length];
  const message = { ...sample, date: '刚刚', source: project.botRoom };
  project.botMessages.unshift(message);
  project.chats.push(message);
  addDirectCandidates(project, [message], 'ocr');
  renderProjectSources();
  update();
};

// ---------- Step 2: AI Requirement Analysis ("分析客户需求") ----------
function mergeAnalyzedRequirements(project, analyzed) {
  const confirmed = project.requirements.filter(r => r.status === '已确认');
  const confirmedTexts = new Set(confirmed.map(r => r.rawText || r.detail));
  const fresh = analyzed
    .filter(item => !confirmedTexts.has(item.rawText) && !confirmedTexts.has(item.description))
    .map(item => toStructuredRequirement(item, 0, item.analyzedBy || 'ai'));
  const combined = [...confirmed, ...fresh].map((item, idx) => ({
    ...item,
    id: `R-${String(idx + 1).padStart(2, '0')}`
  }));
  project.requirements = combined;
}

function updateAnalysisModelLabel() {
  const label = $('#analysisModelLabel');
  if (!label) return;
  const remote = state.provider && state.provider !== 'ollama';
  const modelName = remote ? state.apiModel : state.model;
  const providerName = window.ModelSettings?.providerLabel?.(state.provider) || '本地模型';
  label.textContent = `${providerName}${modelName ? ` (${modelName})` : ''}`;
}
window.addEventListener('model-settings-changed', updateAnalysisModelLabel);

let analyzePending = false;
$('#extractBtn').onclick = async () => {
  const project = activeProject;
  if (!project.chats.length) {
    showToast('请先在「采集客户需求」导入聊天记录、会议纪要或识别截图', 'warning');
    return;
  }
  if (analyzePending) return;
  const button = $('#extractBtn');
  analyzePending = true;
  button.disabled = true;
  button.textContent = '正在分析客户需求…';
  try {
    const selection = window.ModelSettings ? await window.ModelSettings.selection() : { provider: 'ollama', model: state.model };
    const response = await fetch('/api/analyze-requirements', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ ...selection, messages: project.chats })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '需求整理失败');
    mergeAnalyzedRequirements(project, result.requirements || []);
    refreshProject(project);
    showToast(`已整理出 ${project.requirements.length} 条结构化需求（未提及字段已标注「未说明」）`, 'success');
  } catch (error) {
    showToast(`模型整理未完成：${error.message}。可使用右侧「快速离线规则预整理」或检查模型设置。`, 'error', 5200);
  } finally {
    analyzePending = false;
    button.disabled = false;
    button.textContent = '✳ 分析客户需求';
  }
};

$('#ruleExtractFallback')?.addEventListener('click', () => {
  if (!activeProject.chats.length) {
    showToast('请先导入聊天记录或识别截图', 'warning');
    return;
  }
  mergeAnalyzedRequirements(activeProject, requirementsFromChats(activeProject.chats));
  update();
  showToast('已完成离线规则预整理，请人工核对各字段内容', 'info');
});

$('#confirmAllReqs')?.addEventListener('click', () => {
  const pending = activeProject.requirements.filter(r => r.status !== '已确认');
  if (!pending.length) {
    showToast('当前没有待确认的需求', 'info');
    return;
  }
  pending.forEach(r => confirmRequirement(r.id));
  showToast(`已确认 ${pending.length} 条需求并同步生成交付清单`, 'success');
});

$$('[data-req-filter]').forEach(btn => {
  btn.onclick = () => {
    reqFilter = btn.dataset.reqFilter;
    renderRequirements();
  };
});

$$('[data-mat-filter]').forEach(btn => {
  btn.onclick = () => {
    materialFilter = btn.dataset.matFilter;
    renderMaterials();
  };
});

function loadDemoSampleProject() {
  activeProject.chats = parseChat(
    `2026-11-14 10:12 | 客户王经理 | 首页要展示团队协同效率，重点突出任务按时完成率和跨部门协作时长。\n` +
    `2026-11-14 11:36 | 客户王经理 | 汇报里需要补一页上线计划，写清楚试点范围、时间和负责人。\n` +
    `2026-11-15 09:20 | 客户李老师 | 交付材料必须包含管理员操作手册和员工快速上手指南。\n` +
    `2026-11-15 15:05 | 产品小林 | 收到，数据会补充统计口径和来源。\n` +
    `2026-11-16 10:44 | 客户王经理 | 下周三前提供最终方案，请确认移动端审批流程也覆盖了。\n` +
    `2026-11-16 14:30 | 客户李老师 | 汇报时请重点说明数据安全和本地部署方式。\n` +
    `2026-11-17 09:40 | 客户王经理 | 周五前提交预算明细表，注意预算按含税口径计算，用 Excel 格式发我们。`,
    '客户沟通记录_演示.txt'
  );
  activeProject.requirements = [
    toStructuredRequirement({
      description: '首页展示团队协同效率，重点突出任务按时完成率和跨部门协作时长',
      notes: '重点突出任务按时完成率和跨部门协作时长',
      deliverable: '数据指标与口径说明',
      dueTime: '未说明',
      format: '未说明',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-14 10:12',
      speaker: '客户王经理',
      rawText: '首页要展示团队协同效率，重点突出任务按时完成率和跨部门协作时长。'
    }, 0, 'imported'),
    toStructuredRequirement({
      description: '汇报材料需补充上线计划，明确试点范围、时间安排和负责人',
      notes: '写清楚试点范围、时间和负责人',
      deliverable: '上线计划与试点安排',
      dueTime: '未说明',
      format: '未说明',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-14 11:36',
      speaker: '客户王经理',
      rawText: '汇报里需要补一页上线计划，写清楚试点范围、时间和负责人。'
    }, 1, 'imported'),
    toStructuredRequirement({
      description: '交付材料包含管理员操作手册和员工快速上手指南',
      notes: '两份手册均需包含',
      deliverable: '管理员操作手册与员工快速上手指南',
      dueTime: '未说明',
      format: '未说明',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-15 09:20',
      speaker: '客户李老师',
      rawText: '交付材料必须包含管理员操作手册和员工快速上手指南。'
    }, 2, 'imported'),
    toStructuredRequirement({
      description: '提供最终方案并覆盖移动端审批流程',
      notes: '需确认覆盖移动端审批流程',
      deliverable: '项目最终方案',
      dueTime: '下周三前',
      format: '未说明',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-16 10:44',
      speaker: '客户王经理',
      rawText: '下周三前提供最终方案，请确认移动端审批流程也覆盖了。'
    }, 3, 'imported'),
    toStructuredRequirement({
      description: '汇报中重点说明数据安全机制和本地部署方式',
      notes: '重点说明数据安全与本地部署',
      deliverable: '安全与部署说明',
      dueTime: '未说明',
      format: '未说明',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-16 14:30',
      speaker: '客户李老师',
      rawText: '汇报时请重点说明数据安全和本地部署方式。'
    }, 4, 'imported'),
    toStructuredRequirement({
      description: '提交项目预算明细表',
      notes: '预算按含税口径计算',
      deliverable: '预算明细表',
      dueTime: '周五前',
      format: 'Excel',
      source: '客户沟通记录_演示.txt',
      date: '2026-11-17 09:40',
      speaker: '客户王经理',
      rawText: '周五前提交预算明细表，注意预算按含税口径计算，用 Excel 格式发我们。'
    }, 5, 'imported')
  ];
  activeProject.deliverables = [];
  activeProject.docs = [{
    name: '项目汇报稿_演示.md',
    size: 4360,
    text: '# 凌云办公协同升级项目汇报\n\n## 项目目标\n提升跨团队协作效率，降低任务延期。\n\n## 方案设计\n建设任务看板、移动端审批和协同工作台，支持本地化部署。\n\n## 当前成效\n试点团队任务按时完成率提升至 92%。数据来自项目后台，统计周期为 2026 年 10 月。\n\n## 实施安排\n11 月启动试点，12 月推广。\n\n## 风险与保障\n数据在企业内部环境存储，采用权限分级管理。',
    type: 'text/markdown',
    status: '待检查',
    deliverable: ''
  }];
  $('#rules').value = activeProject.rules = '汇报需说明客户痛点、上线计划、移动端审批覆盖、数据安全和本地部署；所有数据需注明来源和统计口径。';
  update();
  page('requirements');
  showToast('已载入演示项目数据，可逐条确认需求生成交付清单', 'success');
}

$('#loadSample').onclick = loadDemoSampleProject;
$('#quickDemoBtn')?.addEventListener('click', loadDemoSampleProject);
$('#heroDemoBtn')?.addEventListener('click', () => {
  const target = projects.get('demo') || projects.values().next().value;
  if (target) openProject(target, 'requirements');
  loadDemoSampleProject();
});

$('#rules').oninput = event => { activeProject.rules = event.target.value; };
$('#saveRules').onclick = () => {
  const project = activeProject;
  const button = $('#saveRules');
  const savedRules = $('#rules').value;
  try {
    saveProjectMetadata(project.id, { savedRules });
    project.savedRules = project.rules = savedRules;
    button.textContent = '已保存 ✓';
    showToast('PRD 与检查规范已保存', 'success');
  } catch {
    button.textContent = '保存失败，请重试';
  }
  setTimeout(() => {
    if (project === activeProject) button.textContent = '保存规范';
  }, 1500);
};

$('#projectSearch').oninput = filterProjects;
$('#projectFilter').onchange = filterProjects;

for (const metadata of readProjectMetadata()) {
  const project = registerProject(metadata);
  renderProjectCard(project, projectProgress(project));
}
activeProject = projects.values().next().value;
$('#rules').value = activeProject.rules;
renderProjectSources();
updateAnalysisModelLabel();
update();
page('projects');
