/**
 * Rundown Scheduler — Hybrid time + event + manual cue system.
 *
 * Gives TDs a "show caller" experience where the production can run
 * semi-autonomously during predictable service moments.
 *
 * Trigger types per cue:
 *   - manual          — TD must advance (default, backward-compatible)
 *   - time_absolute   — fire at a specific HH:MM (church timezone)
 *   - time_relative   — fire N minutes after service start
 *   - delay           — fire N seconds after previous cue fires
 *   - event           — fire on external event (slide change, equipment state)
 *
 * Safety: Stream Guard checks on auto-triggered dangerous commands,
 *         per-session fire cap (50), dedup via cues_fired array.
 */

const { checkStreamSafety } = require('./stream-guard');
const { createQueryClient } = require('./db');

const MAX_FIRES_PER_SESSION = 50;
const SQLITE_FALLBACK_CONFIG = {
  driver: 'sqlite',
  isSqlite: true,
  isPostgres: false,
  databaseUrl: '',
};

const CHURCH_ACCESS_SELECT_SQL = `
  SELECT
    churchId AS "churchId",
    billing_tier AS "billing_tier",
    billing_status AS "billing_status"
  FROM churches
  WHERE churchId = ?
`;

class RundownScheduler {
  /**
   * @param {import('better-sqlite3').Database|import('./db/queryClient').SqliteQueryClient|import('./db/queryClient').PostgresQueryClient} dbOrClient
   * @param {object} opts
   * @param {import('./rundownEngine').RundownEngine} opts.rundownEngine
   * @param {import('./scheduleEngine').ScheduleEngine} opts.scheduleEngine
   * @param {import('./billing').BillingSystem} [opts.billing]
   * @param {import('./presetLibrary').PresetLibrary} [opts.presetLibrary]
   * @param {import('./autoPilot').AutoPilot} [opts.autoPilot] - for command logging
   */
  constructor(dbOrClient, opts = {}) {
    this.db = dbOrClient && typeof dbOrClient.prepare === 'function' ? dbOrClient : null;
    this.client = this._resolveClient(dbOrClient);
    this.rundownEngine = opts.rundownEngine;
    this.scheduleEngine = opts.scheduleEngine;
    this.billing = opts.billing || null;
    this.presetLibrary = opts.presetLibrary || null;
    this.autoPilot = opts.autoPilot || null;

    // Command executor — set by server.js
    this._executeCommand = null;

    // Telegram notifier — set by server.js
    this._notifyTD = null;

    // Active delay timers (churchId → setTimeout handle)
    this._delayTimers = new Map();

    // Tick interval handle
    this._tickTimer = null;
    this.ready = Promise.resolve();
  }

  _resolveClient(dbOrClient) {
    if (!dbOrClient) return null;
    if (typeof dbOrClient.query === 'function' && typeof dbOrClient.exec === 'function') {
      return dbOrClient;
    }

    return createQueryClient({
      config: SQLITE_FALLBACK_CONFIG,
      sqliteDb: dbOrClient,
    });
  }

  _requireClient() {
    if (!this.client) throw new Error('[Scheduler] Database client is not configured.');
    return this.client;
  }

  setCommandExecutor(fn) { this._executeCommand = fn; }
  setTDNotifier(fn) { this._notifyTD = fn; }

  // ─── LIFECYCLE ──────────────────────────────────────────────────────────────

  /**
   * Start the 15-second tick loop for evaluating time-based triggers.
   */
  start() {
    this._tickTimer = setInterval(() => {
      Promise.resolve(this._tick()).catch((error) => {
        console.error('[Scheduler] Tick loop error:', error.message);
      });
    }, 15 * 1000);
    console.log('[Scheduler] Started (15s tick interval)');
  }

  stop() {
    if (this._tickTimer) { clearInterval(this._tickTimer); this._tickTimer = null; }
    for (const [churchId, timer] of this._delayTimers) {
      clearTimeout(timer);
    }
    this._delayTimers.clear();
    console.log('[Scheduler] Stopped');
  }

  /**
   * Called when service window opens — auto-activate if configured.
   */
  onServiceWindowOpen(churchId) {
    if (!this.db) {
      return this._onServiceWindowOpenAsync(churchId);
    }

    try {
      const dayOfWeek = new Date().getDay();
      const rundown = this.rundownEngine.getAutoActivateRundown(churchId, dayOfWeek);
      if (!rundown) return;

      // Check billing: auto-triggers require pro+
      if (!this._checkAutoTriggerAccess(churchId)) return;

      const active = this.rundownEngine.activateRundownForScheduler(
        churchId, rundown.id, new Date().toISOString()
      );
      if (active) {
        console.log(`[Scheduler] Auto-activated rundown "${rundown.name}" for church ${churchId}`);
        if (this._notifyTD) {
          this._notifyTD(churchId, `📋 Rundown "${rundown.name}" auto-started (${rundown.steps.length} cues)`);
        }
      }
    } catch (e) {
      console.error(`[Scheduler] onServiceWindowOpen error for ${churchId}:`, e.message);
    }
  }

  async _onServiceWindowOpenAsync(churchId) {
    try {
      const dayOfWeek = new Date().getDay();
      const rundown = this.rundownEngine.getAutoActivateRundown(churchId, dayOfWeek);
      if (!rundown) return;

      if (!(await this._checkAutoTriggerAccessAsync(churchId))) return;

      const active = this.rundownEngine.activateRundownForScheduler(
        churchId, rundown.id, new Date().toISOString()
      );
      if (active) {
        console.log(`[Scheduler] Auto-activated rundown "${rundown.name}" for church ${churchId}`);
        if (this._notifyTD) {
          this._notifyTD(churchId, `📋 Rundown "${rundown.name}" auto-started (${rundown.steps.length} cues)`);
        }
      }
    } catch (e) {
      console.error(`[Scheduler] onServiceWindowOpen error for ${churchId}:`, e.message);
    }
  }

  /**
   * Called when service window closes — deactivate running rundown.
   */
  onServiceWindowClose(churchId) {
    try {
      const active = this.rundownEngine.getActiveRundownFull(churchId);
      if (!active) return;

      this._clearDelayTimer(churchId);
      this.rundownEngine.deactivateRundown(churchId);
      console.log(`[Scheduler] Deactivated rundown for church ${churchId} (service window closed)`);
    } catch (e) {
      console.error(`[Scheduler] onServiceWindowClose error for ${churchId}:`, e.message);
    }
  }

  // ─── TICK — TIME-BASED TRIGGER EVALUATION ──────────────────────────────────

  _tick() {
    const churchIds = typeof this.rundownEngine?.listActiveChurchIds === 'function'
      ? this.rundownEngine.listActiveChurchIds()
      : [];

    for (const churchId of churchIds) {
      try {
        this._evaluateTimeTriggers(churchId);
      } catch (e) {
        console.error(`[Scheduler] Tick error for ${churchId}:`, e.message);
      }
    }
  }

  _evaluateTimeTriggers(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active || active.state !== 'running') return;

    const cues = active.rundown.steps || [];
    const cue = cues[active.currentStep];
    if (!cue) return;

    const trigger = cue.trigger || { type: 'manual' };
    if (trigger.type === 'manual' || trigger.type === 'event') return; // handled elsewhere

    const now = new Date();

    if (trigger.type === 'time_absolute') {
      // Compare HH:MM to current time
      const [hours, minutes] = (trigger.time || '00:00').split(':').map(Number);
      const nowMinutes = now.getHours() * 60 + now.getMinutes();
      const triggerMinutes = hours * 60 + minutes;
      // Fire if we're within the 15-second tick window (±1 minute tolerance)
      if (Math.abs(nowMinutes - triggerMinutes) <= 1) {
        this._fireCue(churchId, active.currentStep, 'time_absolute').catch(e =>
          console.error(`[Scheduler] time_absolute fire error:`, e.message)
        );
      }
    }

    if (trigger.type === 'time_relative') {
      const serviceStart = new Date(active.serviceStartAt);
      const minutesSinceStart = (now - serviceStart) / 60000;
      const offsetMinutes = trigger.offsetMinutes || 0;
      // Fire if within 1-minute tolerance
      if (minutesSinceStart >= offsetMinutes && minutesSinceStart < offsetMinutes + 1.5) {
        this._fireCue(churchId, active.currentStep, 'time_relative').catch(e =>
          console.error(`[Scheduler] time_relative fire error:`, e.message)
        );
      }
    }

    // delay triggers are handled by setTimeout in _afterCueFired, not by tick
  }

  // ─── EVENT HOOKS ────────────────────────────────────────────────────────────

  /**
   * Called when a ProPresenter slide changes.
   */
  async onSlideChange(churchId, slideData) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active || active.state !== 'running') return;

    const cues = active.rundown.steps || [];
    const cue = cues[active.currentStep];
    if (!cue) return;

    const trigger = cue.trigger || { type: 'manual' };
    if (trigger.type !== 'event') return;
    if (trigger.event?.type !== 'propresenter_slide_change') return;

    // Match presentation pattern
    const pattern = String(trigger.event.config?.presentationPattern || '').toLowerCase();
    const name = String(slideData.presentationName || '').toLowerCase();
    if (pattern && !name.includes(pattern)) return;

    await this._fireCue(churchId, active.currentStep, 'event:slide_change');
  }

  /**
   * Called when equipment state changes.
   */
  async onEquipmentStateChange(churchId, state) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active || active.state !== 'running') return;

    const cues = active.rundown.steps || [];
    const cue = cues[active.currentStep];
    if (!cue) return;

    const trigger = cue.trigger || { type: 'manual' };
    if (trigger.type !== 'event') return;
    if (trigger.event?.type !== 'equipment_state_match') return;

    const conditions = trigger.event.config?.conditions || {};
    if (Object.keys(conditions).length === 0) return;

    for (const [key, expected] of Object.entries(conditions)) {
      const actual = key.split('.').reduce((o, k) => o?.[k], state);
      if (actual !== expected) return;
    }

    await this._fireCue(churchId, active.currentStep, 'event:equipment_state');
  }

  // ─── CUE EXECUTION ─────────────────────────────────────────────────────────

  async _fireCue(churchId, cueIndex, source) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active || active.state !== 'running') return null;

    const cues = active.rundown.steps || [];
    const cue = cues[cueIndex];
    if (!cue) return null;

    // Dedup — don't fire a cue we've already fired
    if (active.cuesFired.includes(cueIndex)) return null;

    // Fire cap
    if (active.cuesFired.length >= MAX_FIRES_PER_SESSION) {
      console.warn(`[Scheduler] Fire cap reached (${MAX_FIRES_PER_SESSION}) for church ${churchId} — pausing`);
      this.pause(churchId);
      return null;
    }

    // Stream Guard check for auto triggers (not manual)
    if (source !== 'manual') {
      for (const cmd of (cue.commands || [])) {
        const guard = checkStreamSafety(cmd.command, null);
        if (guard) {
          // Dangerous auto-command — notify TD instead of executing
          if (this._notifyTD) {
            this._notifyTD(churchId,
              `⚠️ Scheduler paused at cue ${cueIndex + 1} "${cue.label || ''}"\n` +
              `Auto-trigger wants to: ${guard.desc}\n` +
              `Send "go" to confirm or "skip" to skip.`
            );
          }
          this.pause(churchId);
          return null;
        }
      }
    }

    console.log(`[Scheduler] Firing cue ${cueIndex + 1}/${cues.length} "${cue.label || ''}" for ${churchId} (${source})`);

    // Execute commands
    if (cue.commands && cue.commands.length > 0) {
      for (const cmd of cue.commands) {
        try {
          if (this._executeCommand) {
            const result = await this._executeCommand(churchId, cmd.command, cmd.params || {}, 'scheduler');
            // Log via autoPilot's command logger
            if (this.autoPilot) {
              this.autoPilot.logCommand(churchId, cmd.command, cmd.params || {}, 'scheduler', result);
            }
          }
        } catch (e) {
          console.error(`[Scheduler] Command "${cmd.command}" failed for cue ${cueIndex + 1}:`, e.message);
          if (this.autoPilot) {
            this.autoPilot.logCommand(churchId, cmd.command, cmd.params || {}, 'scheduler', `ERROR: ${e.message}`);
          }
        }
      }
    }

    // Execute preset if referenced
    if (cue.presetName && this.presetLibrary) {
      try {
        const preset = await this.presetLibrary.getByName(churchId, cue.presetName);
        if (preset) {
          const presetData = typeof preset.data === 'string' ? JSON.parse(preset.data) : preset.data;
          if (presetData.commands) {
            for (const cmd of presetData.commands) {
              if (this._executeCommand) {
                await this._executeCommand(churchId, cmd.command, cmd.params || {}, 'scheduler');
              }
            }
          }
        }
      } catch (e) {
        console.error(`[Scheduler] Preset "${cue.presetName}" failed:`, e.message);
      }
    }

    // Update state
    const updatedFired = [...active.cuesFired, cueIndex];
    const now = new Date().toISOString();
    const nextStep = cueIndex + 1;
    const isLast = nextStep >= cues.length;

    this.rundownEngine.updateActiveState(churchId, {
      currentStep: isLast ? cueIndex : nextStep,
      state: isLast ? 'completed' : 'running',
      lastCueFiredAt: now,
      cuesFired: updatedFired,
    });

    if (isLast) {
      console.log(`[Scheduler] Rundown completed for church ${churchId}`);
      this._clearDelayTimer(churchId);
      if (this._notifyTD) {
        this._notifyTD(churchId, `✅ Rundown "${active.rundown.name}" completed (${cues.length} cues)`);
      }
    } else {
      // Check if next cue is a delay trigger — start its timer
      this._setupDelayTrigger(churchId, nextStep);
    }

    return { cueIndex, label: cue.label || '', source };
  }

  _setupDelayTrigger(churchId, stepIndex) {
    this._clearDelayTimer(churchId);

    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active || active.state !== 'running') return;

    const cues = active.rundown.steps || [];
    const cue = cues[stepIndex];
    if (!cue) return;

    const trigger = cue.trigger || { type: 'manual' };
    if (trigger.type !== 'delay') return;

    const delayMs = (trigger.delaySeconds || 5) * 1000;
    console.log(`[Scheduler] Delay trigger: cue ${stepIndex + 1} will fire in ${trigger.delaySeconds}s for ${churchId}`);

    const timer = setTimeout(() => {
      this._delayTimers.delete(churchId);
      this._fireCue(churchId, stepIndex, 'delay').catch(e =>
        console.error(`[Scheduler] Delay fire error:`, e.message)
      );
    }, delayMs);

    this._delayTimers.set(churchId, timer);
  }

  _clearDelayTimer(churchId) {
    const timer = this._delayTimers.get(churchId);
    if (timer) {
      clearTimeout(timer);
      this._delayTimers.delete(churchId);
    }
  }

  // ─── TD MANUAL CONTROLS ────────────────────────────────────────────────────

  /**
   * Fire current cue and advance (regardless of trigger type).
   */
  async advance(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { error: 'No active rundown' };
    if (active.state === 'completed') return { error: 'Rundown already completed' };

    // Resume if paused
    if (active.state === 'paused') {
      this.rundownEngine.updateActiveState(churchId, { state: 'running' });
    }

    this._clearDelayTimer(churchId);
    return await this._fireCue(churchId, active.currentStep, 'manual');
  }

  /**
   * Skip current cue without firing, move to next.
   */
  skip(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { error: 'No active rundown' };
    if (active.state === 'completed') return { error: 'Rundown already completed' };

    this._clearDelayTimer(churchId);

    const cues = active.rundown.steps || [];
    const nextStep = active.currentStep + 1;
    const isLast = nextStep >= cues.length;

    this.rundownEngine.updateActiveState(churchId, {
      currentStep: isLast ? active.currentStep : nextStep,
      state: isLast ? 'completed' : (active.state === 'paused' ? 'running' : active.state),
    });

    if (!isLast) this._setupDelayTrigger(churchId, nextStep);

    const cue = cues[active.currentStep];
    return { skipped: true, cueIndex: active.currentStep, label: cue?.label || '' };
  }

  /**
   * Go back one cue.
   */
  goBack(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { error: 'No active rundown' };
    if (active.currentStep === 0) return { error: 'Already at first cue' };

    this._clearDelayTimer(churchId);
    const prevStep = active.currentStep - 1;

    // Remove the previous cue from fired list so it can re-fire
    const cuesFired = active.cuesFired.filter(i => i !== prevStep);

    this.rundownEngine.updateActiveState(churchId, {
      currentStep: prevStep,
      state: 'running',
      cuesFired,
    });

    const cue = (active.rundown.steps || [])[prevStep];
    return { cueIndex: prevStep, label: cue?.label || '' };
  }

  /**
   * Jump to an arbitrary cue index.
   */
  jumpToCue(churchId, index) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { error: 'No active rundown' };

    const cues = active.rundown.steps || [];
    if (index < 0 || index >= cues.length) return { error: `Invalid cue index ${index}` };

    this._clearDelayTimer(churchId);

    // Remove future cues from fired list
    const cuesFired = active.cuesFired.filter(i => i < index);

    this.rundownEngine.updateActiveState(churchId, {
      currentStep: index,
      state: 'running',
      cuesFired,
    });

    const cue = cues[index];
    return { cueIndex: index, label: cue?.label || '' };
  }

  /**
   * Pause the scheduler — stops auto-triggers.
   */
  pause(churchId) {
    this._clearDelayTimer(churchId);
    this.rundownEngine.updateActiveState(churchId, { state: 'paused' });
    console.log(`[Scheduler] Paused for church ${churchId}`);
    return { paused: true };
  }

  /**
   * Resume the scheduler.
   */
  resume(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { error: 'No active rundown' };
    if (active.state !== 'paused') return { error: 'Not paused' };

    this.rundownEngine.updateActiveState(churchId, { state: 'running' });

    // If current cue is a delay trigger, restart its timer
    this._setupDelayTrigger(churchId, active.currentStep);

    console.log(`[Scheduler] Resumed for church ${churchId}`);
    return { resumed: true };
  }

  /**
   * Activate a rundown manually.
   */
  activate(churchId, rundownId) {
    this._clearDelayTimer(churchId);
    const result = this.rundownEngine.activateRundownForScheduler(churchId, rundownId, new Date().toISOString());
    if (!result) return { error: 'Rundown not found or access denied' };

    // If the first cue is a delay trigger, start its timer
    this._setupDelayTrigger(churchId, 0);

    return result;
  }

  /**
   * Deactivate the current rundown.
   */
  deactivate(churchId) {
    this._clearDelayTimer(churchId);
    return this.rundownEngine.deactivateRundown(churchId);
  }

  /**
   * Get current scheduler status for a church.
   */
  getStatus(churchId) {
    const active = this.rundownEngine.getActiveRundownFull(churchId);
    if (!active) return { active: false };

    const cues = active.rundown.steps || [];
    const currentCue = cues[active.currentStep] || null;
    const nextCue = cues[active.currentStep + 1] || null;
    const trigger = currentCue?.trigger || { type: 'manual' };

    let nextTriggerInfo = 'Waiting for: TD advance';
    if (trigger.type === 'time_absolute') nextTriggerInfo = `Waiting for: ${trigger.time}`;
    if (trigger.type === 'time_relative') nextTriggerInfo = `Waiting for: +${trigger.offsetMinutes}min`;
    if (trigger.type === 'delay') nextTriggerInfo = `Waiting for: ${trigger.delaySeconds}s delay`;
    if (trigger.type === 'event') nextTriggerInfo = `Waiting for: ${trigger.event?.type || 'event'}`;

    return {
      active: true,
      state: active.state,
      rundownName: active.rundown.name,
      rundownId: active.rundownId,
      currentCue: active.currentStep,
      totalCues: cues.length,
      currentCueLabel: currentCue?.label || `Cue ${active.currentStep + 1}`,
      currentCueNotes: currentCue?.notes || '',
      triggerType: trigger.type,
      nextTriggerInfo,
      nextCueLabel: nextCue?.label || null,
      cuesFired: active.cuesFired.length,
      progress: cues.length > 0 ? Math.round((active.cuesFired.length / cues.length) * 100) : 0,
    };
  }

  // ─── INTERNAL ───────────────────────────────────────────────────────────────

  _checkAutoTriggerAccess(churchId) {
    if (!this.billing) return true;
    const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(churchId);
    if (!church) return false;
    return this.billing.checkAccess(church, 'scheduler_auto').allowed;
  }

  async _checkAutoTriggerAccessAsync(churchId) {
    if (!this.billing) return true;

    const church = await this._requireClient().queryOne(CHURCH_ACCESS_SELECT_SQL, [churchId]);
    if (!church) return false;
    return this.billing.checkAccess(church, 'scheduler_auto').allowed;
  }
}

module.exports = { RundownScheduler };
