/**
 * portal-url.test.js — Cloud portal deep-link URL builder.
 *
 * The biggest concrete bug PR #60 fixed was the "View in Tally Engineer" link
 * routing to a hidden local tab instead of the cloud portal. These tests pin
 * the URL shape so a future renderer.js refactor can't regress it.
 *
 * Specifically:
 *   - engineer route uses `?page=engineer`
 *   - the active roomId is appended as `roomId=...` (NOT `room=...`)
 *   - "?" + "&" separator selection is correct
 */

'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { PORTAL_BASE, buildPortalUrl } = require('../src/portal-url');

test('PORTAL_BASE points to the production church portal', () => {
  assert.equal(PORTAL_BASE, 'https://tallyconnect.app/church-portal');
});

// ─── Engineer route — the PR #60 regression case ────────────────────────────

test('engineer route appends ?page=engineer and roomId via &', () => {
  // This is the exact link wired up by renderer.js runQuickSystemCheck after
  // PR #60. Tab-engineer is hidden behind display:none in index.html — if
  // the URL pattern silently drifts to "?engineer" or back to switchTab(),
  // users see a black screen again.
  const url = buildPortalUrl('?page=engineer', 'sanctuary');
  assert.equal(url, 'https://tallyconnect.app/church-portal?page=engineer&roomId=sanctuary');
});

test('engineer route without an active room omits roomId', () => {
  // Some users haven't selected a room yet — don't append a stray `roomId=`.
  const url = buildPortalUrl('?page=engineer', '');
  assert.equal(url, 'https://tallyconnect.app/church-portal?page=engineer');
});

// ─── Room param selection ───────────────────────────────────────────────────

test('roomId uses ? when path has no existing query string', () => {
  assert.equal(
    buildPortalUrl('/team', 'main-hall'),
    'https://tallyconnect.app/church-portal/team?roomId=main-hall',
  );
});

test('roomId uses & when path already contains a ?', () => {
  assert.equal(
    buildPortalUrl('?page=alerts', 'youth'),
    'https://tallyconnect.app/church-portal?page=alerts&roomId=youth',
  );
});

test('roomId is the right param name (regression: was sometimes "room")', () => {
  // The portal reads `roomId`, not `room`. Spelling matters — using the wrong
  // param name silently lands the user in their last-viewed room rather than
  // the room the desktop app is monitoring.
  const url = buildPortalUrl('?page=engineer', 'sanctuary');
  assert.match(url, /[?&]roomId=sanctuary(?:$|&)/);
  assert.doesNotMatch(url, /[?&]room=sanctuary(?:$|&)/);
});

test('roomId is URI-encoded for safety', () => {
  const url = buildPortalUrl('?page=engineer', 'Main Hall & Youth');
  assert.match(url, /roomId=Main%20Hall%20%26%20Youth/);
});

test('numeric roomId is coerced to string', () => {
  const url = buildPortalUrl('?page=engineer', 42);
  assert.match(url, /roomId=42$/);
});

// ─── No-args / empty-args behaviour ─────────────────────────────────────────

test('no path and no roomId returns bare portal URL', () => {
  assert.equal(buildPortalUrl(), 'https://tallyconnect.app/church-portal');
  assert.equal(buildPortalUrl(null, null), 'https://tallyconnect.app/church-portal');
  assert.equal(buildPortalUrl('', undefined), 'https://tallyconnect.app/church-portal');
});

test('path-only (no room) returns base + path', () => {
  assert.equal(
    buildPortalUrl('/billing'),
    'https://tallyconnect.app/church-portal/billing',
  );
});
