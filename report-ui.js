(function () {
  'use strict';
  const escape = text => String(text).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  function markdownHTML(source) {
    if (!window.marked || !window.DOMPurify) return `<pre class="markdown-fallback">${escape(source)}</pre>`;
    const safe = window.DOMPurify.sanitize(window.marked.parse(String(source), { gfm: true, breaks: false }), {
      ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'br', 'hr', 'strong', 'em', 'del', 'ul', 'ol', 'li', 'blockquote', 'pre', 'code', 'a', 'table', 'thead', 'tbody', 'tr', 'th', 'td'],
      ALLOWED_ATTR: ['href', 'title', 'start', 'colspan', 'rowspan'],
      ALLOW_DATA_ATTR: false
    });
    const root = document.createElement('div');
    root.innerHTML = safe;
    root.querySelectorAll('a').forEach(link => {
      const href = link.getAttribute('href') || '';
      if (!/^(https?:|mailto:|#)/i.test(href)) link.removeAttribute('href');
      if (/^https?:/i.test(href)) { link.target = '_blank'; link.rel = 'noopener noreferrer'; }
    });
    root.querySelectorAll('table').forEach(table => {
      const wrapper = document.createElement('div');
      wrapper.className = 'markdown-table';
      wrapper.tabIndex = 0;
      wrapper.setAttribute('role', 'region');
      wrapper.setAttribute('aria-label', '核验结果表格，可横向滚动');
      table.replaceWith(wrapper);
      wrapper.append(table);
    });
    return root.innerHTML;
  }

  async function runReview() {
    page('quality');
    const host = document.querySelector('#report');
    const button = document.querySelector('#runReview');
    if (button.disabled) return;
    const confirmed = state.requirements.filter(r => r.status === '已确认');
    host.classList.remove('empty-state');
    host.classList.add('report-content');
    if (!confirmed.length) {
      host.innerHTML = '<div class="report-message" role="status">请先在“需求与交付清单”中确认至少一条需求，再运行检查。</div>';
      return;
    }
    button.disabled = true;
    button.textContent = '正在逐条核验…';
    host.setAttribute('aria-busy', 'true');
    host.innerHTML = '<div class="report-message" role="status"><b>正在逐条检查需求与材料…</b><p>核对并列要求、材料原文和检查规范。完成后显示每项结论及证据。</p></div>';
    document.querySelector('#qualityModel').textContent = '检查中';
    document.querySelector('#qualityIssues').textContent = '待完成';
    try {
      const selection = window.ModelSettings ? await window.ModelSettings.selection() : { provider: 'ollama', model: state.model };
      const response = await fetch('/api/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selection, requirements: confirmed, documents: state.docs, deliverables: state.deliverables, rules: document.querySelector('#rules').value })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '质检请求失败');
      if (result.report) {
        const summary = result.report.summary;
        const complete = summary.reviewed === summary.total;
        const issues = summary.partial + summary.missing;
        const source = result.provider === 'bohrium' ? '玻尔 API' : '本地模型';
        host.innerHTML = `<div class="report-meta">${source} ${escape(result.model || selection.model)} · ${summary.reviewed}/${summary.total} 项已核验 · ${(result.report.elapsedMs / 1000).toFixed(1)} 秒</div>` +
          (!complete ? '<div class="report-message warning" role="status">部分要求尚未完成模型核验，请查看对应条目的原因后重试。</div>' : '') +
          `<div class="markdown-body">${markdownHTML(result.answer)}</div>`;
        document.querySelector('#qualityIssues').textContent = String(issues);
        document.querySelector('#qualityModel').textContent = complete ? source : '部分未完成';
        state.docs.forEach(d => { d.status = complete && d.text?.trim() ? '已检查' : '待检查'; });
        renderMaterials(); renderProjects();
      } else if (result.mode === 'rules') {
        host.innerHTML = '<div class="report-message warning">规则演示模式：仅作关键词匹配，未运行 AI 核验。</div>' +
          (result.items || []).map(item => `<article class="review-card"><h3>${escape(item.requirement || '')} ${escape(item.title || '')}</h3><p>${escape(item.status)}</p><p>${escape(item.evidence)}</p><p>${escape(item.suggestion)}</p></article>`).join('');
        document.querySelector('#qualityIssues').textContent = '待确认';
        document.querySelector('#qualityModel').textContent = '规则演示';
      } else throw new Error(result.error || '未收到有效质检报告');
    } catch (error) {
      host.innerHTML = `<div class="report-message warning" role="alert"><b>质检未完成</b><p>${escape(error.message)}</p><p>请检查模型设置和服务连接后重试。</p></div>`;
      document.querySelector('#qualityIssues').textContent = '未完成';
      document.querySelector('#qualityModel').textContent = '检查失败';
    } finally {
      button.disabled = false;
      button.textContent = '运行项目检查 →';
      host.setAttribute('aria-busy', 'false');
    }
  }

  window.ReportUI = { markdownHTML, runReview };
  document.querySelector('#runReview').onclick = runReview;
})();
