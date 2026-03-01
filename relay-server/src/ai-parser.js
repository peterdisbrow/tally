/**
 * ai-parser.js
 * Anthropic Claude natural language command parser for Tally church AV system.
 * Uses Claude Haiku for fast, cheap parsing.
 * Returns { command, params } shape or multi-step array.
 */

const { isOnTopic, OFF_TOPIC_RESPONSE } = require('./chat-guard');

// ─── AI USAGE LOGGING ────────────────────────────────────────────────────────

let _logAiUsage = null;
function setAiUsageLogger(fn) { _logAiUsage = fn; }

// ─── COST CONTROLS ──────────────────────────────────────────────────────────

// Simple LRU cache for AI responses (keyed on normalized message text)
const CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CACHE_MAX = 200;
const responseCache = new Map();

function getCachedResponse(key) {
  const entry = responseCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL) {
    responseCache.delete(key);
    return null;
  }
  return entry.value;
}

function setCachedResponse(key, value) {
  // Evict oldest if at capacity
  if (responseCache.size >= CACHE_MAX) {
    const oldest = responseCache.keys().next().value;
    responseCache.delete(oldest);
  }
  responseCache.set(key, { value, ts: Date.now() });
}

// Per-church AI call rate limit (tier-based)
const AI_RATE_LIMITS = {
  connect: 5,     // basic taste — upgrade to Plus for more
  plus: 30,
  pro: 60,
  managed: 120,   // Enterprise gets highest throughput
  event: 15,
  default: 15,
};
const AI_RATE_WINDOW = 60 * 60 * 1000; // 1 hour
const aiCallCounts = new Map(); // churchId → { count, windowStart }

function checkAiRateLimit(churchId, tier) {
  if (!churchId) return true;
  const limit = AI_RATE_LIMITS[tier] || AI_RATE_LIMITS.default;
  const now = Date.now();
  let bucket = aiCallCounts.get(churchId);
  if (!bucket || now - bucket.windowStart > AI_RATE_WINDOW) {
    bucket = { count: 0, windowStart: now };
    aiCallCounts.set(churchId, bucket);
  }
  if (bucket.count >= limit) return false;
  bucket.count++;
  return true;
}

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
// Note: AVAILABLE_COMMANDS is exported via getAvailableCommandNames() for use elsewhere

const SYSTEM_PROMPT = `You parse natural language into JSON commands for Tally, a church AV control system.
Return ONLY valid JSON. No markdown, no explanation.

AVAILABLE COMMANDS (N=number, X=string):
atem: cut(input:N), setPreview(input:N), auto(), fadeToBlack(), startRecording(), stopRecording(), setInputLabel(input:N,longName:X), runMacro(macroIndex:N), stopMacro(), setAux(aux:N,input:N), setTransitionStyle(style:mix|dip|wipe|dve|stinger), setTransitionRate(rate:N), setDskOnAir(keyer:N,onAir:bool), setDskTie(keyer:N,tie:bool), setDskRate(keyer:N,rate:N), setDskSource(keyer:N,fillSource:N,keySource:N), setProgram(input:N), uploadStill(index:N,data:X,name:X), setMediaPlayer(player:N,sourceType:X,stillIndex:N), captureStill(), clearStill(index:N)
hyperdeck: play(hyperdeck:N), stop(hyperdeck:N), record(hyperdeck:N), nextClip(hyperdeck:N), prevClip(hyperdeck:N)
ptz: pan(camera:N,speed:-1to1), tilt(camera:N,speed:-1to1), zoom(camera:N,speed:-1to1), preset(camera:N,preset:N), setPreset(camera:N,preset:N), stop(camera:N), home(camera:N)
camera: setIris(camera:N,value:0-1), autoIris(camera:N), setGain(camera:N,gain:N), setISO(camera:N,iso:N), setWhiteBalance(camera:N,kelvin:N,tint:N), autoWhiteBalance(camera:N), setShutter(camera:N,speed:N), setFocus(camera:N,value:0-1), autoFocus(camera:N), setLift(camera:N,r:N,g:N,b:N,y:N), setGamma(camera:N,r:N,g:N,b:N,y:N), setColorGain(camera:N,r:N,g:N,b:N,y:N), setContrast(camera:N,pivot:N,adjust:N), setSaturation(camera:N,saturation:N), resetColorCorrection(camera:N)
obs: startStream(), stopStream(), startRecording(), stopRecording(), setScene(scene:X)
encoder: startStream(), stopStream(), startRecording(), stopRecording(), status()
companion: pressNamed(name:X)
vmix: startStream(), stopStream(), startRecording(), stopRecording(), cut(), fade(ms:N), setPreview(input:N), setProgram(input:N), setVolume(value:N), mute(), unmute(), function(function:X,input:X)
videohub: route(input:N,output:N), getRoutes()
propresenter: next(), previous(), goToSlide(index:N), status(), playlist()
resolume: playClip(name:X), triggerColumn(column:N), clearAll(), setBpm(bpm:N)
mixer: status(), mute(channel:master|N), unmute(channel:master|N), recallScene(scene:N), saveScene(scene:N,name:X), setFader(channel:N,level:0-1), setChannelName(channel:N,name:X), setHpf(channel:N,enabled:bool,frequency:N), setEq(channel:N,enabled:bool,bands:[...]), setCompressor(channel:N,enabled:bool,threshold:N,ratio:N,attack:N,release:N,knee:N), setGate(channel:N,enabled:bool,threshold:N,range:N,attack:N,hold:N,release:N)
dante: scene(name:X)
other: preview.snap(), system.preServiceCheck(), status()
system: wait(seconds:N) — pause between steps (max 30s)

OUTPUT FORMAT — return exactly one of these JSON shapes:

Single action:
{"type":"command","command":"atem.cut","params":{"input":2}}

Multiple actions (MUST use when message contains "then", "and", commas, or lists):
{"type":"commands","steps":[{"command":"...","params":{...}},{"command":"...","params":{...}}]}

Conversation reply:
{"type":"chat","text":"..."}

CRITICAL MULTI-STEP RULES:
If the user asks for MORE THAN ONE action, you MUST return type "commands" with a "steps" array.
Words like "then", "and", "after that", commas, or numbered lists ALWAYS mean multiple steps.

MULTI-STEP EXAMPLES WITH FULL JSON OUTPUT:

User: "cut to cam 1 then cut to cam 2"
{"type":"commands","steps":[{"command":"atem.cut","params":{"input":1}},{"command":"atem.cut","params":{"input":2}}]}

User: "cut to 1 then wait 5 seconds then cut to 2"
{"type":"commands","steps":[{"command":"atem.cut","params":{"input":1}},{"command":"system.wait","params":{"seconds":5}},{"command":"atem.cut","params":{"input":2}}]}

User: "cut to 1 then 2 then 3 then 4"
{"type":"commands","steps":[{"command":"atem.cut","params":{"input":1}},{"command":"atem.cut","params":{"input":2}},{"command":"atem.cut","params":{"input":3}},{"command":"atem.cut","params":{"input":4}}]}

User: "preview cam 3 then take it"
{"type":"commands","steps":[{"command":"atem.setPreview","params":{"input":3}},{"command":"atem.auto","params":{}}]}

User: "fade to black, stop recording, and stop streaming"
{"type":"commands","steps":[{"command":"atem.fadeToBlack","params":{}},{"command":"atem.stopRecording","params":{}},{"command":"obs.stopStream","params":{}}]}

RULES:
- "wide"→cam1, "pastor"→cam2, "take it"→atem.auto
- Muting audio → companion.pressNamed with descriptive name
- Off-topic → {"type":"chat","text":"I'm only here for production. Try 'help' for what I can do."}
- Use conversation history to resolve "again", "same for cam 3", "undo that", etc.
- Up to 50 steps allowed (audio consoles may need 32+ channel operations).`;

// ─── Anthropic API call ───────────────────────────────────────────────────

async function callAnthropic(messages, timeout = 15000) {
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
        max_tokens: 2048,
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
    return { text: raw, usage: data.usage || null };

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

  // ── Rate limit: tier-based AI calls per church per hour ──
  const churchId = ctx.churchId || ctx.churchName || '_default';
  const tier = ctx.tier || 'default';
  if (!checkAiRateLimit(churchId, tier)) {
    const limit = AI_RATE_LIMITS[tier] || AI_RATE_LIMITS.default;
    console.warn(`[ai-parser] Rate limit hit for ${churchId} (${limit}/hr, tier: ${tier})`);
    return { type: 'chat', text: `AI rate limit reached (${limit}/hr). Try direct commands like "cam 2" or "status".` };
  }

  // ── Cache check: skip API call for repeated single messages (no history context) ──
  const cacheKey = text.trim().toLowerCase();
  if (conversationHistory.length === 0) {
    const cached = getCachedResponse(cacheKey);
    if (cached) {
      console.log(`[ai-parser] Cache hit: "${cacheKey.slice(0, 40)}"`);
      if (_logAiUsage) {
        _logAiUsage({
          churchId: ctx.churchId || null,
          feature: 'command_parser',
          model: 'claude-haiku-4-5-20251001',
          inputTokens: 0, outputTokens: 0, cached: true,
        });
      }
      return cached;
    }
  }

  // Build context hint from live status + engineer profile
  let contextHint = '';
  if (ctx.churchName) contextHint += `Church: ${ctx.churchName}. `;

  // ATEM switcher
  if (ctx.status?.atem?.connected) {
    const s = ctx.status.atem;
    contextHint += `ATEM: pgm=cam${s.programInput || '?'}, pvw=cam${s.previewInput || '?'}. `;
    if (s.inputLabels && Object.keys(s.inputLabels).length) {
      const labels = Object.entries(s.inputLabels).map(([k, v]) => `${k}=${v}`).join(', ');
      contextHint += `Labels: ${labels}. `;
    }
    if (s.streaming) contextHint += `ATEM streaming${s.streamingBitrate ? ` ${s.streamingBitrate}kbps` : ''}${s.streamingService ? ` (${s.streamingService})` : ''}. `;
    if (s.recording) contextHint += 'ATEM recording. ';
  }

  // OBS
  if (ctx.status?.obs?.connected) {
    const o = ctx.status.obs;
    let obsInfo = `OBS: ${o.streaming ? 'live' : 'idle'}`;
    if (o.streaming && o.bitrate) obsInfo += `, ${o.bitrate}kbps`;
    if (o.fps) obsInfo += `, ${o.fps}fps`;
    contextHint += obsInfo + '. ';
  }

  // vMix
  if (ctx.status?.vmix?.connected) {
    contextHint += `vMix: ${ctx.status.vmix.streaming ? 'live' : 'idle'}. `;
  }

  // Encoder bridge
  if (ctx.status?.encoder?.connected) {
    const e = ctx.status.encoder;
    let encInfo = `Encoder: ${e.live ? 'live' : 'idle'}`;
    if (e.bitrateKbps) encInfo += `, ${e.bitrateKbps}kbps`;
    contextHint += encInfo + '. ';
  }

  // ProPresenter
  if (ctx.status?.proPresenter?.connected) {
    const pp = ctx.status.proPresenter;
    contextHint += `ProPresenter: slide ${pp.slideIndex || '?'}/${pp.slideTotal || '?'}. `;
  }

  // Audio mixer
  if (ctx.status?.mixer?.connected) {
    const m = ctx.status.mixer;
    contextHint += `Audio: ${m.type || ''} ${m.model || ''}${m.mainMuted ? ', MUTED' : ''}. `;
  }

  // PTZ cameras
  const ptzConnected = (ctx.status?.ptz || []).filter(c => c.connected);
  if (ptzConnected.length) contextHint += `PTZ: ${ptzConnected.length} camera${ptzConnected.length > 1 ? 's' : ''} connected. `;

  // HyperDecks
  if (ctx.status?.hyperdeck?.connected) {
    contextHint += `HyperDeck: ${ctx.status.hyperdeck.recording ? 'recording' : 'idle'}. `;
  }

  // Companion
  if (ctx.status?.companion?.connected) {
    const cc = ctx.status.companion.connectionCount || 0;
    if (cc > 0) contextHint += `Companion: ${cc} module${cc > 1 ? 's' : ''}. `;
  }

  // Engineer profile (user-provided setup context)
  const ep = ctx.engineerProfile;
  if (ep && Object.keys(ep).length) {
    if (ep.streamPlatform && ep.streamPlatform !== 'None') contextHint += `Streams to: ${ep.streamPlatform}. `;
    if (ep.expectedViewers) contextHint += `Expected viewers: ${ep.expectedViewers}. `;
    if (ep.operatorLevel) contextHint += `Operator: ${ep.operatorLevel}. `;
    if (ep.backupEncoder) contextHint += `Backup encoder: ${ep.backupEncoder}. `;
    if (ep.backupSwitcher) contextHint += `Backup switcher: ${ep.backupSwitcher}. `;
    if (ep.specialNotes) contextHint += `Notes: ${ep.specialNotes}. `;
  }

  // Church memory (pre-compiled summary from past observations)
  if (ctx.memorySummary) contextHint += ctx.memorySummary + ' ';

  const userContent = contextHint
    ? `[${contextHint.trim()}]\n${text}`
    : text;

  // Build messages array: conversation history + current message
  const messages = [...conversationHistory, { role: 'user', content: userContent }];

  try {
    console.log(`[ai-parser] Calling Haiku (${messages.length} msg) for: "${text.slice(0, 60)}"`);
    const { text: raw, usage } = await callAnthropic(messages);
    console.log(`[ai-parser] Raw response: ${raw.slice(0, 300)}`);

    // Log AI usage
    if (_logAiUsage && usage) {
      _logAiUsage({
        churchId: ctx.churchId || null,
        feature: 'command_parser',
        model: 'claude-haiku-4-5-20251001',
        inputTokens: usage.input_tokens || 0,
        outputTokens: usage.output_tokens || 0,
      });
    }

    const parsed = parseJSON(raw);

    if (!parsed.type || !['command', 'commands', 'chat'].includes(parsed.type)) {
      throw new Error(`Invalid response type: ${parsed.type}`);
    }

    // Cache the result (only for single-turn requests without history)
    if (conversationHistory.length === 0) {
      setCachedResponse(cacheKey, parsed);
    }

    const stepCount = parsed.type === 'commands' ? (parsed.steps?.length || 0) : (parsed.type === 'command' ? 1 : 0);
    console.log(`[ai-parser] ✓ type: ${parsed.type}, steps: ${stepCount}`);
    return parsed;

  } catch (err) {
    console.error(`[ai-parser] Error: ${err.message}`);
    // Return a volunteer-friendly message instead of raw API jargon
    let friendly = 'Tally couldn\'t understand that — try a simpler command like "cam 2" or "go live".';
    if (err.message?.includes('API') && err.message?.includes('529')) {
      friendly = 'AI is temporarily busy — try again in a moment, or use a direct command like "cam 2".';
    } else if (err.message?.includes('API') && err.message?.includes('rate')) {
      friendly = 'Too many requests — wait a moment and try again.';
    } else if (err.message?.includes('timeout') || err.name === 'AbortError' || err.message?.includes('abort')) {
      friendly = 'Request timed out — try again or use a direct command like "status".';
    } else if (err.message?.includes('API_KEY')) {
      friendly = 'AI features are not configured — contact your admin.';
    }
    return {
      type: 'error',
      message: friendly,
      _debug: err.message, // preserve raw error for server logs only
    };
  }
}

module.exports = { aiParseCommand, getAvailableCommandNames, setAiUsageLogger };
