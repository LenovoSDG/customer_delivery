const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

async function setup() {
  const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), { runScripts: 'outside-only', url: 'http://127.0.0.1:4174/' });
  const win = dom.window;
  const calls = [];
  win.eval("var state={model:'local:4b'};");
  const dialog = win.document.getElementById('settingsDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; dialog.dispatchEvent(new win.Event('close')); };
  win.fetch = async (url, options = {}) => {
    calls.push({ url, options });
    const saved = { provider: 'ollama', localModel: 'local:4b', apiModel: '', keyConfigured: false };
    if (url === '/api/model-config' && !options.method) return new Response(JSON.stringify(saved));
    if (url === '/api/api-models') return new Response(JSON.stringify({ models: ['vendor/model-a', 'vendor/model-b'] }));
    if (url === '/api/model-config' && options.method === 'POST') {
      const payload = JSON.parse(options.body);
      if (payload.provider === 'custom') {
        return Response.json({ ...saved, provider: 'custom', customBaseUrl: payload.customBaseUrl,
          customModel: payload.customModel, customKeyConfigured: Boolean(payload.customKey) });
      }
      return new Response(JSON.stringify({ ...saved, provider: payload.provider, apiModel: payload.apiModel, keyConfigured: true }));
    }
    throw new Error('Unexpected request');
  };
  win.eval(fs.readFileSync('model-settings.js', 'utf8'));
  await win.ModelSettings.ready;
  await win.document.getElementById('modelSettings').onclick();
  return { win, calls, el: id => win.document.getElementById(id) };
}

test('API mode selection alone does not change active provider or claim a connection', async () => {
  const { win, el } = await setup();
  el('modelProvider').value = 'bohrium'; el('modelProvider').dispatchEvent(new win.Event('change'));
  assert.equal(el('apiModelPanel').hidden, false);
  assert.equal(el('localModelPanel').hidden, true);
  assert.equal((await win.ModelSettings.selection()).provider, 'ollama');
  assert.match(el('apiKeyStatus').textContent, /尚未配置/);
});

test('model catalog is dynamic, draft key is not persisted, and successful save clears it', async () => {
  const { win, calls, el } = await setup();
  el('modelProvider').value = 'bohrium';
  el('apiKey').value = 'test-only-draft-key';
  await el('refreshApiModels').onclick();
  assert.deepEqual([...el('apiModelOptions').children].map(option => option.value), ['vendor/model-a', 'vendor/model-b']);
  assert.equal(calls.filter(c => c.url === '/api/model-config' && c.options.method === 'POST').length, 0);
  el('apiModelName').value = 'vendor/model-b';
  el('modelSettingsForm').dispatchEvent(new win.SubmitEvent('submit', { cancelable: true, submitter: el('saveSettings') }));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el('apiKey').value, '');
  assert.equal(win.localStorage.length, 0);
  assert.equal((await win.ModelSettings.selection()).model, 'vendor/model-b');
  assert.match(el('processingNotice').textContent, /发送.*玻尔网关/);
});

test('cancel discards the draft key and missing key does not trigger a network request', async () => {
  const { calls, el } = await setup();
  await el('refreshApiModels').onclick();
  assert.equal(calls.filter(c => c.url === '/api/api-models').length, 0);
  assert.match(el('apiModelsStatus').textContent, /先填写/);
  el('apiKey').value = 'test-only-draft-key';
  el('cancelModelSettings').click();
  assert.equal(el('apiKey').value, '');
  assert.equal(el('settingsDialog').open, false);
});

test('custom API explains missing details and confirms a successful key save without echoing it', async () => {
  const { win, calls, el } = await setup();
  el('modelProvider').value = 'custom';
  el('modelProvider').dispatchEvent(new win.Event('change'));
  el('customKey').value = 'test-only-custom-key';
  const submit = () => el('modelSettingsForm').dispatchEvent(new win.SubmitEvent('submit', {
    cancelable: true, submitter: el('saveSettings')
  }));

  submit();
  assert.match(el('modelSettingsStatus').textContent, /保存失败.*API 基础地址和模型 ID/);
  assert.equal(el('customKey').value, 'test-only-custom-key');
  assert.equal(calls.filter(call => call.options.method === 'POST').length, 0);

  el('customBaseUrl').value = 'https://api.example/v1';
  el('customModelName').value = 'test-model';
  submit();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el('settingsDialog').open, true);
  assert.equal(el('customKey').value, '');
  assert.match(el('customKeyStatus').textContent, /密钥已保存/);
  assert.match(el('modelSettingsStatus').textContent, /设置已保存.*自定义 API/);
  assert.equal((await win.ModelSettings.selection()).model, 'test-model');
});
