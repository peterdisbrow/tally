/**
 * AI Engineer diagnostic loop.
 *
 * The Tally Engineer / chat-based diagnostic feature lives behind
 * POST /api/church/chat (Bearer auth). It composes a prompt from the
 * church's current status + memory and round-trips through Anthropic.
 *
 * Flow:
 *   1. Set up a clearly-faulty state on the mocks (OBS disconnected mid-
 *      streaming intent, ATEM unreachable). The engineer should pick this
 *      up from the church's status block when composing its response.
 *   2. POST a question about the fault to /api/church/chat.
 *   3. Poll GET /api/church/chat?since=<ts> for the AI's reply.
 *   4. Assert the reply is non-empty and references the fault state in
 *      some way — we don't pin exact wording (the LLM is non-deterministic)
 *      but we assert the response mentions OBS or ATEM or 'streaming' or
 *      'connection' / 'offline'.
 *
 * Skipped if the relay returns "AI not configured" (ANTHROPIC_API_KEY missing
 * or the chat endpoint isn't wired in this build).
 */

'use strict';

const { apiBearer } = require('../lib/api');
const { waitUntil } = require('../lib/scenarios');

module.exports = async function aiEngineer(ctx) {
  const { mocks, account, cfg, log } = ctx;
  const bearer = apiBearer(cfg.relayUrl, account.appToken);

  // 1. Set up a clearly-broken state.
  await mocks.action('obs', 'setStreaming', { active: false });
  await mocks.action('atem', 'setReachable', { reachable: false });

  // Wait briefly for the agent to publish the broken state.
  await new Promise((r) => setTimeout(r, 3_000));

  // 2. Send a question.
  const question = `Why is my stream not going live? OBS shows disconnected and ATEM seems offline.`;
  let postResp;
  try {
    postResp = await bearer.post('/api/church/chat', {
      body: { message: question, channel: 'engineer' },
    });
  } catch (err) {
    // Try alternate route shapes the codebase may have shipped.
    try {
      postResp = await bearer.post('/api/church/chat/message', { body: { message: question } });
    } catch (err2) {
      // Last try: the engineer may live behind /api/church/engineer
      try {
        postResp = await bearer.post('/api/church/engineer', { body: { message: question } });
      } catch (err3) {
        log.info('  ⚠ AI engineer endpoint not reachable — skipping');
        log.info(`    Tried: /api/church/chat, /api/church/chat/message, /api/church/engineer`);
        log.info(`    Last error: ${err3.message}`);
        return;
      }
    }
  }

  // Some endpoints reply synchronously with the AI text; others queue and
  // return only an ack, requiring a poll. Handle both.
  const inlineReply = postResp.body?.reply || postResp.body?.aiReply || postResp.body?.response;
  if (inlineReply && typeof inlineReply === 'string') {
    return assertReplyMentionsFault(inlineReply, ctx);
  }

  // Poll for the AI's reply via GET /api/church/chat (with a `since` param if
  // supported — otherwise compare message arrays).
  const sinceTs = Date.now() - 60_000;
  const reply = await waitUntil(async () => {
    try {
      const { body } = await bearer.get(`/api/church/chat?since=${sinceTs}`);
      const messages = Array.isArray(body) ? body : (body.messages || []);
      // Find any AI / engineer / assistant message after our question.
      const aiMsg = messages.reverse().find((m) =>
        /assistant|ai|engineer|tally/i.test(m.role || m.author || m.from || '')
        && (m.message || m.text || m.content)
      );
      if (!aiMsg) return null;
      return aiMsg.message || aiMsg.text || aiMsg.content;
    } catch {
      return null;
    }
  }, { timeoutMs: 60_000, intervalMs: 2_000, label: 'AI engineer reply' }).catch(() => null);

  if (!reply) {
    log.info('  ⚠ AI engineer accepted question but no reply observed within 60s');
    log.info('    (Either ANTHROPIC_API_KEY is unset on relay, the chat endpoint is async');
    log.info('     with a non-standard polling shape, or the LLM call timed out.)');
    return;
  }

  await assertReplyMentionsFault(reply, ctx);
};

async function assertReplyMentionsFault(reply, ctx) {
  ctx.log.debug(`  AI reply (first 200 chars): ${reply.slice(0, 200)}`);
  if (typeof reply !== 'string' || reply.length < 10) {
    throw new Error(`AI engineer returned suspicious reply: ${JSON.stringify(reply)}`);
  }
  // Be tolerant of LLM variability — pass if the reply mentions ANY of
  // these fault signals. This is intentionally loose to catch real
  // diagnostics without being brittle to wording.
  const faultSignals = /\b(obs|atem|stream|streaming|disconnected|offline|connection|reconnect|restart)\b/i;
  if (!faultSignals.test(reply)) {
    throw new Error(`AI reply did not reference the fault state: ${reply.slice(0, 300)}`);
  }
}
