(function () {
  'use strict';
  const el = id => document.getElementById(id);
  let saved = null;
  let configError = '';
  state.provider = 'ollama';
  state.apiModel = '';

  function applyConfig(config) {
    saved = config;
    configError = '';
    state.provider = config.provider;
    state.apiModel = config.apiModel || '';
    if (config.localModel) state.model = config.localModel;
    const remote = config.provider === 'bohrium';
    el('privacyNotice').textContent = remote ? 'API 模型 · 确认文字发送至玻尔网关' : '本地模型 · 使用本机 Ollama';
    el('processingNotice').textContent = remote ? 'API 质检与教练会发送需求、材料和确认后的回答至玻尔网关 · 录音不上传' : '质检、转写与教练在本机处理 · 外部聊天平台连接为演示';
    el('reviewProviderBadge').textContent = remote ? '调用玻尔 API' : '调用本机 Ollama';
    if (!document.querySelector('#report .report-meta') && el('qualityModel').textContent !== '检查中') el('qualityModel').textContent = remote ? '玻尔 API' : '本地模型';
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
    const remote = el('modelProvider').value === 'bohrium';
    el('localModelPanel').hidden = remote;
    el('apiModelPanel').hidden = !remote;
    el('modelSettingsStatus').textContent = '';
  }

  async function openSettings() {
    await ready;
    if (configError) await readConfig();
    el('modelProvider').value = state.provider;
    el('modelName').value = state.model;
    el('apiModelName').value = state.apiModel;
    el('apiKey').value = '';
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
      const response = await fetch('/api/model-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const config = await response.json();
      if (!response.ok) throw new Error(config.error || '保存失败');
      applyConfig(config);
      el('apiKey').value = '';
      el('settingsDialog').close();
    } catch (error) { el('modelSettingsStatus').textContent = error.message; }
    finally { button.disabled = false; }
  }

  el('modelSettings').onclick = openSettings;
  el('closeModelSettings').onclick = el('cancelModelSettings').onclick = () => el('settingsDialog').close();
  el('modelProvider').onchange = toggleProvider;
  el('refreshApiModels').onclick = refreshModels;
  el('modelSettingsForm').addEventListener('submit', saveSettings);
  el('settingsDialog').addEventListener('close', () => { el('apiKey').value = ''; });
  el('checkConnection').onclick = async () => {
    el('connectionStatus').textContent = '检测中…';
    try {
      const response = await fetch('/api/health');
      const data = await response.json();
      const model = el('modelName').value.trim();
      el('connectionStatus').textContent = model === 'rules' ? '规则演示模式' : data.ollama && data.models.includes(model) ? '本地模型已就绪' : data.ollama ? 'Ollama 已运行，未找到此模型' : '尚未连接 Ollama';
    } catch { el('connectionStatus').textContent = '无法检测本地服务'; }
  };

  window.ModelSettings = { ready, async selection() {
    await ready;
    if (configError) throw new Error('无法读取模型配置，请打开模型设置后重试');
    const provider = state.provider || 'ollama';
    return { provider, model: provider === 'bohrium' ? state.apiModel : state.model };
  } };
})();
