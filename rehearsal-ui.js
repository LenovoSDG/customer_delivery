(() => {
  const el = id => document.getElementById(id);
  const page = el('page-rehearsal'), input = el('answerInput');
  let active = false, paused = false, phase = 'idle', remaining = 300, lastTick = Date.now(), history = [], turns = 0, session = 0, request, question = '', context;
  let voiceTurn = null, voiceText = '', partialText = '', lastSpeechAt = 0;
  let micOn = false, captureToken = 0, closingUtterance = false, voiceQueue = [], ttsActive = false, timeNotified = false, inFlightTurn = null, resumeMic = false;
  const busy = () => ['preparing','listening','transcribing','sending'].includes(phase);
  function status(text, error = false) { el('voiceStatus').textContent = text; el('voiceStatus').classList.toggle('voice-error', error); }
  function controls() {
    el('micButton').textContent = micOn ? '停止录音' : phase === 'preparing' ? '取消语音准备' : active ? '开启连续录音' : '开始语音演练';
    el('micButton').dataset.recording = micOn; el('micButton').disabled = false;
    el('finishVoiceTurn').disabled = !micOn || closingUtterance || !voiceAnswer();
    el('startRehearsal').disabled = busy() || active; el('importAudio').disabled = busy() || micOn;
    el('sendAnswer').disabled = !active || paused || busy() || !input.value.trim(); input.readOnly = ['preparing','listening','transcribing','sending'].includes(phase);
    for (const id of ['audience','duration','rehearsalFocus']) el(id).disabled = active;
    el('pauseRehearsal').disabled = !active; el('endRehearsal').disabled = !active;
    el('pauseRehearsal').textContent = paused ? '继续演练' : '暂停';
    document.querySelector('#page-rehearsal .coach-live').textContent = !active ? turns ? '已结束' : '待开始' : paused ? '已暂停' : phase === 'sending' ? '教练思考中' : '演练中';
    el('answerCount').textContent = input.value.length;
    el('rehearsalClock').textContent = `${String(Math.floor(remaining / 60)).padStart(2,'0')}:${String(remaining % 60).padStart(2,'0')}`;
  }
  function message(role, text) { const node = document.createElement('div'); node.className = role === 'user' ? 'user-message' : 'coach-message'; node.textContent = text; el('conversation').append(node); el('conversation').scrollTop = el('conversation').scrollHeight; }
  function begin() {
    if (active) { paused = false; lastTick = Date.now(); controls(); return; }
    session++; active = true; paused = false; remaining = Number(el('duration').value) * 60; lastTick = Date.now(); turns = 0; history = []; timeNotified = false; voiceTurn = null; voiceText = partialText = '';
    context = { project: { ...state.project }, requirements: structuredClone(state.requirements), documents: structuredClone(state.docs), rules: el('rules').value, audience: el('audience').value, durationMinutes: Number(el('duration').value), focus: el('rehearsalFocus').value };
    question = `请面向${context.audience}，介绍“${context.project.name}”的进展、交付依据和下一步计划。${context.focus ? '本次重点：' + context.focus : ''}`;
    el('conversation').replaceChildren(); message('assistant', question);
    el('feedback').textContent = '发送回答后，教练会结合已确认需求与可读材料给出本轮反馈。'; controls();
  }
  function voiceAnswer() { return (voiceText + (voiceText && partialText ? '，' : '') + partialText).slice(0,4000).trim(); }
  function showVoice() {
    const answer = voiceAnswer();
    if (!answer) { if (voiceTurn) { voiceTurn.answer = ''; voiceTurn.body.textContent = '正在听…'; } return; }
    if (!voiceTurn) {
      const node = document.createElement('div'); node.className = 'user-message voice-message';
      const body = document.createElement('span'), meta = document.createElement('small'), button = document.createElement('button');
      button.className = 'text-button'; button.hidden = true; node.append(body, meta, button); el('conversation').append(node);
      voiceTurn = { node, body, meta, button, context, answer: '', state: 'live' };
    }
    voiceTurn.answer = answer; voiceTurn.body.textContent = answer; voiceTurn.meta.textContent = '正在听 · 停顿约1秒后教练自动回复';
    el('conversation').scrollTop = el('conversation').scrollHeight; controls();
  }
  function markVoice(turn, label, retry = false) {
    if (!turn) return;
    turn.state = retry ? 'pending' : 'sent'; turn.meta.textContent = label; turn.button.hidden = !retry;
    turn.button.textContent = '让教练回复这段话';
    turn.button.onclick = () => {
      if (!active || paused || phase === 'sending' || closingUtterance || context !== turn.context) return status('请先继续当前演练，再重试这段发言。', true);
      send(turn);
    };
  }
  const speech = new SpeechEngine({
    text(text) { voiceText = text; partialText = ''; lastSpeechAt = Date.now(); showVoice(); if (voiceAnswer().length >= 4000 && micOn) finishVoiceTurn(); },
    partial(text) { if (text !== partialText && text) lastSpeechAt = Date.now(); partialText = text; showVoice(); },
    level(value) { el('voiceLevel').value = value; if (micOn && !ttsActive && value > 0.12) lastSpeechAt = Date.now(); },
    boundary() {
      if (voiceTurn?.answer) { voiceTurn.state = 'queued'; voiceTurn.meta.textContent = '发言已完成 · 等待教练回复'; voiceQueue.push(voiceTurn); }
      voiceTurn = null; voiceText = partialText = ''; lastSpeechAt = Date.now();
    },
    error(error) { audioError(error); }
  });
  // Only the current bubble streams word by word. One complete utterance makes one model request.
  setInterval(() => {
    if (micOn && !ttsActive && !closingUtterance && voiceAnswer() && Date.now() - lastSpeechAt >= 1100) finishVoiceTurn();
  }, 250);
  function stopSpeech() { ttsActive = false; speech.setMuted(false); window.speechSynthesis?.cancel(); el('readQuestion').textContent = '朗读问题'; }
  function interrupt(reason, end = false) {
    resumeMic = !end && micOn; session++; if (inFlightTurn) markVoice(inFlightTurn, '回复已停止 · 发言已保留，可重试', true); inFlightTurn = null; micOn = false; captureToken++; closingUtterance = false; for (const queued of voiceQueue) markVoice(queued, '已暂停 · 发言已保留，尚未回复', true); voiceQueue = []; if (voiceTurn && voiceTurn.state !== 'sent') markVoice(voiceTurn, '已暂停 · 发言已保留，尚未完成回复', true); speech.cancel(); request?.abort(); request = null; stopSpeech(); phase = 'idle'; el('voicePartial').textContent = '';
    if (active) paused = true; if (end) { active = false; paused = false; }
    status(reason); controls();
  }
  function audioError(error) {
    micOn = false; captureToken++; closingUtterance = false; speech.cancel(); if (phase !== 'sending') phase = 'idle'; el('voicePartial').textContent = ''; markVoice(voiceTurn, '未完成回复 · 发言已保留', true);
    const messages = { NotAllowedError: '麦克风权限被拒绝。请在浏览器站点设置中允许麦克风，再重试；也可以导入音频或输入文字。', NotFoundError: '未找到麦克风，请连接设备或导入音频。', NotReadableError: '麦克风被占用或不可用，请关闭其他录音程序后重试。' };
    status(messages[error.name] || (error.name === 'EncodingError' ? '无法解码此音频，请改用 WAV 文件或输入文字' : error.message) || '无法识别此音频，请改用 WAV 文件或输入文字', true); controls();
  }
  function stopMicrophone() {
    resumeMic = false; micOn = false; captureToken++; closingUtterance = false; speech.cancel(); stopSpeech();
    if (voiceTurn?.answer) markVoice(voiceTurn, '录音已停止 · 发言已保留，尚未发送', true);
    voiceTurn = null; voiceText = partialText = '';
    if (phase !== 'sending') phase = 'idle';
    status('麦克风已关闭。需要继续时可重新开启连续录音。'); controls();
  }
  async function record() {
    if (micOn || phase === 'preparing') return stopMicrophone();
    if (phase === 'transcribing' || phase === 'sending') return status('请等当前音频或回复完成后再开启录音。');
    begin(); stopSpeech(); voiceTurn = null; voiceText = partialText = ''; lastSpeechAt = Date.now(); phase = 'preparing'; const id = session, token = ++captureToken; controls(); status('正在加载本地中文识别模型，随后请求麦克风权限…');
    try { if (await speech.start() && id === session && token === captureToken) { micOn = true; phase = 'listening'; status('麦克风持续开启 · 停顿约1秒后自动回复，回复后直接接着说。'); controls(); } }
    catch (error) { if (id === session && token === captureToken) audioError(error); }
  }
  function pumpVoiceQueue() {
    if (active && !paused && !request && !closingUtterance && phase !== 'sending' && voiceQueue.length) send(voiceQueue.shift());
  }
  async function finishVoiceTurn() {
    if (!micOn || closingUtterance || ttsActive) return;
    const id = session, token = captureToken; closingUtterance = true;
    if (phase !== 'sending') phase = 'transcribing'; controls();
    try {
      await speech.finishUtterance();
      if (id !== session || token !== captureToken) return;
      closingUtterance = false; if (phase !== 'sending') phase = 'listening'; controls(); pumpVoiceQueue();
    } catch (error) { if (id === session && token === captureToken) audioError(error); }
  }
  async function send(turn = null) {
    const answer = turn ? turn.answer : input.value.trim();
    if (!active || paused || ['preparing','transcribing','sending'].includes(phase) || !answer || (micOn && !turn)) return;
    inFlightTurn = turn;
    if (turn) { turn.state = 'sending'; turn.meta.textContent = '已发送 · 教练正在回复'; turn.button.hidden = true; }
    const id = session; phase = 'sending'; request = new AbortController(); controls(); stopSpeech(); status(micOn ? '麦克风持续开启 · 教练正在回复，你可以继续补充。' : '教练正在回复…');
    try {
      const selected = await ModelSettings.selection(); if (id !== session) return;
      el('coachModel').textContent = `${selected.provider === 'bohrium' ? 'API' : '本地'} · ${selected.model}`;
      const response = await fetch('/api/rehearsal', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ ...context, ...selected, history, answer }), signal: request.signal });
      const result = await response.json(); if (id !== session) return; if (!response.ok) throw new Error(result.error || '教练请求失败');
      if (!result || typeof result.question !== 'string' || !result.question.trim() || typeof result.summary !== 'string' || !['strengths','improvements','evidence','warnings'].every(key => Array.isArray(result[key]))) throw new Error(result?.error || '教练反馈不完整，请重试');
      if (turn) markVoice(turn, '已发送'); else message('user', answer); history.push({role:'user',content:answer}); question = result.question; message('assistant', question); history.push({role:'assistant',content:question}); if (!turn) input.value = ''; turns++;
      const esc = escapeHtml;
      el('feedback').innerHTML = `<small>第${turns}轮 · ${esc(result.model)}${result.elapsedMs ? ' · 回复用时' + (result.elapsedMs / 1000).toFixed(1) + '秒' : ''} · 已核对材料引用</small><p>${esc(result.summary)}</p><h3>本轮做得好的地方</h3><ul>${result.strengths.map(s=>`<li>${esc(s)}</li>`).join('') || '<li>本轮暂无具体优势建议。</li>'}</ul><h3>下一轮如何改进</h3><ul>${result.improvements.map(s=>`<li>${esc(s)}</li>`).join('') || '<li>继续用材料验证关键结论。</li>'}</ul>${result.evidence.map(e=>`<blockquote>${esc(e.quote)}<br><small>${esc(e.file)} · 第${e.lineStart}行</small></blockquote>`).join('')}${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}`;
      phase = micOn ? 'listening' : 'idle'; status(micOn ? '麦克风持续开启 · 可以直接回答下一问，无需点击录音。' : '本轮反馈已生成，可输入回答或开启连续录音。'); controls(); if (el('autoRead').checked && !voiceAnswer() && !voiceQueue.length) read();
    } catch (error) { if (id === session && error.name !== 'AbortError') { phase = micOn ? 'listening' : 'idle'; if (turn) markVoice(turn, '回复失败 · 发言已保留，可重试', true); status(`${error.message}。回答已保留，可重试。`, true); controls(); } }
    finally { if (id === session) { request = null; inFlightTurn = null; pumpVoiceQueue(); } }
  }
  const synth = window.speechSynthesis;
  function localVoice() { return synth?.getVoices().find(v => v.localService && /^zh/i.test(v.lang)); }
  function voices() { const supported = !!localVoice(); el('readQuestion').disabled = !supported || !question; el('autoRead').disabled = !supported; el('ttsStatus').textContent = supported ? '本地朗读时麦克风保持开启，朗读结束后自动继续听。' : '当前浏览器没有本地中文语音，可直接阅读问题。'; }
  function read() {
    if (synth?.speaking) return stopSpeech();
    const voice = localVoice(); if (!voice || !question || ['preparing','transcribing','sending'].includes(phase) || voiceAnswer() || voiceQueue.length) return;
    const utterance = new SpeechSynthesisUtterance(question); utterance.voice = voice; utterance.lang = voice.lang;
    ttsActive = true; speech.setMuted(true);
    utterance.onend = utterance.onerror = () => { ttsActive = false; speech.setMuted(false); lastSpeechAt = Date.now(); el('readQuestion').textContent = '朗读问题'; }; synth.speak(utterance); el('readQuestion').textContent = '停止朗读';
  }
  el('micButton').onclick = record; el('finishVoiceTurn').onclick = finishVoiceTurn;
  el('startRehearsal').onclick = () => { begin(); status('文字演练已开始，输入汇报内容后发送。'); voices(); input.focus(); };
  el('pauseRehearsal').onclick = () => { if (paused) { paused = false; lastTick = Date.now(); if (resumeMic) { resumeMic = false; record(); } else { status('演练已继续，可开始录音或输入。'); controls(); } } else interrupt('演练已暂停，麦克风和模型请求已停止。'); };
  el('endRehearsal').onclick = () => interrupt(`演练结束，共完成${turns}轮。已保留对话、反馈与未发送文字。`, true);
  el('sendAnswer').onclick = () => send(); input.oninput = controls;
  input.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } });
  el('importAudio').onclick = () => el('audioFile').click();
  el('audioFile').onchange = async () => {
    const file = el('audioFile').files[0]; el('audioFile').value = ''; if (!file || busy()) return;
    begin(); stopSpeech(); voiceTurn = null; voiceText = partialText = ''; phase = 'transcribing'; const id = session; controls(); status('正在本地处理音频，发言将直接显示在对话中…');
    try { await speech.importFile(file); if (id !== session) return; phase = 'idle'; controls(); if (voiceTurn?.answer) await send(voiceTurn); else status('没有识别到讲话，请换一段音频重试。'); }
    catch (error) { if (id === session) audioError(error); }
  };
  el('readQuestion').onclick = read; if (synth) synth.addEventListener('voiceschanged', voices); voices();
  setInterval(() => { if (active && !paused) { const elapsed = Math.floor((Date.now() - lastTick)/1000); remaining = Math.max(0,remaining-elapsed); lastTick += elapsed*1000; if (!remaining && !timeNotified) { timeNotified = true; status(micOn ? '练习时间已到，麦克风仍开启。可继续演练或主动停止录音。' : '练习时间已到，可继续回答或结束演练。'); } controls(); voices(); } },1000);
  new MutationObserver(() => { if (!page.classList.contains('active') && active && !paused) interrupt('已离开演练页，练习自动暂停；返回后可继续。'); }).observe(page, {attributes:true,attributeFilter:['class']});
  window.addEventListener('pagehide', () => interrupt('演练已停止。',true)); controls();
})();
