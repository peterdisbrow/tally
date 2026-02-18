# Tally
> Remote production monitoring for churches. Built on Blackmagic. Controlled from your phone.
Remote monitoring and control of church production systems, built for [ATEM School](https://atemschool.com).

## Architecture

```
Andrew's Telegram
      │
OpenClaw Skill (church-av) — Natural language parsing
      │
      ▼
Relay Server (Railway/Docker) ← SQLite persistence, rate limiting, message queue
      │                         
      ▼                         
Church Client App (Mac/Win)     
      ├── ATEM Switcher (atem-connection)
      ├── OBS Studio (obs-websocket-js) + Screenshot preview
      ├── Bitfocus Companion (HTTP API) — 600+ device types
      ├── HyperDeck control (via ATEM)
      ├── PTZ camera control (via ATEM)
      └── Reports status + accepts commands + sends preview frames
```

## Components

| Folder | What it is |
|--------|-----------|
| `relay-server/` | Node.js WebSocket hub — deploy to Railway or Docker |
| `church-client/` | Node.js agent churches install via npx |
| `electron-app/` | Desktop app with setup wizard (Mac .dmg / Win .exe) |
| `../skills/church-av/` | OpenClaw skill for Telegram control |
| `test/` | Integration test suite |

---

## Quick Start

### 1. Deploy the Relay Server

#### Railway (recommended)
1. Push `relay-server/` to GitHub
2. Railway → New Project → Deploy from GitHub
3. Set environment variables:
   ```
   ADMIN_API_KEY=your-secret-admin-key
   JWT_SECRET=your-secret-jwt-key
   ```

#### Docker
```bash
cd relay-server
docker build -t tally-relay .
docker run -p 3000:3000 -e ADMIN_API_KEY=yourkey -e JWT_SECRET=yoursecret -v ./data:/app/data tally-relay
```

#### Manual
```bash
cd relay-server
npm install
ADMIN_API_KEY=yourkey JWT_SECRET=yoursecret node server.js
```

### 2. Register a Church
```bash
curl -X POST https://your-relay/api/churches/register \
  -H "x-api-key: YOUR_ADMIN_KEY" \
  -H "Content-Type: application/json" \
  -d '{"name": "First Baptist", "email": "av@firstbaptist.org"}'
```

### 3. Church Installation

#### Option A: npx (instant)
```bash
npx tally-connect --token THEIR_TOKEN --atem 192.168.1.10
```

#### Option B: Desktop App
```bash
cd electron-app && npm install && npm run build:mac
```
Church downloads → runs setup wizard → enters token and ATEM IP → done.

---

## Commands Reference

### ATEM Switcher
| Command | Description |
|---------|------------|
| `atem.cut` | Cut transition (params: `me`, `input`) |
| `atem.auto` | Auto/mix transition |
| `atem.setProgram` | Set program input (params: `input`) |
| `atem.setPreview` | Set preview input (params: `input`) |
| `atem.startRecording` | Start ATEM recording |
| `atem.stopRecording` | Stop ATEM recording |
| `atem.fadeToBlack` | Toggle fade to black |

### HyperDeck
| Command | Description |
|---------|------------|
| `hyperdeck.play` | Start playback |
| `hyperdeck.stop` | Stop playback |
| `hyperdeck.record` | Start recording |
| `hyperdeck.stopRecord` | Stop recording |
| `hyperdeck.nextClip` | Next clip |
| `hyperdeck.prevClip` | Previous clip |

### PTZ Camera
| Command | Description |
|---------|------------|
| `ptz.pan` | Pan (params: `camera`, `speed` -1.0 to 1.0) |
| `ptz.tilt` | Tilt (params: `camera`, `speed`) |
| `ptz.zoom` | Zoom (params: `camera`, `speed`) |
| `ptz.preset` | Recall preset (params: `camera`, `preset` 1-6) |

### OBS Studio
| Command | Description |
|---------|------------|
| `obs.startStream` | Start streaming |
| `obs.stopStream` | Stop streaming |
| `obs.startRecording` | Start OBS recording |
| `obs.stopRecording` | Stop OBS recording |
| `obs.setScene` | Switch scene (params: `scene`) |

### Preview Screenshots
| Command | Description |
|---------|------------|
| `preview.start` | Start periodic screenshots (params: `intervalMs`, default 5000) |
| `preview.stop` | Stop preview |
| `preview.snap` | One-shot screenshot |

Screenshots are 720×405 JPEG, ~4-6KB each, sent through existing WebSocket relay. No streaming infrastructure needed.

### Bitfocus Companion
| Command | Description |
|---------|------------|
| `companion.press` | Press button by location (params: `page`, `row`, `col`) |
| `companion.pressNamed` | Press button by label (params: `name`, fuzzy match) |
| `companion.getGrid` | Get button grid for a page |
| `companion.connections` | List all Companion connections |

### System
| Command | Description |
|---------|------------|
| `status` | Get full system status |
| `system.preServiceCheck` | Run pre-service checklist |

---

## Companion Integration

[Bitfocus Companion](https://bitfocus.io/companion) supports 600+ device types. Tally uses Companion as a universal control layer:

- **Any ATEM command** (including models not directly supported)
- **ProPresenter** slide advance, go to slide, clear
- **Dante/audio consoles** — mute/unmute, recall snapshots
- **Lighting boards** — trigger cues, blackout
- **PTZ cameras** — via Companion's PTZ modules (more protocols than direct ATEM control)
- **Media servers** — ProVideoPlayer, Resolume, etc.
- **NDI routing** — switch sources
- **Custom macros** — chain multiple actions into one button

### Setup
1. Configure your devices in Companion as normal
2. Create buttons for remote-triggerable actions
3. Tally calls Companion's HTTP API to press buttons
4. Default: `http://localhost:8888` (change with `--companion` flag)

### Remote Usage
```
"press Go Live in Companion"         → finds and presses button labeled "Go Live"
"trigger Bumper on Companion"        → presses the "Bumper" button
"press button 1 2 3"                 → presses page 1, row 2, col 3
"list Companion connections"         → shows configured devices
```

---

## Natural Language (via Telegram)

Just talk naturally:
- "cut to camera 3 at First Baptist"
- "start recording" / "stop the stream"
- "show me First Baptist" (screenshot preview)
- "play the bumper at [church]"
- "run pre-service check"
- "press 'Go Live' in Companion"
- "list churches" / "how's First Baptist doing"
- "fade to black" / "ftb"

Church names are fuzzy-matched — "first bapt" finds "First Baptist Church".

---

## Relay Server Features

- **SQLite persistence** — churches survive restarts
- **Rate limiting** — 10 commands/second per church (token bucket)
- **Message queue** — buffers up to 10 commands during brief disconnects (<30s)
- **CORS headers** — ready for dashboard integration
- **Connection logging** — timestamped connect/disconnect events
- **Health endpoint** — `GET /api/health` returns uptime, stats

---

## Desktop App Features

- **Setup Wizard** — 5-step guided configuration
- **System tray** — color-coded status (grey/green/yellow/red)
- **Live dashboard** — ATEM inputs, OBS stream, Companion status, alerts
- **Preview thumbnail** — periodic JPEG screenshots from OBS
- **Native notifications** — ATEM disconnect, stream drop, low FPS
- **Auto-update** — checks GitHub releases (electron-updater)
- **Watch Live button** — opens YouTube/Facebook stream URL

---

## Running Tests

```bash
cd relay-server && npm install
cd ../test
node integration.js
```

---

## CLI Flags (Church Client)

```
--token, -t          Connection token (required)
--relay, -r          Relay server URL (default: wss://tally-relay.up.railway.app)
--atem, -a           ATEM switcher IP
--obs, -o            OBS WebSocket URL (default: ws://localhost:4455)
--obs-password, -p   OBS WebSocket password
--name, -n           System label (e.g., "Main Sanctuary")
--companion, -c      Companion HTTP API URL (default: http://localhost:8888)
--preview-source     OBS source name for preview screenshots (default: current program)
--config             Config file path (default: ~/.church-av/config.json)
```

---

## Business Model Options

1. **Included with ATEM School membership** — drives membership value
2. **Add-on service** — $X/month per church for remote monitoring
3. **Sold to integrators** — package as part of installation service
4. **White-label** — license to other AV integrators

---

## TD Telegram Bot

Church Technical Directors can control their production system by messaging the Tally Telegram bot — natural language commands like "cut to camera 3" or "start stream."

### Setup

1. **Create a Telegram bot** — Message [@BotFather](https://t.me/BotFather) on Telegram, `/newbot`, name it "Tally" (or your branding). Copy the bot token.

2. **Configure environment variables** on your relay server (Railway):
   ```
   TALLY_BOT_TOKEN=123456:ABC-DEF...
   TALLY_BOT_WEBHOOK_URL=https://your-relay.up.railway.app/api/telegram-webhook
   ANDREW_TELEGRAM_CHAT_ID=your_chat_id
   ```

3. **Set the webhook** — After deploying, call:
   ```
   POST /api/bot/set-webhook
   x-api-key: YOUR_ADMIN_KEY
   ```
   Or it auto-sets on startup if `TALLY_BOT_WEBHOOK_URL` is configured.

4. **Give TDs their registration code** — Each church gets a unique 6-character code:
   ```
   GET /api/churches/{churchId}
   → { "registrationCode": "A1B2C3", ... }
   ```

5. **TD registers themselves** — They message the bot:
   ```
   /register A1B2C3
   ```
   That's it. They can now send commands scoped to their church.

### Video Hub Support

Church clients support Blackmagic Video Hub routers. Add to the client config (`~/.church-av/config.json`):
```json
{
  "videoHubs": [
    { "ip": "192.168.1.50", "name": "Main Router" }
  ]
}
```

TDs can then say "route camera 2 to monitor 3" or "show routing" via the bot.
