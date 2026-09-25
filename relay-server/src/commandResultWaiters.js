'use strict';
/**
 * Lets an HTTP request that sends a command to a church client wait for the
 * matching command_result (by id) instead of answering "sent" blindly.
 * Used by POST /api/church/app/send-command with { wait: true } so the booth
 * app can tell the operator "Scene not found" instead of a fake "OK".
 */
const waiters = new Map(); // commandId -> { resolve, timer }

function waitForCommandResult(commandId, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      waiters.delete(commandId);
      resolve({ timedOut: true });
    }, timeoutMs);
    if (timer.unref) timer.unref();
    waiters.set(commandId, { resolve, timer });
  });
}

/** Called for every command_result from a church client. Returns true if a waiter consumed it. */
function resolveCommandResult(msg) {
  const id = msg && (msg.messageId || msg.id);
  if (!id) return false;
  const w = waiters.get(id);
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(id);
  w.resolve({ result: msg.result, error: msg.error });
  return true;
}

/** Drop a waiter that will never be answered (command not delivered). */
function cancelWaiter(commandId) {
  const w = waiters.get(commandId);
  if (!w) return false;
  clearTimeout(w.timer);
  waiters.delete(commandId);
  return true;
}

function pendingCount() { return waiters.size; }

module.exports = { waitForCommandResult, resolveCommandResult, cancelWaiter, pendingCount };
