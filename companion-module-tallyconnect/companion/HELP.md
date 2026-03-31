# Tally Connect

This module connects to your Tally Connect relay server, giving you real-time monitoring and control of your church AV system from Companion.

## Setup

1. Enter your **Relay Server URL** (e.g., `https://api.tallyconnect.app`)
2. Enter your **Admin API Key** from the Tally Connect admin panel
3. Enter your **Church ID** to filter status updates to your church
4. Optionally enter a **Room ID** to filter to a specific room (for multi-room churches)

## What You Can Do

### Actions (Stream Deck buttons → Tally Connect)
- **Switch cameras** — Set program/preview inputs on your ATEM or multi-switcher
- **Cut / Auto / FTB** — Execute transitions
- **Start/Stop streaming** — Control ATEM, OBS, or encoder streaming
- **Start/Stop recording** — Control ATEM, OBS, or encoder recording
- **ProPresenter** — Next/Previous slide, trigger presentations, clear layers, control timers
- **Audio mixer** — Mute/unmute channels, set fader levels, recall scenes
- **OBS** — Set preview scene, trigger transitions, toggle input mute
- **vMix** — Cut, fade to black, set program/preview
- **PTZ cameras** — Recall presets, home position
- **Recovery** — Restart stream, restart recording, reconnect devices
- **Failover** — Switch to backup/primary encoder
- **Smart plugs** — Power cycle Shelly devices
- **HyperDeck** — Record, play, stop
- **Raw command** — Send any Tally Connect command with custom parameters

### Feedbacks (visual state on buttons)
- **Tally program/preview** — Red when an input is live, green when previewed
- **Stream live/offline** — Red when streaming from any source
- **Recording active** — Red when recording from any source
- **Device connected/disconnected** — Green/red per device
- **Audio muted** — Red when mixer main is muted
- **Audio silence** — Yellow when silence is detected

### Variables (live data in button text)
- `$(tallyconnect:program_input)` — Current program input number
- `$(tallyconnect:program_label)` — Current program input label
- `$(tallyconnect:stream_status)` — LIVE or OFFLINE
- `$(tallyconnect:stream_bitrate)` — Current bitrate in kbps
- `$(tallyconnect:viewer_count)` — Total viewers (YouTube + Facebook)
- `$(tallyconnect:pp_slide_index)` — Current ProPresenter slide number
- `$(tallyconnect:record_status)` — REC or STOP
- `$(tallyconnect:room_name)` — Connected room name
- And many more (see full list in variable definitions)

## Connection

The module connects to the relay server as a **controller** via WebSocket. It receives real-time status updates and sends commands through the same connection. The WebSocket auto-reconnects on disconnect.

## Troubleshooting

- **Auth Failed**: Check that your Admin API Key is correct
- **Church not found**: Verify the Church ID matches what's in the admin panel
- **No status updates**: Make sure the church client (Electron app) is running and connected to the relay
