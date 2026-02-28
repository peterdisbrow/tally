const fs = require('fs');
const path = require('path');
const { marked } = require('marked');

// ─── Markdown loader & section parser ────────────────────────────────────────

function loadAndParseDocs() {
  const mdPath = path.resolve(__dirname, '../docs/integration-knowledge-base.md');
  const raw = fs.readFileSync(mdPath, 'utf-8');

  // Strip the YAML-style title line and ToC section (everything before first ## heading that isn't ToC)
  const lines = raw.split('\n');
  const sections = [];
  let current = null;

  for (const line of lines) {
    // New top-level section
    if (line.startsWith('## ') && !line.startsWith('## Table of Contents')) {
      if (current) sections.push(current);
      const title = line.replace('## ', '').trim();
      const id = slugify(title);
      current = { id, title, lines: [], subsections: [] };
      continue;
    }
    // Skip everything before first real section (title, ToC, etc.)
    if (!current) continue;

    // Subsection heading
    if (line.startsWith('### ')) {
      const subTitle = line.replace('### ', '').trim();
      current.subsections.push({ id: slugify(subTitle), title: subTitle });
    }
    current.lines.push(line);
  }
  if (current) sections.push(current);

  // Render each section's markdown to HTML
  const renderer = buildRenderer();
  for (const section of sections) {
    section.html = marked(section.lines.join('\n'), { renderer });
  }

  return sections;
}

function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '');
}

// ─── Custom marked renderer (dark theme) ─────────────────────────────────────

function buildRenderer() {
  const renderer = new marked.Renderer();

  // marked v14 uses token objects — destructure accordingly

  renderer.table = function (token) {
    // Build header and body from token rows
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
    return `<div class="doc-table-wrap"><table class="doc-table"><thead><tr>${header}</tr></thead><tbody>${body}</tbody></table></div>`;
  };

  renderer.code = function ({ text, lang }) {
    const langLabel = lang ? `<span class="doc-code-lang">${lang}</span>` : '';
    const escaped = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
    return `<div class="doc-code-block">${langLabel}<pre><code>${escaped}</code></pre></div>`;
  };

  renderer.codespan = function ({ text }) {
    return `<code class="doc-inline-code">${text}</code>`;
  };

  renderer.heading = function ({ tokens, depth }) {
    const text = this.parser.parseInline(tokens);
    const id = slugify(text.replace(/<[^>]+>/g, '')); // strip HTML tags for slug
    return `<h${depth} id="${id}" class="doc-heading doc-h${depth}">${text}</h${depth}>`;
  };

  renderer.blockquote = function ({ tokens }) {
    const body = this.parser.parse(tokens);
    return `<blockquote class="doc-blockquote">${body}</blockquote>`;
  };

  renderer.list = function (token) {
    const tag = token.ordered ? 'ol' : 'ul';
    let body = '';
    for (const item of token.items) {
      body += `<li>${this.parser.parse(item.tokens)}</li>`;
    }
    return `<${tag} class="doc-list">${body}</${tag}>`;
  };

  renderer.hr = function () {
    return '<hr class="doc-hr" />';
  };

  return renderer;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────

function buildDocsHtml(sections) {
  const sidebarItems = sections.map(s => {
    const subItems = s.subsections.map(sub =>
      `<a href="#${sub.id}" class="doc-sidebar-sub" data-section="${s.id}">${sub.title}</a>`
    ).join('');
    return `
      <div class="doc-sidebar-group" data-section="${s.id}">
        <a href="#${s.id}" class="doc-sidebar-link">${s.title}</a>
        ${subItems ? `<div class="doc-sidebar-subs">${subItems}</div>` : ''}
      </div>`;
  }).join('');

  const contentSections = sections.map(s => `
    <section id="${s.id}" class="doc-section">
      <h2 class="doc-section-title">${s.title}</h2>
      ${s.html}
    </section>`).join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Integration Docs — Tally by ATEM School</title>
  <style>
    /* ── Reset & base ─────────────────────────────────────────── */
    *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
    html { scroll-behavior: smooth; scroll-padding-top: 24px; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
      background: #09090b;
      color: #f8fafc;
      line-height: 1.65;
      min-height: 100vh;
    }

    /* ── Layout grid ──────────────────────────────────────────── */
    .doc-layout {
      display: grid;
      grid-template-columns: 280px 1fr;
      min-height: 100vh;
    }

    /* ── Sidebar ──────────────────────────────────────────────── */
    .doc-sidebar {
      position: fixed;
      top: 0;
      left: 0;
      width: 280px;
      height: 100vh;
      overflow-y: auto;
      background: #0F1613;
      border-right: 1px solid #1f3b28;
      padding: 20px 0;
      z-index: 100;
    }
    .doc-sidebar-header {
      padding: 0 20px 16px;
      border-bottom: 1px solid #1f3b28;
      margin-bottom: 12px;
    }
    .doc-sidebar-logo {
      font-size: 18px;
      font-weight: 700;
      color: #22c55e;
      letter-spacing: -0.02em;
    }
    .doc-sidebar-tagline {
      font-size: 11px;
      color: #94a3b8;
      margin-top: 4px;
    }
    .doc-search-wrap {
      padding: 0 16px;
      margin-bottom: 12px;
    }
    .doc-search {
      width: 100%;
      padding: 8px 12px;
      border-radius: 8px;
      border: 1px solid #1f3b28;
      background: #09090b;
      color: #f8fafc;
      font-size: 13px;
      outline: none;
      transition: border-color 0.2s;
    }
    .doc-search:focus { border-color: #22c55e; }
    .doc-search::placeholder { color: #64748b; }
    .doc-sidebar-nav { padding: 0 8px; }
    .doc-sidebar-group { margin-bottom: 2px; }
    .doc-sidebar-link {
      display: block;
      padding: 7px 12px;
      color: #cbd5e1;
      text-decoration: none;
      font-size: 13px;
      font-weight: 500;
      border-radius: 6px;
      transition: all 0.15s;
    }
    .doc-sidebar-link:hover { background: rgba(34, 197, 94, 0.08); color: #f8fafc; }
    .doc-sidebar-link.active { background: rgba(34, 197, 94, 0.12); color: #22c55e; }
    .doc-sidebar-subs {
      max-height: 0;
      overflow: hidden;
      transition: max-height 0.3s ease;
    }
    .doc-sidebar-group.expanded .doc-sidebar-subs { max-height: 600px; }
    .doc-sidebar-sub {
      display: block;
      padding: 4px 12px 4px 28px;
      color: #94a3b8;
      text-decoration: none;
      font-size: 12px;
      border-radius: 4px;
      transition: all 0.15s;
    }
    .doc-sidebar-sub:hover { color: #cbd5e1; background: rgba(34, 197, 94, 0.05); }

    /* ── Main content ─────────────────────────────────────────── */
    .doc-main {
      grid-column: 2;
      padding: 32px 48px 80px;
      max-width: 900px;
    }
    .doc-page-title {
      font-size: 32px;
      font-weight: 700;
      letter-spacing: -0.03em;
      margin-bottom: 6px;
    }
    .doc-page-sub {
      color: #94a3b8;
      font-size: 14px;
      margin-bottom: 32px;
    }

    /* ── Section cards ────────────────────────────────────────── */
    .doc-section {
      background: rgba(15, 22, 19, 0.7);
      border: 1px solid #1f3b28;
      border-radius: 12px;
      padding: 28px 32px;
      margin-bottom: 20px;
    }
    .doc-section-title {
      font-size: 22px;
      font-weight: 700;
      color: #22c55e;
      margin-bottom: 16px;
      letter-spacing: -0.01em;
    }

    /* ── Typography ───────────────────────────────────────────── */
    .doc-heading { margin-top: 24px; margin-bottom: 12px; }
    .doc-h3 { font-size: 17px; font-weight: 600; color: #e2e8f0; border-bottom: 1px solid #1f3b28; padding-bottom: 6px; }
    .doc-h4 { font-size: 15px; font-weight: 600; color: #cbd5e1; }
    .doc-section p { color: #cbd5e1; font-size: 14px; margin-bottom: 12px; }
    .doc-section strong { color: #f8fafc; }

    /* ── Tables ────────────────────────────────────────────────── */
    .doc-table-wrap { overflow-x: auto; margin: 12px 0; border-radius: 8px; }
    .doc-table {
      width: 100%;
      border-collapse: collapse;
      font-size: 13px;
    }
    .doc-table th {
      text-align: left;
      padding: 10px 14px;
      background: #0e1b13;
      color: #22c55e;
      font-weight: 600;
      border-bottom: 2px solid #1f3b28;
      white-space: nowrap;
    }
    .doc-table td {
      padding: 8px 14px;
      border-bottom: 1px solid #162b1e;
      color: #cbd5e1;
    }
    .doc-table tr:hover td { background: rgba(34, 197, 94, 0.04); }

    /* ── Code ──────────────────────────────────────────────────── */
    .doc-code-block {
      position: relative;
      background: #0c0c14;
      border: 1px solid #1e293b;
      border-radius: 8px;
      margin: 12px 0;
      overflow: hidden;
    }
    .doc-code-block pre {
      padding: 16px;
      overflow-x: auto;
      font-size: 13px;
      line-height: 1.5;
    }
    .doc-code-block code {
      font-family: 'SF Mono', 'Fira Code', 'JetBrains Mono', monospace;
      color: #e2e8f0;
    }
    .doc-code-lang {
      position: absolute;
      top: 6px;
      right: 10px;
      font-size: 10px;
      color: #64748b;
      text-transform: uppercase;
      font-weight: 600;
      letter-spacing: 0.05em;
    }
    .doc-inline-code {
      font-family: 'SF Mono', 'Fira Code', monospace;
      background: rgba(34, 197, 94, 0.08);
      border: 1px solid rgba(34, 197, 94, 0.15);
      padding: 1px 6px;
      border-radius: 4px;
      font-size: 12.5px;
      color: #86efac;
    }

    /* ── Lists ─────────────────────────────────────────────────── */
    .doc-list {
      padding-left: 20px;
      margin: 8px 0 12px;
      font-size: 14px;
      color: #cbd5e1;
    }
    .doc-list li { margin-bottom: 4px; }

    /* ── Blockquote ────────────────────────────────────────────── */
    .doc-blockquote {
      border-left: 3px solid #22c55e;
      padding: 10px 16px;
      margin: 12px 0;
      background: rgba(34, 197, 94, 0.05);
      border-radius: 0 8px 8px 0;
      color: #94a3b8;
      font-size: 13px;
    }
    .doc-blockquote p { color: #94a3b8; }

    /* ── HR ─────────────────────────────────────────────────────── */
    .doc-hr {
      border: none;
      border-top: 1px solid #1f3b28;
      margin: 20px 0;
    }

    /* ── Mobile hamburger ──────────────────────────────────────── */
    .doc-hamburger {
      display: none;
      position: fixed;
      top: 14px;
      left: 14px;
      z-index: 200;
      width: 40px;
      height: 40px;
      border-radius: 8px;
      background: #0F1613;
      border: 1px solid #1f3b28;
      color: #22c55e;
      font-size: 20px;
      cursor: pointer;
      align-items: center;
      justify-content: center;
    }
    .doc-backdrop {
      display: none;
      position: fixed;
      inset: 0;
      background: rgba(0,0,0,0.5);
      z-index: 90;
    }

    /* ── Back-to-top ───────────────────────────────────────────── */
    .doc-back-top {
      position: fixed;
      bottom: 24px;
      right: 24px;
      width: 40px;
      height: 40px;
      border-radius: 10px;
      background: #0F1613;
      border: 1px solid #1f3b28;
      color: #22c55e;
      font-size: 18px;
      cursor: pointer;
      display: none;
      align-items: center;
      justify-content: center;
      z-index: 50;
      transition: opacity 0.2s;
    }
    .doc-back-top.visible { display: flex; }

    /* ── Responsive ────────────────────────────────────────────── */
    @media (max-width: 768px) {
      .doc-layout { grid-template-columns: 1fr; }
      .doc-sidebar {
        transform: translateX(-100%);
        transition: transform 0.3s ease;
      }
      .doc-sidebar.open { transform: translateX(0); }
      .doc-main { grid-column: 1; padding: 24px 16px 60px; }
      .doc-page-title { font-size: 24px; margin-top: 48px; }
      .doc-hamburger { display: flex; }
      .doc-backdrop.open { display: block; }
      .doc-section { padding: 20px 16px; }
    }
  </style>
</head>
<body>

  <!-- Mobile hamburger -->
  <button class="doc-hamburger" id="hamburger" aria-label="Toggle navigation">&#9776;</button>
  <div class="doc-backdrop" id="backdrop"></div>

  <div class="doc-layout">
    <!-- Sidebar -->
    <aside class="doc-sidebar" id="sidebar">
      <div class="doc-sidebar-header">
        <div class="doc-sidebar-logo">Tally Docs</div>
        <div class="doc-sidebar-tagline">Integration Knowledge Base</div>
      </div>
      <div class="doc-search-wrap">
        <input type="text" class="doc-search" id="search" placeholder="Filter docs..." autocomplete="off" />
      </div>
      <nav class="doc-sidebar-nav" id="sidebarNav">
        ${sidebarItems}
      </nav>
    </aside>

    <!-- Main content -->
    <main class="doc-main">
      <h1 class="doc-page-title">Integration Knowledge Base</h1>
      <p class="doc-page-sub">247 commands &middot; 20 namespaces &middot; 14 equipment categories</p>
      ${contentSections}
    </main>
  </div>

  <!-- Back-to-top -->
  <button class="doc-back-top" id="backTop" aria-label="Back to top">&uarr;</button>

  <script>
    // ── Scroll spy ──────────────────────────────────────────────
    const sectionEls = document.querySelectorAll('.doc-section');
    const sidebarGroups = document.querySelectorAll('.doc-sidebar-group');
    const sidebarLinks = document.querySelectorAll('.doc-sidebar-link');

    const observer = new IntersectionObserver(entries => {
      entries.forEach(entry => {
        if (entry.isIntersecting) {
          const id = entry.target.id;
          sidebarLinks.forEach(l => l.classList.remove('active'));
          sidebarGroups.forEach(g => g.classList.remove('expanded'));
          const group = document.querySelector('.doc-sidebar-group[data-section="' + id + '"]');
          if (group) {
            group.querySelector('.doc-sidebar-link').classList.add('active');
            group.classList.add('expanded');
          }
        }
      });
    }, { rootMargin: '-80px 0px -60% 0px', threshold: 0 });
    sectionEls.forEach(s => observer.observe(s));

    // ── Sidebar click → expand subsections ──────────────────────
    sidebarLinks.forEach(link => {
      link.addEventListener('click', () => {
        const group = link.closest('.doc-sidebar-group');
        if (group) group.classList.toggle('expanded');
      });
    });

    // ── Search filter ───────────────────────────────────────────
    const searchInput = document.getElementById('search');
    searchInput.addEventListener('input', () => {
      const q = searchInput.value.toLowerCase().trim();
      sidebarGroups.forEach(group => {
        const text = group.textContent.toLowerCase();
        const match = !q || text.includes(q);
        group.style.display = match ? '' : 'none';
        // Also toggle section visibility in main content
        const sectionId = group.dataset.section;
        const sectionEl = document.getElementById(sectionId);
        if (sectionEl) sectionEl.style.display = match ? '' : 'none';
      });
    });

    // ── Mobile hamburger ────────────────────────────────────────
    const sidebar = document.getElementById('sidebar');
    const hamburger = document.getElementById('hamburger');
    const backdrop = document.getElementById('backdrop');

    function toggleSidebar() {
      sidebar.classList.toggle('open');
      backdrop.classList.toggle('open');
    }
    hamburger.addEventListener('click', toggleSidebar);
    backdrop.addEventListener('click', toggleSidebar);

    // Close sidebar on mobile when clicking a link
    document.querySelectorAll('.doc-sidebar-link, .doc-sidebar-sub').forEach(link => {
      link.addEventListener('click', () => {
        if (window.innerWidth <= 768) {
          sidebar.classList.remove('open');
          backdrop.classList.remove('open');
        }
      });
    });

    // ── Back-to-top button ──────────────────────────────────────
    const backTop = document.getElementById('backTop');
    window.addEventListener('scroll', () => {
      backTop.classList.toggle('visible', window.scrollY > 400);
    });
    backTop.addEventListener('click', () => {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    });
  </script>
</body>
</html>`;
}

// ─── Route setup ──────────────────────────────────────────────────────────────

function setupDocsPortal(app) {
  const sections = loadAndParseDocs();
  const html = buildDocsHtml(sections);

  // Subdomain middleware — docs.tallyconnect.app → serve docs at root
  app.use((req, res, next) => {
    const host = (req.headers.host || '').toLowerCase();
    if (host.startsWith('docs.') && req.path === '/') {
      return res.type('html').send(html);
    }
    next();
  });

  // Direct route
  app.get('/docs', (req, res) => {
    res.type('html').send(html);
  });
}

module.exports = { setupDocsPortal };
