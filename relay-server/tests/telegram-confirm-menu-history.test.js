import { describe, it, expect, vi, beforeEach } from 'vitest';

import telegramBotModule from '../src/telegramBot.js';

const { TallyBot, parseCommand, RISKY_COMMANDS, RISKY_COMMAND_MAP, RISKY_LABELS } = telegramBotModule;

// ─── Mock DB ──────────────────────────────────────────────────────────────────

function createMockDb() {
  const store = {};
  return {
    exec: vi.fn(),
    prepare: vi.fn(() => ({
      all: vi.fn(() => []),
      get: vi.fn(() => null),
      run: vi.fn(),
    })),
  };
}

// ─── Mock bot that captures sendMessage calls ────────────────────────────────

function createTestBot() {
  const db = createMockDb();
  const relay = { churches: new Map() };
  const sent = [];
  const edited = [];
  const answered = [];

  const bot = new TallyBot({
    botToken: 'test-token',
    adminChatId: 'admin-123',
    db,
    relay,
  });

  // Stub API calls to capture output
  bot.sendMessage = vi.fn(async (chatId, text, options) => {
    const entry = { chatId, text, options };
    sent.push(entry);
    return { ok: true, result: { message_id: sent.length } };
  });

  bot.editMessageText = vi.fn(async (chatId, messageId, text) => {
    edited.push({ chatId, messageId, text });
  });

  bot.answerCallbackQuery = vi.fn(async (callbackQueryId, text) => {
    answered.push({ callbackQueryId, text });
  });

  // Stub TD lookup to return a registered TD
  bot._stmtFindTD = {
    get: vi.fn((userId) => {
      if (userId === 'td-user-1') return { church_id: 'church-1', telegram_chat_id: 'chat-1', name: 'Test TD' };
      return null;
    }),
  };

  // Stub church lookup
  const mockChurch = { churchId: 'church-1', name: 'Test Church', billing_tier: 'connect' };
  db.prepare = vi.fn((sql) => ({
    all: vi.fn(() => sql.includes('churches') ? [mockChurch] : []),
    get: vi.fn((id) => {
      if (sql.includes('churches') && id === 'church-1') return mockChurch;
      if (sql.includes('church_tds')) return { church_id: 'church-1', name: 'Test TD' };
      return null;
    }),
    run: vi.fn(),
  }));

  return { bot, db, relay, sent, edited, answered, mockChurch };
}

// ─── RISKY COMMANDS CONSTANTS ────────────────────────────────────────────────

describe('Risky command constants', () => {
  it('defines all expected risky command types', () => {
    expect(RISKY_COMMANDS).toContain('stop_stream');
    expect(RISKY_COMMANDS).toContain('stop_recording');
    expect(RISKY_COMMANDS).toContain('fade_to_black');
    expect(RISKY_COMMANDS).toContain('mute_all');
    expect(RISKY_COMMANDS).toContain('restart_encoder');
  });

  it('maps real commands to risky types', () => {
    expect(RISKY_COMMAND_MAP['obs.stopStream']).toBe('stop_stream');
    expect(RISKY_COMMAND_MAP['vmix.stopStream']).toBe('stop_stream');
    expect(RISKY_COMMAND_MAP['encoder.stopStream']).toBe('stop_stream');
    expect(RISKY_COMMAND_MAP['atem.stopRecording']).toBe('stop_recording');
    expect(RISKY_COMMAND_MAP['atem.fadeToBlack']).toBe('fade_to_black');
    expect(RISKY_COMMAND_MAP['mixer.activateMuteGroup']).toBe('mute_all');
    expect(RISKY_COMMAND_MAP['encoder.restart']).toBe('restart_encoder');
  });

  it('has human-readable labels for all risky types', () => {
    for (const type of RISKY_COMMANDS) {
      expect(RISKY_LABELS[type]).toBeDefined();
      expect(typeof RISKY_LABELS[type]).toBe('string');
    }
  });
});

// ─── RISKY COMMAND DETECTION ─────────────────────────────────────────────────

describe('TallyBot._getRiskyType', () => {
  let bot;

  beforeEach(() => {
    ({ bot } = createTestBot());
  });

  it('returns risky type for stop stream commands', () => {
    expect(bot._getRiskyType('obs.stopStream')).toBe('stop_stream');
    expect(bot._getRiskyType('vmix.stopStream')).toBe('stop_stream');
    expect(bot._getRiskyType('encoder.stopStream')).toBe('stop_stream');
  });

  it('returns risky type for stop recording commands', () => {
    expect(bot._getRiskyType('atem.stopRecording')).toBe('stop_recording');
    expect(bot._getRiskyType('vmix.stopRecording')).toBe('stop_recording');
    expect(bot._getRiskyType('encoder.stopRecording')).toBe('stop_recording');
  });

  it('returns risky type for fade to black', () => {
    expect(bot._getRiskyType('atem.fadeToBlack')).toBe('fade_to_black');
  });

  it('returns null for non-risky commands', () => {
    expect(bot._getRiskyType('atem.cut')).toBeNull();
    expect(bot._getRiskyType('obs.startStream')).toBeNull();
    expect(bot._getRiskyType('mixer.mute')).toBeNull();
    expect(bot._getRiskyType('status')).toBeNull();
  });
});

// ─── RISKY CONFIRMATION FLOW ─────────────────────────────────────────────────

describe('Risky confirmation flow', () => {
  let bot, sent, edited, answered, mockChurch;

  beforeEach(() => {
    ({ bot, sent, edited, answered, mockChurch } = createTestBot());
  });

  it('sends an inline keyboard with confirm/cancel buttons', async () => {
    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'obs.stopStream', {}, 'stop_stream');

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain('Stop stream');
    expect(msg.options.reply_markup).toBeDefined();

    const keyboard = msg.options.reply_markup.inline_keyboard;
    expect(keyboard).toHaveLength(1);
    expect(keyboard[0]).toHaveLength(2);
    expect(keyboard[0][0].text).toContain('Confirm');
    expect(keyboard[0][0].callback_data).toMatch(/^risky_confirm:/);
    expect(keyboard[0][1].text).toContain('Cancel');
    expect(keyboard[0][1].callback_data).toMatch(/^risky_cancel:/);
  });

  it('stores the pending confirmation with 30s expiry', async () => {
    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'obs.stopStream', { foo: 1 }, 'stop_stream');

    expect(bot._riskyConfirmations.size).toBe(1);

    const entry = [...bot._riskyConfirmations.values()][0];
    expect(entry.command).toBe('obs.stopStream');
    expect(entry.params).toEqual({ foo: 1 });
    expect(entry.church).toBe(mockChurch);
    expect(entry.chatId).toBe('chat-1');
    expect(entry.expiresAt).toBeGreaterThan(Date.now());
    expect(entry.expiresAt).toBeLessThanOrEqual(Date.now() + 31_000);
  });

  it('executes the command on confirm callback', async () => {
    // Set up a mock dispatch
    bot._dispatchCommand = vi.fn(async () => {});

    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'obs.stopStream', {}, 'stop_stream');

    const confirmId = [...bot._riskyConfirmations.keys()][0];

    await bot._handleCallbackQuery({
      id: 'cbq-1',
      data: `risky_confirm:${confirmId}`,
      message: { chat: { id: 'chat-1' }, message_id: 42 },
      from: { id: 'td-user-1' },
    });

    expect(answered).toHaveLength(1);
    expect(answered[0].text).toBe('Confirmed!');
    expect(edited).toHaveLength(1);
    expect(edited[0].text).toContain('Confirmed');
    expect(bot._dispatchCommand).toHaveBeenCalledWith(mockChurch, 'chat-1', 'obs.stopStream', {});
    expect(bot._riskyConfirmations.size).toBe(0);
  });

  it('cancels on cancel callback and updates the message', async () => {
    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'obs.stopStream', {}, 'stop_stream');

    const confirmId = [...bot._riskyConfirmations.keys()][0];

    await bot._handleCallbackQuery({
      id: 'cbq-2',
      data: `risky_cancel:${confirmId}`,
      message: { chat: { id: 'chat-1' }, message_id: 43 },
      from: { id: 'td-user-1' },
    });

    expect(answered).toHaveLength(1);
    expect(answered[0].text).toBe('Cancelled.');
    expect(edited).toHaveLength(1);
    expect(edited[0].text).toContain('Cancelled');
    expect(bot._riskyConfirmations.size).toBe(0);
  });

  it('handles expired confirmation gracefully', async () => {
    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'obs.stopStream', {}, 'stop_stream');

    const confirmId = [...bot._riskyConfirmations.keys()][0];
    // Force expire it
    bot._riskyConfirmations.get(confirmId).expiresAt = Date.now() - 1000;
    // Cleanup
    bot._riskyConfirmations.delete(confirmId);

    await bot._handleCallbackQuery({
      id: 'cbq-3',
      data: `risky_confirm:${confirmId}`,
      message: { chat: { id: 'chat-1' }, message_id: 44 },
      from: { id: 'td-user-1' },
    });

    expect(answered).toHaveLength(1);
    expect(answered[0].text).toBe('Expired or already handled.');
    expect(edited).toHaveLength(1);
    expect(edited[0].text).toContain('expired');
  });

  it('records command in history on confirm', async () => {
    bot._dispatchCommand = vi.fn(async () => {});

    await bot._sendRiskyConfirmation('chat-1', mockChurch, 'atem.fadeToBlack', {}, 'fade_to_black');
    const confirmId = [...bot._riskyConfirmations.keys()][0];

    await bot._handleCallbackQuery({
      id: 'cbq-4',
      data: `risky_confirm:${confirmId}`,
      message: { chat: { id: 'chat-1' }, message_id: 45 },
      from: { id: 'td-user-1' },
    });

    const history = bot._commandHistory.get('church-1');
    expect(history).toBeDefined();
    expect(history).toHaveLength(1);
    expect(history[0].command).toBe('atem.fadeToBlack');
  });
});

// ─── CALLBACK QUERY ROUTING ──────────────────────────────────────────────────

describe('handleUpdate with callback_query', () => {
  let bot, sent;

  beforeEach(() => {
    ({ bot, sent } = createTestBot());
  });

  it('routes callback_query updates to _handleCallbackQuery', async () => {
    bot._handleCallbackQuery = vi.fn(async () => {});

    await bot.handleUpdate({
      callback_query: {
        id: 'cbq-10',
        data: 'risky_confirm:abc123',
        message: { chat: { id: 'chat-1' }, message_id: 50 },
        from: { id: 'td-user-1' },
      },
    });

    expect(bot._handleCallbackQuery).toHaveBeenCalled();
  });
});

// ─── QUICK-ACCESS MENU ──────────────────────────────────────────────────────

describe('Quick-access menu', () => {
  let bot, sent;

  beforeEach(() => {
    ({ bot, sent } = createTestBot());
  });

  it('/menu sends a reply keyboard with correct rows', async () => {
    await bot._sendMenuKeyboard('chat-1');

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toBe('Quick actions:');

    const kb = msg.options.reply_markup.keyboard;
    expect(kb).toHaveLength(4);

    // Row 1: cameras
    expect(kb[0]).toHaveLength(3);
    expect(kb[0][0].text).toContain('Cam 1');
    expect(kb[0][1].text).toContain('Cam 2');
    expect(kb[0][2].text).toContain('Cam 3');

    // Row 2: stream
    expect(kb[1]).toHaveLength(2);
    expect(kb[1][0].text).toContain('Start Stream');
    expect(kb[1][1].text).toContain('Stop Stream');

    // Row 3: recording
    expect(kb[2]).toHaveLength(2);
    expect(kb[2][0].text).toContain('Start Recording');
    expect(kb[2][1].text).toContain('Stop Recording');

    // Row 4: status/precheck/troubleshoot
    expect(kb[3]).toHaveLength(3);
    expect(kb[3][0].text).toContain('Status');
    expect(kb[3][1].text).toContain('Pre-Check');
    expect(kb[3][2].text).toContain('Troubleshoot');
  });

  it('/menu sets resize_keyboard and persistent keyboard', async () => {
    await bot._sendMenuKeyboard('chat-1');

    const markup = sent[0].options.reply_markup;
    expect(markup.resize_keyboard).toBe(true);
    expect(markup.one_time_keyboard).toBe(false);
  });

  it('/hidemenu command sends remove_keyboard', async () => {
    // Simulate the /hidemenu path from _processMessage
    await bot._processMessage('td-user-1', 'chat-1', '/hidemenu', { id: 'td-user-1' });

    const hideMsg = sent.find(m => m.options?.reply_markup?.remove_keyboard === true);
    expect(hideMsg).toBeDefined();
    expect(hideMsg.text).toBe('Keyboard hidden.');
  });

  it('/menu command is handled in _processMessage', async () => {
    bot._sendMenuKeyboard = vi.fn(async () => {});

    await bot._processMessage('td-user-1', 'chat-1', '/menu', { id: 'td-user-1' });

    expect(bot._sendMenuKeyboard).toHaveBeenCalledWith('chat-1');
  });
});

// ─── COMMAND HISTORY ─────────────────────────────────────────────────────────

describe('Command history', () => {
  let bot, sent;

  beforeEach(() => {
    ({ bot, sent } = createTestBot());
  });

  it('records commands in per-church history', () => {
    bot._recordCommand('church-1', 'atem.cut', { input: 2 });
    bot._recordCommand('church-1', 'obs.startStream', {});
    bot._recordCommand('church-2', 'atem.auto', {});

    expect(bot._commandHistory.get('church-1')).toHaveLength(2);
    expect(bot._commandHistory.get('church-2')).toHaveLength(1);
  });

  it('stores command, params, and timestamp', () => {
    bot._recordCommand('church-1', 'atem.cut', { input: 3 });

    const entry = bot._commandHistory.get('church-1')[0];
    expect(entry.command).toBe('atem.cut');
    expect(entry.params).toEqual({ input: 3 });
    expect(entry.timestamp).toBeDefined();
    expect(new Date(entry.timestamp).getTime()).toBeGreaterThan(0);
  });

  it('caps history at 50 entries', () => {
    for (let i = 0; i < 60; i++) {
      bot._recordCommand('church-1', `cmd.${i}`, {});
    }

    expect(bot._commandHistory.get('church-1')).toHaveLength(50);
    // Should keep the most recent
    expect(bot._commandHistory.get('church-1')[49].command).toBe('cmd.59');
  });

  it('/history shows last 10 commands in reverse order', async () => {
    for (let i = 0; i < 15; i++) {
      bot._recordCommand('church-1', `cmd.${i}`, { n: i });
    }

    await bot._handleHistory('td-user-1', 'chat-1');

    expect(sent).toHaveLength(1);
    const msg = sent[0];
    expect(msg.text).toContain('Recent Commands');
    // Should show cmd.14 (most recent) first
    expect(msg.text).toContain('cmd.14');
    // Should show cmd.5 (10th most recent) last
    expect(msg.text).toContain('cmd.5');
    // Should not show cmd.4
    expect(msg.text).not.toContain('cmd.4');
  });

  it('/history shows empty message when no history', async () => {
    await bot._handleHistory('td-user-1', 'chat-1');

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('No command history');
  });

  it('/history shows unregistered message for unknown users', async () => {
    await bot._handleHistory('unknown-user', 'chat-99');

    expect(sent).toHaveLength(1);
    expect(sent[0].text).toContain('not registered');
  });
});
