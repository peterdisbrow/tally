/**
 * ai-parser.js
 * OpenAI-only natural language command parser for Tally church AV system.
 * Uses gpt-4o-mini for fast, cheap parsing.
 * Returns { command, params } shape or multi-step array.
 */

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
- If the message is production-related but you cannot map it to a command with confidence, return type:chat with a brief clarifying question.
- If the message is NOT related to church AV production (weather, sports, general chat, jokes, etc.), return type:chat with exactly: "I'm only here for production. Try 'help' for what I can do."
- Never return anything outside of the three JSON shapes above.
- No markdown, no explanation, just the JSON.`;

// ─── OpenAI API call ───────────────────────────────────────────────────────

async function callOpenAI(userContent, timeout = 8000) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY not set');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: userContent },
        ],
        temperature: 0.2,  // Deterministic
        max_tokens: 256,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`OpenAI API ${resp.status}: ${body.slice(0, 100)}`);
    }

    const data = await resp.json();
    const raw = data?.choices?.[0]?.message?.content?.trim();

    if (!raw) throw new Error('OpenAI returned empty response');
    return raw;

  } finally {
    clearTimeout(timeoutId);
  }
}

// ─── JSON parser (handles markdown wrapping) ────────────────────────────────

function parseJSON(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Strip markdown code block if present
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(stripped);
  }
}

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
  // Build context hint if we have live status
  let contextHint = '';
  if (ctx.churchName) contextHint += `Church: ${ctx.churchName}. `;
  if (ctx.status?.atem?.connected) {
    const s = ctx.status.atem;
    contextHint += `ATEM: program=cam${s.programInput || '?'}, preview=cam${s.previewInput || '?'}. `;
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
    console.log('[ai-parser] Parsing with gpt-4o-mini...');
    const raw = await callOpenAI(userContent);
    const parsed = parseJSON(raw);

    if (!parsed.type || !['command', 'commands', 'chat'].includes(parsed.type)) {
      throw new Error(`Invalid response type: ${parsed.type}`);
    }

    console.log(`[ai-parser] ✓ Success — type: ${parsed.type}`);
    return parsed;

  } catch (err) {
    console.error(`[ai-parser] Error: ${err.message}`);
    return {
      type: 'error',
      message: `AI parser failed: ${err.message}`,
    };
  }
}

module.exports = { aiParseCommand };
