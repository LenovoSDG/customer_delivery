const test=require('node:test'); const assert=require('node:assert/strict'); const fs=require('node:fs'); const vm=require('node:vm');
function harness() {
  let resolveMedia, stopped=0, removed=0, handlers={};
  class Recognizer {on(event,fn){handlers[event]=fn;} remove(){removed++;} acceptWaveformFloat(){queueMicrotask(()=>handlers.partialresult({result:{partial:'正在说'}}));} retrieveFinalResult(){queueMicrotask(()=>handlers.result({result:{text:'最后 一句话'}}));}}
  class Model {constructor(){this.KaldiRecognizer=Recognizer;}on(event,fn){if(event==='load')queueMicrotask(()=>fn({result:true}));}}
  const root={Vosk:{Model}};
  const scope={window:root,fetch:async()=>({json:async()=>({ready:true,sha256:'test'})}),URL,location:{href:'http://127.0.0.1:4174/'},navigator:{mediaDevices:{getUserMedia:()=>new Promise(resolve=>{resolveMedia=resolve;})}},setTimeout,clearTimeout,Float32Array};
  vm.runInNewContext(fs.readFileSync(require.resolve('../speech-engine'),'utf8'),scope);
  return {Engine:root.SpeechEngine,handlers,resolveMedia:()=>resolveMedia({getTracks:()=>[{stop(){stopped++;}}]}),get stopped(){return stopped;},get removed(){return removed;}};
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
