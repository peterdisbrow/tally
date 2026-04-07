/**
 * Companion command handlers — direct button presses and custom variable sets.
 * These allow the relay to trigger Companion actions via the command pipeline.
 */

module.exports = {
  /**
   * Press a Companion button by page/row/col coordinates.
   * params: { page: number, row: number, col: number }
   */
  'companion.pressButton': async (agent, { page, row, col }) => {
    if (!agent.companion) throw new Error('Companion not configured');
    if (!agent.status.companion?.connected) throw new Error('Companion not connected');
    return await agent.companion.pressButton(page, row, col);
  },

  /**
   * Set a Companion custom variable.
   * params: { name: string, value: string }
   */
  'companion.setCustomVariable': async (agent, { name, value }) => {
    if (!agent.companion) throw new Error('Companion not configured');
    if (!agent.status.companion?.connected) throw new Error('Companion not connected');
    const ok = await agent.companion.setCustomVariable(name, String(value));
    if (!ok) throw new Error(`Failed to set custom variable "${name}"`);
    return { name, value: String(value) };
  },
};
