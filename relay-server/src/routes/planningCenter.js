/**
 * Planning Center integration routes.
 *
 * @param {import('express').Express} app
 * @param {object} ctx - Shared server context
 */
module.exports = function setupPlanningCenterRoutes(app, ctx) {
  const { churches, requireAdmin, requireFeature, planningCenter, safeErrorMessage } = ctx;

  // GET current PC status
  app.get('/api/churches/:churchId/planning-center', requireAdmin, requireFeature('planning_center'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const status = planningCenter.getStatus(req.params.churchId);
    res.json(status);
  });

  // PUT set credentials
  app.put('/api/churches/:churchId/planning-center', requireAdmin, requireFeature('planning_center'), (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    const { appId, secret, serviceTypeId, syncEnabled } = req.body;
    planningCenter.setCredentials(req.params.churchId, { appId, secret, serviceTypeId, syncEnabled });
    res.json({ saved: true });
  });

  // POST manual sync now
  app.post('/api/churches/:churchId/planning-center/sync', requireAdmin, requireFeature('planning_center'), async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const result = await planningCenter.syncChurch(req.params.churchId);
      res.json(result);
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });

  // GET preview upcoming services without saving
  app.get('/api/churches/:churchId/planning-center/preview', requireAdmin, requireFeature('planning_center'), async (req, res) => {
    const church = churches.get(req.params.churchId);
    if (!church) return res.status(404).json({ error: 'Church not found' });
    try {
      const services = await planningCenter.getUpcomingServicesForChurch(req.params.churchId);
      res.json({ services });
    } catch (e) {
      res.status(500).json({ error: safeErrorMessage(e) });
    }
  });
};
