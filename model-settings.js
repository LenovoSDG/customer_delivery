(function () {
  'use strict';
  const el = id => document.getElementById(id);
  let saved = null, configError = '', catalogVersion = 0;
  state.provider = 'ollama'; state.apiModel = '';
  const providerLabel = provider => provider === 'ollama' ? '本地模型' : '自定义 API';
  const destinationLabel = provider => provider === 'ollama' ? '本机 Ollama' : saved?.customBaseUrl || '配置的 API 地址';
  function applyConfig(config) {
    saved = config; configError = '';
    state.provider = config.provider === 'ollama' ? 'ollama' : 'custom';
    state.apiModel = config.customModel || ''; state.customBaseUrl = config.customBaseUrl || '';
    if (config.localModel) state.model = config.localModel;
    const remote = state.provider === 'custom';
    el('privacyNotice').textContent = remote ? '质检与演练 · 自定义 API' : '本地质检与演练 · 使用本机 Ollama';
    el('processingNotice').textContent = remote ? `质检和演练文字发送至 ${destinationLabel('custom')} · 音频仅本机处理` : '质检与演练在本机处理 · 外部聊天平台连接当前为演示状态';
    el('reviewProviderBadge').textContent = remote ? '调用自定义 API' : '调用本机 Ollama';
    if (!document.querySelector('#report .report-meta') && el('qualityModel').textContent !== '检查中') el('qualityModel').textContent = providerLabel(state.provider);
    window.dispatchEvent(new Event('model-settings-changed'));
  }
  async function readConfig() {
    try { const response = await fetch('/api/model-config'); const config = await response.json(); if (!response.ok) throw new Error(config.error || '无法读取模型配置'); applyConfig(config); return config; }
    catch (error) { configError = error.message; return null; }
  }
  const ready = readConfig();
  function updateKeyHint() {
    const sameAddress = normalizeDraftAddress(el('customBaseUrl').value) === saved?.customBaseUrl;
    el('customKeyStatus').textContent = sameAddress && saved?.customKeyConfigured ? '此地址已保存密钥，留空继续使用；仅更换时填写。' : '密钥按服务要求填写。此地址未保存密钥，不会发送其他地址的密钥。';
  }
  function normalizeDraftAddress(value) {
    try { const url = new URL(value.trim()); return url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, ''); } catch { return ''; }
  }
  function resetCatalog() { catalogVersion++; el('refreshApiModels').disabled = false; el('apiModelOptions').replaceChildren(); el('apiModelsStatus').textContent = '填写服务地址后可读取模型列表；服务不支持时，直接填写模型 ID。'; }
  function toggleProvider() {
    const remote = el('modelProvider').value === 'custom';
    el('localModelPanel').hidden = remote; el('customModelPanel').hidden = !remote; el('customBaseUrl').disabled = !remote;
    el('modelSettingsStatus').textContent = '';
  }
  async function openSettings() {
    await ready; if (configError) await readConfig();
    el('modelProvider').value = state.provider; el('modelName').value = state.model;
    el('customBaseUrl').value = saved?.customBaseUrl || ''; el('customModelName').value = saved?.customModel || ''; el('customKey').value = '';
    resetCatalog(); updateKeyHint(); toggleProvider();
    if (configError) el('modelSettingsStatus').textContent = configError;
    el('settingsDialog').showModal();
  }
  async function refreshModels() {
    const address = el('customBaseUrl').value.trim(), key = el('customKey').value.trim();
    if (!address) { el('apiModelsStatus').textContent = '请先填写 API 基础地址。'; return; }
    const version = ++catalogVersion, button = el('refreshApiModels'); button.disabled = true; el('apiModelsStatus').textContent = '正在读取此 API 地址的模型列表…';
    try {
      const response = await fetch('/api/api-models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ customBaseUrl: address, ...(key ? { customKey: key } : {}) }) });
      const data = await response.json(); if (version !== catalogVersion) return; if (!response.ok) throw new Error(data.error || '读取模型列表失败');
      el('apiModelOptions').replaceChildren(...data.models.map(id => { const option = document.createElement('option'); option.value = id; return option; }));
      el('apiModelsStatus').textContent = data.models.length ? `已读取 ${data.models.length} 个模型，可输入名称筛选。请选择支持文本聊天的模型。` : '服务未返回可用模型，请直接填写模型 ID。';
    } catch (error) { if (version === catalogVersion) el('apiModelsStatus').textContent = `${error.message}。也可直接填写模型 ID。`; }
    finally { if (version === catalogVersion) button.disabled = false; }
  }
  async function saveSettings(event) {
    if (event.submitter?.id !== 'saveSettings') return; event.preventDefault();
    const provider = el('modelProvider').value, button = el('saveSettings'); button.disabled = true; el('modelSettingsStatus').textContent = '正在保存…';
    try {
      const payload = { provider, localModel: el('modelName').value.trim() || state.model };
      if (provider === 'custom') { payload.customBaseUrl = el('customBaseUrl').value.trim(); payload.customModel = el('customModelName').value.trim(); if (el('customKey').value.trim()) payload.customKey = el('customKey').value.trim(); }
      const response = await fetch('/api/model-config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
      const config = await response.json(); if (!response.ok) throw new Error(config.error || '保存失败'); applyConfig(config); el('settingsDialog').close();
    } catch (error) { el('modelSettingsStatus').textContent = error.message; }
    finally { button.disabled = false; }
  }
  el('modelSettings').onclick = openSettings;
  el('closeModelSettings').onclick = el('cancelModelSettings').onclick = () => el('settingsDialog').close();
  el('modelProvider').onchange = toggleProvider; el('refreshApiModels').onclick = refreshModels;
  el('customBaseUrl').oninput = () => { el('customKey').value = ''; resetCatalog(); updateKeyHint(); };
  el('customKey').oninput = resetCatalog;
  el('modelSettingsForm').addEventListener('submit', saveSettings);
  el('settingsDialog').addEventListener('close', () => { el('customKey').value = ''; catalogVersion++; });
  el('checkConnection').onclick = async () => {
    el('connectionStatus').textContent = '检测中…';
    try { const response = await fetch('/api/health'); const data = await response.json(); const model = el('modelName').value.trim(); el('connectionStatus').textContent = model === 'rules' ? '规则演示模式' : data.ollama && data.models.includes(model) ? '本地模型已就绪' : data.ollama ? 'Ollama 已运行，未找到此模型' : '尚未连接 Ollama'; }
    catch { el('connectionStatus').textContent = '无法检测本地服务'; }
  };
  window.ModelSettings = { ready, providerLabel, destinationLabel, async selection() {
    await ready; if (configError) throw new Error('无法读取模型配置，请打开模型设置后重试');
    return state.provider === 'custom' ? { provider: 'custom', model: state.apiModel, customBaseUrl: state.customBaseUrl } : { provider: 'ollama', model: state.model };
  } };
})();
