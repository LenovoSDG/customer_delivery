const test = require('node:test');
const assert = require('node:assert/strict');
const {coachTurn} = require('../rehearsal');
const feedback = {summary:'结论清楚，交付时间仍需明确。',strengths:['说明了交付内容'],improvements:['明确负责人和时间'],question:'两份指南何时交付？',evidence:[]};
test('coach receives only confirmed requirements and bounded recent history', async () => {
  let payload;
  const result = await coachTurn({answer:'我们将补齐指南。',requirements:[{id:'R1',detail:'需要指南',status:'已确认'},{id:'R2',detail:'未批准',status:'待确认'}],history:Array.from({length:10},()=>({role:'user',content:'旧回答'}))}, async (system, content)=>{assert.match(system,/不能评价声音/);payload=JSON.parse(content);return feedback;});
  assert.equal(payload.requirements.length,1); assert.equal(payload.history.length,6); assert.match(result.warnings[0],/未提供可读材料/);
});
test('coach validates material quotes and hides fabricated citations', async () => {
  const result = await coachTurn({answer:'补齐指南',documents:[{name:'方案.md',text:'第一行\n需要补充管理员操作手册。'}]},async()=>({...feedback,evidence:[{documentId:'F-1',quote:'需要补充管理员操作手册。'},{documentId:'F-1',quote:'已完成所有验收'}]}));
  assert.equal(result.evidence.length,1); assert.equal(result.evidence[0].lineStart,2); assert.match(result.warnings.join(''),/未通过原文校验/);
});
test('invalid or oversized input never invokes the model', async () => {
  let calls=0; const ask=async()=>{calls++;return feedback;};
  await assert.rejects(coachTurn({answer:''},ask),/确认转写/);
  await assert.rejects(coachTurn({answer:'a'.repeat(4001)},ask),/4000/);
  await assert.rejects(coachTurn({answer:'回答',documents:[{text:'a'.repeat(9000)}]},ask),/上下文/);
  assert.equal(calls,0);
});
test('model failures and malformed feedback do not become demo feedback',async()=>{
  await assert.rejects(coachTurn({answer:'回答'},async()=>{throw new Error('API失败');}),/API失败/);
  await assert.rejects(coachTurn({answer:'回答'},async()=>({summary:'不完整'})),/完整反馈/);
});
