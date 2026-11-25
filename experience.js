/* Shared interaction rules: preserve work, make state visible, and keep recovery close. */
function notify(message, undo) {
  const box=$('#notice'); if(!box)return;
  box.querySelector('span').textContent=message;
  const buttons=box.querySelectorAll('button');buttons[0].hidden=!undo;buttons[0].textContent='撤销';
  buttons[0].onclick=()=>{undo?.();box.hidden=true;};buttons[1].onclick=()=>box.hidden=true;
  box.hidden=false;
}
function editInline(button, item, key, label) {
  if(button.parentElement.querySelector('.inline-editor'))return;
  const form=document.createElement('form');form.className='inline-editor';
  const field=document.createElement('textarea');field.setAttribute('aria-label',label);field.value=item[key];field.required=true;
  const save=document.createElement('button');save.type='submit';save.className='secondary';save.textContent='保存修改';
  const cancel=document.createElement('button');cancel.type='button';cancel.className='text-button';cancel.textContent='取消';
  cancel.onclick=()=>{form.remove();button.hidden=false;button.focus();};
  const project=captureProject();form.onsubmit=e=>{e.preventDefault();if(!field.value.trim())return;if(project!==captureProject())return;item[key]=field.value.trim();if(key==='detail'){item.status='待确认';item.summary=undefined;}form.remove();button.hidden=false;update();notify('修改已保存。'+(key==='detail'?'请重新核对并确认需求。':''));};
  form.append(field,save,cancel);button.after(form);button.hidden=true;field.focus();
}
function removeRequirement(id) {
  const project=captureProject(),index=state.requirements.findIndex(r=>r.id===id),item=state.requirements[index];if(!item)return;
  state.requirements.splice(index,1);update();
  notify('已移除需求，关联交付任务与材料已保留。',()=>{const owner=project===captureProject()?state:projects.get(project);owner.requirements.splice(index,0,item);update();});
}
function removeDocument(index) {
  const project=captureProject(),[item]=state.docs.splice(index,1);if(!item)return;update();
  notify('已移除 '+item.name,()=>{const owner=project===captureProject()?state:projects.get(project);owner.docs.splice(index,0,item);update();});
}
function renderProjectGrid() {
  const grid=$('#projectGrid');if(!grid)return;
  // Called during initial update before persisted projects arrive as well.
  const rows=[...projects];if(!rows.some(([id])=>id===captureProject()))rows.push([captureProject(),{project:state.project,requirements:state.requirements,docs:state.docs}]);
  const query=$('#projectSearch').value.trim().toLowerCase(),filter=$('#projectFilter').value;
  const visible=rows.filter(([,p])=>{const pending=(p.requirements||[]).some(r=>r.status!=='已确认'),checked=(p.docs||[]).some(d=>d.status==='已检查');return [p.project.name,p.project.customer,p.project.owner].join(' ').toLowerCase().includes(query)&&(filter==='全部项目'||filter==='待核对需求'&&pending||filter==='待检查材料'&&(p.docs||[]).some(d=>d.text?.trim()&&d.status!=='已检查')||filter==='已完成检查'&&checked);});
  grid.innerHTML=visible.map(([id,p])=>{const req=p.requirements||[],docs=p.docs||[],confirmed=req.filter(r=>r.status==='已确认').length,done=docs.filter(d=>d.status==='已检查').length;const next=!p.chats?.length?'导入沟通材料':req.some(r=>r.status!=='已确认')?'核对客户需求':!docs.length?'添加交付材料':done?'查看检查结果':'检查交付材料';return `<article class="project-card" data-project-card><div class="card-top"><span class="project-status">${escapeHtml(next)}</span></div><h2>${escapeHtml(p.project.name)}</h2><p>客户：${escapeHtml(p.project.customer||'未填写')}</p><div class="card-progress"><span>已确认需求</span><b>${confirmed} / ${req.length}</b></div><div class="card-progress"><span>已检查材料</span><b>${done} / ${docs.length}</b></div><div class="card-footer"><span>负责人：${escapeHtml(p.project.owner||'待分配')}</span><button class="link-button" data-open-project="${escapeHtml(id)}">打开项目</button></div></article>`;}).join('')+(!visible.length?'<p class="empty-state">没有匹配的项目，试试其他名称或筛选条件。</p>':'');
  $('.result-count').textContent=`${visible.length} / ${rows.length} 个项目`;
  $$('[data-open-project]').forEach(b=>b.onclick=()=>{remember();const p=projects.get(b.dataset.openProject);if(p)restore(p);update();page('project');});
}
let extraction,pendingExtraction=false;
async function analyzeRequirements(options={}) {
  if(extraction){pendingExtraction=Boolean(options.automatic);extraction.abort();return;}
  const button=$('#extractBtn'),status=$('#summaryStatus');
  if(!stateLoaded){notify('请先成功读取项目，再导入或分析。');return;}
  if(!state.chats.length){page('project');notify('先导入沟通材料，系统会自动整理需求。');return;}
  const controller=new AbortController();extraction=controller;
  const project=captureProject(),rows=structuredClone(state.chats),target=state.requirements;
  button.textContent='取消分析';button.setAttribute('aria-busy','true');status.textContent=`正在整理 ${rows.length} 条原文，原始内容已保留…`;
  try{
    const response=await fetch('/api/customer-summary',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({model:state.model,rows})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'服务暂不可用');if(!Array.isArray(result.items))throw Error('返回内容不完整');
    if(project!==captureProject())return;
    // Never replace confirmed or manually edited requirements. Unreviewed AI candidates can be regenerated.
    const retained=target.filter(r=>!r.summary||r.status==='已确认'||result.warning);
    let next=Math.max(0,...target.map(r=>Number(r.id.replace('R-',''))||0))+1;
    for(const item of result.items){const row=rows[item.line-1],detail=item['需求描述'];if(!row||!detail)continue;const evidence=(row.source||'沟通记录')+' · '+row.text;if(retained.some(r=>r.evidence===evidence&&r.detail===detail))continue;retained.push({id:'R-'+String(next++).padStart(2,'0'),detail,summary:Object.fromEntries(['注意事项','交付物','交付时间','格式要求'].map(k=>[k,item[k]||'未说明'])),evidence,source:row.source,date:row.date,speaker:row.speaker,status:'待确认'});}
    state.requirements=retained;update();status.textContent=result.warning||`已整理 ${result.items.length} 条需求。请核对来源中的事实与承诺，再确认。`;
  }catch(e){if(project===captureProject())status.textContent=controller.signal.aborted?'已取消分析，原文与已有需求均已保留。':'整理未完成，原文已保留。'+e.message+'；可点击“重新分析需求”重试。';}
  finally{if(extraction===controller){extraction=null;button.textContent='重新分析需求';button.removeAttribute('aria-busy');if(pendingExtraction){pendingExtraction=false;queueMicrotask(()=>analyzeRequirements());}}}
}
let reviewing;
async function runReview() {
  if(reviewing){reviewing.abort();return;}
  page('quality');const status=$('#reviewStatus'),host=$('#report'),button=$('#runReview');
  const confirmed=structuredClone(state.requirements.filter(r=>r.status==='已确认')),docs=state.docs.filter(d=>d.text?.trim());
  if(!confirmed.length){status.textContent='先核对并确认客户需求，才能作为检查依据。';notify('请先确认客户需求。');page('requirements');return;}
  if(!docs.length){status.textContent='还没有可读的交付材料。请上传文档；图片和视频仅作为附件。';notify(status.textContent);page('materials');return;}
  const project=captureProject(),controller=new AbortController(),fingerprints=docs.map(d=>({doc:d,text:d.text}));reviewing=controller;
  status.textContent=`正在检查 ${docs.length} 份材料，对照 ${confirmed.length} 项已确认需求。可以取消，已有报告会保留。`;
  button.textContent='取消检查';button.setAttribute('aria-busy','true');
  try{
    const response=await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},signal:controller.signal,body:JSON.stringify({model:state.model,requirements:confirmed,documents:structuredClone(docs),rules:$('#rules').value})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'检查服务暂不可用');if(project!==captureProject())return;
    if(!['api','ollama'].includes(result.mode)||typeof result.answer!=='string'||result.answer.replace(/[^\p{L}\p{N}]/gu,'').length<20)throw Error(result.warning||'模型未完成检查，规则提示不能代替 AI 质检');
    host.innerHTML=`<div class="model-note">${result.mode==='api'?'自定义 API':'本地模型'} · ${escapeHtml(result.model||state.model)} · ${confirmed.length} 项需求 · ${docs.length} 份材料</div><article class="review-card"><h3>审查意见</h3>${reviewBlocks(result.answer)}</article>`;
    for(const {doc,text} of fingerprints)if(state.docs.includes(doc)&&doc.text===text)doc.status='已检查';
    state.reviewHtml=host.innerHTML;state.reviewSignature=reviewSignature();state.reviewMeta='检查完成 · '+new Date().toLocaleString('zh-CN');status.textContent=state.reviewMeta;$('#qualityIssues').textContent='查看报告';$('#qualityModel').textContent=result.mode==='api'?'自定义 API':'本地模型';update();
  }catch(e){if(project===captureProject()){status.textContent=controller.signal.aborted?'已取消检查，材料与上次报告均已保留。':'检查未完成：'+e.message+'。材料未标为已检查，请重试。';$('#qualityModel').textContent=controller.signal.aborted?'已取消':'未完成';}}
  finally{if(reviewing===controller){reviewing=null;button.textContent='重新检查材料';button.removeAttribute('aria-busy');}}
}
async function testProviderDraft() {
  const status=$('#connectionStatus'),button=$('#checkConnection');button.disabled=true;status.textContent='正在测试当前填写的配置，不会保存…';
  try{const res=await fetch('/api/model-test',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({draft:{mode:$('#providerMode').value,baseUrl:$('#providerUrl').value.trim(),model:$('#providerModel').value.trim(),key:$('#providerKey').value.trim()},model:$('#modelName').value.trim()||state.model})});const data=await res.json();if(!res.ok)throw Error(data.error||'连接失败');status.textContent=`连接成功 · ${(data.ms/1000).toFixed(1)} 秒。尚未保存，点击“保存设置”后生效。`;}catch(e){status.textContent='未能连接：'+e.message+'。原设置未更改。';}finally{button.disabled=false;}
}
function editLesson(){
 const existing=$('#feedback').nextElementSibling;if(existing?.classList.contains('inline-editor'))return;
 const form=document.createElement('form');form.className='inline-editor';form.innerHTML='<label>确认可复用的经验<textarea required aria-label="可复用经验"></textarea></label><button class="secondary">保存经验</button><button type="button" class="text-button">取消</button>';
 form.querySelector('textarea').value=$('#feedback').innerText.slice(0,1500);form.querySelector('[type=button]').onclick=()=>form.remove();form.onsubmit=e=>{e.preventDefault();const note=form.querySelector('textarea').value.trim();if(!note)return;memories.push({project:state.project.name,note});localStorage.setItem('deliveryLessons',JSON.stringify(memories));showLessons();form.remove();notify('经验已保存到本机。');};$('#feedback').after(form);
}
$$('[data-close]').forEach(b=>b.onclick=()=>b.closest('dialog').close());
$('#retrySave').onclick=()=>{if(!stateLoaded)loadPersistedState();else persistState();};
$('#rules').addEventListener('input',persistState);$('#saveRules').hidden=true;
$('#answerInput').addEventListener('input',persistState);
$('#confirmAll').onclick=()=>{const pending=state.requirements.filter(r=>r.status!=='已确认');if(!pending.length)return;const project=captureProject();pending.forEach(confirmRequirement);update();notify(`已确认 ${pending.length} 项需求；请确保已逐项核对来源。`,()=>{const owner=project===captureProject()?state:projects.get(project);for(const item of owner.requirements)if(pending.includes(item))item.status='待确认';update();});};
window.addEventListener('project-changed',()=>{extraction?.abort();reviewing?.abort();});
let materialFilter='全部材料';
$$('.filter-pill').forEach((b,index)=>b.onclick=()=>{materialFilter=['全部材料','待检查','已检查'][index];$$('.filter-pill').forEach(x=>x.classList.toggle('active',x===b));filterMaterials();});
function filterMaterials(){$$('#materialsList .material-card').forEach((card,i)=>card.hidden=materialFilter!=='全部材料'&&state.docs[i].status!==materialFilter);}
new MutationObserver(filterMaterials).observe($('#materialsList'),{childList:true});
new MutationObserver(()=>{archive.hidden=!$('#feedback').querySelector('h3');history.hidden=!memories.length;}).observe($('#feedback'),{childList:true,subtree:true});archive.hidden=true;history.hidden=!memories.length;
// Optional configuration remains available without dominating the primary task.
for(const selector of ['.spec-surface']){const section=$(selector),details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='补充项目检查规范（可选）';section.before(details);details.className='optional-section';details.append(summary,section);}
$('#newProjectCard')?.remove();
for(const icon of $$('.side-link > span,.choice-icon,.empty-symbol'))icon.remove();
$$('.choice').forEach(b=>b.addEventListener('click',()=>{if(b.dataset.source==='screenshot'&&$('input[value="targeted"]').checked)refreshWechatWindows();}));
$$('input[name="captureMode"]').forEach(r=>r.addEventListener('change',()=>{if(r.checked&&r.value==='targeted')refreshWechatWindows();}));
let capabilities;
fetch('/api/capabilities').then(r=>{if(!r.ok)throw Error();return r.json();}).then(info=>{
 capabilities=info;$('footer span:last-child').textContent='项目独立保存到本机 · 自定义 API 按操作发送所需内容';
 if(!info.windowsCapture){$('[data-source="screenshot"]').hidden=true;$('input[value="targeted"]').closest('label').hidden=true;$('#screenshotPick').disabled=true;$('#recognizeScreenshot').disabled=true;$('#screenshotName').textContent='截图识别需要 Windows 环境。当前设备请导入聊天文字或会议纪要。';}
 if(!info.localSpeech){$('#meetingPick').hidden=true;$('#micButton').hidden=true;$('#voiceStatus').textContent='本机语音模型未就绪；可直接开始文字演练，或在模型设置中配置语音服务。';readProvider().then(p=>{if(!p.localSpeech&&p.mode==='api'&&p.hasKey){$('#meetingPick').hidden=false;$('#micButton').hidden=false;$('#voiceStatus').textContent='语音将发送到你配置的自定义 API 进行识别。';}}).catch(()=>{});}
}).catch(()=>notify('设备能力检测失败，可先使用文档导入和文字演练。'));
renderProjectGrid();

function refreshSpeechAvailability(info){
 const available=Boolean(capabilities?.localSpeech||!info.localSpeech&&info.mode==='api'&&info.hasKey);
 $('#meetingPick').hidden=!available;$('#micButton').hidden=!available;
 if(!available)$('#voiceStatus').textContent='本机语音模型未就绪；可直接开始文字演练，或在模型设置中配置语音服务。';
 $('#asrModel').closest('label').hidden=info.localSpeech||info.mode!=='api';
}
function refreshSpeechField(){$('#asrModel').closest('label').hidden=$('#localSpeech').checked||$('#providerMode').value!=='api';}
$('#localSpeech').addEventListener('change',refreshSpeechField);$('#providerMode').addEventListener('change',refreshSpeechField);
new MutationObserver(refreshSpeechField).observe($('#settingsDialog'),{attributes:true,attributeFilter:['open']});
function reviewOCR(button,text,source,project){
 const form=document.createElement('form');form.className='inline-editor';form.innerHTML='<label>核对识别文字<textarea required aria-label="识别文字"></textarea></label><button class="secondary">核对后加入需求</button><button class="text-button" type="button">取消</button>';form.querySelector('textarea').value=text;form.querySelector('[type=button]').onclick=()=>form.remove();form.onsubmit=e=>{e.preventDefault();if(project!==captureProject())return;const reviewed=form.querySelector('textarea').value.trim();if(!reviewed)return;state.chats=state.chats.filter(r=>r.source!==source);state.chats.push(...parseChat(reviewed,source));update();form.remove();analyzeRequirements({automatic:true});};button.after(form);form.querySelector('textarea').focus();
}
const rehearsalExtras=document.createElement('details');rehearsalExtras.className='rehearsal-extras';rehearsalExtras.innerHTML='<summary>调整练习时长与重点（可选）</summary>';$('#duration').closest('label').before(rehearsalExtras);rehearsalExtras.append($('#duration').closest('label'),$('#rehearsalFocus').closest('label'));

let listingModels=false;
async function loadModelOptions(){
 if(listingModels)return;listingModels=true;const button=$('#loadModelList'),status=$('#modelListStatus');button.disabled=true;status.textContent='正在读取模型…';
 try{const res=await fetch('/api/model-list',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({mode:$('#providerMode').value,baseUrl:$('#providerUrl').value.trim(),key:$('#providerKey').value.trim()})});const data=await res.json();if(!res.ok)throw Error(data.error);$('#availableModels').replaceChildren(...data.models.map(id=>{const option=document.createElement('option');option.value=id;return option;}));status.textContent=`已读取 ${data.models.length} 个模型，可在“模型 ID”中选择或直接填写。`;}catch(e){status.textContent=e.message+'；仍可直接填写模型 ID。';}finally{listingModels=false;button.disabled=false;}
}
$('#loadModelList').onclick=loadModelOptions;

function setProjectReady(ready){for(const id of ['newProject','editProject','docPick','chatPick','meetingPick','loadSample','addDeliverable','extractBtn','runReview'])$('#'+id).disabled=!ready;}

function reviewSignature(){const text=JSON.stringify({requirements:state.requirements.filter(r=>r.status==='已确认'),documents:state.docs.map(d=>({name:d.name,text:d.text})),rules:$('#rules').value});let hash=2166136261;for(let i=0;i<text.length;i++)hash=Math.imul(hash^text.charCodeAt(i),16777619);return (hash>>>0).toString(16);}
function checkReviewFreshness(){if(!state.reviewHtml||reviewing)return;if(state.reviewSignature!==reviewSignature()){for(const doc of state.docs)if(doc.status==='已检查')doc.status='待检查';$('#reviewStatus').textContent='需求、材料或规范已变更，请重新检查。下方保留上次报告供参考。';$('#qualityIssues').textContent='待重新检查';}}
$('#rules').addEventListener('input',()=>{checkReviewFreshness();renderMaterials();});
window.addEventListener('beforeunload',event=>{if(changeVersion>savedVersion){event.preventDefault();event.returnValue='';}});
