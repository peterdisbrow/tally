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
    'Quick Start': 'quickstart',
    'Advanced Details': 'advanced',
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
  quickstart: '&#9889;',
  advanced: '&#128272;',
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
  quickstart: 'Quick Start',
  advanced: 'Advanced Details',
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

// ── Related-article graph (2-4 related IDs per article) ──
const RELATED_GUIDES = {
  H01: ['H02', 'H03', 'H04'],
  H02: ['H01', 'H03', 'H04'],
  H03: ['H01', 'H02', 'H04'],
  H04: ['H03', 'H05', 'H08', 'H09'],
  H05: ['H04', 'H12', 'H06', 'H07'],
  H06: ['H07', 'H08', 'H10', 'H13'],
  H07: ['H06', 'H05', 'H11'],
  H08: ['H06', 'H04', 'H09'],
  H09: ['H04', 'H08', 'H12'],
  H10: ['H06', 'H11', 'H05'],
  H11: ['H06', 'H10', 'H05'],
  H12: ['H05', 'H14', 'H15'],
  H13: ['H06', 'H12', 'H15'],
  H14: ['H12', 'H15', 'H13'],
  H15: ['H14', 'H12', 'H13'],
};

// ── Category slug lookup ──
const CATEGORY_SLUGS = {
  'Getting Started': 'getting-started',
  'Equipment Integrations': 'equipment-integrations',
  'Automation and Companion': 'automation-and-companion',
  'Troubleshooting': 'troubleshooting',
  'Operations': 'operations',
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
        slug: slugify(articleMatch[2].trim()),
        category: '',
        readTime: '',
        summary: '',
        difficulty: '',
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
      const diffMatch = line.match(/<!--\s*difficulty:\s*(.+?)\s*-->/);
      if (diffMatch) { current.difficulty = diffMatch[1].trim(); continue; }
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

// ─── SEO helpers ─────────────────────────────────────────────────────────────

/** Extract FAQ items from troubleshooting tables (Symptom | Cause | Fix) */
function extractFaqItems(article) {
  const faqs = [];
  for (const section of article.sections) {
    if (section.type !== 'troubleshooting') continue;
    const rowRegex = /<tr>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<td[^>]*>(.*?)<\/td>\s*<\/tr>/gs;
    let match;
    while ((match = rowRegex.exec(section.html)) !== null) {
      const symptom = match[1].replace(/<[^>]+>/g, '').trim();
      const cause = match[2].replace(/<[^>]+>/g, '').trim();
      const fix = match[3].replace(/<[^>]+>/g, '').trim();
      if (symptom && fix) {
        faqs.push({ question: symptom, answer: `${cause}. ${fix}` });
      }
    }
  }
  return faqs;
}

/** Build TOC entries from article sections */
function buildTocItems(article) {
  return article.sections.map(s => ({
    id: s.id,
    icon: SECTION_ICONS[s.type] || '',
    label: SECTION_LABELS[s.type] || s.title,
  }));
}

/** Get previous/next articles within the same category */
function getPrevNext(article, categories) {
  const cat = categories.find(c => c.articles.some(a => a.id === article.id));
  if (!cat) return { prev: null, next: null };
  const idx = cat.articles.findIndex(a => a.id === article.id);
  return {
    prev: idx > 0 ? cat.articles[idx - 1] : null,
    next: idx < cat.articles.length - 1 ? cat.articles[idx + 1] : null,
  };
}

/** Extract HowToStep items with text from steps sections */
function extractSteps(article) {
  const steps = [];
  for (const s of article.sections) {
    if (s.type !== 'steps') continue;
    const parts = s.html.split(/<div class="ht-step-heading">/);
    for (let i = 1; i < parts.length; i++) {
      const nameMatch = parts[i].match(/<span class="ht-step-label">(.+?)<\/span>/);
      if (!nameMatch) continue;
      const afterHeading = parts[i].replace(/.*?<\/div>/, '');
      const textContent = afterHeading.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
      steps.push({
        '@type': 'HowToStep',
        position: steps.length + 1,
        name: nameMatch[1],
        text: textContent || nameMatch[1],
      });
    }
  }
  return steps;
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

// ─── Shared CSS ──────────────────────────────────────────────────────────────

const CSS_BLOCK = `
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
.ht-layout { min-height: 100vh; }

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
.ht-sidebar-header { padding: 24px 20px 16px; border-bottom: 1px solid #1f3b28; }
.ht-sidebar-logo {
  font-size: 18px; font-weight: 700; color: #22c55e;
  display: flex; align-items: center; gap: 8px;
}
.ht-sidebar-logo::before {
  content: ''; display: inline-block;
  width: 10px; height: 10px; background: #22c55e;
  border-radius: 50%; box-shadow: 0 0 8px #22c55e;
}
.ht-sidebar-tagline { font-size: 12px; color: #94a3b8; margin-top: 4px; }
.ht-search-wrap { padding: 12px 16px; }
.ht-search {
  width: 100%; padding: 8px 12px; background: #09090b;
  border: 1px solid #1f3b28; border-radius: 6px;
  color: #f8fafc; font-size: 13px; outline: none;
}
.ht-search:focus { border-color: #22c55e; }
.ht-search::placeholder { color: #64748b; }
.ht-sidebar-home {
  display: block; padding: 10px 20px; font-size: 13px;
  font-weight: 600; color: #94a3b8; border-bottom: 1px solid #1a2e1f;
}
.ht-sidebar-home:hover, .ht-sidebar-home.active { color: #22c55e; text-decoration: none; }
.ht-sidebar-nav { flex: 1; overflow-y: auto; padding-bottom: 20px; }
.ht-sidebar-category { padding: 0; }
.ht-sidebar-cat-title {
  padding: 14px 20px 6px; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.5px; color: #64748b;
}
.ht-sidebar-link {
  display: block; padding: 7px 20px 7px 28px; font-size: 13px;
  color: #94a3b8; text-decoration: none; transition: all 0.15s;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.ht-sidebar-link:hover { color: #f8fafc; background: rgba(34,197,94,0.06); text-decoration: none; }
.ht-sidebar-link.active { color: #22c55e; background: rgba(34,197,94,0.08); }
/* ── Main ── */
.ht-main { margin-left: 280px; padding: 32px 40px 60px; max-width: 1200px; }

/* ── Breadcrumb ── */
.ht-breadcrumb {
  display: flex; align-items: center; gap: 8px;
  font-size: 13px; color: #94a3b8; margin-bottom: 20px; flex-wrap: wrap;
}
.ht-breadcrumb a { color: #22c55e; }
.ht-breadcrumb-sep { color: #475569; }

/* ── Progress bar ── */
.ht-progress-track {
  position: sticky; top: 0; z-index: 50;
  height: 3px; background: #1a2e1f; border-radius: 2px; margin-bottom: 24px;
}
.ht-progress-fill { height: 100%; background: #22c55e; border-radius: 2px; width: 0%; transition: width 0.2s; }

/* ── Home view ── */
.ht-page-title { font-size: 28px; font-weight: 800; color: #f8fafc; margin-bottom: 4px; }
.ht-page-sub { font-size: 15px; color: #94a3b8; margin-bottom: 28px; }
.ht-categories-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; }
.ht-category-card {
  background: #0F1613; border: 1px solid #1f3b28;
  border-radius: 12px; padding: 20px 22px; transition: border-color 0.15s;
}
.ht-category-card:hover { border-color: #22c55e40; }
.ht-cat-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 14px; }
.ht-cat-title { font-size: 17px; font-weight: 700; color: #22c55e; }
.ht-cat-title a { color: inherit; text-decoration: none; }
.ht-cat-title a:hover { text-decoration: underline; }
.ht-cat-count {
  font-size: 11px; color: #64748b; background: rgba(34,197,94,0.08);
  padding: 2px 8px; border-radius: 10px;
}
.ht-article-preview {
  display: block; padding: 10px 0; border-top: 1px solid #1a2e1f;
  text-decoration: none; cursor: pointer; transition: padding-left 0.15s;
}
.ht-article-preview:hover { padding-left: 6px; text-decoration: none; }
.ht-preview-top { display: flex; align-items: center; gap: 8px; }
.ht-preview-title { font-size: 14px; font-weight: 500; color: #f8fafc; }
.ht-preview-meta { display: flex; gap: 12px; margin-top: 4px; font-size: 12px; color: #64748b; }
.ht-preview-summary { margin-top: 4px; font-size: 12px; color: #94a3b8; line-height: 1.4; }

/* ── Article view ── */
.ht-article-header { margin-bottom: 24px; }
.ht-article-title { font-size: 26px; font-weight: 800; color: #f8fafc; line-height: 1.2; margin-bottom: 10px; }
.ht-article-meta { display: flex; align-items: center; gap: 10px; flex-wrap: wrap; }
.ht-meta-time { font-size: 13px; color: #94a3b8; }
.ht-meta-cat {
  font-size: 12px; color: #94a3b8;
  background: rgba(148,163,184,0.1); padding: 2px 10px;
  border-radius: 10px; border: 1px solid rgba(148,163,184,0.15);
}
.ht-article-nav { display: flex; flex-wrap: wrap; gap: 6px; margin-bottom: 28px; padding: 12px 0; border-bottom: 1px solid #1a2e1f; }
.ht-article-nav-link {
  font-size: 12px; padding: 4px 10px; border-radius: 6px;
  background: rgba(15,22,19,0.6); border: 1px solid #1a2e1f;
  color: #94a3b8; cursor: pointer; text-decoration: none; transition: all 0.15s;
}
.ht-article-nav-link:hover { border-color: #22c55e; color: #22c55e; text-decoration: none; }

/* ── Sections ── */
.ht-section {
  margin-bottom: 24px; padding: 20px 24px; background: #0F1613;
  border: 1px solid #1a2e1f; border-radius: 10px; border-left: 3px solid #1a2e1f;
}
.ht-section-audience  { border-left-color: #94a3b8; }
.ht-section-outcomes  { border-left-color: #22c55e; }
.ht-section-prerequisites { border-left-color: #f59e0b; }
.ht-section-steps     { border-left-color: #22c55e; background: rgba(15,22,19,0.5); }
.ht-section-checklist { border-left-color: #22c55e; }
.ht-section-troubleshooting { border-left-color: #ef4444; }
.ht-section-rollback  { border-left-color: #f59e0b; }
.ht-section-screenshots { border-left-color: #64748b; }
.ht-section-title { font-size: 18px; font-weight: 700; color: #f8fafc; margin-bottom: 12px; display: flex; align-items: center; gap: 8px; }
.ht-section-icon { font-size: 18px; }
.ht-section-body { font-size: 14px; color: #cbd5e1; line-height: 1.7; }
.ht-section-body p { margin-bottom: 10px; }
.ht-section-audience .ht-section-body { font-style: italic; color: #94a3b8; }

/* ── Step headings ── */
.ht-step-heading { display: flex; align-items: center; gap: 12px; margin: 20px 0 8px; }
.ht-step-number {
  display: inline-flex; align-items: center; justify-content: center;
  width: 30px; height: 30px; border-radius: 50%;
  background: #22c55e; color: #09090b; font-weight: 700; font-size: 13px; flex-shrink: 0;
}
.ht-step-label { font-size: 15px; font-weight: 600; color: #f8fafc; }

/* ── Callout boxes ── */
.ht-callout {
  border-left: 3px solid #22c55e; padding: 12px 16px; margin: 12px 0;
  border-radius: 0 8px 8px 0; font-size: 13px; line-height: 1.6;
}
.ht-callout p { margin-bottom: 0; }
.ht-callout-info { background: rgba(34,197,94,0.06); border-left-color: #22c55e; }
.ht-callout-warning { background: rgba(245,158,11,0.08); border-left-color: #f59e0b; }
.ht-callout-impl { background: rgba(139,92,246,0.08); border-left-color: #8b5cf6; }

/* ── Code blocks ── */
.ht-code-block { position: relative; background: #0c0c14; border: 1px solid #1a2e1f; border-radius: 8px; margin: 12px 0; overflow: hidden; }
.ht-code-block pre { padding: 14px 16px; margin: 0; overflow-x: auto; }
.ht-code-block code { font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace; font-size: 13px; color: #e2e8f0; line-height: 1.5; }
.ht-code-lang {
  display: inline-block; padding: 2px 10px; font-size: 10px; font-weight: 600;
  text-transform: uppercase; color: #64748b; background: rgba(100,116,139,0.1);
  border-bottom: 1px solid #1a2e1f; border-right: 1px solid #1a2e1f; border-radius: 0 0 6px 0;
}
.ht-copy-btn {
  position: absolute; top: 6px; right: 8px; background: rgba(15,22,19,0.8);
  border: 1px solid #1a2e1f; border-radius: 4px; padding: 3px 6px;
  font-size: 13px; cursor: pointer; color: #94a3b8; transition: all 0.15s; z-index: 2;
}
.ht-copy-btn:hover { border-color: #22c55e; color: #22c55e; }
.ht-inline-code {
  background: rgba(34,197,94,0.08); color: #86efac; padding: 1px 6px;
  border-radius: 4px; font-family: 'SF Mono', 'Fira Code', monospace; font-size: 0.9em;
}

/* ── Tables ── */
.ht-table-wrap { overflow-x: auto; margin: 12px 0; }
.ht-table { width: 100%; border-collapse: collapse; font-size: 13px; }
.ht-table th {
  text-align: left; padding: 8px 12px; background: rgba(34,197,94,0.06);
  color: #94a3b8; font-size: 11px; font-weight: 600;
  text-transform: uppercase; letter-spacing: 0.5px; border-bottom: 1px solid #1f3b28;
}
.ht-table td { padding: 8px 12px; border-bottom: 1px solid rgba(26,46,31,0.5); color: #cbd5e1; vertical-align: top; }
.ht-table tr:hover td { background: rgba(34,197,94,0.03); }

/* ── Lists ── */
.ht-list { padding-left: 20px; margin: 8px 0; }
.ht-list li { margin-bottom: 4px; }
.ht-section-outcomes .ht-list { list-style: none; padding-left: 0; }
.ht-section-outcomes .ht-list li::before { content: '\\2713'; color: #22c55e; font-weight: 700; margin-right: 8px; }

/* ── Checkboxes ── */
.ht-checklist-item { list-style: none; margin-bottom: 6px; }
.ht-check-label { display: flex; align-items: flex-start; gap: 8px; cursor: pointer; }
.ht-checkbox {
  appearance: none; -webkit-appearance: none; width: 18px; height: 18px;
  border: 2px solid #1f3b28; border-radius: 4px; background: transparent;
  cursor: pointer; flex-shrink: 0; margin-top: 2px; position: relative; transition: all 0.15s;
}
.ht-checkbox:checked { background: #22c55e; border-color: #22c55e; }
.ht-checkbox:checked::after {
  content: '\\2713'; position: absolute; color: #09090b;
  font-size: 12px; font-weight: 700; top: 50%; left: 50%; transform: translate(-50%, -50%);
}
.ht-checkbox:checked + .ht-check-text { text-decoration: line-through; color: #64748b; }
.ht-check-counter { font-size: 12px; color: #22c55e; margin-bottom: 10px; font-weight: 600; }

/* ── Screenshot placeholders ── */
.ht-screenshot-placeholder {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  background: #111118; border: 2px dashed #2a2d3e; border-radius: 10px;
  padding: 28px; margin: 10px 0; min-height: 140px; color: #475569;
}
.ht-screenshot-icon { font-size: 32px; margin-bottom: 6px; }
.ht-screenshot-label { font-size: 13px; font-weight: 500; }
.ht-screenshot-id { font-size: 10px; font-family: 'SF Mono', monospace; margin-top: 4px; opacity: 0.5; }

/* ── 404 ── */
.ht-404 { text-align: center; padding-top: 80px; }
.ht-404 h1 { font-size: 36px; color: #f59e0b; margin-bottom: 12px; }
.ht-404 p { font-size: 15px; color: #94a3b8; }

/* ── Hamburger (mobile) ── */
.ht-hamburger {
  display: none; position: fixed; top: 12px; left: 12px; z-index: 200;
  background: #0F1613; border: 1px solid #1f3b28; border-radius: 6px;
  padding: 8px 10px; cursor: pointer; color: #f8fafc; font-size: 18px; line-height: 1;
}
.ht-backdrop { display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.6); z-index: 90; }

/* ── Table of Contents ── */
.ht-toc {
  background: #0F1613; border: 1px solid #1f3b28; border-radius: 10px;
  padding: 16px 20px; margin-bottom: 24px;
}
.ht-toc-title { font-size: 14px; font-weight: 700; color: #94a3b8; margin-bottom: 10px; text-transform: uppercase; letter-spacing: 0.5px; }
.ht-toc-list { list-style: none; padding: 0; margin: 0; }
.ht-toc-item { margin-bottom: 4px; }
.ht-toc-link {
  display: flex; align-items: center; gap: 8px; padding: 5px 8px;
  font-size: 13px; color: #94a3b8; border-radius: 6px; text-decoration: none; transition: all 0.15s;
}
.ht-toc-link:hover { color: #22c55e; background: rgba(34,197,94,0.06); text-decoration: none; }
.ht-toc-icon { font-size: 14px; }

/* ── Related Guides ── */
.ht-related { margin-top: 40px; padding-top: 24px; border-top: 1px solid #1f3b28; }
.ht-related-title { font-size: 18px; font-weight: 700; color: #f8fafc; margin-bottom: 16px; }
.ht-related-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 12px; }
.ht-related-card {
  display: block; background: #0F1613; border: 1px solid #1f3b28; border-radius: 10px;
  padding: 16px; text-decoration: none; transition: border-color 0.15s;
}
.ht-related-card:hover { border-color: #22c55e40; text-decoration: none; }
.ht-related-card-title { font-size: 14px; font-weight: 600; color: #f8fafc; }
.ht-related-card-summary { font-size: 12px; color: #94a3b8; margin-top: 4px; line-height: 1.4; }

/* ── Prev / Next ── */
.ht-prevnext { display: flex; justify-content: space-between; gap: 16px; margin-top: 32px; }
.ht-prevnext-link {
  display: block; flex: 1; padding: 14px 16px; background: #0F1613;
  border: 1px solid #1f3b28; border-radius: 10px; text-decoration: none; transition: border-color 0.15s;
}
.ht-prevnext-link:hover { border-color: #22c55e40; text-decoration: none; }
.ht-prevnext-label { font-size: 11px; color: #64748b; text-transform: uppercase; letter-spacing: 0.5px; }
.ht-prevnext-title { font-size: 14px; font-weight: 600; color: #f8fafc; margin-top: 4px; }
.ht-prevnext-next { text-align: right; }

/* ── Share buttons ── */
.ht-share { display: flex; align-items: center; gap: 8px; margin-bottom: 16px; }
.ht-share-label { font-size: 12px; color: #64748b; }
.ht-share-btn {
  display: inline-flex; align-items: center; gap: 4px; padding: 4px 10px;
  font-size: 12px; color: #94a3b8; border: 1px solid #1f3b28; border-radius: 6px;
  text-decoration: none; transition: all 0.15s;
}
.ht-share-btn:hover { color: #22c55e; border-color: #22c55e; text-decoration: none; }

/* ── Category landing page ── */
.ht-cat-landing-desc { font-size: 14px; color: #94a3b8; margin-bottom: 20px; line-height: 1.6; }

/* ── Quick Start section ── */
.ht-section-quickstart {
  border-left-color: #3b82f6;
  background: rgba(59,130,246,0.06);
  border: 2px solid rgba(59,130,246,0.25);
  border-left: 4px solid #3b82f6;
  border-radius: 12px;
}
.ht-section-quickstart .ht-section-title { font-size: 20px; color: #3b82f6; }
.ht-section-quickstart .ht-section-body ol {
  counter-reset: qs-step; list-style: none; padding-left: 0;
}
.ht-section-quickstart .ht-section-body ol li {
  counter-increment: qs-step;
  display: flex; align-items: flex-start; gap: 12px;
  margin-bottom: 10px; font-size: 15px; font-weight: 500;
}
.ht-section-quickstart .ht-section-body ol li::before {
  content: counter(qs-step);
  display: inline-flex; align-items: center; justify-content: center;
  min-width: 28px; height: 28px; border-radius: 50%;
  background: #3b82f6; color: #fff; font-weight: 700; font-size: 13px; flex-shrink: 0;
}

/* ── Advanced Details (collapsible) ── */
.ht-section-advanced {
  border-left-color: #8b5cf6;
  background: rgba(139,92,246,0.04);
}
.ht-section-advanced > summary {
  cursor: pointer; list-style: none;
  display: flex; align-items: center; gap: 8px;
  font-size: 18px; font-weight: 700; color: #f8fafc; padding: 0;
}
.ht-section-advanced > summary::-webkit-details-marker { display: none; }
.ht-section-advanced > summary::marker { display: none; content: ''; }
.ht-section-advanced > summary::before {
  content: '\\25B6'; font-size: 12px; color: #8b5cf6; transition: transform 0.2s;
}
.ht-section-advanced[open] > summary::before { transform: rotate(90deg); }
.ht-advanced-toggle {
  margin-left: auto; font-size: 11px; color: #8b5cf6; font-weight: 500;
}
.ht-section-advanced > .ht-section-body {
  margin-top: 16px; padding-top: 16px; border-top: 1px solid rgba(139,92,246,0.15);
}

/* ── Difficulty badges ── */
.ht-meta-difficulty, .ht-preview-difficulty {
  font-size: 11px; padding: 2px 10px; border-radius: 10px;
  font-weight: 600; text-transform: uppercase; letter-spacing: 0.3px;
}
.ht-difficulty-beginner {
  color: #22c55e; background: rgba(34,197,94,0.1); border: 1px solid rgba(34,197,94,0.2);
}
.ht-difficulty-intermediate {
  color: #f59e0b; background: rgba(245,158,11,0.1); border: 1px solid rgba(245,158,11,0.2);
}
.ht-difficulty-advanced {
  color: #ef4444; background: rgba(239,68,68,0.1); border: 1px solid rgba(239,68,68,0.2);
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
  .ht-toc { padding: 12px 14px; }
  .ht-related-grid { grid-template-columns: 1fr; }
  .ht-prevnext { flex-direction: column; }
}

/* ── Print ── */
@media print {
  .ht-sidebar, .ht-hamburger, .ht-backdrop, .ht-progress-track,
  .ht-share, .ht-article-nav, .ht-copy-btn, .ht-search-wrap,
  .ht-toc, .ht-prevnext { display: none !important; }
  .ht-main { margin-left: 0 !important; padding: 0 !important; max-width: 100% !important; }
  body { background: #fff !important; color: #000 !important; }
  .ht-section { background: #fff !important; border-color: #ccc !important; }
  .ht-section-body, .ht-section-body p { color: #222 !important; }
  .ht-article-title, .ht-section-title, .ht-page-title { color: #000 !important; }
  .ht-breadcrumb a, a { color: #000 !important; }
  a[href^="/"]::after, a[href^="http"]::after { content: " (" attr(href) ")"; font-size: 0.85em; color: #555; }
  .ht-related-card a::after, .ht-sidebar a::after { content: none; }
  .ht-code-block { background: #f5f5f5 !important; border-color: #ccc !important; }
  .ht-code-block code { color: #222 !important; }
  .ht-table th { background: #eee !important; color: #222 !important; }
  .ht-table td { color: #222 !important; border-color: #ccc !important; }
  .ht-related-card { border-color: #ccc !important; background: #f9f9f9 !important; }
  .ht-related-card-title { color: #000 !important; }
  .ht-related-card-summary { color: #333 !important; }
}
`;

// ─── HTML builders ───────────────────────────────────────────────────────────

const BASE_URL = 'https://api.tallyconnect.app/how-to';

function escAttr(s) { return String(s).replace(/"/g, '&quot;').replace(/&/g, '&amp;'); }

function buildSidebarHtml(categories, activeArticleId) {
  return categories.map(cat => `
    <div class="ht-sidebar-category">
      <div class="ht-sidebar-cat-title">${cat.name}</div>
      ${cat.articles.map(a => `
        <a href="/how-to/${a.slug}" class="ht-sidebar-link${activeArticleId === a.id ? ' active' : ''}" data-article="${a.id}">
          ${a.title}
        </a>
      `).join('')}
    </div>
  `).join('');
}

function renderJsonLd(jsonLd) {
  if (!jsonLd) return '';
  if (Array.isArray(jsonLd)) {
    return jsonLd.filter(Boolean).map(ld => `<script type="application/ld+json">${JSON.stringify(ld)}</script>`).join('\n');
  }
  return `<script type="application/ld+json">${JSON.stringify(jsonLd)}</script>`;
}

function buildHtmlShell({ title, metaDescription, canonicalUrl, ogType, jsonLd, sidebarHtml, isHome, bodyContent, scriptContent }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>${escAttr(title)}</title>
<meta name="description" content="${escAttr(metaDescription)}" />
<link rel="canonical" href="${escAttr(canonicalUrl)}" />
<meta property="og:type" content="${ogType || 'website'}" />
<meta property="og:title" content="${escAttr(title)}" />
<meta property="og:description" content="${escAttr(metaDescription)}" />
<meta property="og:url" content="${escAttr(canonicalUrl)}" />
<meta property="og:site_name" content="Tally How-To Guides" />
<meta name="twitter:card" content="summary" />
<meta name="twitter:title" content="${escAttr(title)}" />
<meta name="twitter:description" content="${escAttr(metaDescription)}" />
${renderJsonLd(jsonLd)}
<style>${CSS_BLOCK}</style>
</head>
<body>
<button class="ht-hamburger" onclick="htToggleSidebar()">&#9776;</button>
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
      <a href="/how-to" class="ht-sidebar-home${isHome ? ' active' : ''}">All Guides</a>
      ${sidebarHtml}
    </nav>
  </aside>
  <main class="ht-main">
    ${bodyContent}
  </main>
</div>
<script>
(function() {
  // ── Mobile sidebar ──
  window.htToggleSidebar = function() {
    document.getElementById('htSidebar').classList.toggle('open');
    document.getElementById('htBackdrop').classList.toggle('open');
  };

  // ── Search: filter sidebar links ──
  document.getElementById('htSearch').addEventListener('input', function() {
    var q = this.value.toLowerCase().trim();
    document.querySelectorAll('.ht-sidebar-link').forEach(function(link) {
      link.style.display = (!q || link.textContent.toLowerCase().includes(q)) ? '' : 'none';
    });
    document.querySelectorAll('.ht-sidebar-category').forEach(function(cat) {
      var visible = cat.querySelectorAll('.ht-sidebar-link:not([style*="display: none"])');
      cat.style.display = visible.length > 0 || !q ? '' : 'none';
    });
    ${''}
    var homeCards = document.querySelectorAll('.ht-article-preview');
    if (homeCards.length) {
      homeCards.forEach(function(el) {
        el.style.display = (!q || el.textContent.toLowerCase().includes(q)) ? '' : 'none';
      });
      document.querySelectorAll('.ht-category-card').forEach(function(card) {
        var vis = card.querySelectorAll('.ht-article-preview:not([style*="display: none"])');
        card.style.display = vis.length > 0 || !q ? '' : 'none';
      });
    }
  });

  ${scriptContent || ''}
})();
</script>
</body>
</html>`;
}

function buildIndexPageHtml(categories, articles) {
  const sidebarHtml = buildSidebarHtml(categories, null);

  const homeHtml = categories.map(cat => {
    const catSlug = CATEGORY_SLUGS[cat.name] || slugify(cat.name);
    return `
    <div class="ht-category-card">
      <div class="ht-cat-header">
        <h2 class="ht-cat-title"><a href="/how-to/category/${catSlug}">${cat.name}</a></h2>
        <span class="ht-cat-count">${cat.articles.length} guide${cat.articles.length !== 1 ? 's' : ''}</span>
      </div>
      ${cat.articles.map(a => `
        <a class="ht-article-preview" href="/how-to/${a.slug}">
          <div class="ht-preview-top">
            <span class="ht-preview-title">${a.title}</span>
          </div>
          <div class="ht-preview-meta">
            ${a.readTime ? `<span class="ht-preview-time">&#128337; ${a.readTime}</span>` : ''}
            <span class="ht-preview-sections">${a.sections.length} sections</span>
            ${a.difficulty ? `<span class="ht-preview-difficulty ht-difficulty-${a.difficulty.toLowerCase()}">${a.difficulty}</span>` : ''}
          </div>
          ${a.summary ? `<div class="ht-preview-summary">${a.summary}</div>` : ''}
        </a>
      `).join('')}
    </div>
  `;
  }).join('');

  // JSON-LD: ItemList + BreadcrumbList
  const itemListLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: 'Tally How-To Guides',
    description: `${articles.length} step-by-step setup guides for church production teams`,
    numberOfItems: articles.length,
    itemListElement: articles.map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: a.title,
      url: `${BASE_URL}/${a.slug}`,
    })),
  };
  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Guides', item: `${BASE_URL}/` },
    ],
  };

  // Hash backward-compat redirect script
  const hashRedirectMap = articles.map(a => `'${a.id}':'${a.slug}'`).join(',');
  const hashRedirect = `
    if (location.hash && /^#H\\d{2}$/i.test(location.hash)) {
      var slugMap = {${hashRedirectMap}};
      var slug = slugMap[location.hash.slice(1).toUpperCase()];
      if (slug) location.replace('/how-to/' + slug);
    }
  `;

  const bodyContent = `
    <h1 class="ht-page-title">How-To Guides</h1>
    <p class="ht-page-sub">${articles.length} step-by-step guides for your production team</p>
    <div class="ht-categories-grid">${homeHtml}</div>
  `;

  return buildHtmlShell({
    title: 'Tally How-To Guides — Step-by-Step Setup for Church Production',
    metaDescription: `${articles.length} step-by-step guides for installing, configuring, and troubleshooting Tally church production software including ATEM, PTZ, audio consoles, encoders, and more.`,
    canonicalUrl: `${BASE_URL}/`,
    ogType: 'website',
    jsonLd: [itemListLd, breadcrumbLd],
    sidebarHtml,
    isHome: true,
    bodyContent,
    scriptContent: hashRedirect,
  });
}

function buildArticlePageHtml(article, categories, articles) {
  const sidebarHtml = buildSidebarHtml(categories, article.id);
  const canonicalUrl = `${BASE_URL}/${article.slug}`;
  const catSlug = CATEGORY_SLUGS[article.category] || slugify(article.category);
  const shareUrl = encodeURIComponent(canonicalUrl);
  const shareTitle = encodeURIComponent(article.title);

  // ── Sections HTML (h2 titles for correct hierarchy) ──
  const sectionsHtml = article.sections.map(s => {
    if (s.type === 'advanced') {
      return `
        <details id="${s.id}" class="ht-section ht-section-advanced" data-section-type="advanced">
          <summary class="ht-section-title">
            <span class="ht-section-icon">${SECTION_ICONS.advanced}</span>${s.title}
            <span class="ht-advanced-toggle">Show / Hide</span>
          </summary>
          <div class="ht-section-body">${s.html}</div>
        </details>`;
    }
    return `
      <section id="${s.id}" class="ht-section ht-section-${s.type}" data-section-type="${s.type}">
        <h2 class="ht-section-title"><span class="ht-section-icon">${SECTION_ICONS[s.type] || ''}</span>${s.title}</h2>
        ${s.type === 'checklist' ? '<div class="ht-check-counter">0 of 0 verified</div>' : ''}
        <div class="ht-section-body">${s.html}</div>
      </section>`;
  }).join('');

  // ── Section tab nav ──
  const articleNavHtml = article.sections.map(s =>
    `<a href="#${s.id}" class="ht-article-nav-link ht-nav-${s.type}" onclick="htScrollTo('${s.id}');return false;">${SECTION_ICONS[s.type] || ''} ${SECTION_LABELS[s.type] || s.title}</a>`
  ).join('');

  // ── Share buttons HTML ──
  const shareHtml = `
    <div class="ht-share">
      <span class="ht-share-label">Share:</span>
      <a class="ht-share-btn" href="https://twitter.com/intent/tweet?url=${shareUrl}&text=${shareTitle}" target="_blank" rel="noopener">X / Twitter</a>
      <a class="ht-share-btn" href="https://www.linkedin.com/sharing/share-offsite/?url=${shareUrl}" target="_blank" rel="noopener">LinkedIn</a>
      <a class="ht-share-btn ht-copy-link-btn" href="#" onclick="navigator.clipboard.writeText(decodeURIComponent('${shareUrl}'));this.textContent='Copied!';setTimeout(function(){document.querySelector('.ht-copy-link-btn').textContent='Copy Link'},2000);return false;">Copy Link</a>
    </div>
  `;

  // ── Table of Contents ──
  const tocItems = buildTocItems(article);
  const tocHtml = `
    <nav class="ht-toc" aria-label="Table of contents">
      <div class="ht-toc-title">On This Page</div>
      <ul class="ht-toc-list">
        ${tocItems.map(t => `
          <li class="ht-toc-item">
            <a href="#${t.id}" class="ht-toc-link" onclick="htScrollTo('${t.id}');return false;">
              <span class="ht-toc-icon">${t.icon}</span>${t.label}
            </a>
          </li>
        `).join('')}
      </ul>
    </nav>
  `;

  // ── Prev / Next navigation ──
  const { prev, next } = getPrevNext(article, categories);
  const prevNextHtml = (prev || next) ? `
    <div class="ht-prevnext">
      ${prev ? `<a href="/how-to/${prev.slug}" class="ht-prevnext-link">
        <div class="ht-prevnext-label">&#8592; Previous</div>
        <div class="ht-prevnext-title">${prev.title}</div>
      </a>` : '<div></div>'}
      ${next ? `<a href="/how-to/${next.slug}" class="ht-prevnext-link ht-prevnext-next">
        <div class="ht-prevnext-label">Next &#8594;</div>
        <div class="ht-prevnext-title">${next.title}</div>
      </a>` : '<div></div>'}
    </div>
  ` : '';

  // ── Related Guides ──
  const relatedIds = RELATED_GUIDES[article.id] || [];
  const relatedArticles = relatedIds.map(id => articles.find(a => a.id === id)).filter(Boolean);
  const relatedHtml = relatedArticles.length > 0 ? `
    <div class="ht-related">
      <h2 class="ht-related-title">Related Guides</h2>
      <div class="ht-related-grid">
        ${relatedArticles.map(a => `
          <a href="/how-to/${a.slug}" class="ht-related-card">
            <div class="ht-related-card-title">${a.title}</div>
            ${a.summary ? `<div class="ht-related-card-summary">${a.summary}</div>` : ''}
          </a>
        `).join('')}
      </div>
    </div>
  ` : '';

  // ── Breadcrumb HTML (links to category page) ──
  const breadcrumbHtml = `
    <div class="ht-breadcrumb">
      <a href="/how-to">Guides</a>
      <span class="ht-breadcrumb-sep">&#8250;</span>
      <a href="/how-to/category/${catSlug}">${article.category}</a>
      <span class="ht-breadcrumb-sep">&#8250;</span>
      <span>${article.title}</span>
    </div>
    <div class="ht-progress-track"><div id="htProgressFill" class="ht-progress-fill"></div></div>
  `;

  const articleHeaderHtml = `
    <div class="ht-article-header">
      <h1 class="ht-article-title">${article.title}</h1>
      <div class="ht-article-meta">
        ${article.readTime ? `<span class="ht-meta-time">&#128337; ${article.readTime}</span>` : ''}
        ${article.category ? `<span class="ht-meta-cat">${article.category}</span>` : ''}
        ${article.difficulty ? `<span class="ht-meta-difficulty ht-difficulty-${article.difficulty.toLowerCase()}">${article.difficulty}</span>` : ''}
      </div>
    </div>
    <div class="ht-article-nav">${articleNavHtml}</div>
  `;

  // ── Compose body ──
  const bodyContent = breadcrumbHtml + shareHtml + articleHeaderHtml + tocHtml + sectionsHtml + prevNextHtml + relatedHtml + shareHtml;

  // ── JSON-LD: Enhanced HowTo + BreadcrumbList + FAQPage ──
  const steps = extractSteps(article);
  const howToLd = {
    '@context': 'https://schema.org',
    '@type': 'HowTo',
    name: article.title,
    description: article.summary || `Step-by-step guide: ${article.title}`,
    author: { '@type': 'Organization', name: 'Tally by ATEM School' },
    publisher: { '@type': 'Organization', name: 'Tally by ATEM School', url: 'https://tallyconnect.app' },
    datePublished: '2025-01-15',
    dateModified: new Date().toISOString().split('T')[0],
  };
  if (article.readTime) {
    const mins = parseInt(article.readTime, 10);
    if (mins > 0) howToLd.totalTime = `PT${mins}M`;
  }
  if (steps.length > 0) howToLd.step = steps;
  if (article.difficulty) howToLd.educationalLevel = article.difficulty;

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Guides', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: article.category, item: `${BASE_URL}/category/${catSlug}` },
      { '@type': 'ListItem', position: 3, name: article.title, item: canonicalUrl },
    ],
  };

  const faqItems = extractFaqItems(article);
  const faqLd = faqItems.length > 0 ? {
    '@context': 'https://schema.org',
    '@type': 'FAQPage',
    mainEntity: faqItems.map(f => ({
      '@type': 'Question',
      name: f.question,
      acceptedAnswer: { '@type': 'Answer', text: f.answer },
    })),
  } : null;

  // Article-specific script: progress bar, checkbox counters, code copy, smooth scroll
  const scriptContent = `
  // ── Smooth scroll (auto-opens collapsible sections) ──
  window.htScrollTo = function(id) {
    var el = document.getElementById(id);
    if (el) {
      if (el.tagName === 'DETAILS') el.open = true;
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  };

  // ── Progress bar ──
  function updateProgress() {
    var docHeight = document.documentElement.scrollHeight - window.innerHeight;
    var progress = docHeight > 0 ? Math.min(100, Math.round((window.scrollY / docHeight) * 100)) : 0;
    var fill = document.getElementById('htProgressFill');
    if (fill) fill.style.width = progress + '%';
  }
  window.addEventListener('scroll', updateProgress);
  updateProgress();

  // ── Copy to clipboard ──
  window.htCopyCode = function(btn) {
    var code = btn.closest('.ht-code-block').querySelector('code').textContent;
    navigator.clipboard.writeText(code).then(function() {
      btn.textContent = '\\u2713 Copied';
      btn.style.color = '#22c55e';
      setTimeout(function() { btn.innerHTML = '&#128203;'; btn.style.color = ''; }, 2000);
    });
  };

  // ── Checkbox counters ──
  function updateCheckCounters(container) {
    var root = container || document;
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
  updateCheckCounters(document);
  document.addEventListener('change', function(e) {
    if (e.target.classList.contains('ht-checkbox')) {
      var section = e.target.closest('.ht-section');
      if (section) updateCheckCounters(section);
    }
  });
  `;

  return buildHtmlShell({
    title: `${article.title} — Tally How-To Guide`,
    metaDescription: article.summary || `Step-by-step guide: ${article.title}`,
    canonicalUrl,
    ogType: 'article',
    jsonLd: [howToLd, breadcrumbLd, faqLd],
    sidebarHtml,
    isHome: false,
    bodyContent,
    scriptContent,
  });
}

function buildCategoryPageHtml(category, categories, articles) {
  const sidebarHtml = buildSidebarHtml(categories, null);
  const catSlug = CATEGORY_SLUGS[category.name] || slugify(category.name);
  const canonicalUrl = `${BASE_URL}/category/${catSlug}`;

  const articlesHtml = category.articles.map(a => `
    <a class="ht-article-preview" href="/how-to/${a.slug}">
      <div class="ht-preview-top">
        <span class="ht-preview-title">${a.title}</span>
      </div>
      <div class="ht-preview-meta">
        ${a.readTime ? `<span class="ht-preview-time">&#128337; ${a.readTime}</span>` : ''}
        <span class="ht-preview-sections">${a.sections.length} sections</span>
        ${a.difficulty ? `<span class="ht-preview-difficulty ht-difficulty-${a.difficulty.toLowerCase()}">${a.difficulty}</span>` : ''}
      </div>
      ${a.summary ? `<div class="ht-preview-summary">${a.summary}</div>` : ''}
    </a>
  `).join('');

  const breadcrumbLd = {
    '@context': 'https://schema.org',
    '@type': 'BreadcrumbList',
    itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Guides', item: `${BASE_URL}/` },
      { '@type': 'ListItem', position: 2, name: category.name, item: canonicalUrl },
    ],
  };

  const itemListLd = {
    '@context': 'https://schema.org',
    '@type': 'ItemList',
    name: `${category.name} — Tally How-To Guides`,
    numberOfItems: category.articles.length,
    itemListElement: category.articles.map((a, i) => ({
      '@type': 'ListItem',
      position: i + 1,
      name: a.title,
      url: `${BASE_URL}/${a.slug}`,
    })),
  };

  const bodyContent = `
    <div class="ht-breadcrumb">
      <a href="/how-to">Guides</a>
      <span class="ht-breadcrumb-sep">&#8250;</span>
      <span>${category.name}</span>
    </div>
    <h1 class="ht-page-title">${category.name}</h1>
    <p class="ht-cat-landing-desc">${category.articles.length} step-by-step guide${category.articles.length !== 1 ? 's' : ''} in this category.</p>
    <div class="ht-category-card" style="border:none;padding:0;background:transparent;">
      ${articlesHtml}
    </div>
  `;

  return buildHtmlShell({
    title: `${category.name} — Tally How-To Guides`,
    metaDescription: `${category.articles.length} step-by-step guides for ${category.name.toLowerCase()} in Tally church production software.`,
    canonicalUrl,
    ogType: 'website',
    jsonLd: [breadcrumbLd, itemListLd],
    sidebarHtml,
    isHome: false,
    bodyContent,
  });
}

function build404Html(categories) {
  const sidebarHtml = buildSidebarHtml(categories, null);
  return buildHtmlShell({
    title: 'Guide Not Found — Tally How-To',
    metaDescription: 'The requested how-to guide was not found.',
    canonicalUrl: `${BASE_URL}/`,
    sidebarHtml,
    isHome: false,
    bodyContent: `
      <div class="ht-404">
        <h1>Guide Not Found</h1>
        <p>The guide you're looking for doesn't exist. <a href="/how-to">Browse all guides</a>.</p>
      </div>
    `,
  });
}

function buildSitemapXml(articles, categories) {
  const today = new Date().toISOString().split('T')[0];
  const urls = [
    { loc: `${BASE_URL}/`, priority: '1.0', changefreq: 'weekly' },
    ...categories.map(cat => ({
      loc: `${BASE_URL}/category/${CATEGORY_SLUGS[cat.name] || slugify(cat.name)}`,
      priority: '0.9',
      changefreq: 'weekly',
    })),
    ...articles.map(a => ({ loc: `${BASE_URL}/${a.slug}`, priority: '0.8', changefreq: 'monthly' })),
  ];
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${urls.map(u => `  <url>
    <loc>${u.loc}</loc>
    <lastmod>${today}</lastmod>
    <changefreq>${u.changefreq}</changefreq>
    <priority>${u.priority}</priority>
  </url>`).join('\n')}
</urlset>`;
}

function buildRobotsTxt() {
  return `User-agent: *
Allow: /

Sitemap: ${BASE_URL}/sitemap.xml
`;
}

// ─── Route setup ─────────────────────────────────────────────────────────────

function setupHowToPortal(app) {
  const { categories, articles } = loadAndParseGuides();

  // Pre-render all pages
  const pageMap = new Map();
  const indexHtml = buildIndexPageHtml(categories, articles);

  for (const article of articles) {
    pageMap.set(article.slug, buildArticlePageHtml(article, categories, articles));
  }

  const categoryPageMap = new Map();
  for (const cat of categories) {
    const catSlug = CATEGORY_SLUGS[cat.name] || slugify(cat.name);
    categoryPageMap.set(catSlug, buildCategoryPageHtml(cat, categories, articles));
  }

  const notFoundHtml = build404Html(categories);
  const sitemapXml = buildSitemapXml(articles, categories);
  const robotsTxt = buildRobotsTxt();

  const totalKB = Math.round((
    indexHtml.length +
    [...pageMap.values()].reduce((s, h) => s + h.length, 0) +
    [...categoryPageMap.values()].reduce((s, h) => s + h.length, 0)
  ) / 1024);
  console.log(`[HowTo] Loaded ${articles.length} articles across ${categories.length} categories (${pageMap.size + 1 + categoryPageMap.size} pages, ${totalKB} KB)`);

  // ── Subdomain middleware — howto.tallyconnect.app ──
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (!host.startsWith('howto.')) return next();
    if (req.path === '/') return res.type('html').send(indexHtml);
    if (req.path === '/sitemap.xml') return res.type('xml').send(sitemapXml);
    if (req.path === '/robots.txt') return res.type('text').send(robotsTxt);
    // Category pages on subdomain: /category/getting-started
    if (req.path.startsWith('/category/')) {
      const catSlug = req.path.slice('/category/'.length);
      const catHtml = categoryPageMap.get(catSlug);
      if (catHtml) return res.type('html').send(catHtml);
    }
    const slug = req.path.slice(1);
    const html = pageMap.get(slug);
    if (html) return res.type('html').send(html);
    // Old H## ID redirect
    const byId = articles.find(a => a.id.toLowerCase() === slug.toLowerCase());
    if (byId) return res.redirect(301, `/${byId.slug}`);
    return res.status(404).type('html').send(notFoundHtml);
  });

  // ── Standard path routes (order matters: category BEFORE :slug) ──
  app.get('/how-to', (_req, res) => res.type('html').send(indexHtml));
  app.get('/how-to/sitemap.xml', (_req, res) => res.type('xml').send(sitemapXml));
  app.get('/how-to/robots.txt', (_req, res) => res.type('text').send(robotsTxt));

  app.get('/how-to/category/:catSlug', (req, res) => {
    const html = categoryPageMap.get(req.params.catSlug);
    if (html) return res.type('html').send(html);
    return res.status(404).type('html').send(notFoundHtml);
  });

  app.get('/how-to/:slug', (req, res) => {
    const html = pageMap.get(req.params.slug);
    if (html) return res.type('html').send(html);
    // Old H## ID → 301 redirect to slug
    const byId = articles.find(a => a.id.toLowerCase() === req.params.slug.toLowerCase());
    if (byId) return res.redirect(301, `/how-to/${byId.slug}`);
    return res.status(404).type('html').send(notFoundHtml);
  });
}

module.exports = { setupHowToPortal };
