const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const vm=require('node:vm');
function harness() {
  let resolveMedia, stopped=0, removed=0, handlers={}, mediaCalls=0, contexts=0, closed=0; const instances=[];
  class Recognizer {constructor(){this.handlers={};handlers=this.handlers;instances.push(this);} on(event,fn){this.handlers[event]=fn;} remove(){removed++;} acceptWaveformFloat(){queueMicrotask(()=>this.handlers.partialresult({result:{partial:'正在说'}}));} retrieveFinalResult(){queueMicrotask(()=>this.handlers.result({result:{text:'最后 一句话'}}));}}
  class Model {constructor(){this.KaldiRecognizer=Recognizer;}on(event,fn){if(event==='load')queueMicrotask(()=>fn({result:true}));}}
  class Context {constructor(){contexts++;this.sampleRate=16000;}async resume(){} createMediaStreamSource(){return {connect(){},disconnect(){}};}createScriptProcessor(){return {connect(){},disconnect(){}};}async close(){closed++;}}
  const root={Vosk:{Model},AudioContext:Context};
  const scope={window:root,fetch:async()=>({json:async()=>({ready:true,sha256:'test'})}),URL,location:{href:'http://127.0.0.1:4174/'},navigator:{mediaDevices:{getUserMedia:()=>{mediaCalls++;return new Promise(resolve=>{resolveMedia=resolve;});}}},setTimeout,clearTimeout,Float32Array};
  vm.runInNewContext(fs.readFileSync(require.resolve('../speech-engine'),'utf8'),scope);
  return {Engine:root.SpeechEngine,get handlers(){return handlers;},instances,get mediaCalls(){return mediaCalls;},get contexts(){return contexts;},get closed(){return closed;},resolveMedia:()=>resolveMedia({getTracks:()=>[{stop(){stopped++;}}],getAudioTracks:()=>[{addEventListener(){}}]}),get stopped(){return stopped;},get removed(){return removed;}};
}
test('cancellation stops a late microphone permission result',async()=>{
 const h=harness(),engine=new h.Engine();const pending=engine.start(); await new Promise(setImmediate);engine.cancel();h.resolveMedia();assert.equal(await pending,false);assert.equal(h.stopped,1);assert.equal(h.removed,1);
});
test('final utterance is drained before recognizer cleanup; stale callbacks ignored',async()=>{
 const h=harness();let text='';const engine=new h.Engine({text:t=>text=t});await engine.prepare();engine.feed(new Float32Array(10),16000);await engine.stop();assert.equal(text,'最后一句话');assert.equal(h.removed,1);h.handlers.result({result:{text:'过期文字'}});assert.equal(text,'最后一句话');
});
test('capture worklet downmixes PCM, emits final short buffer, and keeps output silent',()=>{
 let Processor; const messages=[];
 class Base {constructor(){this.port={postMessage:message=>messages.push(message)};}}
 vm.runInNewContext(fs.readFileSync(require.resolve('../audio-capture-worklet'),'utf8'),{AudioWorkletProcessor:Base,Float32Array,registerProcessor:(name,processor)=>{assert.equal(name,'voice-capture');Processor=processor;}});
 const capture=new Processor();const output=new Float32Array([1,1,1]);capture.process([[new Float32Array([.5,1,0]),new Float32Array([-.5,0,1])]],[[output]]);
 capture.port.onmessage({data:{type:'flush'}});
 assert.deepEqual(Array.from(messages[0].data),[0,.5,.5]);assert.equal(messages[1].type,'flushed');assert.deepEqual(Array.from(output),[0,0,0]);
 capture.process([[new Float32Array([1])]],[[output]]);assert.equal(capture.position,0);
});

test('utterance boundaries keep the same microphone and context open across two turns',async()=>{
 const h=harness();let boundaries=0;const engine=new h.Engine({boundary(){boundaries++;}});const start=engine.start();await new Promise(setImmediate);h.resolveMedia();assert.equal(await start,true);const stream=engine.stream,context=engine.context;
 engine.feed(new Float32Array(10),16000);const previous=h.handlers;await engine.finishUtterance();assert.equal(engine.stream,stream);assert.equal(engine.context,context);assert.equal(h.stopped,0);previous.result({result:{text:'过期结果'}});assert.equal(engine.text,'');
 engine.feed(new Float32Array(10),16000);await engine.finishUtterance();assert.equal(boundaries,2);assert.equal(h.mediaCalls,1);assert.equal(h.contexts,1);assert.equal(h.stopped,0);assert.equal(h.closed,0);engine.cancel();assert.equal(h.stopped,1);assert.equal(h.closed,1);
});
test('recognizer rotation buffers audio arriving during finalization instead of dropping it',async()=>{
 const h=harness();const engine=new h.Engine();await engine.prepare();const pending=engine.finishUtterance();engine.feed(new Float32Array(12),16000);assert.equal(engine.held.length,1);await pending;assert.equal(engine.held.length,0);assert.equal(h.instances.length,2);await new Promise(setImmediate);assert.equal(engine.pending,0);engine.cancel();
});

test('playback echo suppression gates recognition without disabling or stopping audio tracks',async()=>{
 const h=harness();const engine=new h.Engine();await engine.prepare();engine.setMuted(true);engine.feed(new Float32Array(10),16000);assert.equal(engine.pending,0);assert.equal(h.stopped,0);engine.setMuted(false);engine.feed(new Float32Array(10),16000);assert.equal(engine.pending,1);await new Promise(setImmediate);engine.cancel();
});
