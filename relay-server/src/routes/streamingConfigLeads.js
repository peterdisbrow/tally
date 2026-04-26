/**
 * Streaming Config Leads – email capture for the free ATEM Streaming.xml generator tool.
 * POST /api/tools/streaming-config/leads → { ok: true }
 */
const fs = require('node:fs');
const path = require('node:path');

const LEADS_FILE = path.join(__dirname, '..', '..', 'data', 'streaming-config-leads.json');

function readLeads() {
  try {
    if (fs.existsSync(LEADS_FILE)) {
      return JSON.parse(fs.readFileSync(LEADS_FILE, 'utf8'));
    }
  } catch (err) { /* ignore corrupt file */ console.debug("[streamingConfigLeads] intentional swallow:", err); }
  return [];
}

function writeLeads(leads) {
  const dir = path.dirname(LEADS_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(LEADS_FILE, JSON.stringify(leads, null, 2));
}

module.exports = function streamingConfigLeadsRoutes(app, ctx) {
  const { rateLimit } = ctx || {};

  const limiter = rateLimit ? rateLimit(10, 15 * 60 * 1000) : (_req, _res, next) => next();

  app.post('/api/tools/streaming-config/leads', limiter, (req, res) => {
    const { email, churchName, platform, model } = req.body || {};

    if (!email || typeof email !== 'string' || !email.includes('@')) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    const lead = {
      email: email.trim().toLowerCase(),
      churchName: (churchName || '').trim(),
      platform: (platform || '').trim(),
      model: (model || '').trim(),
      createdAt: new Date().toISOString(),
    };

    try {
      const leads = readLeads();
      leads.push(lead);
      writeLeads(leads);
    } catch (err) {
      console.error('[StreamingConfigLeads] Failed to save lead:', err.message);
      // Don't fail the request – the download should still work
    }

    res.json({ ok: true });
  });
};
