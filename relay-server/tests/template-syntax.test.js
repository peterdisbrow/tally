/**
 * Validates that generated client-side JS inside HTML templates is syntactically valid.
 *
 * WHY THIS EXISTS:
 * The church portal and admin panel generate full HTML pages with embedded <script>
 * blocks via Node.js template literals. A single misescaped quote (e.g. \' vs \\')
 * can silently produce broken client JS that crashes the entire page at runtime.
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
 */
function extractAndValidateClientJs(html, label) {
  const scriptBlocks = [];
  const re = /<script>([\s\S]*?)<\/script>/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    scriptBlocks.push(match[1]);
  }

  expect(scriptBlocks.length, `${label}: should contain at least one <script> block`).toBeGreaterThan(0);

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
    // Portal JS is now an external static file (portal.js), not inline <script> blocks.
    // Validate the static file directly for syntax errors.
    const fs = require('fs');
    const path = require('path');
    const portalJs = fs.readFileSync(path.join(__dirname, '../public/portal/portal.js'), 'utf8');
    expect(portalJs.length).toBeGreaterThan(0);

    let syntaxError = null;
    try {
      new vm.Script(portalJs, { filename: 'portal.js' });
    } catch (e) {
      syntaxError = e;
    }
    expect(syntaxError, `portal.js has a syntax error: ${syntaxError?.message}`).toBeNull();
  });

  it('generates valid JS with various billing tiers', () => {
    // Portal JS no longer uses server-side template interpolation per tier —
    // it's a static file. Verify the HTML template renders for each tier.
    const { _buildChurchPortalHtml } = require('../src/churchPortal');

    for (const tier of ['connect', 'plus', 'pro', 'managed', 'event']) {
      const church = {
        churchId: `test-church-${tier}`,
        name: `Test Church (${tier})`,
        email: 'td@test.com',
        billing_tier: tier,
      };

      const html = _buildChurchPortalHtml(church);
      expect(html, `churchPortal-tier-${tier}: should generate HTML`).toBeDefined();
      expect(html.length).toBeGreaterThan(0);
    }
  });
});

// ─── Admin Panel ──────────────────────────────────────────────────────────────

describe('Admin Panel template', () => {
  it('generates valid client-side JavaScript for the dashboard', () => {
    const { _buildAdminDashboardHtml } = require('../src/adminPanel');
    expect(_buildAdminDashboardHtml, 'buildAdminDashboardHtml should be exported').toBeDefined();

    const html = _buildAdminDashboardHtml();
    expect(html).toContain('<script>');
    expect(html).toContain('</script>');

    extractAndValidateClientJs(html, 'adminDashboard');
  });

  it('generates valid HTML for the login page', () => {
    const { _buildAdminLoginHtml } = require('../src/adminPanel');

    // Without error
    const htmlOk = _buildAdminLoginHtml();
    expect(htmlOk).toContain('Sign In');

    // With error
    const htmlErr = _buildAdminLoginHtml('1');
    expect(htmlErr).toContain('Invalid email or password');
  });
});
