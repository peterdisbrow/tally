/**
 * ai-parser.js
 * Claude-powered natural language command parser for Tally.
 * Used as a fallback when the regex fast-path doesn't match.
 * Returns the same { command, params } shape — or a multi-step array.
 */

const ANTHROPIC_API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL = 'claude-haiku-4-5';

// ─── System prompt ─────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `You are the command parser for Tally, a church AV monitoring and control system.
A church Technical Director has sent a natural language message via Telegram.
Your job: parse it into one or more structured commands.

AVAILABLE COMMANDS (JSON schema):
{"command":"atem.cut","params":{"input":N}}                        — switch program to camera N
{"command":"atem.setPreview","params":{"input":N}}                 — put camera N on preview
{"command":"atem.auto","params":{}}                                — execute auto transition / take
{"command":"atem.fadeToBlack","params":{}}                         — toggle fade to black
{"command":"atem.startRecording","params":{}}
{"command":"atem.stopRecording","params":{}}
{"command":"atem.setInputLabel","params":{"input":N,"longName":"X"}}
{"command":"obs.startStream","params":{}}
{"command":"obs.stopStream","params":{}}
{"command":"obs.setScene","params":{"scene":"X"}}
{"command":"companion.pressNamed","params":{"name":"X"}}           — press a named Companion button
{"command":"videohub.route","params":{"input":N,"output":N}}
{"command":"videohub.getRoutes","params":{}}
{"command":"propresenter.next","params":{}}
{"command":"propresenter.previous","params":{}}
{"command":"propresenter.goToSlide","params":{"index":N}}
{"command":"propresenter.status","params":{}}
{"command":"propresenter.playlist","params":{}}
{"command":"dante.scene","params":{"name":"X"}}
{"command":"preview.snap","params":{}}                             — send live preview photo
{"command":"system.preServiceCheck","params":{}}
{"command":"status","params":{}}                                   — overall system status

RESPONSE FORMAT — always return valid JSON, one of these three shapes:

1. Single command:
{"type":"command","command":"atem.cut","params":{"input":2}}

2. Multiple sequential commands:
{"type":"commands","steps":[
  {"command":"atem.cut","params":{"input":2}},
  {"command":"obs.startStream","params":{}}
]}

3. Conversational reply (questions, unknown intent, out-of-scope):
{"type":"chat","text":"Short helpful reply here."}

RULES:
- Be liberal with inference. "wide angle" likely means camera 1. "pastor" likely means camera 2. "center" or "main" likely means camera 1 or the current program input.
- If the message references lowering/muting audio: map to companion.pressNamed with a descriptive name like "Mute Audience Mics" or "Lower Music".
- If you cannot map to a command with reasonable confidence, return type:chat with a brief helpful message.
- Never return anything outside of the three JSON shapes above.
- No markdown, no explanation, just the JSON.`;

// ─── Main parse function ────────────────────────────────────────────────────

/**
 * @param {string} text — raw message from the TD
 * @param {object} [ctx] — optional church context
 * @param {string} [ctx.churchName]
 * @param {object} [ctx.status] — current device status (atem, obs, companion, etc.)
 * @returns {Promise<ParseResult>}
 *
 * ParseResult shapes:
 *   { type: 'command', command, params }
 *   { type: 'commands', steps: [{ command, params }] }
 *   { type: 'chat', text }
 *   { type: 'error', message }   — if API call fails
 */
async function aiParseCommand(text, ctx = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return { type: 'error', message: 'ANTHROPIC_API_KEY not set — AI parser unavailable.' };
  }

  // Build context hint if we have live status
  let contextHint = '';
  if (ctx.churchName) contextHint += `Church: ${ctx.churchName}. `;
  if (ctx.status?.atem?.connected) {
    const s = ctx.status.atem;
    contextHint += `ATEM: program=cam${s.programInput||'?'}, preview=cam${s.previewInput||'?'}. `;
    if (s.inputLabels && Object.keys(s.inputLabels).length) {
      const labels = Object.entries(s.inputLabels).map(([k, v]) => `cam${k}=${v}`).join(', ');
      contextHint += `Camera labels: ${labels}. `;
    }
  }
  if (ctx.status?.obs?.connected) {
    contextHint += `OBS: ${ctx.status.obs.streaming ? 'streaming' : 'not streaming'}. `;
  }

  const userContent = contextHint
    ? `[Context: ${contextHint.trim()}]\n\n${text}`
    : text;

  try {
    const resp = await fetch(ANTHROPIC_API_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 256,
        system: SYSTEM_PROMPT,
        messages: [{ role: 'user', content: userContent }],
      }),
      signal: AbortSignal.timeout(8000),
    });

    if (!resp.ok) {
      const body = await resp.text();
      console.error('[ai-parser] API error:', resp.status, body);
      return { type: 'error', message: `AI parser API error: ${resp.status}` };
    }

    const data = await resp.json();
    const raw = data?.content?.[0]?.text?.trim();

    if (!raw) {
      return { type: 'error', message: 'AI parser returned empty response.' };
    }

    // Parse JSON
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // Sometimes Claude wraps in ```json ... ``` — strip and retry
      const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
      try {
        parsed = JSON.parse(stripped);
      } catch {
        console.error('[ai-parser] JSON parse failed:', raw);
        return { type: 'error', message: 'AI parser returned invalid JSON.' };
      }
    }

    // Validate shape
    if (!parsed.type || !['command', 'commands', 'chat'].includes(parsed.type)) {
      return { type: 'error', message: 'AI parser returned unexpected shape.' };
    }

    return parsed;

  } catch (e) {
    console.error('[ai-parser] fetch error:', e.message);
    return { type: 'error', message: `AI parser unavailable: ${e.message}` };
  }
}

module.exports = { aiParseCommand };
