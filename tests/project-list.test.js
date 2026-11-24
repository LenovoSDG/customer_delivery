const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { runInContext } = require('node:vm');
const { JSDOM } = require('jsdom');

function setup(t, { storage = {}, rehearsal = false } = {}) {
  const dom = new JSDOM(fs.readFileSync('index.html', 'utf8'), {
    runScripts: 'outside-only',
    url: 'http://127.0.0.1:4174/'
  });
  const win = dom.window;
  const el = id => win.document.getElementById(id);
  const dialog = el('projectDialog');
  dialog.showModal = () => { dialog.open = true; };
  dialog.close = () => { dialog.open = false; };
  win.scrollTo = () => {};
  t.after(() => win.close());
  for (const [key, value] of Object.entries(storage)) win.localStorage.setItem(key, value);
  const files = ['app.js', 'report-ui.js'];
  if (rehearsal) {
    win.ModelSettings = {
      providerLabel: () => '本机 Ollama',
      selection: async () => ({ provider: 'ollama', model: 'qwen3:4b' })
    };
    files.push('rehearsal-ui.js');
  }
  for (const filename of files) runInContext(fs.readFileSync(filename, 'utf8'), dom.getInternalVMContext(), { filename });
  return { win, el, dialog };
}

test('status filter and customer search follow material check results', async t => {
  const { win, el } = setup(t);
  const card = win.document.querySelector('[data-project-card]');
  const filter = el('projectFilter');
  const search = el('projectSearch');
  const selectStatus = status => {
    filter.value = status;
    filter.dispatchEvent(new win.Event('change'));
  };
  const searchFor = query => {
    search.value = query;
    search.dispatchEvent(new win.Event('input'));
  };
  const assertVisible = visible => {
    assert.equal(card.classList.contains('hidden'), !visible);
    assert.equal(el('projectResultCount').textContent, visible ? '1 个项目' : '0 个项目');
  };

  selectStatus('待汇报');
  assertVisible(false);
  selectStatus('进行中');
  searchFor(' 联想 ');
  assertVisible(true);
  searchFor('其他客户');
  assertVisible(false);
  searchFor('联想');

  el('loadSample').click();
  win.document.querySelector('[data-confirm]').click();
  assert.equal(card.querySelector('.project-status').textContent, '进行中');
  assertVisible(true);

  win.fetch = async () => ({
    ok: true,
    json: async () => ({
      answer: '已核验',
      report: { summary: { reviewed: 1, total: 1, partial: 0, missing: 0 }, elapsedMs: 0 }
    })
  });
  await el('runReview').onclick();
  assert.equal(card.querySelector('.project-status').textContent, '待汇报');
  assertVisible(false);
  selectStatus('待汇报');
  assertVisible(true);
  win.document.querySelector('[data-remove-doc]').click();
  assert.equal(card.querySelector('.project-status').textContent, '进行中');
  assertVisible(false);
  selectStatus('');
  assertVisible(true);
});

test('cancel and close dismiss invalid project forms without saving', t => {
  const { win, el, dialog } = setup(t);
  const form = el('projectForm');
  const name = el('projectNameInput');
  const customer = el('projectCustomerInput');
  const projectName = win.document.querySelector('[data-project-card] h2');
  const originalName = projectName.textContent;
  const originalCustomer = customer.value;
  const buttons = [...dialog.querySelectorAll('[data-close-project]')];
  assert.equal(buttons.length, 2);

  for (const button of buttons) {
    assert.equal(button.type, 'button');
    el('newProject').click();
    assert.equal(dialog.open, true);
    assert.equal(name.value, '');
    name.value = '';
    assert.equal(form.checkValidity(), false);
    button.click();
    assert.equal(dialog.open, false);
    assert.equal(projectName.textContent, originalName);
  }

  el('editProject').click();
  const savedCustomer = customer.value;
  customer.value = '取消前的输入';
  buttons[1].click();
  el('editProject').click();
  assert.equal(customer.value, savedCustomer);
  assert.notEqual(savedCustomer, originalCustomer);
  name.value = '';
  el('saveProject').click();
  assert.equal(dialog.open, true);
  name.value = '更新后的项目名';
  el('saveProject').click();
  assert.equal(dialog.open, false);
  assert.equal(projectName.textContent, '更新后的项目名');
});

function createProject(el, name, customer = '', owner = '') {
  el('newProject').click();
  el('projectNameInput').value = name;
  el('projectCustomerInput').value = customer;
  el('projectOwnerInput').value = owner;
  el('saveProject').click();
}

test('creates independent projects, keeps rules with their project, and restores the list on reload', t => {
  const { win, el } = setup(t, { storage: { projectRules: '原有检查规范' } });
  const demo = win.document.querySelector('[data-project-card]');
  el('loadSample').click();
  win.document.querySelector('[data-confirm]').click();
  createProject(el, '门户升级', '北辰团队', '陈齐');
  const portal = el('projectGrid').lastElementChild;
  assert.equal(el('projectTitle').textContent, '门户升级');
  assert.equal(el('qualityReqs').textContent, '0');
  assert.equal(el('qualityDocs').textContent, '0');
  assert.equal(el('rules').value, '');
  el('rules').value = '门户验收规范';
  el('saveRules').click();

  createProject(el, '数据交付', '南岭团队');
  assert.equal(el('projectResultCount').textContent, '3 个项目');
  demo.querySelector('button').click();
  assert.equal(el('qualityReqs').textContent, '1');
  assert.equal(el('qualityDocs').textContent, '1');
  assert.match(el('rules').value, /汇报需说明/);
  portal.querySelector('button').click();
  assert.equal(el('materialCount').textContent, '0');
  assert.equal(el('rules').value, '门户验收规范');

  el('projectSearch').value = '北辰';
  el('projectSearch').dispatchEvent(new win.Event('input'));
  assert.equal(el('projectResultCount').textContent, '1 个项目');
  assert.equal(portal.classList.contains('hidden'), false);
  assert.equal(demo.classList.contains('hidden'), true);

  const restored = setup(t, {
    storage: { deliveryProjects: win.localStorage.getItem('deliveryProjects') }
  });
  assert.equal(restored.el('projectResultCount').textContent, '3 个项目');
  assert.equal(restored.el('rules').value, '原有检查规范');
  const restoredPortal = restored.el('projectGrid').children[1];
  restoredPortal.querySelector('button').click();
  assert.equal(restored.el('rules').value, '门户验收规范');
  assert.match(restored.el('projectMeta').textContent, /负责人：陈齐/);
});

test('late imports and review results stay with their originating project', async t => {
  const { win, el } = setup(t);
  const demo = win.document.querySelector('[data-project-card]');
  el('loadSample').click();
  win.document.querySelector('[data-confirm]').click();
  let finishReview;
  win.fetch = async (url, options) => {
    assert.equal(url, '/api/review');
    assert.equal(JSON.parse(options.body).documents.length, 1);
    return new Promise(resolve => { finishReview = resolve; });
  };
  const reviewing = el('runReview').onclick();
  let finishRead;
  const reading = el('docInput').onchange({
    target: {
      files: [{ name: '补充材料.txt', type: 'text/plain', size: 10, text: () => new Promise(resolve => { finishRead = resolve; }) }],
      value: ''
    }
  });

  createProject(el, '独立交付');
  finishRead('补充内容');
  await reading;
  finishReview({
    ok: true,
    json: async () => ({
      answer: '原项目质检结果',
      report: { summary: { reviewed: 1, total: 1, partial: 0, missing: 0 }, elapsedMs: 0 }
    })
  });
  await reviewing;
  assert.equal(el('qualityDocs').textContent, '0');
  assert.doesNotMatch(el('report').textContent, /原项目质检结果/);

  demo.querySelector('button').click();
  assert.equal(el('qualityDocs').textContent, '2');
  assert.equal(demo.querySelector('[data-doc-progress]').textContent, '1 / 2');
  assert.match(el('report').textContent, /原项目质检结果/);
});

test('rehearsal and WeChat events stay with the project that started them', async t => {
  const { win, el } = setup(t, { rehearsal: true });
  const demo = win.document.querySelector('[data-project-card]');
  let finishRehearsal;
  win.fetch = async (url, options) => {
    if (url === '/api/rehearsal') {
      assert.equal(JSON.parse(options.body).project, demo.querySelector('h2').textContent);
      return new Promise(resolve => { finishRehearsal = resolve; });
    }
    assert.match(url, /^\/api\/wechat\/capture\/status\?after=/);
    return {
      json: async () => ({
        active: true, projectId: 'demo', title: '微信', group: '演示群', intervalSec: 15,
        events: [{
          id: 1, projectId: 'demo', group: '演示群', at: '2026-11-24T12:00:00Z',
          file: 'wechat-1.png', url: '/captures/wechat-1.png',
          messages: [{ time: '12:00', speaker: '客户', text: '需要增加一份操作手册。' }]
        }]
      })
    };
  };
  const rehearsing = el('startRehearsal').onclick();
  await Promise.resolve();
  createProject(el, '新项目');
  await win.pollCapture();
  finishRehearsal({ ok: true, json: async () => ({ question: '原项目的首问' }) });
  await rehearsing;
  assert.equal(el('reqCount').textContent, '0');
  assert.doesNotMatch(el('conversation').textContent, /原项目的首问/);
  assert.equal(el('stopWechatCapture').disabled, true);

  demo.querySelector('button').click();
  assert.equal(el('reqCount').textContent, '1');
  assert.match(el('captureEvents').textContent, /操作手册/);
  assert.match(el('conversation').textContent, /原项目的首问/);
  assert.equal(el('stopWechatCapture').disabled, false);
});

test('card actions rename and edit the chosen project without opening it', t => {
  const { win, el, dialog } = setup(t);
  const demo = el('projectGrid').firstElementChild;
  createProject(el, '门户升级', '北辰团队', '陈齐');
  const portal = el('projectGrid').lastElementChild;
  const projectId = portal.dataset.projectId;
  demo.querySelector('[data-open-project]').click();
  win.document.querySelector('.sidebar [data-page="projects"]').click();

  portal.querySelector('[data-rename-project]').click();
  assert.equal(el('projectDialogTitle').textContent, '重命名项目');
  assert.equal(el('projectDetailsFields').hidden, true);
  assert.equal(el('projectNameInput').value, '门户升级');
  el('projectNameInput').value = '  ';
  el('saveProject').click();
  assert.equal(dialog.open, true);
  el('projectNameInput').value = '  门户交付  ';
  el('projectCustomerInput').value = '不会保存的客户';
  el('saveProject').click();
  assert.equal(portal.querySelector('h2').textContent, '门户交付');
  assert.equal(portal.querySelector('p').textContent, '客户：北辰团队');
  assert.equal(portal.querySelector('.card-footer span').textContent, '负责人：陈齐');

  portal.querySelector('[data-edit-project]').click();
  assert.equal(el('projectDialogTitle').textContent, '编辑项目');
  assert.equal(el('projectDetailsFields').hidden, false);
  assert.equal(el('projectNameInput').value, '门户交付');
  assert.equal(el('projectCustomerInput').value, '北辰团队');
  assert.equal(el('projectOwnerInput').value, '陈齐');
  el('projectCustomerInput').value = '南岭团队';
  el('projectOwnerInput').value = '王宁';
  el('saveProject').click();

  assert.equal(dialog.open, false);
  assert.equal(portal.querySelector('p').textContent, '客户：南岭团队');
  assert.equal(portal.querySelector('.card-footer span').textContent, '负责人：王宁');
  assert.equal(el('projectTitle').textContent, '凌云办公协同升级');
  assert.ok(el('page-projects').classList.contains('active'));
  const stored = JSON.parse(win.localStorage.getItem('deliveryProjects'));
  assert.equal(stored.length, 2);
  assert.deepEqual(stored.find(project => project.id === projectId), {
    id: projectId, name: '门户交付', customer: '南岭团队', owner: '王宁', savedRules: ''
  });
});
