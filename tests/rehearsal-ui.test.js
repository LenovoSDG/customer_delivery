const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const {JSDOM}=require('jsdom');
function harness() {
 const dom=new JSDOM(fs.readFileSync(require.resolve('../index.html'),'utf8'),{runScripts:'outside-only',url:'http://127.0.0.1:4174/'}), w=dom.window;
 w.document.getElementById('page-rehearsal').classList.add('active');
 w.addEventListener('error',event=>{throw event.error;});
 let cancelCount=0, calls=0, resolveFetch;
 w.structuredClone=structuredClone; w.SpeechEngine=class{cancel(){cancelCount++;}};
 w.ModelSettings={selection:async()=>({provider:'bohrium',model:'test-model'})};
 w.fetch=async()=>{calls++; return new Promise(resolve=>{resolveFetch=resolve;});};
 w.state={project:{name:'演示'},requirements:[],docs:[]}; w.escapeHtml=s=>String(s).replaceAll('<','&lt;');
 w.eval(fs.readFileSync(require.resolve('../rehearsal-ui'),'utf8'));
 const el=id=>w.document.getElementById(id);
 return {w,el,close:()=>w.close(),get calls(){return calls;},get cancels(){return cancelCount;},resolve:result=>resolveFetch({ok:true,json:async()=>result}),type(text){el('answerInput').value=text;el('answerInput').dispatchEvent(new w.Event('input'));}};
}
const flush=()=>new Promise(setImmediate);
test('transcript requires explicit submit; plain Enter and IME composition cannot submit',async()=>{
 const h=harness();try {h.el('startRehearsal').click();h.type('管理员手册');h.el('answerInput').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',bubbles:true}));h.el('answerInput').dispatchEvent(new h.w.KeyboardEvent('keydown',{key:'Enter',ctrlKey:true,isComposing:true,bubbles:true}));await flush();assert.equal(h.calls,0);h.el('sendAnswer').click();await flush();assert.equal(h.calls,1);}finally{h.close();}
});
test('ending an in-flight turn keeps draft and ignores stale model output',async()=>{
 const h=harness();try{h.el('startRehearsal').click();h.type('保留我的草稿');h.el('sendAnswer').click();await flush();h.el('endRehearsal').click();h.resolve({summary:'过期反馈',question:'过期追问',strengths:[],improvements:[],evidence:[],warnings:[],model:'test-model'});await flush();assert.equal(h.el('answerInput').value,'保留我的草稿');assert.doesNotMatch(h.el('conversation').textContent,/过期/);assert.ok(h.cancels>0);assert.equal(h.el('sendAnswer').disabled,true);}finally{h.close();}
});
test('leaving rehearsal pauses recording and cancels pending work',async()=>{
 const h=harness();try {h.el('startRehearsal').click();h.el('page-rehearsal').classList.remove('active');await flush();assert.match(h.el('voiceStatus').textContent,/自动暂停/);assert.equal(h.el('pauseRehearsal').textContent,'继续演练');assert.ok(h.cancels>0);}finally{h.close();}
});
test('failed model turn preserves draft and never inserts fabricated feedback',async()=>{
 const h=harness();try{h.el('startRehearsal').click();h.type('待重试的回答');h.el('sendAnswer').click();await flush();h.resolve({error:'模型返回不完整'});await flush();assert.equal(h.el('answerInput').value,'待重试的回答');assert.equal(h.el('sendAnswer').disabled,false);assert.match(h.el('voiceStatus').textContent,/已保留/);assert.doesNotMatch(h.el('conversation').textContent,/待重试/);}finally{h.close();}
});
