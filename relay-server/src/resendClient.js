/**
 * Shared Resend REST helper.
 *
 * No Resend SDK — raw fetch + Svix HMAC for webhooks. Used by
 * LifecycleEmails.sendEmail, the bypass senders, and server.js
 * sendOnboardingEmail so retries / tags / reply_to stay consistent.
 */

const crypto = require('crypto');

const RESEND_EMAILS_URL = 'https://api.resend.com/emails';
const MAX_ATTEMPTS = 3;
const DEFAULT_BACKOFF_MS = [500, 1000];
const IDEMPOTENCY_MAX_LEN = 256;
const TAG_MAX_LEN = 256;
const WEBHOOK_TOLERANCE_SEC = 300;

function sanitizeTagValue(value) {
  const raw = String(value == null ? '' : value);
  const cleaned = raw.replace(/[^A-Za-z0-9_-]/g, '_').replace(/_+/g, '_');
  const trimmed = cleaned.replace(/^_+|_+$/g, '') || 'untagged';
  return trimmed.slice(0, TAG_MAX_LEN);
}

function sanitizeTags(tags) {
  if (!Array.isArray(tags)) return [];
  return tags
    .filter((tag) => tag && (tag.name || tag.value))
    .map((tag) => ({
      name: sanitizeTagValue(tag.name || 'tag'),
      value: sanitizeTagValue(tag.value),
    }));
}

function buildIdempotencyKey({ churchId, emailType, requestId } = {}) {
  const parts = ['tally', churchId || 'unknown', emailType || 'email'];
  if (requestId) parts.push(String(requestId));
  const key = parts.map((part) => String(part).replace(/\s+/g, '-')).join('/');
  return key.slice(0, IDEMPOTENCY_MAX_LEN);
}

function extractTokenFromUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(String(url), 'https://tallyconnect.app');
    return String(parsed.searchParams.get('token') || '').trim();
  } catch {
    const match = String(url).match(/[?&]token=([^&]+)/);
    return match ? decodeURIComponent(match[1]) : '';
  }
}

function resolveReplyTo({ replyTo, env = process.env } = {}) {
  const explicit = String(replyTo || env.EMAIL_REPLY_TO || '').trim();
  return explicit || undefined;
}

function isRetryableStatus(status, bodyText) {
  if (status === 429 || status >= 500) return true;
  if (status === 409 && /concurrent_idempotent/i.test(bodyText || '')) return true;
  return false;
}

function defaultSleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * POST https://api.resend.com/emails with Idempotency-Key and bounded retry.
 * Retries 429 / 5xx / network / concurrent-409 only. Same key on every attempt.
 */
async function sendResendEmail({
  apiKey,
  from,
  replyTo,
  to,
  subject,
  html,
  text,
  tags,
  idempotencyKey,
  fetchFn = globalThis.fetch,
  sleep = defaultSleep,
  backoffMs = DEFAULT_BACKOFF_MS,
  maxAttempts = MAX_ATTEMPTS,
} = {}) {
  if (!apiKey) return { sent: false, reason: 'no-api-key', attempts: 0 };
  if (!to) return { sent: false, reason: 'no-recipient', attempts: 0 };
  if (typeof fetchFn !== 'function') {
    return { sent: false, reason: 'network-error', attempts: 0, detail: 'fetch unavailable' };
  }

  const recipients = Array.isArray(to) ? to : [to];
  const body = {
    from,
    to: recipients,
    subject,
    html,
    text: text || '',
    tags: sanitizeTags(tags),
  };
  const resolvedReplyTo = resolveReplyTo({ replyTo });
  if (resolvedReplyTo) body.reply_to = resolvedReplyTo;

  const headers = {
    Authorization: `Bearer ${apiKey}`,
    'Content-Type': 'application/json',
  };
  if (idempotencyKey) {
    headers['Idempotency-Key'] = String(idempotencyKey).slice(0, IDEMPOTENCY_MAX_LEN);
  }

  let lastReason = 'resend-error';
  let lastDetail = '';
  let lastStatus = 0;
  const attempts = Math.max(1, Number(maxAttempts) || MAX_ATTEMPTS);

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      const res = await fetchFn(RESEND_EMAILS_URL, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      lastStatus = res.status;
      if (res.ok) {
        const data = await res.json();
        return { sent: true, id: data.id, attempts: attempt + 1 };
      }

      const err = await res.text();
      lastDetail = err;
      lastReason = 'resend-error';
      if (!isRetryableStatus(res.status, err) || attempt === attempts - 1) {
        return {
          sent: false,
          reason: 'resend-error',
          status: res.status,
          detail: err,
          attempts: attempt + 1,
        };
      }
    } catch (e) {
      lastReason = 'network-error';
      lastDetail = e.message;
      if (attempt === attempts - 1) {
        return {
          sent: false,
          reason: 'network-error',
          detail: e.message,
          attempts: attempt + 1,
        };
      }
    }

    const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)] || 0;
    if (wait) await sleep(wait);
  }

  return {
    sent: false,
    reason: lastReason,
    status: lastStatus || undefined,
    detail: lastDetail,
    attempts,
  };
}

function headerValue(headers, name) {
  if (!headers) return '';
  const lower = name.toLowerCase();
  if (typeof headers.get === 'function') {
    return headers.get(name) || headers.get(lower) || '';
  }
  return headers[name] || headers[lower] || headers[name.replace(/-/g, '')] || '';
}

function timingSafeEqualString(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    crypto.timingSafeEqual(bufA, bufA);
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

/**
 * Verify a Resend (Svix) webhook signature without the SDK.
 * `payload` must be the raw request body string.
 */
function verifyResendWebhook({
  payload,
  headers = {},
  secret,
  nowMs = Date.now(),
  toleranceSec = WEBHOOK_TOLERANCE_SEC,
} = {}) {
  if (!secret) return { ok: false, reason: 'missing-secret' };
  const raw = typeof payload === 'string' ? payload : '';
  if (!raw) return { ok: false, reason: 'missing-payload' };

  const id = String(headerValue(headers, 'svix-id') || '').trim();
  const timestamp = String(headerValue(headers, 'svix-timestamp') || '').trim();
  const signature = String(headerValue(headers, 'svix-signature') || '').trim();
  if (!id || !timestamp || !signature) return { ok: false, reason: 'missing-headers' };

  const ts = Number(timestamp);
  if (!Number.isFinite(ts)) return { ok: false, reason: 'invalid-timestamp' };
  if (Math.abs(nowMs / 1000 - ts) > toleranceSec) return { ok: false, reason: 'timestamp-expired' };

  const secretPart = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  const key = Buffer.from(secretPart, 'base64');
  if (!key.length) return { ok: false, reason: 'invalid-secret' };

  const expected = crypto
    .createHmac('sha256', key)
    .update(`${id}.${timestamp}.${raw}`)
    .digest('base64');

  const candidates = signature
    .split(/\s+/)
    .map((part) => {
      const comma = part.indexOf(',');
      return comma === -1 ? part : part.slice(comma + 1);
    })
    .filter(Boolean);

  const match = candidates.some((sig) => timingSafeEqualString(sig, expected));
  if (!match) return { ok: false, reason: 'invalid-signature' };

  try {
    return { ok: true, event: JSON.parse(raw) };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
}

function signResendWebhook(payload, secret, { id = 'msg_test', timestamp } = {}) {
  const svixTimestamp = String(timestamp != null ? timestamp : Math.floor(Date.now() / 1000));
  const secretPart = String(secret).startsWith('whsec_') ? String(secret).slice(6) : String(secret);
  const key = Buffer.from(secretPart, 'base64');
  const sig = crypto.createHmac('sha256', key).update(`${id}.${svixTimestamp}.${payload}`).digest('base64');
  return {
    'svix-id': id,
    'svix-timestamp': svixTimestamp,
    'svix-signature': `v1,${sig}`,
  };
}

function extractWebhookRecipients(event) {
  const to = event?.data?.to;
  if (Array.isArray(to)) {
    return to.map((addr) => String(addr || '').trim().toLowerCase()).filter(Boolean);
  }
  if (typeof to === 'string' && to.trim()) return [to.trim().toLowerCase()];
  return [];
}

function shouldSuppressEventType(type) {
  return type === 'email.bounced' || type === 'email.complained';
}

module.exports = {
  RESEND_EMAILS_URL,
  sanitizeTagValue,
  sanitizeTags,
  buildIdempotencyKey,
  extractTokenFromUrl,
  resolveReplyTo,
  isRetryableStatus,
  sendResendEmail,
  verifyResendWebhook,
  signResendWebhook,
  extractWebhookRecipients,
  shouldSuppressEventType,
};
