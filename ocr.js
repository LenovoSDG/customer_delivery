const {execFile}=require('node:child_process');
const path=require('node:path');
exports.read=file=>new Promise((resolve,reject)=>execFile('powershell.exe',['-NoProfile','-NonInteractive','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'ocr.ps1'),file],{windowsHide:true,timeout:45000,encoding:'utf8',maxBuffer:4*1024*1024},(err,out,stderr)=>{
  if(err)return reject(Error(stderr.trim().split('\n')[0]||err.message));
  try{resolve(JSON.parse(out))}catch(e){reject(e)}
}));
