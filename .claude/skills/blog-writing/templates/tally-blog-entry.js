// ── Content function ─────────────────────────────────────────────────────────
// Insert ABOVE the existing post functions in lib/blog.jsx.
// Function name must be PascalCase and unique.

function PostFunctionName() {
  return (
    <>
      <p style={p}>Opening paragraph — state the reader pain and what they will learn.
      Include the primary keyword naturally in this first paragraph.</p>

      <h2 style={h2}>Quick Win Section</h2>
      <p style={p}>One immediately actionable step the reader can take right now.</p>

      <h2 style={h2}>Main Section (Primary Keyword in H2)</h2>
      <p style={p}>Core explanation with <strong style={strong}>bold key points</strong>.</p>

      <ul style={ul}>
        <li><strong style={strong}>Item label</strong> — description of this point</li>
        <li><strong style={strong}>Another label</strong> — description continues</li>
      </ul>

      <h3 style={h3}>Subsection with Detail</h3>
      <p style={p}>Deeper explanation. Use <code style={code}>inline code</code> for
      technical values like IPs, commands, or config settings.</p>

      <ol style={ol}>
        <li><strong style={strong}>Step one</strong> — concrete instruction</li>
        <li><strong style={strong}>Step two</strong> — next action</li>
        <li><strong style={strong}>Step three</strong> — final step</li>
      </ol>

      <blockquote style={bq}>Key insight or callout worth highlighting.</blockquote>

      <h2 style={h2}>Common Mistakes</h2>
      <p style={p}>What to avoid and why.</p>

      <p style={p}>
        Natural CTA: <a href="/signup" style={a}>Try Tally free</a> — woven into the narrative,
        not forced.
      </p>

      <hr style={hr} />

      <h2 style={h2}>FAQ</h2>
      <h3 style={h3}>Question that matches a People Also Ask query?</h3>
      <p style={p}>Clear, direct answer in 2-3 sentences.</p>

      <h3 style={h3}>Another common question?</h3>
      <p style={p}>Answer with practical detail.</p>

      <h2 style={h2}>Wrapping Up</h2>
      <p style={p}>Brief summary of key takeaways. End with a call to action:
      {' '}<a href="/signup" style={a}>Get started with Tally</a>.</p>
    </>
  );
}


// ── BLOG_POSTS entry ─────────────────────────────────────────────────────────
// Insert at the TOP of the BLOG_POSTS array (newest first).

{
  slug: 'kebab-case-url-slug',
  title: 'Display Title for the Post',
  metaTitle: 'SEO Title Under 60 Chars — Tally',
  metaDescription: 'SEO description under 160 chars. Include primary keyword naturally.',
  excerpt: 'Preview text shown on the blog index card (1-2 sentences).',
  date: '2026-03-08',
  author: 'Andrew Disbrow',
  authorRole: 'Founder, Tally',
  readTime: '8 min read',
  tags: ['Tag1', 'Tag2'],
  keywords: ['primary keyword', 'secondary 1', 'secondary 2', 'secondary 3'],
  content: PostFunctionName,
},
