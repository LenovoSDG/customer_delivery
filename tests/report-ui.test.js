const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { JSDOM } = require('jsdom');

function renderer() {
  const dom = new JSDOM('<button id="runReview"></button>', { runScripts: 'outside-only', url: 'http://localhost/' });
  for (const file of ['node_modules/marked/lib/marked.umd.js', 'node_modules/dompurify/dist/purify.min.js', 'report-ui.js']) dom.window.eval(fs.readFileSync(file, 'utf8'));
  return dom.window.ReportUI.markdownHTML;
}

test('renders GFM headings, lists, tables, quotes and code without raw markdown symbols', () => {
  const html = renderer()('## 核验结果\n\n- **操作手册**缺失\n\n| 需求 | 状态 |\n| --- | --- |\n| R-03 | 未找到 |\n\n> 原文证据\n\n```js\nconst a = 1;\n```');
  assert.match(html, /<h2>核验结果<\/h2>/);
  assert.match(html, /<strong>操作手册<\/strong>/);
  assert.match(html, /class="markdown-table"/);
  assert.match(html, /tabindex="0"/);
  assert.match(html, /<blockquote>/);
  assert.match(html, /<pre><code>/);
});

test('blocks script, event handlers, dangerous links, inline styles and remote images', () => {
  const html = renderer()('<script>alert(1)</script>\n\n<img src="https://tracker.invalid/x" onerror="alert(1)">\n\n[坏链接](javascript:alert%281%29)\n\n<a href="https://example.com" onclick="alert(1)" style="display:none">正常链接</a>');
  assert.doesNotMatch(html, /<script|<img|onerror|onclick|javascript:|style=/i);
  assert.match(html, /rel="noopener noreferrer"/);
  assert.match(html, /正常链接/);
});
