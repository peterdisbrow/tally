/**
 * ai-parser.js
 * Anthropic Claude natural language command parser for Tally church AV system.
 * Uses Claude Haiku for fast, cheap parsing.
 * Returns { command, params } shape or multi-step array.
 */

const { isOnTopic, OFF_TOPIC_RESPONSE } = require('./chat-guard');

// ─── System prompt ─────────────────────────────────────────────────────────

const FALLBACK_COMMANDS = [
  'atem.auto',
  'atem.cut',
  'atem.fadeToBlack',
  'atem.runMacro',
  'atem.setAux',
  'atem.setDskOnAir',
  'atem.setDskRate',
  'atem.setDskSource',
  'atem.setDskTie',
  'atem.setInputLabel',
  'atem.setPreview',
  'atem.setProgram',
  'atem.setTransitionRate',
  'atem.setTransitionStyle',
  'atem.startRecording',
  'atem.stopMacro',
  'atem.stopRecording',
  'companion.connections',
  'companion.getGrid',
  'companion.press',
  'companion.pressNamed',
  'dante.scene',
  'encoder.startRecording',
  'encoder.startStream',
  'encoder.status',
  'encoder.stopRecording',
  'encoder.stopStream',
  'hyperdeck.nextClip',
  'hyperdeck.play',
  'hyperdeck.prevClip',
  'hyperdeck.record',
  'hyperdeck.stop',
  'hyperdeck.stopRecord',
  'mixer.mute',
  'mixer.recallScene',
  'mixer.saveScene',
  'mixer.setChannelName',
  'mixer.setCompressor',
  'mixer.setEq',
  'mixer.setFader',
  'mixer.setFullChannelStrip',
  'mixer.setGate',
  'mixer.setHpf',
  'mixer.setupFromPatchList',
  'mixer.status',
  'mixer.unmute',
  'atem.uploadStill',
  'atem.setMediaPlayer',
  'atem.captureStill',
  'atem.clearStill',
  'obs.configureMonitorStream',
  'obs.reduceBitrate',
  'obs.setScene',
  'obs.startRecording',
  'obs.startStream',
  'obs.stopRecording',
  'obs.stopStream',
  'preset.delete',
  'preset.list',
  'preset.recall',
  'preset.save',
  'preview.snap',
  'preview.start',
  'preview.stop',
  'propresenter.clearAll',
  'propresenter.clearMessage',
  'propresenter.clearSlide',
  'propresenter.getLooks',
  'propresenter.getTimers',
  'propresenter.goToSlide',
  'propresenter.isRunning',
  'propresenter.next',
  'propresenter.playlist',
  'propresenter.previous',
  'propresenter.setLook',
  'propresenter.stageMessage',
  'propresenter.startTimer',
  'propresenter.status',
  'propresenter.stopTimer',
  'ptz.home',
  'ptz.pan',
  'ptz.preset',
  'ptz.setPreset',
  'ptz.stop',
  'ptz.tilt',
  'ptz.zoom',
  'resolume.clearAll',
  'resolume.getColumns',
  'resolume.getLayers',
  'resolume.isRunning',
  'resolume.playClip',
  'resolume.setBpm',
  'resolume.setLayerOpacity',
  'resolume.setMasterOpacity',
  'resolume.status',
  'resolume.stopClip',
  'resolume.triggerColumn',
  'status',
  'system.getServiceWindow',
  'system.preServiceCheck',
  'system.setWatchdogMode',
  'videohub.getRoutes',
  'videohub.route',
  'videohub.setInputLabel',
  'videohub.setOutputLabel',
  'vmix.cut',
  'vmix.fade',
  'vmix.function',
  'vmix.isRunning',
  'vmix.listInputs',
  'vmix.mute',
  'vmix.preview',
  'vmix.setPreview',
  'vmix.setProgram',
  'vmix.setVolume',
  'vmix.startRecording',
  'vmix.startStream',
  'vmix.status',
  'vmix.stopRecording',
  'vmix.stopStream',
  'vmix.unmute',
];

function getAvailableCommandNames() {
  try {
    // Keep parser command surface aligned with the church client runtime.
    // This path exists in monorepo and local/dev contexts.
    // In partial deployments, we fall back to a static snapshot.
    // eslint-disable-next-line global-require, import/no-dynamic-require
    const { commandHandlers } = require('../../church-client/src/commands');
    const runtimeCommands = Object.keys(commandHandlers || {}).sort();
    if (runtimeCommands.length > 0) return runtimeCommands;
  } catch {
    // Fall back to static command list.
  }
  return FALLBACK_COMMANDS;
}

const AVAILABLE_COMMANDS = getAvailableCommandNames();
const AVAILABLE_COMMANDS_TEXT = AVAILABLE_COMMANDS.map((cmd) => `- ${cmd}`).join('\n');

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
{"command":"atem.runMacro","params":{"macroIndex":N}}
{"command":"atem.stopMacro","params":{}}
{"command":"atem.setAux","params":{"aux":N,"input":N}}
{"command":"atem.setTransitionStyle","params":{"style":"mix|dip|wipe|dve|stinger"}}
{"command":"atem.setTransitionRate","params":{"rate":N}}
{"command":"atem.setDskOnAir","params":{"keyer":N,"onAir":true}}
{"command":"atem.setDskTie","params":{"keyer":N,"tie":true}}
{"command":"atem.setDskRate","params":{"keyer":N,"rate":N}}
{"command":"atem.setDskSource","params":{"keyer":N,"fillSource":N,"keySource":N}}
{"command":"hyperdeck.play","params":{"hyperdeck":N}}
{"command":"hyperdeck.stop","params":{"hyperdeck":N}}
{"command":"hyperdeck.record","params":{"hyperdeck":N}}
{"command":"hyperdeck.nextClip","params":{"hyperdeck":N}}
{"command":"hyperdeck.prevClip","params":{"hyperdeck":N}}
{"command":"ptz.pan","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.tilt","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.zoom","params":{"camera":N,"speed":-1.0-1.0}}
{"command":"ptz.preset","params":{"camera":N,"preset":N}}
{"command":"ptz.setPreset","params":{"camera":N,"preset":N}}
{"command":"ptz.stop","params":{"camera":N}}
{"command":"ptz.home","params":{"camera":N}}
{"command":"obs.startStream","params":{}}
{"command":"obs.stopStream","params":{}}
{"command":"obs.startRecording","params":{}}
{"command":"obs.stopRecording","params":{}}
{"command":"obs.setScene","params":{"scene":"X"}}                           — switch to scene "X"
{"command":"encoder.startStream","params":{}}
{"command":"encoder.stopStream","params":{}}
{"command":"encoder.startRecording","params":{}}
{"command":"encoder.stopRecording","params":{}}
{"command":"encoder.status","params":{}}
{"command":"companion.pressNamed","params":{"name":"X"}}           — press a named Companion button
{"command":"vmix.startStream","params":{}}
{"command":"vmix.stopStream","params":{}}
{"command":"vmix.startRecording","params":{}}
{"command":"vmix.stopRecording","params":{}}
{"command":"vmix.cut","params":{}}
{"command":"vmix.fade","params":{"ms":300}}
{"command":"vmix.setPreview","params":{"input":1}}
{"command":"vmix.setProgram","params":{"input":1}}
{"command":"vmix.setVolume","params":{"value":80}}
{"command":"vmix.mute","params":{}}
{"command":"vmix.unmute","params":{}}
{"command":"vmix.preview","params":{}}
{"command":"vmix.isRunning","params":{}}
{"command":"vmix.function","params":{"function":"X","input":"Y"}}
{"command":"videohub.route","params":{"input":N,"output":N}}
{"command":"videohub.getRoutes","params":{}}
{"command":"propresenter.next","params":{}}
{"command":"propresenter.previous","params":{}}
{"command":"propresenter.goToSlide","params":{"index":N}}
{"command":"propresenter.status","params":{}}
{"command":"propresenter.playlist","params":{}}
{"command":"resolume.playClip","params":{"name":"X"}}
{"command":"resolume.triggerColumn","params":{"column":N}}
{"command":"resolume.clearAll","params":{}}
{"command":"resolume.setBpm","params":{"bpm":N}}
{"command":"mixer.status","params":{}}
{"command":"mixer.mute","params":{"channel":"master|N"}}
{"command":"mixer.unmute","params":{"channel":"master|N"}}
{"command":"mixer.recallScene","params":{"scene":N}}
{"command":"mixer.saveScene","params":{"scene":N,"name":"X"}}
{"command":"mixer.setFader","params":{"channel":N,"level":0.0-1.0}}
{"command":"mixer.setChannelName","params":{"channel":N,"name":"X"}}
{"command":"mixer.setHpf","params":{"channel":N,"enabled":true,"frequency":80}}
{"command":"mixer.setEq","params":{"channel":N,"enabled":true,"bands":[{"band":1,"type":2,"frequency":1000,"gain":0,"q":2}]}}
{"command":"mixer.setCompressor","params":{"channel":N,"enabled":true,"threshold":-20,"ratio":4,"attack":10,"release":100,"knee":2}}
{"command":"mixer.setGate","params":{"channel":N,"enabled":true,"threshold":-40,"range":40,"attack":1,"hold":5,"release":150}}
{"command":"atem.uploadStill","params":{"index":0,"data":"base64...","name":"X"}} — upload image to ATEM media pool
{"command":"atem.setMediaPlayer","params":{"player":0,"sourceType":"still","stillIndex":0}}
{"command":"atem.captureStill","params":{}} — capture program output to media pool
{"command":"atem.clearStill","params":{"index":0}}
{"command":"dante.scene","params":{"name":"X"}}
{"command":"preview.snap","params":{}}                             — send live preview photo
{"command":"system.preServiceCheck","params":{}}
{"command":"status","params":{}}                                   — overall system status

ADDITIONAL VALID COMMAND IDS (same params as church runtime):
${AVAILABLE_COMMANDS_TEXT}

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

MULTI-COMMAND EXAMPLES (use type:commands with steps[] for ALL of these):
- "Go live and record" → obs.startStream + atem.startRecording
- "Cut to cam 2 and start streaming" → atem.cut(input:2) + obs.startStream
- "Mute the band and fade to black" → companion.pressNamed("Mute Band") + atem.fadeToBlack
- "Preview cam 3 then take it" → atem.setPreview(input:3) + atem.auto
- "Stop everything" → obs.stopStream + obs.stopRecording (+ encoder.stopStream + encoder.stopRecording if both configured)
- "Get ready for service: cut to cam 1, start recording, go live, and put cam 2 on preview" → atem.cut(input:1) + atem.startRecording + obs.startStream + atem.setPreview(input:2) — 4 steps
- "We're done — stop the stream, stop recording, and fade to black" → obs.stopStream + obs.stopRecording + atem.fadeToBlack — 3 steps
- "Set transition to dissolve at 30 frames, preview cam 4, then take it" → atem.setTransitionStyle(style:"mix") + atem.setTransitionRate(rate:30) + atem.setPreview(input:4) + atem.auto — 4 steps
- "Label cam 1 as Wide, cam 2 as Pastor, cam 3 as Band" → 3x atem.setInputLabel
- "Start the service: recall mixer scene 1, cut to the wide shot, start streaming, and start recording" → mixer.recallScene(scene:1) + atem.cut(input:1) + obs.startStream + atem.startRecording — 4 steps
- "Pan camera 2 left and zoom in" → ptz.pan(camera:2, speed:-0.5) + ptz.zoom(camera:2, speed:0.5) — 2 steps
- "End service: fade to black, stop recording, stop streaming, mute all" → atem.fadeToBlack + atem.stopRecording + obs.stopStream + mixer.mute(channel:"master") — 4 steps
You can return up to 6 steps in a single response. Any time the user asks for two or more actions, use type:commands with steps[].

RULES:
- Be liberal with inference. "wide angle" likely means camera 1. "pastor" likely means camera 2. "center" or "main" likely means camera 1 or the current program input.
- If the message contains multiple actions (connected by "and", "then", commas, or semicolons), ALWAYS return type:commands with a steps[] array — never collapse to a single command.
- If the message references lowering/muting audio: map to companion.pressNamed with a descriptive name like "Mute Audience Mics" or "Lower Music".
- If the message is production-related but you cannot map it to a command with confidence, return type:chat with a brief clarifying question.
- If the message is NOT related to church AV production (weather, sports, general chat, jokes, etc.), return type:chat with exactly: "I'm only here for production. Try 'help' for what I can do."
- Never return anything outside of the three JSON shapes above.
- No markdown, no explanation, just the JSON.
- You have conversation history. Use it to resolve references like "do that again", "same for cam 3", "now mute it", "the other one", "undo that", etc.
- If someone says "again" or "repeat", look at the previous command you returned and repeat it.`;

// ─── Anthropic API call ───────────────────────────────────────────────────

async function callAnthropic(messages, timeout = 8000) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not set');

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeout);

  try {
    const resp = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        system: SYSTEM_PROMPT,
        messages,
        temperature: 0.2,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 100)}`);
    }

    const data = await resp.json();
    const raw = data?.content?.[0]?.text?.trim();

    if (!raw) throw new Error('Anthropic returned empty response');
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
 * @param {Array<{role: string, content: string}>} [conversationHistory=[]] — recent chat history
 * @returns {Promise<ParseResult>}
 *
 * ParseResult shapes:
 *   { type: 'command', command, params }
 *   { type: 'commands', steps: [{ command, params }] }
 *   { type: 'chat', text }
 *   { type: 'error', message }   — if API call fails
 */
async function aiParseCommand(text, ctx = {}, conversationHistory = []) {
  // ── Pre-filter: reject obviously off-topic messages before calling AI ──
  if (!isOnTopic(text)) {
    console.log('[ai-parser] Blocked off-topic message (pre-filter)');
    return { type: 'chat', text: OFF_TOPIC_RESPONSE };
  }

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

  // Build messages array: conversation history + current message
  const messages = [...conversationHistory, { role: 'user', content: userContent }];

  try {
    console.log(`[ai-parser] Parsing with Claude Haiku (${messages.length} messages)...`);
    const raw = await callAnthropic(messages);
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

module.exports = { aiParseCommand, getAvailableCommandNames };
