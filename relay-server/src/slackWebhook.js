/**
 * Slack incoming-webhook helpers — URL validation (SSRF-safe) and masking.
 * Shared by the admin Slack API and church-portal self-serve routes.
 */

function isValidSlackWebhookUrl(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:'
      && (parsed.hostname === 'hooks.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
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

module.exports = { isValidSlackWebhookUrl, maskSlackWebhookUrl };
