# Post Structure (JSX)

No H1 — the page layout renders the title.

```
Opening paragraph (p)
  — State reader pain
  — Promise what they will learn
  — Include primary keyword

H2: Quick Win
  — One actionable step the reader can do immediately

H2: Core Section (include primary keyword)
  — Explanation (p)
  — Bullet list (ul) or numbered steps (ol)
  — Bold labels with dash descriptions

  H3: Subsection detail
    — Deeper walkthrough
    — Code snippets for technical values

H2: Second Major Section
  — Practical advice, checklists, or comparisons
  — Inline CTA to /signup (natural, not forced)

H2: Common Mistakes / What to Avoid
  — 3-5 pitfalls with fixes

Horizontal rule (hr)

H2: FAQ
  H3: Question matching PAA / long-tail query?
    — Direct answer (2-3 sentences)
  H3: Second question?
    — Answer

H2: Wrapping Up
  — 2-3 sentence summary
  — Final CTA link to /signup
```

## Key Patterns from Existing Posts

- **Symptom/Fix/Prevention** — for troubleshooting posts
- **Week 1-4 phased checklists** — for training/onboarding posts
- **Equipment comparison tables** — rendered as bold-label bullet lists (no HTML tables)
- **IP address / config examples** — use `<code style={code}>` inline
- **Internal links** — weave naturally: "Learn more in our [guide to X](/blog/slug)"
