(function () {
  'use strict';

  const start = $('#startRehearsal');
  const send = $('#sendAnswer');
  const input = $('#answerInput');
  const conversation = $('#conversation');
  const audience = $('#audience');
  const duration = $('#duration');
  const focus = $('#rehearsalFocus');
  const initialMessage = '点击「开始文字演练」，由 AI 生成第一个问题。';
  const initialFeedback = '回答后，这里会显示本轮反馈。';

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

  function updateControls() {
    const session = activeProject.rehearsal;
    const busy = Boolean(session?.pending);
    const ready = Boolean(session?.question);
    start.disabled = busy;
    start.textContent = ready ? '重新开始演练' : '开始文字演练';
    input.disabled = busy || !ready;
    input.placeholder = ready ? '输入对当前问题的回答…' : '等首问生成后即可回答';
    send.disabled = input.disabled || !input.value.trim();
  }

  function renderRehearsal() {
    const session = activeProject.rehearsal;
    input.value = session?.answer || '';
    renderMessages(session?.messages || [{ kind: 'coach-message', text: initialMessage }]);
    $('#rehearsalStatus').textContent = session?.status || '待开始';
    $('#rehearsalError').textContent = session?.error || '';
    $('#feedback').textContent = session?.feedback || initialFeedback;
    updateControls();
  }

  function renderSetup() {
    const setup = activeProject.rehearsalSetup;
    audience.selectedIndex = setup?.audience ?? 0;
    duration.selectedIndex = setup?.duration ?? 0;
    focus.value = setup?.focus || '';
    renderRehearsal();
  }

  function updateModel() {
    const remote = state.provider !== 'ollama';
    const model = remote ? state.apiModel : state.model;
    const source = window.ModelSettings.providerLabel(state.provider);
    $('#rehearsalProvider').textContent = !remote && model === 'rules' ? '请选择对话模型' : `调用 ${source}`;
    $('#rehearsalDestination').textContent = remote
      ? `项目摘要、材料摘录及最近四轮问答会发送至 ${window.ModelSettings.destinationLabel(state.provider)}。`
      : '项目内容与回答由本机 Ollama 处理。';
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

  async function requestTurn(project, session, answer = '') {
    const controller = new AbortController();
    const turns = answer ? [...session.turns, { question: session.question, answer }].slice(-4) : [];
    session.pending = controller;
    session.status = answer ? '正在分析回答…' : '正在生成首问…';
    session.error = '';
    renderRehearsal();
    try {
      const selection = session.selection || await window.ModelSettings.selection();
      if (controller.signal.aborted) return;
      if (!selection.model || (selection.provider === 'ollama' && selection.model === 'rules')) {
        throw new Error('请在模型设置中选择支持文本对话的模型。');
      }
      session.selection = selection;
      const response = await fetch('/api/rehearsal', {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: controller.signal,
        body: JSON.stringify({ ...selection, ...session.context, project: project.name, turns })
      });
      const result = await response.json();
      if (project.rehearsal !== session) return;
      if (!response.ok) throw new Error(result.error || '演练请求失败');
      if (answer) {
        session.messages.push({ kind: 'user-message', text: answer });
        session.answer = '';
        session.feedback = result.feedback;
      } else {
        session.messages = [];
      }
      session.turns = turns;
      session.question = result.question;
      session.messages.push({ kind: 'coach-message', text: result.question, label: answer ? '追问' : '首问' });
      session.status = '演练中';
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
    const session = {
      question: '', answer: '', turns: [], selection: null, pending: null,
      messages: [{ kind: 'coach-message', text: '正在根据当前项目准备首问…' }],
      context: {
        audience: audience.value,
        duration: duration.value,
        focus: focus.value,
        requirements: project.requirements.filter(item => item.status === '已确认').slice(0, 8).map(item => item.detail.slice(0, 160)),
        documents: project.docs.filter(item => item.text?.trim()).slice(0, 3).map(item => ({ name: item.name, text: item.text.slice(0, 450) }))
      }
    };
    project.rehearsal = session;
    return requestTurn(project, session);
  };

  send.onclick = () => {
    const project = activeProject;
    const session = project.rehearsal;
    const answer = input.value.trim();
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
      activeProject.rehearsalSetup = { audience: audience.selectedIndex, duration: duration.selectedIndex, focus: focus.value };
    });
  }
  $('#micButton').onclick = () => alert('语音演练是交互示意。请使用文字演练。');
  window.addEventListener('project-changed', renderSetup);
  window.addEventListener('model-settings-changed', updateModel);
  updateModel();
})();
