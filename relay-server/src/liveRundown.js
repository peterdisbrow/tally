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
  constructor({ broadcastToMobile, broadcastToPortal, log = console.log } = {}) {
    // Map<churchId, RundownSession>
    this._sessions = new Map();
    this._tickTimers = new Map();
    this._broadcastToMobile = broadcastToMobile || (() => {});
    this._broadcastToPortal = broadcastToPortal || (() => {});
    this._log = log;
  }

  /**
   * Start a new live rundown session for a church.
   *
   * @param {string} churchId
   * @param {object} plan - PCO plan object with items, title, times, etc.
   * @param {string} callerName - Name of the TD who started the session
   * @returns {object} session state
   */
  startSession(churchId, plan, callerName = 'TD') {
    // End any existing session first
    if (this._sessions.has(churchId)) {
      this.endSession(churchId, 'replaced');
    }

    // Extract service items that are actionable (skip headers for position tracking,
    // but include them in the list for display)
    const items = (plan.items || []).map((item, index) => ({
      index,
      id: item.id,
      title: item.title,
      itemType: item.itemType,
      servicePosition: item.servicePosition,
      lengthSeconds: item.lengthSeconds || 0,
      description: item.description || null,
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
    const session = {
      churchId,
      planId: plan.id,
      planTitle: plan.title,
      callerName,
      items,
      currentIndex: 0,
      state: 'active', // active | paused | ended
      startedAt: now,
      scheduledStart,
      currentItemStartedAt: now,
      totalPlannedDuration: offset,
      // Per-item actual timing records
      itemTimings: [], // { index, startedAt, endedAt, actualDuration, plannedDuration }
      warningThresholdSec: 30, // seconds before end to show warning
    };

    this._sessions.set(churchId, session);

    // Record timing for the first item
    session.itemTimings.push({
      index: 0,
      startedAt: now,
      endedAt: null,
      actualDuration: null,
      plannedDuration: items[0]?.lengthSeconds || 0,
    });

    // Start the tick timer (broadcasts every second)
    this._startTick(churchId);

    this._log(`[LiveRundown] Session started for church ${churchId}: "${plan.title}" (${items.length} items) by ${callerName}`);

    const state = this._buildState(session);
    this._broadcast(churchId, { type: 'rundown_state', ...state });
    return state;
  }

  /**
   * Advance to the next item.
   */
  advance(churchId) {
    const session = this._sessions.get(churchId);
    if (!session || session.state !== 'active') return null;

    const nextIndex = session.currentIndex + 1;
    if (nextIndex >= session.items.length) return null;

    return this._moveTo(session, nextIndex);
  }

  /**
   * Go back to the previous item.
   */
  back(churchId) {
    const session = this._sessions.get(churchId);
    if (!session || session.state !== 'active') return null;

    const prevIndex = session.currentIndex - 1;
    if (prevIndex < 0) return null;

    return this._moveTo(session, prevIndex);
  }

  /**
   * Jump to a specific item index.
   */
  goTo(churchId, index) {
    const session = this._sessions.get(churchId);
    if (!session || session.state !== 'active') return null;

    if (index < 0 || index >= session.items.length) return null;
    if (index === session.currentIndex) return this._buildState(session);

    return this._moveTo(session, index);
  }

  /**
   * End the current session.
   */
  endSession(churchId, reason = 'completed') {
    const session = this._sessions.get(churchId);
    if (!session) return null;

    // Close out current item timing
    this._closeCurrentItemTiming(session);
    session.state = 'ended';

    this._stopTick(churchId);
    this._sessions.delete(churchId);

    const summary = {
      planId: session.planId,
      planTitle: session.planTitle,
      totalDuration: Date.now() - session.startedAt,
      totalPlannedDuration: session.totalPlannedDuration * 1000,
      itemTimings: session.itemTimings,
      reason,
    };

    this._log(`[LiveRundown] Session ended for church ${churchId}: "${session.planTitle}" (${reason})`);
    this._broadcast(churchId, { type: 'rundown_ended', ...summary });
    return summary;
  }

  /**
   * Get the current session state for a church (for late-joining clients).
   */
  getState(churchId) {
    const session = this._sessions.get(churchId);
    if (!session) return null;
    return this._buildState(session);
  }

  /**
   * Check if a church has an active session.
   */
  hasSession(churchId) {
    return this._sessions.has(churchId);
  }

  // ─── INTERNAL ──────────────────────────────────────────────────────────────

  _moveTo(session, newIndex) {
    const now = Date.now();

    // Close timing for the item we're leaving
    this._closeCurrentItemTiming(session);

    // Move to new position
    session.currentIndex = newIndex;
    session.currentItemStartedAt = now;

    // Start timing for the new item
    session.itemTimings.push({
      index: newIndex,
      startedAt: now,
      endedAt: null,
      actualDuration: null,
      plannedDuration: session.items[newIndex]?.lengthSeconds || 0,
    });

    const state = this._buildState(session);
    this._broadcast(session.churchId, { type: 'rundown_position', ...state });
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
    const elapsedOnItem = (now - session.currentItemStartedAt) / 1000;
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
      planId: session.planId,
      planTitle: session.planTitle,
      callerName: session.callerName,
      state: session.state,
      currentIndex: session.currentIndex,
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
      startedAt: session.startedAt,
      scheduledStart: session.scheduledStart,
      totalPlannedDuration: session.totalPlannedDuration,
      totalElapsed: Math.round((now - session.startedAt) / 1000),
      timestamp: now,
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
   */
  _startTick(churchId) {
    this._stopTick(churchId);
    const timer = setInterval(() => {
      const session = this._sessions.get(churchId);
      if (!session || session.state !== 'active') {
        this._stopTick(churchId);
        return;
      }

      const now = Date.now();
      const currentItem = session.items[session.currentIndex];
      if (!currentItem) return;

      const elapsedOnItem = (now - session.currentItemStartedAt) / 1000;
      const remainingOnItem = currentItem.lengthSeconds
        ? Math.max(0, currentItem.lengthSeconds - elapsedOnItem)
        : null;

      const tick = {
        type: 'rundown_tick',
        churchId,
        currentIndex: session.currentIndex,
        elapsedSeconds: Math.round(elapsedOnItem),
        remainingSeconds: remainingOnItem !== null ? Math.round(remainingOnItem) : null,
        isOvertime: currentItem.lengthSeconds > 0 && elapsedOnItem > currentItem.lengthSeconds,
        overtimeSeconds: currentItem.lengthSeconds > 0 ? Math.round(Math.max(0, elapsedOnItem - currentItem.lengthSeconds)) : 0,
        isWarning: currentItem.lengthSeconds > 0 && remainingOnItem !== null && remainingOnItem <= session.warningThresholdSec && remainingOnItem > 0,
        scheduleDelta: this._calculateScheduleDelta(session, now),
        totalElapsed: Math.round((now - session.startedAt) / 1000),
        timestamp: now,
      };

      this._broadcast(churchId, tick);
    }, 1000);

    this._tickTimers.set(churchId, timer);
  }

  _stopTick(churchId) {
    const timer = this._tickTimers.get(churchId);
    if (timer) {
      clearInterval(timer);
      this._tickTimers.delete(churchId);
    }
  }

  /**
   * Broadcast a message to all clients for a church (mobile + portal).
   */
  _broadcast(churchId, message) {
    this._broadcastToMobile(churchId, message);
    this._broadcastToPortal(churchId, message);
  }

  /**
   * Clean up all sessions and timers.
   */
  shutdown() {
    for (const churchId of this._tickTimers.keys()) {
      this._stopTick(churchId);
    }
    this._sessions.clear();
  }
}

module.exports = { LiveRundownManager };
