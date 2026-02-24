# Equipment API Audit (February 23, 2026)

## Scope
- Relay command entry points:
  - `POST /api/command`
  - Telegram parser + dispatch
  - In-app chat command bridge (`/cmd`, `!`, `/ai`)
- Church client execution layer:
  - `church-client/src/commands.js`
  - Device adapters (ATEM, vMix, Resolume, MixerBridge)

## Findings
### P0: Real ATEM controls had signature mismatches/no-op paths
- `atem.setProgram`, `atem.setPreview`, and `atem.setInputLabel` used argument orders incompatible with real `atem-connection`.
- `atem.startRecording`, `atem.stopRecording`, and `atem.fadeToBlack` used legacy/fake-only methods.
- Result: commands could appear successful while not applying on real hardware.

### P1: Preset recall referenced unsupported command IDs
- Preset recall can emit `atem.runMacro` and `vmix.function`.
- Those command IDs were not registered in church client command handlers.
- Result: preset recall paths could fail at runtime.

### P1: Control surface mismatch (parser vs executable command map)
- Telegram parser exposed fewer commands than actual capabilities (mixer/resolume/advanced ATEM).
- AI parser command schema was behind execution map.

### P1: Unsupported PTZ/HyperDeck paths could report false success
- PTZ and HyperDeck methods relied on runtime-specific methods; unsupported paths were not always surfaced clearly.

## Remediations Applied
- Fixed ATEM execution paths for real runtime compatibility and fake-runtime compatibility.
- Added ATEM command coverage:
  - `atem.runMacro`, `atem.stopMacro`
  - `atem.setAux`
  - `atem.setTransitionStyle`, `atem.setTransitionRate`
  - `atem.setDskOnAir`, `atem.setDskTie`, `atem.setDskRate`, `atem.setDskSource`
- Added `vmix.function` command support for preset compatibility.
- Expanded Telegram parser coverage for:
  - Advanced ATEM controls
  - HyperDeck transport phrases
  - Mixer commands
  - Resolume commands
- Expanded AI parser schema to include the same broader control set.
- Enforced explicit errors for unsupported PTZ/HyperDeck runtime paths to avoid false positives.
- Updated README command reference to reflect expanded controls.

## Current Known Limits
- Real HyperDeck transport via ATEM runtime path remains runtime/device dependent.
- PTZ over ATEM depends on runtime support of camera-control method set.
- If strict real HyperDeck control is required independent of ATEM runtime support, add a direct HyperDeck TCP adapter.

## Verification Performed
- Syntax check:
  - `church-client/src/commands.js`
  - `relay-server/src/telegramBot.js`
  - `relay-server/src/ai-parser.js`
  - `relay-server/server.js`
- Runtime sanity checks:
  - New command IDs present in `commandHandlers`
  - Telegram parser resolves new phrases to command payloads
  - Fake ATEM executes newly added ATEM command handlers successfully
