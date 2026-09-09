/**
 * Slack incoming-webhook helpers — URL validation (SSRF-safe) and masking.
 * Shared by the admin Slack API and church-portal self-serve routes.
 *
 * Stored values may be secretCrypto ciphertext (`enc:v1:…`) or legacy plaintext.
 * decryptSecret() is a no-op on plaintext, so reads stay backward compatible;
 * the next save re-encrypts.
 */

const { decryptSecret } = require('./secretCrypto');

function isValidSlackWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'hooks.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

function isMaskedSlackWebhookPlaceholder(url) {
  return typeof url === 'string' && url.includes('•');
}

/**
 * Decrypt a stored webhook for send/mask. Legacy plaintext passes through.
 * Never log the return value.
 */
function resolveSlackWebhookUrl(stored) {
  if (!stored) return '';
  return decryptSecret(stored) || '';
}

/**
 * Mask a stored webhook so the secret tail is never echoed back to the portal.
 * Keeps a short workspace hint so the church can confirm which hook is saved.
 */
function maskSlackWebhookUrl(url) {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    const parts = parsed.pathname.split('/').filter(Boolean);
    if (parts[0] === 'services' && parts.length >= 2) {
      const workspaceHint = String(parts[1] || '').slice(0, 3);
      return `${parsed.origin}/services/${workspaceHint}••••/••••••••`;
    }
    return `${parsed.origin}/••••••••`;
  } catch {
    return 'https://hooks.slack.com/••••••••';
  }
}

/**
 * GET payload for portal + admin. Never includes the full webhook.
 * Decrypts ciphertext first so the mask can show a workspace hint.
 */
function slackStatusPayload(row) {
  const stored = row?.slack_webhook_url || '';
  const plaintext = resolveSlackWebhookUrl(stored);
  return {
    configured: !!stored,
    webhookUrl: maskSlackWebhookUrl(plaintext),
    channel: row?.slack_channel || '',
  };
}

module.exports = {
  isValidSlackWebhookUrl,
  isMaskedSlackWebhookPlaceholder,
  resolveSlackWebhookUrl,
  maskSlackWebhookUrl,
  slackStatusPayload,
};
