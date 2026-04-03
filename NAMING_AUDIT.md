# Tally Connect Naming & Presentation Audit

**Date:** 2026-04-03
**Surfaces audited:** Mobile App, Church Portal, Electron Desktop App, Companion Module, Admin Portal

---

## 1. Device Name Matrix

| Device | Mobile App | Church Portal | Electron App | Companion Module | Admin Portal | **Canonical** |
|--------|-----------|---------------|-------------|-----------------|-------------|---------------|
| ATEM | "ATEM Switcher" | "ATEM Switcher" | "ATEM Switcher" | "ATEM" (feedbacks/presets) | "ATEM" (header), "ATEM Switcher" (table) | **ATEM Switcher** |
| OBS | "OBS Studio" | "OBS Studio" | "OBS Studio" | "OBS" (feedbacks/presets) | "OBS" (header) | **OBS Studio** |
| vMix | "vMix" | "vMix" | "vMix" | "vMix" | "vMix" | **vMix** (consistent) |
| Encoder | "Encoder" | "Streaming Encoder" | "Streaming Encoder" | "Encoder" (feedbacks) | varies | **Streaming Encoder** |
| ProPresenter | "ProPresenter" | "ProPresenter" | "ProPresenter" | "ProPresenter" (name), **"ProP"** (button text) | "ProPresenter" | **ProPresenter** |
| HyperDeck | "HyperDeck" | "HyperDeck" / "HyperDecks" | "HyperDeck" | "HyperDeck" | "HyperDecks" | **HyperDeck** |
| Companion | "Companion" | "Companion" / "Bitfocus Companion" | "Bitfocus Companion" (registry), "Companion" (UI) | "Companion" | "Companion" | **Companion** |
| Resolume | N/A | "Resolume Arena" | "Resolume Arena" (registry), **"Arena"** (status chip) | "Resolume" (feedbacks) | N/A | **Resolume Arena** |
| VideoHub | N/A | "VideoHub" / "VideoHubs" | "VideoHub" | N/A | N/A | **VideoHub** |
| Audio | "Audio Mixer" | "Audio Mixer" | **"Audio Console"** (registry) | "Audio Mixer" (feedbacks) | "Audio Inputs" | **Audio Mixer** |
| Smart Plug | N/A | "Smart Plugs" | **"Smart Plug (Shelly)"** (registry) | "Smart Plug" (actions) | N/A | **Smart Plug** |
| PTZ | N/A | "PTZ Cameras" | "PTZ Camera" | "PTZ" (actions) | "PTZ Cameras" | **PTZ Camera** |

### Inconsistencies Found (Device Names)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| D1 | Encoder fallback name too short | Mobile `index.tsx:225` | "Encoder" | "Streaming Encoder" |
| D2 | Audio device name mismatch | Electron `device-registry.js:199` | "Audio Console" | "Audio Mixer" |
| D3 | Smart Plug includes brand | Electron `device-registry.js:184` | "Smart Plug (Shelly)" | "Smart Plug" |
| D4 | Resolume shortened in chip | Electron `index.html:168` | "Arena" | "Resolume" |
| D5 | ProPresenter abbreviated on button | Companion `presets.ts:328` | "ProP" | "ProPres" |
| D6 | Companion feedbacks use short names | Companion `feedbacks.ts:146-153` | "ATEM", "OBS" | OK for Companion context (space-constrained) |
| D7 | Portal stream source label | Portal `portal.js:1467` | "ATEM Encoder" | "ATEM Switcher" |

---

## 2. Connection Status Label Matrix

| Context | Mobile App | Church Portal | Electron App | Companion Module | Admin Portal |
|---------|-----------|---------------|-------------|-----------------|-------------|
| Device online | **"Online"** | "Online" (top-level), **"Connected"** (equipment table) | **"Connected"** | "Connected" (feedbacks) | **"Connected"** / "Online" |
| Device offline | **"Offline"** | "Offline" (top-level), **"unknown"** (equipment table) | **"Disconnected"** | "Disconnected" (feedbacks) | **"Not connected"** / "Offline" |

### Canonical Status Labels

| Context | Canonical Label | Rationale |
|---------|----------------|-----------|
| High-level church status (portal badge) | **Online** / **Offline** | Simple, non-technical |
| Equipment table row | **Connected** / **Disconnected** | Precise for device-level status |
| Admin overview equipment grid | **Connected** / **Disconnected** | Match equipment table |
| Mobile device list | **Connected** / **Disconnected** | Match other equipment views |
| Companion feedbacks | **Connected** / **Disconnected** | Already correct |

### Inconsistencies Found (Connection Status)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| S1 | Mobile uses "Online/Offline" for devices | Mobile `DeviceRow.tsx:22` | "Online" / "Offline" | "Connected" / "Disconnected" |
| S2 | Portal equipment table uses "unknown" | Portal `portal.js:1198` | "unknown" | "Disconnected" |
| S3 | Admin overview uses "Not connected" | Admin `OverviewPanel.jsx:170-180` | "Not connected" | "Disconnected" |
| S4 | Admin device header uses "Offline" | Admin `MonitorTab.jsx:418` | "Offline" | "Disconnected" |

---

## 3. Stream Status Label Matrix

| Context | Mobile App | Church Portal | Electron App | Companion Module | Admin Portal |
|---------|-----------|---------------|-------------|-----------------|-------------|
| Actively streaming | **"LIVE"** (StreamStats), "Streaming" (device detail) | **"Live"** (badge), "Streaming" (table) | "Streaming" (badge) | **"LIVE"** (variable), "Live" (feedback name) | "Live" / "Streaming" |
| Not streaming | **"OFFLINE"** (StreamStats) | "Off-air" / "Offline" | "Standby" / "Idle" | **"OFFLINE"** (variable) | "Off-air" |
| Stream status tag in cards | "LIVE" red badge | Red dot + "Live Stream" | "Streaming" badge | "Stream: Live" feedback | Red dot + "Live" |

### Canonical Stream Labels

| Context | Canonical | Rationale |
|---------|-----------|-----------|
| Stream actively broadcasting | **Live** | Universal, clear |
| Stream not active | **Off Air** | Broadcast industry standard, cleaner than "Offline" (which implies broken) |
| Device-level streaming detail | **Streaming** | OK as device detail (e.g., "ATEM Switcher — Streaming") |

### Inconsistencies Found (Stream Status)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| ST1 | Mobile StreamStats "OFFLINE" tag | Mobile `StreamStats.tsx:26` | "OFFLINE" | "OFF AIR" |
| ST2 | Portal equipment table "offline" for stream row | Portal `portal.js:1200` | "offline" | "off-air" |
| ST3 | Electron audio standby label | Electron `renderer.js:2059,2069` | "Standby" / "Idle" | OK (encoder-specific states, not stream status) |

---

## 4. Color Consistency Matrix

| Purpose | Mobile | Portal | Electron | Companion | **Canonical** |
|---------|--------|--------|----------|-----------|---------------|
| Online/Connected | `#22c55e` | `#22c55e` | `#22c55e` | **`RGB(0,204,0)` = `#00CC00`** | **`#22c55e`** |
| Offline/Error | `#ef4444` | `#ef4444` | `#ef4444` | **`RGB(255,0,0)` = `#FF0000`** | **`#ef4444`** |
| Warning | `#f59e0b` | **`#eab308`** | `#eab308` | `RGB(255,191,0)` | `#f59e0b` (mobile) or `#eab308` (portal/electron) |
| Info / Blue | `#3b82f6` | `#3b82f6` | `#3b82f6` | N/A | **`#3b82f6`** |
| Brand accent | `#22c55e` | `#22c55e` | `#22c55e` | N/A | **`#22c55e`** (green, no purple) |
| Live stream | `#ef4444` (red) | `#ef4444` | `#ef4444` | `RGB(255,0,0)` | **`#ef4444`** |
| Preview tally | `#22c55e` | N/A | N/A | **`RGB(0,255,0)` = `#00FF00`** | See note below |

**Note on Companion colors:** Companion modules use the Companion SDK's `combineRgb()` function which produces integer RGB values for StreamDeck button rendering. These are inherently different from web CSS hex colors. The Companion module uses pure RGB primaries (`#00FF00`, `#FF0000`) which is standard practice for StreamDeck visibility. **No change needed** for Companion button colors — they operate in a different rendering context.

### Color Inconsistencies Found

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| C1 | Warning color differs between mobile and portal/electron | Mobile `colors.ts` vs Portal/Electron CSS | Mobile: `#f59e0b`, Portal/Electron: `#eab308` | Standardize to `#f59e0b` (Tailwind amber-500, brighter) |
| C2 | Portal alert INFO severity color is green | Portal `portal.html:821` area | `#22c55e` (green) | `#3b82f6` (blue, matches mobile INFO) |

---

## 5. Button / Command Label Matrix

| Action | Mobile App | Church Portal | Electron App | Companion Module |
|--------|-----------|---------------|-------------|-----------------|
| Start stream | "Start Stream" | N/A (auto) | N/A | "GO LIVE" (preset), "Encoder: Start Streaming" (action) |
| Stop stream | "Stop Stream" | N/A (auto) | N/A | "STOP STREAM" (preset), "Encoder: Stop Streaming" (action) |
| Start recording | "Start Rec" | N/A | N/A | "REC" (preset) |
| Stop recording | "Stop Rec" | N/A | N/A | N/A |
| Cut transition | "CUT" | N/A | N/A | "CUT" |
| Auto transition | "AUTO" | N/A | N/A | "AUTO" |
| Next slide | "Next" | N/A | N/A | "NEXT" (preset), "ProPresenter: Next Slide" (action) |
| Previous slide | "Previous" | N/A | N/A | "PREV" (preset), "ProPresenter: Previous Slide" (action) |

### Inconsistencies Found (Commands)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| B1 | Companion preset "GO LIVE" vs Mobile "Start Stream" | Companion `presets.ts:131` vs Mobile `actions.tsx:119` | Different verbs | OK — Companion presets are big physical buttons; "GO LIVE" is appropriate for StreamDeck. Mobile can keep "Start Stream". |
| B2 | Recording button labels abbreviated | Mobile `actions.tsx:142,149` | "Start Rec" / "Stop Rec" | "Start Recording" / "Stop Recording" |

---

## 6. Data Field Label Matrix

| Field | Mobile App | Church Portal | Electron App | Companion Module |
|-------|-----------|---------------|-------------|-----------------|
| Bitrate | "Mbps" (computed) | "Bitrate (kbps)" (header), "kbps" (values) | "Bitrate" (label), value in kbps | "Stream Bitrate (kbps)" (variable name) |
| FPS | "FPS" | "FPS" | "FPS" | "Encoder FPS" (variable name) |
| Cache | N/A | "ATEM cache" | N/A | N/A |
| Viewers | "Viewers", "YT:", "FB:" | "Live Viewers" | "Peak Viewers" (recap) | "YouTube Viewer Count", "Facebook Viewer Count", "Total Viewer Count" |

### Inconsistencies Found (Data Fields)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| F1 | Portal stream source label for ATEM | Portal `portal.js:1467` | "ATEM Encoder" | "ATEM Switcher" |

---

## 7. Section / Tab Name Matrix

| Section | Mobile App | Church Portal | Electron App |
|---------|-----------|---------------|-------------|
| Main dashboard | (tab: "Equipment") | "Overview" | "Status" (tab) |
| Equipment config | N/A | "Equipment" (in profile) | "Equipment" (tab) |
| AI Assistant | "Engineer" (tab) | "Tally Engineer" | "Tally Engineer" (tab) |
| Alerts | "Alerts" (tab) | "Alerts" | N/A (in status) |
| Commands | "Commands" (tab) | N/A | N/A |
| More/Settings | "More" (tab) | "Profile" | N/A |

### Inconsistencies Found (Sections)

| # | Issue | Location | Current | Fix |
|---|-------|----------|---------|-----|
| T1 | Mobile AI tab says "Engineer" | Mobile `_layout.tsx:56` | "Engineer" | "Tally Engineer" (matches portal & electron) — **but** mobile tab bar has limited space, "Engineer" is acceptable abbreviation |

---

## 8. Prioritized Fix List

### Priority 1 — Cross-surface device name mismatches (user-visible confusion)

| Fix | File | Change |
|-----|------|--------|
| D1 | `tally-connect-mobile/app/(tabs)/index.tsx:225` | "Encoder" → "Streaming Encoder" |
| D2 | `electron-app/src/device-registry.js:199` | "Audio Console" → "Audio Mixer" |
| D3 | `electron-app/src/device-registry.js:184` | "Smart Plug (Shelly)" ��� "Smart Plug" |
| D4 | `electron-app/src/index.html:168` | "Arena" → "Resolume" |
| D5 | `companion-module-tallyconnect/src/presets.ts:328` | "ProP" → "ProPres" |
| D7 | `relay-server/public/portal/portal.js:1467` | "ATEM Encoder" → "ATEM Switcher" |

### Priority 2 — Status label consistency

| Fix | File | Change |
|-----|------|--------|
| S1 | `tally-connect-mobile/src/components/DeviceRow.tsx:22` | "Online"/"Offline" → "Connected"/"Disconnected" |
| S2 | `relay-server/public/portal/portal.js:1198` | Status "unknown" → "disconnected" for equipment rows |
| S3 | `relay-server/admin/src/components/OverviewPanel.jsx:170-180` | "Not connected" → "Disconnected" |
| S4 | `relay-server/admin/src/components/MonitorTab.jsx:418` | "Offline" → "Disconnected" |
| ST1 | `tally-connect-mobile/src/components/StreamStats.tsx:26` | "OFFLINE" → "OFF AIR" |
| ST2 | `relay-server/public/portal/portal.js:1200,1320` | Stream "offline" → "off-air" consistently |

### Priority 3 — Color consistency

| Fix | File | Change |
|-----|------|--------|
| C1 | `relay-server/public/portal/portal.css` + `electron-app/src/styles.css` | Warning `#eab308` → `#f59e0b` |

### Priority 4 — Minor label polish

| Fix | File | Change |
|-----|------|--------|
| B2 | `tally-connect-mobile/app/(tabs)/actions.tsx:142,149` | "Start Rec"/"Stop Rec" → "Start Recording"/"Stop Recording" |
| F1 | `relay-server/public/portal/portal.js:1467` | "ATEM Encoder" → "ATEM Switcher" (same as D7) |

---

## 9. Items Verified Consistent (No Issues)

- **vMix** — spelled consistently across all surfaces
- **ProPresenter** — full name used consistently (except Companion button text, fixed above)
- **HyperDeck** — capitalization consistent (capital D)
- **Brand accent color** — `#22c55e` green used everywhere, no purple found
- **Alert severity levels** — EMERGENCY, CRITICAL, WARNING, INFO used consistently
- **Tally indicators** — PGM (red `#ef4444`) and PVW (green `#22c55e`) consistent
- **Grade color scale** — A=green, B=light green, C=yellow, D/F=red consistent across surfaces
