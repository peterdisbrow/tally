/**
 * Escape HTML special characters to prevent XSS.
 */
function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * Decode common HTML entities back to plain characters.
 * Used to sanitise AI response text before storing as chat messages —
 * the AI occasionally returns &quot; etc., which the portal's escapeHtml
 * would then double-encode, causing them to appear literally in the UI.
 */
function decodeHtmlEntities(str) {
  return String(str || '')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&'); // must be last
}

module.exports = { escapeHtml, decodeHtmlEntities };
