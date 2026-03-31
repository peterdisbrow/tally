# companion-module-tallyconnect

Bitfocus Companion module for [Tally Connect](https://tallyconnect.app) — church AV monitoring and control.

## Features

- **40+ Actions**: Switch cameras, start/stop streaming, control ProPresenter, audio mixer, PTZ cameras, and more
- **10 Feedbacks**: Tally program/preview, stream status, device connection, audio mute
- **30+ Variables**: Live data from your AV system displayed on button text
- **25+ Presets**: Pre-built buttons for camera switching, streaming, ProPresenter, and safety operations

## Installation

### From Companion Module Store
Search for "Tally Connect" in the Companion module store.

### Development
```bash
cd companion-module-tallyconnect
npm install
npm run build
```

Then add the module's parent directory as a development module path in Companion settings.

## Configuration

| Field | Description |
|-------|-------------|
| Relay Server URL | Your Tally Connect relay URL (e.g., `https://api.tallyconnect.app`) |
| Admin API Key | Admin API key from the Tally Connect admin panel |
| Church ID | Your church's unique identifier |
| Room ID | (Optional) Filter to a specific room for multi-room setups |

## Architecture

The module connects to the Tally Connect relay server as a **controller** via WebSocket (`/controller` endpoint). This is the same protocol used by the admin dashboard. It receives real-time `status_update` messages and sends `command` messages back through the same connection.

### Connection Flow
1. Module opens WebSocket to `wss://relay-url/controller?apikey=API_KEY`
2. Relay sends `church_list` with all churches and their current status
3. Module filters to the configured `church_id` and extracts initial state
4. Relay streams `status_update`, `alert`, `church_connected`/`church_disconnected` events
5. Module sends commands as `{ type: 'command', churchId, command, params }`

### Command Routing
Commands are routed by the relay to all connected instances of the target church. Each church-client agent handles only the commands relevant to its connected devices. For multi-room churches, commands reach all rooms unless a specific instance is targeted.

## License

MIT
