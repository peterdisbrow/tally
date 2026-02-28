const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// ─── Markdown loader & parser ────────────────────────────────────────────────

function slugify(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function parseCategoryMap(lines) {
  const categories = [];
  let inBlock = false;
  for (const line of lines) {
    if (line.includes('<!-- CATEGORIES')) { inBlock = true; continue; }
    if (inBlock && line.includes('-->')) { inBlock = false; break; }
    if (inBlock) {
      const match = line.match(/^\d+\.\s+(.+?)\s*\|\s*(.+)$/);
      if (match) {
        categories.push({
          id: slugify(match[1].trim()),
          name: match[1].trim(),
          articleIds: match[2].split(',').map(s => s.trim()),
          articles: [],
        });
      }
    }
  }
  return categories;
}

function classifySection(title) {
  const map = {
    'Who This Is For': 'audience',
    'What You Will Accomplish': 'outcomes',
    'Prerequisites': 'prerequisites',
    'Step-by-Step Setup': 'steps',
    'Validation Checklist': 'checklist',
    'Common Issues and Fixes': 'troubleshooting',
    'Rollback / Fallback': 'rollback',
    'Screenshot Placeholders': 'screenshots',
  };
  return map[title] || 'generic';
}

const SECTION_ICONS = {
  audience: '&#128100;',
  outcomes: '&#127919;',
  prerequisites: '&#128221;',
  steps: '&#128736;',
  checklist: '&#9989;',
  troubleshooting: '&#128295;',
  rollback: '&#128260;',
  screenshots: '&#128247;',
  generic: '&#128196;',
};

const SECTION_LABELS = {
  audience: 'Audience',
  outcomes: 'Goals',
  prerequisites: 'Before You Start',
  steps: 'Setup Steps',
  checklist: 'Verify',
  troubleshooting: 'Troubleshooting',
  rollback: 'Rollback',
  screenshots: 'Screenshots',
  generic: 'Info',
};

function parseArticles(lines) {
  const articles = [];
  let current = null;
  let currentSection = null;

  for (const line of lines) {
    const articleMatch = line.match(/^## (H\d{2}):\s+(.+)$/);
    if (articleMatch) {
      if (current) articles.push(current);
      current = {
        id: articleMatch[1],
        title: articleMatch[2].trim(),
        category: '',
        readTime: '',
        summary: '',
        sections: [],
      };
      currentSection = null;
      continue;
    }
    if (!current) continue;

    // Metadata comments (before first ### section)
    if (!currentSection) {
      const catMatch = line.match(/<!--\s*category:\s*(.+?)\s*-->/);
      if (catMatch) { current.category = catMatch[1].trim(); continue; }
      const timeMatch = line.match(/<!--\s*time:\s*(.+?)\s*-->/);
      if (timeMatch) { current.readTime = timeMatch[1].trim(); continue; }
      const sumMatch = line.match(/<!--\s*summary:\s*(.+?)\s*-->/);
      if (sumMatch) { current.summary = sumMatch[1].trim(); continue; }
    }

    const sectionMatch = line.match(/^### (.+)$/);
    if (sectionMatch) {
      currentSection = {
        id: slugify(current.id + '-' + sectionMatch[1]),
        title: sectionMatch[1].trim(),
        type: classifySection(sectionMatch[1].trim()),
        lines: [],
      };
      current.sections.push(currentSection);
      continue;
    }

    if (currentSection) {
      currentSection.lines.push(line);
    }
  }
  if (current) articles.push(current);
  return articles;
}

function loadAndParseGuides() {
  const mdPath = path.resolve(__dirname, '../docs/how-to-guides.md');
  const raw = fs.readFileSync(mdPath, 'utf-8');
  const lines = raw.split('\n');

  const categories = parseCategoryMap(lines);
  const articles = parseArticles(lines);

  // Link articles to categories
  for (const cat of categories) {
    cat.articles = cat.articleIds.map(id => articles.find(a => a.id === id)).filter(Boolean);
  }

  // Render each section's markdown to HTML
  const renderer = buildRenderer();
  for (const article of articles) {
    for (const section of article.sections) {
      let html = marked(section.lines.join('\n'), { renderer });

      // Post-process step headings: **Step N — label** → numbered circle
      if (section.type === 'steps') {
        html = html.replace(
          /<strong>Step\s+(\d+)\s*[—–\-]+\s*(.+?)<\/strong>/g,
          '<div class="ht-step-heading"><span class="ht-step-number">$1</span><span class="ht-step-label">$2</span></div>'
        );
      }

      section.html = html;
    }
  }

  return { categories, articles };
}

// ─── Custom marked renderer ──────────────────────────────────────────────────

function buildRenderer() {
  const renderer = new marked.Renderer();

  renderer.table = function (token) {
    let header = '';
    for (const cell of token.header) {
      const align = cell.align ? ` style="text-align:${cell.align}"` : '';
      header += `<th${align}>${this.parser.parseInline(cell.tokens)}</th>`;
    }
    let body = '';
    for (const row of token.rows) {
      body += '<tr>';
      for (const cell of row) {
        const align = cell.align ? ` style="text-align:${cell.align}"` : '';
        body += `<td${align}>${this.parser.parseInline(cell.tokens)}</td>`;
      }
      body += '</tr>';
    }
    return `<div class="ht-table-wrap"><table class="ht-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  };

  renderer.code = function ({ text, lang }) {
    const langLabel = lang ? `<span class="ht-code-lang">${lang}</span>` : '';
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    return `<div class="ht-code-block">${langLabel}<button class="ht-copy-btn" onclick="htCopyCode(this)" title="Copy">&#128203;</button><pre><code>${escaped}</code></pre></div>`;
  };

  renderer.codespan = function ({ text }) {
    return `<code class="ht-inline-code">${text}</code>`;
  };

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const id = slugify(text.replace(/<[^>]+>/g, ''));
    return `<h${depth} id="${id}" class="ht-heading ht-h${depth}">${text}</h${depth}>`;
  };

  renderer.blockquote = function ({ tokens }) {
    const body = this.parser.parse(tokens);
    let type = 'info';
    if (body.includes('<strong>Safety')) type = 'warning';
    else if (body.includes('<strong>Implementation Note')) type = 'impl';
    else if (body.includes('<strong>Note')) type = 'info';
    return `<div class="ht-callout ht-callout-${type}">${body}</div>`;
  };

  renderer.list = function (token) {
    const tag = token.ordered ? 'ol' : 'ul';
    let body = '';
    for (const item of token.items) {
      const inner = this.parser.parse(item.tokens);
      // Detect checkbox items: - [ ] or - [x] (marked v14 task list support)
      if (item.task) {
        const checked = item.checked ? ' checked' : '';
        const text = inner.replace(/^<p>/, '').replace(/<\/p>\n?$/, '');
        body += `<li class="ht-checklist-item"><label class="ht-check-label"><input type="checkbox" class="ht-checkbox"${checked} /><span class="ht-check-text">${text}</span></label></li>`;
      } else {
        body += `<li>${inner}</li>`;
      }
    }
    return `<${tag} class="ht-list">${body}</${tag}>`;
  };

  renderer.image = function ({ href, title, text }) {
    if (href && href.startsWith('screenshot:')) {
      const id = href.replace('screenshot:', '');
      return `<div class="ht-screenshot-placeholder"><div class="ht-screenshot-icon">&#128247;</div><div class="ht-screenshot-label">${text || 'Screenshot'}</div><div class="ht-screenshot-id">${id}</div></div>`;
    }
    const t = title ? ` title="${title}"` : '';
    return `<img src="${href}" alt="${text || ''}"${t} class="ht-img" />`;
  };

  renderer.hr = function () {
    return '';
  };

  return renderer;
}

// ─── HTML builder ────────────────────────────────────────────────────────────

function buildHowToHtml(categories, articles) {
  const sidebarHtml = categories.map(cat => `
    <div class="ht-sidebar-category">
      <div class="ht-sidebar-cat-title">${cat.name}</div>
      ${cat.articles.map(a => `
        <a href="#${a.id}" class="ht-sidebar-link" data-article="${a.id}" onclick="htNav('${a.id}')">
          <span class="ht-sidebar-id">${a.id}</span>${a.title}
        </a>
      `).join('')}
    </div>
  `).join('');

  const homeHtml = categories.map(cat => `
    <div class="ht-category-card">
      <div class="ht-cat-header">
        <h2 class="ht-cat-title">${cat.name}</h2>
        <span class="ht-cat-count">${cat.articles.length} guide${cat.articles.length !== 1 ? 's' : ''}</span>
      </div>
      ${cat.articles.map(a => `
        <a class="ht-article-preview" href="#${a.id}" onclick="htNav('${a.id}')">
          <div class="ht-preview-top">
            <span class="ht-preview-id">${a.id}</span>
            <span class="ht-preview-title">${a.title}</span>
          </div>
          <div class="ht-preview-meta">
            ${a.readTime ? `<span class="ht-preview-time">&#128337; ${a.readTime}</span>` : ''}
            <span class="ht-preview-sections">${a.sections.length} sections</span>
          </div>
          ${a.summary ? `<div class="ht-preview-summary">${a.summary}</div>` : ''}
        </a>
      `).join('')}
    </div>
  `).join('');

  const articlesHtml = articles.map(a => `
    <div class="ht-article" data-article="${a.id}" style="display:none">
      <div class="ht-article-header">
        <h1 class="ht-article-title">${a.title}</h1>
        <div class="ht-article-meta">
          <span class="ht-meta-badge">${a.id}</span>
          ${a.readTime ? `<span class="ht-meta-time">&#128337; ${a.readTime}</span>` : ''}
          ${a.category ? `<span class="ht-meta-cat">${a.category}</span>` : ''}
        </div>
      </div>
      <div class="ht-article-nav">
        ${a.sections.map(s => `<a href="#${s.id}" class="ht-article-nav-link ht-nav-${s.type}" onclick="htScrollTo('${s.id}')">${SECTION_ICONS[s.type] || ''} ${SECTION_LABELS[s.type] || s.title}</a>`).join('')}
      </div>
      ${a.sections.map(s => `
        <section id="${s.id}" class="ht-section ht-section-${s.type}" data-section-type="${s.type}">
          <h3 class="ht-section-title"><span class="ht-section-icon">${SECTION_ICONS[s.type] || ''}</span>${s.title}</h3>
          ${s.type === 'checklist' ? '<div class="ht-check-counter">0 of 0 verified</div>' : ''}
          <div class="ht-section-body">${s.html}</div>
        </section>
      `).join('')}
    </div>
  `).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Tally How-To Guides</title>
<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

body {
  font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  background: #09090b;
  color: #f8fafc;
  line-height: 1.6;
  min-height: 100vh;
}

a { color: #22c55e; text-decoration: none; }
a:hover { text-decoration: underline; }

/* ── Layout ── */
.ht-layout {
  min-height: 100vh;
}

/* ── Sidebar ── */
.ht-sidebar {
  position: fixed;
  top: 0; left: 0; bottom: 0;
  width: 280px;
  background: #0F1613;
  border-right: 1px solid #1f3b28;
  overflow-y: auto;
  z-index: 100;
  display: flex;
  flex-direction: column;
}

.ht-sidebar-header {
  padding: 24px 20px 16px;
  border-bottom: 1px solid #1f3b28;
}

.ht-sidebar-logo {
  font-size: 18px;
  font-weight: 700;
  color: #22c55e;
  display: flex;
  align-items: center;
  gap: 8px;
}

.ht-sidebar-logo::before {
  content: '';
  display: inline-block;
  width: 10px; height: 10px;
  background: #22c55e;
  border-radius: 50%;
  box-shadow: 0 0 8px #22c55e;
}

.ht-sidebar-tagline {
  font-size: 12px;
  color: #94a3b8;
  margin-top: 4px;
}

.ht-search-wrap {
  padding: 12px 16px;
}

.ht-search {
  width: 100%;
  padding: 8px 12px;
  background: #09090b;
  border: 1px solid #1f3b28;
  border-radius: 6px;
  color: #f8fafc;
  font-size: 13px;
  outline: none;
}
.ht-search:focus { border-color: #22c55e; }
.ht-search::placeholder { color: #64748b; }

.ht-sidebar-home {
  display: block;
  padding: 10px 20px;
  font-size: 13px;
  font-weight: 600;
  color: #94a3b8;
  border-bottom: 1px solid #1a2e1f;
}
.ht-sidebar-home:hover, .ht-sidebar-home.active { color: #22c55e; text-decoration: none; }

.ht-sidebar-nav {
  flex: 1;
  overflow-y: auto;
  padding-bottom: 20px;
}

.ht-sidebar-category {
  padding: 0;
}

.ht-sidebar-cat-title {
  padding: 14px 20px 6px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  color: #64748b;
}

.ht-sidebar-link {
  display: block;
  padding: 7px 20px 7px 28px;
  font-size: 13px;
  color: #94a3b8;
  text-decoration: none;
  transition: all 0.15s;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ht-sidebar-link:hover { color: #f8fafc; background: rgba(34,197,94,0.06); text-decoration: none; }
.ht-sidebar-link.active { color: #22c55e; background: rgba(34,197,94,0.08); }

.ht-sidebar-id {
  display: inline-block;
  font-size: 10px;
  font-weight: 700;
  font-family: 'SF Mono', 'Fira Code', monospace;
  background: rgba(34,197,94,0.12);
  color: #22c55e;
  padding: 1px 5px;
  border-radius: 3px;
  margin-right: 6px;
}

/* ── Main ── */
.ht-main {
  margin-left: 280px;
  padding: 32px 40px 60px;
  max-width: 1200px;
}

/* ── Breadcrumb ── */
.ht-breadcrumb {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  color: #94a3b8;
  margin-bottom: 20px;
  flex-wrap: wrap;
}
.ht-breadcrumb a { color: #22c55e; }
.ht-breadcrumb-sep { color: #475569; }

/* ── Progress bar ── */
.ht-progress-track {
  position: sticky;
  top: 0;
  z-index: 50;
  height: 3px;
  background: #1a2e1f;
  border-radius: 2px;
  margin-bottom: 24px;
}
.ht-progress-fill {
  height: 100%;
  background: #22c55e;
  border-radius: 2px;
  width: 0%;
  transition: width 0.2s;
}

/* ── Home view ── */
.ht-page-title {
  font-size: 28px;
  font-weight: 800;
  color: #f8fafc;
  margin-bottom: 4px;
}
.ht-page-sub {
  font-size: 15px;
  color: #94a3b8;
  margin-bottom: 28px;
}

.ht-categories-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 16px;
}

.ht-category-card {
  background: #0F1613;
  border: 1px solid #1f3b28;
  border-radius: 12px;
  padding: 20px 22px;
  transition: border-color 0.15s;
}
.ht-category-card:hover { border-color: #22c55e40; }

.ht-cat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 14px;
}
.ht-cat-title {
  font-size: 17px;
  font-weight: 700;
  color: #22c55e;
}
.ht-cat-count {
  font-size: 11px;
  color: #64748b;
  background: rgba(34,197,94,0.08);
  padding: 2px 8px;
  border-radius: 10px;
}

.ht-article-preview {
  display: block;
  padding: 10px 0;
  border-top: 1px solid #1a2e1f;
  text-decoration: none;
  cursor: pointer;
  transition: padding-left 0.15s;
}
.ht-article-preview:hover { padding-left: 6px; text-decoration: none; }

.ht-preview-top { display: flex; align-items: center; gap: 8px; }
.ht-preview-id {
  font-size: 10px;
  font-weight: 700;
  font-family: 'SF Mono', 'Fira Code', monospace;
  background: rgba(34,197,94,0.12);
  color: #22c55e;
  padding: 1px 5px;
  border-radius: 3px;
  flex-shrink: 0;
}
.ht-preview-title { font-size: 14px; font-weight: 500; color: #f8fafc; }
.ht-preview-meta {
  display: flex;
  gap: 12px;
  margin-top: 4px;
  font-size: 12px;
  color: #64748b;
}
.ht-preview-summary {
  margin-top: 4px;
  font-size: 12px;
  color: #94a3b8;
  line-height: 1.4;
}

/* ── Article view ── */
.ht-article-header { margin-bottom: 24px; }
.ht-article-title {
  font-size: 26px;
  font-weight: 800;
  color: #f8fafc;
  line-height: 1.2;
  margin-bottom: 10px;
}
.ht-article-meta {
  display: flex;
  align-items: center;
  gap: 10px;
  flex-wrap: wrap;
}
.ht-meta-badge {
  font-size: 12px;
  font-weight: 700;
  font-family: 'SF Mono', 'Fira Code', monospace;
  background: #22c55e;
  color: #09090b;
  padding: 3px 8px;
  border-radius: 4px;
}
.ht-meta-time { font-size: 13px; color: #94a3b8; }
.ht-meta-cat {
  font-size: 12px;
  color: #94a3b8;
  background: rgba(148,163,184,0.1);
  padding: 2px 10px;
  border-radius: 10px;
  border: 1px solid rgba(148,163,184,0.15);
}

/* ── Article nav (section jump bar) ── */
.ht-article-nav {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  margin-bottom: 28px;
  padding: 12px 0;
  border-bottom: 1px solid #1a2e1f;
}
.ht-article-nav-link {
  font-size: 12px;
  padding: 4px 10px;
  border-radius: 6px;
  background: rgba(15,22,19,0.6);
  border: 1px solid #1a2e1f;
  color: #94a3b8;
  cursor: pointer;
  text-decoration: none;
  transition: all 0.15s;
}
.ht-article-nav-link:hover { border-color: #22c55e; color: #22c55e; text-decoration: none; }

/* ── Sections ── */
.ht-section {
  margin-bottom: 24px;
  padding: 20px 24px;
  background: #0F1613;
  border: 1px solid #1a2e1f;
  border-radius: 10px;
  border-left: 3px solid #1a2e1f;
}
.ht-section-audience  { border-left-color: #94a3b8; }
.ht-section-outcomes  { border-left-color: #22c55e; }
.ht-section-prerequisites { border-left-color: #f59e0b; }
.ht-section-steps     { border-left-color: #22c55e; background: rgba(15,22,19,0.5); }
.ht-section-checklist { border-left-color: #22c55e; }
.ht-section-troubleshooting { border-left-color: #ef4444; }
.ht-section-rollback  { border-left-color: #f59e0b; }
.ht-section-screenshots { border-left-color: #64748b; }

.ht-section-title {
  font-size: 16px;
  font-weight: 700;
  color: #f8fafc;
  margin-bottom: 12px;
  display: flex;
  align-items: center;
  gap: 8px;
}
.ht-section-icon { font-size: 18px; }

.ht-section-body {
  font-size: 14px;
  color: #cbd5e1;
  line-height: 1.7;
}
.ht-section-body p { margin-bottom: 10px; }
.ht-section-audience .ht-section-body { font-style: italic; color: #94a3b8; }

/* ── Step headings ── */
.ht-step-heading {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 20px 0 8px;
}
.ht-step-number {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px; height: 30px;
  border-radius: 50%;
  background: #22c55e;
  color: #09090b;
  font-weight: 700;
  font-size: 13px;
  flex-shrink: 0;
}
.ht-step-label { font-size: 15px; font-weight: 600; color: #f8fafc; }

/* ── Callout boxes ── */
.ht-callout {
  border-left: 3px solid #22c55e;
  padding: 12px 16px;
  margin: 12px 0;
  border-radius: 0 8px 8px 0;
  font-size: 13px;
  line-height: 1.6;
}
.ht-callout p { margin-bottom: 0; }
.ht-callout-info { background: rgba(34,197,94,0.06); border-left-color: #22c55e; }
.ht-callout-warning { background: rgba(245,158,11,0.08); border-left-color: #f59e0b; }
.ht-callout-impl { background: rgba(139,92,246,0.08); border-left-color: #8b5cf6; }

/* ── Code blocks ── */
.ht-code-block {
  position: relative;
  background: #0c0c14;
  border: 1px solid #1a2e1f;
  border-radius: 8px;
  margin: 12px 0;
  overflow: hidden;
}
.ht-code-block pre {
  padding: 14px 16px;
  margin: 0;
  overflow-x: auto;
}
.ht-code-block code {
  font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
  font-size: 13px;
  color: #e2e8f0;
  line-height: 1.5;
}
.ht-code-lang {
  display: inline-block;
  padding: 2px 10px;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  color: #64748b;
  background: rgba(100,116,139,0.1);
  border-bottom: 1px solid #1a2e1f;
  border-right: 1px solid #1a2e1f;
  border-radius: 0 0 6px 0;
}
.ht-copy-btn {
  position: absolute;
  top: 6px; right: 8px;
  background: rgba(15,22,19,0.8);
  border: 1px solid #1a2e1f;
  border-radius: 4px;
  padding: 3px 6px;
  font-size: 13px;
  cursor: pointer;
  color: #94a3b8;
  transition: all 0.15s;
  z-index: 2;
}
.ht-copy-btn:hover { border-color: #22c55e; color: #22c55e; }

.ht-inline-code {
  background: rgba(34,197,94,0.08);
  color: #86efac;
  padding: 1px 6px;
  border-radius: 4px;
  font-family: 'SF Mono', 'Fira Code', monospace;
  font-size: 0.9em;
}

/* ── Tables ── */
.ht-table-wrap { overflow-x: auto; margin: 12px 0; }
.ht-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 13px;
}
.ht-table th {
  text-align: left;
  padding: 8px 12px;
  background: rgba(34,197,94,0.06);
  color: #94a3b8;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.5px;
  border-bottom: 1px solid #1f3b28;
}
.ht-table td {
  padding: 8px 12px;
  border-bottom: 1px solid rgba(26,46,31,0.5);
  color: #cbd5e1;
  vertical-align: top;
}
.ht-table tr:hover td { background: rgba(34,197,94,0.03); }

/* ── Lists ── */
.ht-list { padding-left: 20px; margin: 8px 0; }
.ht-list li { margin-bottom: 4px; }
.ht-section-outcomes .ht-list { list-style: none; padding-left: 0; }
.ht-section-outcomes .ht-list li::before {
  content: '\\2713';
  color: #22c55e;
  font-weight: 700;
  margin-right: 8px;
}

/* ── Checkboxes ── */
.ht-checklist-item { list-style: none; margin-bottom: 6px; }
.ht-check-label {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  cursor: pointer;
}
.ht-checkbox {
  appearance: none;
  -webkit-appearance: none;
  width: 18px; height: 18px;
  border: 2px solid #1f3b28;
  border-radius: 4px;
  background: transparent;
  cursor: pointer;
  flex-shrink: 0;
  margin-top: 2px;
  position: relative;
  transition: all 0.15s;
}
.ht-checkbox:checked {
  background: #22c55e;
  border-color: #22c55e;
}
.ht-checkbox:checked::after {
  content: '\\2713';
  position: absolute;
  color: #09090b;
  font-size: 12px;
  font-weight: 700;
  top: 50%; left: 50%;
  transform: translate(-50%, -50%);
}
.ht-checkbox:checked + .ht-check-text {
  text-decoration: line-through;
  color: #64748b;
}
.ht-check-counter {
  font-size: 12px;
  color: #22c55e;
  margin-bottom: 10px;
  font-weight: 600;
}

/* ── Screenshot placeholders ── */
.ht-screenshot-placeholder {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  background: #111118;
  border: 2px dashed #2a2d3e;
  border-radius: 10px;
  padding: 28px;
  margin: 10px 0;
  min-height: 140px;
  color: #475569;
}
.ht-screenshot-icon { font-size: 32px; margin-bottom: 6px; }
.ht-screenshot-label { font-size: 13px; font-weight: 500; }
.ht-screenshot-id {
  font-size: 10px;
  font-family: 'SF Mono', monospace;
  margin-top: 4px;
  opacity: 0.5;
}

/* ── Hamburger (mobile) ── */
.ht-hamburger {
  display: none;
  position: fixed;
  top: 12px; left: 12px;
  z-index: 200;
  background: #0F1613;
  border: 1px solid #1f3b28;
  border-radius: 6px;
  padding: 8px 10px;
  cursor: pointer;
  color: #f8fafc;
  font-size: 18px;
  line-height: 1;
}
.ht-backdrop {
  display: none;
  position: fixed;
  inset: 0;
  background: rgba(0,0,0,0.6);
  z-index: 90;
}

/* ── Mobile ── */
@media (max-width: 768px) {
  .ht-sidebar { display: none; }
  .ht-sidebar.open { display: flex; }
  .ht-main { margin-left: 0; padding: 20px 16px 60px; padding-top: 56px; }
  .ht-hamburger { display: block; }
  .ht-backdrop.open { display: block; }
  .ht-categories-grid { grid-template-columns: 1fr; }
  .ht-page-title { font-size: 22px; }
  .ht-article-title { font-size: 20px; }
  .ht-section { padding: 16px; }
  .ht-article-nav { gap: 4px; }
  .ht-article-nav-link { font-size: 11px; padding: 3px 7px; }
}
</style>
</head>
<body>

<button class="ht-hamburger" id="htHamburger" onclick="htToggleSidebar()">&#9776;</button>
<div class="ht-backdrop" id="htBackdrop" onclick="htToggleSidebar()"></div>

<div class="ht-layout">
  <aside class="ht-sidebar" id="htSidebar">
    <div class="ht-sidebar-header">
      <div class="ht-sidebar-logo">Tally How-To</div>
      <div class="ht-sidebar-tagline">Step-by-step setup guides</div>
    </div>
    <div class="ht-search-wrap">
      <input type="text" class="ht-search" id="htSearch" placeholder="Search guides..." autocomplete="off" />
    </div>
    <nav class="ht-sidebar-nav">
      <a href="#home" class="ht-sidebar-home" id="htSidebarHome" onclick="htNav('home')">All Guides</a>
      ${sidebarHtml}
    </nav>
  </aside>

  <main class="ht-main">
    <div id="htBreadcrumb" class="ht-breadcrumb" style="display:none">
      <a href="#home" onclick="htNav('home')">Guides</a>
      <span class="ht-breadcrumb-sep">&#8250;</span>
      <span id="htBreadCat"></span>
      <span class="ht-breadcrumb-sep">&#8250;</span>
      <span id="htBreadTitle"></span>
    </div>
    <div id="htProgress" class="ht-progress-track" style="display:none">
      <div id="htProgressFill" class="ht-progress-fill"></div>
    </div>

    <div id="htHomeView">
      <h1 class="ht-page-title">How-To Guides</h1>
      <p class="ht-page-sub">${articles.length} step-by-step guides for your production team</p>
      <div class="ht-categories-grid">
        ${homeHtml}
      </div>
    </div>

    <div id="htArticleView" style="display:none">
      ${articlesHtml}
    </div>
  </main>
</div>

<script>
(function() {
  var currentView = 'home';
  var currentArticleId = null;

  // Article metadata for breadcrumbs
  var articleMeta = {};
  ${articles.map(a => `articleMeta['${a.id}'] = { title: ${JSON.stringify(a.title)}, category: ${JSON.stringify(a.category)} };`).join('\n  ')}

  window.htNav = function(target) {
    if (target === 'home' || !target) {
      location.hash = 'home';
    } else {
      location.hash = target;
    }
    // Close mobile sidebar
    document.getElementById('htSidebar').classList.remove('open');
    document.getElementById('htBackdrop').classList.remove('open');
  };

  window.htScrollTo = function(id) {
    var el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  function showHome() {
    currentView = 'home';
    currentArticleId = null;
    document.getElementById('htHomeView').style.display = '';
    document.getElementById('htArticleView').style.display = 'none';
    document.getElementById('htBreadcrumb').style.display = 'none';
    document.getElementById('htProgress').style.display = 'none';

    // Sidebar state
    document.querySelectorAll('.ht-sidebar-link').forEach(function(l) { l.classList.remove('active'); });
    document.getElementById('htSidebarHome').classList.add('active');
    window.scrollTo({ top: 0 });
  }

  function showArticle(id) {
    var articleEl = document.querySelector('.ht-article[data-article="' + id + '"]');
    if (!articleEl) return;
    currentView = 'article';
    currentArticleId = id;

    document.getElementById('htHomeView').style.display = 'none';
    document.getElementById('htArticleView').style.display = '';

    // Hide all articles, show requested one
    document.querySelectorAll('.ht-article').forEach(function(a) { a.style.display = 'none'; });
    articleEl.style.display = '';

    // Breadcrumb
    var meta = articleMeta[id] || {};
    document.getElementById('htBreadCat').textContent = meta.category || '';
    document.getElementById('htBreadTitle').textContent = id + ': ' + (meta.title || '');
    document.getElementById('htBreadcrumb').style.display = '';
    document.getElementById('htProgress').style.display = '';

    // Sidebar
    document.querySelectorAll('.ht-sidebar-link').forEach(function(l) {
      l.classList.toggle('active', l.dataset.article === id);
    });
    document.getElementById('htSidebarHome').classList.remove('active');

    window.scrollTo({ top: 0 });
    updateProgress();
    updateCheckCounters(articleEl);
  }

  function navigate() {
    var hash = location.hash.replace('#', '').toUpperCase();
    if (!hash || hash === 'HOME') {
      showHome();
    } else {
      showArticle(hash);
    }
  }

  window.addEventListener('hashchange', navigate);
  navigate();

  // ── Progress bar ──
  function updateProgress() {
    if (currentView !== 'article') return;
    var scrollTop = window.scrollY;
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    var progress = docHeight > 0 ? Math.min(100, Math.round((scrollTop / docHeight) * 100)) : 0;
    document.getElementById('htProgressFill').style.width = progress + '%';
  }
  window.addEventListener('scroll', updateProgress);

  // ── Search ──
  document.getElementById('htSearch').addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();

    // Filter sidebar links
    document.querySelectorAll('.ht-sidebar-link').forEach(function(link) {
      var text = link.textContent.toLowerCase();
      link.style.display = (!q || text.includes(q)) ? '' : 'none';
    });

    // Filter sidebar categories (hide if all links hidden)
    document.querySelectorAll('.ht-sidebar-category').forEach(function(cat) {
      var visible = cat.querySelectorAll('.ht-sidebar-link:not([style*="display: none"])');
      cat.style.display = visible.length > 0 || !q ? '' : 'none';
    });

    // Filter home view cards
    if (currentView === 'home') {
      document.querySelectorAll('.ht-article-preview').forEach(function(el) {
        var text = el.textContent.toLowerCase();
        el.style.display = (!q || text.includes(q)) ? '' : 'none';
      });
      document.querySelectorAll('.ht-category-card').forEach(function(card) {
        var visible = card.querySelectorAll('.ht-article-preview:not([style*="display: none"])');
        card.style.display = visible.length > 0 || !q ? '' : 'none';
      });
    }
  });

  // ── Copy to clipboard ──
  window.htCopyCode = function(btn) {
    var code = btn.closest('.ht-code-block').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(function() {
      btn.textContent = '\\u2713 Copied';
      btn.style.color = '#22c55e';
      setTimeout(function() {
        btn.innerHTML = '&#128203;';
        btn.style.color = '';
      }, 2000);
    });
  };

  // ── Checkbox counters ──
  function updateCheckCounters(container) {
    var root = container || document;
    // Collect sections: if root IS a checklist section, use it; otherwise search descendants
    var sections = (root.classList && root.classList.contains('ht-section-checklist'))
      ? [root]
      : Array.from(root.querySelectorAll('.ht-section-checklist'));
    sections.forEach(function(section) {
      var total = section.querySelectorAll('.ht-checkbox').length;
      var checked = section.querySelectorAll('.ht-checkbox:checked').length;
      var counter = section.querySelector('.ht-check-counter');
      if (counter) counter.textContent = checked + ' of ' + total + ' verified';
    });
  }

  document.addEventListener('change', function(e) {
    if (e.target.classList.contains('ht-checkbox')) {
      var section = e.target.closest('.ht-section');
      if (section) updateCheckCounters(section);
    }
  });

  // ── Mobile sidebar ──
  window.htToggleSidebar = function() {
    document.getElementById('htSidebar').classList.toggle('open');
    document.getElementById('htBackdrop').classList.toggle('open');
  };
})();
</script>
</body>
</html>`;
}

// ─── Route setup ─────────────────────────────────────────────────────────────

function setupHowToPortal(app) {
  const { categories, articles } = loadAndParseGuides();
  const html = buildHowToHtml(categories, articles);

  console.log(`[HowTo] Loaded ${articles.length} articles across ${categories.length} categories (${html.length} chars HTML)`);

  // Subdomain middleware — howto.tallyconnect.app
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (host.startsWith('howto.') && req.path === '/') {
      return res.type('html').send(html);
    }
    next();
  });

  app.get('/how-to', (_req, res) => {
    res.type('html').send(html);
  });
}

module.exports = { setupHowToPortal };
