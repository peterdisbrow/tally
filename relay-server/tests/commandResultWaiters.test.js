import { describe, it, expect } from 'vitest';
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const { waitForCommandResult, resolveCommandResult, pendingCount } = require('../src/commandResultWaiters');

describe('commandResultWaiters (app send-command wait:true)', () => {
  it('resolves with the client error (e.g. unknown OBS scene) instead of a blind "sent"', async () => {
    const p = waitForCommandResult('cmd-1', 2000);
    expect(resolveCommandResult({ type: 'command_result', messageId: 'cmd-1', error: 'OBS: No source was found by the name of `No Such Scene`.' })).toBe(true);
    await expect(p).resolves.toEqual({ result: undefined, error: 'OBS: No source was found by the name of `No Such Scene`.' });
    expect(pendingCount()).toBe(0);
  });
  it('resolves with the result on success', async () => {
    const p = waitForCommandResult('cmd-2', 2000);
    resolveCommandResult({ messageId: 'cmd-2', result: 'Scene switched to Scene 3' });
    await expect(p).resolves.toEqual({ result: 'Scene switched to Scene 3', error: undefined });
  });
  it('times out honestly when the booth never answers', async () => {
    const r = await waitForCommandResult('cmd-3', 50);
    expect(r).toEqual({ timedOut: true });
    expect(pendingCount()).toBe(0);
  });
  it('ignores results nobody is waiting for', () => {
    expect(resolveCommandResult({ messageId: 'nobody' })).toBe(false);
    expect(resolveCommandResult({})).toBe(false);
  });
});
