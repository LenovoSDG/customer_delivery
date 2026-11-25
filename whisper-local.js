const path=require('node:path');
let context,tail=Promise.resolve();
module.exports=function recognize(wav){
  const run=async()=>{
    context ||= require('@fugood/whisper.node').initWhisper({filePath:path.join(__dirname,'whisper-model.bin'),useGpu:false}).catch(e=>{context=null;throw e});
    const bytes=Buffer.from(wav,'base64');
    if(bytes.length<=44||bytes.toString('ascii',36,40)!=='data'||bytes.readUInt32LE(24)!==16000)throw Error('需要单声道 16kHz PCM WAV');
    const pcm=bytes.buffer.slice(bytes.byteOffset+44,bytes.byteOffset+bytes.length);
    const result=await (await context).transcribeData(pcm,{language:'auto',temperature:0,maxThreads:4}).promise;
    const text=result.result?.trim();if(!text)throw Error('未识别到讲话，请靠近麦克风重试');
    return {text,engine:'本地 Whisper'};
  };
  const next=tail.then(run);tail=next.catch(()=>{});return next;
};