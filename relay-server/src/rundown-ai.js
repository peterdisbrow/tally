/**
 * Rundown AI — Natural language → structured cue list.
 *
 * Uses the same Anthropic API as ai-parser.js but with a specialized
 * prompt that converts freeform rundown descriptions into cue arrays
 * compatible with the scheduler engine.
 *
 * Usage:
 *   const { parseRundownDescription } = require('./rundown-ai');
 *   const result = await parseRundownDescription(text, ctx);
 *   // result: { name, service_day, auto_activate, cues: [...] }
 */

const { getAvailableCommandNames } = require('./ai-parser');

// ─── Anthropic API call (same as ai-parser.js) ─────────────────────────────

async function callAnthropic(messages, timeout = 20000, systemPrompt = '') {
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
        system: systemPrompt,
        messages,
        temperature: 0.1,
        max_tokens: 4096,
      }),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const body = await resp.text();
      throw new Error(`Anthropic API ${resp.status}: ${body.slice(0, 200)}`);
    }

    const data = await resp.json();
    return { text: data?.content?.[0]?.text?.trim() || '', usage: data.usage || null };
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseJSON(raw) {
  try { return JSON.parse(raw); } catch {
    const stripped = raw.replace(/^```json\s*/i, '').replace(/```\s*$/, '').trim();
    return JSON.parse(stripped);
  }
}

// ─── Day name → number mapping ──────────────────────────────────────────────

const DAY_MAP = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2,
  wednesday: 3, wed: 3, thursday: 4, thu: 4, thur: 4, thurs: 4,
  friday: 5, fri: 5, saturday: 6, sat: 6,
};

function parseDayOfWeek(text) {
  const lower = text.toLowerCase();
  for (const [name, num] of Object.entries(DAY_MAP)) {
    if (lower.includes(name)) return num;
  }
  return null;
}

// ─── Build the rundown parsing prompt ───────────────────────────────────────

function buildRundownPrompt(ctx = {}) {
  const commands = getAvailableCommandNames();
  // Group by device prefix for the prompt
  const commandsByDevice = {};
  for (const cmd of commands) {
    const [device] = cmd.split('.');
    if (!commandsByDevice[device]) commandsByDevice[device] = [];
    commandsByDevice[device].push(cmd);
  }
  const cmdList = Object.entries(commandsByDevice)
    .map(([device, cmds]) => `${device}: ${cmds.join(', ')}`)
    .join('\n');

  let deviceContext = '';
  if (ctx.status) {
    const s = ctx.status;
    if (s.atem?.connected) deviceContext += 'ATEM connected. ';
    if (s.obs?.connected) deviceContext += 'OBS connected. ';
    if (s.vmix?.connected) deviceContext += 'vMix connected. ';
    if (s.encoder?.connected) deviceContext += 'Encoder connected. ';
    if (s.proPresenter?.connected) deviceContext += 'ProPresenter connected. ';
    if (s.mixer?.connected) deviceContext += `Audio mixer (${s.mixer.type || 'unknown'}) connected. `;
    if (s.companion?.connected) deviceContext += 'Companion connected. ';
  }

  return `You are a church production AI that converts natural language service rundown descriptions into structured cue lists.

CONTEXT:
Church: ${ctx.churchName || 'Unknown'}
${deviceContext ? `Connected devices: ${deviceContext}` : 'Devices: assume ATEM + OBS available.'}

AVAILABLE COMMANDS:
${cmdList}

TRIGGER TYPES:
- manual: TD must press "Go" to fire (default, safest)
- time_absolute: fires at a specific time, format "HH:MM" (24h)
- time_relative: fires N minutes after service start, field "offsetMinutes"
- delay: fires N seconds after previous cue, field "delaySeconds"
- event: fires on external event. Subtypes:
  - propresenter_slide_change: fires when a slide/presentation matches. Config: { presentationPattern: "worship" }
  - equipment_state_match: fires when equipment matches. Config: { conditions: { "atem.streaming": true } }

OUTPUT FORMAT — return ONLY valid JSON, no markdown:
{
  "name": "Sunday Morning Rundown",
  "service_day": 0,
  "auto_activate": true,
  "cues": [
    {
      "label": "Start Recording",
      "notes": "Optional notes for the TD",
      "trigger": { "type": "time_absolute", "time": "09:55" },
      "commands": [
        { "command": "obs.startRecording", "params": {} }
      ]
    },
    {
      "label": "Worship — Camera 1",
      "trigger": {
        "type": "event",
        "event": { "type": "propresenter_slide_change", "config": { "presentationPattern": "worship" } }
      },
      "commands": [
        { "command": "atem.cut", "params": { "input": 1 } }
      ]
    },
    {
      "label": "Go Live",
      "trigger": { "type": "manual" },
      "commands": [
        { "command": "obs.startStream", "params": {} }
      ]
    }
  ]
}

RULES:
1. Use ONLY commands from the AVAILABLE COMMANDS list. Do NOT invent commands.
2. "start recording" → obs.startRecording or atem.startRecording based on connected devices.
3. "switch to cam N" / "cam N" → atem.cut with input N, or atem.auto for smooth transitions.
4. "go live" / "start streaming" → obs.startStream or encoder.startStream based on connected devices.
5. "fade to black" → atem.fadeToBlack. Mark dangerous commands (stop stream, fade to black) as manual trigger unless explicitly requested as auto.
6. Default to manual trigger when no timing/event info is given for a cue.
7. service_day: 0=Sunday, 1=Monday, ..., 6=Saturday. Infer from the rundown name or context. Default to 0 (Sunday).
8. auto_activate: set true if user says "auto" or implies automatic start. Default false.
9. A cue can have multiple commands. Group related actions (e.g., "start recording and switch to cam 1").
10. "after N seconds" / "wait N seconds then" → delay trigger with delaySeconds.
11. "N minutes into service" / "at +N min" → time_relative with offsetMinutes.
12. "at 9:55" / "at 10am" → time_absolute with 24h time string.
13. "when worship starts" / "when slides say X" → event trigger with propresenter_slide_change.
14. Keep label short (2-5 words). Add notes for details.
15. If the description is unclear, make reasonable assumptions for a typical church service.`;
}

// ─── Main parse function ────────────────────────────────────────────────────

/**
 * Parse a natural language rundown description into structured cues.
 *
 * @param {string} text — the TD's message describing the rundown
 * @param {object} [ctx] — church context (name, status, etc.)
 * @returns {Promise<{ name, service_day, auto_activate, cues: Array }>}
 */
async function parseRundownDescription(text, ctx = {}) {
  const systemPrompt = buildRundownPrompt(ctx);

  console.log(`[rundown-ai] Parsing rundown description: "${text.slice(0, 80)}"`);

  const { text: raw, usage } = await callAnthropic(
    [{ role: 'user', content: text }],
    20000,
    systemPrompt
  );

  console.log(`[rundown-ai] Raw response: ${raw.slice(0, 300)}`);

  const parsed = parseJSON(raw);

  // Validate structure
  if (!parsed.name) parsed.name = 'New Rundown';
  if (!Array.isArray(parsed.cues) || parsed.cues.length === 0) {
    throw new Error('AI returned no cues. Try describing your rundown more specifically.');
  }

  // Validate commands exist
  const availableCommands = getAvailableCommandNames();
  for (const cue of parsed.cues) {
    if (!cue.label) cue.label = 'Untitled Cue';
    if (!cue.trigger) cue.trigger = { type: 'manual' };
    if (!cue.commands) cue.commands = [];

    // Filter out hallucinated commands
    cue.commands = cue.commands.filter(cmd => {
      if (!cmd.command) return false;
      if (availableCommands.includes(cmd.command)) return true;
      console.warn(`[rundown-ai] Filtered out hallucinated command: ${cmd.command}`);
      return false;
    });
  }

  // Remove empty cues (no commands and no notes)
  parsed.cues = parsed.cues.filter(cue => cue.commands.length > 0 || cue.notes);

  if (parsed.cues.length === 0) {
    throw new Error('No valid cues could be created. The commands might not match your connected devices.');
  }

  // Normalize service_day
  if (parsed.service_day === undefined || parsed.service_day === null) {
    // Try to infer from name or original text
    const day = parseDayOfWeek(text) ?? parseDayOfWeek(parsed.name) ?? 0;
    parsed.service_day = day;
  }

  if (parsed.auto_activate === undefined) parsed.auto_activate = false;

  console.log(`[rundown-ai] ✓ Parsed "${parsed.name}" with ${parsed.cues.length} cues (day=${parsed.service_day}, auto=${parsed.auto_activate})`);

  return {
    name: parsed.name,
    service_day: parsed.service_day,
    auto_activate: !!parsed.auto_activate,
    cues: parsed.cues,
    _usage: usage,
  };
}

/**
 * Parse a natural language edit instruction and apply it to existing cues.
 *
 * @param {string} editText — e.g. "move cue 3 to after cue 1" or "change cam 1 to cam 2 in cue 4"
 * @param {Array} currentCues — the existing cue list
 * @param {object} [ctx] — church context
 * @returns {Promise<{ cues: Array, description: string }>}
 */
async function editRundownCues(editText, currentCues, ctx = {}) {
  const availableCommands = getAvailableCommandNames();

  const systemPrompt = `You are editing an existing church service rundown. You'll receive the current cue list and an edit instruction.
Return the COMPLETE updated cue list as JSON, plus a short description of what changed.

AVAILABLE COMMANDS: ${availableCommands.join(', ')}

TRIGGER TYPES: manual, time_absolute (time:"HH:MM"), time_relative (offsetMinutes:N), delay (delaySeconds:N), event (event:{type,config})

OUTPUT FORMAT — return ONLY valid JSON:
{
  "cues": [...updated complete cue list...],
  "description": "Moved cue 3 to position 2"
}

RULES:
- Return ALL cues, not just the changed ones.
- Preserve cues that weren't mentioned in the edit.
- "remove cue N" → delete it from the list.
- "add a cue" → insert at the specified position or at the end.
- "make cue N manual/auto/timed" → change its trigger type.
- "swap cue N and M" → swap their positions.`;

  const userMessage = `Current cues:\n${JSON.stringify(currentCues, null, 2)}\n\nEdit instruction: ${editText}`;

  const { text: raw } = await callAnthropic(
    [{ role: 'user', content: userMessage }],
    15000,
    systemPrompt
  );

  const parsed = parseJSON(raw);

  if (!Array.isArray(parsed.cues)) throw new Error('AI returned invalid edit result.');

  // Validate commands
  for (const cue of parsed.cues) {
    if (!cue.trigger) cue.trigger = { type: 'manual' };
    if (!cue.commands) cue.commands = [];
    cue.commands = cue.commands.filter(cmd => cmd.command && availableCommands.includes(cmd.command));
  }

  return {
    cues: parsed.cues,
    description: parsed.description || 'Rundown updated',
  };
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

const TRIGGER_ICONS = { manual: '✋', time_absolute: '🕐', time_relative: '⏱', delay: '⏳', event: '⚡' };
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

/**
 * Format a parsed rundown as a Telegram-friendly summary for confirmation.
 */
function formatRundownPreview(parsed) {
  const lines = [];
  lines.push(`📋 *${escapeMarkdown(parsed.name)}*`);
  lines.push(`📅 ${DAY_NAMES[parsed.service_day] || 'Sunday'}${parsed.auto_activate ? ' (auto-start)' : ''}`);
  lines.push('');

  parsed.cues.forEach((cue, i) => {
    const trigger = cue.trigger || { type: 'manual' };
    const icon = TRIGGER_ICONS[trigger.type] || '✋';
    let triggerDesc = 'manual';
    if (trigger.type === 'time_absolute') triggerDesc = `at ${trigger.time}`;
    if (trigger.type === 'time_relative') triggerDesc = `+${trigger.offsetMinutes}min`;
    if (trigger.type === 'delay') triggerDesc = `${trigger.delaySeconds}s delay`;
    if (trigger.type === 'event') triggerDesc = trigger.event?.type === 'propresenter_slide_change'
      ? `slide: "${trigger.event.config?.presentationPattern || '*'}"` : 'event';

    const cmdCount = (cue.commands || []).length;
    const cmdList = (cue.commands || []).map(c => `\`${c.command}\``).join(', ');

    lines.push(`${i + 1}. ${icon} *${escapeMarkdown(cue.label)}* — ${triggerDesc}`);
    if (cmdCount > 0) lines.push(`   ${cmdList}`);
    if (cue.notes) lines.push(`   _${escapeMarkdown(cue.notes)}_`);
  });

  lines.push('');
  lines.push('Reply:');
  lines.push('• `save` — save this rundown');
  lines.push('• `edit [instruction]` — modify cues');
  lines.push('• `cancel` — discard');

  return lines.join('\n');
}

function escapeMarkdown(text) {
  return String(text).replace(/([_*\[\]()~`>#+\-=|{}.!])/g, '\\$1');
}

module.exports = {
  parseRundownDescription,
  editRundownCues,
  formatRundownPreview,
  parseDayOfWeek,
  DAY_NAMES,
};
