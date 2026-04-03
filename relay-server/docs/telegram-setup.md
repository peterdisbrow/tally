# Telegram Bot Setup Guide

**Tally Connect · @TallyConnectBot**

Tally Connect uses Telegram as its primary alert and control channel. Your Technical Director gets real-time alerts on their phone, can run commands from anywhere in the building, and can check system status without opening a laptop.

---

## Why Telegram

- **Real-time delivery** — alerts arrive in seconds, not minutes
- **Reliable on church WiFi** — Telegram works even on congested networks where email is slow
- **Team coordination** — multiple TDs can be registered to the same church; everyone sees alerts
- **Two-way control** — TDs can send commands back to the system (cut to camera, check status, run a pre-service check) directly from the chat
- **Free** — no cost beyond your Tally Connect subscription

---

## Registering as a Technical Director

### Option A — Invite link (recommended)

Your church administrator generates an invite link from the Tally portal:

1. In the portal, go to **Team → Copy Invite Link**
2. Share the link with your TD via group chat, email, or SMS
3. The TD taps the link on their phone — it opens Telegram and pre-fills the registration command
4. The TD taps **Start** — they're registered automatically

### Option B — Manual registration

1. Open Telegram and search for **@TallyConnectBot**
2. Tap **Start** (or send `/start`)
3. Send: `/register YOUR_CODE`
   - Use the 6-character code from your welcome email
   - Codes are uppercase (e.g., `/register ABC123`)
4. The bot confirms your registration with your church name

### Guest registration

For visiting or temporary TDs, the admin generates a 24-hour guest token:

```
guest [church name]    ← admin sends this to the bot
```

The bot returns a token like `GUEST-A1B2C3`. Share it with the visitor:
```
/register GUEST-A1B2C3
```

Guest TDs have a limited command set (status, basic ATEM cuts, PTZ presets) and their access expires automatically after 24 hours.

---

## Understanding Role-Based Access

Tally Connect has three roles. The bot automatically shows the right help text and enforces limits for each.

### Registered TD

Full access to all device commands for your church's equipment:
- ATEM control (cuts, transitions, macros, DSK, aux routing)
- OBS control (start/stop stream, switch scene)
- PTZ camera control (presets, pan/tilt/zoom)
- Camera parameter control (iris, gain, white balance, shutter, focus)
- HyperDeck transport control
- ProPresenter slide control
- Mixer control
- Companion button triggers
- VideoHub routing
- Pre-service check, status, history

### Guest TD

Limited command set for visiting or temporary operators:
- Status overview
- Pre-service check
- Basic ATEM cuts and fade to black
- OBS start/stop stream and scene switching
- PTZ preset recall and home

### Admin (Andrew)

Admin sees additional commands for managing multiple churches:
- `at [Church Name]: [command]` — send a command to any church
- `msg [Church Name] [message]` — post to a church's team chat
- `guest [church name]` — generate a guest token
- `revoke guest [GUEST-TOKEN]` — revoke a guest token
- `list guests` — show active guest tokens
- `set oncall [church] [TD name]` — change the on-call TD
- `list tds [church]` — list TDs for a church
- `sync planning center [church name]` — pull schedule from Planning Center

---

## Setting Up Alert Preferences

Tally sends three alert levels:

| Level | Emoji | Meaning |
|-------|-------|---------|
| Warning | 🟡 | Something needs attention; service not yet impacted |
| Critical | 🔴 | Service-impacting issue (stream down, ATEM disconnected) |
| Recovery | ✅ | Issue was resolved (automatically or manually) |

**Escalation:** If a Critical alert arrives and no response is received within 90 seconds, it escalates to Andrew automatically.

Alert preferences (which device categories trigger alerts, minimum severity) are configured in the Tally portal under **Settings → Alerts**. Changes take effect immediately — no app restart needed.

---

## Core Commands

### `/status` — system health overview

Returns a snapshot of everything Tally is monitoring:
- ATEM connection state and current program/preview inputs
- OBS connection state and active scene
- Stream status (live / offline)
- Recording status
- Any active warnings or incidents

```
/status
```

### `/help` — command reference

Returns the full command list for your role. Registered TDs see all device commands; guest TDs see the limited set; unregistered users see onboarding instructions.

```
/help
```

### `/history` — last 10 commands

Shows the 10 most recent commands sent by anyone at your church, with timestamps. Useful for reviewing what happened during a service.

```
/history
```

### `pre-service check` — run all checks

Triggers the pre-service check immediately. Tally also runs this automatically 30 minutes before each scheduled service.

```
pre-service check
```

Returns a pass/fail for each check item (ATEM connected, OBS connected, stream key valid, recording drive space, cameras responding, ProPresenter loaded).

### `/menu` — quick-access keyboard

Displays a persistent button keyboard in Telegram with common commands. Tap buttons instead of typing.

```
/menu
```

To remove the keyboard:
```
/hidemenu
```

### `/fix [topic]` — inline troubleshooting guides

Returns a step-by-step troubleshooting guide for common issues:

```
/fix obs        — OBS connection issues
/fix atem       — ATEM switcher connection
/fix stream     — Stream not working
/fix audio      — Audio problems
/fix encoder    — Encoder issues
/fix recording  — Recording problems
/fix companion  — Companion connection
/fix network    — General network issues
/fix preservice — Pre-service checklist
/fix restart    — Full system restart sequence
```

Just send `/fix` with no argument to see the full list.

---

## ATEM Commands

| Message | Action |
|---------|--------|
| `cut to camera 2` | Cut to input 2 on Program |
| `camera 3 to preview` | Set input 3 on Preview |
| `auto transition` or `take` | Fire the auto transition |
| `fade to black` or `ftb` | Fade to black |
| `start recording` | Start recording |
| `stop recording` | Stop recording |
| `run macro 3` | Run ATEM macro index 3 |
| `set aux 1 to camera 4` | Route input 4 to Aux 1 |
| `dsk 1 on` / `dsk 1 off` | Put DSK 1 on/off air |

---

## OBS Commands

| Message | Action |
|---------|--------|
| `start stream` | Start the OBS stream |
| `stop stream` | Stop the OBS stream |
| `switch to scene [name]` | Switch to a named OBS scene |
| `show me what's on screen` | Get a preview screenshot |

---

## PTZ Camera Commands

| Message | Action |
|---------|--------|
| `ptz 1 preset 3` | Recall preset 3 on PTZ camera 1 |
| `ptz 1 home` | Move PTZ 1 to home position |
| `ptz 1 pan left` / `ptz 1 pan right` | Pan left or right |
| `ptz 1 tilt up` / `ptz 1 tilt down` | Tilt up or down |
| `ptz 1 zoom in` / `ptz 1 zoom out` | Zoom in or out |
| `ptz 1 stop` | Stop all PTZ movement |

---

## Custom Macros

Macros let you create a single command that runs multiple device steps in sequence. Macros are created in the Tally portal under **Settings → Macros**.

**Example macro:** `/preservice`
1. Cut to Camera 1
2. Fade up OBS stream
3. Start recording

**To use a macro:**
```
/macroname     ← just the macro name as a slash command
```

**To list your church's macros:**
```
/macros
```

Macro steps execute with a 1-second delay between each to avoid overwhelming devices.

---

## Safety Confirmations

Commands that could interrupt a live service require an inline confirmation before executing:

- Stop stream
- Stop recording
- Fade to black
- Mute all
- Restart encoder

When you send one of these commands, the bot replies with **Confirm / Cancel** buttons. You must tap **Confirm** within the timeout window or the command is cancelled.

---

## On-Call Rotation

If your church has multiple TDs on rotation, Tally routes alerts to whoever is on call that week. The admin can update the on-call TD at any time:

```
set oncall [church name] [TD name]
```

TDs can also swap shifts themselves. When a swap is pending, the incoming TD receives a confirmation request and replies:

```
/confirmswap
```

---

## Troubleshooting

### Bot not responding

1. Make sure you're messaging **@TallyConnectBot** — search for it by username, not display name
2. Send `/start` first; if the bot hasn't seen you before, it needs the start command to activate the chat
3. If you're already registered but messages aren't getting through, send `/status` — if the bot responds to that but not to other commands, check your message for typos
4. Check your internet connection — Telegram requires an active connection to deliver messages

### Messages not arriving / alerts not showing up

1. Confirm your TD is registered: have them send `/status` to the bot — if it returns church data, they're registered
2. Check Telegram notification settings — make sure the Tally bot chat is not muted (tap the chat name → Notifications → Unmute)
3. On iOS: Settings → Telegram → Notifications → make sure notifications are enabled
4. On Android: Settings → Apps → Telegram → Notifications → make sure notifications are on
5. Check that the Tally app is running on the booth computer — if the app is closed, no alerts are generated

### "You're not registered yet"

Send `/register YOUR_CODE` where `YOUR_CODE` is the 6-character code from your welcome email. If you don't have a code, ask your church administrator or email support@tallyconnect.app.

### Registration code not working

1. Codes are case-insensitive but must be exactly 6 characters (e.g., `ABC123`)
2. Codes don't expire, but they can only register up to the seat limit on your plan
3. If you get "invalid code," double-check with your administrator that you have the right code for your church (multi-campus organizations have separate codes per campus)

### Guest token expired

Guest tokens expire after 24 hours. Ask your administrator to generate a new one:
```
guest [church name]
```

### Commands work but risky ones are ignored

Stop stream, stop recording, fade to black, and similar commands require an inline confirmation. Look for the **Confirm / Cancel** buttons the bot sends in reply — you must tap **Confirm** within 30 seconds.

---

## Getting Help

- **Email:** support@tallyconnect.app
- **Telegram:** Send `/help` to @TallyConnectBot for the full command reference
- **Documentation:** tallyconnect.app/docs
