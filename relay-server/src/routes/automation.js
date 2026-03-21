/**
 * Preset library + Autopilot automation + command log routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupAutomationRoutes(app, ctx) {
  const { churches, requireAdmin, requireChurchOrAdmin, requireFeature,
          presetLibrary, autoPilot, safeErrorMessage, safeSend, log } = ctx;
  const WebSocket = require('ws').WebSocket;

  // ─── Helper: create a sendCommand function for a church WebSocket ─────────
  function makeCommandSender(church) {
    return (command, params) => new Promise((resolve, reject) => {
      if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
        return reject(new Error('Church client not connected'));
      }
      const { v4: uuid } = require('uuid');
      const id = uuid();
      const timeout = setTimeout(() => {
        church.ws.removeListener('message', handler);
        reject(new Error('Command timeout (15s)'));
      }, 15000);

      const handler = (data) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === 'command_result' && msg.id === id) {
            clearTimeout(timeout);
            church.ws.removeListener('message', handler);
            if (msg.error) reject(new Error(msg.error));
            else resolve(msg.result);
          }
        } catch { /* ignore */ }
      };
      church.ws.on('message', handler);
      safeSend(church.ws, { type: 'command', command, params, id });
    });
  }

  // ─── PRESET LIBRARY ──────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/presets', requireChurchOrAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    res.json(presetLibrary.list(req.params.churchId));
  });

  app.post('/api/churches/:churchId/presets', requireChurchOrAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { name, type, data } = req.body;
    if (!name || !type || !data) return res.status(400).json({ error: 'name, type, and data required' });
    try {
      const id = presetLibrary.save(req.params.churchId, name, type, data);
      res.json({ id, name, type, saved: true });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  app.get('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const preset = presetLibrary.get(req.params.churchId, req.params.name);
    if (!preset) return res.status(404).json({ error: 'Preset not found' });
    res.json(preset);
  });

  app.delete('/api/churches/:churchId/presets/:name', requireChurchOrAdmin, (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const deleted = presetLibrary.delete(req.params.churchId, req.params.name);
    if (!deleted) return res.status(404).json({ error: 'Preset not found' });
    res.json({ deleted: true });
  });

  app.post('/api/churches/:churchId/presets/:name/recall', requireChurchOrAdmin, async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    if (!church.ws || church.ws.readyState !== WebSocket.OPEN) {
      return res.status(503).json({ error: 'Church client not connected' });
    }
    try {
      const sendCommand = makeCommandSender(church);
      const preset = await presetLibrary.recall(req.params.churchId, req.params.name, sendCommand);
      log(`PRESET recall → ${church.name}: "${preset.name}" (${preset.type})`);
      res.json({ recalled: true, preset: { name: preset.name, type: preset.type } });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // ─── AUTOPILOT ───────────────────────────────────────────────────────────────

  app.get('/api/churches/:churchId/automation', requireAdmin, requireFeature('autopilot'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    res.json({
      paused: autoPilot.isPaused(req.params.churchId),
      rules: autoPilot.getRules(req.params.churchId),
    });
  });

  app.post('/api/churches/:churchId/automation', requireAdmin, requireFeature('autopilot'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const rule = autoPilot.createRule(req.params.churchId, {
        name: req.body.name,
        triggerType: req.body.triggerType,
        triggerConfig: req.body.triggerConfig || {},
        actions: req.body.actions || [],
      });
      res.json(rule);
    } catch (e) {
      if (e.code === 'RULE_LIMIT_REACHED') {
        const NEXT_TIER = { connect: 'plus', plus: 'pro', pro: 'managed', managed: 'managed' };
        const suggestedPlan = NEXT_TIER[e.currentTier] || 'pro';
        return res.status(402).json({
          error: e.message,
          upgradeUrl: `https://tallyconnect.app/signup?plan=${suggestedPlan}`,
          suggestedPlan,
          currentTier: e.currentTier,
          ruleLimit: e.ruleLimit,
        });
      }
      res.status(400).json({ error: e.message });
    }
  });

  app.put('/api/churches/:churchId/automation/:ruleId', requireAdmin, requireFeature('autopilot'), (req, res) => {
    try {
      const rule = autoPilot.updateRule(req.params.ruleId, req.body);
      res.json(rule);
    } catch (e) {
      res.status(400).json({ error: e.message });
    }
  });

  app.delete('/api/churches/:churchId/automation/:ruleId', requireAdmin, requireFeature('autopilot'), (req, res) => {
    const deleted = autoPilot.deleteRule(req.params.ruleId);
    if (!deleted) return res.status(404).json({ error: 'Rule not found' });
    res.json({ deleted: true });
  });

  app.post('/api/churches/:churchId/automation/:ruleId/test', requireAdmin, requireFeature('autopilot'), (req, res) => {
    const rule = autoPilot.getRule(req.params.ruleId);
    if (!rule) return res.status(404).json({ error: 'Rule not found' });
    if (rule.church_id !== req.params.churchId) return res.status(403).json({ error: 'Access denied' });
    try {
      const result = autoPilot.testRule(req.params.ruleId, req.body || {});
      res.json(result);
    } catch (e) {
      res.status(400).json({ error: safeErrorMessage(e) });
    }
  });

  app.post('/api/churches/:churchId/automation/pause', requireAdmin, requireFeature('autopilot'), (req, res) => {
    autoPilot.pause(req.params.churchId);
    res.json({ paused: true });
  });

  app.post('/api/churches/:churchId/automation/resume', requireAdmin, requireFeature('autopilot'), (req, res) => {
    autoPilot.resume(req.params.churchId);
    res.json({ paused: false });
  });

  app.get('/api/churches/:churchId/command-log', requireAdmin, requireFeature('autopilot'), (req, res) => {
    const limit = Math.min(parseInt(req.query.limit) || 50, 200);
    const offset = parseInt(req.query.offset) || 0;
    const logData = autoPilot.getCommandLog(req.params.churchId, limit, offset);
    res.json(logData);
  });
};
