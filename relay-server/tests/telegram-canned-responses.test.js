import { describe, it, expect, vi, beforeEach } from 'vitest';

import telegramBotModule from '../src/telegramBot.js';

const { TallyBot, CANNED_RESPONSES } = telegramBotModule;

// ─── Mock DB ──────────────────────────────────────────────────────────────────

function createMockDb() {
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

  return { bot, db, relay, sent, mockChurch };
}

// ─── Helper: simulate a TD sending a message ────────────────────────────────

async function sendAsTD(bot, text) {
  await bot.handleUpdate({
    message: {
      from: { id: 'td-user-1', first_name: 'Test', last_name: 'TD' },
      chat: { id: 'chat-1' },
      text,
    },
  });
}

// ─── CANNED_RESPONSES constant structure ────────────────────────────────────

describe('CANNED_RESPONSES constant', () => {
  it('is exported and is a non-empty object', () => {
    expect(CANNED_RESPONSES).toBeDefined();
    expect(typeof CANNED_RESPONSES).toBe('object');
    expect(Object.keys(CANNED_RESPONSES).length).toBeGreaterThan(0);
  });

  it('all entries have title and text fields', () => {
    for (const [key, value] of Object.entries(CANNED_RESPONSES)) {
      expect(value.title, `${key} missing title`).toBeDefined();
      expect(typeof value.title, `${key} title not string`).toBe('string');
      expect(value.text, `${key} missing text`).toBeDefined();
      expect(typeof value.text, `${key} text not string`).toBe('string');
    }
  });

  it('each response is under 4096 characters (Telegram limit)', () => {
    for (const [key, value] of Object.entries(CANNED_RESPONSES)) {
      const fullMessage = `*${value.title}*\n\n${value.text}`;
      expect(fullMessage.length, `${key} exceeds 4096 chars (${fullMessage.length})`).toBeLessThan(4096);
    }
  });

  it('contains all 10 expected topics', () => {
    const expectedTopics = ['obs', 'atem', 'stream', 'audio', 'encoder', 'recording', 'companion', 'network', 'preservice', 'restart'];
    for (const topic of expectedTopics) {
      expect(CANNED_RESPONSES[topic], `missing topic: ${topic}`).toBeDefined();
    }
  });
});

// ─── /fix command handler ───────────────────────────────────────────────────

describe('/fix command', () => {
  let bot, sent;

  beforeEach(() => {
    ({ bot, sent } = createTestBot());
  });

  it('/fix obs returns OBS troubleshooting guide', async () => {
    await sendAsTD(bot, '/fix obs');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('OBS Connection Troubleshooting');
    expect(sent[0].text).toContain('WebSocket');
  });

  it('/fix atem returns ATEM guide', async () => {
    await sendAsTD(bot, '/fix atem');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('ATEM Connection Troubleshooting');
    expect(sent[0].text).toContain('192.168.10.240');
  });

  it('/fix stream returns stream guide', async () => {
    await sendAsTD(bot, '/fix stream');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Stream Not Working');
    expect(sent[0].text).toContain('stream key');
  });

  it('/fix audio returns audio guide', async () => {
    await sendAsTD(bot, '/fix audio');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Audio Issues');
  });

  it('/fix encoder returns encoder guide', async () => {
    await sendAsTD(bot, '/fix encoder');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Encoder Troubleshooting');
  });

  it('/fix recording returns recording guide', async () => {
    await sendAsTD(bot, '/fix recording');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Recording Issues');
  });

  it('/fix companion returns companion guide', async () => {
    await sendAsTD(bot, '/fix companion');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Companion Connection Issues');
  });

  it('/fix network returns network guide', async () => {
    await sendAsTD(bot, '/fix network');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Network Troubleshooting');
  });

  it('/fix preservice returns pre-service checklist', async () => {
    await sendAsTD(bot, '/fix preservice');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Pre-Service Checklist');
  });

  it('/fix restart returns restart guide', async () => {
    await sendAsTD(bot, '/fix restart');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Full System Restart Guide');
  });

  it('all 10 topics return non-empty responses', async () => {
    const topics = ['obs', 'atem', 'stream', 'audio', 'encoder', 'recording', 'companion', 'network', 'preservice', 'restart'];
    for (const topic of topics) {
      sent.length = 0;
      await sendAsTD(bot, `/fix ${topic}`);
      expect(sent.length, `no response for ${topic}`).toBe(1);
      expect(sent[0].text.length, `empty response for ${topic}`).toBeGreaterThan(50);
    }
  });

  it('/fix with no topic returns topic list', async () => {
    await sendAsTD(bot, '/fix');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Available troubleshooting guides');
    expect(sent[0].text).toContain('/fix obs');
    expect(sent[0].text).toContain('/fix atem');
    expect(sent[0].text).toContain('/fix restart');
  });

  it('/fix list returns topic list', async () => {
    await sendAsTD(bot, '/fix list');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Available troubleshooting guides');
    expect(sent[0].text).toContain('/fix obs');
  });

  it('/fix unknown-topic returns "not found" + topic list', async () => {
    await sendAsTD(bot, '/fix blender');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Unknown topic');
    expect(sent[0].text).toContain('blender');
    expect(sent[0].text).toContain('Available troubleshooting guides');
  });

  it('/fix is case-insensitive (/fix OBS works)', async () => {
    await sendAsTD(bot, '/fix OBS');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('OBS Connection Troubleshooting');
  });

  it('response includes title formatted with Markdown bold', async () => {
    await sendAsTD(bot, '/fix obs');
    expect(sent[0].text).toMatch(/^\*/); // starts with bold marker
    expect(sent[0].options?.parse_mode).toBe('Markdown');
  });

  it('response includes numbered steps', async () => {
    await sendAsTD(bot, '/fix obs');
    expect(sent[0].text).toMatch(/1\./);
    expect(sent[0].text).toMatch(/2\./);
    expect(sent[0].text).toMatch(/3\./);
  });

  it('/fix is available when church is identified (registered TD)', async () => {
    // sendAsTD uses td-user-1 which resolves to church-1
    await sendAsTD(bot, '/fix obs');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('OBS');
    // confirm it did NOT get the "not registered" message
    expect(sent[0].text).not.toContain('not registered');
  });

  it('/fix ATEM also works (mixed case)', async () => {
    await sendAsTD(bot, '/fix ATEM');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('ATEM Connection Troubleshooting');
  });

  it('/fix Restart works (capitalized)', async () => {
    await sendAsTD(bot, '/fix Restart');
    expect(sent.length).toBe(1);
    expect(sent[0].text).toContain('Full System Restart Guide');
  });
});
