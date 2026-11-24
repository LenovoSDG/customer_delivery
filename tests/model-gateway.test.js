const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createModelGateway, BASE_URL } = require('../model-gateway');

function setup(t, fetchImpl = async () => { throw new Error('Unexpected network request'); }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'delivery-gateway-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, '.env.local');
  return { file, gateway: createModelGateway({ configFile: file, env: {}, fetchImpl }) };
}

test('persists key on backend with private permissions, but never returns it', t => {
  const { gateway, file } = setup(t);
  const config = gateway.saveConfig({ provider: 'bohrium', apiKey: 'test-only-sentinel-key', apiModel: 'vendor/model-a', localModel: 'local:4b' });
  assert.equal(config.keyConfigured, true);
  assert.doesNotMatch(JSON.stringify(config), /test-only-sentinel-key/);
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  const reloaded = createModelGateway({ configFile: file, env: {} });
  assert.equal(reloaded.publicConfig().apiModel, 'vendor/model-a');
  reloaded.saveConfig({ provider: 'ollama', localModel: 'local:4b' });
  assert.equal(reloaded.publicConfig().keyConfigured, true);
});

test('model list uses the fixed Bohrium destination and only exposes model IDs', async t => {
  const { gateway, file } = setup(t, async (url, options) => {
    assert.equal(url, BASE_URL + '/models');
    assert.equal(options.headers.authorization, 'Bearer temporary-test-key');
    assert.equal(options.redirect, 'error');
    return new Response(JSON.stringify({ data: [{ id: 'b' }, { id: 'a' }, { id: 'a' }] }));
  });
  assert.deepEqual((await gateway.listModels('temporary-test-key')).models, ['a', 'b']);
  assert.equal(fs.existsSync(file), false, 'reading models does not persist the draft key');
});

test('does not forward provider error bodies or credential-bearing transport errors', async t => {
  const { gateway } = setup(t, async () => new Response('echo test-only-sentinel-key', { status: 401 }));
  await assert.rejects(gateway.listModels('test-only-sentinel-key'), error => !error.message.includes('test-only-sentinel-key') && /密钥/.test(error.message));
  const second = setup(t, async () => { throw new Error('test-only-sentinel-key in header'); });
  await assert.rejects(second.gateway.listModels('test-only-sentinel-key'), error => !error.message.includes('test-only-sentinel-key'));
});

test('API request contains selected model and schema, and JSON-mode incompatibility is retried once', async t => {
  let calls = 0;
  const { gateway } = setup(t, async (url, options) => {
    calls++;
    assert.equal(url, BASE_URL + '/chat/completions');
    const body = JSON.parse(options.body);
    assert.equal(body.model, 'chosen/model');
    assert.ok(body.messages[1].content.includes('schema'));
    assert.equal(body.think, undefined);
    assert.equal(body.format, undefined);
    if (calls === 1) return new Response('unsupported response_format', { status: 400 });
    assert.equal(body.response_format, undefined);
    return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: '```json\n{"criteria":["检查点"]}\n```' } }] }));
  });
  gateway.saveConfig({ provider: 'bohrium', apiKey: 'test-only-key', apiModel: 'chosen/model' });
  assert.deepEqual(await gateway.ask('chosen/model', 'system', 'content', { type: 'object' }), { criteria: ['检查点'] });
  assert.equal(calls, 2);
});

test('rate limits are surfaced without retries or silent local fallback', async t => {
  let calls = 0;
  const { gateway } = setup(t, async () => { calls++; return new Response('private details', { status: 429 }); });
  gateway.saveConfig({ provider: 'bohrium', apiKey: 'test-only-key', apiModel: 'chosen/model' });
  await assert.rejects(gateway.ask('chosen/model', 's', 'c', {}), /限流或额度不足/);
  assert.equal(calls, 1);
});

test('cannot save API mode without a key or select an arbitrary provider', t => {
  const { gateway, file } = setup(t);
  assert.throws(() => gateway.saveConfig({ provider: 'bohrium', apiModel: 'chosen/model' }), /密钥/);
  assert.throws(() => gateway.saveConfig({ provider: 'other', apiModel: 'chosen/model' }), /未知/);
  assert.equal(fs.existsSync(file), false);
});

test('cancellation stops in-flight work and prevents subsequent API requests', async t => {
  let calls = 0;
  const { gateway } = setup(t, async (url, options) => {
    calls++;
    return new Promise((resolve, reject) => options.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true }));
  });
  gateway.saveConfig({ provider: 'bohrium', apiKey: 'test-only-key', apiModel: 'chosen/model' });
  const controller = new AbortController();
  const request = gateway.ask('chosen/model', 's', 'c', {}, { signal: controller.signal });
  controller.abort();
  await assert.rejects(request, /取消/);
  await assert.rejects(gateway.ask('chosen/model', 's', 'c', {}, { signal: controller.signal }), /取消/);
  assert.equal(calls, 1);
});

test('custom API uses the saved address, keeps its key scoped to that address, and leaves DeepSeek separate', async t => {
  const requests = [];
  const fakeFetch = async (url, options) => {
    requests.push({ url, authorization: options.headers.authorization, model: JSON.parse(options.body).model });
    assert.equal(options.redirect, 'error');
    return Response.json({ choices: [{ message: { content: '{"question":"试点何时启动？","feedback":""}' } }] });
  };
  const { gateway, file } = setup(t, fakeFetch);
  gateway.saveConfig({ provider: 'deepseek', deepseekKey: 'test-deepseek-key' });
  const first = gateway.saveConfig({
    provider: 'custom', customBaseUrl: 'https://first.example/v1/chat/completions/',
    customModel: 'first-model', customKey: 'test-custom-key'
  });
  assert.equal(first.customBaseUrl, 'https://first.example/v1');
  assert.equal(first.customKeyConfigured, true);
  assert.doesNotMatch(JSON.stringify(first), /test-.*-key/);
  assert.throws(() => gateway.saveConfig({ provider: 'custom', customBaseUrl: 'https://user:secret@example/v1' }), /API 地址/);

  const runningReview = gateway.createChat('custom', first.customModel, { expectedBaseUrl: first.customBaseUrl });
  const second = gateway.saveConfig({ provider: 'custom', customBaseUrl: 'http://127.0.0.1:8000/v1', customModel: 'second-model' });
  assert.equal(second.customKeyConfigured, false);
  assert.equal(second.deepseekKeyConfigured, true);
  assert.throws(() => gateway.createChat('custom', first.customModel, { expectedBaseUrl: first.customBaseUrl }), /地址已更新/);
  assert.equal((await runningReview('system', 'content', {})).question, '试点何时启动？');

  const reloaded = createModelGateway({ configFile: file, env: {}, fetchImpl: fakeFetch });
  await reloaded.createChat('custom')('system', 'content', {});
  await reloaded.createChat('deepseek')('system', 'content', {});
  assert.deepEqual(requests, [
    { url: 'https://first.example/v1/chat/completions', authorization: 'Bearer test-custom-key', model: 'first-model' },
    { url: 'http://127.0.0.1:8000/v1/chat/completions', authorization: undefined, model: 'second-model' },
    { url: 'https://api.deepseek.com/chat/completions', authorization: 'Bearer test-deepseek-key', model: 'deepseek-flash' }
  ]);
});
