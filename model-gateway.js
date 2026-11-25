const fs = require('node:fs');
const path = require('node:path');
const dotenv = require('dotenv');

const BASE_URL = 'https://open.bohrium.com/openapi/model-gateway/v1';
const DEFAULT_DEEPSEEK_MODEL = 'deepseek-flash';
const API_PROVIDERS = {
  bohrium: { name: '玻尔', baseUrl: BASE_URL, modelField: 'apiModel', keyField: 'apiKey' },
  deepseek: { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com', modelField: 'deepseekModel', keyField: 'deepseekKey' },
  custom: { name: '自定义', modelField: 'customModel', keyField: 'customKey' }
};

function normalizeBaseUrl(input) {
  const text = String(input || '').trim();
  let url;
  try { url = new URL(text); } catch { throw new Error('请填写有效的 HTTP 或 HTTPS API 地址'); }
  if (!/^https?:\/\//i.test(text) || /[\\?#\s]/.test(text) || url.username || url.password) {
    throw new Error('请填写不含账号、密码、查询参数或片段的 HTTP 或 HTTPS API 地址');
  }
  return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
}

function customAddress(value) {
  try { return normalizeBaseUrl(value); } catch { return ''; }
}

function createModelGateway({ configFile, env = process.env, fetchImpl = global.fetch }) {
  if (fs.existsSync(configFile) && fs.lstatSync(configFile).isSymbolicLink()) throw new Error('模型配置不能使用符号链接');
  const fileValues = fs.existsSync(configFile) ? dotenv.parse(fs.readFileSync(configFile)) : {};
  const value = name => fileValues[name] ?? env[name] ?? '';
  const preferredProvider = value('MODEL_PROVIDER');
  const customBaseUrl = customAddress(value('CUSTOM_API_BASE_URL'));
  const customKey = fileValues.CUSTOM_API_KEY
    ?? (customBaseUrl && customBaseUrl === customAddress(env.CUSTOM_API_BASE_URL) ? env.CUSTOM_API_KEY || '' : '');
  let settings = {
    provider: Object.hasOwn(API_PROVIDERS, preferredProvider) ? preferredProvider : 'ollama',
    localModel: value('LOCAL_MODEL'), apiModel: value('BOHRIUM_MODEL'), apiKey: value('BOHRIUM_API_KEY'),
    deepseekModel: value('DEEPSEEK_MODEL').trim() || DEFAULT_DEEPSEEK_MODEL, deepseekKey: value('DEEPSEEK_API_KEY'),
    customBaseUrl, customModel: value('CUSTOM_API_MODEL'), customKey
  };

  const publicConfig = () => ({ provider: settings.provider, localModel: settings.localModel,
    apiModel: settings.apiModel, apiBaseUrl: BASE_URL, keyConfigured: Boolean(settings.apiKey),
    deepseekModel: settings.deepseekModel, deepseekKeyConfigured: Boolean(settings.deepseekKey),
    customBaseUrl: settings.customBaseUrl, customModel: settings.customModel, customKeyConfigured: Boolean(settings.customKey) });

  function validateKey(input, name) {
    const key = String(input || '').trim();
    if (!key || key.length > 4096 || /[\s\x00-\x1f\x7f]/.test(key)) throw new Error(`请填写有效的 ${name} API 密钥`);
    return key;
  }

  function validateModel(input) {
    const model = String(input || '').trim();
    if (!model || model.length > 200 || /[\r\n\x00-\x1f]/.test(model)) throw new Error('请选择或填写有效的模型 ID');
    return model;
  }

  function saveConfig(input) {
    if (!['ollama', 'bohrium', 'deepseek', 'custom'].includes(input.provider)) throw new Error('未知的模型来源');
    const next = { ...settings, provider: input.provider };
    if (input.localModel !== undefined) next.localModel = validateModel(input.localModel);
    if (input.apiModel !== undefined) next.apiModel = String(input.apiModel || '').trim();
    if (input.apiKey) next.apiKey = validateKey(input.apiKey, '玻尔');
    if (input.deepseekModel !== undefined) next.deepseekModel = validateModel(input.deepseekModel);
    if (input.deepseekKey) next.deepseekKey = validateKey(input.deepseekKey, 'DeepSeek');
    if (next.provider === 'bohrium') {
      next.apiModel = validateModel(next.apiModel);
      next.apiKey = validateKey(next.apiKey, '玻尔');
    }
    if (next.provider === 'deepseek') {
      next.deepseekModel = validateModel(next.deepseekModel);
      next.deepseekKey = validateKey(next.deepseekKey, 'DeepSeek');
    }
    if (next.provider === 'custom') {
      next.customBaseUrl = normalizeBaseUrl(input.customBaseUrl ?? next.customBaseUrl);
      next.customModel = validateModel(input.customModel ?? next.customModel);
      const sameAddress = next.customBaseUrl === settings.customBaseUrl;
      next.customKey = input.customKey ? validateKey(input.customKey, '自定义') : sameAddress ? settings.customKey : '';
    }
    if (next.provider === 'ollama') next.localModel = validateModel(next.localModel);
    if (fs.existsSync(configFile) && fs.lstatSync(configFile).isSymbolicLink()) throw new Error('模型配置不能使用符号链接');
    const existing = fs.existsSync(configFile) ? dotenv.parse(fs.readFileSync(configFile)) : {};
    const values = { ...existing, MODEL_PROVIDER: next.provider, LOCAL_MODEL: next.localModel,
      BOHRIUM_MODEL: next.apiModel, BOHRIUM_API_KEY: next.apiKey, DEEPSEEK_MODEL: next.deepseekModel };
    if (input.deepseekKey) values.DEEPSEEK_API_KEY = next.deepseekKey;
    if (next.provider === 'custom') {
      values.CUSTOM_API_BASE_URL = next.customBaseUrl;
      values.CUSTOM_API_MODEL = next.customModel;
      if (input.customKey || next.customBaseUrl !== settings.customBaseUrl) {
        values.CUSTOM_API_KEY = next.customKey;
      }
    }
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

  function httpError(status, name) {
    if (status === 401) return new Error(`${name} API 密钥无效或已失效，请更新密钥`);
    if (status === 402) return new Error(`${name} API 账户余额不足`);
    if (status === 403) return new Error('当前密钥没有所选模型的访问权限');
    if (status === 429) return new Error('玻尔网关限流或额度不足，请稍后重试并检查账户额度');
    if (status === 404) return new Error('网关未找到接口或模型，请刷新列表或核对模型 ID');
    return new Error(`${name} API 请求失败（HTTP ${status}），请检查所选模型是否支持文本聊天`);
  }

  async function request(api, endpoint, key, body, signal) {
    let response;
    if (signal?.aborted) throw new Error('请求已取消');
    try {
      response = await fetchImpl(`${api.baseUrl}${endpoint}`, {
        method: body ? 'POST' : 'GET', redirect: 'error',
        headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), 'content-type': 'application/json', accept: 'application/json' },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(body ? 120000 : 15000)]) : AbortSignal.timeout(body ? 120000 : 15000)
      });
    } catch (error) {
      // Never forward a transport error that might contain headers or credentials.
      if (signal?.aborted) throw new Error('请求已取消');
      if (error.name === 'TimeoutError' || error.name === 'AbortError') throw new Error(`${api.name} API 响应超时，请稍后重试`);
      throw new Error(`无法连接 ${api.name} API，请检查网络及本机密钥配置`);
    }
    return response;
  }

  async function listModels(temporaryKey) {
    const key = validateKey(temporaryKey || settings.apiKey, '玻尔');
    const response = await request(API_PROVIDERS.bohrium, '/models', key);
    if (!response.ok) throw httpError(response.status, '玻尔');
    let data;
    try { data = await response.json(); } catch { throw new Error('网关模型列表不是有效 JSON'); }
    const rows = Array.isArray(data.data) ? data.data : Array.isArray(data.models) ? data.models : null;
    if (!rows) throw new Error('网关没有返回可识别的模型列表，可手动填写模型 ID');
    const models = [...new Set(rows.map(row => typeof row === 'string' ? row : row?.id).filter(id => typeof id === 'string' && id.trim()))].sort();
    return { models, apiBaseUrl: BASE_URL };
  }

  async function chatCompletion(api, key, model, system, content, schema, signal, interactive = false) {
    const body = { model, stream: false,
      messages: [{ role: 'system', content: system }, { role: 'user', content: content + '\n仅输出JSON，遵循此schema：' + JSON.stringify(schema) }],
      response_format: { type: 'json_object' }
    };
    if (interactive) {
      body.max_tokens = 1200;
      if (/^glm-(?:4\.[567](?:-|$)|5(?:\.[12])?(?:-|$))/i.test(model)) body.thinking = { type: 'disabled' };
    }
    if (api.provider === 'deepseek') {
      body.thinking = { type: 'disabled' };
      body.max_tokens = 1200;
    }
    let response = await request(api, '/chat/completions', key, body, signal);
    if (response.status === 400 || response.status === 422) {
      // Retry only a rejected JSON-mode parameter, never a completed generation.
      const detail = await response.text();
      if (/response_format|json_object/i.test(detail)) {
        delete body.response_format;
        response = await request(api, '/chat/completions', key, body, signal);
      }
    }
    if (!response.ok) throw httpError(response.status, api.name);
    let data;
    try { data = await response.json(); } catch { throw new Error(`${api.name} API 未返回有效 JSON 响应`); }
    const choice = data.choices?.[0];
    if (choice?.finish_reason === 'length') throw new Error('所选模型输出被截断，请拆分需求或更换模型');
    if (choice?.message?.refusal) throw new Error('所选模型未执行本次核验，请检查材料或更换模型');
    const raw = choice?.message?.content;
    const answer = typeof raw === 'string' ? raw : Array.isArray(raw) ? raw.map(part => part.text || '').join('') : '';
    if (!answer.trim()) throw new Error('所选模型没有返回文本，请选择支持文本聊天的模型');
    const jsonText = answer.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    try { return JSON.parse(jsonText); } catch { throw new Error('所选模型未按要求返回 JSON，请重试或更换模型'); }
  }

  function apiConfig(provider) {
    if (typeof provider !== 'string' || !Object.hasOwn(API_PROVIDERS, provider)) return null;
    const definition = API_PROVIDERS[provider];
    const baseUrl = definition.baseUrl || settings.customBaseUrl;
    const error = provider !== 'custom' && !settings[definition.keyField] ? `请先在模型设置中配置 ${definition.name} API 密钥`
      : !baseUrl ? '请先在模型设置中保存有效的自定义 API 地址' : '';
    return { provider, name: definition.name, model: settings[definition.modelField], baseUrl, error };
  }

  function createChat(provider, model, { signal, expectedBaseUrl, interactive = false } = {}) {
    const api = apiConfig(provider);
    if (!api) throw new Error('未知的模型来源');
    if (api.error) throw new Error(api.error);
    if (provider === 'custom' && expectedBaseUrl !== undefined && expectedBaseUrl !== api.baseUrl) {
      throw new Error('自定义 API 地址已更新，请刷新页面后重试');
    }
    const keyValue = settings[API_PROVIDERS[provider].keyField];
    const key = keyValue ? validateKey(keyValue, api.name) : '';
    const selected = validateModel(model || api.model);
    return (system, content, schema) => chatCompletion(api, key, selected, system, content, schema, signal, interactive);
  }

  async function ask(model, system, content, schema, { provider = 'bohrium', signal, interactive = false } = {}) {
    return createChat(provider, model, { signal, interactive })(system, content, schema);
  }

  return { publicConfig, saveConfig, listModels, ask, apiConfig, createChat };
}

module.exports = { BASE_URL, createModelGateway };
