(function () {
  'use strict';

  const start = $('#startRehearsal');
  const send = $('#sendAnswer');
  const input = $('#answerInput');
  const conversation = $('#conversation');
  const audience = $('#audience');
  const duration = $('#duration');
  const focus = $('#rehearsalFocus');
  const micBtn = $('#micButton');
  const saveKbBtn = $('#saveToKnowledge');
  const kbStorageKey = 'zhihuiKnowledgeBase';
  const initialMessage = '选择模拟视角与演练重点后，点击「开始模拟提问」，教练将基于当前项目要求与材料生成首问。';
  const initialFeedback = '回答首问后，这里会展示总评、亮点、改进建议与可引用的材料出处。';

  let knowledgeItems = [];
  let citedKbIds = new Set();
  let editingKbId = null;

  // Voice Recognition & Audio Meter state
  let recognition = null;
  let recording = false;
  let micStream = null;
  let audioCtx = null;
  let meterRaf = 0;
  let voicePrefix = '';

  // Countdown timer
  let remainingSeconds = 300;
  let timerId = null;

  function parseDurationSec() {
    const mins = parseInt(duration?.value || '5', 10);
    return (Number.isFinite(mins) && mins > 0 ? mins : 5) * 60;
  }

  function renderClock() {
    const clock = $('#rehearsalClock');
    if (!clock) return;
    const m = Math.floor(remainingSeconds / 60);
    const s = remainingSeconds % 60;
    clock.textContent = `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  function startClock() {
    clearInterval(timerId);
    remainingSeconds = parseDurationSec();
    renderClock();
    timerId = setInterval(() => {
      if (remainingSeconds > 0) {
        remainingSeconds -= 1;
        renderClock();
      }
    }, 1000);
  }

  function speakText(text) {
    if (!text || !$('#autoReadTts')?.checked || typeof window.speechSynthesis === 'undefined') return;
    try {
      window.speechSynthesis.cancel();
      const utter = new SpeechSynthesisUtterance(text);
      const voices = window.speechSynthesis.getVoices?.() || [];
      const zh = voices.find(v => /zh/i.test(v.lang) && v.localService) || voices.find(v => /zh/i.test(v.lang));
      if (zh) utter.voice = zh;
      utter.lang = zh?.lang || 'zh-CN';
      window.speechSynthesis.speak(utter);
    } catch {}
  }

  function stopVoiceCapture() {
    recording = false;
    if (meterRaf && typeof window.cancelAnimationFrame === 'function') {
      window.cancelAnimationFrame(meterRaf);
      meterRaf = 0;
    }
    if (recognition) {
      try { recognition.stop(); } catch {}
      recognition = null;
    }
    if (micStream) {
      micStream.getTracks().forEach(t => t.stop());
      micStream = null;
    }
    if (audioCtx) {
      try { audioCtx.close(); } catch {}
      audioCtx = null;
    }
    if (micBtn) {
      micBtn.classList.remove('recording');
      micBtn.textContent = '🎙 语音回答';
    }
    $('#voiceMeterWrap')?.classList.add('hidden');
    if ($('#voiceLevelBar')) $('#voiceLevelBar').style.width = '8%';
  }

  async function startAudioMeter() {
    if (!navigator.mediaDevices?.getUserMedia) return;
    try {
      micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return;
      audioCtx = new Ctx();
      const source = audioCtx.createMediaStreamSource(micStream);
      const analyser = audioCtx.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      const data = new Uint8Array(analyser.frequencyBinCount);
      const tick = () => {
        if (!recording) return;
        analyser.getByteFrequencyData(data);
        const avg = data.reduce((a, b) => a + b, 0) / data.length;
        const pct = Math.min(100, Math.max(8, Math.round(avg * 1.6)));
        if ($('#voiceLevelBar')) $('#voiceLevelBar').style.width = `${pct}%`;
        if (typeof window.requestAnimationFrame === 'function') {
          meterRaf = window.requestAnimationFrame(tick);
        }
      };
      tick();
    } catch {}
  }

  function toggleVoiceCapture() {
    if (recording) {
      stopVoiceCapture();
      if ($('#voiceStatus')) $('#voiceStatus').textContent = '录音已结束，可直接核对文字并点击「发送回答」';
      input?.focus();
      return;
    }
    const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SpeechRec) {
      if ($('#voiceStatus')) {
        $('#voiceStatus').textContent = '当前浏览器不支持内置中文语音转写，请使用 Chrome/Edge 或直接文字输入回答。';
      }
      window.showToast?.('当前浏览器不支持语音识别 API，请使用 Chrome/Edge 或文字输入回答', 'warning');
      return;
    }
    if (!activeProject.rehearsal?.question) {
      window.showToast?.('请先点击「开始模拟提问」，首问生成后再语音作答', 'info');
      return;
    }
    try {
      recognition = new SpeechRec();
      recognition.lang = 'zh-CN';
      recognition.continuous = true;
      recognition.interimResults = true;
      voicePrefix = input.value.trim();
      let finalText = '';

      recognition.onstart = () => {
        recording = true;
        micBtn.classList.add('recording');
        micBtn.textContent = '⏹ 停止录音';
        $('#voiceMeterWrap')?.classList.remove('hidden');
        if ($('#voiceStatus')) $('#voiceStatus').textContent = '正在聆听中文语音，请开始回答…';
        startAudioMeter();
      };

      recognition.onresult = event => {
        let interim = '';
        finalText = '';
        for (let i = 0; i < event.results.length; i++) {
          const transcript = event.results[i][0].transcript;
          if (event.results[i].isFinal) finalText += transcript;
          else interim += transcript;
        }
        const combined = [voicePrefix, (finalText + interim).trim()].filter(Boolean).join(' ');
        input.value = combined.slice(0, 1200);
        if (activeProject.rehearsal) activeProject.rehearsal.answer = input.value;
        updateControls();
      };

      recognition.onerror = event => {
        const msg = event.error === 'not-allowed' ? '麦克风权限被拒绝，请在浏览器地址栏允许麦克风访问' : `语音识别提示：${event.error}`;
        if ($('#voiceStatus')) $('#voiceStatus').textContent = msg;
        stopVoiceCapture();
      };

      recognition.onend = () => {
        if (recording) stopVoiceCapture();
      };

      recognition.start();
    } catch (error) {
      stopVoiceCapture();
      window.showToast?.(`无法开启语音识别：${error.message}`, 'error');
    }
  }

  function renderMessages(messages) {
    conversation.replaceChildren(...messages.map(({ kind, text, label }) => {
      const message = document.createElement('div');
      message.className = kind;
      if (label) {
        const heading = document.createElement('b');
        heading.textContent = label;
        message.append(heading, document.createElement('br'));
      }
      message.append(text);
      return message;
    }));
    conversation.scrollTop = conversation.scrollHeight;
  }

  function renderFeedback(session) {
    const host = $('#feedback');
    if (!host) return;
    const hasStructured = session?.feedback && (session.strengths?.length || session.improvements?.length || session.evidenceTip);
    if (!session?.feedback) {
      host.className = 'feedback-placeholder';
      host.textContent = initialFeedback;
      if (saveKbBtn) saveKbBtn.disabled = true;
      return;
    }
    if (saveKbBtn) saveKbBtn.disabled = false;
    if (!hasStructured) {
      host.className = 'feedback-placeholder';
      host.textContent = session.feedback;
      return;
    }
    host.className = 'feedback-structured';
    host.replaceChildren();
    const makeCard = (cls, title, bodyNode) => {
      const card = document.createElement('div');
      card.className = `feedback-card ${cls}`;
      const h = document.createElement('h3');
      h.textContent = title;
      card.append(h, bodyNode);
      return card;
    };
    const pSum = document.createElement('p');
    pSum.textContent = session.feedback;
    host.append(makeCard('summary', '本轮总评', pSum));

    if (session.strengths?.length) {
      const ul = document.createElement('ul');
      session.strengths.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.append(li); });
      host.append(makeCard('strengths', '表达亮点', ul));
    }
    if (session.improvements?.length) {
      const ul = document.createElement('ul');
      session.improvements.forEach(s => { const li = document.createElement('li'); li.textContent = s; ul.append(li); });
      host.append(makeCard('improvements', '待补缺口与修改建议', ul));
    }
    if (session.evidenceTip) {
      const pEv = document.createElement('p');
      pEv.textContent = session.evidenceTip;
      host.append(makeCard('evidence', '材料出处提示', pEv));
    }
  }

  function updateControls() {
    const session = activeProject.rehearsal;
    const busy = Boolean(session?.pending);
    const ready = Boolean(session?.question);
    start.disabled = busy;
    start.textContent = ready ? '重新开始演练' : '开始模拟提问';
    input.disabled = busy || !ready;
    input.placeholder = ready ? '可用语音或文字输入回答（Enter 发送，Shift+Enter 换行）…' : '等首问生成后即可回答';
    send.disabled = input.disabled || !input.value.trim();
    if ($('#navBadgeRehearsal')) {
      $('#navBadgeRehearsal').textContent = session?.turns?.length ? `${session.turns.length}轮` : (ready ? '进行中' : '待练');
    }
  }

  function renderRehearsal() {
    const session = activeProject.rehearsal;
    input.value = session?.answer || '';
    renderMessages(session?.messages || [{ kind: 'coach-message', text: initialMessage }]);
    $('#rehearsalStatus').textContent = session?.status || '待开始';
    $('#rehearsalError').textContent = session?.error || '';
    renderFeedback(session);
    updateControls();
  }

  function renderSetup() {
    const setup = activeProject.rehearsalSetup;
    audience.selectedIndex = setup?.audience ?? 0;
    duration.selectedIndex = setup?.duration ?? 0;
    focus.value = setup?.focus || '';
    remainingSeconds = parseDurationSec();
    renderClock();
    renderRehearsal();
  }

  function updateModel() {
    const remote = state.provider !== 'ollama';
    const model = remote ? state.apiModel : state.model;
    const source = window.ModelSettings.providerLabel(state.provider);
    const dest = window.ModelSettings.destinationLabel
      ? window.ModelSettings.destinationLabel(state.provider)
      : source;
    $('#rehearsalProvider').textContent = !remote && model === 'rules' ? '请选择对话模型' : `调用 ${source}`;
    $('#rehearsalDestination').textContent = remote
      ? `项目摘要、材料摘录、引用复盘及近期问答会发送至 ${dest}。`
      : '项目内容、复盘引用与问答均由本机 Ollama 处理。';
    for (const project of projects.values()) {
      const session = project.rehearsal;
      if (session?.selection && (state.provider !== session.selection.provider || model !== session.selection.model
        || (state.provider === 'custom' && state.customBaseUrl !== session.selection.customBaseUrl))) {
        session.pending?.abort();
        project.rehearsal = { messages: [{ kind: 'coach-message', text: '模型已更换，请重新开始演练。' }] };
      }
    }
    renderRehearsal();
  }

  function getSelectedKnowledgeRefs() {
    return knowledgeItems
      .filter(item => citedKbIds.has(item.id))
      .map(item => ({ title: item.title, audience: item.audience, takeaway: item.takeaway }));
  }

  async function requestTurn(project, session, answer = '') {
    const controller = new AbortController();
    const turns = answer ? [...session.turns, { question: session.question, answer }].slice(-4) : [];
    session.pending = controller;
    session.status = answer ? '教练评估回答中…' : '正在生成首问…';
    session.error = '';
    renderRehearsal();
    try {
      const selection = session.selection || await window.ModelSettings.selection();
      if (controller.signal.aborted) return;
      if (!selection.model || (selection.provider === 'ollama' && selection.model === 'rules')) {
        throw new Error('请在右上角「模型设置」中选择支持文本对话的模型（rules 模式仅用于关键词演示）。');
      }
      session.selection = selection;
      const response = await fetch('/api/rehearsal', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: controller.signal,
        body: JSON.stringify({
          ...selection,
          ...session.context,
          knowledgeRefs: getSelectedKnowledgeRefs(),
          project: project.name,
          turns
        })
      });
      const result = await response.json();
      if (project.rehearsal !== session) return;
      if (!response.ok) throw new Error(result.error || '演练请求失败');
      if (answer) {
        session.messages.push({ kind: 'user-message', text: answer });
        session.answer = '';
        session.lastQuestion = session.question;
        session.lastAnswer = answer;
        session.feedback = result.feedback;
        session.strengths = result.strengths || [];
        session.improvements = result.improvements || [];
        session.evidenceTip = result.evidenceTip || '';
      } else {
        session.messages = [];
      }
      session.turns = turns;
      session.question = result.question;
      session.messages.push({
        kind: 'coach-message',
        text: result.question,
        label: answer ? `${session.context.audience} · 追问` : `${session.context.audience} · 首问`
      });
      session.status = '演练中';
      speakText(result.question);
    } catch (error) {
      if (project.rehearsal !== session) return;
      session.error = error.message;
      session.status = session.question ? '等待重试' : '启动失败';
    } finally {
      session.pending = null;
      if (project === activeProject && project.rehearsal === session) {
        renderRehearsal();
        if (session.question && $('#page-rehearsal').classList.contains('active')) input.focus();
      }
    }
  }

  start.onclick = () => {
    const project = activeProject;
    if (project.rehearsal?.pending) return;
    stopVoiceCapture();
    startClock();
    const session = {
      question: '',
      answer: '',
      turns: [],
      selection: null,
      pending: null,
      messages: [{ kind: 'coach-message', text: '正在结合项目需求、材料与引用复盘准备首问…' }],
      context: {
        audience: audience.value,
        duration: duration.value,
        focus: focus.value,
        rules: project.rules || '',
        requirements: project.requirements.filter(item => item.status === '已确认').slice(0, 10).map(item => item.detail.slice(0, 180)),
        documents: project.docs.filter(item => item.text?.trim()).slice(0, 4).map(item => ({ name: item.name, text: item.text.slice(0, 500) }))
      }
    };
    project.rehearsal = session;
    return requestTurn(project, session);
  };

  send.onclick = () => {
    const project = activeProject;
    const session = project.rehearsal;
    const answer = input.value.trim();
    if (recording) stopVoiceCapture();
    if (session?.question && !session.pending && answer) return requestTurn(project, session, answer);
  };

  input.addEventListener('input', () => {
    if (activeProject.rehearsal) activeProject.rehearsal.answer = input.value;
    updateControls();
  });

  input.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send.click();
    }
  });

  for (const element of [audience, duration, focus]) {
    element.addEventListener('input', () => {
      activeProject.rehearsalSetup = {
        audience: audience.selectedIndex,
        duration: duration.selectedIndex,
        focus: focus.value
      };
      if (element === duration && !activeProject.rehearsal?.question) {
        remainingSeconds = parseDurationSec();
        renderClock();
      }
    });
  }

  if (micBtn) micBtn.onclick = toggleVoiceCapture;

  // ---------- Local Personal Knowledge Base ----------
  function saveKbLocalCache() {
    try {
      localStorage.setItem(kbStorageKey, JSON.stringify(knowledgeItems));
    } catch {}
  }

  function renderCitedChips() {
    const host = $('#citedKbChips');
    if (!host) return;
    const cited = knowledgeItems.filter(item => citedKbIds.has(item.id));
    if (!cited.length) {
      host.innerHTML = '<small class="muted-hint">未引用历史复盘（可在下方知识库勾选）</small>';
      return;
    }
    host.innerHTML = cited.map(item =>
      `<span class="cited-chip"><span>${escapeHtml(item.title)}</span><button type="button" data-uncite-kb="${escapeHtml(item.id)}" aria-label="取消引用">×</button></span>`
    ).join('');
    host.querySelectorAll('[data-uncite-kb]').forEach(btn => {
      btn.onclick = () => {
        citedKbIds.delete(btn.dataset.unciteKb);
        renderKnowledgeBase();
      };
    });
  }

  function renderKnowledgeBase() {
    const count = knowledgeItems.length;
    if ($('#kbTopCount')) $('#kbTopCount').textContent = String(count);
    if ($('#kbCountChip')) $('#kbCountChip').textContent = String(count);
    renderCitedChips();

    const listHost = $('#kbList');
    if (!listHost) return;
    const q = ($('#kbSearch')?.value || '').trim().toLowerCase();
    const aud = $('#kbAudienceFilter')?.value || '';
    const filtered = knowledgeItems.filter(item => {
      const matchesAud = !aud || item.audience.includes(aud);
      const hay = `${item.title} ${item.takeaway} ${item.question} ${(item.tags || []).join(' ')}`.toLowerCase();
      return matchesAud && (!q || hay.includes(q));
    });

    listHost.innerHTML = filtered.length
      ? filtered.map(item => {
          const isCited = citedKbIds.has(item.id);
          return `
            <article class="kb-card ${isCited ? 'cited' : ''}">
              <div class="kb-card-top">
                <b>${escapeHtml(item.title)}</b>
                <span class="kb-audience-pill">${escapeHtml(item.audience || '通用视角')}</span>
              </div>
              ${item.tags?.length ? `<div class="kb-tags">${item.tags.map(t => `<span class="kb-tag">#${escapeHtml(t)}</span>`).join('')}</div>` : ''}
              ${item.question ? `<div class="kb-question-quote">原题：${escapeHtml(item.question)}</div>` : ''}
              <p class="kb-takeaway">${escapeHtml(item.takeaway)}</p>
              <div class="kb-card-footer">
                <label class="kb-cite-toggle">
                  <input type="checkbox" ${isCited ? 'checked' : ''} data-toggle-cite="${escapeHtml(item.id)}">
                  <span>${isCited ? '已引用到演练' : '引用到演练'}</span>
                </label>
                <div>
                  <button class="link-button muted" type="button" data-edit-kb="${escapeHtml(item.id)}">编辑</button>
                  <button class="link-button danger" type="button" data-del-kb="${escapeHtml(item.id)}">删除</button>
                </div>
              </div>
            </article>
          `;
        }).join('')
      : `<div class="empty-state wide compact"><div class="empty-symbol">◈</div><b>${count ? '没有匹配的复盘记录' : '个人知识库还是空的'}</b><span>${count ? '调整搜索词或视角筛选条件。' : '完成一轮演练反馈后点击「保存到个人知识库」，或点击右上角「载入示例复盘」体验引用效果。'}</span></div>`;

    listHost.querySelectorAll('[data-toggle-cite]').forEach(cb => {
      cb.onchange = () => {
        if (cb.checked) citedKbIds.add(cb.dataset.toggleCite);
        else citedKbIds.delete(cb.dataset.toggleCite);
        renderKnowledgeBase();
      };
    });
    listHost.querySelectorAll('[data-edit-kb]').forEach(btn => {
      btn.onclick = () => openKnowledgeDialog(knowledgeItems.find(x => x.id === btn.dataset.editKb));
    });
    listHost.querySelectorAll('[data-del-kb]').forEach(btn => {
      btn.onclick = () => deleteKnowledgeItem(btn.dataset.delKb);
    });
  }

  async function loadKnowledgeBase() {
    try {
      const response = await fetch('/api/knowledge-base');
      if (!response.ok) throw new Error('offline');
      const data = await response.json();
      knowledgeItems = Array.isArray(data.items) ? data.items : [];
      saveKbLocalCache();
    } catch {
      try {
        const cached = JSON.parse(localStorage.getItem(kbStorageKey) || '[]');
        if (Array.isArray(cached)) knowledgeItems = cached;
      } catch {
        knowledgeItems = [];
      }
    }
    renderKnowledgeBase();
  }

  async function upsertKnowledgeItem(payload) {
    try {
      const response = await fetch('/api/knowledge-base', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存失败');
      const idx = knowledgeItems.findIndex(x => x.id === data.item.id);
      if (idx >= 0) knowledgeItems[idx] = data.item;
      else knowledgeItems.unshift(data.item);
      citedKbIds.add(data.item.id);
      saveKbLocalCache();
      renderKnowledgeBase();
      return data.item;
    } catch {
      const record = {
        ...payload,
        id: payload.id || crypto.randomUUID(),
        tags: String(payload.tags || '').split(/[,，、\s]+/).filter(Boolean),
        createdAt: new Date().toISOString()
      };
      const idx = knowledgeItems.findIndex(x => x.id === record.id);
      if (idx >= 0) knowledgeItems[idx] = record;
      else knowledgeItems.unshift(record);
      citedKbIds.add(record.id);
      saveKbLocalCache();
      renderKnowledgeBase();
      return record;
    }
  }

  async function deleteKnowledgeItem(id) {
    citedKbIds.delete(id);
    try {
      await fetch(`/api/knowledge-base/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch {}
    knowledgeItems = knowledgeItems.filter(item => item.id !== id);
    saveKbLocalCache();
    renderKnowledgeBase();
    window.showToast?.('已从本地知识库删除该复盘记录', 'info');
  }

  const kbDialog = $('#knowledgeDialog');
  function openKnowledgeDialog(existing = null, fromSession = null) {
    if (!kbDialog) return;
    editingKbId = existing?.id || null;
    $('#knowledgeDialogTitle').textContent = existing ? '编辑个人复盘记录' : '保存演练复盘到本地知识库';
    if (existing) {
      $('#kbFieldTitle').value = existing.title || '';
      $('#kbFieldAudience').value = existing.audience || '客户项目负责人';
      $('#kbFieldTags').value = (existing.tags || []).join(', ');
      $('#kbFieldQuestion').value = existing.question || '';
      $('#kbFieldTakeaway').value = existing.takeaway || '';
    } else if (fromSession) {
      const q = fromSession.lastQuestion || fromSession.question || '';
      $('#kbFieldTitle').value = `${fromSession.context?.audience || '演练'}追问复盘：${q.slice(0, 24)}${q.length > 24 ? '…' : ''}`;
      $('#kbFieldAudience').value = fromSession.context?.audience || '客户项目负责人';
      $('#kbFieldTags').value = '答辩复盘, 证据依据';
      $('#kbFieldQuestion').value = q;
      const parts = [fromSession.feedback];
      if (fromSession.improvements?.length) parts.push(`改进建议：${fromSession.improvements.join('；')}`);
      if (fromSession.evidenceTip) parts.push(`出处要求：${fromSession.evidenceTip}`);
      $('#kbFieldTakeaway').value = parts.filter(Boolean).join('\n');
    } else {
      $('#kbFieldTitle').value = '';
      $('#kbFieldAudience').value = audience?.value || '客户项目负责人';
      $('#kbFieldTags').value = '';
      $('#kbFieldQuestion').value = '';
      $('#kbFieldTakeaway').value = '';
    }
    kbDialog.showModal();
  }

  $$('[data-close-kb]').forEach(btn => {
    btn.onclick = () => kbDialog?.close('cancel');
  });

  $('#knowledgeForm')?.addEventListener('submit', async event => {
    event.preventDefault();
    const title = $('#kbFieldTitle').value.trim();
    const takeaway = $('#kbFieldTakeaway').value.trim();
    if (!title || !takeaway) return;
    await upsertKnowledgeItem({
      id: editingKbId || undefined,
      title,
      audience: $('#kbFieldAudience').value,
      tags: $('#kbFieldTags').value,
      question: $('#kbFieldQuestion').value.trim(),
      takeaway,
      feedback: takeaway,
      projectName: activeProject?.name || '个人知识库'
    });
    kbDialog.close();
    window.showToast?.('已保存到本地个人复盘知识库，并默认勾选引用', 'success');
  });

  saveKbBtn?.addEventListener('click', () => openKnowledgeDialog(null, activeProject.rehearsal));
  $('#newKbNote')?.addEventListener('click', () => openKnowledgeDialog(null, null));
  $('#kbSearch')?.addEventListener('input', renderKnowledgeBase);
  $('#kbAudienceFilter')?.addEventListener('change', renderKnowledgeBase);
  $('#scrollToKbBtn')?.addEventListener('click', () => {
    $('#knowledgeBaseSection')?.scrollIntoView?.({ behavior: 'smooth' });
  });
  $('#kbQuickBtn')?.addEventListener('click', () => {
    if (typeof page === 'function') page('rehearsal');
    setTimeout(() => $('#knowledgeBaseSection')?.scrollIntoView?.({ behavior: 'smooth' }), 60);
  });

  $('#seedKbSample')?.addEventListener('click', async () => {
    await upsertKnowledgeItem({
      title: '预算报价含税口径与支撑依据追问',
      audience: '客户商务与采购负责人',
      tags: '含税口径, 预算明细, 财务依据',
      question: '你们的预算明细为什么按含税口径测算？具体税率与分项依据在哪里？',
      takeaway: '先给明确口径（全表按 6% 增值税含税测算），再报出支撑文件位置（预算明细表.xlsx 第2工作表），最后说明可提供不含税对照列。'
    });
    await upsertKnowledgeItem({
      title: '交付时间延期风险与阶段里程碑说明',
      audience: '公司领导（汇报评审）',
      tags: '上线计划, 里程碑, 风险应对',
      question: '11 月启动试点、12 月推广的节点是否紧张？如果移动端审批接口联调延期怎么办？',
      takeaway: '不能只说“按期推进”，必须给出具体责任人、前置联调时间窗以及降级备用方案（先灰度Web端审批，移动端周内补齐）。'
    });
    window.showToast?.('已载入 2 条典型汇报复盘经验到个人知识库', 'success');
  });

  window.addEventListener('project-changed', () => {
    stopVoiceCapture();
    renderSetup();
  });
  window.addEventListener('unload', () => {
    clearInterval(timerId);
    stopVoiceCapture();
  });
  window.addEventListener('model-settings-changed', updateModel);

  updateModel();
  loadKnowledgeBase();
})();
