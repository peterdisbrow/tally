/**
 * Booth clock directory redirect + Studio Clock share path contracts.
 *
 * /tools/clock/ must redirect BEFORE express.static serves the SPA quote home.
 */
import { describe, expect, it } from 'vitest';
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const require = createRequire(import.meta.url);
const express = require('express');
const { createClient } = require('./helpers/expressTestClient');

const { legacyViewDisplayRedirect } = require('../src/rundownCanonical');

const here = path.dirname(fileURLToPath(import.meta.url));
const serverSrc = fs.readFileSync(path.join(here, '../server.js'), 'utf8');
const clockHtml = fs.readFileSync(path.join(here, '../public/rundown-clock.html'), 'utf8');
const liveRundownSrc = fs.readFileSync(path.join(here, '../src/routes/liveRundown.js'), 'utf8');
const rundownCanonicalSrc = fs.readFileSync(path.join(here, '../src/rundownCanonical.js'), 'utf8');
const portalSrc = fs.readFileSync(path.join(here, '../public/portal/portal.js'), 'utf8');

function buildBoothClockApp() {
  const app = express();
  app.get(['/tools/clock', '/tools/clock/'], (_req, res) => res.redirect(302, '/tools/clock/clock'));
  app.use('/tools', express.static(path.join(here, '../public/tools')));
  app.get('/clock', (_req, res) => res.redirect(301, '/tools/clock/clock'));
  app.get('/rundown/view/:token', (req, res) => {
    const dedicated = legacyViewDisplayRedirect(req.params.token, req.query);
    if (dedicated) return res.redirect(302, dedicated);
    res.status(200).send('view');
  });
  app.get('/tools/clock/*', (_req, res) => {
    res.sendFile(path.join(here, '../public/tools/clock/index.html'));
  });
  return app;
}

describe('booth clock routes', () => {
  it('registers the /tools/clock/ redirect before static /tools in server.js', () => {
    const redirectIdx = serverSrc.indexOf("app.get(['/tools/clock', '/tools/clock/']");
    const staticIdx = serverSrc.indexOf("app.use('/tools', express.static");
    expect(redirectIdx).toBeGreaterThan(-1);
    expect(staticIdx).toBeGreaterThan(-1);
    expect(redirectIdx).toBeLessThan(staticIdx);
    expect(serverSrc).toContain("res.redirect(302, '/tools/clock/clock')");
  });

  it('redirects directory index variants to the Production Clock', async () => {
    const client = createClient(buildBoothClockApp());
    for (const url of ['/tools/clock', '/tools/clock/']) {
      const res = await client.get(url);
      expect(res.status, url).toBe(302);
      expect(res.headers.location).toBe('/tools/clock/clock');
    }
  });

  it('keeps /clock, the clock SPA, and the quote page reachable', async () => {
    const client = createClient(buildBoothClockApp());

    const alias = await client.get('/clock');
    expect(alias.status).toBe(301);
    expect(alias.headers.location).toBe('/tools/clock/clock');

    const clock = await client.get('/tools/clock/clock');
    expect(clock.status).toBe(200);
    expect(clock.text).toContain('TallyConnect Production Clock');

    const quote = await client.get('/tools/clock/index.html');
    expect(quote.status).toBe(200);
    expect(quote.text).toContain('TallyConnect Production Clock');
  });

  it('serves the tally-landing Production Clock hashes and drops stale bundles', () => {
    const clockDir = path.join(here, '../public/tools/clock');
    const html = fs.readFileSync(path.join(clockDir, 'index.html'), 'utf8');
    const assets = fs.readdirSync(path.join(clockDir, 'assets'));

    expect(html).toContain('/tools/clock/assets/index-DR04vamf.js');
    expect(html).toContain('/tools/clock/assets/index-BBVGjS4P.css');
    expect(html).not.toContain('index-BREot0gW.js');
    expect(html).not.toContain('index-C3SVvvwb.css');

    expect(assets).toEqual(expect.arrayContaining([
      'hero-bg-CMFx691j.jpg',
      'index-BBVGjS4P.css',
      'index-DR04vamf.js',
      'Index-DQuTWlas.js',
    ]));
    expect(assets).not.toContain('index-BREot0gW.js');
    expect(assets).not.toContain('index-C3SVvvwb.css');
  });

  it('redirects legacy view?mode=clock shares to /rundown/clock/:token', async () => {
    const client = createClient(buildBoothClockApp());
    const res = await client.get('/rundown/view/abc123?mode=clock&theme=light');
    expect(res.status).toBe(302);
    expect(res.headers.location).toBe('/rundown/clock/abc123?theme=light');
  });

  it('redirects legacy teleprompter and confidence view modes to dedicated pages', async () => {
    const client = createClient(buildBoothClockApp());

    const prompter = await client.get('/rundown/view/abc123?mode=teleprompter&theme=light');
    expect(prompter.status).toBe(302);
    expect(prompter.headers.location).toBe('/rundown/prompter/abc123?theme=light');

    const confidence = await client.get('/rundown/view/abc123?mode=confidence');
    expect(confidence.status).toBe(302);
    expect(confidence.headers.location).toBe('/rundown/confidence/abc123');

    const largeText = await client.get('/rundown/view/abc123?mode=prompter');
    expect(largeText.status).toBe(200);
    expect(largeText.text).toBe('view');
  });
});

describe('studio clock client contracts', () => {
  it('uses server_timestamp, stops reconnect on invalid token, and loads sync helper', () => {
    expect(clockHtml).toContain('src="/tools/studio-clock-sync.js"');
    expect(clockHtml).toContain('applyServerStamp(msg.server_timestamp)');
    expect(clockHtml).toContain('isInvalidTokenClose');
    expect(clockHtml).toContain('Link expired / invalid');
    expect(clockHtml).toContain('showExpiredState');
    expect(clockHtml).toMatch(/if \(tokenInvalid\) return/);
  });

  it('includes dedicated display URLs on rundown share API payloads', () => {
    expect(rundownCanonicalSrc).toContain('clock_url: `${root}/rundown/clock/${token}`');
    expect(rundownCanonicalSrc).toContain('prompter_url: `${root}/rundown/prompter/${token}`');
    expect(rundownCanonicalSrc).toContain('confidence_url: `${root}/rundown/confidence/${token}`');
    expect(serverSrc).toContain('legacyViewDisplayRedirect');
    expect(liveRundownSrc).toContain('packShareBundle');
    expect(liveRundownSrc).toContain('decorateShare');
  });
});

describe('portal production-display share cards', () => {
  it('links teleprompter, confidence, and clock to dedicated routes', () => {
    const productionBlock = portalSrc.split('// Production displays:')[1].split('if (outputSuite)')[0];
    expect(productionBlock).toContain('url: urls.prompterUrl');
    expect(productionBlock).toContain('url: urls.confidenceUrl');
    expect(productionBlock).toContain('url: urls.clockUrl');
    expect(productionBlock).not.toContain("'teleprompter'");
    expect(productionBlock).not.toContain("_rundownBuildModeUrl(publicUrl, 'confidence'");
    expect(productionBlock).not.toContain("_rundownBuildModeUrl(publicUrl, 'clock'");
    expect(portalSrc).toContain("'/rundown/prompter/'");
    expect(portalSrc).toContain("'/rundown/confidence/'");
    expect(portalSrc).toContain("'/rundown/clock/'");
  });
});
