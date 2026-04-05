/**
 * YouTube & Facebook OAuth routes for stream platform integration.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
/**
 * Build an HTML page for OAuth callback results that auto-closes the tab.
 */
function oauthResultPage(message, success) {
  const icon = success ? '&#10003;' : '&#10007;';
  const color = success ? '#22c55e' : '#ef4444';
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>Tally — ${success ? 'Connected' : 'Error'}</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;background:#0f172a;color:#e2e8f0;}
.card{text-align:center;padding:40px;border-radius:12px;background:#1e293b;max-width:360px;}
h2{color:${color};margin:0 0 8px;font-size:24px;} p{margin:0;font-size:14px;color:#94a3b8;}</style></head>
<body><div class="card"><h2>${icon} ${message}</h2><p id="msg">This window will close automatically…</p></div>
<script>setTimeout(function(){try{window.close()}catch(e){}document.getElementById("msg").textContent="You can close this tab and return to Tally."},1500);</script>
</body></html>`;
}

module.exports = function setupStreamPlatformRoutes(app, ctx) {
  const { requireChurchAppAuth, streamOAuth, safeErrorMessage } = ctx;

  // YouTube OAuth callback (public — receives redirect from Google)
  app.get('/api/oauth/youtube/callback', (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      return res.status(400).send(oauthResultPage('Authorization failed', false));
    }
    streamOAuth.storeYouTubePendingCode(state, code);
    res.send(oauthResultPage('Connected to YouTube', true));
  });

  // Poll for pending YouTube auth code (Electron polls this)
  app.get('/api/church/app/oauth/youtube/pending', requireChurchAppAuth, (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).json({ error: 'state required' });
    const pending = streamOAuth.getYouTubePendingCode(state);
    if (!pending) return res.json({ ready: false });
    res.json({ ready: true, code: pending.code });
  });

  // Facebook OAuth callback (public — receives redirect from Facebook)
  app.get('/api/oauth/facebook/callback', (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      return res.status(400).send(oauthResultPage('Authorization failed', false));
    }
    streamOAuth.storeFacebookPendingCode(state, code);
    res.send(oauthResultPage('Connected to Facebook', true));
  });

  // Poll for pending Facebook auth code (Electron polls this)
  app.get('/api/church/app/oauth/facebook/pending', requireChurchAppAuth, (req, res) => {
    const { state } = req.query;
    if (!state) return res.status(400).json({ error: 'state required' });
    const pending = streamOAuth.getFacebookPendingCode(state);
    if (!pending) return res.json({ ready: false });
    res.json({ ready: true, code: pending.code });
  });

  // YouTube: exchange auth code for tokens + stream key
  app.post('/api/church/app/oauth/youtube/exchange', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.exchangeYouTubeCode(req.church.churchId, req.body.code, req.body.redirectUri);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // YouTube: re-fetch stream key
  app.post('/api/church/app/oauth/youtube/refresh-key', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.fetchYouTubeStreamKey(req.church.churchId);
      res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // YouTube: disconnect
  app.delete('/api/church/app/oauth/youtube', requireChurchAppAuth, async (req, res) => {
    try {
      await streamOAuth.disconnectYouTube(req.church.churchId);
      res.json({ disconnected: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Facebook: exchange auth code for tokens + list pages
  app.post('/api/church/app/oauth/facebook/exchange', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.exchangeFacebookCode(req.church.churchId, req.body.code, req.body.redirectUri);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Facebook: list available pages/destinations (for changing page after initial connect)
  app.get('/api/church/app/oauth/facebook/pages', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.listFacebookDestinations(req.church.churchId);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Facebook: select page (creates live video, gets stream key)
  app.post('/api/church/app/oauth/facebook/select-page', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.selectFacebookPage(req.church.churchId, req.body.pageId);
      res.json(result);
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Facebook: refresh stream key (new live video)
  app.post('/api/church/app/oauth/facebook/refresh-key', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.refreshFacebookStreamKey(req.church.churchId);
      res.json({ success: true, ...result });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Facebook: disconnect
  app.delete('/api/church/app/oauth/facebook', requireChurchAppAuth, async (req, res) => {
    try {
      await streamOAuth.disconnectFacebook(req.church.churchId);
      res.json({ disconnected: true });
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // OAuth client IDs (public, non-secret — needed by Electron to build auth URLs)
  app.get('/api/church/app/oauth/client-ids', requireChurchAppAuth, (req, res) => {
    res.json({
      youtubeClientId: process.env.YOUTUBE_CLIENT_ID || '',
      facebookAppId: process.env.FACEBOOK_APP_ID || '',
    });
  });

  // Combined status (both platforms)
  app.get('/api/church/app/oauth/status', requireChurchAppAuth, async (req, res) => {
    try {
      res.json(await streamOAuth.getStatus(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });

  // Combined stream keys
  app.get('/api/church/app/oauth/stream-keys', requireChurchAppAuth, async (req, res) => {
    try {
      res.json(await streamOAuth.getStreamKeys(req.church.churchId));
    } catch (e) { res.status(500).json({ error: safeErrorMessage(e) }); }
  });
};
