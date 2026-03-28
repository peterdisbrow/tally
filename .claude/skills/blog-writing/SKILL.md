# Blog Writing Skill

## Purpose
Produce conversion-focused, SEO-aware blog posts for the Tally blog at `tallyconnect.app/blog`.
Posts are React JSX component functions with inline styles — not markdown.
Primary objective: rank for target search queries. Secondary objective: convert readers to sign up.

## Use This Skill When
- You need a new blog post from a topic or keyword.
- You need to rewrite an existing post for clarity, conversion, or SEO.
- You need post assets (meta description, title options, slug, social copy).

## Required Inputs
- `topic`: What the post is about.
- `audience`: Who this is for.
- `goal`: What action the reader should take.
- `primary_keyword`: Exact keyword to rank for.

## Optional Inputs
- `secondary_keywords` (3-8)
- `word_count_target` (default: 1200)
- `tone` (default: clear, practical, confident)
- `offer` (CTA destination, default: `/signup`)
- `references` (internal notes, links, docs)

---

## Tally Blog Format Contract

### Source files (read before first draft)
- `/Volumes/DataDisk/openclaw-workspace/tally-landing/lib/blog.jsx` — All posts + style constants
- `/Volumes/DataDisk/openclaw-workspace/tally-landing/lib/tokens.js` — Design token colors
- `/Volumes/DataDisk/openclaw-workspace/tally-landing/app/blog/[slug]/page.js` — Post page layout

### Design tokens (from `tokens.js`)
```
BG       = '#09090B'   (page background)
CARD_BG  = '#0F1613'   (card background)
BORDER   = '#1a2e1f'   (subtle green border)
GREEN    = '#22c55e'   (primary accent)
GREEN_LT = '#4ade80'   (lighter green)
WHITE    = '#F8FAFC'   (text white)
MUTED    = '#94A3B8'   (secondary text)
DIM      = '#475569'   (tertiary text)
DANGER   = '#ef4444'   (red alerts)
```

### Style constants (defined at top of `blog.jsx`)
These are the ONLY style objects to use. Do not create new ones.

```jsx
const h2 = { fontSize: 22, fontWeight: 700, color: WHITE, marginTop: 36, marginBottom: 12 };
const h3 = { fontSize: 18, fontWeight: 700, color: WHITE, marginTop: 28, marginBottom: 8 };
const p  = { color: MUTED, fontSize: 15, lineHeight: 1.7, marginBottom: 16 };
const ul = { margin: '4px 0 16px', paddingLeft: 20, display: 'flex', flexDirection: 'column', gap: 8, color: MUTED, fontSize: 15, lineHeight: 1.7 };
const ol = { ...ul };
const a  = { color: GREEN, textDecoration: 'none' };
const strong = { color: WHITE };
const bq = { borderLeft: `3px solid ${GREEN}`, paddingLeft: 16, marginLeft: 0, marginBottom: 16, fontStyle: 'italic', color: MUTED, fontSize: 15, lineHeight: 1.7 };
const code = { background: '#1a2e1f', padding: '2px 6px', borderRadius: 4, fontSize: 13, fontFamily: 'ui-monospace, monospace', color: GREEN };
const hr = { border: 'none', borderTop: `1px solid ${BORDER}`, margin: '32px 0' };
```

### JSX content function pattern
Every blog post is a named function component returning a `<>` fragment:

```jsx
function MyPostTitle() {
  return (
    <>
      <p style={p}>Opening paragraph — state the reader pain + promise of what they will learn.</p>

      <h2 style={h2}>Section Title</h2>
      <p style={p}>Explanation text with <strong style={strong}>bold highlights</strong> for key points.</p>

      <ul style={ul}>
        <li><strong style={strong}>Bold label</strong> — description of this item</li>
        <li><strong style={strong}>Another item</strong> — more detail here</li>
      </ul>

      <h3 style={h3}>Subsection Title</h3>
      <ol style={ol}>
        <li><strong style={strong}>Step one</strong> — do this first</li>
        <li><strong style={strong}>Step two</strong> — then do this</li>
      </ol>

      <blockquote style={bq}>Key callout or insight worth highlighting.</blockquote>

      <p style={p}>
        Natural CTA: <a href="/signup" style={a}>Try Tally free</a> — woven into the narrative.
      </p>

      <hr style={hr} />

      <h2 style={h2}>FAQ</h2>
      <h3 style={h3}>Common question about the topic?</h3>
      <p style={p}>Clear, direct answer.</p>
    </>
  );
}
```

### BLOG_POSTS entry schema
```js
{
  slug: 'kebab-case-url-slug',
  title: 'Display Title for the Post',
  metaTitle: 'SEO Title (50-60 chars) — Tally',
  metaDescription: 'SEO description (150-160 chars with primary keyword).',
  excerpt: 'Preview text for blog index cards (1-2 sentences).',
  date: '2026-03-08',
  author: 'Andrew Disbrow',
  authorRole: 'Founder, Tally',
  readTime: '8 min read',
  tags: ['Tag1', 'Tag2'],
  keywords: ['primary keyword', 'secondary keyword 1', 'secondary keyword 2'],
  content: MyPostTitle,
}
```

### Formatting rules
- **No `<h1>`** — the page layout renders the title as h1 already.
- **No images** — the blog does not currently support embedded images.
- **No CSS classes** — all styling is inline via the style constants above.
- **Internal links** use relative paths: `/signup`, `/blog/other-slug`, `/help`.
- **External links** use `target="_blank"` and `rel="noopener noreferrer"`.
- **Code inline** uses `<code style={code}>text</code>` for IPs, commands, config values.
- **CTA placement** — embed 2-3 natural CTAs throughout, link to `/signup` by default.
- **`readTime` formula** — estimate ~200 words per minute, format as `"N min read"`.
- **`date` format** — ISO `YYYY-MM-DD`, use the publish date.
- **Function name** — PascalCase, descriptive, matches the topic (e.g., `ChurchAudioStreamingGuide`).
- **Fragment wrapper** — always return `<>...</>`, not a `<div>`.
- **BlogCTA component** — rendered automatically by the page layout after content. Do not add it inside the content function.
- **New posts go at top** of the BLOG_POSTS array (newest first).

---

## Existing Blog Posts (Cannibalization Check)

Before writing, verify the new topic does not overlap with these:

| Slug | Title | Tags |
|------|-------|------|
| `church-live-stream-setup-guide` | Complete Guide to Church Live Streaming in 2026 | Live Streaming, Setup Guide |
| `atem-mini-church-production-setup` | ATEM Mini Setup for Church Production | ATEM, Setup Guide |
| `church-production-volunteer-training` | Training Church Volunteers for Production | Team Management, Volunteers |
| `church-streaming-troubleshooting` | Church Streaming Troubleshooting: 10 Problems and Fixes | Troubleshooting, Live Streaming |
| `remote-church-production-monitoring` | How to Monitor Your Church Production Remotely | Monitoring, Remote Control |
| `church-av-network-setup-guide` | Church AV Network Setup: Static IPs, Switches | Networking, Setup Guide |
| `best-ptz-cameras-for-church` | Best PTZ Cameras for Church Live Streaming | Cameras, Setup Guide |
| `propresenter-atem-integration-guide` | ProPresenter + ATEM Integration Guide | ProPresenter, ATEM |
| `church-audio-live-streaming-guide` | Church Audio for Live Streaming | Audio, Live Streaming |

### Existing tags
Live Streaming, Setup Guide, ATEM, Team Management, Volunteers, Troubleshooting, Monitoring, Remote Control, Networking, Cameras, ProPresenter, Audio

---

## Research-First Requirement

Do not start drafting until research is complete.

Minimum research output:
- 5+ relevant external sources from current search results (URL + date accessed).
- Source type per link: `official-doc`, `platform-help`, `industry-blog`, `competitor`, `community`.
- Published/updated date when available.
- Search intent summary (what the reader is trying to solve).
- SERP pattern map for the target keyword:
  - Common title patterns in top results
  - Typical section structure (H2/H3 themes)
  - Content depth expectation (word count range of top results)
  - Likely intent: `informational`, `commercial`, `comparison`, `transactional`
  - SERP features present: featured snippet, PAA, video carousel, knowledge panel
- Gap analysis against existing Tally posts (see table above).
- Risk check: identify claims that need careful wording.
- Fact discipline: no fabricated citations, data points, benchmarks, or quotes.

---

## Workflow

1. **Research** — Gather current sources, summarize intent + content gaps.
2. **Title/Hook ideation** — Generate exactly 3 options, each with:
   - Title (benefit-driven, keyword-forward)
   - Opening hook (2-3 sentences)
   - Why this angle converts
   - Why this angle ranks
3. **Approval gate** — STOP. Wait for explicit user approval. Do not draft before approval.
4. **Build outline** — Create H2/H3 structure with logical progression.
5. **Draft** — Write in Tally voice. Short paragraphs, clear headers, concrete examples.
6. **Voice pass** — Read 2-3 existing posts in `blog.jsx` to calibrate. Rewrite to match tone.
7. **Draft review gate** — Return full draft. Wait for edits/feedback. Do not publish.
8. **Revise** — Apply edits, tighten intro, improve transitions, strengthen CTA.
9. **Final approval gate** — Return revised draft. Wait for explicit final approval. Do not publish.
10. **Validate** — Run pre-publish checklist (see below).
11. **Publish** — Insert into `blog.jsx`, build, commit, push, deploy.
12. **Post-publish SEO** — Return indexing checklist and internal link opportunities.

---

## Pre-Publish Validation Checklist

Before publish, verify ALL:
- [ ] Slug is unique (not in existing BLOG_POSTS)
- [ ] Topic does not cannibalize an existing post
- [ ] All required fields present: `slug`, `title`, `metaTitle`, `metaDescription`, `excerpt`, `date`, `author`, `authorRole`, `readTime`, `tags`, `keywords`, `content`
- [ ] `readTime` format: `"N min read"`
- [ ] `metaTitle` ends with ` — Tally`, 50-60 characters total
- [ ] `metaDescription` is 150-160 characters
- [ ] Internal links point to real Tally routes
- [ ] Content function uses only existing style constants
- [ ] Content function returns `<>...</>` fragment, not `<div>`
- [ ] Function name is unique and PascalCase
- [ ] Tags reuse existing tag names where applicable
- [ ] Primary keyword appears in: title, slug, metaDescription, opening paragraph, at least one H2
- [ ] `npm run build` passes without errors

---

## Publish Workflow

1. Insert new content function + BLOG_POSTS entry at **top** of array in:
   `/Volumes/DataDisk/openclaw-workspace/tally-landing/lib/blog.jsx`
2. Build: `cd /Volumes/DataDisk/openclaw-workspace/tally-landing && npm run build`
3. Commit: `git add lib/blog.jsx && git commit -m "Add blog post: <slug>"`
4. Push: `git push`
5. Deploy: `cd /Volumes/DataDisk/openclaw-workspace/tally-landing && npx vercel deploy --prod -y`
6. Return: slug, commit hash, production URL (`tallyconnect.app/blog/<slug>`), Vercel inspect URL.

## Rollback Protocol
If build or deploy fails:
1. Stop publish sequence immediately.
2. Return failure details + failed command output.
3. Provide exact rollback command or revert commit hash.
4. Do not retry deploy without fixing the code error first.

---

## Output Format by Stage

**Stage 1: RESEARCH_AND_OPTIONS**
- Research brief (sources, SERP map, gaps, risks).
- Exactly 3 title + hook options with ranking and conversion rationale.
- Wait for user selection.

**Stage 2: TALLY_BLOG_DRAFT**
- Full JSX content function using existing style constants.
- Draft BLOG_POSTS entry object.
- Ask for edits/feedback.

**Stage 3: TALLY_BLOG_FINAL**
- Revised content function.
- Final BLOG_POSTS entry.
- SEO_JSON (keyword placement, internal/external links, FAQ schema candidates).
- SOCIAL_COPY (X/Twitter, Facebook/LinkedIn, Email teaser).
- Wait for explicit final approval.

**Stage 4: PUBLISH_RESULT** (after final approval only)
- Slug, changed files, build result, commit hash, production URL, inspect URL.
- SEO_NEXT_ACTIONS: live URL, sitemap check, Google Search Console URL inspection target, 2-3 internal link opportunities from existing posts/pages.

---

## Quality Gates
- Title is specific and benefit-driven (not generic clickbait).
- Intro states pain + promise in first 120 words.
- Every section advances one clear point.
- Includes practical steps/checklists (not abstract talk).
- CTA is explicit and matches post intent.
- No invented facts, numbers, or quotes.
- Readability: plain language, active voice, short paragraphs.
- Voice: operator-led, practical, church-tech perspective, zero hype.
- Primary keyword distributed naturally, not stuffed.
- Includes FAQ section for long-tail / People Also Ask capture.
- Includes 1-3 credible external references where useful.
- Includes internal links to `/signup` and related blog posts.

## Default Writing Rules
- Prefer concrete instructions over theory.
- Keep sentences varied but concise.
- Avoid hype words: "game-changer", "revolutionary", "seamless", "cutting-edge".
- Use numbered steps where action is required.
- Use bullets for checklists and options.
- Include one "quick win" section early in the post.
- Address the reader directly ("you", "your team").

## File Targets (If Writing to Disk)
- `output/blog/<slug>.research.md`
- `output/blog/<slug>.tally-blog-code.jsx`
- `output/blog/<slug>.seo.json`
- `output/blog/<slug>.social.md`

## Starter Commands
- Stage 1: `prompts/title-options.md`
- Stage 2: `prompts/write-and-publish.md`
- Stage 3: `prompts/revise-final.md`
- Stage 4: `prompts/publish-approved.md`
