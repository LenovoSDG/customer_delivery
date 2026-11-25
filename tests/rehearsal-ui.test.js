const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const {JSDOM}=require('jsdom');
function harness() {
 const dom=new JSDOM(fs.readFileSync(require.resolve('../index.html'),'utf8'),{runScripts:'outside-only',url:'http://127.0.0.1:4174/'}), w=dom.window;
 w.document.getElementById('page-rehearsal').classList.add('active');
 w.addEventListener('error',event=>{throw event.error;});
 let cancelCount=0, calls=0, resolveFetch, callbacks, now=10000; const timers=[], bodies=[];
 w.Date.now=()=>now; w.setInterval=fn=>{timers.push(fn);return timers.length;};
 w.structuredClone=structuredClone; w.SpeechEngine=class{constructor(cb){callbacks=cb;} async start(){return true;} async stop(){callbacks.text('我们需要补充管理员操作手册');callbacks.partial('');} cancel(){cancelCount++;}};
 w.ModelSettings={selection:async()=>({provider:'bohrium',model:'test-model'})};
 w.fetch=async(url,options)=>{calls++;bodies.push(JSON.parse(options.body)); return new Promise(resolve=>{resolveFetch=resolve;});};
 w.state={project:{name:'演示'},requirements:[],docs:[]}; w.escapeHtml=s=>String(s).replaceAll('<','&lt;');
 w.eval(fs.readFileSync(require.resolve('../rehearsal-ui'),'utf8'));
 const el=id=>w.document.getElementById(id);
 return {w,el,bodies,get speech(){return callbacks;},advance(ms){now+=ms;timers.forEach(fn=>fn());},close:()=>w.close(),get calls(){return calls;},get cancels(){return cancelCount;},resolve:result=>resolveFetch({ok:true,json:async()=>result}),type(text){el('answerInput').value=text;el('answerInput').dispatchEvent(new w.Event('input'));}};
}
const flush=()=>new Promise(setImmediate);
test('typed answers require explicit submit; plain Enter and IME composition cannot submit',async()=>{
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

test('speech streams revisions into one conversation bubble, keeps typed draft, and sends once after silence',async()=>{
 const h=harness();try{h.type('文字草稿');h.el('micButton').click();await flush();h.speech.partial('我们');assert.match(h.el('conversation').textContent,/我们/);assert.equal(h.el('answerInput').value,'文字草稿');h.speech.partial('我们需要');assert.equal(h.el('conversation').querySelectorAll('.voice-message').length,1);assert.equal(h.calls,0);h.advance(1700);await flush();assert.equal(h.calls,0);h.advance(200);await flush();assert.equal(h.calls,1);assert.equal(h.bodies[0].answer,'我们需要补充管理员操作手册');h.advance(3000);await flush();assert.equal(h.calls,1);assert.equal(h.el('answerInput').value,'文字草稿');}finally{h.close();}
});
test('pausing live speech prevents silence auto-send and preserves the visible utterance',async()=>{
 const h=harness();try{h.el('micButton').click();await flush();h.speech.partial('先保留这段发言');h.el('pauseRehearsal').click();h.advance(3000);await flush();assert.equal(h.calls,0);assert.match(h.el('conversation').textContent,/先保留这段发言/);assert.match(h.el('conversation').textContent,/已暂停/);}finally{h.close();}
});
test('voice model failure can retry the same bubble without duplicating the user message',async()=>{
 const h=harness();try{h.el('micButton').click();await flush();h.speech.partial('我们需要');h.el('micButton').click();await flush();assert.equal(h.calls,1);h.resolve({error:'服务暂时不可用'});await flush();const bubble=h.el('conversation').querySelector('.voice-message');assert.match(bubble.textContent,/回复失败/);bubble.querySelector('button').click();await flush();assert.equal(h.calls,2);h.resolve({summary:'建议明确交付时间',question:'何时交付？',strengths:[],improvements:[],evidence:[],warnings:[],model:'test-model'});await flush();assert.equal(h.el('conversation').querySelectorAll('.user-message').length,1);assert.match(h.el('conversation').textContent,/何时交付/);}finally{h.close();}
});

test('ongoing microphone activity extends the silence deadline',async()=>{
 const h=harness();try{h.el('micButton').click();await flush();h.speech.partial('我们');h.advance(1700);h.speech.level(.5);h.advance(200);await flush();assert.equal(h.calls,0);h.advance(1800);await flush();assert.equal(h.calls,1);}finally{h.close();}
});
