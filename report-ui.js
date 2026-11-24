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

  const initialReport = document.querySelector('#report')?.innerHTML;

  function renderReview() {
    const report = activeProject.review;
    const host = document.querySelector('#report');
    const button = document.querySelector('#runReview');
    host.classList.toggle('empty-state', !report);
    host.classList.toggle('report-content', Boolean(report));
    host.setAttribute('aria-busy', String(Boolean(report?.pending)));
    host.innerHTML = report?.html || initialReport;
    button.disabled = Boolean(report?.pending);
    button.textContent = report?.pending ? '正在逐条核验…' : '运行项目检查 →';
    document.querySelector('#qualityIssues').textContent = report?.issues || '待运行';
    const defaultModel = state.provider && state.provider !== 'ollama'
      ? window.ModelSettings?.providerLabel(state.provider) : '本地模型';
    document.querySelector('#qualityModel').textContent = report?.model || defaultModel;
  }

  async function runReview() {
    page('quality');
    const project = activeProject;
    if (project.review?.pending) return;
    const requirements = project.requirements.filter(item => item.status === '已确认');
    if (!requirements.length) {
      project.review = { html: '<div class="report-message" role="status">请先在“需求与交付清单”中确认至少一条需求，再运行检查。</div>' };
      renderReview();
      return;
    }
    const documents = [...project.docs];
    const deliverables = [...project.deliverables];
    const rules = document.querySelector('#rules').value;
    project.review = {
      pending: true, model: '检查中', issues: '待完成',
      html: '<div class="report-message" role="status"><b>正在逐条检查需求与材料…</b><p>核对并列要求、材料原文和检查规范。完成后显示每项结论及证据。</p></div>'
    };
    renderReview();
    try {
      const selection = window.ModelSettings ? await window.ModelSettings.selection() : { provider: 'ollama', model: state.model };
      const response = await fetch('/api/review', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selection, requirements, documents, deliverables, rules })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '质检请求失败');
      if (result.report) {
        const summary = result.report.summary;
        const complete = summary.reviewed === summary.total;
        const source = window.ModelSettings?.providerLabel(result.provider || selection.provider) || '本地模型';
        const html = `<div class="report-meta">${escape(source)} ${escape(result.model || selection.model)} · ${summary.reviewed}/${summary.total} 项已核验 · ${(result.report.elapsedMs / 1000).toFixed(1)} 秒</div>` +
          (!complete ? '<div class="report-message warning" role="status">部分要求尚未完成模型核验，请查看对应条目的原因后重试。</div>' : '') +
          `<div class="markdown-body">${markdownHTML(result.answer)}</div>`;
        project.review = { html, issues: String(summary.partial + summary.missing), model: complete ? source : '部分未完成' };
        documents.forEach(doc => { doc.status = complete && doc.text?.trim() ? '已检查' : '待检查'; });
        refreshProject(project);
      } else if (result.mode === 'rules') {
        const html = '<div class="report-message warning">规则演示模式：仅作关键词匹配，未运行 AI 核验。</div>' +
          (result.items || []).map(item => `<article class="review-card"><h3>${escape(item.requirement || '')} ${escape(item.title || '')}</h3><p>${escape(item.status)}</p><p>${escape(item.evidence)}</p><p>${escape(item.suggestion)}</p></article>`).join('');
        project.review = { html, issues: '待确认', model: '规则演示' };
      } else throw new Error(result.error || '未收到有效质检报告');
    } catch (error) {
      project.review = {
        html: `<div class="report-message warning" role="alert"><b>质检未完成</b><p>${escape(error.message)}</p><p>请检查模型设置和服务连接后重试。</p></div>`,
        issues: '未完成', model: '检查失败'
      };
    } finally {
      if (activeProject === project) renderReview();
    }
  }

  window.addEventListener('project-changed', renderReview);
  window.ReportUI = { markdownHTML, runReview };
  document.querySelector('#runReview').onclick = runReview;
})();
