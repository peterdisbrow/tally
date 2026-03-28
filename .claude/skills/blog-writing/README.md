# Blog Writing Skill

## Location
`.claude/skills/blog-writing/`

## Files
- `SKILL.md` — Full behavior contract: workflow, format spec, quality gates, existing post list
- `prompts/new-post.md` — Full pipeline prompt (research → draft → revise → publish)
- `prompts/title-options.md` — Stage 1: research + 3 title/hook options
- `prompts/write-and-publish.md` — Stage 2: first draft (after title approval)
- `prompts/revise-final.md` — Stage 3: apply edits + final draft
- `prompts/publish-approved.md` — Stage 4: publish to production (after final approval)
- `templates/tally-blog-entry.js` — Full example: JSX content function + BLOG_POSTS entry
- `templates/post-structure.md` — JSX section skeleton with pattern examples
- `templates/frontmatter.md` — Pre-draft planning checklist
- `templates/research-brief.md` — SERP research output template
- `templates/seo.json` — SEO metadata structure with keyword placement checklist
- `templates/social-copy.md` — Social media + email copy templates with examples

## Quick Use
1. Give topic + keyword → run `prompts/title-options.md` (Stage 1)
2. Approve one title/hook option
3. Run `prompts/write-and-publish.md` (Stage 2) → get first draft
4. Give edits → run `prompts/revise-final.md` (Stage 3) → get final draft + SEO + social
5. Give final approval → run `prompts/publish-approved.md` (Stage 4) → live on production

## Key Details
- Blog format is **React JSX with inline styles** (not markdown)
- All posts live in `tally-landing/lib/blog.jsx` as named function components
- Style constants (h2, h3, p, ul, ol, a, strong, bq, code, hr) are pre-defined — do not create new ones
- Domain: `tallyconnect.app/blog`
- Deploy: Vercel (`npx vercel deploy --prod -y`)
- 9 existing posts — check SKILL.md for the full list before writing
