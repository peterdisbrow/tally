/**
 * Tally Telegram Bot
 * Handles TD and admin commands via a single shared Telegram bot.
 * Uses raw Bot API (fetch) — no library needed.
 */

const crypto = require('crypto');
const { aiParseCommand } = require('./ai-parser');
const { isStreamActive, isRecordingActive } = require('./status-utils');
const { smartParse } = require('./smart-parser');
const { classifyIntent } = require('./intent-classifier');
const { checkStreamSafety, checkWorkflowSafety, hasForceBypass } = require('./stream-guard');
const { parseRundownDescription, editRundownCues, formatRundownPreview } = require('./rundown-ai');
const { bt, churchLocale } = require('./botI18n');

// ─── CANNED RESPONSES (troubleshooting guides for /fix command) ──────────────

const CANNED_RESPONSES = {
  'obs': {
    title: '🔧 OBS Connection Troubleshooting',
    text: `Here's how to fix OBS connection issues:

1. Make sure OBS Studio is open
2. Go to Tools → WebSocket Server Settings
3. Check "Enable WebSocket server"
4. Set port to 4455
5. Click OK and restart OBS
6. In Tally, go to Equipment and verify the OBS connection

If it still won't connect, check that no firewall is blocking port 4455.`
  },
  'atem': {
    title: '🔧 ATEM Connection Troubleshooting',
    text: `Here's how to fix ATEM connection issues:

1. Check the ATEM is powered on (front panel lights)
2. Verify the ethernet cable is connected and link lights are active
3. Open ATEM Software Control — can you connect there?
4. If not, check the ATEM's IP:
   - On Mini: hold the button on the front to see the IP on the multiview
   - On larger models: check ATEM Setup utility
5. Make sure the IP in Tally Equipment settings matches
6. Both devices must be on the same subnet (e.g., 192.168.1.x)

Common issue: ATEM defaults to 192.168.10.240 — your network might use a different range.`
  },
  'stream': {
    title: '🔧 Stream Not Working',
    text: `Steps to fix your stream:

1. Check internet — can you load a website?
2. In OBS: Settings → Stream — verify your stream key is correct
3. Check your streaming platform dashboard — is the stream key still valid?
4. Try stopping and restarting the stream in OBS
5. If using an encoder: check the encoder dashboard for error messages

If you recently changed your stream key on YouTube/Facebook, update it in OBS too.`
  },
  'audio': {
    title: '🔧 Audio Issues',
    text: `Steps to fix audio problems:

1. Check the mixer/console is powered on
2. Verify channel faders and master fader are up (not muted)
3. Check the audio output to your stream:
   - USB: make sure OBS has the correct USB audio device selected
   - Dante: verify Dante routing in Dante Controller
   - Analog/Aux: check the aux send level going to your encoder
4. In OBS: check the audio mixer panel — are the meters showing signal?
5. Click the speaker icon on each audio source to make sure nothing is muted

If meters show signal in OBS but stream has no audio, check your streaming output audio settings.`
  },
  'encoder': {
    title: '🔧 Encoder Troubleshooting',
    text: `Steps to fix encoder issues:

1. Check the encoder is powered on and showing activity
2. Verify the network connection (ethernet cable, link lights)
3. Reboot the encoder (power cycle, wait 60 seconds)
4. Check the encoder's web dashboard for error messages
5. Verify the IP address matches what's configured in Tally
6. Make sure the stream key/destination is configured on the encoder

For Blackmagic Web Presenter: access its web UI at its IP address in a browser.`
  },
  'recording': {
    title: '🔧 Recording Issues',
    text: `Steps to fix recording problems:

1. Check disk space — you need at least 50GB free for a service
2. In OBS: Settings → Output → Recording — verify the path exists
3. Try starting recording manually in OBS
4. If using HyperDeck: check the SSD is inserted and has space
5. Check file permissions on the recording directory

Common issue: the recording folder was on an external drive that isn't plugged in.`
  },
  'companion': {
    title: '🔧 Companion Connection Issues',
    text: `Steps to fix Bitfocus Companion:

1. Check that Companion is running (it's a separate application)
2. Try opening http://localhost:8000 in a browser
3. If Companion is on another computer, check the IP in Tally Equipment settings
4. Verify no firewall is blocking the connection
5. Restart Companion if needed

Companion must be running for button deck control to work.`
  },
  'network': {
    title: '🔧 Network Troubleshooting',
    text: `General network troubleshooting:

1. Check your internet connection — load a website in a browser
2. Verify all devices are on the same network/subnet
3. Check your network switch — are all link lights active?
4. Try pinging devices: open Terminal and type "ping [device IP]"
5. Restart your network switch if multiple devices lost connection
6. Check if a firewall or content filter is blocking connections

If Tally shows "Relay Disconnected" — it's an internet issue between your building and our server.`
  },
  'preservice': {
    title: '✅ Pre-Service Checklist',
    text: `Quick pre-service checks:

1. ✅ ATEM connected and on the right scene
2. ✅ OBS connected, correct scene selected
3. ✅ Audio levels showing signal on the mixer
4. ✅ Stream key is set and platform is ready
5. ✅ Recording drive has space
6. ✅ All cameras powered on and framed
7. ✅ ProPresenter/lyrics software loaded
8. ✅ Test the stream — go live for 30 seconds, check on your phone

Tally runs automated pre-service checks 30 minutes before your scheduled service time.`
  },
  'restart': {
    title: '🔄 Full System Restart Guide',
    text: `If things are really broken, here's the restart order:

1. Stop the stream and recording
2. Close OBS
3. Power cycle the ATEM (wait 30 seconds)
4. Power cycle any encoders (wait 60 seconds)
5. Restart Companion
6. Reopen OBS
7. Wait for Tally to reconnect all devices (check the Status tab)
8. Start the stream and recording

This fixes most issues. The order matters — ATEM first, then encoders, then OBS.`
  },
};

function _formatFixList() {
  return `📋 *Available troubleshooting guides:*

/fix obs — OBS connection issues
/fix atem — ATEM switcher connection
/fix stream — Stream not working
/fix audio — Audio problems
/fix encoder — Encoder issues
/fix recording — Recording issues
/fix companion — Companion connection
/fix network — Network troubleshooting
/fix preservice — Pre-service checklist
/fix restart — Full system restart guide`;
}

function isValidSlackWebhookUrl(url) {
  try {
    const parsed = new URL(String(url || '').trim());
    return parsed.protocol === 'https:' &&
      (parsed.hostname === 'hooks.slack.com' || parsed.hostname.endsWith('.slack.com'));
  } catch {
    return false;
  }
}

// ─── COMMAND PATTERNS (ported from parse-command.js + videohub + extras) ─────

const patterns = [
  // ATEM — cut/switch
  { match: /^(?!.*\b(?:vmix|v\.?mix)\b).*?(?:cut|switch|go)\s+(?:to\s+)?(?:cam(?:era)?|input)\s*(\d+)/i, command: 'atem.cut', extract: m => ({ input: parseInt(m[1]) }), desc: 'cut to camera N' },
  { match: /^(?!.*\b(?:vmix|v\.?mix)\b).*?(?:cam(?:era)?|input)\s*(\d+)\s+(?:to|on)\s+(?:program|pgm|live)/i, command: 'atem.cut', extract: m => ({ input: parseInt(m[1]) }), desc: null },
  { match: /^(?!.*\b(?:vmix|v\.?mix)\b).*?(?:put\s+)?(?:cam(?:era)?|input)\s*(\d+)\s+(?:to|on)\s+preview/i, command: 'atem.setPreview', extract: m => ({ input: parseInt(m[1]) }), desc: 'camera N to preview' },
  { match: /^(?!.*\b(?:vmix|v\.?mix)\b).*?(?:set|change)\s+preview?\s+(?:to\s+)?(?:cam(?:era)?|input)\s*(\d+)/i, command: 'atem.setPreview', extract: m => ({ input: parseInt(m[1]) }), desc: null },

  // ATEM — transitions
  { match: /auto\s*(?:transition|mix|trans)|^take$/i, command: 'atem.auto', extract: () => ({}), desc: 'auto transition / take' },
  { match: /(?:fade\s*to\s*black|ftb)/i, command: 'atem.fadeToBlack', extract: () => ({}), desc: 'fade to black' },

  // ATEM — recording (device-specific; generic "start/stop recording" handled by smart-parser)
  { match: /(?:start|begin)\s+(?:atem\s+)?recording\s+(?:on\s+)?(?:atem|switcher)/i, command: 'atem.startRecording', extract: () => ({}), desc: 'start ATEM recording' },
  { match: /stop\s+(?:atem\s+)?recording\s+(?:on\s+)?(?:atem|switcher)/i, command: 'atem.stopRecording', extract: () => ({}), desc: 'stop ATEM recording' },

  // ATEM — input label / rename
  { match: /(?:change|rename|set|label)\s+(?:cam(?:era)?|input)\s*(\d+)\s+(?:name\s+)?(?:to|as)\s+["""]?(.+?)["""]?\s*$/i, command: 'atem.setInputLabel', extract: m => ({ input: parseInt(m[1]), longName: m[2].trim() }), desc: 'rename camera N to "Name"' },
  { match: /label\s+(?:cam(?:era)?|input)\s*(\d+)\s+["""]?(.+?)["""]?\s*$/i, command: 'atem.setInputLabel', extract: m => ({ input: parseInt(m[1]), longName: m[2].trim() }), desc: null },
  { match: /(?:run|start)\s+(?:macro)\s*(\d+)/i, command: 'atem.runMacro', extract: m => ({ macroIndex: parseInt(m[1]) }), desc: 'run macro N' },
  { match: /(?:stop|abort)\s+macro/i, command: 'atem.stopMacro', extract: () => ({}), desc: 'stop macro' },
  { match: /(?:set|route)\s+aux\s*(\d+)\s+(?:to\s+)?(?:cam(?:era)?|input)\s*(\d+)/i, command: 'atem.setAux', extract: m => ({ aux: parseInt(m[1]), input: parseInt(m[2]) }), desc: 'route aux N to input N' },
  { match: /(?:set\s+)?transition\s+style\s+(mix|dip|wipe|dve|sting(?:er)?)/i, command: 'atem.setTransitionStyle', extract: m => ({ style: String(m[1]).toLowerCase() }), desc: 'set transition style' },
  { match: /(?:set\s+)?transition\s+(?:rate|speed)\s*(\d+)/i, command: 'atem.setTransitionRate', extract: m => ({ rate: parseInt(m[1]) }), desc: 'set transition rate' },
  { match: /(?:dsk|key)\s*(\d+)\s+(on|off|onair|offair)/i, command: 'atem.setDskOnAir', extract: m => ({ keyer: Math.max(0, parseInt(m[1]) - 1), onAir: /on/.test(String(m[2]).toLowerCase()) }), desc: 'set DSK on/off air' },
  { match: /(?:dsk|key)\s*(\d+)\s+tie\s+(on|off)/i, command: 'atem.setDskTie', extract: m => ({ keyer: Math.max(0, parseInt(m[1]) - 1), tie: String(m[2]).toLowerCase() === 'on' }), desc: 'set DSK tie on/off' },
  { match: /(?:dsk|key)\s*(\d+)\s+rate\s*(\d+)/i, command: 'atem.setDskRate', extract: m => ({ keyer: Math.max(0, parseInt(m[1]) - 1), rate: parseInt(m[2]) }), desc: 'set DSK rate' },
  { match: /(?:dsk|key)\s*(\d+)\s+source\s+fill\s*(\d+)\s+key\s*(\d+)/i, command: 'atem.setDskSource', extract: m => ({ keyer: Math.max(0, parseInt(m[1]) - 1), fillSource: parseInt(m[2]), keySource: parseInt(m[3]) }), desc: 'set DSK fill/key source' },

  // HyperDeck
  { match: /hyperdeck\s*(\d+)\s+(play|stop|record|next|prev|previous)/i, command: 'hyperdeck.action', extract: m => ({ hyperdeck: parseInt(m[1]), action: String(m[2]).toLowerCase() }), desc: 'control hyperdeck transport' },

  // PTZ (network camera protocols)
  { match: /ptz\s*(\d+)\s+preset\s*(\d+)/i, command: 'ptz.preset', extract: m => ({ camera: parseInt(m[1]), preset: parseInt(m[2]) }), desc: 'PTZ camera N recall preset N' },
  { match: /ptz\s*(\d+)\s+save\s+preset\s*(\d+)/i, command: 'ptz.setPreset', extract: m => ({ camera: parseInt(m[1]), preset: parseInt(m[2]) }), desc: 'PTZ camera N save preset N' },
  { match: /ptz\s*(\d+)\s+home/i, command: 'ptz.home', extract: m => ({ camera: parseInt(m[1]) }), desc: 'PTZ camera N home' },
  { match: /ptz\s*(\d+)\s+stop/i, command: 'ptz.stop', extract: m => ({ camera: parseInt(m[1]) }), desc: 'PTZ camera N stop' },
  { match: /ptz\s*(\d+)\s+zoom\s+(in|out|stop)/i, command: 'ptz.zoom', extract: m => ({ camera: parseInt(m[1]), speed: m[2].toLowerCase() === 'in' ? 0.6 : (m[2].toLowerCase() === 'out' ? -0.6 : 0) }), desc: 'PTZ zoom' },
  { match: /ptz\s*(\d+)\s+pan\s+(left|right|stop)/i, command: 'ptz.pan', extract: m => ({ camera: parseInt(m[1]), speed: m[2].toLowerCase() === 'left' ? -0.6 : (m[2].toLowerCase() === 'right' ? 0.6 : 0) }), desc: 'PTZ pan' },
  { match: /ptz\s*(\d+)\s+tilt\s+(up|down|stop)/i, command: 'ptz.tilt', extract: m => ({ camera: parseInt(m[1]), speed: m[2].toLowerCase() === 'up' ? 0.6 : (m[2].toLowerCase() === 'down' ? -0.6 : 0) }), desc: 'PTZ tilt' },

  // Blackmagic camera control (via ATEM)
  { match: /cam(?:era)?\s*(\d+)\s+iris\s+(open)/i, command: 'camera.setIris', extract: m => ({ camera: parseInt(m[1]), value: 1.0 }), desc: 'cam N iris open' },
  { match: /cam(?:era)?\s*(\d+)\s+iris\s+(close|closed)/i, command: 'camera.setIris', extract: m => ({ camera: parseInt(m[1]), value: 0 }), desc: 'cam N iris close' },
  { match: /cam(?:era)?\s*(\d+)\s+iris\s+(\d+(?:\.\d+)?)\s*%?/i, command: 'camera.setIris', extract: m => ({ camera: parseInt(m[1]), value: parseFloat(m[2]) }), desc: 'cam N iris N%' },
  { match: /cam(?:era)?\s*(\d+)\s+auto\s*iris/i, command: 'camera.autoIris', extract: m => ({ camera: parseInt(m[1]) }), desc: 'cam N auto iris' },
  { match: /cam(?:era)?\s*(\d+)\s+gain\s+(\d+)/i, command: 'camera.setGain', extract: m => ({ camera: parseInt(m[1]), gain: parseInt(m[2]) }), desc: 'cam N gain N dB' },
  { match: /cam(?:era)?\s*(\d+)\s+iso\s+(\d+)/i, command: 'camera.setISO', extract: m => ({ camera: parseInt(m[1]), iso: parseInt(m[2]) }), desc: 'cam N ISO N' },
  { match: /cam(?:era)?\s*(\d+)\s+(?:white\s*balance|wb)\s+(\d+)\s*k?/i, command: 'camera.setWhiteBalance', extract: m => ({ camera: parseInt(m[1]), kelvin: parseInt(m[2]) }), desc: 'cam N wb N K' },
  { match: /cam(?:era)?\s*(\d+)\s+auto\s*(?:white\s*balance|wb)/i, command: 'camera.autoWhiteBalance', extract: m => ({ camera: parseInt(m[1]) }), desc: 'cam N auto wb' },
  { match: /cam(?:era)?\s*(\d+)\s+shutter\s+(\d+)/i, command: 'camera.setShutter', extract: m => ({ camera: parseInt(m[1]), speed: parseInt(m[2]) }), desc: 'cam N shutter N°' },
  { match: /cam(?:era)?\s*(\d+)\s+auto\s*focus/i, command: 'camera.autoFocus', extract: m => ({ camera: parseInt(m[1]) }), desc: 'cam N auto focus' },
  { match: /cam(?:era)?\s*(\d+)\s+focus\s+(\d+(?:\.\d+)?)\s*%?/i, command: 'camera.setFocus', extract: m => ({ camera: parseInt(m[1]), value: parseFloat(m[2]) / (parseFloat(m[2]) > 1 ? 100 : 1) }), desc: 'cam N focus N%' },
  { match: /cam(?:era)?\s*(\d+)\s+saturation\s+(\d+(?:\.\d+)?)/i, command: 'camera.setSaturation', extract: m => ({ camera: parseInt(m[1]), saturation: parseFloat(m[2]) }), desc: 'cam N saturation N' },
  { match: /cam(?:era)?\s*(\d+)\s+contrast\s+(\d+(?:\.\d+)?)/i, command: 'camera.setContrast', extract: m => ({ camera: parseInt(m[1]), adjust: parseFloat(m[2]) }), desc: 'cam N contrast N' },
  { match: /cam(?:era)?\s*(\d+)\s+reset\s+color/i, command: 'camera.resetColorCorrection', extract: m => ({ camera: parseInt(m[1]) }), desc: 'cam N reset color' },

  // OBS — stream (device-specific; generic "start/stop stream" / "go live" handled by smart-parser)
  { match: /(?:start|begin|go)\s+(?:the\s+)?(?:obs)\s+stream(?:ing)?/i, command: 'obs.startStream', extract: () => ({}), desc: 'start OBS stream' },
  { match: /(?:stop|end)\s+(?:the\s+)?(?:obs)\s+stream(?:ing)?/i, command: 'obs.stopStream', extract: () => ({}), desc: 'stop OBS stream' },

    // vMix - legacy/volunteer production flows
  { match: /(?:^|\s)(?:start|begin|go)\s+(?:the\s+)?(?:vmix|v\.?mix)\s*(?:stream|streaming)?/i, command: 'vmix.startStream', extract: () => ({}), desc: 'start vMix stream' },
  { match: /(?:\S+)\s+(?:vmix|v\.?mix)\s*(?:stream|streaming)?|(?:^|\s)(?:start|begin|go)\s+stream\s+(?:on\s+)?(?:vmix|v\.?mix)/i, command: 'vmix.startStream', extract: () => ({}), desc: 'start vMix stream' },
  { match: /(?:^|\s)(?:stop|end)\s+(?:the\s+)?(?:vmix|v\.?mix)\s*(?:stream|streaming)?/i, command: 'vmix.stopStream', extract: () => ({}), desc: 'stop vMix stream' },
  { match: /(?:\S+)\s+(?:vmix|v\.?mix)\s+stream|(?:^|\s)(?:stop|end)\s+stream\s+(?:on\s+)?(?:vmix|v\.?mix)/i, command: 'vmix.stopStream', extract: () => ({}), desc: 'stop vMix stream' },
  { match: /(?:start|begin|go)\s+(?:\S+\s+)?(?:vmix|v\.?mix)\s+recording/i, command: 'vmix.startRecording', extract: () => ({}), desc: 'start vMix recording' },
  { match: /(?:stop|end)\s+(?:\S+\s+)?(?:vmix|v\.?mix)\s+recording/i, command: 'vmix.stopRecording', extract: () => ({}), desc: 'stop vMix recording' },
  { match: /(?:vmix|v\.?mix)\s+(?:mute|muting)/i, command: 'vmix.mute', extract: () => ({}), desc: 'mute vMix master' },
  { match: /(?:vmix|v\.?mix)\s+(?:unmute|unmuting)/i, command: 'vmix.unmute', extract: () => ({}), desc: 'unmute vMix master' },
  { match: /(?:vmix|v\.?mix)\s+volume\s*(\d{1,3})%?/i, command: 'vmix.setVolume', extract: m => ({ value: Number(m[1]) }), desc: 'set vMix master volume' },
  { match: /(?:vmix|v\.?mix)\s+to\s+(?:program|air|live|pgm|out|output)\s+(?:cam(?:era)?|camera|input)?\s*(\d+)|(?:vmix|v\.?mix)\s+(?:cam(?:era)?|camera|input)\s*(\d+)\s*(?:to\s+)?(?:program|air|live|pgm|out|output)/i, command: 'vmix.setProgram', extract: m => ({ input: parseInt(m[1] || m[2] || 1) }), desc: 'vmix cut to input N' },
  { match: /(?:vmix|v\.?mix)\s+cut/i, command: 'vmix.cut', extract: () => ({}), desc: 'vmix cut transition' },
  { match: /(?:vmix|v\.?mix)\s+set\s+(?:program|air|live|pgm|out|output)\s+(?:to\s+)?(?:input|camera|cam)?\s*(\d+)/i, command: 'vmix.setProgram', extract: m => ({ input: parseInt(m[1]) }), desc: 'vmix set program input' },
  { match: /(?:vmix|v\.?mix)\s+(?:set\s+)?preview\s*(?:to|on)?\s*(?:input|camera|cam)?\s*(\d+)/i, command: 'vmix.setPreview', extract: m => ({ input: parseInt(m[1]) }), desc: 'vmix preview input N' },
  { match: /(?:list|show)\s+(?:vmix|v\.?mix)\s+inputs/i, command: 'vmix.listInputs', extract: () => ({}), desc: 'list vMix inputs' },
  { match: /(?:vmix|v\.?mix)\s+fade\s*(\d+)?/i, command: 'vmix.fade', extract: m => ({ ms: Number(m[1] || 500) }), desc: 'vmix fade to preview' },
  { match: /(?:vmix|v\.?mix)\s+snapshot/i, command: 'vmix.preview', extract: () => ({}), desc: 'take vmix preview snapshot' },
  { match: /(?:is\s+)?(?:vmix|v\.?mix)\s+running|(?:vmix|v\.?mix)\s+status|(?:vmix|v\.?mix)\s+health/i, command: 'vmix.isRunning', extract: () => ({}), desc: 'check vmix running' },

  // Encoder (standalone encoder bridge)
  { match: /(?:start|begin|go)\s+(?:the\s+)?encoder\s+stream(?:ing)?|encoder\s+go\s+live/i, command: 'encoder.startStream', extract: () => ({}), desc: 'start encoder stream' },
  { match: /(?:stop|end)\s+(?:the\s+)?encoder\s+stream(?:ing)?/i, command: 'encoder.stopStream', extract: () => ({}), desc: 'stop encoder stream' },
  { match: /(?:start|begin)\s+encoder\s+record(?:ing)?/i, command: 'encoder.startRecording', extract: () => ({}), desc: 'start encoder recording' },
  { match: /(?:stop|end)\s+encoder\s+record(?:ing)?/i, command: 'encoder.stopRecording', extract: () => ({}), desc: 'stop encoder recording' },
  { match: /(?:start|begin|go)\s+(?:the\s+)?encoders?\s*$/i, command: 'encoder.startStream', extract: () => ({}), desc: 'start encoder (bare — defaults to stream)' },
  { match: /(?:stop|end|kill)\s+(?:the\s+)?encoders?\s*$/i, command: 'encoder.stopStream', extract: () => ({}), desc: 'stop encoder (bare — defaults to stream)' },
  { match: /(?:encoder|hardware\s+encoder)\s+status/i, command: 'encoder.status', extract: () => ({}), desc: 'encoder status' },

// OBS — scene
  { match: /(?:switch|go|change)\s+(?:to\s+)?scene\s+["""]?(.+?)["""]?\s*$/i, command: 'obs.setScene', extract: m => ({ scene: m[1].trim() }), desc: 'switch to scene "Name"' },

  // Mixer — softkey (must be before Companion to avoid "press softkey" matching companion)
  { match: /(?:press|trigger|hit)\s+soft\s*key\s*(\d+)/i, command: 'mixer.pressSoftKey', extract: m => ({ key: parseInt(m[1]) }), desc: 'press softkey N' },

  // Companion
  { match: /(?:press|trigger|hit|fire)\s+(?:the\s+)?["""](.+?)["""](?:\s+(?:button|in|on))?/i, command: 'companion.pressNamed', extract: m => ({ name: m[1] }), desc: 'press "button name"' },
  { match: /(?:press|trigger|hit|fire)\s+(?:the\s+)?(.+?)(?:\s+button)?$/i, command: 'companion.pressNamed', extract: m => ({ name: m[1].trim() }), desc: null },
  { match: /play\s+(?:the\s+)?["""]?(.+?)["""]?\s*$/i, command: 'companion.pressNamed', extract: m => ({ name: m[1].trim() }), desc: 'play the "video name"' },

  // Video Hub — routing
  { match: /route\s+(?:cam(?:era)?|input)\s*(\d+)\s+(?:to\s+)?(?:monitor|output)\s*(\d+)/i, command: 'videohub.route', extract: m => ({ input: parseInt(m[1]), output: parseInt(m[2]) }), desc: 'route camera N to monitor N' },
  { match: /(?:send|patch)\s+(?:cam(?:era)?|input)\s*(\d+)\s+(?:to\s+)?(?:output|monitor)\s*(\d+)/i, command: 'videohub.route', extract: m => ({ input: parseInt(m[1]), output: parseInt(m[2]) }), desc: null },
  { match: /what'?s?\s+(?:on|routed\s+to)\s+(?:monitor|output)\s*(\d+)/i, command: 'videohub.getRoutes', extract: m => ({ filterOutput: parseInt(m[1]) }), desc: "what's on monitor N?" },
  { match: /(?:show\s+)?rout(?:ing|es?)(?:\s+status)?/i, command: 'videohub.getRoutes', extract: () => ({}), desc: 'show routing' },
  { match: /rename\s+(?:hub\s+)?input\s*(\d+)\s+(?:to\s+)?["""]?(.+?)["""]?\s*$/i, command: 'videohub.setInputLabel', extract: m => ({ index: parseInt(m[1]), label: m[2].trim() }), desc: 'rename input N to "Name"' },
  { match: /rename\s+(?:hub\s+)?output\s*(\d+)\s+(?:to\s+)?["""]?(.+?)["""]?\s*$/i, command: 'videohub.setOutputLabel', extract: m => ({ index: parseInt(m[1]), label: m[2].trim() }), desc: null },

  // ProPresenter
  { match: /^(?:next\s+slide|advance)$/i, command: 'propresenter.next', extract: () => ({}), desc: 'next slide / advance' },
  { match: /^(?:previous\s+slide|go\s+back|back\s+slide|prev\s+slide)$/i, command: 'propresenter.previous', extract: () => ({}), desc: 'previous slide / go back' },
  { match: /(?:what'?s?\s+on\s+screen|current\s+slide|what\s+slide)/i, command: 'propresenter.status', extract: () => ({}), desc: 'current slide / what\'s on screen?' },
  { match: /(?:go|jump)\s+to\s+slide\s+(\d+)/i, command: 'propresenter.goToSlide', extract: m => ({ index: parseInt(m[1]) }), desc: 'go to slide N' },
  { match: /^(?:playlist|what'?s?\s+loaded)\s*\??$/i, command: 'propresenter.playlist', extract: () => ({}), desc: 'playlist / what\'s loaded?' },
  { match: /^(?:clear\s+all|blank\s+all|clear\s+everything)$/i, command: 'propresenter.clearAll', extract: () => ({}), desc: 'clear all / blank all' },
  { match: /^(?:clear\s+slide|blank\s+slide)$/i, command: 'propresenter.clearSlide', extract: () => ({}), desc: 'clear slide' },
  { match: /(?:stage\s+message|show\s+message)\s+["""]?(.+?)["""]?\s*$/i, command: 'propresenter.stageMessage', extract: m => ({ name: m[1].trim() }), desc: 'stage message [name]' },
  { match: /^(?:clear\s+message|hide\s+message)s?\s*$/i, command: 'propresenter.clearMessage', extract: () => ({}), desc: 'clear message' },
  { match: /^(?:list\s+)?looks?\s*\??$/i, command: 'propresenter.getLooks', extract: () => ({}), desc: 'looks' },
  { match: /(?:set\s+look|switch\s+(?:to\s+)?look|activate\s+look)\s+["""]?(.+?)["""]?\s*$/i, command: 'propresenter.setLook', extract: m => ({ name: m[1].trim() }), desc: 'set look [name]' },
  { match: /^(?:list\s+)?timers?\s*\??$/i, command: 'propresenter.getTimers', extract: () => ({}), desc: 'timers' },
  { match: /start\s+timer\s+["""]?(.+?)["""]?\s*$/i, command: 'propresenter.startTimer', extract: m => ({ name: m[1].trim() }), desc: 'start timer [name]' },
  { match: /stop\s+timer\s+["""]?(.+?)["""]?\s*$/i, command: 'propresenter.stopTimer', extract: m => ({ name: m[1].trim() }), desc: 'stop timer [name]' },

  // Dante (via Companion)
  { match: /(?:load\s+dante\s+scene|dante\s+preset)\s+["""]?(.+?)["""]?\s*$/i, command: 'dante.scene', extract: m => ({ name: m[1].trim() }), desc: 'load dante scene [name]' },

  // Mixer — mute / unmute / fader (unmute BEFORE mute so "unmute" isn't caught by /mute/)
  { match: /unmute\s+(?:channel|ch)\s*(\d+)/i, command: 'mixer.unmute', extract: m => ({ channel: parseInt(m[1]) }), desc: 'unmute channel N' },
  { match: /(?<!un)mute\s+(?:channel|ch)\s*(\d+)/i, command: 'mixer.mute', extract: m => ({ channel: parseInt(m[1]) }), desc: 'mute channel N' },
  { match: /unmute\s+master/i, command: 'mixer.unmute', extract: () => ({ channel: 'master' }), desc: 'unmute master output' },
  { match: /(?<!un)mute\s+master/i, command: 'mixer.mute', extract: () => ({ channel: 'master' }), desc: 'mute master output' },
  { match: /(?:set\s+)?(?:channel|ch)\s*(\d+)\s+fader\s*(?:to)?\s*(\d{1,3})%?/i, command: 'mixer.setFader', extract: m => ({ channel: parseInt(m[1]), level: Math.max(0, Math.min(1, parseInt(m[2]) / 100)) }), desc: 'set channel fader level' },
  { match: /(?:set\s+)?fader\s+(?:channel|ch)\s*(\d+)\s*(?:to)?\s*(\d{1,3})%?/i, command: 'mixer.setFader', extract: m => ({ channel: parseInt(m[1]), level: Math.max(0, Math.min(1, parseInt(m[2]) / 100)) }), desc: null },

  // Mixer — scene
  { match: /(?:recall|load)\s+(?:mixer\s+)?scene\s*(\d+)/i, command: 'mixer.recallScene', extract: m => ({ scene: parseInt(m[1]) }), desc: 'recall mixer scene' },
  { match: /save\s+(?:mixer\s+)?scene\s*(\d+)(?:\s+(?:as|name(?:d)?)\s+["""]?(.+?)["""]?)?\s*$/i, command: 'mixer.saveScene', extract: m => ({ scene: parseInt(m[1]), name: (m[2] || '').trim() || undefined }), desc: 'save mixer scene' },

  // Mixer — status & channel status
  { match: /(?:mixer|audio|console)\s+status/i, command: 'mixer.status', extract: () => ({}), desc: 'audio console status' },
  { match: /(?:channel|ch)\s*(\d+)\s+status/i, command: 'mixer.channelStatus', extract: m => ({ channel: parseInt(m[1]) }), desc: 'channel N status' },

  // Mixer — channel name
  { match: /(?:name|label|rename)\s+(?:channel|ch)\s*(\d+)\s+(?:to\s+|as\s+)?["""]?(.+?)["""]?\s*$/i, command: 'mixer.setChannelName', extract: m => ({ channel: parseInt(m[1]), name: m[2].trim() }), desc: 'name channel N' },

  // Mixer — HPF
  { match: /(?:enable|turn\s+on)\s+(?:hpf|high\s*pass)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setHpf', extract: m => ({ channel: parseInt(m[1]), enabled: true }), desc: 'enable HPF on channel N' },
  { match: /(?:disable|turn\s+off)\s+(?:hpf|high\s*pass)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setHpf', extract: m => ({ channel: parseInt(m[1]), enabled: false }), desc: 'disable HPF on channel N' },
  { match: /(?:set\s+)?(?:hpf|high\s*pass)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)\s+(?:to\s+)?(\d+)\s*(?:hz)?/i, command: 'mixer.setHpf', extract: m => ({ channel: parseInt(m[1]), enabled: true, frequency: parseInt(m[2]) }), desc: 'set HPF frequency on channel N' },

  // Mixer — pan
  { match: /pan\s+(?:channel|ch)\s*(\d+)\s+(left|right|center|centre)/i, command: 'mixer.setPan', extract: m => ({ channel: parseInt(m[1]), pan: m[2].toLowerCase() === 'left' ? -1.0 : m[2].toLowerCase() === 'right' ? 1.0 : 0 }), desc: 'pan channel N L/R/C' },
  { match: /pan\s+(?:channel|ch)\s*(\d+)\s+(?:to\s+)?(-?\d+)\s*%?/i, command: 'mixer.setPan', extract: m => ({ channel: parseInt(m[1]), pan: Math.max(-1, Math.min(1, parseInt(m[2]) / 100)) }), desc: 'pan channel N to N%' },

  // Mixer — preamp gain / phantom
  { match: /(?:set\s+)?(?:preamp|trim|pre-amp)\s+(?:gain\s+)?(?:on\s+)?(?:channel|ch)\s*(\d+)\s+(?:to\s+)?([+-]?\d+(?:\.\d+)?)\s*(?:db)?/i, command: 'mixer.setPreampGain', extract: m => ({ channel: parseInt(m[1]), gain: parseFloat(m[2]) }), desc: 'set preamp gain' },
  { match: /(?:enable|turn\s+on)\s+(?:phantom|48v)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setPhantom', extract: m => ({ channel: parseInt(m[1]), enabled: true }), desc: 'enable phantom power' },
  { match: /(?:disable|turn\s+off)\s+(?:phantom|48v)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setPhantom', extract: m => ({ channel: parseInt(m[1]), enabled: false }), desc: 'disable phantom power' },

  // Mixer — send level
  { match: /(?:set\s+)?send\s+(?:from\s+)?(?:channel|ch)\s*(\d+)\s+(?:to\s+)?(?:bus|mix)\s*(\d+)\s+(?:to\s+|at\s+)?(\d{1,3})%?/i, command: 'mixer.setSendLevel', extract: m => ({ channel: parseInt(m[1]), bus: parseInt(m[2]), level: Math.max(0, Math.min(1, parseInt(m[3]) / 100)) }), desc: 'set send level ch→bus' },

  // Mixer — DCA control (unmute BEFORE mute)
  { match: /unmute\s+dca\s*(\d+)/i, command: 'mixer.unmuteDca', extract: m => ({ dca: parseInt(m[1]) }), desc: 'unmute DCA N' },
  { match: /(?<!un)mute\s+dca\s*(\d+)/i, command: 'mixer.muteDca', extract: m => ({ dca: parseInt(m[1]) }), desc: 'mute DCA N' },
  { match: /(?:set\s+)?dca\s*(\d+)\s+(?:fader\s+|level\s+)?(?:to\s+)?(\d{1,3})%?/i, command: 'mixer.setDcaFader', extract: m => ({ dca: parseInt(m[1]), level: Math.max(0, Math.min(1, parseInt(m[2]) / 100)) }), desc: 'set DCA fader level' },
  { match: /assign\s+(?:channel|ch)\s*(\d+)\s+(?:to\s+)?dca\s*(\d+)/i, command: 'mixer.assignToDca', extract: m => ({ channel: parseInt(m[1]), dca: parseInt(m[2]), enabled: true }), desc: 'assign channel to DCA' },
  { match: /(?:remove|unassign)\s+(?:channel|ch)\s*(\d+)\s+(?:from\s+)?dca\s*(\d+)/i, command: 'mixer.assignToDca', extract: m => ({ channel: parseInt(m[1]), dca: parseInt(m[2]), enabled: false }), desc: 'remove channel from DCA' },

  // Mixer — bus assign
  { match: /assign\s+(?:channel|ch)\s*(\d+)\s+(?:to\s+)?(?:bus|mix)\s*(\d+)/i, command: 'mixer.assignToBus', extract: m => ({ channel: parseInt(m[1]), bus: parseInt(m[2]), enabled: true }), desc: 'assign channel to bus' },
  { match: /(?:remove|unassign)\s+(?:channel|ch)\s*(\d+)\s+(?:from\s+)?(?:bus|mix)\s*(\d+)/i, command: 'mixer.assignToBus', extract: m => ({ channel: parseInt(m[1]), bus: parseInt(m[2]), enabled: false }), desc: 'remove channel from bus' },

  // Mixer — mute group (deactivate BEFORE activate)
  { match: /(?:deactivate|disable)\s+mute\s+group\s*(\d+)/i, command: 'mixer.deactivateMuteGroup', extract: m => ({ group: parseInt(m[1]) }), desc: 'deactivate mute group' },
  { match: /(?:activate|enable)\s+mute\s+group\s*(\d+)/i, command: 'mixer.activateMuteGroup', extract: m => ({ group: parseInt(m[1]) }), desc: 'activate mute group' },

  // Mixer — channel color
  { match: /(?:set\s+)?(?:channel|ch)\s*(\d+)\s+colou?r\s+(?:to\s+)?(\w+)/i, command: 'mixer.setChannelColor', extract: m => ({ channel: parseInt(m[1]), color: m[2].toLowerCase() }), desc: 'set channel color' },
  { match: /colou?r\s+(?:channel|ch)\s*(\d+)\s+(\w+)/i, command: 'mixer.setChannelColor', extract: m => ({ channel: parseInt(m[1]), color: m[2].toLowerCase() }), desc: null },

  // Mixer — clear solos
  { match: /clear\s+solos?/i, command: 'mixer.clearSolos', extract: () => ({}), desc: 'clear solos' },

  // Mixer — compressor / gate / EQ enable/disable
  { match: /(?:enable|turn\s+on)\s+(?:compressor|comp|dynamics)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setCompressor', extract: m => ({ channel: parseInt(m[1]), enabled: true }), desc: 'enable compressor' },
  { match: /(?:disable|turn\s+off)\s+(?:compressor|comp|dynamics)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setCompressor', extract: m => ({ channel: parseInt(m[1]), enabled: false }), desc: 'disable compressor' },
  { match: /(?:enable|turn\s+on)\s+(?:gate|noise\s*gate)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setGate', extract: m => ({ channel: parseInt(m[1]), enabled: true }), desc: 'enable gate' },
  { match: /(?:disable|turn\s+off)\s+(?:gate|noise\s*gate)\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setGate', extract: m => ({ channel: parseInt(m[1]), enabled: false }), desc: 'disable gate' },
  { match: /(?:enable|turn\s+on)\s+eq\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setEq', extract: m => ({ channel: parseInt(m[1]), enabled: true }), desc: 'enable EQ' },
  { match: /(?:disable|turn\s+off)\s+eq\s+(?:on\s+)?(?:channel|ch)\s*(\d+)/i, command: 'mixer.setEq', extract: m => ({ channel: parseInt(m[1]), enabled: false }), desc: 'disable EQ' },

  // Resolume
  { match: /(?:resolume\s+)?(?:trigger|go\s+to)\s+column\s*(\d+)/i, command: 'resolume.triggerColumn', extract: m => ({ column: parseInt(m[1]) }), desc: 'trigger resolume column' },
  { match: /(?:resolume\s+)?(?:trigger|go\s+to)\s+column\s+["""]?(.+?)["""]?\s*$/i, command: 'resolume.triggerColumn', extract: m => ({ name: m[1].trim() }), desc: 'trigger resolume column by name' },
  { match: /(?:resolume\s+)?play\s+clip\s+["""]?(.+?)["""]?\s*$/i, command: 'resolume.playClip', extract: m => ({ name: m[1].trim() }), desc: 'play resolume clip by name' },
  { match: /(?:clear|blackout)\s+(?:resolume|led|wall)/i, command: 'resolume.clearAll', extract: () => ({}), desc: 'clear resolume output' },
  { match: /(?:set\s+)?(?:resolume\s+)?bpm\s*(\d+)/i, command: 'resolume.setBpm', extract: m => ({ bpm: parseInt(m[1]) }), desc: 'set resolume bpm' },

  // Preview
  { match: /(?:show\s+me|preview|what\s+does\s+.+\s+look\s+like|screenshot|snap(?:shot)?|what'?s?\s+(?:on\s+(?:screen|camera)|live))/i, command: 'preview.snap', extract: () => ({}), desc: 'show me what\'s on screen' },

  // System
  { match: /(?:pre[- ]?service|run)\s+(?:check|checklist)/i, command: 'system.preServiceCheck', extract: () => ({}), desc: 'pre-service check' },
  { match: /^(?:status|how'?s?\s+(?:it|everything|things?)\s+(?:looking|doing|going)|check|what'?s?\s+up)\s*\??$/i, command: 'status', extract: () => ({}), desc: 'status' },
];

function parseCommand(text) {
  const trimmed = text.trim();
  if (!trimmed) return null;
  for (const pattern of patterns) {
    const match = trimmed.match(pattern.match);
    if (match) {
      const params = pattern.extract(match);
      if (pattern.command === 'hyperdeck.action') {
        const action = String(params.action || '').toLowerCase();
        const actionMap = {
          play: 'hyperdeck.play',
          stop: 'hyperdeck.stop',
          record: 'hyperdeck.record',
          next: 'hyperdeck.nextClip',
          prev: 'hyperdeck.prevClip',
          previous: 'hyperdeck.prevClip',
        };
        const mapped = actionMap[action];
        if (mapped) return { command: mapped, params: { hyperdeck: params.hyperdeck || 0 } };
      }
      return { command: pattern.command, params };
    }
  }
  return null;
}

// ─── HELP MESSAGE ───────────────────────────────────────────────────────────

function getHelpText(brandName = 'Tally') {
  return `🎛️ *${brandName} Commands*

*ATEM*
• cut to camera 2
• camera 3 to preview
• fade to black
• start / stop recording
• rename camera 4 to "Fog GFX"
• auto transition
• run macro 3
• set aux 1 to camera 4
• dsk 1 on

*OBS*
• start / stop stream
• switch to scene \\[name\\]

*Encoder*
• start / stop encoder stream
• start / stop encoder recording
• start / stop encoders
• encoder status

*HyperDeck*
• hyperdeck 1 play
• hyperdeck 1 record
• hyperdeck 1 next

*Camera Control*
• cam 1 iris 80%
• cam 1 auto iris
• cam 2 gain 12
• cam 1 iso 800
• cam 1 wb 5600
• cam 1 auto wb
• cam 1 shutter 180
• cam 1 auto focus
• cam 1 reset color

*PTZ*
• ptz 1 preset 3
• ptz 1 home
• ptz 1 pan left
• ptz 1 tilt up
• ptz 1 zoom in
• ptz 1 stop

*Companion*
• press "button name"
• play the "video name"

*Video Hub*
• route camera 2 to monitor 3
• show routing
• what's on monitor 1?
• rename input 3 to "Stage Cam"

*Mixer*
• mute channel 4
• unmute master
• channel 1 fader to 70%
• recall scene 2

*ProPresenter*
• next slide / advance
• previous slide / go back
• current slide / what's on screen?
• go to slide 3
• playlist / what's loaded?
• clear all — blank all layers
• clear slide — blank slide layer only
• stage message \\[name\\] — show stage message
• clear message — hide stage messages
• looks — list available looks
• set look \\[name\\] — switch look
• timers — list timers
• start timer \\[name\\] / stop timer \\[name\\]

*Dante*
• load dante scene \\[name\\] — trigger Companion button 'Dante: \\[name\\]'

*Chat*
• msg \\[text\\] — send message to your team

*Support*
• /diagnose \\[category\\] — run quick diagnostics
• /support — list your latest support tickets
• /support \\[summary\\] — open support ticket

*Status*
• status — system overview
• show me what's on screen — live preview
• pre-service check

Powered by ${brandName}`;
}

// Backward-compat constant
const HELP_TEXT = getHelpText('Tally');

function getGuestHelpText(brandName = 'Tally') {
  return `🎛️ *${brandName} — Guest Commands*

You have limited guest access. Available commands:

*Status*
• status — system overview
• pre-service check

*ATEM*
• cut to camera 2
• camera 3 to preview
• fade to black
• auto transition

*OBS*
• start / stop stream
• switch to scene \\[name\\]

*PTZ*
• ptz 1 preset 3
• ptz 1 home

*Utility*
• /status — quick health check
• /help — show this message

_Contact your church administrator to upgrade to full access._
Powered by ${brandName}`;
}

function getAdminHelpText(brandName = 'Tally') {
  return `🔧 *${brandName} Admin Commands*

*Church Targeting*
• at \\[Church Name\\]: \\[command\\] — send command to any church
• msg \\[Church Name\\]  \\[message\\] — post to church chat

*Guest Access*
• guest \\[church name\\] — generate guest token
• revoke guest \\[GUEST-TOKEN\\] — revoke a guest token
• list guests — show active guest tokens

*On-Call Rotation*
• set oncall \\[church\\] \\[TD name\\] — change on-call TD
• list tds \\[church\\] — list TDs for a church

*Planning Center*
• sync planning center \\[church name\\] — pull schedule from PC

*All standard TD commands also work for admin.*
Type \`help td\` for the full TD command reference.

Powered by ${brandName}`;
}

// ─── RISKY COMMAND TYPES ─────────────────────────────────────────────────────
// Commands that require inline-keyboard confirmation before execution
const RISKY_COMMANDS = new Set([
  'stop_stream', 'stop_recording', 'fade_to_black', 'mute_all', 'restart_encoder',
]);

// Map actual command strings to risky command types
const RISKY_COMMAND_MAP = {
  'obs.stopStream':        'stop_stream',
  'vmix.stopStream':       'stop_stream',
  'encoder.stopStream':    'stop_stream',
  'obs.stopRecording':     'stop_recording',
  'atem.stopRecording':    'stop_recording',
  'vmix.stopRecording':    'stop_recording',
  'encoder.stopRecording': 'stop_recording',
  'atem.fadeToBlack':      'fade_to_black',
  'mixer.activateMuteGroup': 'mute_all',
  'encoder.restart':       'restart_encoder',
};

// Human-readable labels for risky actions
const RISKY_LABELS = {
  stop_stream:      'Stop stream',
  stop_recording:   'Stop recording',
  fade_to_black:    'Fade to black',
  mute_all:         'Mute all',
  restart_encoder:  'Restart encoder',
};

// ─── TELEGRAM BOT CLASS ─────────────────────────────────────────────────────

class TallyBot {
  /**
   * @param {object} opts
   * @param {string} opts.botToken     - Telegram bot token
   * @param {string} opts.adminChatId  - Andrew's Telegram chat ID
   * @param {object} opts.db           - better-sqlite3 instance
   * @param {object} opts.relay        - { churches }
   * @param {object} [opts.onCallRotation]  - OnCallRotation instance (optional)
   * @param {object} [opts.guestTdMode]     - GuestTdMode instance (optional)
   * @param {object} [opts.preServiceCheck] - PreServiceCheck instance (optional)
   * @param {object} [opts.resellerSystem]  - ResellerSystem instance for white-labeling (optional)
   */
  constructor({ botToken, adminChatId, db, relay, onCallRotation, guestTdMode, preServiceCheck, presetLibrary, planningCenter, resellerSystem, autoPilot, chatEngine, scheduler, signalFailover }) {
    this.token = botToken;
    this.adminChatId = adminChatId;
    this.db = db;
    this.relay = relay;
    this.onCallRotation  = onCallRotation  || null;
    this.guestTdMode     = guestTdMode     || null;
    this.preServiceCheck = preServiceCheck || null;
    this.presetLibrary   = presetLibrary   || null;
    this.planningCenter  = planningCenter  || null;
    this.resellerSystem  = resellerSystem  || null;
    this.autoPilot       = autoPilot       || null;
    this.chatEngine      = chatEngine      || null;
    this.scheduler       = scheduler       || null;
    this.signalFailover  = signalFailover  || null;
    this._apiBase = `https://api.telegram.org/bot${botToken}`;

    // Ensure church_tds table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS church_tds (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        church_id TEXT NOT NULL,
        telegram_user_id TEXT NOT NULL,
        telegram_chat_id TEXT NOT NULL,
        name TEXT NOT NULL,
        registered_at TEXT NOT NULL,
        active INTEGER DEFAULT 1,
        UNIQUE(telegram_user_id)
      )
    `);

    // Ensure registration_code column on churches
    try {
      this.db.exec(`ALTER TABLE churches ADD COLUMN registration_code TEXT`);
    } catch { /* column already exists */ }

    // Generate codes for churches that don't have one
    const churchesWithoutCode = this.db.prepare('SELECT churchId FROM churches WHERE registration_code IS NULL').all();
    for (const c of churchesWithoutCode) {
      const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 chars
      this.db.prepare('UPDATE churches SET registration_code = ? WHERE churchId = ?').run(code, c.churchId);
    }

    // Add access_level column if it doesn't exist (viewer / operator / admin)
    try {
      this.db.exec(`ALTER TABLE church_tds ADD COLUMN access_level TEXT DEFAULT 'operator'`);
    } catch { /* column already exists */ }

    this._stmtFindTD = this.db.prepare('SELECT * FROM church_tds WHERE telegram_user_id = ? AND active = 1');
    this._stmtFindChurchByCode = this.db.prepare('SELECT * FROM churches WHERE registration_code = ?');
    this._stmtRegisterTD = this.db.prepare('INSERT OR REPLACE INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active) VALUES (?, ?, ?, ?, ?, 1)');
    this._stmtListTDs = this.db.prepare('SELECT * FROM church_tds WHERE church_id = ? AND active = 1');
    this._stmtDeactivateTD = this.db.prepare('UPDATE church_tds SET active = 0 WHERE church_id = ? AND telegram_user_id = ?');

    // ─── Stream Guard: pending confirmations for dangerous commands ──────
    // chatId → { command?, params?, steps?, church, expiresAt }
    this._pendingConfirmations = new Map();
    this._confirmCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [chatId, pending] of this._pendingConfirmations) {
        if (now > pending.expiresAt) this._pendingConfirmations.delete(chatId);
      }
    }, 120_000);

    // ─── AI Rundown Builder: pending drafts awaiting confirmation ──────
    // chatId → { church, parsed: { name, service_day, auto_activate, cues }, expiresAt }
    this._pendingRundowns = new Map();

    // ─── Risky action confirmations (inline keyboard) ────────────────
    // confirmationId → { command, params, church, chatId, expiresAt }
    this._riskyConfirmations = new Map();
    this._riskyCleanupTimer = setInterval(() => {
      const now = Date.now();
      for (const [id, pending] of this._riskyConfirmations) {
        if (now > pending.expiresAt) this._riskyConfirmations.delete(id);
      }
    }, 15_000);

    // ─── Command history (per church, in-memory) ─────────────────────
    // churchId → [{ command, text, timestamp }]  (max 50, show last 10)
    this._commandHistory = new Map();
  }

  // ─── WEBHOOK HANDLER ───────────────────────────────────────────────────

  async handleUpdate(update) {
    // ── Handle inline keyboard callback queries (risky action confirm/cancel) ──
    if (update.callback_query) {
      return this._handleCallbackQuery(update.callback_query).catch(err => {
        console.error('[TallyBot] Error processing callback query:', err.message);
      });
    }

    const msg = update.message;
    if (!msg || !msg.text) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Process async — don't block Telegram's webhook timeout
    this._processMessage(userId, chatId, text, msg.from).catch(err => {
      console.error('[TallyBot] Error processing message:', err.message);
      this.sendMessage(chatId, '❌ Something went wrong. Try again.').catch(e => console.error('[TallyBot] Failed to send error reply to', chatId, ':', e.message));
    });
  }

  // ─── WHITE-LABEL BRAND HELPERS ────────────────────────────────────────────

  /**
   * Get the brand name for a church (falls back to "Tally" if no reseller).
   * @param {string|null} churchId
   * @returns {string}
   */
  _getBrandName(churchId) {
    if (!this.resellerSystem || !churchId) return 'Tally';
    try {
      const church = this.db.prepare('SELECT reseller_id FROM churches WHERE churchId = ?').get(churchId);
      if (!church?.reseller_id) return 'Tally';
      const branding = this.resellerSystem.getBranding(church.reseller_id);
      return branding?.brandName || 'Tally';
    } catch { return 'Tally'; }
  }

  /**
   * Get brand name for a user (TD) by looking up their registered church.
   * @param {string} userId - Telegram user ID
   * @returns {string}
   */
  _getBrandNameForUser(userId) {
    try {
      const td = this.db.prepare('SELECT church_id FROM church_tds WHERE telegram_user_id = ? AND active = 1').get(userId);
      return this._getBrandName(td?.church_id || null);
    } catch { return 'Tally'; }
  }

  async _processMessage(userId, chatId, text, from) {
    // 1. /start command — also handles deep links (/start reg_CODE)
    if (text === '/start' || text.startsWith('/start ')) {
      const param = text.slice(6).trim(); // everything after "/start "
      if (param.startsWith('reg_')) {
        // Deep link registration: /start reg_REGISTRATIONCODE
        const code = param.slice(4).toUpperCase();
        return this._handleRegister(userId, chatId, `/register ${code}`, from);
      }
      const brandName = this._getBrandNameForUser(userId);
      const poweredBy = brandName !== 'Tally' ? `\n\n_Powered by Tally_` : '';
      // Detect locale from already-registered church (if user is re-starting)
      let locale = 'en';
      try {
        const td = this.db.prepare('SELECT church_id FROM church_tds WHERE telegram_user_id = ? AND active = 1').get(userId);
        if (td) {
          const ch = this.db.prepare('SELECT locale FROM churches WHERE churchId = ?').get(td.church_id);
          locale = churchLocale(ch);
        }
      } catch {}
      return this.sendMessage(chatId,
        bt('welcome', locale, { brandName, poweredBy }),
        { parse_mode: 'Markdown' }
      );
    }

    // 2. /register CHURCH_CODE or /register GUEST-XXXXXX
    if (text.startsWith('/register')) {
      return this._handleRegister(userId, chatId, text, from);
    }

    // 3. /help — role-aware
    if (text === '/help' || text.toLowerCase() === 'help' || text.toLowerCase() === 'help td') {
      const showFullTd = text.toLowerCase() === 'help td';
      const brandName = this._getBrandNameForUser(userId);

      // Admin sees admin command reference (or TD reference if they ask for it)
      if (chatId === this.adminChatId) {
        const helpMsg = showFullTd ? getHelpText(brandName) : getAdminHelpText(brandName);
        return this.sendMessage(chatId, helpMsg, { parse_mode: 'Markdown' });
      }

      // Registered TD sees full command reference
      const tdRow = this._stmtFindTD.get(userId);
      if (tdRow) {
        return this.sendMessage(chatId, getHelpText(brandName), { parse_mode: 'Markdown' });
      }

      // Guest TD sees limited command reference
      if (this.guestTdMode) {
        const guest = this.guestTdMode.findActiveGuestByChatId(chatId);
        if (guest) {
          return this.sendMessage(chatId, getGuestHelpText(brandName), { parse_mode: 'Markdown' });
        }
      }

      // Unregistered user — show onboarding instructions
      return this.sendMessage(chatId,
        `👋 *Getting started with ${brandName}*\n\nTo use this bot, register with your church code:\n\`/register YOUR_CODE\`\n\nYour church administrator will give you the registration code.`,
        { parse_mode: 'Markdown' }
      );
    }

    // 3b. /menu — quick-access button keyboard
    if (text === '/menu') {
      return this._sendMenuKeyboard(chatId);
    }

    // 3c. /hidemenu — remove persistent keyboard
    if (text === '/hidemenu') {
      return this.sendMessage(chatId, 'Keyboard hidden.', {
        reply_markup: { remove_keyboard: true },
      });
    }

    // 3d. /history — last 10 commands for this user's church
    if (text === '/history') {
      return this._handleHistory(userId, chatId);
    }

    // 3e. /status — quick system health overview for the registered church
    if (text === '/status') {
      const tdRow = this._stmtFindTD.get(userId);
      if (tdRow) {
        const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(tdRow.church_id);
        if (church) return this._sendStatus(church, chatId);
      }
      // Guest TD path
      if (this.guestTdMode) {
        const guest = this.guestTdMode.findActiveGuestByChatId(chatId);
        if (guest) {
          const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(guest.churchId);
          if (church) return this._sendStatus(church, chatId);
        }
      }
      return this.sendMessage(chatId, '❌ You\'re not registered yet. Send /register YOUR_CODE to get started.');
    }

    // 4. /confirmswap — TD confirming an on-call swap
    if (text === '/confirmswap' && this.onCallRotation) {
      return this._handleConfirmSwap(userId, chatId);
    }

    // 4b. Stream guard — check for pending dangerous-command confirmation
    if (this._pendingConfirmations.has(chatId)) {
      const pending = this._pendingConfirmations.get(chatId);
      const lower = text.toLowerCase().trim();

      // Expired?
      if (Date.now() > pending.expiresAt) {
        this._pendingConfirmations.delete(chatId);
        return this.sendMessage(chatId, '⏰ Confirmation timed out — command cancelled. Nothing was changed.');
      }

      // Confirmed
      if (/^(yes|y|yep|yup|confirm|confirmed|do it|proceed|go|go ahead|execute|ok|okay|sure)$/i.test(lower)) {
        this._pendingConfirmations.delete(chatId);
        if (pending.steps) {
          const replies = [];
          for (const step of pending.steps) {
            if (step.command === 'system.wait') {
              const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
              replies.push(`⏳ Waited ${seconds}s`);
              await new Promise((r) => setTimeout(r, seconds * 1000));
              continue;
            }
            const reply = await this._dispatchCommandSilent(pending.church, chatId, step.command, step.params);
            if (reply) replies.push(reply);
          }
          return this.sendMessage(chatId, replies.join('\n') || '✅ Done', { parse_mode: 'Markdown' });
        }
        return this._dispatchCommand(pending.church, chatId, pending.command, pending.params);
      }

      // Cancelled
      if (/^(no|n|cancel|abort|stop|nevermind|never mind|nah)$/i.test(lower)) {
        this._pendingConfirmations.delete(chatId);
        return this.sendMessage(chatId, '✅ Cancelled — nothing was changed.');
      }

      // Unknown reply — re-prompt
      return this.sendMessage(chatId, '↩️ Reply "yes" to confirm or "cancel" to abort.');
    }

    // 5. Check if admin
    if (chatId === this.adminChatId) {
      return this.handleAdminCommand(chatId, text);
    }

    // 6. Check if registered TD
    const td = this._stmtFindTD.get(userId);
    if (td) {
      const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(td.church_id);
      if (church) {
        const accessLevel = td.access_level || 'operator';
        return this.handleTDCommand(church, chatId, text, { accessLevel });
      }
    }

    // 7. Check if guest TD
    if (this.guestTdMode) {
      const guest = this.guestTdMode.findActiveGuestByChatId(chatId);
      if (guest) {
        const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(guest.churchId);
        if (church) {
          return this.handleTDCommand(church, chatId, text, { accessLevel: 'operator', guestRow: guest });
        }
      }
    }

    // 8. Unknown user
    return this.sendMessage(chatId,
      "You're not registered with Tally. Contact your church administrator for a registration code, then use `/register YOUR_CODE`.",
      { parse_mode: 'Markdown' }
    );
  }

  // ─── REGISTRATION ─────────────────────────────────────────────────────

  async _handleRegister(userId, chatId, text, from) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      return this.sendMessage(chatId, 'Usage: `/register YOUR_CODE`\nYour church admin will give you the 6-character code or a GUEST token.', { parse_mode: 'Markdown' });
    }

    const code = parts[1].trim().toUpperCase();

    // Check if this is a guest token (starts with "GUEST-")
    if (code.startsWith('GUEST-') && this.guestTdMode) {
      const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Guest';
      const result = this.guestTdMode.registerGuest(code, chatId, name);

      if (!result.success) {
        return this.sendMessage(chatId, `❌ ${result.message}`);
      }

      const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(result.churchId);
      if (!church) {
        return this.sendMessage(chatId, '❌ Church not found for this token.');
      }

      console.log(`[TallyBot] Guest registered: ${name} → ${church.name} (token: ${code.slice(0, 4)}****)`);
      return this.sendMessage(chatId,
        `✅ Welcome, *${name}*!\n\nYou have *guest access* for *${church.name}*.\n\n${result.message}\n\nType \`help\` for commands or \`my access\` to check how much time you have left.`,
        { parse_mode: 'Markdown' }
      );
    }

    // Regular church registration code (6-char hex)
    const church = this._stmtFindChurchByCode.get(code);
    if (!church) {
      // Try to detect locale from the code pattern (not possible without church) — use 'en'
      return this.sendMessage(chatId, bt('register.invalid_code', 'en'));
    }

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
    this._stmtRegisterTD.run(church.churchId, userId, chatId, name, new Date().toISOString());

    // Also add to td_contacts for on-call rotation if available
    if (this.onCallRotation) {
      this.onCallRotation.addOrUpdateTD({
        churchId: church.churchId,
        name,
        telegramChatId: chatId,
        telegramUserId: userId,
        isPrimary: 0,
      });
    }

    console.log(`[TallyBot] TD registered: ${name} → ${church.name}`);

    // Onboarding milestone: Telegram TD registration covers steps 2 (notifications) and 4 (invite team)
    try {
      const onbRow = this.db.prepare('SELECT onboarding_telegram_registered_at, onboarding_team_invited_at FROM churches WHERE churchId = ?').get(church.churchId);
      const now = new Date().toISOString();
      if (onbRow && !onbRow.onboarding_telegram_registered_at) {
        this.db.prepare('UPDATE churches SET onboarding_telegram_registered_at = ? WHERE churchId = ?').run(now, church.churchId);
        console.log(`[onboarding] First Telegram TD registered for "${church.name}"`);
      }
      // "Invite your team" step: mark done when any TD registers (they've shared the code and someone joined)
      if (onbRow && !onbRow.onboarding_team_invited_at) {
        this.db.prepare('UPDATE churches SET onboarding_team_invited_at = ? WHERE churchId = ?').run(now, church.churchId);
        console.log(`[onboarding] Team invite milestone reached for "${church.name}"`);
      }
    } catch (e) {
      console.error(`[onboarding] Telegram milestone error: ${e.message}`);
    }

    const brandName = this._getBrandName(church.churchId);
    const poweredBy = brandName !== 'Tally' ? ` — _Powered by Tally_` : '';
    const locale = churchLocale(church);
    return this.sendMessage(chatId,
      bt('welcome.registered', locale, { brandName, poweredBy, name, church: church.name }),
      { parse_mode: 'Markdown' }
    );
  }

  // ─── CONFIRM SWAP ─────────────────────────────────────────────────────────

  async _handleConfirmSwap(userId, chatId) {
    if (!this.onCallRotation) {
      return this.sendMessage(chatId, '❌ On-call rotation is not configured.');
    }

    const swap = this.onCallRotation.findPendingSwapForTarget(chatId);
    if (!swap) {
      return this.sendMessage(chatId, '❌ No pending swap request found for you.');
    }

    const result = this.onCallRotation.confirmSwap(swap.swapKey);
    if (!result.success) {
      return this.sendMessage(chatId, `❌ ${result.message}`);
    }

    await this.sendMessage(chatId,
      `✅ Swap confirmed! You are now on-call for *${swap.churchId}* starting ${result.sundayStr}.`,
      { parse_mode: 'Markdown' }
    );

    // Notify the requester too
    if (swap.requester.telegramChatId) {
      await this.sendMessage(swap.requester.telegramChatId,
        `✅ *${result.target.name}* confirmed the swap — they are now on-call starting ${result.sundayStr}. You're off the hook!`,
        { parse_mode: 'Markdown' }
      ).catch(e => console.error('[TallyBot] Swap confirm notify failed for', swap.requester.telegramChatId, ':', e.message));
    }
  }

  // ─── TD COMMAND HANDLER ───────────────────────────────────────────────

  /**
   * @param {object} church
   * @param {string|number} chatId
   * @param {string} text
   * @param {object} [opts]
   * @param {'viewer'|'operator'|'admin'} [opts.accessLevel='operator'] - Access tier
   * @param {object|null} [opts.guestRow=null] - guest_tokens row if caller is a guest TD
   */
  async handleTDCommand(church, chatId, text, { accessLevel = 'operator', guestRow = null } = {}) {
    const ltext = text.trim().toLowerCase();

    // ── Guest: check remaining access time ───────────────────────────────────
    if (guestRow && /^(my\s*access|access\s*info|access|token\s*status)$/i.test(ltext)) {
      const remaining = require('./guestTdMode').GuestTdMode.formatRemainingTime(guestRow.expiresAt);
      const expiresLocal = new Date(guestRow.expiresAt).toLocaleString('en-US', {
        weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit',
      });
      return this.sendMessage(chatId,
        `🎟️ *Guest Access — ${church.name}*\n\n⏳ *${remaining}*\nExpires: ${expiresLocal}\n\nYou have operator-level access to monitor and control ${church.name}.`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── Viewer access level: only status/info commands allowed ───────────────
    if (accessLevel === 'viewer') {
      const VIEWER_WHITELIST = /^(status|help|\?|commands?|fix|event\s+status|my\s+access|access|access\s+info|token\s+status|support|diagnose|scores?|system\s+health|\/(fix|oncall|support|diagnose|eventstatus).*|\/ack_.+|\/recover_.+)$/i;
      if (!VIEWER_WHITELIST.test(ltext)) {
        return this.sendMessage(chatId,
          `🔒 *Viewer access* — you can check status and run diagnostics, but not control equipment.\n\nAsk your church admin to upgrade your access level to *operator* or *admin*.`,
          { parse_mode: 'Markdown' }
        );
      }
    }

    // ── Pending rundown draft handler (save/edit/cancel) ─────────────────
    const pendingRundown = this._pendingRundowns.get(chatId);
    if (pendingRundown && Date.now() < pendingRundown.expiresAt) {
      if (ltext === 'save' || ltext === 'confirm' || ltext === 'yes') {
        return this._saveRundownDraft(church, chatId, pendingRundown);
      }
      if (ltext === 'cancel' || ltext === 'discard' || ltext === 'no') {
        this._pendingRundowns.delete(chatId);
        return this.sendMessage(chatId, '🗑️ Rundown draft discarded.');
      }
      if (ltext.startsWith('edit ')) {
        return this._editRundownDraft(church, chatId, pendingRundown, text.slice(5).trim());
      }
      if (ltext === 'auto' || ltext === 'make auto' || ltext === 'auto activate') {
        pendingRundown.parsed.auto_activate = true;
        const preview = formatRundownPreview(pendingRundown.parsed);
        return this.sendMessage(chatId, `✅ Auto-activate enabled.\n\n${preview}`, { parse_mode: 'Markdown' });
      }
    } else if (pendingRundown) {
      // Expired — clean up silently
      this._pendingRundowns.delete(chatId);
    }

    // ── Failover ack/recover commands ─────────────────────────────────────
    const ackMatch = text.match(/^\/ack_([a-f0-9]+)/i);
    if (ackMatch && this.signalFailover) {
      this.signalFailover.onTdAcknowledge(church.churchId);
      return this.sendMessage(chatId,
        `✅ Got it — Tally will stand by and let you handle it.\nWhen you're ready to switch back, reply /recover_${ackMatch[1]}`
      );
    }

    const recoverMatch = text.match(/^\/recover_([a-f0-9]+)/i);
    if (recoverMatch && this.signalFailover) {
      try {
        await this.signalFailover.onTdConfirmRecovery(church.churchId);
        return this.sendMessage(chatId, '✅ Switched back to the main source. You\'re all set.');
      } catch (e) {
        return this.sendMessage(chatId, `❌ Couldn't switch back automatically.\n${e.message}\nYou'll need to do it manually at the booth.`);
      }
    }

    // ── Chat message ─────────────────────────────────────────────────────
    const chatMsgMatch = text.match(/^(?:\/chat|msg)\s+(.+)$/is);
    if (chatMsgMatch && this.chatEngine) {
      const td = this.db.prepare(
        'SELECT name FROM church_tds WHERE church_id = ? AND telegram_chat_id = ? AND active = 1'
      ).get(church.churchId, String(chatId));
      const saved = this.chatEngine.saveMessage({
        churchId: church.churchId,
        senderName: td?.name || 'TD',
        senderRole: 'td',
        source: 'telegram',
        message: chatMsgMatch[1].trim(),
      });
      this.chatEngine.broadcastChat(saved);
      return this.sendMessage(chatId, `💬 Sent to ${church.name} chat.`);
    }

    // event status — show time remaining for event churches
    if (ltext === 'event status' || ltext === '/eventstatus') {
      const dbChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
      if (!dbChurch || dbChurch.church_type !== 'event') {
        return this.sendMessage(chatId, '❌ This church is not registered as an event.');
      }
      if (!dbChurch.event_expires_at) {
        return this.sendMessage(chatId, '🎬 Event monitoring window has ended.');
      }
      const msLeft = new Date(dbChurch.event_expires_at) - Date.now();
      if (msLeft <= 0) {
        return this.sendMessage(chatId, '🎬 Event monitoring window has ended.');
      }
      const totalMinutes = Math.floor(msLeft / 60000);
      const hours   = Math.floor(totalMinutes / 60);
      const minutes = totalMinutes % 60;
      const remaining = hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
      const expiresLocal = new Date(dbChurch.event_expires_at).toLocaleString();
      const label = dbChurch.event_label && dbChurch.event_label !== dbChurch.name
        ? ` (${dbChurch.event_label})`
        : '';
      return this.sendMessage(chatId,
        `🎬 *Event Status — ${dbChurch.name}*${label}\n\n⏱ Time remaining: *${remaining}*\n🕐 Expires: ${expiresLocal}`,
        { parse_mode: 'Markdown' }
      );
    }

    // ── /fix — canned troubleshooting responses ──────────────────────────────
    if (/^\ud83d\udee0\s*Troubleshoot$/i.test(text)) {
      return this.sendMessage(chatId, _formatFixList(), { parse_mode: 'Markdown' });
    }

    const fixMatch = text.match(/^\/fix(?:\s+(.+))?$/i);
    if (fixMatch) {
      const topic = (fixMatch[1] || '').trim().toLowerCase();
      if (!topic || topic === 'list') {
        return this.sendMessage(chatId, _formatFixList(), { parse_mode: 'Markdown' });
      }
      const response = CANNED_RESPONSES[topic];
      if (!response) {
        return this.sendMessage(chatId,
          `❌ Unknown topic: "${topic}"\n\n${_formatFixList()}`,
          { parse_mode: 'Markdown' }
        );
      }
      return this.sendMessage(chatId, `*${response.title}*\n\n${response.text}`, { parse_mode: 'Markdown' });
    }

    // ── Preset commands ─────────────────────────────────────────────────────
    if (this.presetLibrary) {
      if (/^list\s+presets?$/i.test(ltext)) {
        return this._handleListPresets(church, chatId);
      }
      const saveMatch = text.match(/^save\s+preset\s+(.+)$/i);
      if (saveMatch) return this._handleSavePreset(church, chatId, saveMatch[1].trim());

      const recallMatch = text.match(/^(?:load|recall)\s+preset\s+(.+)$/i);
      if (recallMatch) return this._handleRecallPreset(church, chatId, recallMatch[1].trim());

      const delPresetMatch = text.match(/^delete\s+preset\s+(.+)$/i);
      if (delPresetMatch) return this._handleDeletePreset(church, chatId, delPresetMatch[1].trim());
    }

    // ── Slack commands ───────────────────────────────────────────────────────
    const setSlackMatch = text.match(/^set\s+slack\s+(https?:\/\/.+)$/i);
    if (setSlackMatch) return this._handleSetSlack(church, chatId, setSlackMatch[1].trim());
    if (/^remove\s+slack$/i.test(ltext)) return this._handleRemoveSlack(church, chatId);
    if (/^test\s+slack$/i.test(ltext)) return this._handleTestSlack(church, chatId);

    // /oncall — show who is on-call for this church
    if (ltext === '/oncall' || ltext === 'oncall') {
      if (!this.onCallRotation) {
        return this.sendMessage(chatId, '❌ On-call rotation is not configured.');
      }
      const status = this.onCallRotation.formatOnCallStatus(church.churchId, this.db);
      const onCallTd = this.onCallRotation.getOnCallTD(church.churchId);
      return this.sendMessage(chatId,
        `📋 *On-Call TDs — ${church.name}*\n\n${status}`,
        { parse_mode: 'Markdown' }
      );
    }

    // /swap [TD name] — request an on-call swap
    if ((ltext.startsWith('/swap') || ltext.startsWith('swap ')) && this.onCallRotation) {
      const targetName = text.replace(/^\/swap\s*/i, '').replace(/^swap\s+/i, '').trim();
      if (!targetName) {
        return this.sendMessage(chatId, 'Usage: `/swap [TD name]`\nExample: `/swap John`', { parse_mode: 'Markdown' });
      }
      const result = this.onCallRotation.initiateSwap(church.churchId, chatId, targetName);
      if (!result.success) {
        return this.sendMessage(chatId, `❌ ${result.message}`);
      }
      // Notify target
      if (result.target?.telegramChatId) {
        await this.sendMessage(result.target.telegramChatId,
          `🔄 *On-Call Swap Request*\n\n${result.requester.name} wants to swap on-call duty with you for *${church.name}*.\n\nType \`/confirmswap\` to accept.`,
          { parse_mode: 'Markdown' }
        ).catch(e => console.error('[TallyBot] Swap request notify failed for', result.target.telegramChatId, ':', e.message));
      }
      return this.sendMessage(chatId, `✅ ${result.message}`, { parse_mode: 'Markdown' });
    }

    // ── Planning Center commands ───────────────────────────────────────────────
    if (/^(sync\s+planning\s+center|sync\s+schedule)$/i.test(ltext)) {
      return this._handlePCSyncChurch(church, chatId);
    }
    if (/^(show\s+schedule|upcoming\s+services?)$/i.test(ltext)) {
      return this._handlePCShowSchedule(church, chatId);
    }

    // ── Autopilot commands ─────────────────────────────────────────────────
    if (/^pause\s+autopilot$/i.test(ltext) && this.autoPilot) {
      this.autoPilot.pause(church.churchId);
      return this.sendMessage(chatId, `⏸️ Autopilot paused for *${church.name}*. No automation rules will fire until resumed.`, { parse_mode: 'Markdown' });
    }
    if (/^resume\s+autopilot$/i.test(ltext) && this.autoPilot) {
      this.autoPilot.resume(church.churchId);
      return this.sendMessage(chatId, `▶️ Autopilot resumed for *${church.name}*. Automation rules are active.`, { parse_mode: 'Markdown' });
    }
    if (/^autopilot\s+status$/i.test(ltext) && this.autoPilot) {
      const paused = this.autoPilot.isPaused(church.churchId);
      const rules = this.autoPilot.getRules(church.churchId);
      const enabled = rules.filter(r => r.enabled).length;
      return this.sendMessage(chatId,
        `🤖 *Autopilot — ${church.name}*\n\nStatus: ${paused ? '⏸️ Paused' : '▶️ Active'}\nRules: ${enabled} enabled / ${rules.length} total\n\nCommands:\n• \`pause autopilot\`\n• \`resume autopilot\``,
        { parse_mode: 'Markdown' }
      );
    }

    // ── Rundown Scheduler commands ──────────────────────────────────────────
    if (this.scheduler) {
      // "start rundown [name]" — fuzzy-match activate
      const startRundownMatch = text.match(/^(?:start|activate)\s+rundown\s+(.+)$/i);
      if (startRundownMatch) {
        return this._handleStartRundown(church, chatId, startRundownMatch[1].trim());
      }

      // "next cue" / "go" — fire current + advance
      if (/^(?:next\s+cue|go|advance)$/i.test(ltext)) {
        const result = await this.scheduler.advance(church.churchId);
        if (result?.error) return this.sendMessage(chatId, `❌ ${result.error}`);
        if (!result) return this.sendMessage(chatId, '❌ Could not advance cue.');
        return this.sendMessage(chatId, `▶️ Fired cue ${result.cueIndex + 1}: *${result.label}*`, { parse_mode: 'Markdown' });
      }

      // "skip cue" / "skip"
      if (/^(?:skip\s+cue|skip)$/i.test(ltext)) {
        const result = this.scheduler.skip(church.churchId);
        if (result.error) return this.sendMessage(chatId, `❌ ${result.error}`);
        return this.sendMessage(chatId, `⏭️ Skipped cue ${result.cueIndex + 1}: *${result.label}*`, { parse_mode: 'Markdown' });
      }

      // "back" / "prev cue"
      if (/^(?:back|prev\s+cue|previous\s+cue)$/i.test(ltext)) {
        const result = this.scheduler.goBack(church.churchId);
        if (result.error) return this.sendMessage(chatId, `❌ ${result.error}`);
        return this.sendMessage(chatId, `⏮️ Back to cue ${result.cueIndex + 1}: *${result.label}*`, { parse_mode: 'Markdown' });
      }

      // "cue 5" / "go to cue 5"
      const jumpCueMatch = text.match(/^(?:cue|go\s+to\s+cue)\s+(\d+)$/i);
      if (jumpCueMatch) {
        const idx = parseInt(jumpCueMatch[1]) - 1; // 1-indexed for user, 0-indexed internal
        const result = this.scheduler.jumpToCue(church.churchId, idx);
        if (result.error) return this.sendMessage(chatId, `❌ ${result.error}`);
        return this.sendMessage(chatId, `🎯 Jumped to cue ${result.cueIndex + 1}: *${result.label}*`, { parse_mode: 'Markdown' });
      }

      // "rundown status" / "rundown"
      if (/^(?:rundown\s+status|rundown|cue\s+status)$/i.test(ltext)) {
        return this._handleRundownStatus(church, chatId);
      }

      // "pause rundown"
      if (/^pause\s+rundown$/i.test(ltext)) {
        this.scheduler.pause(church.churchId);
        return this.sendMessage(chatId, `⏸️ Rundown paused for *${church.name}*. Auto-triggers are stopped.`, { parse_mode: 'Markdown' });
      }

      // "resume rundown"
      if (/^resume\s+rundown$/i.test(ltext)) {
        const result = this.scheduler.resume(church.churchId);
        if (result.error) return this.sendMessage(chatId, `❌ ${result.error}`);
        return this.sendMessage(chatId, `▶️ Rundown resumed for *${church.name}*.`, { parse_mode: 'Markdown' });
      }

      // "end rundown"
      if (/^(?:end|stop|deactivate)\s+rundown$/i.test(ltext)) {
        this.scheduler.deactivate(church.churchId);
        return this.sendMessage(chatId, `🛑 Rundown ended for *${church.name}*.`, { parse_mode: 'Markdown' });
      }

      // ── AI Rundown Builder — "create rundown ..." / "set up a rundown for ..." ──
      const createRundownMatch = text.match(
        /^(?:create|set\s*up|build|make|design|plan)\s+(?:a\s+)?(?:new\s+)?rundown\b(.*)$/i
      );
      if (createRundownMatch) {
        return this._handleCreateRundownAI(church, chatId, text);
      }

      // Also catch "rundown for Sunday morning" without a verb prefix
      const rundownForMatch = text.match(/^rundown\s+for\s+(.+)$/i);
      if (rundownForMatch) {
        return this._handleCreateRundownAI(church, chatId, text);
      }
    }

    // ── Support commands ───────────────────────────────────────────────────
    if (ltext === '/support' || ltext === 'support') {
      return this._handleSupportOverview(church, chatId);
    }
    const supportCreateMatch = text.match(/^\/support\s+(.+)$/i) || text.match(/^support\s+(.+)$/i);
    if (supportCreateMatch) {
      return this._handleSupportCreate(church, chatId, supportCreateMatch[1].trim());
    }
    const diagnoseMatch = text.match(/^\/diagnose(?:\s+(.+))?$/i) || text.match(/^diagnose(?:\s+(.+))?$/i);
    if (diagnoseMatch) {
      return this._handleDiagnose(church, chatId, diagnoseMatch[1] || 'other');
    }

    // ── Fast path: regex parser ──────────────────────────────────────────────
    const parsed = parseCommand(text);
    const churchRuntime = this.relay.churches.get(church.churchId);
    const liveStatus = churchRuntime?.status || {};
    const forceBypassed = hasForceBypass(text);

    if (parsed) {
      // Risky action: require inline-keyboard confirmation
      const riskyType = this._getRiskyType(parsed.command);
      if (riskyType && !forceBypassed) {
        return this._sendRiskyConfirmation(chatId, church, parsed.command, parsed.params, riskyType);
      }
      // Stream guard: warn if dangerous while live
      if (!forceBypassed) {
        const safety = checkStreamSafety(parsed.command, parsed.params, liveStatus);
        if (safety) {
          this._pendingConfirmations.set(chatId, { command: parsed.command, params: parsed.params, church, expiresAt: Date.now() + 60_000 });
          return this.sendMessage(chatId, safety.warning);
        }
      }
      this._recordCommand(church.churchId, parsed.command, parsed.params);
      return this._dispatchCommand(church, chatId, parsed.command, parsed.params);
    }

    // ── Smart parser: device-aware routing (no AI needed) ───────────────────
    const smartResult = smartParse(text, liveStatus);

    if (smartResult) {
      if (smartResult.type === 'command') {
        const smartRiskyType = this._getRiskyType(smartResult.command);
        if (smartRiskyType && !forceBypassed) {
          return this._sendRiskyConfirmation(chatId, church, smartResult.command, smartResult.params, smartRiskyType);
        }
        if (!forceBypassed) {
          const safety = checkStreamSafety(smartResult.command, smartResult.params, liveStatus);
          if (safety) {
            this._pendingConfirmations.set(chatId, { command: smartResult.command, params: smartResult.params, church, expiresAt: Date.now() + 60_000 });
            return this.sendMessage(chatId, safety.warning);
          }
        }
        this._recordCommand(church.churchId, smartResult.command, smartResult.params);
        return this._dispatchCommand(church, chatId, smartResult.command, smartResult.params);
      }
      if (smartResult.type === 'commands' && Array.isArray(smartResult.steps) && smartResult.steps.length > 0) {
        if (!forceBypassed) {
          const wfSafety = checkWorkflowSafety(smartResult.steps, liveStatus);
          if (wfSafety) {
            this._pendingConfirmations.set(chatId, { steps: smartResult.steps, church, expiresAt: Date.now() + 60_000 });
            return this.sendMessage(chatId, wfSafety.warning);
          }
        }
        const replies = [];
        for (const step of smartResult.steps) {
          if (step.command === 'system.wait') {
            const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
            replies.push(`⏳ Waited ${seconds}s`);
            await new Promise((r) => setTimeout(r, seconds * 1000));
            continue;
          }
          const reply = await this._dispatchCommandSilent(church, chatId, step.command, step.params);
          if (reply) replies.push(reply);
        }
        return this.sendMessage(chatId, replies.join('\n') || '✅ Done', { parse_mode: 'Markdown' });
      }
      if (smartResult.type === 'chat') {
        return this.sendMessage(chatId, smartResult.text);
      }
    }

    // ── Custom macros: /macroname — check church DB before AI fallback ─────────
    // List macros
    if (text === '/macros') {
      const locale = churchLocale(church);
      try {
        const macros = this.db.prepare('SELECT name, description FROM church_macros WHERE church_id = ? ORDER BY name ASC').all(church.churchId);
        if (!macros.length) return this.sendMessage(chatId, bt('macro.list.empty', locale), { parse_mode: 'Markdown' });
        const list = macros.map(m => `• \`/${m.name}\` — ${m.description || 'no description'}`).join('\n');
        return this.sendMessage(chatId, bt('macro.list.header', locale) + list, { parse_mode: 'Markdown' });
      } catch { /* fall through */ }
    }

    // Run macro by name (/command with no args — look up in macros table)
    if (text.startsWith('/')) {
      const macroName = text.slice(1).split(/\s+/)[0].toLowerCase();
      if (macroName && /^[a-z0-9_]+$/.test(macroName)) {
        try {
          const macro = this.db.prepare('SELECT * FROM church_macros WHERE church_id = ? AND name = ?').get(church.churchId, macroName);
          if (macro) {
            const steps = (() => { try { return JSON.parse(macro.steps || '[]'); } catch { return []; } })();
            const locale = churchLocale(church);
            await this.sendMessage(chatId, bt('macro.running', locale, { name: macroName }), { parse_mode: 'Markdown' });

            // Execute each step by re-processing as a command
            for (const step of steps) {
              if (!step.trim()) continue;
              try {
                const stepParsed = parseCommand(step);
                if (stepParsed) {
                  await this._dispatchCommand(church, chatId, stepParsed.command, stepParsed.params);
                }
              } catch (stepErr) {
                console.warn(`[TallyBot] Macro step error (${macroName}): ${stepErr.message}`);
              }
              // 1 second delay between steps to avoid overwhelming devices
              await new Promise(resolve => setTimeout(resolve, 1000));
            }

            return this.sendMessage(chatId, bt('macro.done', locale, { name: macroName }), { parse_mode: 'Markdown' });
          }
        } catch (e) {
          console.warn(`[TallyBot] Macro lookup error: ${e.message}`);
        }
      }
    }

    // ── Intent classification: route diagnostics to Sonnet, commands to Haiku ──
    const classification = classifyIntent(text);

    // Diagnostic intent → Sonnet (deep reasoning with full context)
    if (classification.intent === 'diagnostic' && this.relay?.callDiagnosticAI) {
      const reply = await this.relay.callDiagnosticAI(church.churchId, text);
      return this.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
    }

    // ── AI fallback: Anthropic parser (Haiku — lean command context) ─────────
    const ctx = {
      churchId: church.churchId,
      churchName: church.name,
      status: liveStatus,
      tier: church.billing_tier || 'connect',
    };
    const conversationHistory = this.chatEngine?.getRecentConversation(church.churchId) || [];

    const aiResult = await aiParseCommand(text, ctx, conversationHistory);

    // Single command
    if (aiResult.type === 'command') {
      const aiRiskyType = this._getRiskyType(aiResult.command);
      if (aiRiskyType && !forceBypassed) {
        return this._sendRiskyConfirmation(chatId, church, aiResult.command, aiResult.params, aiRiskyType);
      }
      if (!forceBypassed) {
        const safety = checkStreamSafety(aiResult.command, aiResult.params, liveStatus);
        if (safety) {
          this._pendingConfirmations.set(chatId, { command: aiResult.command, params: aiResult.params, church, expiresAt: Date.now() + 60_000 });
          return this.sendMessage(chatId, safety.warning);
        }
      }
      this._recordCommand(church.churchId, aiResult.command, aiResult.params);
      return this._dispatchCommand(church, chatId, aiResult.command, aiResult.params);
    }

    // Multi-step commands — execute sequentially
    if (aiResult.type === 'commands' && Array.isArray(aiResult.steps) && aiResult.steps.length > 0) {
      if (!forceBypassed) {
        const wfSafety = checkWorkflowSafety(aiResult.steps, liveStatus);
        if (wfSafety) {
          this._pendingConfirmations.set(chatId, { steps: aiResult.steps, church, expiresAt: Date.now() + 60_000 });
          return this.sendMessage(chatId, wfSafety.warning);
        }
      }
      const replies = [];
      for (const step of aiResult.steps) {
        // Handle system.wait pseudo-command
        if (step.command === 'system.wait') {
          const seconds = Math.min(Math.max(Number(step.params?.seconds) || 1, 0.5), 30);
          replies.push(`⏳ Waited ${seconds}s`);
          await new Promise((r) => setTimeout(r, seconds * 1000));
          continue;
        }
        const reply = await this._dispatchCommandSilent(church, chatId, step.command, step.params);
        if (reply) replies.push(reply);
      }
      const summary = replies.join('\n');
      return this.sendMessage(chatId, summary || '✅ Done', { parse_mode: 'Markdown' });
    }

    // Conversational reply from AI
    if (aiResult.type === 'chat') {
      // Ambiguous intent: Haiku couldn't resolve a command — escalate to Sonnet
      if (classification.intent === 'ambiguous' && this.relay?.callDiagnosticAI) {
        const reply = await this.relay.callDiagnosticAI(church.churchId, text);
        return this.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
      }
      return this.sendMessage(chatId, aiResult.text);
    }

    // AI unavailable or parse failed — fall back to help nudge
    return this.sendMessage(chatId, "I didn't understand that. Try `help` for a list of commands.", { parse_mode: 'Markdown' });
  }

  // ─── ADMIN COMMAND HANDLER ────────────────────────────────────────────

  async handleAdminCommand(chatId, text) {
    const ltext = text.trim().toLowerCase();

    // ── Chat message from admin ──────────────────────────────────────────────
    const adminChatMatch = text.match(/^msg\s+(.+?)\s{2,}(.+)$/is) || text.match(/^msg\s+(\S+)\s+(.+)$/is);
    if (adminChatMatch && this.chatEngine) {
      const churchName = adminChatMatch[1].trim();
      const message = adminChatMatch[2].trim();
      const allChurches = this.db.prepare('SELECT * FROM churches').all();
      const targetChurch = allChurches.find(c =>
        c.name.toLowerCase().includes(churchName.toLowerCase())
      );
      if (!targetChurch) {
        return this.sendMessage(chatId, `❌ Church not found: "${churchName}"`);
      }
      const saved = this.chatEngine.saveMessage({
        churchId: targetChurch.churchId,
        senderName: 'Andrew',
        senderRole: 'admin',
        source: 'telegram',
        message,
      });
      this.chatEngine.broadcastChat(saved);
      return this.sendMessage(chatId, `💬 Sent to ${targetChurch.name} chat.`);
    }

    // ── Guest token commands ─────────────────────────────────────────────────
    if (this.guestTdMode) {
      // guest [church name] → generate guest token
      const guestMatch = text.match(/^guest\s+(.+)$/i);
      if (guestMatch) {
        return this._handleAdminGuestCreate(chatId, guestMatch[1].trim());
      }

      // revoke guest [token]
      const revokeMatch = text.match(/^revoke\s+guest\s+(GUEST-[A-F0-9]+)$/i);
      if (revokeMatch) {
        const result = await this.guestTdMode.revokeAndNotify(revokeMatch[1].toUpperCase());
        return this.sendMessage(chatId, result.revoked
          ? `✅ Guest token \`${result.token}\` revoked. Guest has been notified.`
          : `❌ Token not found.`,
          { parse_mode: 'Markdown' }
        );
      }

      // list guests
      if (ltext === 'list guests') {
        const tokens = this.guestTdMode.listActiveTokens();
        if (!tokens.length) return this.sendMessage(chatId, 'No active guest tokens.');
        const lines = tokens.map(t => {
          const expires = new Date(t.expiresAt).toLocaleString();
          const used = t.usedByChat ? `✅ Used by chat ${t.usedByChat}` : '⏳ Unused';
          return `\`${t.token}\` → ${t.churchId}\n${used} | Expires: ${expires}`;
        });
        return this.sendMessage(chatId, `🎟️ *Active Guest Tokens*\n\n${lines.join('\n\n')}`, { parse_mode: 'Markdown' });
      }
    }

    // ── On-call rotation commands ────────────────────────────────────────────
    if (this.onCallRotation) {
      // set oncall [church] [TD name]
      const setOnCallMatch = text.match(/^set\s+oncall\s+(.+?)\s+(.+)$/i);
      if (setOnCallMatch) {
        return this._handleAdminSetOnCall(chatId, setOnCallMatch[1].trim(), setOnCallMatch[2].trim());
      }

      // list tds [church]
      const listTdsMatch = text.match(/^list\s+tds?\s+(.+)$/i);
      if (listTdsMatch) {
        return this._handleAdminListTDs(chatId, listTdsMatch[1].trim());
      }
    }

    // ── Planning Center admin commands ───────────────────────────────────────
    // sync planning center [church name]
    const pcSyncMatch = text.match(/^sync\s+(?:planning\s+center|schedule)\s+(.+)$/i);
    if (pcSyncMatch && this.planningCenter) {
      const churchName = pcSyncMatch[1].trim();
      const allChurches = this.db.prepare('SELECT * FROM churches').all();
      const pc = allChurches.find(c => c.name.toLowerCase().includes(churchName.toLowerCase()));
      if (!pc) return this.sendMessage(chatId, `❌ Church "${churchName}" not found.`);
      try {
        const result = await this.planningCenter.syncChurch(pc.churchId);
        return this.sendMessage(chatId, `✅ Synced *${result.synced}* service time(s) from Planning Center for *${pc.name}*.`, { parse_mode: 'Markdown' });
      } catch (e) {
        return this.sendMessage(chatId, `❌ Sync failed for ${pc.name}: ${e.message}`);
      }
    }

    // Admin can prefix with "at ChurchName:" to target a church
    const atMatch = text.match(/^(?:at|@)\s+(.+?):\s*(.+)$/i);
    let targetChurch = null;
    let commandText = text;

    if (atMatch) {
      const churchName = atMatch[1].trim();
      commandText = atMatch[2].trim();
      const churches = this.db.prepare('SELECT * FROM churches').all();
      for (const c of churches) {
        if (c.name.toLowerCase().includes(churchName.toLowerCase())) {
          targetChurch = c;
          break;
        }
      }
      if (!targetChurch) {
        return this.sendMessage(chatId, `❌ Church "${churchName}" not found.`);
      }
    }

    // If no church specified and only one exists, auto-select
    if (!targetChurch) {
      const churches = this.db.prepare('SELECT * FROM churches').all();
      if (churches.length === 1) {
        targetChurch = churches[0];
      }
    }

    let parsed = parseCommand(commandText);

    // Smart parser — device-aware routing (no AI needed)
    const adminForceBypassed = hasForceBypass(commandText);
    if (!parsed && targetChurch) {
      const adminChurchRuntime = this.relay.churches.get(targetChurch.churchId);
      const adminLiveStatus = adminChurchRuntime?.status || {};
      const smartResult = smartParse(commandText, adminLiveStatus);
      if (smartResult) {
        if (smartResult.type === 'command') {
          parsed = { command: smartResult.command, params: smartResult.params };
        } else if (smartResult.type === 'commands' && smartResult.steps?.length) {
          if (!adminForceBypassed) {
            const wfSafety = checkWorkflowSafety(smartResult.steps, adminLiveStatus);
            if (wfSafety) {
              this._pendingConfirmations.set(chatId, { steps: smartResult.steps, church: targetChurch, expiresAt: Date.now() + 60_000 });
              return this.sendMessage(chatId, wfSafety.warning);
            }
          }
          const replies = [];
          for (const step of smartResult.steps) {
            const r = await this._dispatchCommandSilent(targetChurch, chatId, step.command, step.params);
            if (r) replies.push(r);
          }
          return this.sendMessage(chatId, replies.join('\n') || '✅ Done', { parse_mode: 'Markdown' });
        } else if (smartResult.type === 'chat') {
          return this.sendMessage(chatId, smartResult.text);
        }
      }
    }

    if (!parsed) {
      // Try AI for admin too — pass church tier so rate limit matches their plan
      const aiResult = await aiParseCommand(commandText, {
        churchId: targetChurch?.churchId,
        churchName: targetChurch?.name,
        tier: targetChurch?.billing_tier || 'managed',
      });
      if (aiResult.type === 'command') {
        parsed = { command: aiResult.command, params: aiResult.params };
      } else if (aiResult.type === 'commands' && aiResult.steps?.length) {
        if (targetChurch) {
          if (!adminForceBypassed) {
            const adminRuntime = this.relay.churches.get(targetChurch.churchId);
            const wfSafety = checkWorkflowSafety(aiResult.steps, adminRuntime?.status || {});
            if (wfSafety) {
              this._pendingConfirmations.set(chatId, { steps: aiResult.steps, church: targetChurch, expiresAt: Date.now() + 60_000 });
              return this.sendMessage(chatId, wfSafety.warning);
            }
          }
          const replies = [];
          for (const step of aiResult.steps) {
            const r = await this._dispatchCommandSilent(targetChurch, chatId, step.command, step.params);
            if (r) replies.push(r);
          }
          return this.sendMessage(chatId, replies.join('\n') || '✅ Done', { parse_mode: 'Markdown' });
        }
      } else if (aiResult.type === 'chat') {
        return this.sendMessage(chatId, aiResult.text);
      } else {
        return this.sendMessage(chatId, "🤔 I didn't understand that. Try `help` for commands.", { parse_mode: 'Markdown' });
      }
    }

    if (parsed.command === 'status' && !targetChurch) {
      // Show all churches status
      const churches = this.db.prepare('SELECT * FROM churches').all();
      const lines = [];
      for (const c of churches) {
        const churchRuntime = this.relay.churches.get(c.churchId);
        const connected = churchRuntime?.ws?.readyState === 1;
        lines.push(`${connected ? '🟢' : '⚫'} *${c.name}*`);
      }
      return this.sendMessage(chatId, lines.join('\n') || 'No churches registered.', { parse_mode: 'Markdown' });
    }

    if (!targetChurch) {
      const churches = this.db.prepare('SELECT * FROM churches').all();
      const names = churches.map(c => `• ${c.name}`).join('\n');
      return this.sendMessage(chatId, `Which church? Use:\n\`at ChurchName: ${commandText}\`\n\n${names}`, { parse_mode: 'Markdown' });
    }

    // Route through same handlers as TD
    return this.handleTDCommand(targetChurch, chatId, commandText);
  }

  // ─── ADMIN HELPER METHODS ────────────────────────────────────────────

  async _handleAdminGuestCreate(chatId, churchName) {
    // Find the church by name (partial match)
    const churches = this.db.prepare('SELECT * FROM churches').all();
    const church = churches.find(c => c.name.toLowerCase().includes(churchName.toLowerCase()));
    if (!church) {
      const names = churches.map(c => `• ${c.name}`).join('\n');
      return this.sendMessage(chatId, `❌ Church "${churchName}" not found.\n\nRegistered churches:\n${names}`);
    }

    const { token, expiresAt, expiresFormatted } = this.guestTdMode.generateToken(church.churchId, church.name);
    return this.sendMessage(chatId,
      `🎟️ *Guest token for ${church.name}* (24h)\n\nShare this with the guest TD:\n\`/register ${token}\`\n\nExpires: ${expiresFormatted}`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleAdminSetOnCall(chatId, churchName, tdName) {
    const churches = this.db.prepare('SELECT * FROM churches').all();
    const church = churches.find(c => c.name.toLowerCase().includes(churchName.toLowerCase()));
    if (!church) {
      return this.sendMessage(chatId, `❌ Church "${churchName}" not found.`);
    }

    const result = this.onCallRotation.setOnCall(church.churchId, tdName);
    return this.sendMessage(chatId,
      result.success ? `✅ ${result.message}` : `❌ ${result.message}`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleAdminListTDs(chatId, churchName) {
    const churches = this.db.prepare('SELECT * FROM churches').all();
    const church = churches.find(c => c.name.toLowerCase().includes(churchName.toLowerCase()));
    if (!church) {
      return this.sendMessage(chatId, `❌ Church "${churchName}" not found.`);
    }

    const status = this.onCallRotation.formatOnCallStatus(church.churchId, this.db);
    return this.sendMessage(chatId,
      `📋 *TDs for ${church.name}*\n\n${status || 'No TDs registered.'}`,
      { parse_mode: 'Markdown' }
    );
  }

  // ─── PLANNING CENTER HANDLERS ─────────────────────────────────────────────

  async _handlePCSyncChurch(church, chatId) {
    if (!this.planningCenter) {
      return this.sendMessage(chatId, '❌ Planning Center integration is not configured on this server.');
    }
    try {
      const result = await this.planningCenter.syncChurch(church.churchId);
      return this.sendMessage(chatId,
        `✅ Synced *${result.synced}* service time(s) from Planning Center for *${church.name}*.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return this.sendMessage(chatId, `❌ Sync failed: ${e.message}`);
    }
  }

  async _handlePCShowSchedule(church, chatId) {
    if (!this.planningCenter) {
      return this.sendMessage(chatId, '❌ Planning Center integration is not configured on this server.');
    }
    try {
      const services = await this.planningCenter.getUpcomingServicesForChurch(church.churchId);
      if (!services.length) {
        return this.sendMessage(chatId, `📅 No upcoming services found in Planning Center for *${church.name}*.`, { parse_mode: 'Markdown' });
      }
      const lines = services.slice(0, 3).map(s => `• ${s.dayName} ${s.startTime} — ${s.title}`);
      return this.sendMessage(chatId,
        `📅 *Upcoming services — ${church.name}*\n\n${lines.join('\n')}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return this.sendMessage(chatId, `❌ Could not fetch from Planning Center: ${e.message}`);
    }
  }

  // ─── PRESET HANDLERS ─────────────────────────────────────────────────────

  // ── Rundown Scheduler helpers ──────────────────────────────────────────────

  async _handleStartRundown(church, chatId, nameQuery) {
    const rundowns = this.scheduler.rundownEngine.getRundowns(church.churchId);
    if (!rundowns.length) {
      return this.sendMessage(chatId, `📋 No rundowns found for *${church.name}*.\nCreate one in the Church Portal.`, { parse_mode: 'Markdown' });
    }

    // Fuzzy match by name (case-insensitive substring)
    const query = nameQuery.toLowerCase();
    const match = rundowns.find(r => r.name.toLowerCase().includes(query));
    if (!match) {
      const names = rundowns.map(r => `• ${r.name}`).join('\n');
      return this.sendMessage(chatId, `❌ No rundown matching "${nameQuery}".\n\nAvailable:\n${names}`, { parse_mode: 'Markdown' });
    }

    const result = this.scheduler.activate(church.churchId, match.id);
    if (result.error) return this.sendMessage(chatId, `❌ ${result.error}`);

    const cues = match.steps || [];
    return this.sendMessage(chatId,
      `📋 *Rundown Started: ${match.name}*\n\n` +
      `Cues: ${cues.length}\n` +
      `Current: ${cues[0]?.label || 'Cue 1'}\n\n` +
      `Commands:\n• \`go\` — fire current cue\n• \`skip\` — skip cue\n• \`back\` — previous cue\n• \`rundown\` — show status\n• \`end rundown\` — stop`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleRundownStatus(church, chatId) {
    const status = this.scheduler.getStatus(church.churchId);
    if (!status.active) {
      return this.sendMessage(chatId, `📋 No active rundown for *${church.name}*.`, { parse_mode: 'Markdown' });
    }

    const stateIcon = status.state === 'running' ? '▶️' : status.state === 'paused' ? '⏸️' : '✅';
    const progressBar = '█'.repeat(Math.floor(status.progress / 10)) + '░'.repeat(10 - Math.floor(status.progress / 10));

    return this.sendMessage(chatId,
      `📋 *Rundown: ${status.rundownName}*\n\n` +
      `${stateIcon} ${status.state.toUpperCase()}\n` +
      `Cue ${status.currentCue + 1}/${status.totalCues}: *${status.currentCueLabel}*\n` +
      (status.currentCueNotes ? `📝 ${status.currentCueNotes}\n` : '') +
      `${status.nextTriggerInfo}\n` +
      `Progress: [${progressBar}] ${status.progress}%` +
      (status.nextCueLabel ? `\n\nNext: ${status.nextCueLabel}` : ''),
      { parse_mode: 'Markdown' }
    );
  }

  async _handleCreateRundownAI(church, chatId, text) {
    // Billing check — scheduler feature required
    const dbChurch = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
    if (dbChurch) {
      const access = this.relay.billing?.checkAccess(dbChurch, 'scheduler');
      if (access && !access.allowed) {
        return this.sendMessage(chatId, `❌ ${access.reason}`);
      }
    }

    await this.sendMessage(chatId, '🤖 Building your rundown…');

    try {
      const churchRuntime = this.relay.churches.get(church.churchId);
      const ctx = {
        churchName: church.name,
        status: churchRuntime?.status || {},
      };

      const parsed = await parseRundownDescription(text, ctx);

      // Store as pending draft for confirmation
      this._pendingRundowns.set(chatId, {
        parsed,
        church,
        expiresAt: Date.now() + 5 * 60_000, // 5 min expiry
      });

      const preview = formatRundownPreview(parsed);
      return this.sendMessage(chatId, preview, { parse_mode: 'Markdown' });
    } catch (e) {
      console.error(`[telegramBot] AI rundown parse error:`, e.message);
      return this.sendMessage(chatId,
        `❌ Could not build rundown: ${e.message}\n\nTry describing it more specifically, e.g.:\n_"Set up a Sunday rundown: start recording at 9:55, go live at 10, cam 1 for worship, cam 2 for sermon"_`,
        { parse_mode: 'Markdown' }
      );
    }
  }

  async _saveRundownDraft(church, chatId, pending) {
    try {
      const { parsed } = pending;

      // Create rundown in DB
      const rundown = this.scheduler.rundownEngine.createRundown(
        church.churchId,
        parsed.name,
        parsed.cues
      );

      // Set scheduler-specific columns (service_day, auto_activate)
      const sets = [];
      const vals = [];
      if (parsed.service_day !== undefined) {
        sets.push('service_day = ?');
        vals.push(parsed.service_day);
      }
      if (parsed.auto_activate) {
        sets.push('auto_activate = ?');
        vals.push(1);
      }
      if (sets.length) {
        vals.push(rundown.id);
        this.scheduler.rundownEngine.db.prepare(
          `UPDATE rundowns SET ${sets.join(', ')} WHERE id = ?`
        ).run(...vals);
      }

      this._pendingRundowns.delete(chatId);

      const { DAY_NAMES } = require('./rundown-ai');
      const dayName = DAY_NAMES[parsed.service_day] || 'Sunday';
      return this.sendMessage(chatId,
        `✅ Rundown *${parsed.name}* saved!\n\n` +
        `📅 ${dayName} • ${parsed.cues.length} cues${parsed.auto_activate ? ' • Auto-start' : ''}\n\n` +
        `Use \`start rundown ${parsed.name}\` to activate it.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error(`[telegramBot] Save rundown draft error:`, e.message);
      return this.sendMessage(chatId, `❌ Failed to save rundown: ${e.message}`);
    }
  }

  async _editRundownDraft(church, chatId, pending, editText) {
    await this.sendMessage(chatId, '🤖 Editing rundown…');

    try {
      const churchRuntime = this.relay.churches.get(church.churchId);
      const ctx = {
        churchName: church.name,
        status: churchRuntime?.status || {},
      };

      const result = await editRundownCues(editText, pending.parsed.cues, ctx);

      // Update the pending draft with new cues
      pending.parsed.cues = result.cues;
      pending.expiresAt = Date.now() + 5 * 60_000; // refresh expiry

      const preview = formatRundownPreview(pending.parsed);
      return this.sendMessage(chatId,
        `✏️ ${result.description}\n\n${preview}`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      console.error(`[telegramBot] AI rundown edit error:`, e.message);
      return this.sendMessage(chatId, `❌ Could not apply edit: ${e.message}\n\nTry again or type \`cancel\` to discard.`);
    }
  }

  async _handleListPresets(church, chatId) {
    const presets = this.presetLibrary.list(church.churchId);
    if (!presets.length) {
      return this.sendMessage(chatId, `📋 No saved presets for *${church.name}*.\n\nUse \`save preset [name]\` to create one.`, { parse_mode: 'Markdown' });
    }
    const lines = presets.map(p => {
      const typeLabel = p.type.replace(/_/g, ' ');
      const updated = new Date(p.updated_at).toLocaleDateString();
      return `• *${p.name}* (${typeLabel}) — ${updated}`;
    });
    return this.sendMessage(chatId,
      `📋 *Presets for ${church.name}*\n\n${lines.join('\n')}\n\nUse \`recall preset [name]\` to restore one.`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleSavePreset(church, chatId, presetName) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return this.sendMessage(chatId, `❌ *${church.name}* is offline — cannot capture current state.`, { parse_mode: 'Markdown' });
    }

    await this.sendMessage(chatId, `⏳ Capturing current equipment state…`);

    const msgId = crypto.randomUUID();
    const resultPromise = this._waitForResult(church.churchId, msgId, 15000);
    churchRuntime.ws.send(JSON.stringify({ type: 'command', command: 'preset.save', params: { name: presetName }, id: msgId }));

    const result = await resultPromise;
    if (result.error) {
      return this.sendMessage(chatId, `❌ Failed to capture state: ${result.error}`);
    }

    const { steps = [], presetType } = result.result || {};
    if (!steps.length) {
      return this.sendMessage(chatId, `⚠️ No connected devices found to save state from.`);
    }

    const type = presetType || (steps.length === 1 ? steps[0].type : 'named_bundle');
    const data = type === 'named_bundle' ? { steps } : steps[0];
    this.presetLibrary.save(church.churchId, presetName, type, data);

    const deviceList = steps.map(s => s.type.replace(/_/g, ' ')).join(', ');
    return this.sendMessage(chatId,
      `✅ Preset *${presetName}* saved!\n\nDevices captured: ${deviceList}`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleRecallPreset(church, chatId, presetName) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return this.sendMessage(chatId, `❌ *${church.name}* is offline.`, { parse_mode: 'Markdown' });
    }

    const preset = this.presetLibrary.get(church.churchId, presetName);
    if (!preset) {
      const presets = this.presetLibrary.list(church.churchId);
      const names = presets.map(p => `• ${p.name}`).join('\n') || '  (none)';
      return this.sendMessage(chatId,
        `❌ Preset *${presetName}* not found.\n\nAvailable presets:\n${names}`,
        { parse_mode: 'Markdown' }
      );
    }

    try {
      const sendCommand = (command, params) => {
        return new Promise((resolve, reject) => {
          const msgId = crypto.randomUUID();
          const handler = (msg) => {
            if (msg.type === 'command_result' && msg.churchId === church.churchId && msg.messageId === msgId) {
              clearTimeout(timer);
              const idx = (this._resultListeners || []).indexOf(handler);
              if (idx !== -1) this._resultListeners.splice(idx, 1);
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.result);
            }
          };
          const timer = setTimeout(() => {
            const idx = (this._resultListeners || []).indexOf(handler);
            if (idx !== -1) this._resultListeners.splice(idx, 1);
            reject(new Error('Command timed out (10s)'));
          }, 10000);
          handler._presetMsgId = msgId;
          if (!this._resultListeners) this._resultListeners = [];
          this._resultListeners.push(handler);
          churchRuntime.ws.send(JSON.stringify({ type: 'command', command, params, id: msgId }));
        });
      };

      await this.presetLibrary.recall(church.churchId, presetName, sendCommand);
      return this.sendMessage(chatId, `✅ Preset *${presetName}* recalled!`, { parse_mode: 'Markdown' });
    } catch (e) {
      return this.sendMessage(chatId, `❌ Recall failed: ${e.message}`);
    }
  }

  async _handleDeletePreset(church, chatId, presetName) {
    const deleted = this.presetLibrary.delete(church.churchId, presetName);
    if (!deleted) {
      return this.sendMessage(chatId, `❌ Preset *${presetName}* not found.`, { parse_mode: 'Markdown' });
    }
    return this.sendMessage(chatId, `🗑️ Preset *${presetName}* deleted.`, { parse_mode: 'Markdown' });
  }

  // ─── SLACK HANDLERS ───────────────────────────────────────────────────────

  async _handleSetSlack(church, chatId, webhookUrl) {
    if (!isValidSlackWebhookUrl(webhookUrl)) {
      return this.sendMessage(
        chatId,
        '❌ Invalid Slack webhook URL. It must be an `https://hooks.slack.com/...` URL.',
        { parse_mode: 'Markdown' }
      );
    }
    try {
      this.db.prepare('UPDATE churches SET slack_webhook_url = ? WHERE churchId = ?')
        .run(webhookUrl, church.churchId);
      return this.sendMessage(chatId,
        `✅ Slack webhook saved for *${church.name}*.\n\nSend \`test slack\` to verify it's working.`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      return this.sendMessage(chatId, `❌ Failed to save Slack config: ${e.message}`);
    }
  }

  async _handleRemoveSlack(church, chatId) {
    this.db.prepare('UPDATE churches SET slack_webhook_url = NULL, slack_channel = NULL WHERE churchId = ?')
      .run(church.churchId);
    return this.sendMessage(chatId, `✅ Slack integration removed for *${church.name}*.`, { parse_mode: 'Markdown' });
  }

  async _handleTestSlack(church, chatId) {
    const row = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(church.churchId);
    if (!row?.slack_webhook_url) {
      return this.sendMessage(chatId,
        `❌ No Slack webhook configured.\n\nUse \`set slack [webhook-url]\` to add one.`,
        { parse_mode: 'Markdown' }
      );
    }

    const time = new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
    const payload = {
      username: 'Tally',
      icon_emoji: ':satellite:',
      channel: row.slack_channel || undefined,
      attachments: [{
        color: '#22c55e',
        title: `✅ Slack Test — ${church.name}`,
        text: `Tally Slack integration is working! Sent at ${time}.`,
        footer: `Tally | ${time}`,
      }],
    };

    try {
      const resp = await fetch(row.slack_webhook_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      if (resp.ok) {
        return this.sendMessage(chatId, `✅ Test message sent to Slack!`);
      } else {
        const body = await resp.text();
        return this.sendMessage(chatId, `❌ Slack rejected the message: ${resp.status} ${body}`);
      }
    } catch (e) {
      return this.sendMessage(chatId, `❌ Failed to reach Slack: ${e.message}`);
    }
  }

  // ─── SUPPORT HANDLERS ───────────────────────────────────────────────────

  _buildSupportDiagnostics(church, issueCategory, severity, summary) {
    const runtime = this.relay.churches.get(church.churchId);
    const sinceIso = new Date(Date.now() - 15 * 60 * 1000).toISOString();
    const recentAlerts = this.db.prepare(`
      SELECT id, alert_type, severity, created_at
      FROM alerts
      WHERE church_id = ? AND created_at >= ?
      ORDER BY datetime(created_at) DESC
      LIMIT 12
    `).all(church.churchId, sinceIso);

    return {
      churchId: church.churchId,
      issueCategory,
      severity,
      summary,
      generatedAt: new Date().toISOString(),
      connection: {
        churchClientConnected: runtime?.ws?.readyState === 1,
        lastSeen: runtime?.lastSeen || null,
        lastHeartbeat: runtime?.lastHeartbeat || null,
      },
      deviceHealth: runtime?.status || {},
      recentAlerts,
    };
  }

  _computeSupportChecks(issueCategory, diagnostics) {
    const checks = [];
    checks.push({
      key: 'church_client_connection',
      ok: diagnostics.connection.churchClientConnected === true,
      note: diagnostics.connection.churchClientConnected ? 'Church client connected' : 'Church client offline',
    });

    const s = diagnostics.deviceHealth || {};
    if (issueCategory === 'stream_down') {
      const ok = isStreamActive(s);
      checks.push({ key: 'stream_state', ok, note: ok ? 'Stream appears active' : 'Stream appears inactive' });
    }
    if (issueCategory === 'atem_connectivity') {
      const ok = s.atem?.connected === true;
      checks.push({ key: 'atem_link', ok, note: ok ? 'ATEM connected' : 'ATEM disconnected' });
    }
    if (issueCategory === 'recording_issue') {
      const ok = isRecordingActive(s);
      checks.push({ key: 'recording_state', ok, note: ok ? 'Recording active' : 'Recording inactive' });
    }
    return checks;
  }

  _normalizeSupportCategory(input) {
    const normalized = String(input || 'other').trim().toLowerCase().replace(/\s+/g, '_');
    const allowed = new Set(['stream_down', 'no_audio_stream', 'slides_issue', 'atem_connectivity', 'recording_issue', 'other']);
    return allowed.has(normalized) ? normalized : 'other';
  }

  async _handleDiagnose(church, chatId, categoryInput) {
    const issueCategory = this._normalizeSupportCategory(categoryInput);
    const diagnostics = this._buildSupportDiagnostics(church, issueCategory, 'P3', '');
    const checks = this._computeSupportChecks(issueCategory, diagnostics);
    const triageResult = checks.some(c => !c.ok) ? 'needs_escalation' : 'monitoring';

    const lines = checks.map(c => `${c.ok ? '✅' : '❌'} ${c.note}`).join('\n');
    const recent = (diagnostics.recentAlerts || []).slice(0, 3).map(a => `• ${a.alert_type} (${a.severity})`).join('\n');
    return this.sendMessage(chatId,
      `🩺 *Diagnostics — ${church.name}*\nCategory: *${issueCategory}*\nResult: *${triageResult}*\n\n${lines}\n\nRecent alerts:\n${recent || '• none'}\n\nUse \`/support [summary]\` to open a ticket.`,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleSupportOverview(church, chatId) {
    const tickets = this.db.prepare(`
      SELECT id, title, status, severity, created_at
      FROM support_tickets
      WHERE church_id = ?
      ORDER BY datetime(updated_at) DESC
      LIMIT 5
    `).all(church.churchId);

    if (!tickets.length) {
      return this.sendMessage(chatId,
        `📨 *Support — ${church.name}*\n\nNo open tickets right now.\n\nCommands:\n• \`/diagnose stream_down\`\n• \`/support Stream dropped before service\``,
        { parse_mode: 'Markdown' }
      );
    }

    const lines = tickets.map(t =>
      `• *${t.severity}* [${t.status}] ${t.title}\n  ${new Date(t.created_at).toLocaleString()}`
    ).join('\n');
    return this.sendMessage(chatId,
      `📨 *Latest Support Tickets — ${church.name}*\n\n${lines}\n\nOpen a new ticket with:\n\`/support [summary]\``,
      { parse_mode: 'Markdown' }
    );
  }

  async _handleSupportCreate(church, chatId, summaryInput) {
    const summary = String(summaryInput || '').trim();
    if (!summary) {
      return this.sendMessage(chatId, 'Usage: `/support [brief summary of the issue]`', { parse_mode: 'Markdown' });
    }

    const issueCategory = 'other';
    const severity = 'P2';
    const diagnostics = this._buildSupportDiagnostics(church, issueCategory, severity, summary);
    const checks = this._computeSupportChecks(issueCategory, diagnostics);
    const triageResult = checks.some(c => !c.ok) ? 'needs_escalation' : 'monitoring';

    const triageId = crypto.randomUUID();
    const ticketId = crypto.randomUUID();
    const nowIso = new Date().toISOString();

    this.db.prepare(`
      INSERT INTO support_triage_runs (
        id, church_id, issue_category, severity, summary, triage_result,
        diagnostics_json, autofix_attempts_json, timezone, app_version, created_by, created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      triageId,
      church.churchId,
      issueCategory,
      severity,
      summary,
      triageResult,
      JSON.stringify({ ...diagnostics, checks }),
      JSON.stringify([]),
      null,
      null,
      `telegram:${chatId}`,
      nowIso
    );

    this.db.prepare(`
      INSERT INTO support_tickets (
        id, church_id, triage_id, issue_category, severity, title, description,
        status, forced_bypass, diagnostics_json, created_by, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 'open', 0, ?, ?, ?, ?)
    `).run(
      ticketId,
      church.churchId,
      triageId,
      issueCategory,
      severity,
      summary.slice(0, 140),
      summary,
      JSON.stringify({ ...diagnostics, checks }),
      `telegram:${chatId}`,
      nowIso,
      nowIso
    );

    this.db.prepare(`
      INSERT INTO support_ticket_updates (ticket_id, message, actor_type, actor_id, created_at)
      VALUES (?, ?, 'church', ?, ?)
    `).run(ticketId, summary, String(chatId), nowIso);

    return this.sendMessage(chatId,
      `✅ Support ticket opened.\n\nTicket ID: \`${ticketId.slice(0, 8)}\`\nTriage: *${triageResult}*\n\nYou can view updates in the Church Portal support tab.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ─── DISPATCH HELPERS ────────────────────────────────────────────────

  /** Route a parsed command to the right handler and reply to chatId. */
  async _dispatchCommand(church, chatId, command, params) {
    if (command === 'status') return this._sendStatus(church, chatId);
    if (command === 'preview.snap') return this._sendPreviewSnap(church, chatId);
    if (command === 'videohub.getRoutes') return this._sendRouteQuery(church, chatId, params);
    return this._executeAndReply(church, chatId, command, params);
  }

  /** Execute a command and return the reply string (for multi-step batching). */
  async _dispatchCommandSilent(church, chatId, command, params) {
    if (command === 'status') { await this._sendStatus(church, chatId); return null; }
    if (command === 'preview.snap') { await this._sendPreviewSnap(church, chatId); return null; }
    if (command === 'videohub.getRoutes') { await this._sendRouteQuery(church, chatId, params); return null; }

    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return `❌ *${church.name}* is offline.`;
    }
    const msgId = crypto.randomUUID();
    const resultPromise = this._waitForResult(church.churchId, msgId, 10000);
    churchRuntime.ws.send(JSON.stringify({ type: 'command', command, params, id: msgId }));
    const result = await resultPromise;
    if (result.error) return `❌ ${result.error}`;
    return this._formatResult(command, params, result.result);
  }

  // ─── COMMAND EXECUTION ────────────────────────────────────────────────

  async _executeAndReply(church, chatId, command, params) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return this.sendMessage(chatId, `❌ *${church.name}* is offline — equipment not connected.`, { parse_mode: 'Markdown' });
    }

    // Send command and wait for result
    const msgId = crypto.randomUUID();
    const resultPromise = this._waitForResult(church.churchId, msgId, 10000);

    churchRuntime.ws.send(JSON.stringify({ type: 'command', command, params, id: msgId }));

    const result = await resultPromise;
    if (result.error) {
      return this.sendMessage(chatId, `❌ ${result.error}`);
    }

    // Format response based on command
    const reply = this._formatResult(command, params, result.result);
    return this.sendMessage(chatId, reply, { parse_mode: 'Markdown' });
  }

  _formatResult(command, params, result) {
    if (typeof result === 'string') {
      return `✅ ${result}`;
    }

    switch (command) {
      case 'atem.cut':
        return `✅ Switched to Camera ${params.input}`;
      case 'atem.setPreview':
        return `✅ Camera ${params.input} on preview`;
      case 'atem.auto':
        return `✅ Auto transition executed`;
      case 'atem.fadeToBlack':
        return `✅ Fade to black toggled`;
      case 'atem.startRecording':
        return `✅ Recording started`;
      case 'atem.stopRecording':
        return `✅ Recording stopped`;
      case 'atem.setInputLabel':
        return `✅ Camera ${params.input} renamed to *${params.longName}*`;
      case 'obs.startStream':
        return `✅ Stream started — you're live!`;
      case 'obs.stopStream':
        return `✅ Stream stopped`;
      case 'obs.setScene':
        return `✅ Switched to scene *${params.scene}*`;
      case 'companion.pressNamed':
        return `✅ Button "${params.name}" pressed`;
      case 'videohub.route':
        return `✅ Input ${params.input} → Output ${params.output}`;
      case 'videohub.setInputLabel':
        return `✅ Input ${params.index} renamed to *${params.label}*`;
      case 'videohub.setOutputLabel':
        return `✅ Output ${params.index} renamed to *${params.label}*`;
      case 'propresenter.next':
        return `✅ Advanced to next slide`;
      case 'propresenter.previous':
        return `✅ Went to previous slide`;
      case 'propresenter.goToSlide':
        return `✅ Jumped to slide ${params.index}`;
      case 'propresenter.status':
        return `✅ ${result}`;
      case 'propresenter.playlist':
        return `📋 *Playlist*\n${result}`;
      case 'dante.scene':
        return `✅ Dante scene "${params.name}" triggered`;
      case 'ptz.pan':
      case 'ptz.tilt':
      case 'ptz.zoom':
      case 'ptz.preset':
      case 'ptz.setPreset':
      case 'ptz.home':
      case 'ptz.stop':
        return `✅ ${typeof result === 'string' ? result : 'PTZ command executed'}`;
      case 'system.preServiceCheck':
        if (result && result.checks) {
          const lines = result.checks.map(c => `${c.pass ? '✅' : '❌'} ${c.name}: ${c.detail}`);
          const summary = result.pass ? '🟢 All systems go!' : `⚠️ Issues detected`;
          return `*Pre-Service Check*\n${summary}\n\n${lines.join('\n')}`;
        }
        return `✅ Pre-service check sent`;
      default:
        return `✅ ${JSON.stringify(result)}`;
    }
  }

  _waitForResult(churchId, msgId, timeoutMs) {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        cleanup();
        resolve({ error: 'Command timed out (10s). Church client may be unresponsive.' });
      }, timeoutMs);

      const handler = (msg) => {
        if (msg.type === 'command_result' && msg.churchId === churchId && msg.messageId === msgId) {
          cleanup();
          resolve({ result: msg.result, error: msg.error });
        }
      };

      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._resultListeners.indexOf(handler);
        if (idx !== -1) this._resultListeners.splice(idx, 1);
      };

      if (!this._resultListeners) this._resultListeners = [];
      this._resultListeners.push(handler);
    });
  }

  /** Call this from server.js when a command_result is broadcast */
  onCommandResult(msg) {
    if (this._resultListeners) {
      for (const handler of this._resultListeners) handler(msg);
    }
  }

  // ─── STATUS ───────────────────────────────────────────────────────────

  async _sendStatus(church, chatId) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime) {
      return this.sendMessage(chatId, `❌ *${church.name}* not found.`, { parse_mode: 'Markdown' });
    }

    const connected = churchRuntime.ws?.readyState === 1;
    const s = churchRuntime.status || {};

    let text = `*${church.name}* — ${connected ? '🟢 Online' : '⚫ Offline'}\n`;

    if (s.atem) {
      text += `\n📹 *ATEM*: ${s.atem.connected ? '✅' : '❌'}`;
      if (s.atem.connected) {
        text += ` | Camera ${s.atem.programInput || '?'} live`;
        text += ` | Camera ${s.atem.previewInput || '?'} preview`;
        if (s.atem.recording) text += ` | 🔴 Recording`;
      }
    }

    if (s.obs) {
      text += `\n🎬 *OBS*: ${s.obs.connected ? '✅' : '❌'}`;
      if (s.obs.connected) {
        text += s.obs.streaming ? ' | 🔴 Streaming' : ' | Off-air';
        if (s.obs.fps) text += ` | ${s.obs.fps}fps`;
        if (s.obs.bitrate) text += ` | ${(s.obs.bitrate / 1000).toFixed(1)}Mbps`;
      }
    }

    if (s.companion) {
      text += `\n🎛️ *Companion*: ${s.companion.connected ? '✅' : '❌'}`;
    }

    if (s.proPresenter) {
      text += `\n⛪ *ProPresenter*: ${s.proPresenter.connected ? '✅' : '❌'}`;
      if (s.proPresenter.connected && s.proPresenter.currentSlide) {
        text += ` | ${s.proPresenter.currentSlide}`;
        if (s.proPresenter.slideIndex != null) text += ` (${s.proPresenter.slideIndex + 1}/${s.proPresenter.slideTotal})`;
      }
    }

    if (s.videoHubs && s.videoHubs.length > 0) {
      for (const hub of s.videoHubs) {
        text += `\n📺 *${hub.name}*: ${hub.connected ? '✅' : '❌'}`;
        if (hub.connected) text += ` | ${hub.routeCount} routes`;
      }
    }

    return this.sendMessage(chatId, text, { parse_mode: 'Markdown' });
  }

  // ─── PREVIEW SNAP ─────────────────────────────────────────────────────

  async _sendPreviewSnap(church, chatId) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return this.sendMessage(chatId, `❌ *${church.name}* is offline.`, { parse_mode: 'Markdown' });
    }

    // Request a preview snap
    const msgId = crypto.randomUUID();
    churchRuntime.ws.send(JSON.stringify({ type: 'command', command: 'preview.snap', params: {}, id: msgId }));

    // Wait for preview_frame message (up to 10s)
    const frame = await new Promise((resolve) => {
      const timer = setTimeout(() => { cleanup(); resolve(null); }, 10000);
      const handler = (msg) => {
        if (msg.type === 'preview_frame' && msg.churchId === church.churchId) {
          cleanup();
          resolve(msg);
        }
      };
      const cleanup = () => {
        clearTimeout(timer);
        const idx = this._frameListeners.indexOf(handler);
        if (idx !== -1) this._frameListeners.splice(idx, 1);
      };
      if (!this._frameListeners) this._frameListeners = [];
      this._frameListeners.push(handler);
    });

    if (!frame || !frame.data) {
      // Fallback to text status
      return this._sendStatus(church, chatId);
    }

    // Send as Telegram photo
    const caption = `📸 Live preview — ${new Date().toLocaleString()}`;
    return this.sendPhoto(chatId, Buffer.from(frame.data, 'base64'), caption);
  }

  /** Call this from server.js when a preview_frame arrives */
  onPreviewFrame(msg) {
    if (this._frameListeners) {
      for (const handler of this._frameListeners) handler(msg);
    }
  }

  // ─── ROUTE QUERY ──────────────────────────────────────────────────────

  async _sendRouteQuery(church, chatId, params) {
    const churchRuntime = this.relay.churches.get(church.churchId);
    if (!churchRuntime?.ws || churchRuntime.ws.readyState !== 1) {
      return this.sendMessage(chatId, `❌ *${church.name}* is offline.`, { parse_mode: 'Markdown' });
    }

    const msgId = crypto.randomUUID();
    const resultPromise = this._waitForResult(church.churchId, msgId, 10000);
    churchRuntime.ws.send(JSON.stringify({ type: 'command', command: 'videohub.getRoutes', params: params || {}, id: msgId }));

    const result = await resultPromise;
    if (result.error) {
      return this.sendMessage(chatId, `❌ ${result.error}`);
    }

    const routes = result.result;
    if (!Array.isArray(routes) || routes.length === 0) {
      return this.sendMessage(chatId, 'No routing data available.');
    }

    // Filter if specific output requested
    let filtered = routes;
    if (params.filterOutput !== undefined) {
      filtered = routes.filter(r => r.output === params.filterOutput);
      if (filtered.length === 0) {
        return this.sendMessage(chatId, `No route found for output ${params.filterOutput}.`);
      }
      const r = filtered[0];
      return this.sendMessage(chatId, `📺 *Output ${r.output}* (${r.outputLabel})\n← Input ${r.input} (${r.inputLabel})`, { parse_mode: 'Markdown' });
    }

    // Format all routes
    const lines = filtered.map(r => `Out ${r.output} (${r.outputLabel}) ← In ${r.input} (${r.inputLabel})`);
    return this.sendMessage(chatId, `📺 *Video Hub Routing*\n\n${lines.join('\n')}`, { parse_mode: 'Markdown' });
  }

  // ─── TELEGRAM API ─────────────────────────────────────────────────────

  async sendMessage(chatId, text, options = {}) {
    const body = { chat_id: chatId, text, ...options };
    try {
      const resp = await fetch(`${this._apiBase}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      if (!data.ok) console.warn('[TallyBot] sendMessage failed:', data.description);
      return data;
    } catch (e) {
      console.error('[TallyBot] sendMessage error:', e.message);
    }
  }

  async sendPhoto(chatId, photoBuffer, caption = '') {
    const boundary = '----TallyBotBoundary' + Date.now();
    const parts = [];

    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="chat_id"\r\n\r\n${chatId}`);
    if (caption) parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="caption"\r\n\r\n${caption}`);
    parts.push(`--${boundary}\r\nContent-Disposition: form-data; name="photo"; filename="preview.jpg"\r\nContent-Type: image/jpeg\r\n\r\n`);

    const header = Buffer.from(parts.join('\r\n') + '\r\n');
    const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
    const body = Buffer.concat([header, photoBuffer, footer]);

    try {
      const resp = await fetch(`${this._apiBase}/sendPhoto`, {
        method: 'POST',
        headers: { 'Content-Type': `multipart/form-data; boundary=${boundary}` },
        body,
        signal: AbortSignal.timeout(10000),
      });
      const data = await resp.json();
      if (!data.ok) console.warn('[TallyBot] sendPhoto failed:', data.description);
      return data;
    } catch (e) {
      console.error('[TallyBot] sendPhoto error:', e.message);
    }
  }

  // ─── RISKY ACTION CONFIRMATION (inline keyboard) ─────────────────────

  /**
   * Check if a command is risky and needs inline-keyboard confirmation.
   * Returns the risky type string, or null if not risky.
   */
  _getRiskyType(command) {
    return RISKY_COMMAND_MAP[command] || null;
  }

  /**
   * Send a confirmation prompt with inline keyboard for a risky command.
   * Returns the sendMessage promise.
   */
  _sendRiskyConfirmation(chatId, church, command, params, riskyType) {
    const confirmId = crypto.randomBytes(8).toString('hex');
    this._riskyConfirmations.set(confirmId, {
      command,
      params,
      church,
      chatId,
      expiresAt: Date.now() + 30_000, // 30s timeout
    });

    // Auto-cancel after 30s
    setTimeout(() => {
      if (this._riskyConfirmations.has(confirmId)) {
        this._riskyConfirmations.delete(confirmId);
        this.answerCallbackQuery(null); // no-op, just cleanup
      }
    }, 30_000);

    const label = RISKY_LABELS[riskyType] || riskyType;
    return this.sendMessage(chatId, `\u26a0\ufe0f ${label}?`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '\u2705 Confirm', callback_data: `risky_confirm:${confirmId}` },
          { text: '\u274c Cancel', callback_data: `risky_cancel:${confirmId}` },
        ]],
      },
    });
  }

  /**
   * Handle an inline keyboard callback query (confirm / cancel risky action).
   */
  async _handleCallbackQuery(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = String(callbackQuery.message?.chat?.id || callbackQuery.from?.id);
    const callbackQueryId = callbackQuery.id;

    if (!data) return;

    // Parse callback data
    const [action, confirmId] = data.split(':');
    if (!confirmId || !['risky_confirm', 'risky_cancel'].includes(action)) {
      return this.answerCallbackQuery(callbackQueryId, 'Unknown action.');
    }

    const pending = this._riskyConfirmations.get(confirmId);

    // Expired or not found
    if (!pending) {
      await this.answerCallbackQuery(callbackQueryId, 'Expired or already handled.');
      return this.editMessageText(chatId, callbackQuery.message?.message_id, '\u23f0 Confirmation expired.');
    }

    this._riskyConfirmations.delete(confirmId);

    if (action === 'risky_cancel') {
      await this.answerCallbackQuery(callbackQueryId, 'Cancelled.');
      return this.editMessageText(chatId, callbackQuery.message?.message_id, '\u2705 Cancelled \u2014 nothing was changed.');
    }

    // Confirmed — execute the command
    await this.answerCallbackQuery(callbackQueryId, 'Confirmed!');
    await this.editMessageText(chatId, callbackQuery.message?.message_id, '\u2705 Confirmed \u2014 executing...');

    // Record in command history
    this._recordCommand(pending.church.churchId, pending.command, pending.params);

    return this._dispatchCommand(pending.church, chatId, pending.command, pending.params);
  }

  /**
   * Answer a Telegram callback query (acknowledge the button press).
   */
  async answerCallbackQuery(callbackQueryId, text) {
    if (!callbackQueryId) return;
    try {
      await fetch(`${this._apiBase}/answerCallbackQuery`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ callback_query_id: callbackQueryId, text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error('[TallyBot] answerCallbackQuery error:', e.message);
    }
  }

  /**
   * Edit an existing message's text (used to update confirmation prompts).
   */
  async editMessageText(chatId, messageId, text) {
    if (!messageId) return;
    try {
      await fetch(`${this._apiBase}/editMessageText`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, text }),
        signal: AbortSignal.timeout(5000),
      });
    } catch (e) {
      console.error('[TallyBot] editMessageText error:', e.message);
    }
  }

  // ─── QUICK-ACCESS MENU (reply keyboard) ─────────────────────────────

  _sendMenuKeyboard(chatId) {
    return this.sendMessage(chatId, 'Quick actions:', {
      reply_markup: {
        keyboard: [
          [{ text: '\ud83d\udcf7 Cam 1' }, { text: '\ud83d\udcf7 Cam 2' }, { text: '\ud83d\udcf7 Cam 3' }],
          [{ text: '\ud83d\udd34 Start Stream' }, { text: '\u23f9 Stop Stream' }],
          [{ text: '\ud83c\udfac Start Recording' }, { text: '\u23f9 Stop Recording' }],
          [{ text: '\ud83d\udcca Status' }, { text: '\ud83d\udd27 Pre-Check' }, { text: '\ud83d\udee0 Troubleshoot' }],
        ],
        resize_keyboard: true,
        one_time_keyboard: false,
      },
    });
  }

  // ─── COMMAND HISTORY ────────────────────────────────────────────────

  /**
   * Record a command execution in the per-church history.
   */
  _recordCommand(churchId, command, params) {
    if (!this._commandHistory.has(churchId)) {
      this._commandHistory.set(churchId, []);
    }
    const history = this._commandHistory.get(churchId);
    history.push({
      command,
      params: params || {},
      timestamp: new Date().toISOString(),
    });
    // Keep max 50 entries
    if (history.length > 50) history.splice(0, history.length - 50);
  }

  /**
   * Handle /history — show last 10 commands for the user's church.
   */
  async _handleHistory(userId, chatId) {
    const td = this._stmtFindTD.get(userId);
    if (!td) {
      return this.sendMessage(chatId, 'You are not registered. Use `/register YOUR_CODE` first.', { parse_mode: 'Markdown' });
    }

    const history = this._commandHistory.get(td.church_id) || [];
    if (!history.length) {
      return this.sendMessage(chatId, 'No command history yet.');
    }

    const recent = history.slice(-10).reverse();
    const lines = recent.map((h, i) => {
      const time = new Date(h.timestamp).toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
      const paramStr = Object.keys(h.params).length ? ` (${JSON.stringify(h.params)})` : '';
      return `${i + 1}. \`${h.command}\`${paramStr} — ${time}`;
    });

    return this.sendMessage(chatId,
      `*Recent Commands*\n\n${lines.join('\n')}`,
      { parse_mode: 'Markdown' }
    );
  }

  async setWebhook(payloadOrUrl) {
    const payload = typeof payloadOrUrl === 'string'
      ? { url: payloadOrUrl }
      : (payloadOrUrl || {});

    try {
      const resp = await fetch(`${this._apiBase}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(5000),
      });
      const data = await resp.json();
      console.log(`[TallyBot] Webhook set: ${data.ok ? '✅' : '❌'} ${data.description || ''}`);
      return data;
    } catch (e) {
      console.error('[TallyBot] setWebhook error:', e.message);
    }
  }
}

module.exports = { TallyBot, parseCommand, RISKY_COMMANDS, RISKY_COMMAND_MAP, RISKY_LABELS, CANNED_RESPONSES };
