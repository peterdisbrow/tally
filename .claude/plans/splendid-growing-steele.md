# Multi-Switcher Support

## Context

The system currently assumes one ATEM switcher per instance. Real-world rooms often have 2+ ATEMs (IMAG + broadcast), and OBS/vMix can serve as video switchers alongside their encoder role. This plan introduces a unified switcher abstraction supporting multiple ATEM, OBS, and vMix instances per room with user-configurable roles.

## Audit Summary

### Current State
- **church-client**: `this.atem` = single `Atem` instance, `connectATEM()` inline in index.js (~240 lines). OBS (`this.obs`) and vMix (`this.vmix`) already exist with switching capabilities but are treated as separate device categories
- **Status shape**: `status.atem`, `status.obs`, `status.vmix` are flat top-level objects sent every 10s to relay
- **Signal failover**: Reads `status.atem?.connected` and `status.atem?.programInput` for diagnosis/recovery. Sends `atem.cut` command
- **Portal**: `updateAtemDetailCard(status)` renders one ATEM card. Failover UI populates inputs from `status.atem.inputLabels`
- **Electron**: `device-registry.js` has ATEM as `multi: false`. Config stores `config.atemIp` (string)
- **Commands**: `atem.cut`, `atem.setProgram`, `atem.setPreview` reference `agent.atem` directly

### Key Discovery: OBS & vMix Already Have Switching APIs
- OBS: `obsSetScene()`, `SetCurrentProgramScene`, `SetCurrentPreviewScene` in `commands/obs.js`
- vMix: `cut()`, `setPreview(input)`, `setProgram(input)` in `vmix.js` class

## Architecture

### New Status Shape (additive, backward-compatible)

```js
this.status = {
  // LEGACY — populated from primary switcher of each type (unchanged)
  atem: { connected, ip, model, programInput, previewInput, ... },
  obs: { connected, streaming, recording, ... },
  vmix: { connected, streaming, recording, ... },

  // NEW — canonical multi-switcher data
  switchers: {
    "atem-1": { id, type: "atem", role: "primary", connected, programInput, previewInput, inputLabels, model, recording, streaming, inTransition, tally },
    "atem-2": { id, type: "atem", role: "imag", ... },
    "obs-1":  { id, type: "obs", role: "backup", connected, programInput (scene), previewInput, inputLabels (scenes), ... },
    "vmix-1": { id, type: "vmix", role: "broadcast", connected, programInput, previewInput, inputLabels, ... }
  }
};
```

**Dual-write**: Primary ATEM always syncs back to `status.atem`. First OBS/vMix sync to `status.obs`/`status.vmix`. All downstream consumers work unchanged.

### Config Shape

```json
{
  "atemIp": "192.168.1.10",        // LEGACY: auto-migrated on load
  "switchers": [
    { "id": "atem-1", "type": "atem", "role": "primary", "ip": "192.168.1.10" },
    { "id": "atem-2", "type": "atem", "role": "imag", "ip": "192.168.1.11" },
    { "id": "obs-1", "type": "obs", "role": "backup", "url": "ws://localhost:4455" },
    { "id": "vmix-1", "type": "vmix", "role": "broadcast", "host": "192.168.1.20", "port": 8088 }
  ]
}
```

Auto-migration: if `config.switchers` absent but `config.atemIp` exists, construct `switchers` array from legacy fields.

### Switcher Roles
User-configurable: `primary`, `backup`, `imag`, `broadcast`, `recording`. The "primary" role is the default and used for backward-compat resolution.

## Implementation Plan

### Phase 1: Abstraction Layer (church-client)

**1. `church-client/src/switcher.js`** (NEW) — Base class
- Common interface: `connect()`, `disconnect()`, `cut()`, `setProgram(input)`, `setPreview(input)`, `getStatus()`, `getTally()`
- EventEmitter: `connected`, `disconnected`, `stateChanged`, `tallyChanged`
- Properties: `id`, `type`, `role`, `connected`

**2. `church-client/src/switchers/atemSwitcher.js`** (NEW)
- Wraps `atem-connection` package
- Extracts ATEM connection logic from `index.js` lines 1051-1290
- Reconnect with exponential backoff (reuse existing logic)
- Maps `state.video.mixEffects[0]` to common programInput/previewInput
- Tally: derives from programInput/previewInput across all MEs

**3. `church-client/src/switchers/obsSwitcher.js`** (NEW)
- Wraps `obs-websocket-js`
- `programInput` = current program scene name
- `previewInput` = studio mode preview scene (null if not studio mode)
- `inputLabels` = scene list as `{ sceneName: sceneName }`
- `cut()` = `SetCurrentProgramScene` or `TriggerStudioModeTransition`
- Can share WebSocket with encoder OBS instance (same connection)

**4. `church-client/src/switchers/vmixSwitcher.js`** (NEW)
- Wraps existing `VMix` class (`vmix.js`)
- `getState()` already returns `{ activeInput, previewInput, inputs[] }`
- Polls on 3s interval (vMix has no push events)
- `cut()`, `setProgram()`, `setPreview()` delegate to VMix methods

**5. `church-client/src/switcherManager.js`** (NEW)
- `initFromConfig(config)` — creates switcher instances, handles auto-migration
- `get(id)`, `getByRole(role)`, `getPrimary()`, `getAllByType(type)`, `all()`
- `getSwitchersStatus()` — returns status object for all switchers
- `syncLegacyStatus(status)` — dual-writes primary to legacy fields
- `connectAll()`, `disconnectAll()` — lifecycle management

**6. `church-client/src/index.js`** (MODIFY)
- Add `this.switcherManager = new SwitcherManager(this)` in constructor
- In `start()`: call `switcherManager.initFromConfig()` which replaces direct `connectATEM()` when switchers config exists
- Keep `this.atem` pointing to primary ATEM's raw instance (backward compat for commands)
- `sendStatus()`: call `syncLegacyStatus()`, add `switchers` to payload
- Keep `connectATEM()` as fallback for legacy configs (delegates to manager internally)

### Phase 2: Command Routing

**7. `church-client/src/commands/switcher.js`** (NEW)
- `switcherCut(agent, params)` — resolves by `params.switcherId`, calls `.cut()`
- `switcherSetProgram(agent, params)` — resolves by ID, calls `.setProgram(params.input)`
- `switcherSetPreview(agent, params)` — resolves by ID, calls `.setPreview(params.input)`
- `switcherList(agent)` — returns all switchers with status summary

**8. `church-client/src/commands/index.js`** (MODIFY)
- Register `switcher.*` commands

**9. `church-client/src/commands/atem.js`** (MODIFY)
- Accept optional `params.switcherId`
- If present, resolve via `agent.switcherManager.get(switcherId)` for its raw ATEM
- If absent, use `agent.switcherManager.getPrimary()` or `agent.atem` fallback

### Phase 3: Equipment UI

**10. `electron-app/src/device-registry.js`** (MODIFY)
- ATEM: `multi: true`, `maxInstances: 4`
- Add `role` select field and `name` text field to ATEM
- Add `switcherRole` select field to vMix entry

**11. `electron-app/src/equipment-ui.js`** (MODIFY)
- `deviceState.atem` changes from `{ ip: '' }` to array `[]` (same pattern as hyperdecks/ptz)
- Handle save/load for multi-ATEM array

**12. `electron-app/src/main.js`** (MODIFY)
- `save-equipment` handler: serialize `atems` array to config
- `get-equipment` handler: read `atems` array (with legacy migration from `atemIp`)

**13. `electron-app/src/config-manager.js`** (MODIFY)
- Add `atems` to `ROOM_EQUIPMENT_KEYS` for per-room persistence
- Migration: `atemIp` string -> `atems` array on load

### Phase 4: Relay & Portal

**14. `relay-server/src/signalFailover.js`** (MODIFY)
- `_diagnoseFailure`: check `status.switchers[switcherId]?.connected` with fallback to `status.atem?.connected`
- `_captureCurrentSource`: read from `status.switchers[switcherId]?.programInput`
- `_buildFailoverCommand`: support `switcher_switch` action type with `switcherId` param
- `_isEncoderHealthy`: check streaming on specific switcher if ATEM-streaming is encoder
- Legacy: `atem_switch` action type resolves to primary ATEM automatically

**15. `relay-server/public/portal/portal.html`** (MODIFY)
- Add `#switchers-cards` container alongside existing ATEM detail card

**16. `relay-server/public/portal/portal.js`** (MODIFY)
- New `updateSwitchersCards(status)`: dynamically render a card per switcher
- Each card: type icon + role badge, model/app, program/preview inputs, tally, recording/streaming
- Failover settings: add switcher selector dropdown, populate inputs from selected switcher's labels
- Fall back to legacy `updateAtemDetailCard()` when `status.switchers` absent

### Phase 5: Analytics & Diagnostics

**17. `church-client/src/atemAnalytics.js`** (MODIFY)
- Accept `switcherId` in constructor
- SwitcherManager creates one instance per switcher
- Stats include `switcherId` and `role`

**18. `relay-server/src/diagnostic-context.js`** (MODIFY)
- Include all switchers in diagnostic context, not just `status.atem`

**19. `relay-server/src/ai-parser.js`** (MODIFY)
- Expose all switcher states in AI context

## Backward Compatibility

1. **Auto-migration**: Old `atemIp` string -> `switchers` array on config load
2. **Dual-write**: Legacy `status.atem/obs/vmix` always populated from primary
3. **Command fallback**: Commands without `switcherId` route to primary
4. **Relay passthrough**: `status.switchers` is additive; old portals render legacy fields
5. **Failover compat**: `atem_switch` action type still works, resolves to primary ATEM
6. **No DB migration**: Failover config interpretation is in code, not schema

## OBS Dual-Purpose Handling

OBS can be both encoder and switcher simultaneously. They share the same WebSocket connection:
- Encoder role: configured via `config.encoder.type === 'obs'`, handled by `encoders/obs.js`
- Switcher role: configured via `config.switchers[].type === 'obs'`, handled by `switchers/obsSwitcher.js`
- The OBSSwitcher detects if `agent.obs` already has a connected WebSocket and reuses it

## Verification

1. **Unit**: Test SwitcherManager with mock switchers — lifecycle, status aggregation, legacy sync
2. **Integration**: Connect to real ATEM + OBS, verify dual-write produces identical legacy status
3. **Portal**: Load portal with multi-switcher status, verify cards render for each switcher
4. **Failover**: Configure failover targeting specific switcher ID, trigger drill, verify correct switcher receives cut command
5. **Migration**: Start with old single-ATEM config, verify auto-migration creates valid switchers array
6. **Equipment UI**: Add/remove multiple ATEMs, verify save/load round-trips correctly
