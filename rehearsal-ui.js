(() => {
  const el = id => document.getElementById(id);
  const page = el('page-rehearsal'), input = el('answerInput');
  let active = false, paused = false, phase = 'idle', remaining = 300, lastTick = Date.now(), history = [], turns = 0, session = 0, request, draft = '', question = '', context;
  const busy = () => ['preparing','listening','transcribing','sending'].includes(phase);
  function status(text, error = false) { el('voiceStatus').textContent = text; el('voiceStatus').classList.toggle('voice-error', error); }
  function controls() {
    el('micButton').textContent = phase === 'listening' ? '停止录音并转写' : ['preparing','transcribing'].includes(phase) ? '取消语音处理' : active ? '继续录音' : '开始语音演练';
    el('micButton').dataset.recording = phase === 'listening'; el('micButton').disabled = phase === 'sending';
    el('startRehearsal').disabled = busy() || active; el('importAudio').disabled = busy();
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
    session++; active = true; paused = false; remaining = Number(el('duration').value) * 60; lastTick = Date.now(); turns = 0; history = [];
    context = { project: { ...state.project }, requirements: structuredClone(state.requirements), documents: structuredClone(state.docs), rules: el('rules').value, audience: el('audience').value, durationMinutes: Number(el('duration').value), focus: el('rehearsalFocus').value };
    question = `请面向${context.audience}，介绍“${context.project.name}”的进展、交付依据和下一步计划。${context.focus ? '本次重点：' + context.focus : ''}`;
    el('conversation').replaceChildren(); message('assistant', question);
    el('feedback').textContent = '发送回答后，教练会结合已确认需求与可读材料给出本轮反馈。'; controls();
  }
  const speech = new SpeechEngine({
    text(text) { input.value = (draft + (draft && text ? '\n' : '') + text).slice(0,4000); controls(); if (input.value.length >= 4000 && phase === 'listening') stopRecording(); },
    partial(text) { el('voicePartial').textContent = text ? '正在识别：' + text : ''; },
    level(value) { el('voiceLevel').value = value; },
    error(error) { session++; speech.cancel(); phase = 'idle'; status(error.message, true); controls(); }
  });
  function stopSpeech() { window.speechSynthesis?.cancel(); el('readQuestion').textContent = '朗读问题'; }
  function interrupt(reason, end = false) {
    session++; speech.cancel(); request?.abort(); request = null; stopSpeech(); phase = 'idle'; el('voicePartial').textContent = '';
    if (active) paused = true; if (end) { active = false; paused = false; }
    status(reason); controls();
  }
  function audioError(error) {
    speech.cancel(); phase = 'idle'; el('voicePartial').textContent = '';
    const messages = { NotAllowedError: '麦克风权限被拒绝。请在浏览器站点设置中允许麦克风，再重试；也可以导入音频或输入文字。', NotFoundError: '未找到麦克风，请连接设备或导入音频。', NotReadableError: '麦克风被占用或不可用，请关闭其他录音程序后重试。' };
    status(messages[error.name] || (error.name === 'EncodingError' ? '无法解码此音频，请改用 WAV 文件或输入文字' : error.message) || '无法识别此音频，请改用 WAV 文件或输入文字', true); controls();
  }
  async function record() {
    if (phase === 'listening') return stopRecording();
    if (['preparing','transcribing'].includes(phase)) return interrupt('语音处理已取消，已保留确认的转写文字。');
    begin(); stopSpeech(); draft = input.value; phase = 'preparing'; const id = session; controls(); status('正在加载本地中文识别模型，随后请求麦克风权限…');
    try { if (await speech.start() && id === session) { phase = 'listening'; status('正在录音 · 说完后点击停止，再确认文字发送。'); controls(); } }
    catch (error) { if (id === session) audioError(error); }
  }
  async function stopRecording() {
    if (phase !== 'listening') return;
    const id = session; phase = 'transcribing'; controls(); status('录音已停止，正在完成转写…');
    try { await speech.stop(); if (id !== session) return; phase = 'idle'; status(input.value.trim() ? '转写完成。请核对文字，再发送给教练。' : '未识别到讲话，请靠近麦克风重试或直接输入。'); el('voicePartial').textContent = ''; controls(); input.focus(); }
    catch (error) { if (id === session) audioError(error); }
  }
  async function send() {
    if (!active || paused || busy() || !input.value.trim()) return;
    const answer = input.value.trim(), id = session; phase = 'sending'; request = new AbortController(); controls(); stopSpeech(); status('正在生成针对本轮回答的反馈，请稍候…');
    try {
      const selected = await ModelSettings.selection(); if (id !== session) return;
      el('coachModel').textContent = `${selected.provider === 'bohrium' ? 'API' : '本地'} · ${selected.model}`;
      const response = await fetch('/api/rehearsal', { method:'POST', headers:{'content-type':'application/json'}, body: JSON.stringify({ ...context, ...selected, history, answer }), signal: request.signal });
      const result = await response.json(); if (id !== session) return; if (!response.ok) throw new Error(result.error || '教练请求失败');
      if (!result || typeof result.question !== 'string' || !result.question.trim() || typeof result.summary !== 'string' || !['strengths','improvements','evidence','warnings'].every(key => Array.isArray(result[key]))) throw new Error(result?.error || '教练反馈不完整，请重试');
      message('user', answer); history.push({role:'user',content:answer}); question = result.question; message('assistant', question); history.push({role:'assistant',content:question}); input.value = ''; turns++;
      const esc = escapeHtml;
      el('feedback').innerHTML = `<small>第${turns}轮 · ${esc(result.model)} · 已核对材料引用</small><p>${esc(result.summary)}</p><h3>本轮做得好的地方</h3><ul>${result.strengths.map(s=>`<li>${esc(s)}</li>`).join('') || '<li>本轮暂无具体优势建议。</li>'}</ul><h3>下一轮如何改进</h3><ul>${result.improvements.map(s=>`<li>${esc(s)}</li>`).join('') || '<li>继续用材料验证关键结论。</li>'}</ul>${result.evidence.map(e=>`<blockquote>${esc(e.quote)}<br><small>${esc(e.file)} · 第${e.lineStart}行</small></blockquote>`).join('')}${result.warnings.map(w=>`<p>${esc(w)}</p>`).join('')}`;
      phase = 'idle'; status('本轮反馈已生成。可继续录音或输入，回答教练追问。'); controls(); if (el('autoRead').checked) read();
    } catch (error) { if (id === session && error.name !== 'AbortError') { phase = 'idle'; status(`${error.message}。回答已保留，可修改后重试。`, true); controls(); } }
    finally { if (id === session) request = null; }
  }
  const synth = window.speechSynthesis;
  function localVoice() { return synth?.getVoices().find(v => v.localService && /^zh/i.test(v.lang)); }
  function voices() { const supported = !!localVoice(); el('readQuestion').disabled = !supported || !question; el('autoRead').disabled = !supported; el('ttsStatus').textContent = supported ? '问题使用本地中文语音朗读，录音时自动停止。' : '当前浏览器没有本地中文语音，可直接阅读问题。'; }
  function read() {
    if (synth?.speaking) return stopSpeech();
    const voice = localVoice(); if (!voice || !question || busy()) return;
    const utterance = new SpeechSynthesisUtterance(question); utterance.voice = voice; utterance.lang = voice.lang;
    utterance.onend = utterance.onerror = () => { el('readQuestion').textContent = '朗读问题'; }; synth.speak(utterance); el('readQuestion').textContent = '停止朗读';
  }
  el('micButton').onclick = record;
  el('startRehearsal').onclick = () => { begin(); status('文字演练已开始，输入汇报内容后发送。'); voices(); input.focus(); };
  el('pauseRehearsal').onclick = () => { if (paused) { paused = false; lastTick = Date.now(); status('演练已继续，可开始录音或输入。'); controls(); } else interrupt('演练已暂停，麦克风和模型请求已停止。'); };
  el('endRehearsal').onclick = () => interrupt(`演练结束，共完成${turns}轮。已保留对话、反馈与未发送文字。`, true);
  el('sendAnswer').onclick = send; input.oninput = controls;
  input.addEventListener('keydown', event => { if (!event.isComposing && event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); send(); } });
  el('importAudio').onclick = () => el('audioFile').click();
  el('audioFile').onchange = async () => {
    const file = el('audioFile').files[0]; el('audioFile').value = ''; if (!file || busy()) return;
    begin(); stopSpeech(); draft = input.value; phase = 'transcribing'; const id = session; controls(); status('正在本地识别音频，文件不会上传…');
    try { await speech.importFile(file); if (id !== session) return; phase = 'idle'; status('音频转写完成，请核对文字后发送。'); controls(); }
    catch (error) { if (id === session) audioError(error); }
  };
  el('readQuestion').onclick = read; if (synth) synth.addEventListener('voiceschanged', voices); voices();
  setInterval(() => { if (active && !paused) { const elapsed = Math.floor((Date.now() - lastTick)/1000); remaining = Math.max(0,remaining-elapsed); lastTick += elapsed*1000; if (!remaining) interrupt(`练习时间到，共完成${turns}轮。可以修改设置后再次开始。`, true); controls(); voices(); } },1000);
  new MutationObserver(() => { if (!page.classList.contains('active') && active && !paused) interrupt('已离开演练页，练习自动暂停；返回后可继续。'); }).observe(page, {attributes:true,attributeFilter:['class']});
  document.addEventListener('visibilitychange', () => { if (document.hidden && active && !paused) interrupt('页面进入后台，已暂停录音与练习。'); });
  window.addEventListener('pagehide', () => interrupt('演练已停止。',true)); controls();
})();
