/**
 * Tally Telegram Bot
 * Handles TD and admin commands via a single shared Telegram bot.
 * Uses raw Bot API (fetch) — no library needed.
 */

const crypto = require('crypto');

// ─── COMMAND PATTERNS (ported from parse-command.js + videohub + extras) ─────

const patterns = [
  // ATEM — cut/switch
  { match: /(?:cut|switch|go)\s+(?:to\s+)?(?:cam(?:era)?|input)\s*(\d+)/i, command: 'atem.cut', extract: m => ({ input: parseInt(m[1]) }), desc: 'cut to camera N' },
  { match: /(?:cam(?:era)?|input)\s*(\d+)\s+(?:to|on)\s+(?:program|pgm|live)/i, command: 'atem.cut', extract: m => ({ input: parseInt(m[1]) }), desc: null },
  { match: /(?:put\s+)?(?:cam(?:era)?|input)\s*(\d+)\s+(?:to|on)\s+preview/i, command: 'atem.setPreview', extract: m => ({ input: parseInt(m[1]) }), desc: 'camera N to preview' },
  { match: /(?:set|change)\s+preview?\s+(?:to\s+)?(?:cam(?:era)?|input)\s*(\d+)/i, command: 'atem.setPreview', extract: m => ({ input: parseInt(m[1]) }), desc: null },

  // ATEM — transitions
  { match: /auto\s*(?:transition|mix|trans)|^take$/i, command: 'atem.auto', extract: () => ({}), desc: 'auto transition / take' },
  { match: /(?:fade\s*to\s*black|ftb)/i, command: 'atem.fadeToBlack', extract: () => ({}), desc: 'fade to black' },

  // ATEM — recording
  { match: /(?:start|begin)\s+recording/i, command: 'atem.startRecording', extract: () => ({}), desc: 'start recording' },
  { match: /stop\s+recording/i, command: 'atem.stopRecording', extract: () => ({}), desc: 'stop recording' },

  // ATEM — input label / rename
  { match: /(?:change|rename|set|label)\s+(?:cam(?:era)?|input)\s*(\d+)\s+(?:name\s+)?(?:to|as)\s+["""]?(.+?)["""]?\s*$/i, command: 'atem.setInputLabel', extract: m => ({ input: parseInt(m[1]), longName: m[2].trim() }), desc: 'rename camera N to "Name"' },
  { match: /label\s+(?:cam(?:era)?|input)\s*(\d+)\s+["""]?(.+?)["""]?\s*$/i, command: 'atem.setInputLabel', extract: m => ({ input: parseInt(m[1]), longName: m[2].trim() }), desc: null },

  // OBS — stream
  { match: /(?:start|begin|go)\s+(?:the\s+)?stream(?:ing)?|go\s+live/i, command: 'obs.startStream', extract: () => ({}), desc: 'start stream / go live' },
  { match: /(?:stop|end)\s+(?:the\s+)?stream(?:ing)?/i, command: 'obs.stopStream', extract: () => ({}), desc: 'stop stream' },

  // OBS — scene
  { match: /(?:switch|go|change)\s+(?:to\s+)?scene\s+["""]?(.+?)["""]?\s*$/i, command: 'obs.setScene', extract: m => ({ scene: m[1].trim() }), desc: 'switch to scene "Name"' },

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

  // Dante (via Companion)
  { match: /(?:load\s+dante\s+scene|dante\s+preset)\s+["""]?(.+?)["""]?\s*$/i, command: 'dante.scene', extract: m => ({ name: m[1].trim() }), desc: 'load dante scene [name]' },

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
    if (match) return { command: pattern.command, params: pattern.extract(match) };
  }
  return null;
}

// ─── HELP MESSAGE ───────────────────────────────────────────────────────────

const HELP_TEXT = `🎛️ *Tally Commands*

*ATEM*
• cut to camera 2
• camera 3 to preview
• fade to black
• start / stop recording
• rename camera 4 to "Fog GFX"
• auto transition

*OBS*
• start / stop stream
• switch to scene \\[name\\]

*Companion*
• press "button name"
• play the "video name"

*Video Hub*
• route camera 2 to monitor 3
• show routing
• what's on monitor 1?
• rename input 3 to "Stage Cam"

*ProPresenter*
• next slide / advance
• previous slide / go back
• current slide / what's on screen?
• go to slide 3
• playlist / what's loaded?

*Dante*
• load dante scene \\[name\\] — trigger Companion button 'Dante: \\[name\\]'

*Status*
• status — system overview
• show me what's on screen — live preview
• pre-service check

Need help? Contact your ATEM School administrator.`;

// ─── TELEGRAM BOT CLASS ─────────────────────────────────────────────────────

class TallyBot {
  /**
   * @param {object} opts
   * @param {string} opts.botToken - Telegram bot token
   * @param {string} opts.adminChatId - Andrew's Telegram chat ID
   * @param {object} opts.db - better-sqlite3 instance
   * @param {object} opts.relay - { churches, sendCommand, waitForResult }
   */
  constructor({ botToken, adminChatId, db, relay }) {
    this.token = botToken;
    this.adminChatId = adminChatId;
    this.db = db;
    this.relay = relay;
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

    this._stmtFindTD = this.db.prepare('SELECT * FROM church_tds WHERE telegram_user_id = ? AND active = 1');
    this._stmtFindChurchByCode = this.db.prepare('SELECT * FROM churches WHERE registration_code = ?');
    this._stmtRegisterTD = this.db.prepare('INSERT OR REPLACE INTO church_tds (church_id, telegram_user_id, telegram_chat_id, name, registered_at, active) VALUES (?, ?, ?, ?, ?, 1)');
    this._stmtListTDs = this.db.prepare('SELECT * FROM church_tds WHERE church_id = ? AND active = 1');
    this._stmtDeactivateTD = this.db.prepare('UPDATE church_tds SET active = 0 WHERE church_id = ? AND telegram_user_id = ?');
  }

  // ─── WEBHOOK HANDLER ───────────────────────────────────────────────────

  async handleUpdate(update) {
    const msg = update.message;
    if (!msg || !msg.text) return;

    const userId = String(msg.from.id);
    const chatId = String(msg.chat.id);
    const text = msg.text.trim();

    // Process async — don't block Telegram's webhook timeout
    this._processMessage(userId, chatId, text, msg.from).catch(err => {
      console.error('[TallyBot] Error processing message:', err.message);
      this.sendMessage(chatId, '❌ Something went wrong. Try again.').catch(() => {});
    });
  }

  async _processMessage(userId, chatId, text, from) {
    // 1. /start command
    if (text === '/start') {
      return this.sendMessage(chatId,
        `👋 Welcome to *Tally*!\n\nIf you're a church Technical Director, register with:\n\`/register YOUR_CODE\`\n\nYour church admin will give you the code.`,
        { parse_mode: 'Markdown' }
      );
    }

    // 2. /register CHURCH_CODE
    if (text.startsWith('/register')) {
      return this._handleRegister(userId, chatId, text, from);
    }

    // 3. /help
    if (text === '/help' || text.toLowerCase() === 'help') {
      return this.sendMessage(chatId, HELP_TEXT, { parse_mode: 'Markdown' });
    }

    // 4. Check if admin
    if (chatId === this.adminChatId) {
      return this.handleAdminCommand(chatId, text);
    }

    // 5. Check if registered TD
    const td = this._stmtFindTD.get(userId);
    if (td) {
      const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(td.church_id);
      if (church) {
        return this.handleTDCommand(church, chatId, text);
      }
    }

    // 6. Unknown user
    return this.sendMessage(chatId,
      "You're not registered with Tally. Contact your church administrator for a registration code, then use `/register YOUR_CODE`.",
      { parse_mode: 'Markdown' }
    );
  }

  // ─── REGISTRATION ─────────────────────────────────────────────────────

  async _handleRegister(userId, chatId, text, from) {
    const parts = text.split(/\s+/);
    if (parts.length < 2) {
      return this.sendMessage(chatId, 'Usage: `/register YOUR_CODE`\nYour church admin will give you the 6-character code.', { parse_mode: 'Markdown' });
    }

    const code = parts[1].toUpperCase();
    const church = this._stmtFindChurchByCode.get(code);
    if (!church) {
      return this.sendMessage(chatId, "❌ Invalid registration code. Check with your church administrator.");
    }

    const name = [from.first_name, from.last_name].filter(Boolean).join(' ') || 'Unknown';
    this._stmtRegisterTD.run(church.churchId, userId, chatId, name, new Date().toISOString());

    console.log(`[TallyBot] TD registered: ${name} → ${church.name}`);
    return this.sendMessage(chatId,
      `✅ Welcome to Tally, *${name}*!\n\nYou're now registered as TD for *${church.name}*.\nType \`help\` to see what you can do.`,
      { parse_mode: 'Markdown' }
    );
  }

  // ─── TD COMMAND HANDLER ───────────────────────────────────────────────

  async handleTDCommand(church, chatId, text) {
    const parsed = parseCommand(text);
    if (!parsed) {
      return this.sendMessage(chatId, "🤔 I didn't understand that. Try `help` for a list of commands.", { parse_mode: 'Markdown' });
    }

    const { command, params } = parsed;

    // Status — return formatted status from relay
    if (command === 'status') {
      return this._sendStatus(church, chatId);
    }

    // Preview snap — special handling for photo
    if (command === 'preview.snap') {
      return this._sendPreviewSnap(church, chatId);
    }

    // Route queries — return formatted, don't send as command
    if (command === 'videohub.getRoutes') {
      return this._sendRouteQuery(church, chatId, params);
    }

    // Everything else — send to church client via relay
    return this._executeAndReply(church, chatId, command, params);
  }

  // ─── ADMIN COMMAND HANDLER ────────────────────────────────────────────

  async handleAdminCommand(chatId, text) {
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

    const parsed = parseCommand(commandText);
    if (!parsed) {
      return this.sendMessage(chatId, "🤔 I didn't understand that. Try `help` for commands.", { parse_mode: 'Markdown' });
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
      });
      const data = await resp.json();
      if (!data.ok) console.warn('[TallyBot] sendPhoto failed:', data.description);
      return data;
    } catch (e) {
      console.error('[TallyBot] sendPhoto error:', e.message);
    }
  }

  async setWebhook(webhookUrl) {
    try {
      const resp = await fetch(`${this._apiBase}/setWebhook`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url: webhookUrl }),
      });
      const data = await resp.json();
      console.log(`[TallyBot] Webhook set: ${data.ok ? '✅' : '❌'} ${data.description || ''}`);
      return data;
    } catch (e) {
      console.error('[TallyBot] setWebhook error:', e.message);
    }
  }
}

module.exports = { TallyBot, parseCommand };
