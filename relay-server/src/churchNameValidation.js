/**
 * Church display-name checks for self-service signup / onboard.
 *
 * Rejects URL bait, shorteners, and casino/spam copy without blocking
 * short real names (LCC, Cogcomm, St. Mary's).
 */

'use strict';

const MIN_CHURCH_NAME_LENGTH = 2;
const MAX_CHURCH_NAME_LENGTH = 80;

const URL_OR_SHORTENER = /https?:\/\/|www\.|\b(?:bit\.ly|tinyurl\.com|t\.co|goo\.gl|ow\.ly|is\.gd|cutt\.ly|rebrand\.ly|rb\.gy|tiny\.cc|shorturl\.at)\b/i;

// Domain-like bait (foo.com, foo.net/path). Shortener TLDs such as .ly are
// handled above so we do not treat "St. Ly" style punctuation as a URL.
const BARE_DOMAIN = /\b[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.(?:com|net|org|io|info|biz|xyz|ru|cn|top|click|link|site|online|shop|store|vip|app|bet|casino)\b/i;

const SPAM_KEYWORDS = /\b(?:casinos?|betting|sportsbook|poker|slots?|viagra|cialis|xanax|forex|airdrop|jackpots?|wagers?|wagering|gambling|gambles?|roulette|blackjack|onlyfans|porn|xxx|backlinks?|crypto|nfts?|phentermine|tramadol|free[\s-]?spins?|bonus[\s-]?codes?)\b/i;

const HTML_OR_EMAIL = /<[^>]+>|\b[^\s@]+@[^\s@]+\.[^\s@]+\b/;
const CONTROL_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const HAS_LETTER = /\p{L}/u;

const GENERIC_INVALID = 'Enter a valid church name';

function normalizeChurchName(name) {
  return String(name || '').trim().replace(/\s+/g, ' ');
}

function validateChurchName(name) {
  const clean = normalizeChurchName(name);
  if (!clean) {
    return { ok: false, error: 'name required' };
  }
  if (clean.length < MIN_CHURCH_NAME_LENGTH) {
    return { ok: false, error: GENERIC_INVALID };
  }
  if (clean.length > MAX_CHURCH_NAME_LENGTH) {
    return { ok: false, error: 'Church name is too long' };
  }
  if (CONTROL_CHARS.test(clean) || HTML_OR_EMAIL.test(clean)) {
    return { ok: false, error: GENERIC_INVALID };
  }
  if (URL_OR_SHORTENER.test(clean) || BARE_DOMAIN.test(clean) || SPAM_KEYWORDS.test(clean)) {
    return { ok: false, error: GENERIC_INVALID };
  }
  if (!HAS_LETTER.test(clean)) {
    return { ok: false, error: GENERIC_INVALID };
  }
  return { ok: true, name: clean };
}

const TEST_OR_PLACEHOLDER_NAME = /^(?:test|demo|asdf|spam|foo|xxx|zzz)(?:\s|$)|(?:\btest church\b|\bdemo church\b|\blorem ipsum\b)/i;

/**
 * Soft-hide junk / smoke tenants in the admin fleet list.
 * Name heuristics reuse signup validation (URL / casino / spam copy).
 * Also hides never-seen + inactive, or an explicit is_test / is_spam flag.
 */
function isLikelyTestOrSpamChurch(church = {}) {
  if (church.is_test || church.is_spam || church.church_type === 'test') return true;
  const name = normalizeChurchName(church.name);
  if (name && TEST_OR_PLACEHOLDER_NAME.test(name)) return true;
  if (name && !validateChurchName(name).ok) return true;
  const neverSeen = !church.lastSeen && !church.connected;
  const inactive = String(church.billing_status || 'inactive').toLowerCase() === 'inactive';
  return neverSeen && inactive;
}

module.exports = {
  MIN_CHURCH_NAME_LENGTH,
  MAX_CHURCH_NAME_LENGTH,
  normalizeChurchName,
  validateChurchName,
  isLikelyTestOrSpamChurch,
};
