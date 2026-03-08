/**
 * YouTube & Facebook OAuth routes for stream platform integration.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupStreamPlatformRoutes(app, ctx) {
  const { requireChurchAppAuth, streamOAuth, safeErrorMessage } = ctx;

  // Facebook OAuth callback (public — receives redirect from Facebook)
  app.get('/api/oauth/facebook/callback', (req, res) => {
    const { code, state, error } = req.query;
    if (error || !code || !state) {
      return res.status(400).send('<html><body><h2>Authorization failed</h2><p>You can close this window.</p></body></html>');
    }
    streamOAuth.storeFacebookPendingCode(state, code);
    res.send('<html><body><h2>&#10003; Connected to Facebook</h2><p>You can close this window and return to Tally.</p></body></html>');
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
  app.delete('/api/church/app/oauth/youtube', requireChurchAppAuth, (req, res) => {
    streamOAuth.disconnectYouTube(req.church.churchId);
    res.json({ disconnected: true });
  });

  // Facebook: exchange auth code for tokens + list pages
  app.post('/api/church/app/oauth/facebook/exchange', requireChurchAppAuth, async (req, res) => {
    try {
      const result = await streamOAuth.exchangeFacebookCode(req.church.churchId, req.body.code, req.body.redirectUri);
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
  app.delete('/api/church/app/oauth/facebook', requireChurchAppAuth, (req, res) => {
    streamOAuth.disconnectFacebook(req.church.churchId);
    res.json({ disconnected: true });
  });

  // Combined status (both platforms)
  app.get('/api/church/app/oauth/status', requireChurchAppAuth, (req, res) => {
    res.json(streamOAuth.getStatus(req.church.churchId));
  });

  // Combined stream keys
  app.get('/api/church/app/oauth/stream-keys', requireChurchAppAuth, (req, res) => {
    res.json(streamOAuth.getStreamKeys(req.church.churchId));
  });
};
