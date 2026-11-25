const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');

function cleanString(value, limit = 1000) {
  return typeof value === 'string' ? value.trim().slice(0, limit) : '';
}

function normalizeTags(tags) {
  if (Array.isArray(tags)) {
    return [...new Set(tags.map(t => cleanString(String(t), 40)).filter(Boolean))].slice(0, 8);
  }
  if (typeof tags === 'string') {
    return [...new Set(tags.split(/[,，、\s]+/).map(t => t.trim().slice(0, 40)).filter(Boolean))].slice(0, 8);
  }
  return [];
}

function createKnowledgeStore(filePath) {
  function readAll() {
    if (!fs.existsSync(filePath)) return [];
    if (fs.lstatSync(filePath).isSymbolicLink()) throw new Error('知识库文件不能使用符号链接');
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }

  function writeAll(items) {
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(filePath) && fs.lstatSync(filePath).isSymbolicLink()) {
      throw new Error('知识库文件不能使用符号链接');
    }
    const temp = path.join(dir, `.kb-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temp, JSON.stringify(items, null, 2), { mode: 0o600, flag: 'wx' });
      fs.renameSync(temp, filePath);
    } catch (error) {
      if (fs.existsSync(temp)) fs.unlinkSync(temp);
      throw new Error(`无法保存个人知识库：${error.message}`);
    }
  }

  function upsert(input) {
    const title = cleanString(input?.title, 160);
    const takeaway = cleanString(input?.takeaway || input?.feedback, 2000);
    if (!title || !takeaway) throw new Error('请填写复盘标题和核心复盘结论');

    const items = readAll();
    const now = new Date().toISOString();
    const id = cleanString(input?.id, 64) || randomUUID();
    const existingIndex = items.findIndex(item => item.id === id);
    const record = {
      id,
      title,
      audience: cleanString(input?.audience, 80) || '通用视角',
      tags: normalizeTags(input?.tags),
      question: cleanString(input?.question, 400),
      answer: cleanString(input?.answer, 1200),
      feedback: cleanString(input?.feedback, 1200),
      takeaway,
      projectName: cleanString(input?.projectName, 120) || '未关联项目',
      createdAt: existingIndex >= 0 ? items[existingIndex].createdAt : now,
      updatedAt: now
    };
    if (existingIndex >= 0) items[existingIndex] = record;
    else items.unshift(record);
    writeAll(items);
    return record;
  }

  function remove(id) {
    const targetId = cleanString(id, 64);
    if (!targetId) throw new Error('缺少复盘记录编号');
    const items = readAll();
    const next = items.filter(item => item.id !== targetId);
    if (next.length === items.length) return false;
    writeAll(next);
    return true;
  }

  return { list: readAll, upsert, remove };
}

module.exports = { createKnowledgeStore, normalizeTags };
