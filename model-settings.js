(function () {
  'use strict';
  const el = id => document.getElementById(id);
  let saved = null;
  let configError = '';
  state.provider = 'ollama';
  state.apiModel = '';

  function providerLabel(provider) {
    if (provider === 'custom') return '自定义 API';
    return provider === 'deepseek' ? 'DeepSeek API' : provider === 'bohrium' ? '玻尔 API' : '本机 Ollama';
  }

  function destinationLabel(provider) {
    if (provider === 'custom') return saved?.customBaseUrl || '自定义 API';
    return provider === 'bohrium' ? '玻尔网关' : providerLabel(provider);
  }

  function applyConfig(config) {
    saved = config;
    configError = '';
    state.provider = config.provider;
    const models = { bohrium: config.apiModel, deepseek: config.deepseekModel, custom: config.customModel };
    state.apiModel = models[config.provider] || '';
    state.customBaseUrl = config.customBaseUrl || '';
    if (config.localModel) state.model = config.localModel;
    const remote = config.provider !== 'ollama';
    const source = providerLabel(config.provider);
    el('privacyNotice').textContent = remote ? `质检与演练 · ${source}` : '本地质检与演练 · 使用本机 Ollama';
    el('processingNotice').textContent = remote ? `质检和演练文字发送至 ${destinationLabel(config.provider)} · 音频仅本机处理` : '质检与演练在本机处理 · 外部聊天平台连接当前为演示状态';
    el('reviewProviderBadge').textContent = `调用${source}`;
    if (!document.querySelector('#report .report-meta') && el('qualityModel').textContent !== '检查中') el('qualityModel').textContent = remote ? source : '本地模型';
    window.dispatchEvent(new Event('model-settings-changed'));
  }

  async function readConfig() {
    try {
      const response = await fetch('/api/model-config');
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || '无法读取模型配置');
      applyConfig(config);
      return config;
    } catch (error) { configError = error.message; return null; }
  }
  const ready = readConfig();

  function toggleProvider() {
    const provider = el('modelProvider').value;
    el('localModelPanel').hidden = provider !== 'ollama';
    el('apiModelPanel').hidden = provider !== 'bohrium';
    el('deepseekModelPanel').hidden = provider !== 'deepseek';
    el('customModelPanel').hidden = provider !== 'custom';
    el('customBaseUrl').disabled = provider !== 'custom';
    el('modelSettingsStatus').textContent = '';
  }

  async function openSettings() {
    await ready;
    if (configError) await readConfig();
    el('modelProvider').value = state.provider;
    el('modelName').value = state.model;
    el('apiModelName').value = saved?.apiModel || '';
    el('apiKey').value = '';
    el('deepseekModelName').value = saved?.deepseekModel || 'deepseek-flash';
    el('deepseekKey').value = '';
    el('deepseekKeyStatus').textContent = saved?.deepseekKeyConfigured
      ? '已配置密钥，留空继续使用。'
      : '请填写 DeepSeek API 密钥。';
    el('customBaseUrl').value = saved?.customBaseUrl || '';
    el('customModelName').value = saved?.customModel || '';
    el('customKey').value = '';
    el('customKeyStatus').textContent = saved?.customKeyConfigured
      ? '当前地址的密钥已保存。更换地址时，按新服务的要求填写密钥。'
      : '服务要求 Bearer 密钥时填写。';
    el('apiKeyStatus').textContent = saved?.keyConfigured ? '已保存密钥；留空则继续使用，仅更换时填写。' : '尚未配置密钥。输入后可读取模型列表，再保存。';
    toggleProvider();
    if (configError) el('modelSettingsStatus').textContent = configError;
    el('settingsDialog').showModal();
  }

  async function refreshModels() {
    const key = el('apiKey').value.trim();
    if (!key && !saved?.keyConfigured) {
      el('apiModelsStatus').textContent = '请先填写 API 密钥，再读取模型列表。';
      return;
    }
    const button = el('refreshApiModels');
    button.disabled = true;
    el('apiModelsStatus').textContent = '正在读取玻尔网关模型列表…';
    try {
      const response = await fetch('/api/api-models', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify(key ? { apiKey: key } : {}) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '读取模型列表失败');
      el('apiModelOptions').replaceChildren(...data.models.map(id => {
        const option = document.createElement('option'); option.value = id; return option;
      }));
      el('apiModelsStatus').textContent = data.models.length ? `已读取 ${data.models.length} 个模型。输入名称可筛选，选择支持文本聊天的模型。` : '当前密钥未返回模型，可直接填写控制台中的模型 ID。';
    } catch (error) {
      el('apiModelsStatus').textContent = `${error.message}。也可直接填写模型 ID。`;
    } finally { button.disabled = false; }
  }

  async function saveSettings(event) {
    if (event.submitter?.id !== 'saveSettings') return;
    event.preventDefault();
    const provider = el('modelProvider').value;
    const button = el('saveSettings');
    button.disabled = true;
    el('modelSettingsStatus').textContent = '正在保存…';
    try {
      const payload = { provider, localModel: el('modelName').value.trim() || state.model,
        apiModel: el('apiModelName').value.trim() };
      if (provider === 'bohrium' && el('apiKey').value.trim()) payload.apiKey = el('apiKey').value.trim();
      if (provider === 'deepseek') {
        payload.deepseekModel = el('deepseekModelName').value.trim();
        if (el('deepseekKey').value.trim()) payload.deepseekKey = el('deepseekKey').value.trim();
      }
      if (provider === 'custom') {
        payload.customBaseUrl = el('customBaseUrl').value.trim();
        payload.customModel = el('customModelName').value.trim();
        if (el('customKey').value.trim()) payload.customKey = el('customKey').value.trim();
      }
      const response = await fetch('/api/model-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || '保存失败');
      applyConfig(config);
      el('settingsDialog').close();
    } catch (error) { el('modelSettingsStatus').textContent = error.message; }
    finally { button.disabled = false; }
  }

  el('modelSettings').onclick = openSettings;
  el('closeModelSettings').onclick = el('cancelModelSettings').onclick = () => el('settingsDialog').close();
  el('modelProvider').onchange = toggleProvider;
  el('refreshApiModels').onclick = refreshModels;
  el('modelSettingsForm').addEventListener('submit', saveSettings);
  el('settingsDialog').addEventListener('close', () => {
    el('apiKey').value = '';
    el('deepseekKey').value = '';
    el('customKey').value = '';
  });
  el('checkConnection').onclick = async () => {
    el('connectionStatus').textContent = '检测中…';
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      const model = el('modelName').value.trim();
      el('connectionStatus').textContent = model === 'rules' ? '规则演示模式' : data.ollama && data.models.includes(model) ? '本地模型已就绪' : data.ollama ? 'Ollama 已运行，未找到此模型' : '尚未连接 Ollama';
    } catch { el('connectionStatus').textContent = '无法检测本地服务'; }
  };

  window.ModelSettings = { ready, providerLabel, destinationLabel, async selection() {
    await ready;
    if (configError) throw new Error('无法读取模型配置，请打开模型设置后重试');
    const provider = state.provider || 'ollama';
    const model = provider === 'ollama' ? state.model : state.apiModel;
    return provider === 'custom' ? { provider, model, customBaseUrl: state.customBaseUrl } : { provider, model };
  } };
})();
