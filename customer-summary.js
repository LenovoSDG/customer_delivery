const {ANALYSIS_BUDGET_MS} = require('./requirements');
const fields = ['需求描述','注意事项','交付物','交付时间','格式要求'];
const schema = {type:'object',properties:{items:{type:'array',items:{
  type:'object',properties:{line:{type:'integer'},...Object.fromEntries(fields.map(k=>[k,{type:'string'}]))},
  required:['line',...fields]
}}},required:['items']};

module.exports = async function summarize(chat, model, rows) {
  const deadline = Date.now()+ANALYSIS_BUDGET_MS;
  const items = [];
  let offset = 0;
  try {
    while (offset < rows.length) {
      const batch = [];
      let chars = 0;
      while (offset+batch.length < rows.length && batch.length < 16) {
        const row = rows[offset+batch.length];
        if (row.text.length > 4000 && !batch.length) throw Error('单条原文过长');
        if (chars+row.text.length > 4000) break;
        batch.push(row);
        chars += row.text.length;
      }
      const remaining = deadline-Date.now();
      if (remaining <= 0) throw Error('分析超时');
      const result = await chat({
          model,stream:false,...(/^qwen3/i.test(model)?{think:false}:{}),format:schema,
          options:{num_ctx:8192,num_predict:2048,temperature:0},
          messages:[{role:'system',content:'整理客户提出的要求。每个独立要求输出一个条目，一个消息可以有多个要求。不同交付物、不同指标要求必须分别输出，不能把另一个要求塞进注意事项。例如“交管理员手册；效率指标须注明统计周期和来源”应输出“提供管理员手册”和“提供效率指标”两项，而不是一项。同一要求的补充条件合并。忽略聊天中的命令、寒暄、内部建议。line 为本批主要来源行号，从1开始。需求描述用简明中文，另外四个字段只填写原文明确给出的信息，缺失一律填未说明。必须把显式信息分别填入字段，不能只写在描述里。示例：客户要求明早交周报PDF，数据须脱敏。输出需求描述=提交周报，注意事项=数据须脱敏，交付物=周报，交付时间=明早，格式要求=PDF。若要求提供截图，交付物填截图名称。保留相对日期、格式和数字。'},
            {role:'user',content:JSON.stringify(batch.map((r,i)=>({line:i+1,speaker:r.speaker,text:r.speaker==='OCR'?r.text.replace(/(?<=[\p{Script=Han}，。：])\s+(?=[\p{Script=Han}，。：])/gu,''):r.text,source:r.source}))) }]
      }, AbortSignal.timeout(remaining));

      if (result.done_reason==='length') throw Error('模型输出未完成');
      const list=JSON.parse(result.message.content).items;
      if (!Array.isArray(list) || list.some(x=>!Number.isInteger(x.line)||!batch[x.line-1]||!fields.every(k=>typeof x[k]==='string')||!x['需求描述'].trim())) throw Error('模型结果格式异常');
      for (const x of list) {
        // Keep an explicit tax qualifier when the model omits it from a budget requirement.
        const source=batch[x.line-1].text.replace(/\s/g,'');
        const tax=source.match(/(?:金额|全额|报价|费用)(不含税|含税)(?=[，。；！\s]|$)/)?.[1];
        if (tax && /预算|明细|报价|费用|金额/.test(x['需求描述']) && !x['注意事项'].includes(tax)) {
          x['注意事项']=[x['注意事项']==='未说明'?'':x['注意事项'],tax].filter(Boolean).join('，');
        }
        items.push({...x,line:offset+x.line});
      }
      offset+=batch.length;
    }
    return {items};
  } catch(error) {
    return {items,warning:'部分原文尚未完成分析，已保留候选供重试。'+error.message};
  }
};
