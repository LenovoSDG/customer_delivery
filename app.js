const state={project:{name:'凌云办公协同升级',customer:'联想办公软件团队',owner:'李明'},chats:[],docs:[],requirements:[],deliverables:[],screenshots:[],selectedScreenshot:null,visionModels:[],model:localStorage.getItem('localModel')||'qwen3:4b',botConnected:false,botMessageIndex:0,questionIndex:0};
const $=s=>document.querySelector(s);const $$=s=>[...document.querySelectorAll(s)];
const escapeHtml=s=>String(s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function parseChat(text,name){return text.split(/\r?\n/).map((line,i)=>{const m=line.trim().match(/^(\d{4}[-/]\d{1,2}[-/]\d{1,2}(?:\s+\d{1,2}:\d{2})?)\s*[|｜,，\t]\s*([^|｜,，\t]+)\s*[|｜,，\t]\s*(.*)$/);return {date:m?.[1]||`第 ${i+1} 行`,speaker:m?.[2]?.trim()||name,text:m?.[3]?.trim()||line.trim(),source:name,line:i+1}}).filter(m=>m.text)}
async function fileText(file){if(file.size>8*1024*1024)throw new Error(`${file.name} 超过 8 MB 限制`);const ext=file.name.split('.').pop().toLowerCase();if(['txt','md','csv','json'].includes(ext))return{ text:await file.text() };if(!['docx','pdf','xlsx'].includes(ext))return{text:'',warning:'该格式只进入材料列表，当前版本不能提取内容进行质检。'};const bytes=new Uint8Array(await file.arrayBuffer());let binary='';for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));const response=await fetch('/api/parse-file',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({name:file.name,data:btoa(binary)})});const result=await response.json();if(!response.ok)throw new Error(result.error||'文件解析失败');if(result.empty)throw new Error(result.warning||`${file.name} 中未提取到文字`);return{text:result.text,warning:result.warning}}
async function addChats(files){const target=state.chats;for(const f of files){try{const parsed=await fileText(f);if(parsed.warning)alert(parsed.warning);target.push(...parseChat(parsed.text,f.name))}catch(e){alert(e.message)}}update()}
async function addDocs(files){const target=state.docs;for(const f of files){try{const parsed=await fileText(f);if(parsed.warning)alert(parsed.warning);target.push({name:f.name,text:parsed.text,size:f.size,type:f.type||'文件',status:'待检查',warning:parsed.warning})}catch(e){alert(e.message)}}update()}
function requirementsFromChats(){const hints=['需要','要求','必须','希望','支持','提供','交付','完成','上线','验收','修改','增加','删除','优化','截至','时间','数据','格式','客户','不要','不能','覆盖','说明','补充'];return state.chats.filter(m=>hints.some(h=>m.text.includes(h))&&!/^(收到|好的|明白|了解)/.test(m.text)).map((m,i)=>({id:`R-${String(i+1).padStart(2,'0')}`,detail:m.text,evidence:`${m.source} · ${m.date} · ${m.speaker}`,date:m.date,speaker:m.speaker,source:m.source,status:'待确认'}))}
function renderProjects(){const{ name,customer,owner}=state.project;$('#sideProjectName').textContent=name;$('#cardProjectName').textContent=name;$('#cardCustomer').textContent=`客户：${customer||'未填写'}`;$('#projectTitle').textContent=name;$('#projectMeta').textContent=`客户：${customer||'未填写'}　·　负责人：${owner||'未分配'}　·　${state.botConnected?'聊天同步中':'进行中'}`;const total=state.requirements.length,confirmed=state.requirements.filter(x=>x.status==='已确认').length,docs=state.docs.length,done=state.docs.filter(x=>x.status==='已检查').length;$('#cardReqProgress').textContent=`${confirmed} / ${total}`;$('#cardDocProgress').textContent=`${done} / ${docs}`;$('#reqProgressBar').style.width=total?`${confirmed/total*100}%`:'0%';$('#docProgressBar').style.width=docs?`${done/docs*100}%`:'0%';$('#overviewReqText').textContent=total?`${confirmed} 项已确认，${total-confirmed} 项待确认`:'等待导入聊天记录';$('#overviewDocText').textContent=docs?`${docs} 份材料已添加`:'添加材料并关联清单项';$('#chatSummary').textContent=state.chats.length?`已导入 ${new Set(state.chats.map(m=>m.source)).size} 个聊天文件，共 ${state.chats.length} 条消息`:'尚未导入聊天记录'}
function confirmRequirement(r){r.status='已确认';if(!state.deliverables.some(d=>d.requirement===r.id))state.deliverables.push({id:`D-${String(1+Math.max(0,...state.deliverables.map(d=>Number(d.id.slice(2))||0))).padStart(2,'0')}`,name:r.summary?.交付物 && r.summary.交付物!=="未说明"?r.summary.交付物:guessDeliverable(r.detail),standard:r.summary?Object.entries(r.summary).filter(([k,v])=>k!=='交付物'&&v&&v!=='未说明').map(([k,v])=>k+'：'+v).join('；')||r.detail:'覆盖该客户要求，并提供可核验依据',owner:state.project.owner,requirement:r.id,status:'待提交'})}
$('#confirmAll').onclick=()=>{state.requirements.filter(r=>r.status!=='已确认').forEach(confirmRequirement);update()};
function renderRequirements(){$('#confirmAll').disabled=!state.requirements.some(r=>r.status!=='已确认');$('#reqCount').textContent=state.chats.length;$('#candidateRows').innerHTML=state.chats.map(m=>'<article class="req-source"><b>'+escapeHtml(m.source||'聊天原文')+'</b><p>'+escapeHtml(m.text)+'</p></article>').join('');$('#deliverableCount').textContent=state.deliverables.length;$('#requirementsList').innerHTML=state.requirements.length?state.requirements.map(r=>`<article class="req-card"><div class="req-top"><div class="req-title"><span class="req-id">${escapeHtml(r.id)}</span>需求描述 · ${escapeHtml(r.detail)}</div><span class="status ${r.status==='已确认'?'ok':''}">${escapeHtml(r.status)}</span></div><div class="field-grid">${r.summary?Object.entries(r.summary).map(([k,v])=>`<p><b>${escapeHtml(k)}</b>　${escapeHtml(v||"未说明")}</p>`).join(""):""}</div><details class="source-detail"><summary>查看来源</summary><p>${escapeHtml(r.evidence)}</p></details><div class="req-actions"><button class="link-button" data-confirm="${r.id}">✓ 确认需求</button><button class="link-button muted" data-edit-req="${r.id}">编辑</button><button class="link-button muted" data-remove-req="${r.id}">移除</button></div></article>`).join(''):`<div class="empty-state compact"><div class="empty-symbol">☷</div><b>尚无汇总条目</b><span>点击「分析客户需求」整理候选原文。</span></div>`;$$('[data-confirm]').forEach(b=>b.onclick=()=>{const r=state.requirements.find(x=>x.id===b.dataset.confirm);confirmRequirement(r);update()});$$('[data-remove-req]').forEach(b=>b.onclick=()=>{state.deliverables=state.deliverables.filter(d=>d.requirement!==b.dataset.removeReq);state.requirements=state.requirements.filter(x=>x.id!==b.dataset.removeReq);update()});$$('[data-edit-req]').forEach(b=>b.onclick=()=>{const r=state.requirements.find(x=>x.id===b.dataset.editReq);const v=prompt('编辑需求内容',r.detail);if(v?.trim()){r.detail=v.trim();update()}});renderDeliverables()}
function guessDeliverable(text){if(/上线|试点|时间|负责人/.test(text))return'上线计划与试点安排';if(/数据|指标|统计/.test(text))return'数据指标与口径说明';if(/汇报|方案/.test(text))return'项目方案与汇报材料';if(/图片|页面|展示/.test(text))return'页面设计与展示素材';if(/手册|指南/.test(text))return'产品操作手册';if(/安全|部署/.test(text))return'安全与部署说明';return'客户要求对应交付材料'}
function renderDeliverables(){$('#deliverablesList').innerHTML=state.deliverables.length?state.deliverables.map(d=>`<article class="deliverable-card"><div class="deliverable-index">${escapeHtml(d.id)}</div><div class="deliverable-body"><div class="deliverable-head"><b>${escapeHtml(d.name)}</b><span class="status ${d.status==='已提交'?'ok':''}">${escapeHtml(d.status)}</span></div><small>关联需求：${escapeHtml(d.requirement||'手动添加')}　·　负责人：${escapeHtml(d.owner||'待分配')}</small><p>验收标准：${escapeHtml(d.standard)}</p><button class="link-button muted" data-edit-del="${d.id}">编辑清单项</button></div></article>`).join(''):`<div class="empty-state compact"><div class="empty-symbol">☑</div><b>确认需求后生成交付清单</b><span>可设置交付物、负责人、截止时间和验收标准。</span></div>`;$$('[data-edit-del]').forEach(b=>b.onclick=()=>{const d=state.deliverables.find(x=>x.id===b.dataset.editDel);const v=prompt('交付物名称',d.name);if(v?.trim()){d.name=v.trim();update()}})}
function renderMaterials(){$('#materialCount').textContent=state.docs.length;$('#qualityDocs').textContent=state.docs.length;$('#materialsList').innerHTML=state.docs.length?state.docs.map((d,i)=>`<article class="material-card"><div class="material-type">${/image/i.test(d.type)||/\.(png|jpe?g|webp)$/i.test(d.name)?'▧':/video/i.test(d.type)||/\.(mp4|webm)$/i.test(d.name)?'▷':'▤'}</div><div class="material-info"><b>${escapeHtml(d.name)}</b><small>${escapeHtml(d.type)} · ${(d.size/1024).toFixed(1)} KB</small><select data-link-doc="${i}"><option value="">关联交付清单项</option>${state.deliverables.map(x=>`<option ${d.deliverable===x.id?'selected':''} value="${escapeHtml(x.id)}">${escapeHtml(x.name)}</option>`).join('')}</select></div><span class="status ${d.status==='已检查'?'ok':''}">${d.status}</span><button class="link-button muted" data-remove-doc="${i}">移除</button></article>`).join(''):`<div class="empty-state wide"><div class="empty-symbol">▤</div><b>还没有上传交付材料</b><span>上传文件后，为材料关联清单项并运行质量检查。</span><button class="secondary" id="emptyUpload">选择项目文件</button></div>`;$('#emptyUpload')?.addEventListener('click',()=>$('#docInput').click());$$('[data-link-doc]').forEach(s=>s.onchange=()=>{state.docs[Number(s.dataset.linkDoc)].deliverable=s.value;update()});$$('[data-remove-doc]').forEach(b=>b.onclick=()=>{state.docs.splice(Number(b.dataset.removeDoc),1);update()})}
let knowledgeChecked=new Set();
function renderKnowledgeChecks(){
  $('#knowledgeCount').textContent=knowledgeChecked.size+' / '+deliveryKnowledge.checks.length;
  $('#knowledgeChecks').innerHTML=deliveryKnowledge.checks.map(([id,label])=>'<label><input type="checkbox" data-check="'+id+'" '+(knowledgeChecked.has(id)?'checked':'')+'> '+label+'</label>').join('');
}
$('#knowledgeChecks').onchange=e=>{const id=e.target.dataset.check;if(!id)return;if(e.target.checked)knowledgeChecked.add(id);else knowledgeChecked.delete(id);renderKnowledgeChecks();persistState()};
$('#knowledgeContents').innerHTML='<p>'+deliveryKnowledge.scope+'</p><p>'+deliveryKnowledge.principle+'</p>'+deliveryKnowledge.sections.map(s=>'<details><summary>'+s.title+'</summary>'+s.rules.map(([id,name,check,fix])=>'<article><h4>'+id+' · '+name+'</h4><p>'+check+'</p><p>'+fix+'</p></article>').join('')+'</details>').join('')+[ ['场景与框架',deliveryKnowledge.scenarios],['高危句式改写',deliveryKnowledge.rewrites] ].map(([title,rows])=>'<details><summary>'+title+'</summary>'+rows.map(([a,b])=>'<p><b>'+a+'</b>　'+b+'</p>').join('')+'</details>').join('');
renderKnowledgeChecks();
const projects=new Map();
const fields=['project','chats','docs','requirements','deliverables','screenshots','botConnected'];
let stateLoaded=false,saveTimer,saving=Promise.resolve(),editing=false;
function snapshot(){return {knowledgeChecked:[...knowledgeChecked],...Object.fromEntries(fields.map(k=>[k,state[k]])),rules:$('#rules').value,room:$('#captureRoom').value};}
function remember(){projects.set(captureProject(),snapshot());}
function listProjects(){const menu=$('#projectMenu');menu.innerHTML=[...projects].map(([id,p])=>'<option value="'+escapeHtml(id)+'">'+escapeHtml(p.project.name)+'</option>').join('');menu.value=captureProject();}
function persistState(){if(!stateLoaded)return;remember();listProjects();clearTimeout(saveTimer);saveTimer=setTimeout(()=>{const body=JSON.stringify({state:{active:captureProject(),projects:[...projects.values()],model:state.model}});saving=saving.catch(()=>{}).then(async()=>{const res=await fetch('/api/state',{method:'PUT',body,headers:{'content-type':'application/json'}});if(!res.ok)throw Error('项目保存失败')}).catch(e=>{$('#summaryStatus').textContent=e.message})},150)}
function restore(p){knowledgeChecked=new Set(p.knowledgeChecked||[]);renderKnowledgeChecks();$('#answerInput').value='';$('#screenshotResult').textContent='';$('#captureStatus').textContent='正在读取项目监测状态';$('#feedback').textContent='尚未开始演练';for(const k of fields)state[k]=p[k]??(k==='botConnected'?false:[]);$('#rules').value=p.rules||'';$('#captureRoom').value=p.room||'';$('#captureEvents').replaceChildren();captureMarkup='';$('#report').textContent='尚未运行检查';$('#summaryStatus').textContent='';state.selectedScreenshot=null;$('#recognizeScreenshot').disabled=true;window.dispatchEvent(new Event('project-changed'));}
async function loadPersistedState(){try{const data=(await(await fetch('/api/state')).json()).state||JSON.parse(localStorage.getItem('projectState')||'null');if(data){for(const p of data.projects||[data]){p.project.id ||= JSON.stringify([p.project.customer,p.project.name]);projects.set(p.project.id,p)}restore(projects.get(data.active)||projects.values().next().value);if(data.model)state.model=data.model}}finally{stateLoaded=true;update()}}
$('#projectMenu').onchange=e=>{remember();restore(projects.get(e.target.value));update();pollCapture();page('project')};
function update(){renderProjects();renderRequirements();renderMaterials();$('#qualityReqs').textContent=state.requirements.filter(r=>r.status==='已确认').length;persistState()}
function page(name){$$('.page').forEach(p=>p.classList.toggle('active',p.id===`page-${name}`));$$('[data-page]').forEach(b=>b.classList.toggle('active',b.dataset.page===name));const names={projects:'项目列表',project:'项目概览',requirements:'需求与交付清单',materials:'交付材料',quality:'质量检查',rehearsal:'汇报演练'};$('#breadcrumbCurrent').textContent=names[name]||'项目概览';if(['project','requirements','materials','quality','rehearsal'].includes(name)){$$('.step').forEach(s=>s.classList.toggle('active',s.dataset.page===name))}window.scrollTo(0,0)}
$$('[data-page]').forEach(b=>b.onclick=()=>page(b.dataset.page));$$('[data-next]').forEach(b=>b.onclick=()=>page(b.dataset.next));$('#newProject').onclick=$('#newProjectCard').onclick=()=>{editing=false;$('#projectForm').reset();$('#projectDialog').showModal()};$('#editProject').onclick=()=>{editing=true; $('#newName').value=state.project.name;$('#newCustomer').value=state.project.customer;$('#newOwner').value=state.project.owner;$('#projectDialog').showModal()};$('#projectForm').addEventListener('submit',e=>{if(e.submitter?.id==='createProject'||e.submitter?.value==='default'){e.preventDefault();remember();const id=editing?captureProject():crypto.randomUUID();if(!editing)restore({project:{id},chats:[],docs:[],requirements:[],deliverables:[],screenshots:[]});state.project={id,name:$('#newName').value.trim()||state.project.name,customer:$('#newCustomer').value.trim(),owner:$('#newOwner').value.trim()||'待分配'};$('#projectDialog').close();update();page('project')}});
$$('.choice').forEach(b=>b.onclick=()=>{$$('.choice').forEach(x=>x.classList.toggle('active',x===b));$('#importPanel').classList.toggle('hidden',b.dataset.source!=='import');$('#botPanel').classList.toggle('hidden',b.dataset.source!=='bot');$('#screenshotPanel').classList.toggle('hidden',b.dataset.source!=='screenshot');if(b.dataset.source==='screenshot')refreshVisionModels()});$$('input[name="captureMode"]').forEach(r=>r.onchange=()=>$('#targetCapture').classList.toggle('hidden',r.value!=='targeted'||!r.checked));$('#chatPick').onclick=()=>$('#chatInput').click();$('#chatInput').onchange=e=>addChats([...e.target.files]);$('#docPick').onclick=()=>$('#docInput').click();$('#emptyUpload')?.addEventListener('click',()=>$('#docInput').click());$('#docInput').onchange=e=>addDocs([...e.target.files]);
$('#screenshotPick').onclick=()=>$('#screenshotInput').click();$('#screenshotInput').onchange=e=>{const f=e.target.files?.[0];if(!f)return;if(f.size>8*1024*1024){alert('截图最大 8 MB');e.target.value='';return}state.selectedScreenshot=f;$('#screenshotName').textContent=f.name;$('#recognizeScreenshot').disabled=false;$('#screenshotResult').classList.add('hidden')};
async function refreshVisionModels(){const select=$('#visionModel');select.innerHTML='<option value="">正在检测本机视觉模型…</option>';try{const result=await(await fetch('/api/health')).json();state.visionModels=(result.models||[]).sort((a,b)=>Number(b==='qwen3:4b')-Number(a==='qwen3:4b'));select.innerHTML=state.visionModels.length?state.visionModels.map(m=>`<option value="${escapeHtml(m)}">${escapeHtml(m)}</option>`).join(''):'<option value="">未发现本机分析模型</option>'}catch{select.innerHTML='<option value="">无法连接 Ollama</option>'}}
const captureProject = () => state.project.id || JSON.stringify([state.project.customer,state.project.name]);
async function refreshWechatWindows(){const select=$('#wechatWindow');select.innerHTML='<option value="">正在查找微信窗口…</option>';try{const result=await(await fetch('/api/wechat/windows')).json();select.innerHTML=result.windows?.length?result.windows.map((w,i)=>`<option value="${escapeHtml(w.hwnd)}">${escapeHtml(w.app)} · ${escapeHtml(w.title||`聊天窗口 ${i+1}`)}</option>`).join(''):`<option value="">${escapeHtml(result.error||'未发现已打开的微信窗口')}</option>`}catch{select.innerHTML='<option value="">无法读取微信窗口</option>'}}
$('#refreshWechatWindows').onclick=refreshWechatWindows;
$('#startWechatCapture').onclick=async()=>{const model=$('#visionModel').value,hwnd=$('#wechatWindow').value,group=$('#captureRoom').value.trim();if(!hwnd){$('#captureStatus').textContent='请先刷新并选择微信窗口';return}if(group.length<2){$('#captureStatus').textContent='请填写准确的目标群聊名称';return}const button=$('#startWechatCapture');button.disabled=true;try{const result=await(await fetch('/api/wechat/capture/start',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({hwnd,group,model,project:captureProject(),intervalSec:$('#captureInterval').value})})).json();if(!result.active)throw new Error(result.error||'监测未能启动');$('#captureStatus').textContent=`监测中 · ${result.title} · 群聊：${result.group} · 每 ${result.intervalSec} 秒`;$('#stopWechatCapture').disabled=false;$('#globalCaptureBadge').classList.remove('hidden')}catch(e){$('#captureStatus').textContent=e.message}finally{button.disabled=false}};
$('#stopWechatCapture').onclick=async()=>{await fetch('/api/wechat/capture/stop',{method:'POST',body:JSON.stringify({project:captureProject()})});$('#captureStatus').textContent='监测已停止';$('#stopWechatCapture').disabled=true;$('#globalCaptureBadge').classList.add('hidden')};
let captureMarkup="";
function card(r) {
  const stages={saved:'等待 OCR',ocr:'正在识别文字',transcribed:'OCR 原文已保存',review:'待核对群名',ready:'等待模型分析',analyzing:'正在提取需求',done:r.analysisMode==='candidate'?'候选原文 · 待人工核对':'分析完成',excluded:'已排除',ocrError:'OCR 失败',modelError:'分析失败'};
  const button=(action,label)=>`<button class="secondary" data-file="${escapeHtml(r.file)}" data-action="${action}">${label}</button>`;
  const elapsed=ms=>(ms/1000).toFixed(1)+' 秒';
  const timing=[r.ocrMs!=null?'OCR '+elapsed(r.ocrMs):'',r.modelMs!=null?'分析 '+elapsed(r.modelMs):'', ['analyzing','ocr'].includes(r.stage)?'已用 '+elapsed(Math.max(0,Date.now()-r.started)):''].filter(Boolean).join(' · ');
  const actions=r.stage==='transcribed'?button('view','查看需求候选'):r.stage==='review'?button('confirm','确认并加入候选')+button('exclude','排除此图'):r.error?button('retry','重试'):'';
  return `<article class="capture-event"><div><b>${escapeHtml(r.group)}</b><time>${new Date(r.at).toLocaleTimeString()}</time></div><a href="/captures/${r.file}" target="_blank" rel="noreferrer"><img class="saved-shot" loading="lazy" src="/captures/${r.file}" alt="查看已保存截图"></a><p>${stages[r.stage]} ${r.manual?' · 人工确认':''} ${timing}</p>${r.stage==='review'?`<p>顶部识别文字：${escapeHtml(r.title||'未读到')}</p>`:''}${r.analysisNote?`<p>已回退到原文筛选：${escapeHtml(r.analysisNote)}</p>`:''}${r.error?`<p>${escapeHtml(r.error)}</p>`:''}${r.text!==undefined?'<p><b>OCR 原文</b></p><pre style="white-space:pre-wrap;max-height:14em;overflow:auto">'+escapeHtml(r.text||'未识别到文字')+'</pre>':''}${actions}${r.ocrMs!=null?button('vision','本机视觉复核'):''}</article>`;
}
async function pollCapture(){
  const project=captureProject();
  try{
    const status=await(await fetch('/api/wechat/capture/status?project='+encodeURIComponent(project))).json();
    if(project!==captureProject())return;
    const records=status.records;
    $('#globalCaptureBadge').classList.toggle('hidden',!status.active);
    $('#stopWechatCapture').disabled=!status.active;
    $('#captureStatus').textContent=status.active?'监测中 · '+status.group+(status.lastError?' · '+status.lastError:''):'监测已停止';
    const requirements=new Set(records.flatMap(r=>r.requirements||[]));
    $('#frameTotals').textContent=`已截图 ${records.length} 张 · 已识别 ${records.filter(r=>r.ocrMs!=null).length} 张 · 待核对 ${records.filter(r=>r.stage==='review').length} 张 · 已提取需求 ${requirements.size} 条`;
    const html=records.slice().reverse().map(card).join('');
    if(html!==captureMarkup){$('#captureEvents').innerHTML=html;captureMarkup=html}
    let changed=false;
    for(const r of records.filter(r=>Array.isArray(r.rows))){
      if(state.screenshots.some(s=>s.name===r.file))continue;
      const source=`${r.group} · ${r.file}`;
      state.screenshots.push({name:r.file,source,count:r.rows.length});
      state.chats.push(...r.rows.map(text=>({text,source,speaker:'OCR',date:new Date(r.at).toLocaleString()})));
      for(const detail of r.requirements||[]){
        if(!state.requirements.some(req=>req.detail===detail))state.requirements.push({id:`R-${String(state.requirements.length+1).padStart(2,'0')}`,detail,source,evidence:source,speaker:r.analysisMode==='candidate'?'候选原文':'模型筛选',date:new Date(r.at).toLocaleString(),status:'待确认'});
      }
      changed=true;
    }
    if(changed)update();
  }catch(error){$('#captureStatus').textContent='读取截图进度失败：'+error.message}
}
$('#captureEvents').onclick=async e=>{
  const button=e.target.closest('button[data-action]');
  if(!button)return;
  if(button.dataset.action==='vision'){
    const project=captureProject(),file=button.dataset.file;button.disabled=true;button.textContent='复核中…';
    try{
      const response=await fetch('/api/ocr-review',{method:'POST',body:JSON.stringify({project,file})}),result=await response.json();
      if(project!==captureProject())return;
      if(!response.ok)throw Error(result.error);
      const reviewed=prompt('核对识别文字后加入本项目候选',result.text);
      if(reviewed?.trim()){const source='视觉复核 · '+file;state.chats=state.chats.filter(r=>r.source!==source);state.chats.push(...parseChat(reviewed,source));update();}
    }catch(e){alert(e.message)}finally{button.disabled=false;button.textContent='本机视觉复核'}return;
  }
  if(button.dataset.action==='view'){page('requirements');return}
  button.disabled=true;
  try {
    const res=await fetch('/api/wechat/capture/decision',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({file:button.dataset.file,action:button.dataset.action,project:captureProject(),model:$('#visionModel').value})});
    if(!res.ok)throw Error((await res.json()).error);
    await pollCapture();
  }catch(error){alert(error.message);button.disabled=false}
};
setInterval(pollCapture,2500);
$('#refreshVisionModels').onclick=refreshVisionModels;$('#recognizeScreenshot').onclick=async()=>{
  const file=state.selectedScreenshot;
  if(!file)return;
  const btn=$('#recognizeScreenshot'), result=$('#screenshotResult');
  btn.disabled=true;
  result.classList.remove('hidden');
  try {
    const bytes=new Uint8Array(await file.arrayBuffer());
    let binary='';
    for(let i=0;i<bytes.length;i+=0x8000)binary+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    const response=await fetch('/api/recognize-image',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({
      model:$('#visionModel').value,data:btoa(binary),source:file.name,project:captureProject()
    })});
    if(!response.ok)throw Error((await response.json()).error);
    result.textContent='截图已加入本项目，识别进度见截图列表。';
    await pollCapture();
  }catch(error){result.textContent=error.message}finally{btn.disabled=false}
};
$('#loadScreenshotDemo').onclick=()=>{const source=document.querySelector('input[name="captureMode"]:checked').value==='targeted'?`本机应用 · ${$('#captureRoom').value||'凌云办公协同升级项目群'}`:'用户手动截图';const m={date:'2026-11-22 10:24',speaker:'客户王经理',text:'汇报材料请增加移动端审批页面截图，并标注审批时长数据的统计口径。',source:`截图演示：${source}`};state.chats.push(m);state.screenshots.push({name:'本地截图_演示.png',source,count:1});$('#screenshotResult').classList.remove('hidden');$('#screenshotResult').innerHTML=`<b>演示 OCR 结果 · 待人工确认</b><p>${escapeHtml(m.text)}</p><small>来源：截图演示 · ${escapeHtml(source)} · 原文已加入需求候选</small>`;update()};
$('#connectBot').onclick=()=>{state.botConnected=!state.botConnected;$('#botConnection').classList.toggle('hidden',!state.botConnected);$('.bot-config').classList.toggle('hidden',state.botConnected);$('#projectMeta').textContent=`客户：${state.project.customer||'未填写'}　·　负责人：${state.project.owner||'未分配'}　·　${state.botConnected?'聊天同步中':'进行中'}`};
$('#simulateIncoming').onclick=()=>{const samples=[{date:'刚刚',speaker:'客户王经理',text:'再补充一项：汇报材料需要展示移动端审批页面截图，并标注审批时长数据的统计口径。'},{date:'刚刚',speaker:'客户李老师',text:'请在最终方案中增加管理员权限配置说明，周五前给我们确认。'},{date:'刚刚',speaker:'产品小林',text:'已收到，正在补充材料。'}];const m=samples[state.botMessageIndex++%samples.length];state.chats.push({...m,source:'凌云办公协同升级项目群'});const box=$('#botMessages');box.querySelector('.bot-empty')?.remove();box.insertAdjacentHTML('afterbegin',`<article class="bot-message"><div><b>${escapeHtml(m.speaker)}</b><time>${m.date}</time></div><p>${escapeHtml(m.text)}</p><span class="message-tag">新消息 · 已进入需求识别</span></article>`);update()};
$('#extractBtn').onclick=async()=>{
  const button=$('#extractBtn'),status=$('#summaryStatus');
  if(!state.chats.length){status.textContent='请先导入聊天或识别截图。';return}
  const project=captureProject(), rows=state.chats.slice(), start=performance.now();
  button.disabled=true; status.textContent='正在分析 '+rows.length+' 条候选原文…';
  try{
    const res=await fetch('/api/customer-summary',{method:'POST',headers:{'content-type':'application/json'},
      body:JSON.stringify({model:$('#visionModel').value||state.model,rows})});
    const result=await res.json();
    if(!res.ok)throw Error(result.error);
    if(project!==captureProject())return;
    let next=Math.max(0,...state.requirements.map(r=>Number(r.id.replace('R-',''))||0))+1;
    const retained=state.requirements.filter(r=>!r.summary||r.status==='已确认'||result.warning);
    for(const item of result.items){
      const row=rows[item.line-1], detail=item['需求描述'];
      const evidence=(row.source||'聊天')+' · '+row.text;
      if(retained.some(r=>r.evidence===evidence&&r.detail===detail))continue;
      const summary=Object.fromEntries(['注意事项','交付物','交付时间','格式要求'].map(k=>[k,item[k]||'未说明']));
      retained.push({id:'R-'+String(next++).padStart(2,'0'),detail,summary,evidence,source:row.source,date:row.date,speaker:row.speaker,status:'待确认'});
    }
    state.requirements=retained;
    update();status.textContent=(result.warning||'分析完成')+' · 本次 '+result.items.length+' 条 · '+((performance.now()-start)/1000).toFixed(1)+' 秒';
  }catch(error){status.textContent='分析失败，候选原文已保留。'+error.message}finally{button.disabled=false}
};
$('#loadSample').onclick=()=>{state.chats=parseChat(`2026-11-14 10:12 | 客户王经理 | 首页要展示团队协同效率，重点突出任务按时完成率和跨部门协作时长。\n2026-11-14 11:36 | 客户王经理 | 汇报里需要补一页上线计划，写清楚试点范围、时间和负责人。\n2026-11-15 09:20 | 客户李老师 | 交付材料必须包含管理员操作手册和员工快速上手指南。\n2026-11-15 15:05 | 产品小林 | 收到，数据会补充统计口径和来源。\n2026-11-16 10:44 | 客户王经理 | 下周三前提供最终方案，请确认移动端审批流程也覆盖了。\n2026-11-16 14:30 | 客户李老师 | 汇报时请重点说明数据安全和本地部署方式。`,'客户沟通记录_演示.txt');state.requirements=[];state.deliverables=[];state.docs=[{name:'项目汇报稿_演示.md',size:4360,text:'# 凌云办公协同升级项目汇报\n\n## 项目目标\n提升跨团队协作效率，降低任务延期。\n\n## 方案设计\n建设任务看板、移动端审批和协同工作台，支持本地化部署。\n\n## 当前成效\n试点团队任务按时完成率提升至 92%。数据来自项目后台，统计周期为 2026 年 10 月。\n\n## 实施安排\n11 月启动试点，12 月推广。\n\n## 风险与保障\n数据在企业内部环境存储，采用权限分级管理。',type:'text/markdown',status:'待检查'}];$('#rules').value='汇报需说明客户痛点、上线计划、移动端审批覆盖、数据安全和本地部署；所有数据需注明来源和统计口径。';update();page('requirements')};
$('#addDeliverable').onclick=()=>$('#deliverableDialog').showModal();$('#deliverableForm').addEventListener('submit',e=>{if(e.submitter?.id==='saveDeliverable'||e.submitter?.value==='default'){e.preventDefault();state.deliverables.push({id:`D-${String(state.deliverables.length+1).padStart(2,'0')}`,name:$('#deliverableName').value.trim(),standard:$('#deliverableStandard').value.trim()||'待补充验收标准',owner:$('#deliverableOwner').value.trim()||'待分配',status:'待提交'});$('#deliverableForm').reset();$('#deliverableDialog').close();update()}});
$('#saveRules').onclick=()=>{persistState();$('#saveRules').textContent='已保存 ✓';setTimeout(()=>$('#saveRules').textContent='保存规范',1500)};$('#rules').value=localStorage.getItem('projectRules')||'';
function showProvider(info){
  $('.ocr-model-row').hidden=info.mode==='api';
  $('#analysisMode').textContent=info.mode==='api'?'API 分析 · '+info.model:'本机 Ollama';
}
async function readProvider(){
  const response=await fetch('/api/model-settings');
  if(!response.ok)throw Error('无法读取模型设置');
  const info=await response.json();
  showProvider(info);
  return info;
}
function toggleProvider(){
  const remote=$('#providerMode').value==='api';
  $('#remoteFields').hidden=!remote;$('#localFields').hidden=remote;
}
$('#providerMode').onchange=toggleProvider;
$('#modelSettings').onclick=async()=>{
  const dialog=$('#settingsDialog');dialog.showModal();
  try{
    const info=await readProvider();
    $('#localSpeech').checked=info.localSpeech;$('#providerMode').value=info.mode;$('#providerUrl').value=info.baseUrl;$('#providerModel').value=info.model;$('#asrModel').value=info.asrModel;
    $('#providerKey').value='';$('#providerKey').placeholder=info.hasKey?'已配置，留空沿用':'填写 API Key';
    $('#modelName').value=state.model;$('#connectionStatus').textContent='';toggleProvider();
  }catch(e){$('#connectionStatus').textContent=e.message}
};
async function saveProvider(test){
  const status=$('#connectionStatus');
  $('#checkConnection').disabled=$('#saveSettings').disabled=true;
  try{
    const res=await fetch('/api/model-settings',{method:'PUT',headers:{'content-type':'application/json'},body:JSON.stringify({
      localSpeech:$('#localSpeech').checked,mode:$('#providerMode').value,baseUrl:$('#providerUrl').value.trim(),model:$('#providerModel').value.trim(),asrModel:$('#asrModel').value.trim(),key:$('#providerKey').value.trim()
    })});
    const info=await res.json();if(!res.ok)throw Error(info.error);
    $('#providerKey').value='';showProvider(info);
    state.model=$('#modelName').value.trim()||'qwen3:4b';localStorage.setItem('localModel',state.model);persistState();
    if(!test){if(info.sessionOnly && info.mode==='api'){status.textContent='已启用 API。当前 Windows 会话无法加密保存密钥，应用重启后将使用本地模型。';return}$('#settingsDialog').close();return}
    status.textContent='已保存，正在测试…';
    const reply=await fetch('/api/model-test',{method:'POST',body:JSON.stringify({model:state.model})});
    const data=await reply.json();if(!reply.ok)throw Error(data.error);
    status.textContent='连接成功 · '+(data.ms/1000).toFixed(1)+' 秒'+(info.sessionOnly?' · 密钥仅在本次运行有效':'');
  }catch(e){status.textContent=e.message}finally{$('#checkConnection').disabled=$('#saveSettings').disabled=false}
}
$('#saveSettings').onclick=()=>saveProvider(false);$('#checkConnection').onclick=()=>saveProvider(true);
readProvider().catch(()=>{});
function reviewBlocks(text){
 const inline=s=>escapeHtml(s).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>');
 const lines=text.split(/\r?\n/),out=[];
 for(let i=0;i<lines.length;i++){
   const line=lines[i].trim();
   if(!line||/^[-*_]{3,}$/.test(line))continue;
   if(line.includes('|') && /^\s*\|?[\s:|-]+\|/.test(lines[i+1]||'')){
     const cells=s=>s.trim().replace(/^\||\|$/g,'').split('|');
     const head=cells(line);let table='<table><thead><tr>'+head.map(v=>'<th>'+inline(v)+'</th>').join('')+'</tr></thead><tbody>';i++;
     while(i+1<lines.length&&lines[i+1].includes('|'))table+='<tr>'+cells(lines[++i]).map(v=>'<td>'+inline(v)+'</td>').join('')+'</tr>';
     out.push('<div class="review-table">'+table+'</tbody></table></div>');
   }else if(/^#{1,6}\s/.test(line))out.push('<h3>'+inline(line.replace(/^#+\s*/,''))+'</h3>');
   else out.push('<p>'+inline(line.replace(/^[-*]\s+/,'• ').replace(/^>\s*/,''))+'</p>');
 }
 return out.join('');
}
$('#runReview').onclick=runReview;async function runReview(){const project=captureProject();page('quality');const confirmed=state.requirements.filter(r=>r.status==='已确认');const host=$('#report');host.innerHTML='<div class="empty-state"><b>正在检查项目材料…</b><span>使用所选模型</span></div>';$('#qualityModel').textContent='检查中';try{const result=await(await fetch('/api/review',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({model:state.model,requirements:confirmed.length?confirmed:state.requirements,documents:state.docs,rules:$('#rules').value+' 请分别从产品验收、运营指标口径、销售承诺和证据一致性检查。'})})).json();if(project!==captureProject())return;if(['api','ollama'].includes(result.mode)){host.innerHTML=`<div class="model-note">${result.mode==='api'?'模型 API':'本地模型'} ${escapeHtml(result.model||state.model)} · ${confirmed.length} 项已确认需求 · ${state.docs.length} 份材料</div><article class="review-card good"><h3>模型审查意见</h3>${reviewBlocks(result.answer)}</article>`;$('#qualityIssues').textContent='已生成';$('#qualityModel').textContent=result.mode==='api'?'模型 API':'本地模型'}else{host.innerHTML=(result.warning?`<div class="model-note">${escapeHtml(result.warning)}</div>`:'<div class="model-note">规则演示模式：关键词匹配结果，仅用于展示流程。</div>')+(result.items||[]).map(x=>`<article class="review-card ${x.status.includes('可能缺失')||x.status.includes('无法')?'risk':''}"><div class="review-top"><h3>${escapeHtml(x.requirement?x.requirement+' · ':'')}${escapeHtml(x.title)}</h3><span class="status">${escapeHtml(x.status)}</span></div><div class="review-evidence">证据：${escapeHtml(x.evidence)} ${x.source?'· 来源：'+escapeHtml(x.source):''}</div><p>建议：${escapeHtml(x.suggestion)}</p></article>`).join('');$('#qualityIssues').textContent=`${(result.items||[]).length} 项`;$('#qualityModel').textContent='规则模式'}state.docs.forEach(d=>d.status='已检查');renderMaterials();renderProjects()}catch(e){host.innerHTML=`<article class="review-card risk"><h3>检查暂未完成</h3><p>${escapeHtml(e.message)}</p></article>`;$('#qualityIssues').textContent='失败';$('#qualityModel').textContent='未连接'}}
$('#projectSearch').oninput=()=>{$('[data-project-card]').style.display=$('#cardProjectName').textContent.toLowerCase().includes($('#projectSearch').value.toLowerCase())?'block':'none'};$('#projectFilter').onchange=()=>{};update();page('projects');loadPersistedState();
const memories = JSON.parse(localStorage.getItem('deliveryLessons') || '[]');
const archive = document.createElement('button');
archive.textContent = '保存本次复盘到个人知识库';
archive.className = 'secondary';
$('#feedback').after(archive);
const history = document.createElement('details');
archive.after(history);
function showLessons(){
  history.innerHTML = '<summary>个人知识库（'+memories.length+'）</summary>'+memories.map(m=>'<p>'+escapeHtml(m.project+' · '+m.note)+'</p>').join('');
}
showLessons();
archive.onclick=()=>{
  const note=prompt('确认可复用的项目经验', $('#feedback').innerText.slice(0,1500));
  if(note?.trim()){memories.push({project:state.project.name,note:note.trim()});localStorage.setItem('deliveryLessons',JSON.stringify(memories));showLessons();}
};
$('#meetingPick').onclick=()=>$('#meetingInput').click();
$('#meetingInput').onchange=async e=>{
 for(const f of e.target.files){
   try{
    const text=/\.vtt$/i.test(f.name)?(await f.text()).split(/\r?\n/).filter(l=>l.trim()&&!/^(WEBVTT|\d+$)|-->/.test(l)).join('\n'):(await fileText(f)).text;
    state.chats.push(...parseChat(text,'会议 · '+f.name));
   }catch(err){alert(err.message)}
 }
 update();e.target.value='';
};





function encodeSpeech(samples){
  const buffer=new ArrayBuffer(44+samples.length*2),view=new DataView(buffer);
  const tag=(offset,s)=>[...s].forEach((c,i)=>view.setUint8(offset+i,c.charCodeAt(0)));
  tag(0,'RIFF');view.setUint32(4,buffer.byteLength-8,true);tag(8,'WAVE');tag(12,'fmt ');
  view.setUint32(16,16,true);view.setUint16(20,1,true);view.setUint16(22,1,true);view.setUint32(24,16000,true);
  view.setUint32(28,32000,true);view.setUint16(32,2,true);view.setUint16(34,16,true);
  tag(36,'data');view.setUint32(40,samples.length*2,true);
  for(let i=0;i<samples.length;i++){const v=Math.max(-1,Math.min(1,samples[i]));view.setInt16(44+i*2,v*(v<0?32768:32767),true)}
  const bytes=new Uint8Array(buffer);let binary='';
  for(let i=0;i<bytes.length;i+=32768)binary+=String.fromCharCode(...bytes.subarray(i,i+32768));
  return btoa(binary);
}
async function speechToText(blob,progress,project){
  const context=new AudioContext({sampleRate:16000});
  let audio;
  try{audio=await context.decodeAudioData(await blob.arrayBuffer())}catch{throw Error('无法解码录音，请使用 WAV、MP3 或 M4A 文件。')}finally{await context.close()}
  const mono=new OfflineAudioContext(1,Math.ceil(audio.duration*16000),16000),source=mono.createBufferSource();
  source.buffer=audio;source.connect(mono.destination);source.start();
  const samples=(await mono.startRendering()).getChannelData(0);
  delete progress.dataset.engine;const size=120*16000,parts=[];
  for(let pos=0;pos<samples.length;pos+=size){
    if(project!==captureProject())throw Error('项目已切换，请在原项目重新转写。');
    progress.textContent=`正在转写 ${parts.length+1} / ${Math.ceil(samples.length/size)} 段…`;
    const response=await fetch('/api/transcribe',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({wav:encodeSpeech(samples.subarray(pos,pos+size))})});
    const result=await response.json();if(!response.ok)throw Error(result.error||'转写失败');
    parts.push(result.text);if(result.engine==='Windows 中文转写')progress.dataset.engine=result.engine;
  }
  if(project!==captureProject())throw Error('项目已切换，请在原项目重新转写。');
  return parts;
}
async function requireSpeechAPI(){
  const info=await readProvider();
  if(!info.localSpeech&&(info.mode!=='api'||!info.hasKey))throw Error('请先在模型设置中启用 API，填写分析模型和语音转写模型。');
}
async function importMeeting(){
  const picker=$('#meetingAudio'),file=picker.files[0];if(!file)return;
  const button=$('#meetingPick'),progress=$('#meetingProgress'),project=captureProject();
  button.disabled=true;
  try{
    await requireSpeechAPI();
    const parts=await speechToText(file,progress,project);
    parts.forEach((text,i)=>state.chats.push({text,source:file.name,date:`录音 ${i*2}:00 起`,speaker:'会议转写'}));
    update();page('requirements');$('#summaryStatus').textContent='会议原文已加入候选，可点击「分析客户需求」。';progress.textContent='转写完成';
  }catch(e){progress.textContent=e.message}finally{button.disabled=false;picker.value=''}
}
$('#meetingPick').onclick=()=>$('#meetingAudio').click();
$('#meetingAudio').onchange=importMeeting;

