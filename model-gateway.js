const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const BASE_URL = 'https://open.bohrium.com/openapi/model-gateway/v1';

function createModelGateway({ configFile, env = process.env, fetchImpl = global.fetch }) {
  if (fs.existsSync(configFile) && fs.lstatSync(configFile).isSymbolicLink()) throw new Error('模型配置不能使用符号链接');
  const fileValues = fs.existsSync(configFile) ? dotenv.parse(fs.readFileSync(configFile)) : {};
  const value = name => fileValues[name] ?? env[name] ?? '';
  let settings = {
    provider: value('MODEL_PROVIDER') === 'bohrium' ? 'bohrium' : 'ollama',
    localModel: value('LOCAL_MODEL'), apiModel: value('BOHRIUM_MODEL'), apiKey: value('BOHRIUM_API_KEY')
  };

  const publicConfig = () => ({ provider: settings.provider, localModel: settings.localModel,
    apiModel: settings.apiModel, apiBaseUrl: BASE_URL, keyConfigured: Boolean(settings.apiKey) });

  function validateKey(input) {
    const key = String(input || '').trim();
    if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error('请填写有效的玻尔 API 密钥');
    return key;
  }

  function validateModel(input) {
    const model = String(input || '').trim();
    if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new Error('请选择或填写有效的模型 ID');
    return model;
  }

  function saveConfig(input) {
    if (!['ollama', 'bohrium'].includes(input.provider)) throw new Error('未知的模型来源');
    const next = { ...settings, provider: input.provider };
    if (input.localModel !== undefined) next.localModel = validateModel(input.localModel);
    if (input.apiModel !== undefined) next.apiModel = String(input.apiModel || '').trim();
    if (input.apiKey) next.apiKey = validateKey(input.apiKey);
    if (next.provider === 'bohrium') {
      next.apiModel = validateModel(next.apiModel);
      next.apiKey = validateKey(next.apiKey);
    }
    if (next.provider === 'ollama') next.localModel = validateModel(next.localModel);
    if (fs.existsSync(configFile) && fs.lstatSync(configFile).isSymbolicLink()) throw new Error('模型配置不能使用符号链接');
    const existing = fs.existsSync(configFile) ? dotenv.parse(fs.readFileSync(configFile)) : {};
    const values = { ...existing, MODEL_PROVIDER: next.provider, LOCAL_MODEL: next.localModel,
      BOHRIUM_MODEL: next.apiModel, BOHRIUM_API_KEY: next.apiKey };
    // Do not put secret values into errors, responses, stdout or browser storage.
    const text = Object.entries(values).map(([key, val]) => `${key}=${JSON.stringify(val)}`).join('\n') + '\n';
    const temporary = path.join(path.dirname(configFile), `.model-config-${process.pid}-${Date.now()}.tmp`);
    try {
      fs.writeFileSync(temporary, text, { mode: 0o600, flag: 'wx' });
      fs.renameSync(temporary, configFile);
      fs.chmodSync(configFile, 0o600);
    } catch {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
      throw new Error('无法保存本机模型配置，请检查目录写入权限');
    }
    settings = next;
    return publicConfig();
  }

  function httpError(status) {
    if (status === 401) return new Error('玻尔 API 密钥无效或已失效，请更新密钥');
    if (status === 403) return new Error('当前密钥没有所选模型的访问权限');
    if (status === 429) return new Error('玻尔网关限流或额度不足，请稍后重试并检查账户额度');
    if (status === 404) return new Error('网关未找到接口或模型，请刷新列表或核对模型 ID');
    return new Error(`玻尔网关请求失败（HTTP ${status}），请检查所选模型是否支持文本聊天`);
  }

  async function request(endpoint, key, body, signal) {
    let response;
    if (signal?.aborted) throw new Error('质检已取消');
    try {
      response = await fetchImpl(`${BASE_URL}${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { authorization: `Bearer ${validateKey(key)}`, 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body ? 120000 : 15000)]) : AbortSignal.timeout(body ? 120000 : 15000)
      });
    } catch (error) {
      // Never forward a transport error that might contain headers or credentials.
      if (signal?.aborted) throw new Error('质检已取消');
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error('玻尔网关响应超时，请稍后重试');
      throw new Error('无法连接玻尔模型网关，请检查网络及本机密钥配置');
    }
    return response;
  }

  async function listModels(temporaryKey) {
    const key = validateKey(temporaryKey || settings.apiKey);
    const response = await request('/models', key);
    if (!response.ok) throw httpError(response.status);
    let data;
    try { data = await response.json(); } catch { throw new Error('网关模型列表不是有效 JSON'); }
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null;
    if (!rows) throw new Error('网关没有返回可识别的模型列表，可手动填写模型 ID');
    const models = [...new Set(rows.map(row => typeof row === 'string' ? row : row?.id).filter(id => typeof id === 'string' && id.trim()))].sort();
    return { models, apiBaseUrl: BASE_URL };
  }

  async function ask(model, system, content, schema, { signal, interactive = false } = {}) {
    const key = validateKey(settings.apiKey);
    const body = { model: validateModel(model), stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: content + '\n仅输出JSON，遵循此schema：' + JSON.stringify(schema) }],
      response_format: { type: 'json_object' }
    };
    if (interactive) {
      body.max_tokens = 1200;
      // Only known GLM versions support disabling reasoning; keep quality review defaults intact.
      if (/^glm-(?:4\.[567](?:-|$)|5(?:\.[12])?(?:-|$))/i.test(model)) body.thinking = { type: 'disabled' };
    }
    let response = await request('/chat/completions', key, body, signal);
    if (response.status === 400 || response.status === 422) {
      // Retry only a rejected JSON-mode parameter, never a completed generation.
      const detail = await response.text();
      if (/response_format|json_object/i.test(detail)) {
        delete body.response_format;
        response = await request('/chat/completions', key, body, signal);
      }
    }
    if (!response.ok) throw httpError(response.status);
    let data;
    try { data = await response.json(); } catch { throw new Error('玻尔网关未返回有效 JSON 响应'); }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('所选模型输出被截断，请拆分需求或更换模型');
    if (choice?.message?.refusal) throw new Error('所选模型未执行本次核验，请检查材料或更换模型');
    const raw = choice?.message?.content;
    const answer = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(part => part.text || '').join('') : '';
    if (!answer.trim()) throw new Error('所选模型没有返回文本，请选择支持文本聊天的模型');
    const jsonText = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(jsonText); } catch { throw new Error('所选模型未按要求返回 JSON，请重试或更换模型'); }
  }

  return { publicConfig, saveConfig, listModels, ask };
}

module.exports = { BASE_URL, createModelGateway };
