/**
 * portal-url.js — pure URL builder for the cloud portal deep-links.
 *
 * Extracted from renderer.js so the routing logic that PR #60 fixed
 * (engineer link must hit the cloud portal, not the hidden local tab) can
 * be exercised by unit tests without spinning up Electron + a DOM.
 *
 * Two invariants this module pins:
 *   1. The roomId currently active in the desktop app is appended as a query
 *      param so the portal opens to the same room the user is monitoring.
 *   2. Path arguments that already carry a "?" use "&" for the room param.
 *
 * Loaded twice: once via <script> tag for the renderer (publishes to window),
 * and once via require() for Node-based unit tests.
 */

/* eslint-disable no-unused-vars */

const PORTAL_BASE = 'https://tallyconnect.app/church-portal';

/**
 * Build a portal URL.
 *
 * @param {string|null|undefined} pathOrQuery - "?page=engineer", "/team", or empty
 * @param {string|number|null|undefined} roomId - currently-active room
 * @returns {string} fully-qualified portal URL
 */
function buildPortalUrl(pathOrQuery, roomId) {
  let url = pathOrQuery ? `${PORTAL_BASE}${pathOrQuery}` : PORTAL_BASE;
  if (roomId !== undefined && roomId !== null && roomId !== '') {
    const sep = url.includes('?') ? '&' : '?';
    url = `${url}${sep}roomId=${encodeURIComponent(String(roomId))}`;
  }
  return url;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { PORTAL_BASE, buildPortalUrl };
}
