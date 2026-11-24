const state = { visionModels: [], model: localStorage.getItem('localModel') || 'qwen3:4b' };
const projectStorageKey = 'deliveryProjects';
const demoProject = {
  id: 'demo', name: '凌云办公协同升级', customer: '联想办公软件团队', owner: '李明',
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

function saveProjectMetadata(id, changes) {
  const records = new Map(readProjectMetadata().map(item => [item.id, item]));
  const record = { ...records.get(id), ...changes, id };
  records.set(id, record);
  localStorage.setItem(projectStorageKey, JSON.stringify([...records.values()]));
  return record;
}
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parseChat(text,name){return text.split(/\r?\n/).map((line,i)=>{const m=line.trim().match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s*[|｜,，\t]\s*([^|｜,，\t]+)\s*[|｜,，\t]\s*(.*)$/);return {date:m?.[1]||`第 ${i+1} 行`,speaker:m?.[2]?.trim()||name,text:m?.[3]?.trim()||line.trim(),source:name,line:i+1}}).filter(m=>m.text)}
async function fileText(file){if(file.size>8*1024*1024)throw new Error(`${file.name} 超过 8 MB 限制`);const ext=file.name.split('.').pop().toLowerCase();if(['txt','md','csv','json'].includes(ext))return{ text:await file.text() };if(!['docx','pdf','xlsx'].includes(ext))return{text:'',warning:'该格式只进入材料列表，当前版本不能提取内容进行质检。'};const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const response=await fetch('/api/parse-file',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,data:btoa(binary)})});const result=await response.json();if(!response.ok)throw new Error(result.error||'文件解析失败');if(result.empty)throw new Error(result.warning||`${file.name} 中未提取到文字`);return{text:result.text,warning:result.warning}}
async function addChats(files) {
  const project = activeProject;
  for (const file of files) {
    try {
      const parsed = await fileText(file);
      if (parsed.warning) alert(parsed.warning);
      project.chats.push(...parseChat(parsed.text, file.name));
    } catch (error) { alert(error.message); }
  }
  refreshProject(project);
}

async function addDocs(files) {
  const project = activeProject;
  for (const file of files) {
    try {
      const parsed = await fileText(file);
      if (parsed.warning) alert(parsed.warning);
      project.docs.push({ name: file.name, text: parsed.text, size: file.size, type: file.type || '文件', status: '待检查', warning: parsed.warning });
    } catch (error) { alert(error.message); }
  }
  refreshProject(project);
}

function requirementsFromChats(chats = activeProject.chats){const hints=['需要','要求','必须','希望','支持','提供','交付','完成','上线','验收','修改','增加','删除','优化','截至','时间','数据','格式','客户','不要','不能','覆盖','说明','补充'];return chats.filter(m=>hints.some(h=>m.text.includes(h))&&!/^(收到|好的|明白|了解)/.test(m.text)).map((m,i)=>({id:`R-${String(i+1).padStart(2,'0')}`,detail:m.text,evidence:`${m.source} · ${m.date} · ${m.speaker}`,date:m.date,speaker:m.speaker,source:m.source,status:'待确认'}))}
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
    ...metadata, card, chats: [], docs: [], requirements: [], deliverables: [], screenshots: [],
    rules: metadata.savedRules, botConnected: false, botMessages: [], selectedScreenshot: null,
    screenshotResult: '', captureEvents: [], captureRoom: '', source: 'import', captureMode: 'manual'
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
  card.querySelector('.card-footer span').textContent = `负责人：${owner || '未分配'}`;
  card.querySelector('[data-open-project]').setAttribute('aria-label', `打开项目：${name}`);
  card.querySelector('[data-rename-project]').setAttribute('aria-label', `重命名项目：${name}`);
  card.querySelector('[data-edit-project]').setAttribute('aria-label', `编辑项目：${name}`);
  card.querySelector('[data-req-progress]').textContent = `${confirmed} / ${total}`;
  card.querySelector('[data-doc-progress]').textContent = `${done} / ${docs}`;
  card.querySelector('.progress-track i').style.width = total ? `${confirmed / total * 100}%` : '0%';
  card.querySelector('.progress-track.blue i').style.width = docs ? `${done / docs * 100}%` : '0%';
}

function renderProjects(project = activeProject) {
  const progress = projectProgress(project);
  renderProjectCard(project, progress);
  filterProjects();
  if (project !== activeProject) return;

  const { name, customer, owner, chats, botConnected } = project;
  const { total, confirmed, docs } = progress;
  $('#sideProjectName').textContent = name;
  $('#projectTitle').textContent = name;
  $('#requirementsProjectName').textContent = name;
  $('#projectMeta').textContent = `客户：${customer || '未填写'}　·　负责人：${owner || '未分配'}　·　${botConnected ? '聊天同步中' : getProjectStatus(progress)}`;
  $('#overviewReqText').textContent = total ? `${confirmed} 项已确认，${total - confirmed} 项待确认` : '等待导入聊天记录';
  $('#overviewDocText').textContent = docs ? `${docs} 份材料已添加` : '添加材料并关联清单项';
  $('#chatSummary').textContent = chats.length ? `已导入 ${new Set(chats.map(message => message.source)).size} 个聊天文件，共 ${chats.length} 条消息` : '尚未导入聊天记录';
}

function renderRequirements(){$('#reqCount').textContent=activeProject.requirements.length;$('#deliverableCount').textContent=activeProject.deliverables.length;$('#requirementsList').innerHTML=activeProject.requirements.length?activeProject.requirements.map(r=>`<article class="req-card"><div class="req-top"><div class="req-title"><span class="req-id">${escapeHtml(r.id)}</span>${escapeHtml(r.detail)}</div><span class="status ${r.status==='已确认'?'ok':''}">${escapeHtml(r.status)}</span></div><div class="req-source">↳ 来源：${escapeHtml(r.evidence)}</div><div class="req-actions"><button class="link-button" data-confirm="${r.id}">✓ 确认需求</button><button class="link-button muted" data-edit-req="${r.id}">编辑</button><button class="link-button muted" data-remove-req="${r.id}">移除</button></div></article>`).join(''):`<div class="empty-state compact"><div class="empty-symbol">☷</div><b>还没有需求候选</b><span>先导入聊天记录，或载入演示项目查看完整流程。</span></div>`;$$('[data-confirm]').forEach(b=>b.onclick=()=>{const r=activeProject.requirements.find(x=>x.id===b.dataset.confirm);r.status='已确认';if(!activeProject.deliverables.some(d=>d.requirement===r.id))activeProject.deliverables.push({id:`D-${String(activeProject.deliverables.length+1).padStart(2,'0')}`,name:guessDeliverable(r.detail),standard:'覆盖该客户要求，并提供可核验依据',owner:activeProject.owner,requirement:r.id,status:'待提交'});update()});$$('[data-remove-req]').forEach(b=>b.onclick=()=>{activeProject.requirements=activeProject.requirements.filter(x=>x.id!==b.dataset.removeReq);update()});$$('[data-edit-req]').forEach(b=>b.onclick=()=>{const r=activeProject.requirements.find(x=>x.id===b.dataset.editReq);const v=prompt('编辑需求内容',r.detail);if(v?.trim()){r.detail=v.trim();update()}});renderDeliverables()}
function guessDeliverable(text){if(/上线|试点|时间|负责人/.test(text))return'上线计划与试点安排';if(/数据|指标|统计/.test(text))return'数据指标与口径说明';if(/汇报|方案/.test(text))return'项目方案与汇报材料';if(/图片|页面|展示/.test(text))return'页面设计与展示素材';if(/手册|指南/.test(text))return'产品操作手册';if(/安全|部署/.test(text))return'安全与部署说明';return'客户要求对应交付材料'}
function renderDeliverables(){$('#deliverablesList').innerHTML=activeProject.deliverables.length?activeProject.deliverables.map(d=>`<article class="deliverable-card"><div class="deliverable-index">${escapeHtml(d.id)}</div><div class="deliverable-body"><div class="deliverable-head"><b>${escapeHtml(d.name)}</b><span class="status ${d.status==='已提交'?'ok':''}">${escapeHtml(d.status)}</span></div><small>关联需求：${escapeHtml(d.requirement||'手动添加')}　·　负责人：${escapeHtml(d.owner||'待分配')}</small><p>验收标准：${escapeHtml(d.standard)}</p><button class="link-button muted" data-edit-del="${d.id}">编辑清单项</button></div></article>`).join(''):`<div class="empty-state compact"><div class="empty-symbol">☑</div><b>确认需求后生成交付清单</b><span>可设置交付物、负责人、截止时间和验收标准。</span></div>`;$$('[data-edit-del]').forEach(b=>b.onclick=()=>{const d=activeProject.deliverables.find(x=>x.id===b.dataset.editDel);const v=prompt('交付物名称',d.name);if(v?.trim()){d.name=v.trim();update()}})}
function renderMaterials(){$('#materialCount').textContent=activeProject.docs.length;$('#qualityDocs').textContent=activeProject.docs.length;$('#materialsList').innerHTML=activeProject.docs.length?activeProject.docs.map((d,i)=>`<article class="material-card"><div class="material-type">${/image/i.test(d.type)||/\.(png|jpe?g|webp)$/i.test(d.name)?'▧':/video/i.test(d.type)||/\.(mp4|webm)$/i.test(d.name)?'▷':'▤'}</div><div class="material-info"><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.type)} · ${(d.size/1024).toFixed(1)} KB</small><select data-link-doc="${i}"><option value="">关联交付清单项</option>${activeProject.deliverables.map(x=>`<option ${d.deliverable===x.id?'selected':''} value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select></div><span class="status ${d.status==='已检查'?'ok':''}">${d.status}</span><button class="link-button muted" data-remove-doc="${i}">移除</button></article>`).join(''):`<div class="empty-state wide"><div class="empty-symbol">▤</div><b>还没有上传交付材料</b><span>上传文件后，为材料关联清单项并运行质量检查。</span><button class="secondary" id="emptyUpload">选择项目文件</button></div>`;$('#emptyUpload')?.addEventListener('click',()=>$('#docInput').click());$$('[data-link-doc]').forEach(s=>s.onchange=()=>{activeProject.docs[Number(s.dataset.linkDoc)].deliverable=s.value;update()});$$('[data-remove-doc]').forEach(b=>b.onclick=()=>{activeProject.docs.splice(Number(b.dataset.removeDoc),1);update()})}
function update(){renderProjects();renderRequirements();renderMaterials();$('#qualityReqs').textContent=activeProject.requirements.filter(r=>r.status==='已确认').length}
function page(name){$$('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${name}`));$$('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));const names={projects:'项目列表',project:'项目概览',requirements:'需求与交付清单',materials:'交付材料',quality:'质量检查',rehearsal:'汇报演练'};$('#breadcrumbCurrent').textContent=names[name]||'项目概览';if(['project','requirements','materials','quality','rehearsal'].includes(name)){$$('.step').forEach(s=>s.classList.toggle('active',s.dataset.page===name))}window.scrollTo(0,0)}
$$('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));$$('[data-next]').forEach(b=>b.onclick=()=>page(b.dataset.next));
function refreshProject(project) {
  if (activeProject === project) update();
  else renderProjects(project);
}

function openProject(project) {
  if (activeProject !== project) {
    activeProject = project;
    $('#rules').value = project.rules;
    $('#saveRules').textContent = '保存规范';
    renderProjectSources();
    update();
    window.dispatchEvent(new Event('project-changed'));
  }
  page('project');
}

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
    ? project.botMessages.map(message => `<article class="bot-message"><div><b>${escapeHtml(message.speaker)}</b><time>${message.date}</time></div><p>${escapeHtml(message.text)}</p><span class="message-tag">新消息 · 已进入需求识别</span></article>`).join('')
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
for (const [button, input, upload] of [['chatPick', 'chatInput', addChats], ['docPick', 'docInput', addDocs]]) {
  $(`#${button}`).onclick = () => $(`#${input}`).click();
  $(`#${input}`).onchange = event => {
    const files = [...event.target.files];
    event.target.value = '';
    return upload(files);
  };
}

function renderScreenshot() {
  const { selectedScreenshot, screenshotResult, screenshotPending } = activeProject;
  $('#screenshotName').textContent = selectedScreenshot?.name || '支持 PNG / JPG / WEBP · 单张不超过 8 MB';
  $('#screenshotPick').disabled = Boolean(screenshotPending);
  $('#recognizeScreenshot').disabled = !selectedScreenshot || Boolean(screenshotPending);
  $('#recognizeScreenshot').textContent = screenshotPending ? '正在本机识别…' : '本地识别截图';
  $('#screenshotResult').innerHTML = screenshotResult;
  $('#screenshotResult').classList.toggle('hidden', !screenshotResult);
}

$('#screenshotPick').onclick = () => $('#screenshotInput').click();
$('#screenshotInput').onchange = event => {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;
  if (file.size > 8 * 1024 * 1024) { alert('截图最大 8 MB'); return; }
  activeProject.selectedScreenshot = file;
  activeProject.screenshotResult = '';
  renderScreenshot();
};

async function refreshVisionModels() {
  const select = $('#visionModel');
  select.innerHTML = '<option value="">正在检测本机视觉模型…</option>';
  try {
    const result = await (await fetch('/api/health')).json();
    state.visionModels = (result.models || []).filter(model => /vl|vision|llava|minicpm-v|moondream/i.test(model));
    select.innerHTML = state.visionModels.length
      ? state.visionModels.map(model => `<option value="${escapeHtml(model)}">${escapeHtml(model)}</option>`).join('')
      : '<option value="">未发现本机视觉模型</option>';
  } catch { select.innerHTML = '<option value="">无法连接 Ollama</option>'; }
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
    $('#captureStatus').textContent = `监测中 · ${title} · 群聊：${group} · 每 ${intervalSec} 秒` +
      (lastCheck ? ` · 最近检查 ${new Date(lastCheck).toLocaleTimeString()}` : '') + (lastError ? ` · ${lastError}` : '');
  } else if (active) {
    $('#captureStatus').textContent = '另一项目正在监测微信，请先在该项目中停止监测。';
  } else {
    $('#captureStatus').textContent = activeProject.captureMessage || '尚未开始监测';
  }
}

async function refreshWechatWindows() {
  const select = $('#wechatWindow');
  select.innerHTML = '<option value="">正在查找微信窗口…</option>';
  try {
    const result = await (await fetch('/api/wechat/windows')).json();
    select.innerHTML = result.windows?.length
      ? result.windows.map((window, index) => `<option value="${escapeHtml(window.hwnd)}">${escapeHtml(window.title || `微信窗口 ${index + 1}`)} · ${escapeHtml(window.process)}</option>`).join('')
      : `<option value="">${escapeHtml(result.error || '未发现已打开的微信窗口')}</option>`;
  } catch { select.innerHTML = '<option value="">无法读取微信窗口</option>'; }
}

$('#refreshWechatWindows').onclick = refreshWechatWindows;
$('#startWechatCapture').onclick = async () => {
  const project = activeProject;
  const model = $('#visionModel').value;
  const hwnd = $('#wechatWindow').value;
  const group = project.captureRoom.trim();
  const error = !hwnd ? '请先刷新并选择微信窗口'
    : group.length < 2 ? '请填写准确的目标群聊名称'
    : !model ? '需要先安装并选择本地视觉模型' : '';
  if (error) {
    $('#captureStatus').textContent = error;
    return;
  }

  captureRequestPending = true;
  renderCaptureStatus();
  try {
    const response = await fetch('/api/wechat/capture/start', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ hwnd, group, model, intervalSec: $('#captureInterval').value, projectId: project.id })
    });
    const result = await response.json();
    if (!response.ok || !result.active) throw new Error(result.error || '监测未能启动');
    captureStatus = result;
    project.captureMessage = '';
  } catch (error) {
    project.captureMessage = error.message;
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
  } catch (error) {
    project.captureMessage = error.message;
    if (captureStatus) captureStatus.lastError = error.message;
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
  const existing = new Set(project.requirements.map(requirement => requirement.detail));
  for (const requirement of requirementsFromChats(messages)) {
    if (existing.has(requirement.detail)) continue;
    requirement.id = `R-${String(project.requirements.length + 1).padStart(2, '0')}`;
    project.requirements.push(requirement);
    existing.add(requirement.detail);
  }
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
      const source = `微信截图 · ${event.group}`;
      const messages = event.messages.map(message => ({ date: message.time, speaker: message.speaker, text: message.text, source: `${source} · ${event.file}` }));
      project.chats.push(...messages);
      project.screenshots.push({ name: event.file, source, count: messages.length });
      addMessageRequirements(project, messages);
      project.captureEvents.unshift(event);
      if (project === activeProject) $('#captureEvents').insertAdjacentHTML('afterbegin', renderCaptureEvent(event));
      refreshProject(project);
    }
  } catch {
  } finally { capturePollPending = false; }
}

setInterval(pollCapture, 2500);
$('#refreshVisionModels').onclick = refreshVisionModels;
$('#recognizeScreenshot').onclick = async () => {
  const project = activeProject;
  const file = project.selectedScreenshot;
  const model = $('#visionModel').value;
  if (!file) return;
  if (!model) {
    project.screenshotResult = '<b>本机没有可用的视觉模型</b><p>请选择支持图片输入的 Ollama 模型，或载入演示识别结果。</p>';
    renderScreenshot();
    return;
  }
  const source = project.captureMode === 'targeted' ? `微信 · ${project.captureRoom || '未填写群聊'}` : '用户手动截图';
  project.screenshotPending = true;
  renderScreenshot();
  try {
    const bytes = new Uint8Array(await file.arrayBuffer());
    let binary = '';
    for (let index = 0; index < bytes.length; index += 0x8000) binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
    const response = await fetch('/api/recognize-image', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model, data: btoa(binary), source })
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    const messages = parseChat(result.text, `截图：${source}`);
    project.chats.push(...messages);
    project.screenshots.push({ name: file.name, source, count: messages.length });
    addMessageRequirements(project, messages);
    project.screenshotResult = `<b>识别完成 · ${escapeHtml(model)}</b><p>${escapeHtml(result.text || '未识别到清晰消息')}</p><small>来源：${escapeHtml(source)} · ${messages.length} 条消息已加入待确认需求来源</small>`;
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
  const source = project.captureMode === 'targeted' ? `微信 · ${project.captureRoom || `${project.name}项目群`}` : '用户手动截图';
  const message = {
    date: '2026-11-22 10:24', speaker: '客户王经理', text: '汇报材料请增加移动端审批页面截图，并标注审批时长数据的统计口径。',
    source: `截图演示：${source}`
  };
  project.chats.push(message);
  project.screenshots.push({ name: '本地截图_演示.png', source, count: 1 });
  addMessageRequirements(project, [message]);
  project.screenshotResult = `<b>演示 OCR 结果 · 待人工确认</b><p>${escapeHtml(message.text)}</p><small>来源：截图演示 · ${escapeHtml(source)} · 需求已加入需求清单</small>`;
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
  { speaker: '客户李老师', text: '请在最终方案中增加管理员权限配置说明，周五前给我们确认。' },
  { speaker: '产品小林', text: '已收到，正在补充材料。' }
];
$('#simulateIncoming').onclick = () => {
  const project = activeProject;
  const sample = botSamples[project.botMessages.length % botSamples.length];
  const message = { ...sample, date: '刚刚', source: project.botRoom };
  project.botMessages.unshift(message);
  project.chats.push(message);
  addMessageRequirements(project, [message]);
  renderProjectSources();
  update();
};
$('#extractBtn').onclick=()=>{if(!activeProject.chats.length){alert('请先导入聊天记录，或点击“载入演示项目”。');return}activeProject.requirements=requirementsFromChats();update()};$('#loadSample').onclick=()=>{activeProject.chats=parseChat(`2026-11-14 10:12 | 客户王经理 | 首页要展示团队协同效率，重点突出任务按时完成率和跨部门协作时长。\n2026-11-14 11:36 | 客户王经理 | 汇报里需要补一页上线计划，写清楚试点范围、时间和负责人。\n2026-11-15 09:20 | 客户李老师 | 交付材料必须包含管理员操作手册和员工快速上手指南。\n2026-11-15 15:05 | 产品小林 | 收到，数据会补充统计口径和来源。\n2026-11-16 10:44 | 客户王经理 | 下周三前提供最终方案，请确认移动端审批流程也覆盖了。\n2026-11-16 14:30 | 客户李老师 | 汇报时请重点说明数据安全和本地部署方式。`,'客户沟通记录_演示.txt');activeProject.requirements=requirementsFromChats();activeProject.deliverables=[];activeProject.docs=[{name:'项目汇报稿_演示.md',size:4360,text:'# 凌云办公协同升级项目汇报\n\n## 项目目标\n提升跨团队协作效率，降低任务延期。\n\n## 方案设计\n建设任务看板、移动端审批和协同工作台，支持本地化部署。\n\n## 当前成效\n试点团队任务按时完成率提升至 92%。数据来自项目后台，统计周期为 2026 年 10 月。\n\n## 实施安排\n11 月启动试点，12 月推广。\n\n## 风险与保障\n数据在企业内部环境存储，采用权限分级管理。',type:'text/markdown',status:'待检查'}];$('#rules').value=activeProject.rules='汇报需说明客户痛点、上线计划、移动端审批覆盖、数据安全和本地部署；所有数据需注明来源和统计口径。';update();page('requirements')};
$('#addDeliverable').onclick=()=>$('#deliverableDialog').showModal();$('#deliverableForm').addEventListener('submit',e=>{if(e.submitter?.id==='saveDeliverable'||e.submitter?.value==='default'){e.preventDefault();activeProject.deliverables.push({id:`D-${String(activeProject.deliverables.length+1).padStart(2,'0')}`,name:$('#deliverableName').value.trim(),standard:$('#deliverableStandard').value.trim()||'待补充验收标准',owner:$('#deliverableOwner').value.trim()||'待分配',status:'待提交'});$('#deliverableForm').reset();$('#deliverableDialog').close();update()}});
$('#rules').oninput = event => { activeProject.rules = event.target.value; };
$('#saveRules').onclick = () => {
  const project = activeProject;
  const button = $('#saveRules');
  const savedRules = $('#rules').value;
  try {
    saveProjectMetadata(project.id, { savedRules });
    project.savedRules = project.rules = savedRules;
    button.textContent = '已保存 ✓';
  } catch { button.textContent = '保存失败，请重试'; }
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
update();
page('projects');
