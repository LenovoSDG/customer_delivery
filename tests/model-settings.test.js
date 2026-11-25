const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');
async function setup({ config = {}, catalog } = {}) {
  const dom = new JSDOM(fs.readFileSync('index.html','utf8'), {runScripts:'outside-only',url:'http://127.0.0.1:4174/'}), win = dom.window;
  const el = id=>win.document.getElementById(id), calls=[];
  win.eval("var state={model:'local:4b'};");
  let saved = {provider:'ollama',localModel:'local:4b',customBaseUrl:'',customModel:'',customKeyConfigured:false,...config};
  el('settingsDialog').showModal=()=>{el('settingsDialog').open=true;};
  el('settingsDialog').close=()=>{el('settingsDialog').open=false;el('settingsDialog').dispatchEvent(new win.Event('close'));};
  win.fetch=async(url,options={})=>{
    calls.push({url,options});
    if(url==='/api/model-config'&&!options.method)return Response.json(saved);
    if(url==='/api/api-models')return catalog ? catalog(options) : Response.json({models:['vendor/model-a','vendor/model-b']});
    if(url==='/api/model-config'&&options.method==='POST'){
      const payload=JSON.parse(options.body);const {customKey,...visible}=payload;
      saved={...saved,...visible,customKeyConfigured:!!customKey || (payload.customBaseUrl===saved.customBaseUrl && saved.customKeyConfigured)};
      return Response.json(saved);
    }
    throw new Error('Unexpected request');
  };
  win.eval(fs.readFileSync('model-settings.js','utf8'));await win.ModelSettings.ready;await el('modelSettings').onclick();
  return {win,el,calls,save:async()=>{el('modelSettingsForm').dispatchEvent(new win.SubmitEvent('submit',{cancelable:true,submitter:el('saveSettings')}));await new Promise(setImmediate);}};
}
test('the settings surface has exactly local and custom sources with no provider-specific forms',async()=>{
  const h=await setup();try{assert.deepEqual([...h.el('modelProvider').options].map(x=>x.value),['ollama','custom']);assert.equal(h.el('apiModelPanel'),null);assert.equal(h.el('deepseekModelPanel'),null);assert.doesNotMatch(h.el('settingsDialog').textContent,/玻尔|Bohrium|DeepSeek/);}finally{h.win.close();}
});
test('selecting a custom draft leaves the active source unchanged until saving',async()=>{
  const h=await setup();try{h.el('modelProvider').value='custom';h.el('modelProvider').dispatchEvent(new h.win.Event('change'));assert.equal(h.el('customModelPanel').hidden,false);assert.equal(h.el('localModelPanel').hidden,true);assert.equal((await h.win.ModelSettings.selection()).provider,'ollama');}finally{h.win.close();}
});
test('catalog requests use the editable draft URL and key, with manual model entry and explicit save',async()=>{
  const h=await setup();try{h.el('modelProvider').value='custom';h.el('customBaseUrl').value='https://service.example/v1';h.el('customKey').value='test-only-key';await h.el('refreshApiModels').onclick();assert.deepEqual([...h.el('apiModelOptions').children].map(x=>x.value),['vendor/model-a','vendor/model-b']);const draft=JSON.parse(h.calls.find(x=>x.url==='/api/api-models').options.body);assert.equal(draft.customBaseUrl,'https://service.example/v1');assert.equal(draft.customKey,'test-only-key');assert.equal(h.calls.filter(x=>x.options.method==='POST'&&x.url==='/api/model-config').length,0);h.el('customModelName').value='manual-model';await h.save();assert.equal(h.el('customKey').value,'');assert.equal(h.win.localStorage.length,0);const choice=await h.win.ModelSettings.selection();assert.equal(choice.provider,'custom');assert.equal(choice.model,'manual-model');assert.equal(choice.customBaseUrl,'https://service.example/v1');assert.match(h.el('processingNotice').textContent,/service\.example/);}finally{h.win.close();}
});
test('cancel discards the draft secret and reopening restores saved fields without exposing the key',async()=>{
  const h=await setup({config:{provider:'custom',customBaseUrl:'https://saved.example/v1',customModel:'saved-model',customKeyConfigured:true}});try{assert.equal(h.el('customKey').value,'');h.el('customBaseUrl').value='https://draft.example/v1';h.el('customKey').value='test-only-draft';h.el('cancelModelSettings').click();assert.equal(h.el('customKey').value,'');await h.el('modelSettings').onclick();assert.equal(h.el('customBaseUrl').value,'https://saved.example/v1');assert.equal(h.el('customModelName').value,'saved-model');assert.equal(h.el('customKey').value,'');}finally{h.win.close();}
});
test('missing URL blocks catalog lookup; an unsupported catalog does not prevent manually selecting a model',async()=>{
  const h=await setup({catalog:async()=>Response.json({error:'不支持模型列表'},{status:404})});try{await h.el('refreshApiModels').onclick();assert.equal(h.calls.filter(x=>x.url==='/api/api-models').length,0);h.el('modelProvider').value='custom';h.el('customBaseUrl').value='http://127.0.0.1:8000/v1';await h.el('refreshApiModels').onclick();assert.match(h.el('apiModelsStatus').textContent,/直接填写/);h.el('customModelName').value='local-chat';await h.save();assert.equal((await h.win.ModelSettings.selection()).model,'local-chat');}finally{h.win.close();}
});
test('editing the draft URL clears its draft key and prevents a stale catalog from replacing the new address choices',async()=>{
  let finish;const h=await setup({catalog:()=>new Promise(resolve=>finish=resolve)});try{h.el('customBaseUrl').value='https://first.example/v1';h.el('customKey').value='test-first-key';const pending=h.el('refreshApiModels').onclick();h.el('customBaseUrl').value='https://second.example/v1';h.el('customBaseUrl').dispatchEvent(new h.win.Event('input'));assert.equal(h.el('customKey').value,'');finish(Response.json({models:['first-model']}));await pending;assert.equal(h.el('apiModelOptions').children.length,0);}finally{h.win.close();}
});
