# Tally Connect

> Remote production monitoring for churches. Built on Blackmagic. Controlled from your phone.

Tally Connect gives church production teams and technical directors real-time visibility into their AV systems — ATEM switcher, OBS, ProPresenter, PTZ cameras, audio, and more — all from a single dashboard, with remote control from anywhere.

Release history: see [CHANGELOG.md](./CHANGELOG.md).

---

## Architecture

```
Tally Connect Relay (Railway / Docker)
      │  SQLite persistence · rate limiting · message queue
      │
      ▼
Tally Connect Desktop App (Mac / Windows)
      ├── ATEM Switcher (atem-connection)
      ├── OBS Studio (obs-websocket-js) + screenshot preview
      ├── Bitfocus Companion (HTTP API) — 600+ device types
      ├── HyperDeck control
      ├── PTZ camera control (ONVIF / VISCA over IP)
      ├── ProPresenter 7 (REST/WebSocket API)
      ├── Dante routing (via Companion)
      └── Reports status · accepts commands · sends preview frames
```

## Codebases

| Folder | What it is |
|--------|------------|
| `electron-app/` | Desktop app with setup wizard (Mac .dmg / Win .exe) |
| `relay-server/` | Node.js WebSocket hub — deploy to Railway or Docker |
| `church-client/` | Lightweight Node.js agent (headless / server installs) |

---

## Features

### Desktop App
- **Setup Wizard** — 5-step guided configuration
- **System tray** — color-coded status (grey / green / yellow / red)
- **Live dashboard** — ATEM inputs, OBS stream, Companion status, alerts
- **Preview thumbnail** — periodic JPEG screenshots from OBS
- **Native notifications** — ATEM disconnect, stream drop, low FPS
- **Auto-update** — checks GitHub releases
- **Watch Live button** — opens YouTube / Facebook stream URL

### Relay Server
- **SQLite persistence** — churches survive restarts
- **Rate limiting** — 10 commands/second per church (token bucket)
- **Message queue** — buffers commands during brief disconnects
- **Health endpoint** — `GET /api/health` returns uptime and stats
- **Telegram bot** — TDs control their system via natural language messages

### Integrations
- **ATEM Switcher** — cut, auto, set program/preview, DSK, aux, macros, transitions, recording
- **OBS Studio** — start/stop stream and recording, scene switching
- **ProPresenter 7** — slide advance, go to slide, real-time slide change events
- **PTZ Cameras** — ONVIF, VISCA-TCP, VISCA-UDP, Sony VISCA-over-IP, auto-detect
- **HyperDeck** — play, stop, record, clip navigation
- **Bitfocus Companion** — press any button by name or location (600+ device integrations)
- **Dante Audio** — scene routing via Companion buttons
- **Audio Mixer** — mute/unmute, fader, scene recall, channel status (X32/M32)
- **vMix** — stream, record, input switching, volume, raw function calls
- **Resolume** — clip playback, column trigger, opacity, BPM
- **Blackmagic Video Hub** — routing control

---

## Relay Server Deployment

### Railway (recommended)
1. Push `relay-server/` to GitHub
2. Railway → New Project → Deploy from GitHub
3. Set environment variables:
   ```
   ADMIN_API_KEY=your-secret-admin-key
   JWT_SECRET=your-secret-jwt-key
   ```

### Docker
```bash
cd relay-server
docker build -t tally-relay .
docker run -p 3000:3000 \
  -e ADMIN_API_KEY=yourkey \
  -e JWT_SECRET=yoursecret \
  -v ./data:/app/data \
  tally-relay
```

---

## Desktop App Build

```bash
cd electron-app && npm install && npm run build:mac
```

Church downloads the installer, runs the setup wizard, enters their token and ATEM IP, and they're done.

Release checks:
```bash
cd electron-app && npm run release:check
```

---

## Telegram Bot Setup

Technical Directors can control their system by messaging the Tally bot — natural language like "cut to camera 3" or "start stream."

1. Create a bot via [@BotFather](https://t.me/BotFather), copy the token
2. Set environment variables on your relay:
   ```
   TALLY_BOT_TOKEN=123456:ABC-DEF...
   TALLY_BOT_WEBHOOK_URL=https://your-relay.up.railway.app/api/telegram-webhook
   ```
3. Set the webhook (auto-sets on startup if `TALLY_BOT_WEBHOOK_URL` is configured)
4. Give each TD their 6-character registration code from the admin API
5. TD messages the bot: `/register A1B2C3` — done

Example commands:
- "cut to camera 3 at First Baptist"
- "start recording" / "stop the stream"
- "show me First Baptist" (screenshot preview)
- "run pre-service check"
- "press 'Go Live' in Companion"
- "fade to black"

---

## ProPresenter 7 Setup

1. Open ProPresenter → **Preferences** → **Network**
2. Enable the network API on port **1025** (default)
3. In Tally's Equipment tab, enter the ProPresenter host and port

---

## PTZ Camera Setup

Supported protocols: `onvif`, `visca-tcp`, `visca-udp`, `sony-visca-udp`, `auto`

Configure cameras in the Equipment tab with IP, port, and protocol. Use `auto` to let Tally detect the protocol.

---

## Bitfocus Companion Integration

1. Configure devices in Companion as normal
2. Create buttons for actions you want Tally to trigger
3. Tally calls Companion's HTTP API (`http://localhost:8888` by default) to press buttons

This gives Tally access to 600+ device types without native integrations for each one.

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
--preview-source     OBS source name for preview screenshots
--config             Config file path (default: ~/.church-av/config.json)
```
