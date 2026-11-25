const fs = require('node:fs');
const path = require('node:path');
const {execFileSync} = require('node:child_process');

const defaultUrl = 'https://tokendance.space/gateway/v1';
function protect(value, decrypt=false) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    '$v=[Console]::In.ReadToEnd()',
    decrypt
      ? '[Console]::Write([Text.Encoding]::UTF8.GetString([Security.Cryptography.ProtectedData]::Unprotect([Convert]::FromBase64String($v),$null,"CurrentUser")))'
      : '[Console]::Write([Convert]::ToBase64String([Security.Cryptography.ProtectedData]::Protect([Text.Encoding]::UTF8.GetBytes($v),$null,"CurrentUser")))'
  ].join(';');
  return execFileSync('powershell.exe',['-NoProfile','-NonInteractive','-Command',script],
    {input:value,encoding:'utf8',windowsHide:true,timeout:10000,stdio:['pipe','pipe','ignore']});
}

module.exports = function modelProvider(dir,ollama) {
  const file = path.join(dir,'model-provider.json');
  const defaults = {mode:process.env.TOKENDANCE_API_KEY && process.env.TOKENDANCE_MODEL?'api':'local',
    baseUrl:process.env.TOKENDANCE_BASE_URL||defaultUrl, model:process.env.TOKENDANCE_MODEL||''};
  let config = fs.existsSync(file)?JSON.parse(fs.readFileSync(file,'utf8')):defaults;
  if (!config.asrModel || config.asrModel==='qwen3-asr-flash') config.asrModel='deepseek-asr';
  let sessionKey='';
  function envKey() {return config.baseUrl===defaults.baseUrl?process.env.TOKENDANCE_API_KEY:'';}
  function info() {return {localSpeech:config.localSpeech!==false,mode:config.mode,baseUrl:config.baseUrl,model:config.model,asrModel:config.asrModel||"deepseek-asr",hasKey:Boolean(sessionKey||config.secret||envKey()),sessionOnly:Boolean(sessionKey)};}
  function save(input) {
    if (!['local','api'].includes(input.mode)) throw Error('请选择分析方式');
    const next={...config,mode:input.mode,localSpeech:input.localSpeech??config.localSpeech??true};
    let nextSession=sessionKey;
    if (next.mode==='api') {
      const endpoint=new URL(input.baseUrl);
      if(endpoint.protocol!=='https:'||endpoint.username||endpoint.password||endpoint.search||endpoint.hash)throw Error('请填写 HTTPS API 基础地址');
      next.baseUrl=endpoint.href.replace(/\/+$/,'');
      next.asrModel=String(input.asrModel||config.asrModel||'deepseek-asr').trim();
      next.model=String(input.model||'').trim();
      if(next.baseUrl!==config.baseUrl){delete next.secret;nextSession='';}
      if(input.key){
        nextSession='';
        try {next.secret=protect(String(input.key).trim());}
        catch {delete next.secret;nextSession=String(input.key).trim();}
      }
      if(!next.model||!(next.secret||nextSession||(next.baseUrl===defaults.baseUrl && process.env.TOKENDANCE_API_KEY)))throw Error('请填写模型 ID 和对应服务的 API Key');
    }
    fs.writeFileSync(file+'.tmp',JSON.stringify(nextSession?{...next,mode:'local'}:next),{mode:0o600});
    fs.renameSync(file+'.tmp',file);
    config=next;
    sessionKey=nextSession;
    return info();
  }
  async function chat(body,signal,audio=false) {
    const api=config.mode==='api';
    let url=ollama+'/api/chat',headers={'content-type':'application/json'};
    if(api){
      const key=sessionKey||(config.secret?protect(config.secret,true):envKey());
      if(!key)throw Error('缺少 API Key，请打开模型设置');
      url=config.baseUrl+'/chat/completions';
      headers.authorization='Bearer '+key;
      const messages=body.messages.slice();
      if(body.format){
        const spec='只返回符合以下 JSON Schema 的 JSON 对象。'+JSON.stringify(body.format);
        if(messages[0]?.role==='system')messages[0]={role:'system',content:messages[0].content+'\n'+spec};
        else messages.unshift({role:'system',content:spec});
      }
      body=audio?{model:info().asrModel,messages,stream:false}:{model:config.model,messages,stream:false,temperature:body.options?.temperature??0.2,max_tokens:body.options?.num_predict||2048};
    }
    const response=await fetch(url,{method:'POST',headers,body:JSON.stringify(body),signal,redirect:'error'});
    if(!response.ok){
      const payload=await response.json().catch(()=>({}));
      const code=String(payload.error?.code||'').replace(/[^a-zA-Z0-9_.-]/g,'').slice(0,70);
      const detail=audio?String(payload.error?.message||'').replace(/data:audio[^\s"]+|[A-Za-z0-9+/_=-]{45,}/g,'…').slice(0,180):'';
      throw Object.assign(Error((audio?'语音转写 API':api?'模型 API':'Ollama')+' HTTP '+response.status+(code?' · '+code:'')+(detail?' · '+detail:'')),{status:response.status});
    }
    const result=await response.json();
    if(!api)return result;
    const choice=result.choices?.[0], content=choice?.message?.content;
    if(typeof content!=='string'||!content.trim())throw Error('模型 API 返回空内容');
    return {message:{content:content.trim().replace(/^\x60\x60\x60(?:json)?\s*([\s\S]*?)\s*\x60\x60\x60$/i,'$1')},done_reason:choice.finish_reason};
  }
  async function transcribe(wav) {
    if(info().localSpeech)return require("./whisper-local")(wav);
    if(config.mode!=='api')throw Error('请在模型设置中启用 API 并保存语音转写模型。');
    if(info().asrModel==='deepseek-asr'){
      const key=sessionKey||(config.secret?protect(config.secret,true):envKey());
      const form=new FormData();form.append('file',new Blob([Buffer.from(wav,'base64')],{type:'audio/wav'}),'turn.wav');
      const asrBase=config.baseUrl===defaultUrl?'https://tokendance.space/gateway/deepseek/v1':config.baseUrl;
      const res=await fetch(asrBase+'/tools/asr',{method:'POST',headers:{authorization:'Bearer '+key},body:form,redirect:'error',signal:AbortSignal.timeout(45000)});
      if(!res.ok)throw Error('DeepSeek ASR · HTTP '+res.status+'，请核对网关是否开通语音转写协议');
      const data=await res.json();if(typeof data.text!=='string')throw Error('DeepSeek ASR 返回无效');
      return {text:data.text,engine:'deepseek-asr'};
    }
    const messages=[{role:'user',content:[{type:'input_audio',input_audio:{data:'data:audio/wav;base64,'+wav,format:'wav'}}]}];
    try {
      const result=await chat({messages},AbortSignal.timeout(295000),true);
      return {text:result.message.content,engine:'API'};
    } catch(error){
      if(error.status!==400 && error.status!==404)throw error;
      const text=await new Promise((resolve,reject)=>{
        const child=require('node:child_process').execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'speech-fallback.ps1')],{windowsHide:true,timeout:170000,encoding:'utf8'},(err,out)=>err?reject(Error(error.message+'；Windows 中文语音识别不可用')):resolve(out.trim()));
        child.stdin.on('error',()=>{});child.stdin.end(wav);
      });
      if(!text)throw Error(error.message+'；Windows 未识别到讲话');
      return {text,engine:'Windows 中文转写'};
    }
  }
  return {chat,info,save,transcribe};
};
