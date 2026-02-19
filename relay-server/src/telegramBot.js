/**
 * Tally Telegram Bot
 * Handles TD and admin commands via a single shared Telegram bot.
 * Uses raw Bot API (fetch) — no library needed.
 */

const crypto = require('crypto');
const { aiParseCommand } = require('./ai-parser');

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

function getHelpText(brandName = 'Tally') {
  return `🎛️ *${brandName} Commands*

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

Powered by ${brandName}`;
}

// Backward-compat constant
const HELP_TEXT = getHelpText('Tally');

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
  constructor({ botToken, adminChatId, db, relay, onCallRotation, guestTdMode, preServiceCheck, presetLibrary, planningCenter, resellerSystem }) {
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
    // 1. /start command
    if (text === '/start') {
      const brandName = this._getBrandNameForUser(userId);
      const poweredBy = brandName !== 'Tally' ? `\n\n_Powered by Tally_` : '';
      return this.sendMessage(chatId,
        `👋 Welcome to *${brandName}*!${poweredBy}\n\nIf you're a church Technical Director, register with:\n\`/register YOUR_CODE\`\n\nYour church admin will give you the code.`,
        { parse_mode: 'Markdown' }
      );
    }

    // 2. /register CHURCH_CODE or /register GUEST-XXXXXX
    if (text.startsWith('/register')) {
      return this._handleRegister(userId, chatId, text, from);
    }

    // 3. /help
    if (text === '/help' || text.toLowerCase() === 'help') {
      const brandName = this._getBrandNameForUser(userId);
      return this.sendMessage(chatId, getHelpText(brandName), { parse_mode: 'Markdown' });
    }

    // 4. /confirmswap — TD confirming an on-call swap
    if (text === '/confirmswap' && this.onCallRotation) {
      return this._handleConfirmSwap(userId, chatId);
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
        return this.handleTDCommand(church, chatId, text);
      }
    }

    // 7. Check if guest TD
    if (this.guestTdMode) {
      const guest = this.guestTdMode.findActiveGuestByChatId(chatId);
      if (guest) {
        const church = this.db.prepare('SELECT * FROM churches WHERE churchId = ?').get(guest.churchId);
        if (church) {
          return this.handleTDCommand(church, chatId, text);
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

      console.log(`[TallyBot] Guest registered: ${name} → ${church.name} (token: ${code})`);
      return this.sendMessage(chatId,
        `✅ Welcome, *${name}*!\n\nYou have *guest access* for *${church.name}*.\n\n${result.message}\n\nType \`help\` to see available commands.`,
        { parse_mode: 'Markdown' }
      );
    }

    // Regular church registration code (6-char hex)
    const church = this._stmtFindChurchByCode.get(code);
    if (!church) {
      return this.sendMessage(chatId, "❌ Invalid registration code. Check with your church administrator.");
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
    const brandName = this._getBrandName(church.churchId);
    const poweredBy = brandName !== 'Tally' ? ` — _Powered by Tally_` : '';
    return this.sendMessage(chatId,
      `✅ Welcome to *${brandName}*${poweredBy}, *${name}*!\n\nYou're now registered as TD for *${church.name}*.\nType \`help\` to see what you can do.`,
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
      ).catch(() => {});
    }
  }

  // ─── TD COMMAND HANDLER ───────────────────────────────────────────────

  async handleTDCommand(church, chatId, text) {
    const ltext = text.trim().toLowerCase();

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
        ).catch(() => {});
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

    // ── Fast path: regex parser ──────────────────────────────────────────────
    const parsed = parseCommand(text);

    if (parsed) {
      return this._dispatchCommand(church, chatId, parsed.command, parsed.params);
    }

    // ── AI fallback: Claude Haiku ────────────────────────────────────────────
    const churchRuntime = this.relay.churches.get(church.churchId);
    const ctx = {
      churchName: church.name,
      status: churchRuntime?.status || {},
    };

    const aiResult = await aiParseCommand(text, ctx);

    // Single command
    if (aiResult.type === 'command') {
      return this._dispatchCommand(church, chatId, aiResult.command, aiResult.params);
    }

    // Multi-step commands — execute sequentially
    if (aiResult.type === 'commands' && Array.isArray(aiResult.steps) && aiResult.steps.length > 0) {
      const replies = [];
      for (const step of aiResult.steps) {
        const reply = await this._dispatchCommandSilent(church, chatId, step.command, step.params);
        if (reply) replies.push(reply);
      }
      const summary = replies.join('\n');
      return this.sendMessage(chatId, summary || '✅ Done', { parse_mode: 'Markdown' });
    }

    // Conversational reply from AI
    if (aiResult.type === 'chat') {
      return this.sendMessage(chatId, aiResult.text);
    }

    // AI unavailable or parse failed — fall back to help nudge
    return this.sendMessage(chatId, "🤔 I didn't understand that. Try `help` for a list of commands.", { parse_mode: 'Markdown' });
  }

  // ─── ADMIN COMMAND HANDLER ────────────────────────────────────────────

  async handleAdminCommand(chatId, text) {
    const ltext = text.trim().toLowerCase();

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
        const result = this.guestTdMode.revokeToken(revokeMatch[1].toUpperCase());
        return this.sendMessage(chatId, result.revoked
          ? `✅ Guest token \`${result.token}\` revoked.`
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
    if (!parsed) {
      // Try AI for admin too
      const aiResult = await aiParseCommand(commandText, { churchName: targetChurch?.name });
      if (aiResult.type === 'command') {
        parsed = { command: aiResult.command, params: aiResult.params };
      } else if (aiResult.type === 'commands' && aiResult.steps?.length) {
        if (targetChurch) {
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
          const timer = setTimeout(() => {
            const idx = (this._resultListeners || []).findIndex(h => h._presetMsgId === msgId);
            if (idx !== -1) this._resultListeners.splice(idx, 1);
            reject(new Error('Command timed out (10s)'));
          }, 10000);
          const handler = (msg) => {
            if (msg.type === 'command_result' && msg.churchId === church.churchId && msg.messageId === msgId) {
              clearTimeout(timer);
              const idx = (this._resultListeners || []).indexOf(handler);
              if (idx !== -1) this._resultListeners.splice(idx, 1);
              if (msg.error) reject(new Error(msg.error));
              else resolve(msg.result);
            }
          };
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
      username: 'Tally by ATEM School',
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
