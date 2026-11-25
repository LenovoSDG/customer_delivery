(function () {
  'use strict';
  const escape = text => String(text ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));

  const STATUS_LABELS = {
    covered: '已覆盖',
    partial: '部分覆盖',
    missing: '未找到',
    uncertain: '待人工确认'
  };

  let statusFilter = 'all';
  let viewMode = 'structured'; // 'structured' | 'markdown'

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
      if (/^https?:/i.test(href)) {
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
      }
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

  function structuredReportHTML(report) {
    const units = report.units || [];
    const summary = report.summary || {};
    const counts = {
      all: units.reduce((acc, u) => acc + (u.checks?.length || 0), 0),
      missing: summary.missing || 0,
      partial: summary.partial || 0,
      uncertain: summary.uncertain || 0,
      covered: summary.covered || 0
    };
    const filterButtons = [
      ['all', `全部检查点 (${counts.all})`],
      ['missing', `未找到 (${counts.missing})`],
      ['partial', `部分覆盖 (${counts.partial})`],
      ['uncertain', `待人工确认 (${counts.uncertain})`],
      ['covered', `已覆盖 (${counts.covered})`]
    ].map(([key, label]) =>
      `<button class="report-filter-chip ${statusFilter === key ? 'active' : ''}" type="button" data-report-filter="${key}">${label}</button>`
    ).join('');

    const cards = units.map(unit => {
      const checks = (unit.checks || []).filter(c => statusFilter === 'all' || c.status === statusFilter);
      if (!checks.length) return '';
      const unitStatus = unit.reviewed ? (STATUS_LABELS[unit.status] || '待核对') : '核验未完成';
      return `
        <article class="audit-unit-card">
          <div class="audit-unit-head">
            <div>
              <span class="req-id">${escape(unit.id)} · ${unit.type === 'rule' ? 'PRD / 汇报规范' : '客户需求'}</span>
              <h3 class="audit-unit-title">${escape(unit.detail)}</h3>
              ${unit.evidence ? `<div class="audit-unit-source">来源：${escape(unit.evidence)}</div>` : ''}
            </div>
            <span class="audit-status-pill ${escape(unit.status || 'uncertain')}">${escape(unitStatus)}</span>
          </div>
          <div class="audit-checks-list">
            ${checks.map(check => `
              <div class="audit-check-item ${escape(check.status)}">
                <div class="audit-check-top">
                  <h4>${escape(check.criterion)}</h4>
                  <span class="audit-status-pill ${escape(check.status)}">${escape(STATUS_LABELS[check.status] || check.status)}</span>
                </div>
                <p class="audit-reason">${escape(check.reason)}</p>
                ${check.evidence?.length ? `
                  <div class="audit-evidence-list">
                    ${check.evidence.map(ev => `
                      <div class="audit-evidence-item">
                        <button class="audit-evidence-loc" type="button" data-cite-file="${escape(ev.file)}" data-cite-start="${Number(ev.lineStart || 1)}" data-cite-end="${Number(ev.lineEnd || ev.lineStart || 1)}">
                          📄 ${escape(ev.file)} · 第 ${ev.lineStart}${ev.lineEnd && ev.lineEnd !== ev.lineStart ? '–' + ev.lineEnd : ''} 行（点击查看原文）
                        </button>
                        <blockquote>${escape(ev.quote)}</blockquote>
                      </div>
                    `).join('')}
                  </div>
                ` : '<div class="muted-hint">材料证据：未找到可核验的原文引用</div>'}
                ${check.status !== 'covered' && check.suggestion ? `
                  <div class="audit-suggestion"><strong>修改建议：</strong>${escape(check.suggestion)}</div>
                ` : ''}
              </div>
            `).join('')}
          </div>
        </article>
      `;
    }).filter(Boolean).join('');

    return `
      <div class="report-filter-bar">${filterButtons}</div>
      <div class="audit-units">${cards || '<div class="report-message">当前筛选状态下没有匹配的检查点，可点击「全部检查点」查看完整结果。</div>'}</div>
    `;
  }

  const initialReport = document.querySelector('#report')?.innerHTML;

  function renderReview() {
    if (typeof activeProject === 'undefined') return;
    const report = activeProject.review;
    const host = document.querySelector('#report');
    const button = document.querySelector('#runReview');
    if (!host || !button) return;

    const hasResult = Boolean(report?.rawAnswer);
    document.querySelector('#toggleReportViewBtn')?.classList.toggle('hidden', !report?.reportData?.units?.length);
    document.querySelector('#copyReportBtn')?.classList.toggle('hidden', !hasResult);
    document.querySelector('#exportReportBtn')?.classList.toggle('hidden', !hasResult);

    const toggleBtn = document.querySelector('#toggleReportViewBtn');
    if (toggleBtn) {
      toggleBtn.textContent = viewMode === 'structured' ? '切换完整报告视图' : '切换结构化证据视图';
    }

    host.classList.toggle('empty-state', !report);
    host.classList.toggle('report-content', Boolean(report));
    host.setAttribute('aria-busy', String(Boolean(report?.pending)));

    if (!report) {
      host.innerHTML = initialReport;
    } else if (report.reportData?.units?.length && viewMode === 'structured') {
      host.innerHTML = (report.metaHtml || '') + structuredReportHTML(report.reportData);
    } else {
      host.innerHTML = report.html || initialReport;
    }

    host.querySelectorAll('[data-report-filter]').forEach(chip => {
      chip.onclick = () => {
        statusFilter = chip.dataset.reportFilter;
        renderReview();
      };
    });

    host.querySelectorAll('[data-cite-file]').forEach(btn => {
      btn.onclick = () => {
        if (typeof window.openMaterialPreview === 'function') {
          window.openMaterialPreview(btn.dataset.citeFile, Number(btn.dataset.citeStart), Number(btn.dataset.citeEnd));
        }
      };
    });

    button.disabled = Boolean(report?.pending);
    button.textContent = report?.pending ? '正在逐条核验…' : '运行项目检查 →';
    const issuesEl = document.querySelector('#qualityIssues');
    const issuesUnitEl = document.querySelector('#qualityIssuesUnit');
    const issuesVal = report?.issues || '待运行';
    if (issuesEl) issuesEl.textContent = issuesVal;
    if (issuesUnitEl) {
      issuesUnitEl.textContent = /^\d+$/.test(String(issuesVal))
        ? '个待补充 / 缺口检查点'
        : report?.pending ? '正在逐条校验原文引用…' : '对照需求、PRD 与规范核查';
    }
    const defaultModel = typeof state !== 'undefined' && state.provider && state.provider !== 'ollama'
      ? window.ModelSettings?.providerLabel(state.provider) : '本地模型';
    const modelEl = document.querySelector('#qualityModel');
    if (modelEl) modelEl.textContent = report?.model || defaultModel;
  }

  async function runReview() {
    if (typeof page === 'function') page('quality');
    const project = activeProject;
    if (project.review?.pending) return;
    const requirements = project.requirements.filter(item => item.status === '已确认');
    if (!requirements.length) {
      project.review = { html: '<div class="report-message" role="status">请先在「确认交付清单」中确认至少一条客户需求，再运行检查。</div>' };
      renderReview();
      return;
    }
    const documents = [...project.docs];
    const deliverables = [...project.deliverables];
    const rules = document.querySelector('#rules')?.value || '';
    project.review = {
      pending: true,
      model: '检查中',
      issues: '待完成',
      html: '<div class="report-message" role="status"><b>正在逐条核验需求、PRD 与交付材料…</b><p>排查覆盖情况、材料完整度、数据口径及汇报逻辑。完成后显示每项结论与原文行号引用。</p></div>'
    };
    renderReview();
    try {
      const selection = window.ModelSettings ? await window.ModelSettings.selection() : { provider: 'ollama', model: state.model };
      const response = await fetch('/api/review', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...selection, requirements, documents, deliverables, rules })
      });
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '质检请求失败');
      if (result.report) {
        const summary = result.report.summary;
        const complete = summary.reviewed === summary.total;
        const source = window.ModelSettings?.providerLabel(result.provider || selection.provider) || '本地模型';
        const metaHtml = `<div class="report-meta">${escape(source)} ${escape(result.model || selection.model)} · ${summary.reviewed}/${summary.total} 项已核验 · ${(result.report.elapsedMs / 1000).toFixed(1)} 秒</div>` +
          (!complete ? '<div class="report-message warning" role="status">部分要求尚未完成模型核验，请查看对应条目的原因后重试。</div>' : '');
        const html = metaHtml + `<div class="markdown-body">${markdownHTML(result.answer)}</div>`;
        project.review = {
          html,
          metaHtml,
          rawAnswer: result.answer,
          reportData: result.report,
          issues: String(summary.partial + summary.missing),
          model: complete ? source : '部分未完成'
        };
        documents.forEach(doc => { doc.status = complete && doc.text?.trim() ? '已检查' : '待检查'; });
        statusFilter = 'all';
        refreshProject(project);
      } else if (result.mode === 'rules') {
        const html = '<div class="report-message warning">规则演示模式：仅作关键词匹配，未运行 AI 核验。</div>' +
          (result.items || []).map(item => `<article class="review-card"><h3>${escape(item.requirement || '')} ${escape(item.title || '')}</h3><p>${escape(item.status)}</p><p>${escape(item.evidence)}</p><p>${escape(item.suggestion)}</p></article>`).join('');
        project.review = { html, issues: '待确认', model: '规则演示' };
      } else {
        throw new Error(result.error || '未收到有效质检报告');
      }
    } catch (error) {
      project.review = {
        html: `<div class="report-message warning" role="alert"><b>质检未完成</b><p>${escape(error.message)}</p><p>请检查模型设置和服务连接后重试。</p></div>`,
        issues: '未完成',
        model: '检查失败'
      };
    } finally {
      if (activeProject === project) renderReview();
    }
  }

  document.querySelector('#toggleReportViewBtn')?.addEventListener('click', () => {
    viewMode = viewMode === 'structured' ? 'markdown' : 'structured';
    renderReview();
  });

  document.querySelector('#copyReportBtn')?.addEventListener('click', async () => {
    const text = activeProject?.review?.rawAnswer;
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      window.showToast?.('已复制完整质检报告到剪贴板', 'success');
    } catch {
      window.showToast?.('当前环境不允许自动复制，可点击「导出 Markdown」保存文件', 'warning');
    }
  });

  document.querySelector('#exportReportBtn')?.addEventListener('click', () => {
    const text = activeProject?.review?.rawAnswer;
    if (!text) return;
    const blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `${activeProject.name || '项目'}-交付质检报告.md`;
    link.click();
    URL.revokeObjectURL(url);
  });

  window.addEventListener('project-changed', renderReview);
  window.ReportUI = { markdownHTML, runReview };
  const runBtn = document.querySelector('#runReview');
  if (runBtn) runBtn.onclick = runReview;
})();
