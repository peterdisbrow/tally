/**
 * AI Setup Assistant
 *
 * Orchestrates AI-powered equipment setup from patch lists, camera plots,
 * and image uploads.  Uses Claude Haiku (vision) for parsing documents/photos
 * and generating broadcast-standard settings.
 *
 * Three modes:
 *   1. Mixer setup   — patch list → full channel strip settings → OSC batch
 *   2. Camera setup  — camera plot → ATEM input labels + config
 *   3. Media upload  — image → ATEM media pool still
 */

'use strict';

const ANTHROPIC_MODEL = 'claude-3-5-haiku-20241022';

// ─── INTENT DETECTION ─────────────────────────────────────────────────────────

const MIXER_KEYWORDS = [
  'patch list', 'patch sheet', 'channel list', 'input list',
  'setup mixer', 'setup audio', 'setup console', 'setup channels',
  'configure mixer', 'configure audio', 'configure channels',
  'eq setup', 'eq the mixer', 'set up the mixer', 'set up audio',
  'channel strip', 'sound check', 'soundcheck',
];

const CAMERA_KEYWORDS = [
  'camera plot', 'camera plan', 'camera layout', 'camera setup',
  'stage plan', 'setup cameras', 'configure cameras', 'name cameras',
  'name inputs', 'label inputs', 'label cameras', 'input labels',
  'rename all inputs', 'rename all cameras',
];

const MEDIA_KEYWORDS = [
  'upload to media', 'upload still', 'upload image to atem',
  'media player', 'media pool', 'load image', 'send image to atem',
  'put image on atem', 'add still', 'add image',
];

/**
 * Detect whether a chat message is a setup request.
 * @param {string} message
 * @returns {'mixer'|'camera'|'media'|null}
 */
function detectSetupIntent(message) {
  if (!message) return null;
  const lower = message.toLowerCase();

  for (const kw of MIXER_KEYWORDS) {
    if (lower.includes(kw)) return 'mixer';
  }
  for (const kw of CAMERA_KEYWORDS) {
    if (lower.includes(kw)) return 'camera';
  }
  for (const kw of MEDIA_KEYWORDS) {
    if (lower.includes(kw)) return 'media';
  }

  return null;
}

/**
 * If there's a file attachment, infer intent from MIME type + message.
 */
function detectIntentWithAttachment(message, mimeType) {
  // If message explicitly mentions a setup type, use that
  const explicit = detectSetupIntent(message);
  if (explicit) return explicit;

  // For images without explicit intent, check if it's likely a media upload
  // vs a patch sheet photo
  if (mimeType && mimeType.startsWith('image/')) {
    const lower = (message || '').toLowerCase();
    if (lower.includes('media') || lower.includes('still') || lower.includes('atem'))
      return 'media';
    // Default: treat photo upload as a patch list (most common use case)
    return 'mixer';
  }

  // CSV/text files are likely patch lists
  if (mimeType === 'text/csv' || mimeType === 'text/plain') return 'mixer';
  // PDFs could be either — default to mixer
  if (mimeType === 'application/pdf') return 'mixer';

  return null;
}

// ─── AI PROMPTS ───────────────────────────────────────────────────────────────

const PATCH_LIST_PARSER_PROMPT = `You are an expert audio engineer parsing a patch list for a live sound mixing console.

You will receive either:
1. A text description of a patch list
2. A CSV/table of channel assignments
3. A photo of a handwritten or printed patch sheet
4. A PDF document containing a patch list

Extract a structured JSON array of channel assignments.

OUTPUT FORMAT (strict JSON, no markdown wrapping, no explanation):
{
  "channels": [
    {
      "channel": 1,
      "source": "Kick Drum",
      "sourceType": "kick",
      "micType": null,
      "notes": ""
    }
  ]
}

SOURCE TYPE must be one of these canonical categories:
kick, snare_top, snare_bottom, hi_hat, overhead_L, overhead_R, tom_high, tom_mid, tom_floor,
bass_di, bass_amp, electric_guitar, acoustic_guitar, acoustic_guitar_di,
keys_L, keys_R, keys_mono, tracks_L, tracks_R, click,
vocal_lead, vocal_bg, vocal_pastor, vocal_worship_leader,
podium_mic, lapel_mic, handheld_wireless, headset_mic,
choir_L, choir_R, choir_mono,
ambient_L, ambient_R, audience_L, audience_R,
playback_L, playback_R, video_L, video_R,
sax, trumpet, violin, cello, percussion, djembe, cajon,
other, unused

RULES:
- Channel numbers are 1-indexed
- If the source says "empty", "unused", "spare", or is blank, set sourceType to "unused"
- Infer sourceType from common abbreviations: "Vox" = vocal, "GTR" = guitar, "KB" = keys, "OH" = overhead, "DI" = direct inject, "Aco" = acoustic, "Elec" = electric, "BG" = background, "WL" = worship leader
- If a photo is unclear, make your best guess and note confidence in the "notes" field
- Return ONLY the JSON, no markdown wrapping`;

const MIXER_SETUP_PROMPT = `You are an expert broadcast audio engineer setting up a digital mixing console for a church live stream.

Given a parsed patch list, generate full channel strip settings for EVERY channel using broadcast audio engineering best practices. These are STARTING POINTS for a live worship service broadcast mix.

The target console is a {MIXER_TYPE}.

For each channel provide:
1. HPF: enable + frequency based on source type
2. 4-band parametric EQ: each band has type (int), frequency (Hz), gain (dB), Q
3. Compressor: threshold (dB), ratio (X:1), attack (ms), release (ms), knee (0-5)
4. Gate: enable (only for drums/percussion), threshold (dB), range (dB), attack (ms), hold (ms), release (ms)
5. Initial fader level (0.0-1.0 where 0.75 = unity/0dB)
6. Scribble strip name (max 12 chars, readable abbreviation)
7. Mute state (true/false)

ENGINEERING GUIDELINES:
- HPF: Always enable. Vocals: 80-120Hz. Kick: 30-40Hz. Bass DI: 30Hz. Acoustic guitar: 80Hz. Keys: 40-60Hz. Overheads: 200Hz. Podium/lapel: 100-150Hz.
- EQ: Subtle. Band 1: low shelf or low cleanup. Band 2: low-mid (200-500Hz cuts for mud). Band 3: presence (1-5kHz). Band 4: air/clarity (8-15kHz).
- Vocals: 3dB cut at 350Hz, 2dB boost at 3.5kHz, 1dB boost at 10kHz air.
- Kick: boost 3dB at 65Hz, cut 4dB at 350Hz, boost 2.5dB at 3.5kHz.
- Snare: boost 2dB at 200Hz, cut 3dB at 800Hz, boost 3dB at 5kHz.
- Bass DI: boost 2dB at 80Hz, cut 3dB at 250Hz, boost 1.5dB at 2kHz.
- Compressor: Vocals 3-4:1, threshold for 3-6dB GR on peaks. Drums 3-4:1. Bass 4:1. Keys/guitars 2-3:1.
- Gate: Only on drums. Kick threshold -35dB. Snare -40dB. Toms -45dB. Mode 3 (GATE).
- Faders: Unity 0.75 for vocals. 0.72 for drums. 0.65 for keys. 0.0 for click/tracks (muted).
- Click/tracks: fader 0.0, mute true. NEVER route to house.
- Unused channels: name "---", HPF on 100Hz, EQ off, comp off, gate off, fader 0.0, mute true.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "channels": [
    {
      "channel": 1,
      "name": "Kick",
      "hpf": { "enabled": true, "frequency": 35 },
      "eq": {
        "enabled": true,
        "bands": [
          { "band": 1, "type": 2, "frequency": 65, "gain": 3.0, "q": 1.5 },
          { "band": 2, "type": 2, "frequency": 350, "gain": -4.0, "q": 2.0 },
          { "band": 3, "type": 2, "frequency": 3500, "gain": 2.5, "q": 2.5 },
          { "band": 4, "type": 4, "frequency": 10000, "gain": 1.0, "q": 1.0 }
        ]
      },
      "compressor": { "enabled": true, "threshold": -20, "ratio": 4, "attack": 5, "release": 80, "knee": 2 },
      "gate": { "enabled": true, "threshold": -35, "range": 40, "attack": 0.5, "hold": 5, "release": 150, "mode": 3 },
      "fader": 0.72,
      "mute": false
    }
  ]
}

EQ type values: 0=LCut, 1=LShelf, 2=PEQ, 3=VEQ, 4=HShelf, 5=HCut
All freq in Hz. All gain in dB. All time in ms. Fader 0.0-1.0.
Return ONLY JSON.`;

const CAMERA_PLOT_PROMPT = `You are an expert broadcast video engineer parsing a camera plot for a church or live production.

You will receive either text, a diagram image, or a PDF of a camera plot / stage plan.

Extract camera positions and generate a professional ATEM input setup.

OUTPUT FORMAT (strict JSON, no markdown):
{
  "cameras": [
    {
      "input": 1,
      "longName": "Wide Shot",
      "shortLabel": "WIDE",
      "position": "center back",
      "cameraType": "PTZ",
      "notes": "main wide establishing shot"
    }
  ],
  "suggestions": {
    "defaultProgram": 1,
    "defaultPreview": 2
  }
}

COMMON CHURCH CAMERA CONVENTIONS:
- Input 1: Wide/establishing shot (center back or balcony)
- Input 2: Pastor/speaker close-up
- Input 3: Worship leader / band shot
- Input 4: Alternate angle / crowd shot
- Higher inputs: Slides/ProPresenter, graphics, media players

RULES:
- Input numbers are 1-indexed (ATEM standard)
- longName: max 20 chars (ATEM long name limit)
- shortLabel: max 4 chars (ATEM short name)
- If the plot shows "ProPresenter" or "slides" or "graphics", map to higher input numbers
- If camera positions aren't specified, use broadcast best practices for a typical church
- Return ONLY JSON`;

// ─── ANTHROPIC API CALLS ──────────────────────────────────────────────────────

/**
 * Call Anthropic Claude with optional vision support.
 * @param {string} systemPrompt
 * @param {string} userText
 * @param {string|null} imageBase64  Base64-encoded image data (optional)
 * @param {string} mimeType  e.g. 'image/jpeg'
 * @returns {string} Raw response text
 */
async function callAnthropic(systemPrompt, userText, imageBase64 = null, mimeType = 'image/jpeg') {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY not configured — AI setup assistant requires Anthropic');

  // Build user message content
  const userContent = [];
  if (imageBase64) {
    userContent.push({
      type: 'image',
      source: {
        type: 'base64',
        media_type: mimeType,
        data: imageBase64,
      },
    });
  }
  if (userText) {
    userContent.push({ type: 'text', text: userText });
  }

  const messages = [
    { role: 'user', content: userContent.length === 1 && !imageBase64 ? userText : userContent },
  ];

  const resp = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: ANTHROPIC_MODEL,
      system: systemPrompt,
      messages,
      temperature: 0.2,
      max_tokens: 4096,
    }),
  });

  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Anthropic API error ${resp.status}: ${errText.slice(0, 200)}`);
  }

  const data = await resp.json();
  return (data.content?.[0]?.text || '').trim();
}

/**
 * Parse JSON from AI response, stripping markdown code fences if present.
 */
function parseAIJson(text) {
  let cleaned = text;
  // Strip ```json ... ``` wrapping
  const fenceMatch = cleaned.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fenceMatch) cleaned = fenceMatch[1];
  return JSON.parse(cleaned.trim());
}

// ─── MIXER SETUP PIPELINE ─────────────────────────────────────────────────────

/**
 * Parse a patch list from text or image.
 * @param {string} textInput  Text content (or empty if image-only)
 * @param {string|null} imageBase64
 * @param {string} mimeType
 * @returns {{ channels: Array<{channel, source, sourceType, micType, notes}> }}
 */
async function parsePatchList(textInput, imageBase64 = null, mimeType = 'image/jpeg') {
  const raw = await callAnthropic(PATCH_LIST_PARSER_PROMPT, textInput || 'Parse this patch list from the image.', imageBase64, mimeType);
  return parseAIJson(raw);
}

/**
 * Generate full channel strip settings from a parsed patch list.
 * @param {{ channels: Array }} patchList  Output from parsePatchList
 * @param {string} mixerType  e.g. 'behringer', 'allenheath', 'yamaha'
 * @returns {{ channels: Array<{channel, name, hpf, eq, compressor, gate, fader, mute}> }}
 */
async function generateMixerSetup(patchList, mixerType = 'behringer') {
  const prompt = MIXER_SETUP_PROMPT.replace('{MIXER_TYPE}', mixerType === 'behringer' || mixerType === 'midas' ? 'Behringer X32 / Midas M32' : mixerType === 'allenheath' ? 'Allen & Heath SQ' : 'Yamaha CL/QL');
  const input = JSON.stringify(patchList, null, 2);
  const raw = await callAnthropic(prompt, input);
  const result = parseAIJson(raw);

  // Clamp all values to safe ranges
  if (result.channels) {
    for (const ch of result.channels) {
      if (ch.hpf) {
        ch.hpf.frequency = Math.max(20, Math.min(400, ch.hpf.frequency || 80));
      }
      if (ch.eq && ch.eq.bands) {
        for (const b of ch.eq.bands) {
          b.frequency = Math.max(20, Math.min(20000, b.frequency || 1000));
          b.gain = Math.max(-15, Math.min(15, b.gain || 0));
          b.q = Math.max(0.3, Math.min(10, b.q || 2));
          b.type = Math.max(0, Math.min(5, b.type || 2));
          b.band = Math.max(1, Math.min(4, b.band || 1));
        }
      }
      if (ch.compressor) {
        ch.compressor.threshold = Math.max(-60, Math.min(0, ch.compressor.threshold || -20));
        ch.compressor.ratio = Math.max(1, Math.min(20, ch.compressor.ratio || 3));
        ch.compressor.attack = Math.max(0, Math.min(120, ch.compressor.attack || 10));
        ch.compressor.release = Math.max(5, Math.min(4000, ch.compressor.release || 100));
        ch.compressor.knee = Math.max(0, Math.min(5, ch.compressor.knee || 2));
      }
      if (ch.gate) {
        ch.gate.threshold = Math.max(-80, Math.min(0, ch.gate.threshold || -40));
        ch.gate.range = Math.max(3, Math.min(80, ch.gate.range || 40));
        ch.gate.attack = Math.max(0.02, Math.min(300, ch.gate.attack || 1));
        ch.gate.hold = Math.max(0.02, Math.min(2000, ch.gate.hold || 5));
        ch.gate.release = Math.max(5, Math.min(4000, ch.gate.release || 150));
      }
      ch.fader = Math.max(0, Math.min(1, ch.fader ?? 0.75));
      if (ch.name) ch.name = String(ch.name).slice(0, 12);
    }
  }

  return result;
}

// ─── CAMERA SETUP PIPELINE ────────────────────────────────────────────────────

/**
 * Parse a camera plot from text or image.
 * @param {string} textInput
 * @param {string|null} imageBase64
 * @param {string} mimeType
 * @returns {{ cameras: Array<{input, longName, shortLabel, position, cameraType, notes}>, suggestions }}
 */
async function parseCameraPlot(textInput, imageBase64 = null, mimeType = 'image/jpeg') {
  const raw = await callAnthropic(CAMERA_PLOT_PROMPT, textInput || 'Parse this camera plot from the image.', imageBase64, mimeType);
  return parseAIJson(raw);
}

/**
 * Build ATEM commands from parsed camera plot.
 * @param {{ cameras: Array, suggestions?: object }} cameraSetup
 * @returns {Array<{command: string, params: object}>}
 */
function buildCameraCommands(cameraSetup) {
  const commands = [];

  for (const cam of (cameraSetup.cameras || [])) {
    commands.push({
      command: 'atem.setInputLabel',
      params: {
        input: cam.input,
        longName: (cam.longName || cam.label || `Input ${cam.input}`).slice(0, 20),
      },
    });
  }

  return commands;
}

// ─── EXPORTS ──────────────────────────────────────────────────────────────────

module.exports = {
  detectSetupIntent,
  detectIntentWithAttachment,
  parsePatchList,
  generateMixerSetup,
  parseCameraPlot,
  buildCameraCommands,
};
