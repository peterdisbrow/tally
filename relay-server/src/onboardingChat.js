/**
 * Onboarding Chat Engine — Conversational church setup via AI
 *
 * Replaces the 3-step wizard with an AI chatbot that asks about gear,
 * service times, TDs, and streaming, then does the setup automatically.
 */

const { v4: uuidv4 } = require('uuid');

// ─── CONSTANTS ───────────────────────────────────────────────────────────────

const STATES = ['intro', 'gear', 'schedule', 'tds', 'stream', 'review', 'complete'];

const DAY_MAP = {
  sunday: 0, sun: 0,
  monday: 1, mon: 1,
  tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3,
  thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5,
  saturday: 6, sat: 6,
};

const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// ─── SYSTEM PROMPT ───────────────────────────────────────────────────────────

function buildSystemPrompt(state, collectedData, scanResults) {
  return `You are TallyConnect's onboarding assistant — a friendly AV specialist helping a church set up their live production monitoring system.

## Your Role
You guide the user through setup by asking about their gear, service times, team, and streaming. You collect information conversationally and propose configuration actions for the user to confirm.

## Current State: ${state}
## Data Collected So Far: ${JSON.stringify(collectedData)}
## Network Scan Results: ${JSON.stringify(scanResults)}

## State Flow
Progress through these topics in order, but let the conversation flow naturally:
1. **gear** — What AV equipment they use (ATEM switcher, OBS, VideoHub, ProPresenter, PTZ cameras, encoders, Companion)
2. **schedule** — Service times (days, times, duration, labels)
3. **tds** — Technical directors / volunteers who run production
4. **stream** — Streaming platforms, expected viewers, operator experience level, backup gear

## Response Format
You MUST respond with valid JSON in this exact format:
\`\`\`json
{
  "reply": "Your conversational message to the user",
  "actions": [],
  "nextState": "${state}",
  "quickReplies": [],
  "progress": { "completed": [], "remaining": ["gear", "schedule", "tds", "stream"] }
}
\`\`\`

### Quick Replies
Suggest 2-4 tappable options when helpful. Examples:
- Gear question: ["ATEM Switcher", "OBS Studio", "ProPresenter", "vMix"]
- Schedule question: ["Sundays only", "Sundays + Midweek", "Multiple days"]
- Skip: ["Skip this section"]
Only include when choices are obvious. Omit for open-ended questions like "What's your ATEM IP?"

### Actions
When you have enough info to configure something, include an action:
\`\`\`json
{
  "type": "save_equipment",
  "data": { "atemHost": "192.168.1.240", "obsHost": "localhost", "obsPort": 4455 },
  "confirmLabel": "Equipment Setup",
  "confirmItems": ["ATEM Switcher: 192.168.1.240", "OBS: localhost:4455"]
}
\`\`\`

Action types:
- **save_equipment** — data: { atemHost, atemPort, obsHost, obsPort, videohubHost, videohubPort, proPresenterHost, proPresenterPort, encoderType, encoderHost, encoderPort, companionHost, companionPort }
  - encoderType values: "obs", "vmix", "blackmagic", "aja", "epiphan", "teradek", "tricaster", "birddog", "atem-streaming", "ecamm", "tally-encoder", "yolobox", "custom"
- **save_schedule** — data: { services: [{ day: "sunday", times: ["9:00 AM", "11:00 AM"], duration: 1.5, label: "Worship" }] }
- **save_engineer_profile** — data: { churchName, timezone, streamPlatform, expectedViewers, operatorLevel, backupEncoder, backupSwitcher, specialNotes }
  - streamPlatform: "youtube", "facebook", "both", "churchonline", "resi", "boxcast", "other"
  - expectedViewers: "<50", "50-200", "200-500", "500+"
  - operatorLevel: "volunteer", "intermediate", "pro"
  - backupEncoder/backupSwitcher: "yes" or "no"
- **save_tds** — data: { tds: [{ name, role, email, phone }] }
- **complete** — data: {}

### Rules
- Ask ONE topic per message. Don't overwhelm with questions.
- If scan results found devices, mention them: "I found an ATEM at 192.168.1.240 — want to use it?"
- Use smart defaults: OBS port 4455, ATEM port 9910, ProPresenter port 1025, Companion port 8888
- For schedule, accept natural language: "Sundays at 9 and 11, Wednesday night at 7"
- Parse times flexibly: "9", "9am", "9:00 AM", "9 o'clock" all mean 09:00
- Default service duration: 1.5 hours
- Default labels: "Worship" for Sunday, "Midweek" for weekdays, "Saturday Service" for Saturday
- Let users skip any section — if they say "skip", "none", "not yet", "we don't have that", "we don't stream", "in-house only", "monitoring only", or similar, mark that section done and move to the NEXT state immediately
- IMPORTANT: If a user says they don't stream, don't have streaming, use in-house monitoring only, or anything indicating no streaming — do NOT keep asking about streaming. Accept it, save the engineer profile with streamPlatform "none", and advance to review.
- IMPORTANT: If a user says they only have an ATEM (or only one piece of gear), accept it and move on. Don't keep asking about additional gear after they've answered.
- Be concise — church tech volunteers are busy
- On the intro state, greet them warmly and ask about their equipment first
- During the stream state, also ask about their operator experience level and expected viewer count — bundle this into the engineer profile action. If they said no streaming, skip this entirely.
- When all sections are done (or skipped), move to review state and propose the "complete" action
- NEVER re-ask a question the user has already answered. If they said "just the ATEM" for gear, don't ask about gear again.
- If a user wants to change something already configured, accept it naturally — emit a new action to overwrite
- Never ask for information you already have in "Data Collected So Far"`;
}

// ─── FALLBACK (NO API KEY) ───────────────────────────────────────────────────

const FALLBACK_FLOW = {
  intro: {
    reply: "Hi! I'm your TallyConnect setup assistant. Let's get your production monitoring configured. What AV equipment does your church use? (ATEM switcher, OBS, ProPresenter, etc.)",
    quickReplies: ['ATEM Switcher', 'OBS Studio', 'ProPresenter', 'vMix', 'Skip this section'],
    nextState: 'gear',
  },
  gear: {
    reply: "Got it! Now let's set up your service schedule. When are your services? (e.g., 'Sundays at 9 and 11, Wednesday at 7pm')",
    quickReplies: ['Sundays only', 'Sundays + Midweek', 'Skip this section'],
    nextState: 'schedule',
  },
  schedule: {
    reply: "Great! Do you have any technical directors or volunteers who run your production? If so, tell me their names and roles.",
    quickReplies: ['Just me', 'I have a team', 'Skip this section'],
    nextState: 'tds',
  },
  tds: {
    reply: "Almost done! What platform do you stream on? And roughly how many viewers do you get?",
    quickReplies: ['YouTube', 'Facebook', 'Both', "We don't stream", 'Skip this section'],
    nextState: 'stream',
  },
  stream: {
    reply: "You're all set! Click 'Complete Setup' below to finish and start monitoring.",
    quickReplies: [],
    nextState: 'review',
    actions: [{ type: 'complete', data: {}, confirmLabel: 'Complete Setup', confirmItems: ['Finish onboarding and start monitoring'] }],
  },
};

function fallbackResponse(state, message) {
  const step = FALLBACK_FLOW[state] || FALLBACK_FLOW.intro;
  const nextState = message.toLowerCase().includes('skip') ? step.nextState : state;
  // If user is providing info (not skipping), advance to next state
  const actualNext = (message.toLowerCase().includes('skip') || message === 'hi')
    ? step.nextState
    : step.nextState; // Always advance in fallback — the AI-powered version is smarter about this
  const flow = FALLBACK_FLOW[actualNext] || FALLBACK_FLOW[state] || step;
  return {
    reply: step.reply,
    actions: step.actions || [],
    nextState: step.nextState,
    quickReplies: step.quickReplies || [],
    progress: null,
  };
}

// ─── SCHEDULE PARSING ────────────────────────────────────────────────────────

/**
 * Parse AI-extracted schedule data into dual formats (portal + engine).
 * Input: { services: [{ day: "sunday", times: ["9:00 AM", "11:00 AM"], label: "Worship" }] }
 */
function parseScheduleToFormats(services) {
  const portalFormat = {};  // { sunday: [{ start, end, label }] }
  const engineFormat = [];  // [{ day, startHour, startMin, durationHours, label }]

  for (const svc of services) {
    const dayStr = (svc.day || '').toLowerCase().trim();
    const dayNum = DAY_MAP[dayStr];
    if (dayNum === undefined) continue;
    const dayName = DAY_NAMES[dayNum].toLowerCase();

    if (!portalFormat[dayName]) portalFormat[dayName] = [];

    const times = Array.isArray(svc.times) ? svc.times : [svc.times];
    const duration = svc.duration || 1.5;
    const label = svc.label || defaultLabel(dayNum);

    for (const timeStr of times) {
      const parsed = parseTimeString(timeStr);
      if (!parsed) continue;

      const { hour, minute } = parsed;
      const endMinutes = hour * 60 + minute + duration * 60;
      const endHour = Math.floor(endMinutes / 60);
      const endMin = Math.round(endMinutes % 60);

      portalFormat[dayName].push({
        start: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
        end: `${String(endHour).padStart(2, '0')}:${String(endMin).padStart(2, '0')}`,
        label: svc.perTimeLabels?.[timeStr] || label,
      });

      engineFormat.push({
        day: dayNum,
        startHour: hour,
        startMin: minute,
        durationHours: duration,
        label: svc.perTimeLabels?.[timeStr] || label,
      });
    }
  }

  return { portalFormat, engineFormat };
}

function parseTimeString(str) {
  if (!str) return null;
  const s = String(str).trim().toLowerCase().replace(/\s+/g, ' ');

  // "9:30 pm", "9:30pm", "9:30 PM"
  const full = s.match(/^(\d{1,2}):(\d{2})\s*(am|pm)?$/i);
  if (full) {
    let hour = parseInt(full[1], 10);
    const minute = parseInt(full[2], 10);
    const ampm = (full[3] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    return { hour, minute };
  }

  // "9 pm", "9pm", "9 AM", "11"
  const short = s.match(/^(\d{1,2})\s*(am|pm)?$/i);
  if (short) {
    let hour = parseInt(short[1], 10);
    const ampm = (short[2] || '').toLowerCase();
    if (ampm === 'pm' && hour < 12) hour += 12;
    if (ampm === 'am' && hour === 12) hour = 0;
    // If no am/pm and hour <= 6, assume PM (church services)
    if (!ampm && hour >= 1 && hour <= 6) hour += 12;
    return { hour, minute: 0 };
  }

  return null;
}

function defaultLabel(dayNum) {
  if (dayNum === 0) return 'Worship';
  if (dayNum === 6) return 'Saturday Service';
  return 'Midweek';
}

// ─── SESSION MANAGEMENT ──────────────────────────────────────────────────────

function ensureTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS onboarding_sessions (
      church_id TEXT PRIMARY KEY,
      state TEXT DEFAULT 'intro',
      collected_data TEXT DEFAULT '{}',
      scan_results TEXT DEFAULT '{}',
      started_at TEXT,
      updated_at TEXT
    )
  `);
}

function getSession(db, churchId) {
  const row = db.prepare('SELECT * FROM onboarding_sessions WHERE church_id = ?').get(churchId);
  if (!row) return null;
  return {
    churchId: row.church_id,
    state: row.state,
    collectedData: JSON.parse(row.collected_data || '{}'),
    scanResults: JSON.parse(row.scan_results || '{}'),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
  };
}

function createSession(db, churchId, scanResults = {}) {
  const now = new Date().toISOString();
  db.prepare(`
    INSERT OR REPLACE INTO onboarding_sessions (church_id, state, collected_data, scan_results, started_at, updated_at)
    VALUES (?, 'intro', '{}', ?, ?, ?)
  `).run(churchId, JSON.stringify(scanResults), now, now);
  return { churchId, state: 'intro', collectedData: {}, scanResults, startedAt: now, updatedAt: now };
}

function updateSession(db, churchId, state, collectedData) {
  const now = new Date().toISOString();
  db.prepare(`
    UPDATE onboarding_sessions SET state = ?, collected_data = ?, updated_at = ? WHERE church_id = ?
  `).run(state, JSON.stringify(collectedData), now, churchId);
}

// ─── AI CALL ─────────────────────────────────────────────────────────────────

async function callOnboardingAI(messages, systemPrompt) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null; // Signal to use fallback

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

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
        system: systemPrompt,
        messages,
        temperature: 0.3,
        max_tokens: 1024,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    const raw = data?.content?.[0]?.text?.trim();
    if (!raw) throw new Error('Empty response from AI');
    return raw;
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseAIResponse(raw) {
  try {
    return JSON.parse(raw);
  } catch {
    // Strip markdown code block if present
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    try {
      return JSON.parse(stripped);
    } catch {
      // Fallback: extract reply text
      return { reply: raw, actions: [], nextState: null, progress: null };
    }
  }
}

// ─── MAIN ENTRY POINT ────────────────────────────────────────────────────────

/**
 * Process an onboarding chat message.
 * @param {object} db - SQLite database
 * @param {string} churchId
 * @param {string} message - User's message
 * @param {object} scanResults - Network scan results { atem: [...], obs: [...], ... }
 * @param {object} chatEngine - ChatEngine instance for message history
 * @returns {{ reply: string, actions: Array, progress: object, quickReplies: string[] }}
 */
async function processOnboardingMessage(db, churchId, message, scanResults, chatEngine) {
  // Load or create session
  let session = getSession(db, churchId);
  if (!session) {
    session = createSession(db, churchId, scanResults || {});
  } else if (scanResults && Object.keys(scanResults).length > 0) {
    // Update scan results if new ones provided
    db.prepare('UPDATE onboarding_sessions SET scan_results = ? WHERE church_id = ?')
      .run(JSON.stringify(scanResults), churchId);
    session.scanResults = scanResults;
  }

  // Build conversation history — only from onboarding source (#16)
  const history = [];
  if (chatEngine) {
    try {
      const msgs = chatEngine.getMessages(churchId, { limit: 50 });
      const onboardingMsgs = msgs.filter(m => m.source === 'onboarding');
      // Take last 20 onboarding messages for context window
      const recent = onboardingMsgs.slice(-20);
      for (const m of recent) {
        history.push({
          role: m.sender_role === 'system' ? 'assistant' : 'user',
          content: m.message,
        });
      }
    } catch { /* chatEngine may not have getMessages — non-fatal */ }
  }

  // Add current message
  history.push({ role: 'user', content: message });

  // Build system prompt and call AI
  const systemPrompt = buildSystemPrompt(session.state, session.collectedData, session.scanResults);
  let parsed;

  const raw = await callOnboardingAI(history, systemPrompt);
  if (raw === null) {
    // No API key — use fallback (#1)
    parsed = fallbackResponse(session.state, message);
  } else {
    parsed = parseAIResponse(raw);
  }

  // Update session state
  let nextState = parsed.nextState || session.state;
  const collectedData = { ...session.collectedData };

  // ── Anti-loop safety valve ──
  // If we've been in the same state for 3+ turns, force-advance to next state
  const turnKey = `_turnsIn_${session.state}`;
  const turnsInState = (session.collectedData[turnKey] || 0) + 1;
  collectedData[turnKey] = turnsInState;
  if (nextState === session.state && turnsInState >= 3) {
    const stateIdx = STATES.indexOf(session.state);
    if (stateIdx >= 0 && stateIdx < STATES.length - 2) {
      nextState = STATES[stateIdx + 1];
      collectedData[turnKey] = 0;
    }
  }
  // Reset turn counter when state actually changes
  if (nextState !== session.state) {
    collectedData[turnKey] = 0;
  }

  // Merge any action data into collected data for context
  if (parsed.actions?.length > 0) {
    for (const action of parsed.actions) {
      if (action.type === 'save_equipment') collectedData.equipment = action.data;
      if (action.type === 'save_schedule') collectedData.schedule = action.data;
      if (action.type === 'save_tds') collectedData.tds = action.data;
      if (action.type === 'save_engineer_profile') collectedData.profile = action.data;
    }
  }

  updateSession(db, churchId, nextState, collectedData);

  // Compute progress
  const progress = parsed.progress || computeProgress(nextState, collectedData);

  return {
    reply: parsed.reply || 'I had trouble understanding that. Could you rephrase?',
    actions: parsed.actions || [],
    quickReplies: parsed.quickReplies || [],
    progress,
    state: nextState,
  };
}

function computeProgress(state, collectedData) {
  const sections = ['gear', 'schedule', 'tds', 'stream'];
  const completed = [];
  const remaining = [];

  for (const s of sections) {
    if (collectedData[s === 'gear' ? 'equipment' : s]) {
      completed.push(s);
    } else if (STATES.indexOf(s) < STATES.indexOf(state)) {
      completed.push(s); // passed through
    } else {
      remaining.push(s);
    }
  }

  return { completed, remaining };
}

// ─── ACTION EXECUTION ────────────────────────────────────────────────────────

/**
 * Execute a confirmed onboarding action.
 * Returns { ok, message, localConfig } where localConfig is the data the
 * Electron app should write to its local config file (#5).
 */
function executeOnboardingAction(db, churchId, action, churches, scheduleEngine) {
  const { type, data } = action;

  switch (type) {
    case 'save_equipment': {
      const updates = [];
      const params = [];
      const localConfig = {};

      if (data.atemHost) { updates.push('atem_host = ?'); params.push(data.atemHost); localConfig.atemIp = data.atemHost; }
      if (data.atemPort) { updates.push('atem_port = ?'); params.push(data.atemPort); }
      if (data.obsHost) { updates.push('obs_host = ?'); params.push(data.obsHost); }
      if (data.obsPort) { updates.push('obs_port = ?'); params.push(data.obsPort); }
      if (data.videohubHost) { updates.push('videohub_host = ?'); params.push(data.videohubHost); }
      if (data.videohubPort) { updates.push('videohub_port = ?'); params.push(data.videohubPort); }
      if (data.proPresenterHost) { updates.push('propresenter_host = ?'); params.push(data.proPresenterHost); }
      if (data.proPresenterPort) { updates.push('propresenter_port = ?'); params.push(data.proPresenterPort); }

      // Encoder config (#4)
      if (data.encoderType) localConfig.encoderType = data.encoderType;
      if (data.encoderHost) localConfig.encoderHost = data.encoderHost;
      if (data.encoderPort) localConfig.encoderPort = data.encoderPort;

      // Companion config
      if (data.companionHost) {
        const port = data.companionPort || 8888;
        localConfig.companionUrl = `http://${data.companionHost}:${port}`;
      }

      if (updates.length > 0) {
        params.push(churchId);
        db.prepare(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`).run(...params);
        const runtime = churches.get(churchId);
        if (runtime) {
          if (data.atemHost) runtime.atem_host = data.atemHost;
          if (data.obsHost) runtime.obs_host = data.obsHost;
        }
      }
      return { ok: true, message: 'Equipment configuration saved', localConfig };
    }

    case 'save_schedule': {
      const services = data.services || data;
      const { portalFormat, engineFormat } = parseScheduleToFormats(
        Array.isArray(services) ? services : [services]
      );

      db.prepare('UPDATE churches SET schedule = ? WHERE churchId = ?')
        .run(JSON.stringify(portalFormat), churchId);

      if (scheduleEngine) {
        scheduleEngine.setSchedule(churchId, engineFormat);
      }

      const runtime = churches.get(churchId);
      if (runtime) runtime.schedule = portalFormat;

      return { ok: true, message: 'Service schedule saved' };
    }

    case 'save_tds': {
      const tds = data.tds || [];
      let added = 0;
      for (const td of tds) {
        if (!td.name) continue;
        const id = uuidv4();
        try {
          db.prepare(`
            INSERT INTO church_tds (id, church_id, name, role, email, phone, registered_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)
          `).run(id, churchId, td.name, td.role || 'TD', td.email || null, td.phone || null, new Date().toISOString());
          added++;
        } catch { /* duplicate or missing table — non-fatal */ }
      }
      return { ok: true, message: `${added} team member${added !== 1 ? 's' : ''} added` };
    }

    case 'save_engineer_profile': {
      // Save churchName/timezone to churches table
      const updates = [];
      const params = [];
      if (data.churchName) { updates.push('name = ?'); params.push(data.churchName); }
      if (data.timezone) { updates.push('timezone = ?'); params.push(data.timezone); }

      // Save the full engineer profile JSON (#3)
      const profile = {};
      if (data.streamPlatform) profile.streamPlatform = data.streamPlatform;
      if (data.expectedViewers) profile.expectedViewers = data.expectedViewers;
      if (data.operatorLevel) profile.operatorLevel = data.operatorLevel;
      if (data.backupEncoder) profile.backupEncoder = data.backupEncoder;
      if (data.backupSwitcher) profile.backupSwitcher = data.backupSwitcher;
      if (data.specialNotes) profile.specialNotes = data.specialNotes;

      if (Object.keys(profile).length > 0) {
        updates.push('engineer_profile = ?');
        params.push(JSON.stringify(profile));
      }

      if (updates.length > 0) {
        params.push(churchId);
        db.prepare(`UPDATE churches SET ${updates.join(', ')} WHERE churchId = ?`).run(...params);
      }

      // Return localConfig with name for Electron display
      const localConfig = {};
      if (data.churchName) localConfig.name = data.churchName;
      return { ok: true, message: 'Profile saved', localConfig };
    }

    case 'complete': {
      db.prepare('UPDATE onboarding_sessions SET state = ? WHERE church_id = ?')
        .run('complete', churchId);
      return { ok: true, message: 'Onboarding complete! Welcome to TallyConnect.' };
    }

    default:
      return { ok: false, message: `Unknown action type: ${type}` };
  }
}

// ─── EXPORTS ─────────────────────────────────────────────────────────────────

module.exports = {
  ensureTable,
  getSession,
  createSession,
  processOnboardingMessage,
  executeOnboardingAction,
  parseScheduleToFormats,
  parseTimeString,
  // For testing
  buildSystemPrompt,
  parseAIResponse,
  computeProgress,
  fallbackResponse,
  STATES,
  FALLBACK_FLOW,
};
