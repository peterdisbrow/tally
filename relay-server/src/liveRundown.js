/**
 * Live Rundown Manager — real-time show-calling with PCO service plans.
 *
 * Manages live rundown sessions where a TD (show caller) advances through
 * a Planning Center service plan while all connected clients see the
 * current position, countdown timers, and ahead/behind schedule indicators.
 *
 * State is held in memory per-church for low-latency access. Sessions are
 * ephemeral — they exist for the duration of a service and are cleared when
 * the TD ends the session.
 *
 * WebSocket message types (outbound):
 *   rundown_state    — full state snapshot (sent on join / major changes)
 *   rundown_position — position + timing update (sent on advance/retreat)
 *   rundown_tick     — periodic timer tick (sent every second during active session)
 *   rundown_ended    — session ended
 *
 * WebSocket message types (inbound from mobile/portal):
 *   rundown_start    — start a new session with a PCO plan
 *   rundown_advance  — advance to next item
 *   rundown_back     — go back to previous item
 *   rundown_goto     — jump to a specific item index
 *   rundown_end      — end the session
 */

'use strict';

class LiveRundownManager {
  constructor({ broadcastToMobile, broadcastToPortal, broadcastToControllers, broadcastToChurch, log = console.log, queryClient = null } = {}) {
    // Map<sessionKey, RundownSession> where sessionKey = "churchId:roomId"
    this._sessions = new Map();
    this._tickTimers = new Map();
    this._broadcastToMobile = broadcastToMobile || (() => {});
    this._broadcastToPortal = broadcastToPortal || (() => {});
    this._broadcastToControllers = broadcastToControllers || (() => {});
    this._broadcastToChurch = broadcastToChurch || (() => {});
    this._log = log;
    this._db = queryClient;
    this.ready = this._db ? this._init() : Promise.resolve();

    // Cross-room sync: Map<sourceKey, Set<{ targetChurchId, targetRoomId, delaySeconds }>>
    // When sourceKey session advances, all registered targets advance after their delay.
    this._syncTargets = new Map();
    // In-flight sync timers: Map<timerHandle, true> — tracked for cleanup
    this._syncTimers = new Set();

    // Room ready-check status: Map<"churchId:roomId", { status, label, updatedAt }>
    // Persisted to DB separately but also held in memory for fast reads.
    this._roomStatus = new Map();
  }

  // ─── SESSION KEY HELPERS ────────────────────────────────────────────────────

  /** Build a composite session key: "churchId:roomId" */
  _sessionKey(churchId, roomId) {
    return churchId + ':' + (roomId || '');
  }

  /** Parse a session key back into { churchId, roomId } */
  _parseSessionKey(key) {
    const idx = key.indexOf(':');
    if (idx < 0) return { churchId: key, roomId: '' };
    return { churchId: key.substring(0, idx), roomId: key.substring(idx + 1) };
  }

  // ─── DB INIT & RESTORE ─────────────────────────────────────────────────────

  async _init() {
    await this._ensureTable();
    await this._restoreActiveSessions();
  }

  async _ensureTable() {
    await this._db.exec(`
      CREATE TABLE IF NOT EXISTS rundown_sessions (
        id TEXT PRIMARY KEY,
        church_id TEXT NOT NULL,
        room_id TEXT NOT NULL DEFAULT '',
        plan_id TEXT,
        plan_title TEXT,
        items TEXT NOT NULL DEFAULT '[]',
        item_timings TEXT NOT NULL DEFAULT '[]',
        current_index INTEGER NOT NULL DEFAULT 0,
        state TEXT NOT NULL DEFAULT 'active',
        caller_name TEXT,
        started_at INTEGER,
        scheduled_start INTEGER,
        current_item_started_at INTEGER,
        total_planned_duration INTEGER,
        updated_at INTEGER
      )
    `);
    await this._db.exec(`
      CREATE INDEX IF NOT EXISTS idx_rundown_sessions_church_state
        ON rundown_sessions(church_id, state)
    `);
    // Migration: add room_id column for existing tables
    try {
      await this._db.exec(`ALTER TABLE rundown_sessions ADD COLUMN room_id TEXT NOT NULL DEFAULT ''`);
    } catch { /* column already exists */ }
  }

  async _restoreActiveSessions() {
    const rows = await this._db.query(
      `SELECT * FROM rundown_sessions WHERE state != 'ended'`
    );
    for (const row of rows) {
      const roomId = row.room_id || '';
      const key = this._sessionKey(row.church_id, roomId);
      const session = {
        churchId: row.church_id,
        roomId,
        planId: row.plan_id,
        planTitle: row.plan_title,
        callerName: row.caller_name,
        items: this._parseJSON(row.items, []),
        currentIndex: row.current_index,
        state: row.state,
        startedAt: row.started_at,
        scheduledStart: row.scheduled_start,
        currentItemStartedAt: row.current_item_started_at,
        totalPlannedDuration: row.total_planned_duration,
        itemTimings: this._parseJSON(row.item_timings, []),
        warningThresholdSec: 30,
      };
      this._sessions.set(key, session);
      this._startTick(key);
      this._log(`[LiveRundown] Restored session for church ${row.church_id} room ${roomId || '(default)'}: "${row.plan_title}"`);
    }
  }

  _parseJSON(str, fallback) {
    try { return JSON.parse(str || 'null') ?? fallback; } catch { return fallback; }
  }

  _isPlayableItem(item) {
    return !!item && item.itemType !== 'section';
  }

  _findFirstPlayableIndex(items = []) {
    const index = items.findIndex((item) => this._isPlayableItem(item));
    return index >= 0 ? index : 0;
  }

  _findNextPlayableIndex(items = [], currentIndex = -1) {
    for (let i = Number(currentIndex) + 1; i < items.length; i += 1) {
      if (this._isPlayableItem(items[i])) return i;
    }
    return null;
  }

  _findPreviousPlayableIndex(items = [], currentIndex = 0) {
    for (let i = Number(currentIndex) - 1; i >= 0; i -= 1) {
      if (this._isPlayableItem(items[i])) return i;
    }
    return null;
  }

  // ─── DB WRITE HELPERS ──────────────────────────────────────────────────────

  _dbUpsert(session) {
    if (!this._db) return;
    const now = Date.now();
    const key = this._sessionKey(session.churchId, session.roomId);
    this._db.run(`
      INSERT INTO rundown_sessions
        (id, church_id, room_id, plan_id, plan_title, items, item_timings, current_index, state,
         caller_name, started_at, scheduled_start, current_item_started_at, total_planned_duration, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        items = excluded.items,
        item_timings = excluded.item_timings,
        current_index = excluded.current_index,
        state = excluded.state,
        current_item_started_at = excluded.current_item_started_at,
        updated_at = excluded.updated_at
    `, [
      key,
      session.churchId,
      session.roomId || '',
      session.planId,
      session.planTitle,
      JSON.stringify(session.items),
      JSON.stringify(session.itemTimings),
      session.currentIndex,
      session.state,
      session.callerName,
      session.startedAt,
      session.scheduledStart,
      session.currentItemStartedAt,
      session.totalPlannedDuration,
      now,
    ]).catch(err => this._log(`[LiveRundown] DB upsert failed: ${err.message}`));
  }

  _dbMarkEnded(key) {
    if (!this._db) return;
    this._db.run(
      `UPDATE rundown_sessions SET state = 'ended', updated_at = ? WHERE id = ?`,
      [Date.now(), key]
    ).catch(err => this._log(`[LiveRundown] DB end-mark failed: ${err.message}`));
  }

  /**
   * Update companion actions for an item in an active session.
   * Called after the portal saves new actions so they take effect immediately.
   *
   * @param {string} churchId
   * @param {string} roomId - room the session belongs to ('' for default)
   * @param {string} itemId - PCO item ID
   * @param {Array}  actions - array of action objects
   */
  setItemActions(churchId, roomId, itemId, actions) {
    // Try specific room first, then fall back to finding by churchId
    const key = this._sessionKey(churchId, roomId);
    let session = this._sessions.get(key);
    if (!session && !roomId) {
      // Legacy: find any session for this church
      for (const [k, s] of this._sessions) {
        if (s.churchId === churchId) { session = s; break; }
      }
    }
    if (!session) return;
    session.companionActions.set(itemId, actions || []);
  }

  /**
   * Start a new live rundown session for a church room.
   *
   * @param {string} churchId
   * @param {string} roomId - room this session belongs to ('' for default/unscoped)
   * @param {object} plan - PCO plan object with items, title, times, etc.
   * @param {string} callerName - Name of the TD who started the session
   * @param {object} companionActionsMap - optional { [itemId]: Action[] } loaded from DB
   * @returns {object} session state
   */
  startSession(churchId, roomId, plan, callerName = 'TD', companionActionsMap = {}) {
    const key = this._sessionKey(churchId, roomId);
    // End any existing session for this room first
    if (this._sessions.has(key)) {
      this.endSession(churchId, roomId, 'replaced');
    }

    // Extract service items that are actionable (skip headers for position tracking,
    // but include them in the list for display)
    const items = (plan.items || []).map((item, index) => ({
      ...item,
      index,
      id: item.id,
      title: item.title,
      itemType: item.itemType,
      servicePosition: item.servicePosition ?? item.sequence ?? item.sortOrder ?? index + 1,
      lengthSeconds: Number(item.lengthSeconds) > 0 ? Number(item.lengthSeconds) : 0,
      description: item.description ?? item.summary ?? null,
      notes: Array.isArray(item.notes) ? item.notes : (item.notes ? [item.notes] : []),
      songTitle: item.songTitle || null,
      author: item.author || null,
      arrangementKey: item.arrangementKey || null,
      // Timing fields populated on start
      plannedStartOffset: 0,
      actualDuration: null,
    }));

    // Calculate planned start offsets (cumulative durations)
    let offset = 0;
    for (const item of items) {
      item.plannedStartOffset = offset;
      if (item.lengthSeconds > 0) {
        offset += item.lengthSeconds;
      }
    }

    const serviceTime = plan.times?.find(t => t.timeType === 'service') || plan.times?.[0];
    const scheduledStart = serviceTime?.startsAt ? new Date(serviceTime.startsAt).getTime() : null;

    const now = Date.now();
    const initialIndex = this._findFirstPlayableIndex(items);
    // Build Map<itemId, actions[]> from the provided map
    const companionActions = new Map(Object.entries(companionActionsMap));

    const session = {
      churchId,
      roomId: roomId || '',
      planId: plan.id,
      planTitle: plan.title,
      source: plan.source || null,
      callerName,
      items,
      team: plan.team || [],
      currentIndex: initialIndex,
      state: 'active', // active | paused | ended
      startedAt: now,
      scheduledStart,
      currentItemStartedAt: now,
      totalPlannedDuration: offset,
      // Per-item actual timing records
      itemTimings: [], // { index, startedAt, endedAt, actualDuration, plannedDuration }
      warningThresholdSec: 30, // seconds before end to show warning
      autoAdvance: false, // when true, PP presentation changes or timer expiry can advance
      lastAutoAdvanceAt: null, // debounce: timestamp of last auto-advance
      // Pause state
      isPaused: false,
      pausedAt: null,           // timestamp when paused
      pausedElapsed: 0,         // seconds elapsed on current item at moment of pause
      autoAdvancedFrom: null, // title of last auto-advanced item
      // Companion automation: Map<itemId, Action[]>
      companionActions,
    };

    this._sessions.set(key, session);

    // Record timing for the first item
    session.itemTimings.push({
      index: initialIndex,
      startedAt: now,
      endedAt: null,
      actualDuration: null,
      plannedDuration: items[initialIndex]?.lengthSeconds || 0,
    });

    // Persist to DB
    this._dbUpsert(session);

    // Start the tick timer (broadcasts every second)
    this._startTick(key);

    this._log(`[LiveRundown] Session started for church ${churchId} room ${roomId || '(default)'}: "${plan.title}" (${items.length} items) by ${callerName}`);

    const state = this._buildState(session);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Advance to the next item.
   */
  advance(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;

    const nextIndex = this._findNextPlayableIndex(session.items, session.currentIndex);
    if (nextIndex == null) return null;

    return this._moveTo(session, nextIndex);
  }

  /**
   * Go back to the previous item.
   */
  back(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;

    const prevIndex = this._findPreviousPlayableIndex(session.items, session.currentIndex);
    if (prevIndex == null) return null;

    return this._moveTo(session, prevIndex);
  }

  /**
   * Jump to a specific item index.
   */
  goTo(churchId, roomId, index) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;

    if (index < 0 || index >= session.items.length) return null;
    if (index === session.currentIndex) return this._buildState(session);

    return this._moveTo(session, index);
  }

  /**
   * End the current session.
   */
  endSession(churchId, roomId, reason = 'completed') {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session) return null;

    // Close out current item timing
    this._closeCurrentItemTiming(session);
    session.state = 'ended';

    this._stopTick(key);
    this._sessions.delete(key);

    // Persist ended state to DB
    this._dbMarkEnded(key);

    const summary = {
      planId: session.planId,
      planTitle: session.planTitle,
      roomId: session.roomId || '',
      totalDuration: Date.now() - session.startedAt,
      totalPlannedDuration: session.totalPlannedDuration * 1000,
      itemTimings: session.itemTimings,
      reason,
    };

    this._log(`[LiveRundown] Session ended for church ${churchId} room ${roomId || '(default)'}: "${session.planTitle}" (${reason})`);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_ended', ...summary });

    // Clear any sync relationships for this session
    this._clearSyncForSession(churchId, roomId);

    return summary;
  }

  /**
   * Get the current session state for a church room (for late-joining clients).
   */
  getState(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session) return null;
    return this._buildState(session);
  }

  /**
   * Get all active sessions for a church (across all rooms).
   * Returns array of { roomId, state }.
   */
  getSessionsForChurch(churchId) {
    const result = [];
    for (const [key, session] of this._sessions) {
      if (session.churchId === churchId && session.state === 'active') {
        result.push({ roomId: session.roomId || '', state: this._buildState(session) });
      }
    }
    return result;
  }

  /**
   * Get a compact timer state for the countdown timer display.
   * Returns null if no active session or no matching planId.
   */
  getTimerState(churchId, roomId, planId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;
    if (planId && session.planId !== planId) return null;

    const now = Date.now();
    const currentItem = session.items[session.currentIndex] || null;
    const nextItemIndex = this._findNextPlayableIndex(session.items, session.currentIndex);
    const nextItem = nextItemIndex != null ? session.items[nextItemIndex] : null;
    const elapsedOnItem = session.isPaused
      ? session.pausedElapsed
      : (currentItem ? (now - session.currentItemStartedAt) / 1000 : 0);
    const duration = currentItem?.lengthSeconds || 0;
    const remaining = duration > 0 ? Math.max(0, duration - elapsedOnItem) : null;
    const isOvertime = duration > 0 && elapsedOnItem > duration;

    // Phase 2: Smart timing — variance + projected end
    const timing = this._calculateSmartTiming(session, now);

    return {
      plan_id: session.planId,
      plan_title: session.planTitle,
      room_id: session.roomId || '',
      cue_title: currentItem?.title || '',
      cue_index: session.currentIndex,
      cue_color: currentItem?.color || null,
      total_cues: session.items.length,
      cue_duration_seconds: duration,
      elapsed_seconds: Math.round(elapsedOnItem),
      remaining_seconds: remaining !== null ? Math.round(remaining) : null,
      overtime_seconds: isOvertime ? Math.round(elapsedOnItem - duration) : 0,
      is_overtime: isOvertime,
      is_warning: duration > 0 && remaining !== null && remaining <= session.warningThresholdSec && remaining > 0,
      is_live: true,
      is_paused: session.isPaused || false,
      next_cue_title: nextItem?.title || null,
      next_cue_duration: nextItem?.lengthSeconds || null,
      next_cue_index: nextItemIndex,
      next_cue_color: nextItem?.color || null,
      started_at: session.startedAt,
      scheduled_start: session.scheduledStart,
      total_planned_duration: session.totalPlannedDuration,
      timestamp: now,
      // Phase 2: Smart timing fields
      variance: timing.variance,
      projected_end_time: timing.projectedEndTime,
      service_elapsed: timing.serviceElapsed,
      service_remaining: timing.serviceRemaining,
      item_timings: timing.itemTimings,
      upcoming_items: timing.upcomingItems,
    };
  }

  /**
   * Find session by planId (for public token lookups).
   * Returns { churchId, roomId } or null.
   */
  findSessionByPlanId(planId) {
    for (const [, session] of this._sessions) {
      if (session.planId === planId && session.state === 'active') {
        return { churchId: session.churchId, roomId: session.roomId || '' };
      }
    }
    return null;
  }

  /**
   * Toggle auto-advance for a church room's session (timer-based and PP-triggered).
   */
  setAutoAdvance(churchId, roomId, enabled) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;
    session.autoAdvance = !!enabled;
    if (!enabled) session.autoAdvancedFrom = null;
    this._log(`[LiveRundown] Auto-advance ${session.autoAdvance ? 'enabled' : 'disabled'} for church ${churchId} room ${roomId || '(default)'}`);
    const state = this._buildState(session);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Pause the current timer without ending the session.
   * Freezes the timer at its current value; all connected clients see PAUSED state.
   */
  pauseSession(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active' || session.isPaused) return null;

    const now = Date.now();
    session.isPaused = true;
    session.pausedAt = now;
    session.pausedElapsed = (now - session.currentItemStartedAt) / 1000;

    this._dbUpsert(session);
    this._log(`[LiveRundown] Session paused for church ${churchId} room ${roomId || '(default)'}`);

    const state = this._buildState(session);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Resume from pause. Adjusts currentItemStartedAt so the timer continues
   * from where it was frozen.
   */
  resumeSession(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active' || !session.isPaused) return null;

    const now = Date.now();
    // Reset start time so elapsed calculation picks up where we left off
    session.currentItemStartedAt = now - (session.pausedElapsed * 1000);
    session.isPaused = false;
    session.pausedAt = null;
    session.pausedElapsed = 0;

    this._dbUpsert(session);
    this._log(`[LiveRundown] Session resumed for church ${churchId} room ${roomId || '(default)'}`);

    const state = this._buildState(session);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Add or subtract seconds from the current item's timer.
   * Positive = add time (extend), Negative = subtract time.
   */
  addTime(churchId, roomId, seconds) {
    const key = this._sessionKey(churchId, roomId);
    const session = this._sessions.get(key);
    if (!session || session.state !== 'active') return null;

    const currentItem = session.items[session.currentIndex];
    if (!currentItem) return null;

    // Adjust the item's planned duration
    currentItem.lengthSeconds = Math.max(0, (currentItem.lengthSeconds || 0) + seconds);

    // If paused, no need to adjust startedAt
    if (!session.isPaused) {
      // Recalculate total planned duration
      let total = 0;
      for (const item of session.items) {
        if (item.lengthSeconds > 0) total += item.lengthSeconds;
      }
      session.totalPlannedDuration = total;
    }

    this._log(`[LiveRundown] Timer adjusted by ${seconds > 0 ? '+' : ''}${seconds}s for church ${churchId} room ${roomId || '(default)'}`);

    const state = this._buildState(session);
    this._broadcastToRoom(churchId, roomId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Check if a church has an active session (optionally for a specific room).
   * If roomId is omitted, checks if any session exists for the church.
   */
  hasSession(churchId, roomId) {
    if (roomId !== undefined) {
      return this._sessions.has(this._sessionKey(churchId, roomId));
    }
    // Check if any session exists for this church
    for (const [, session] of this._sessions) {
      if (session.churchId === churchId && session.state === 'active') return true;
    }
    return false;
  }

  /**
   * Called when a ProPresenter presentation changes. If auto-advance is on,
   * try to match the presentation name against upcoming rundown items and
   * advance if a match is found. Checks all sessions for the church (PP
   * doesn't know which room it belongs to).
   *
   * @param {string} churchId
   * @param {string} presentationName - Name of the new PP presentation
   * @param {string} [roomId] - optional room hint from the device
   * @returns {object|null} new state if advanced, null otherwise
   */
  onPresentationChange(churchId, presentationName, roomId) {
    if (!presentationName) return null;

    // Collect sessions to check: specific room if given, otherwise all for this church
    const sessionsToCheck = [];
    if (roomId !== undefined) {
      const session = this._sessions.get(this._sessionKey(churchId, roomId));
      if (session) sessionsToCheck.push(session);
    } else {
      for (const [, session] of this._sessions) {
        if (session.churchId === churchId && session.state === 'active') {
          sessionsToCheck.push(session);
        }
      }
    }

    for (const session of sessionsToCheck) {
      if (session.state !== 'active' || !session.autoAdvance) continue;

      // Debounce: ignore if last auto-advance was less than 2 seconds ago
      const now = Date.now();
      if (session.lastAutoAdvanceAt && (now - session.lastAutoAdvanceAt) < 2000) continue;

      const normalized = presentationName.toLowerCase().trim();

      // Look ahead from current position: check next 3 items (skip current)
      const startIdx = session.currentIndex + 1;
      const endIdx = Math.min(startIdx + 3, session.items.length);

      for (let i = startIdx; i < endIdx; i++) {
        const item = session.items[i];
        if (!this._isPlayableItem(item)) continue;
        if (this._matchesPresentationName(normalized, item)) {
          session.lastAutoAdvanceAt = now;
          this._log(`[LiveRundown] Auto-advancing church ${churchId} room ${session.roomId || '(default)'} to item ${i} ("${item.title}") — matched PP presentation "${presentationName}"`);
          return this._moveTo(session, i, presentationName);
        }
      }
    }

    return null;
  }

  /**
   * Check if a normalized PP presentation name matches a rundown item.
   * Compares against item title and songTitle using normalized containment.
   */
  _matchesPresentationName(normalizedPresName, item) {
    if (!normalizedPresName) return false;

    const candidates = [item.title, item.songTitle].filter(Boolean);
    for (const candidate of candidates) {
      const normalizedCandidate = candidate.toLowerCase().trim();
      if (!normalizedCandidate) continue;
      // Either direction containment: "Amazing Grace" matches "Amazing Grace (arr. Smith)"
      // and "worship: Amazing Grace" matches "Amazing Grace"
      if (normalizedPresName.includes(normalizedCandidate) || normalizedCandidate.includes(normalizedPresName)) {
        return true;
      }
    }
    return false;
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────────────

  _moveTo(session, newIndex, autoAdvancedFrom = null) {
    const now = Date.now();

    // Auto-resume if paused when moving to a new item
    if (session.isPaused) {
      session.isPaused = false;
      session.pausedAt = null;
      session.pausedElapsed = 0;
    }

    // Close timing for the item we're leaving
    this._closeCurrentItemTiming(session);

    // Move to new position
    session.currentIndex = newIndex;
    session.currentItemStartedAt = now;

    // Track auto-advance source (cleared on next manual move)
    session.autoAdvancedFrom = autoAdvancedFrom || null;

    // Start timing for the new item
    session.itemTimings.push({
      index: newIndex,
      startedAt: now,
      endedAt: null,
      actualDuration: null,
      plannedDuration: session.items[newIndex]?.lengthSeconds || 0,
    });

    // Persist position change to DB
    this._dbUpsert(session);

    const state = this._buildState(session);
    this._broadcastToRoom(session.churchId, session.roomId, { type: 'rundown_position', ...state });

    // Trigger cross-room sync advances (if any sessions mirror this one)
    this._triggerSyncAdvances(session.churchId, session.roomId);

    // Trigger Companion actions for the new item (if any are configured)
    const newItem = session.items[newIndex];
    if (newItem && session.companionActions.size > 0) {
      const actions = session.companionActions.get(newItem.id);
      if (actions && actions.length > 0) {
        this._broadcastToChurch(session.churchId, {
          type: 'companion_actions',
          planId: session.planId,
          roomId: session.roomId || '',
          itemId: newItem.id,
          itemTitle: newItem.title,
          currentIndex: newIndex,
          actions,
        });
        this._log(`[LiveRundown] Triggered ${actions.length} Companion action(s) for item "${newItem.title}" (${session.churchId} room ${session.roomId || '(default)'})`);
      }
    }

    return state;
  }

  _closeCurrentItemTiming(session) {
    const now = Date.now();
    const currentTiming = session.itemTimings.find(
      t => t.index === session.currentIndex && t.endedAt === null
    );
    if (currentTiming) {
      currentTiming.endedAt = now;
      currentTiming.actualDuration = (now - currentTiming.startedAt) / 1000;
    }
  }

  /**
   * Build the full state snapshot for broadcasting.
   */
  _buildState(session) {
    const now = Date.now();
    const currentItem = session.items[session.currentIndex] || null;
    // When paused, use frozen elapsed value instead of live calculation
    const elapsedOnItem = session.isPaused
      ? session.pausedElapsed
      : (now - session.currentItemStartedAt) / 1000;
    const remainingOnItem = currentItem?.lengthSeconds
      ? Math.max(0, currentItem.lengthSeconds - elapsedOnItem)
      : null;
    const itemOvertime = currentItem?.lengthSeconds
      ? Math.max(0, elapsedOnItem - currentItem.lengthSeconds)
      : 0;

    // Calculate rippled start times for all items
    const rippledItems = this._calculateRipple(session, now);

    // Calculate overall schedule delta
    const scheduleDelta = this._calculateScheduleDelta(session, now);

    return {
      churchId: session.churchId,
      roomId: session.roomId || '',
      planId: session.planId,
      planTitle: session.planTitle,
      callerName: session.callerName,
      state: session.state,
      currentIndex: session.currentIndex,
      currentCueIndex: session.currentIndex,
      totalItems: session.items.length,
      currentItem: currentItem ? {
        ...currentItem,
        elapsedSeconds: Math.round(elapsedOnItem),
        remainingSeconds: remainingOnItem !== null ? Math.round(remainingOnItem) : null,
        overtimeSeconds: Math.round(itemOvertime),
        isOvertime: currentItem.lengthSeconds > 0 && elapsedOnItem > currentItem.lengthSeconds,
        isWarning: currentItem.lengthSeconds > 0 && remainingOnItem !== null && remainingOnItem <= session.warningThresholdSec && remainingOnItem > 0,
      } : null,
      items: rippledItems,
      scheduleDelta,
      team: session.team,
      startedAt: session.startedAt,
      scheduledStart: session.scheduledStart,
      totalPlannedDuration: session.totalPlannedDuration,
      totalElapsed: Math.round((now - session.startedAt) / 1000),
      autoAdvance: session.autoAdvance,
      effectiveAutoAdvance: session.autoAdvance || !!currentItem?.autoAdvance,
      autoAdvancedFrom: session.autoAdvancedFrom || null,
      source: session.source || null,
      isPaused: session.isPaused || false,
      timestamp: now,
    };
  }

  /**
   * Calculate smart timing data: cumulative variance, projected end, per-item actuals,
   * and upcoming items for confidence monitor / show mode displays.
   */
  _calculateSmartTiming(session, now) {
    let variance = 0; // positive = behind, negative = ahead (seconds)

    // Sum variance from all completed items
    for (const timing of session.itemTimings) {
      if (timing.endedAt != null && timing.actualDuration != null && timing.plannedDuration > 0) {
        variance += timing.actualDuration - timing.plannedDuration;
      }
    }

    // Add current item's running variance (if it has a planned duration)
    const currentItem = session.items[session.currentIndex];
    if (currentItem?.lengthSeconds > 0) {
      const elapsedOnCurrent = session.isPaused
        ? session.pausedElapsed
        : (now - session.currentItemStartedAt) / 1000;
      if (elapsedOnCurrent > currentItem.lengthSeconds) {
        variance += elapsedOnCurrent - currentItem.lengthSeconds;
      }
    }

    // Service elapsed
    const serviceElapsed = Math.round((now - session.startedAt) / 1000);

    // Projected end time: original planned end + cumulative variance
    const plannedEndMs = session.startedAt + (session.totalPlannedDuration * 1000);
    const projectedEndMs = plannedEndMs + (variance * 1000);
    const projectedEndTime = new Date(projectedEndMs).toISOString();

    // Service remaining: projected end minus now
    const serviceRemaining = Math.max(0, Math.round((projectedEndMs - now) / 1000));

    // Per-item actual durations (for completed items)
    const itemTimings = session.itemTimings
      .filter(t => t.endedAt != null)
      .map(t => ({
        index: t.index,
        plannedDuration: t.plannedDuration,
        actualDuration: Math.round(t.actualDuration),
        variance: t.plannedDuration > 0 ? Math.round(t.actualDuration - t.plannedDuration) : 0,
      }));

    // Upcoming items (next 3 playable) for confidence monitor
    const upcomingItems = [];
    let searchIdx = session.currentIndex;
    while (upcomingItems.length < 3) {
      const nextIdx = this._findNextPlayableIndex(session.items, searchIdx);
      if (nextIdx == null) break;
      const item = session.items[nextIdx];
      upcomingItems.push({
        index: nextIdx,
        title: item.title,
        lengthSeconds: item.lengthSeconds || 0,
        color: item.color || null,
        itemType: item.itemType,
      });
      searchIdx = nextIdx;
    }

    return {
      variance: Math.round(variance),
      projectedEndTime,
      serviceElapsed,
      serviceRemaining,
      itemTimings,
      upcomingItems,
    };
  }

  /**
   * Calculate rippled estimated start times for all remaining items.
   * Completed items show actual times; future items shift based on accumulated delay.
   */
  _calculateRipple(session, now) {
    const items = session.items;
    const result = [];
    let accumulatedOffset = 0; // positive = behind schedule

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      const timing = session.itemTimings.find(t => t.index === i);
      const isCompleted = timing?.endedAt != null;
      const isCurrent = i === session.currentIndex;

      let estimatedStartMs;
      let status;

      if (isCompleted) {
        // Past item: show actual start time
        estimatedStartMs = timing.startedAt;
        status = 'completed';
        // Calculate how much this item shifted schedule
        if (timing.actualDuration != null && timing.plannedDuration > 0) {
          accumulatedOffset += timing.actualDuration - timing.plannedDuration;
        }
      } else if (isCurrent) {
        estimatedStartMs = session.currentItemStartedAt;
        status = 'current';
        // Current item's overtime contributes to offset for future items
        const elapsedOnCurrent = (now - session.currentItemStartedAt) / 1000;
        if (item.lengthSeconds > 0 && elapsedOnCurrent > item.lengthSeconds) {
          accumulatedOffset += elapsedOnCurrent - item.lengthSeconds;
        }
      } else {
        // Future item: planned start + accumulated offset
        const plannedStartMs = session.startedAt + (item.plannedStartOffset * 1000);
        estimatedStartMs = plannedStartMs + (accumulatedOffset * 1000);
        status = 'upcoming';
      }

      result.push({
        ...item,
        estimatedStartMs,
        status,
        actualDuration: timing?.actualDuration ?? null,
      });
    }

    return result;
  }

  /**
   * Calculate overall ahead/behind schedule delta in seconds.
   * Negative = ahead of schedule, Positive = behind schedule.
   */
  _calculateScheduleDelta(session, now) {
    const elapsedMs = now - session.startedAt;
    const elapsedSec = elapsedMs / 1000;

    // Sum planned durations for all completed items + current item
    let plannedElapsed = 0;
    for (let i = 0; i <= session.currentIndex; i++) {
      if (i < session.currentIndex) {
        plannedElapsed += session.items[i].lengthSeconds || 0;
      }
      // Current item: how much of its duration should have elapsed
      // (we count the full planned durations of past items)
    }

    // Actual elapsed time vs where we should be based on completed item durations
    // plus current item's planned start offset
    const currentPlannedStart = session.items[session.currentIndex]?.plannedStartOffset || 0;
    const currentElapsedOnItem = (now - session.currentItemStartedAt) / 1000;
    const currentPlannedDuration = session.items[session.currentIndex]?.lengthSeconds || 0;

    // We're "behind" if actual total elapsed > planned elapsed for items through current
    const actualThroughCurrent = elapsedSec;
    const plannedThroughCurrent = currentPlannedStart + Math.min(currentElapsedOnItem, currentPlannedDuration || currentElapsedOnItem);

    const delta = Math.round(actualThroughCurrent - plannedThroughCurrent);

    return {
      seconds: delta,
      label: delta === 0 ? 'On Time' : delta > 0 ? `${this._formatDelta(delta)} behind` : `${this._formatDelta(Math.abs(delta))} ahead`,
      isAhead: delta < 0,
      isBehind: delta > 0,
      isOnTime: Math.abs(delta) < 15, // within 15 seconds = "on time"
    };
  }

  _formatDelta(seconds) {
    if (seconds < 60) return `${seconds}s`;
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return s > 0 ? `${m}m ${s}s` : `${m}m`;
  }

  /**
   * Start the 1-second tick timer for countdown broadcasts.
   * @param {string} key - composite session key "churchId:roomId"
   */
  _startTick(key) {
    this._stopTick(key);
    let tickCount = 0;
    const timer = setInterval(() => {
      const session = this._sessions.get(key);
      if (!session || session.state !== 'active') {
        this._stopTick(key);
        return;
      }

      const { churchId, roomId } = session;

      // Persist to DB every 30 seconds
      tickCount++;
      if (tickCount % 30 === 0) {
        this._dbUpsert(session);
      }

      const now = Date.now();
      const currentItem = session.items[session.currentIndex];
      if (!currentItem) return;

      // When paused, use frozen elapsed value
      const elapsedOnItem = session.isPaused
        ? session.pausedElapsed
        : (now - session.currentItemStartedAt) / 1000;
      const remainingOnItem = currentItem.lengthSeconds
        ? Math.max(0, currentItem.lengthSeconds - elapsedOnItem)
        : null;

      // Auto-advance: when remaining hits 0 and auto-advance is on (skip if paused)
      const shouldAutoAdvance = !session.isPaused && (session.autoAdvance || !!currentItem.autoAdvance);
      if (shouldAutoAdvance && currentItem.lengthSeconds > 0 && remainingOnItem !== null && remainingOnItem <= 0) {
        const nextIndex = this._findNextPlayableIndex(session.items, session.currentIndex);
        if (nextIndex != null) {
          this._moveTo(session, nextIndex, currentItem.title);
          return; // _moveTo broadcasts rundown_position, skip the tick
        }
      }

      // Phase 2: Smart timing for tick broadcasts
      const smartTiming = this._calculateSmartTiming(session, now);

      const elapsed = Math.round(elapsedOnItem);
      const remaining = remainingOnItem !== null ? Math.round(remainingOnItem) : null;
      const isOvertime = currentItem.lengthSeconds > 0 && elapsedOnItem > currentItem.lengthSeconds;
      const overtime = currentItem.lengthSeconds > 0 ? Math.round(Math.max(0, elapsedOnItem - currentItem.lengthSeconds)) : 0;
      const isWarn = currentItem.lengthSeconds > 0 && remainingOnItem !== null && remainingOnItem <= session.warningThresholdSec && remainingOnItem > 0;
      const delta = this._calculateScheduleDelta(session, now);
      const totalEl = Math.round((now - session.startedAt) / 1000);

      // Delta encoding: only send fields that changed since last tick
      const prev = session._lastTick || {};
      const tick = { type: 'rundown_tick', roomId: roomId || '' };
      if (prev.currentIndex !== session.currentIndex) tick.currentIndex = session.currentIndex;
      tick.elapsedSeconds = elapsed;
      if (remaining !== prev.remainingSeconds) tick.remainingSeconds = remaining;
      if (isOvertime !== prev.isOvertime) tick.isOvertime = isOvertime;
      if (overtime !== prev.overtimeSeconds) tick.overtimeSeconds = overtime;
      if (isWarn !== prev.isWarning) tick.isWarning = isWarn;
      if (delta !== prev.scheduleDelta) tick.scheduleDelta = delta;
      tick.totalElapsed = totalEl;
      if (session.autoAdvancedFrom) {
        tick.autoAdvancedFrom = session.autoAdvancedFrom;
      }
      // Phase 2 smart timing fields
      tick.variance = smartTiming.variance;
      tick.projectedEndTime = smartTiming.projectedEndTime;
      tick.serviceElapsed = smartTiming.serviceElapsed;
      tick.serviceRemaining = smartTiming.serviceRemaining;
      tick.isPaused = session.isPaused || false;

      session._lastTick = {
        currentIndex: session.currentIndex, elapsedSeconds: elapsed,
        remainingSeconds: remaining, isOvertime, overtimeSeconds: overtime,
        isWarning: isWarn, scheduleDelta: delta, totalElapsed: totalEl,
      };

      // Clear autoAdvancedFrom after broadcasting once
      if (session.autoAdvancedFrom) session.autoAdvancedFrom = null;

      this._broadcastToRoom(churchId, roomId, tick);

      // Also broadcast a compact rundown_timer message for countdown displays
      const timerState = this.getTimerState(churchId, roomId);
      if (timerState) {
        this._broadcastToRoom(churchId, roomId, { type: 'rundown_timer', ...timerState });
      }
    }, 1000);

    this._tickTimers.set(key, timer);
  }

  _stopTick(key) {
    const timer = this._tickTimers.get(key);
    if (timer) {
      clearInterval(timer);
      this._tickTimers.delete(key);
    }
  }

  /**
   * Broadcast a message to all clients for a church room.
   * Messages include roomId so clients can filter by room subscription.
   */
  _broadcastToRoom(churchId, roomId, message) {
    // Inject roomId into the message for client-side filtering
    const msg = { ...message, roomId: roomId || '' };
    this._broadcastToMobile(churchId, msg);
    this._broadcastToPortal(churchId, msg);
    this._broadcastToControllers(churchId, msg);
  }

  // ─── CROSS-ROOM SYNC ───────────────────────────────────────────────────────

  /**
   * Register a sync relationship: when sourceKey session advances, advance
   * targetChurchId:targetRoomId after delaySeconds.
   *
   * Call this when a plan session starts with a sync config, or when the TD
   * explicitly enables sync. Replaces any existing target registration for
   * the same (source, target) pair.
   *
   * @param {string} sourceChurchId
   * @param {string} sourceRoomId
   * @param {string} targetChurchId
   * @param {string} targetRoomId
   * @param {number} delaySeconds — 0–10
   */
  registerSyncTarget(sourceChurchId, sourceRoomId, targetChurchId, targetRoomId, delaySeconds = 0) {
    const sourceKey = this._sessionKey(sourceChurchId, sourceRoomId);
    if (!this._syncTargets.has(sourceKey)) this._syncTargets.set(sourceKey, new Set());
    const targets = this._syncTargets.get(sourceKey);
    // Remove any existing entry for the same target
    for (const t of targets) {
      if (t.targetChurchId === targetChurchId && t.targetRoomId === targetRoomId) {
        targets.delete(t);
        break;
      }
    }
    targets.add({ targetChurchId, targetRoomId, delaySeconds: Math.max(0, Math.min(10, Number(delaySeconds) || 0)) });
    this._log(`[LiveRundown] Sync registered: ${sourceChurchId}:${sourceRoomId} → ${targetChurchId}:${targetRoomId} (delay ${delaySeconds}s)`);
  }

  /**
   * Remove a sync target for a source session.
   */
  unregisterSyncTarget(sourceChurchId, sourceRoomId, targetChurchId, targetRoomId) {
    const sourceKey = this._sessionKey(sourceChurchId, sourceRoomId);
    const targets = this._syncTargets.get(sourceKey);
    if (!targets) return;
    for (const t of targets) {
      if (t.targetChurchId === targetChurchId && t.targetRoomId === targetRoomId) {
        targets.delete(t);
        break;
      }
    }
    if (targets.size === 0) this._syncTargets.delete(sourceKey);
  }

  /**
   * Remove all sync registrations where this session is a source or target.
   * Called on endSession.
   */
  _clearSyncForSession(churchId, roomId) {
    const key = this._sessionKey(churchId, roomId);
    // Remove as source
    this._syncTargets.delete(key);
    // Remove as target from all sources
    for (const [sourceKey, targets] of this._syncTargets) {
      for (const t of targets) {
        if (t.targetChurchId === churchId && t.targetRoomId === roomId) {
          targets.delete(t);
        }
      }
      if (targets.size === 0) this._syncTargets.delete(sourceKey);
    }
  }

  /**
   * Fire sync advances for all registered targets of a source session.
   * Called after the source session moves to a new position.
   *
   * @param {string} churchId - source church
   * @param {string} roomId - source room
   */
  _triggerSyncAdvances(churchId, roomId) {
    const sourceKey = this._sessionKey(churchId, roomId);
    const targets = this._syncTargets.get(sourceKey);
    if (!targets || targets.size === 0) return;

    for (const { targetChurchId, targetRoomId, delaySeconds } of targets) {
      const doAdvance = () => {
        const state = this.advance(targetChurchId, targetRoomId);
        if (state) {
          this._log(`[LiveRundown] Sync advance: ${targetChurchId}:${targetRoomId} (mirrored from ${churchId}:${roomId})`);
        }
      };

      if (delaySeconds <= 0) {
        doAdvance();
      } else {
        const handle = setTimeout(() => {
          this._syncTimers.delete(handle);
          doAdvance();
        }, delaySeconds * 1000);
        this._syncTimers.add(handle);
      }
    }
  }

  // ─── ROOM READY-CHECK STATUS ──────────────────────────────────────────────

  /**
   * Get the in-memory ready status for a room.
   * @returns {{ status: string, label: string, updatedAt: number } | null}
   */
  getRoomStatus(churchId, roomId) {
    return this._roomStatus.get(this._sessionKey(churchId, roomId)) || null;
  }

  /**
   * Set in-memory ready status for a room and broadcast to portal clients.
   * The caller is responsible for persisting to DB.
   *
   * @param {string} churchId
   * @param {string} roomId
   * @param {string} status — 'ready' | 'standby' | 'issue'
   * @param {string} label — optional display label
   */
  setRoomStatus(churchId, roomId, status, label = '') {
    const key = this._sessionKey(churchId, roomId);
    const entry = { status, label: label || '', updatedAt: Date.now() };
    this._roomStatus.set(key, entry);
    this._broadcastToPortal(churchId, {
      type: 'room_status_update',
      churchId,
      roomId,
      ...entry,
    });
    this._log(`[LiveRundown] Room status: ${churchId}:${roomId} → ${status}`);
  }

  /**
   * Get all room statuses for a church.
   * @returns {Array<{ roomId, status, label, updatedAt }>}
   */
  getAllRoomStatuses(churchId) {
    const result = [];
    const prefix = churchId + ':';
    for (const [key, val] of this._roomStatus) {
      if (key.startsWith(prefix)) {
        result.push({ roomId: key.substring(prefix.length), ...val });
      }
    }
    return result;
  }

  /**
   * Load room statuses from DB into memory on startup.
   * @param {Array<{ churchId, roomId, status, label, updatedAt }>} rows
   */
  loadRoomStatuses(rows) {
    for (const row of rows) {
      const key = this._sessionKey(row.churchId || row.church_id, row.roomId || row.room_id);
      this._roomStatus.set(key, {
        status: row.status,
        label: row.label || '',
        updatedAt: Number(row.updatedAt || row.updated_at || Date.now()),
      });
    }
  }

  /**
   * Clean up all sessions and timers.
   */
  shutdown() {
    for (const churchId of this._tickTimers.keys()) {
      this._stopTick(churchId);
    }
    for (const handle of this._syncTimers) {
      clearTimeout(handle);
    }
    this._syncTimers.clear();
    this._sessions.clear();
  }
}

module.exports = { LiveRundownManager };
