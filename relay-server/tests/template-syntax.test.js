/**
 * Validates that generated client-side JS inside HTML templates is syntactically valid.
 *
 * WHY THIS EXISTS:
 * The church portal generates full HTML pages with embedded <script> blocks via
 * Node.js template literals. A single misescaped quote (e.g. \' vs \\') can
 * silently produce broken client JS that crashes the entire page at runtime.
 * Node's syntax checker (node -c) only validates the server-side code, NOT the
 * generated client-side output. This test renders each template and parses the
 * resulting <script> content to catch these errors at test time.
 */

import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
import vm from 'vm';

const require = createRequire(import.meta.url);

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Extract all <script>...</script> blocks from an HTML string,
 * concatenate them, and validate JS syntax via vm.createScript().
 * Templates using external script files (e.g. <script src="...">) are also valid.
 */
function extractAndValidateClientJs(html, label) {
  const scriptBlocks = [];
  const re = /<script>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    scriptBlocks.push(match[1]);
  }

  // Accept templates that use external script files instead of inline scripts
  if (scriptBlocks.length === 0) {
    const hasExternalScripts = /<script\s+src=/.test(html);
    expect(hasExternalScripts, `${label}: should contain at least one <script> block or external script reference`).toBe(true);
    return;
  }

  const fullJs = scriptBlocks.join('\n;\n');

  // vm.createScript() parses without executing — catches syntax errors only
  let syntaxError = null;
  try {
    new vm.Script(fullJs, { filename: `${label}-client.js` });
  } catch (e) {
    syntaxError = e;
  }

  if (syntaxError) {
    // Find the offending line for a useful error message
    const lines = fullJs.split('\n');
    const lineMatch = syntaxError.message.match(/:(\d+)/);
    const lineNum = lineMatch ? parseInt(lineMatch[1]) : null;
    let context = '';
    if (lineNum) {
      const start = Math.max(0, lineNum - 4);
      const end = Math.min(lines.length, lineNum + 3);
      context = lines.slice(start, end).map((l, i) => {
        const num = start + i + 1;
        const marker = num === lineNum ? '>>> ' : '    ';
        return `${marker}${num}: ${l.substring(0, 120)}`;
      }).join('\n');
    }

    expect.fail(
      `${label}: generated client JS has a syntax error:\n` +
      `  ${syntaxError.message}\n` +
      (context ? `\nContext:\n${context}\n` : '')
    );
  }
}

// ─── Church Portal ────────────────────────────────────────────────────────────

describe('Church Portal template', () => {
  it('generates valid client-side JavaScript', () => {
    const { _buildChurchPortalHtml } = require('../src/churchPortal');
    expect(_buildChurchPortalHtml, 'buildChurchPortalHtml should be exported').toBeDefined();

    const church = {
      churchId: 'test-church-id',
      name: 'Test Church',
      email: 'td@test.com',
      billing_tier: 'connect',
      registeredAt: new Date().toISOString(),
    };

    const html = _buildChurchPortalHtml(church);
    expect(html).toMatch(/<script[\s>]/);

    extractAndValidateClientJs(html, 'churchPortal');
  });

  it('generates valid JS with various billing tiers', () => {
    const { _buildChurchPortalHtml } = require('../src/churchPortal');

    // Test each tier to make sure no conditional branches break the template
    for (const tier of ['connect', 'plus', 'pro', 'managed', 'event']) {
      const church = {
        churchId: `test-church-${tier}`,
        name: `Test Church (${tier})`,
        email: 'td@test.com',
        billing_tier: tier,
      };

      const html = _buildChurchPortalHtml(church);
      extractAndValidateClientJs(html, `churchPortal-tier-${tier}`);
    }
  });
});

