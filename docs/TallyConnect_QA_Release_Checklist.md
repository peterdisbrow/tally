# TallyConnect QA Release Checklist

**Version under test:** `___________`
**Relay version:** `___________`
**Date:** `___________`
**Tester:** `___________`
**Test environment:** ☐ Staging &nbsp; ☐ Production

> **How to use this document:** Work through each section in order. Mark ✅ for pass, ❌ for fail. If you mark ❌, note what happened in the Notes column. Do not sign off until every row in the Sign-off Criteria section is ✅.

---

## 1. Pre-Flight Checks

> Complete these before launching the app or touching any equipment.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 1.1 | Desktop app installer version matches the release notes (check **About** or title bar) | ☐ ✅ ☐ ❌ | |
| 1.2 | Relay version at `https://api.tallyconnect.app/version` (or `/health`) matches release notes | ☐ ✅ ☐ ❌ | |
| 1.3 | Portal loads at `https://api.tallyconnect.app/portal` with no console errors (open DevTools → Console) | ☐ ✅ ☐ ❌ | |
| 1.4 | Test machine is on the **same local network** as all AV equipment to be tested | ☐ ✅ ☐ ❌ | |
| 1.5 | Outbound internet access confirmed (ping `api.tallyconnect.app` from the venue machine) | ☐ ✅ ☐ ❌ | |
| 1.6 | All equipment to be tested is **powered on** and reachable by IP | ☐ ✅ ☐ ❌ | |
| 1.7 | Previous release's church-client is **fully quit** before installing the new build | ☐ ✅ ☐ ❌ | |
| 1.8 | Config file / saved room settings from the prior release load correctly after upgrade | ☐ ✅ ☐ ❌ | |
| 1.9 | No stale WebSocket connections shown in the relay logs from a previous client session | ☐ ✅ ☐ ❌ | |

**Section sign-off:** ☐ All 9 checks passed &nbsp;|&nbsp; ❌ Issues found: `___________`

---

## 2. Core Connection Flow

> Verify the fundamental relay ↔ client ↔ portal handshake.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 2.1 | Launch church-client; it starts without error dialogs or crash | ☐ ✅ ☐ ❌ | |
| 2.2 | Enter relay URL (`api.tallyconnect.app`) and room credentials; click **Connect** | ☐ ✅ ☐ ❌ | |
| 2.3 | Connection status indicator in desktop app turns **green / "Connected"** within 10 seconds | ☐ ✅ ☐ ❌ | |
| 2.4 | Open portal → your room name appears in the room list | ☐ ✅ ☐ ❌ | |
| 2.5 | Click into the room in the portal — dashboard loads with no blank panels | ☐ ✅ ☐ ❌ | |
| 2.6 | Relay log shows a clean `client connected` event (check Railway logs or `/logs` endpoint) | ☐ ✅ ☐ ❌ | |
| 2.7 | Disconnect from the desktop app; portal shows room as **Offline / Disconnected** within 15 seconds | ☐ ✅ ☐ ❌ | |
| 2.8 | Reconnect — room status returns to **Online** in portal within 15 seconds | ☐ ✅ ☐ ❌ | |
| 2.9 | Simulate relay restart: restart the Railway service, wait for it to come back, reconnect client — room re-registers correctly | ☐ ✅ ☐ ❌ | |

**Section sign-off:** ☐ All 9 checks passed &nbsp;|&nbsp; ❌ Issues found: `___________`

---

## 3. Per-Equipment Checklists

### 3A — Blackmagic ATEM Switcher

| # | Check | Result | Notes |
|---|-------|--------|-------|
| A1 | Add ATEM device in church-client with correct IP; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| A2 | Portal equipment card shows ATEM with correct model name | ☐ ✅ ☐ ❌ | |
| A3 | Current program/preview source visible in the portal card | ☐ ✅ ☐ ❌ | |
| A4 | Send a **Cut** command from the portal; confirm program source changes on the physical switcher | ☐ ✅ ☐ ❌ | |
| A5 | Send an **Auto Transition** from the portal; verify transition executes | ☐ ✅ ☐ ❌ | |
| A6 | Change preview source via portal; confirm it updates on ATEM and reflects in portal | ☐ ✅ ☐ ❌ | |
| A7 | Remove/disable ATEM in church-client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |
| A8 | Re-add ATEM; it reconnects without requiring an app restart | ☐ ✅ ☐ ❌ | |

**Edge case:** If the ATEM reboots mid-session, the client should auto-reconnect within ~30 seconds. ☐ Tested &nbsp; ☐ Skipped

**ATEM sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3B — Blackmagic VideoHub Video Router

| # | Check | Result | Notes |
|---|-------|--------|-------|
| B1 | Add VideoHub device with correct IP; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| B2 | Portal card displays correct input/output labels (pulled from device) | ☐ ✅ ☐ ❌ | |
| B3 | Route an input to an output via portal; verify physical VideoHub reflects the change | ☐ ✅ ☐ ❌ | |
| B4 | Route confirms in portal immediately (no stale state) | ☐ ✅ ☐ ❌ | |
| B5 | Disconnect network cable from VideoHub for 10 seconds, reconnect — client re-establishes without manual intervention | ☐ ✅ ☐ ❌ | |
| B6 | Remove VideoHub in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

> ⚠️ **Known issue — VideoHub reconnect:** After a network blip the Videohub TCP socket can hang. Confirm the client drops and fully re-opens the socket (not just re-sends commands on a dead connection). Check logs for `socket closed` → `reconnecting` → `connected` sequence.

**VideoHub sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3C — Allen & Heath SQ Series Mixer

| # | Check | Result | Notes |
|---|-------|--------|-------|
| C1 | Add SQ mixer with correct IP and **MIDI channel** setting; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| C2 | Portal card shows channel fader levels / mute states | ☐ ✅ ☐ ❌ | |
| C3 | Mute a channel from the portal; verify mute LED lights on physical mixer | ☐ ✅ ☐ ❌ | |
| C4 | Unmute from portal; verify unmute on physical mixer | ☐ ✅ ☐ ❌ | |
| C5 | Adjust a fader from the portal; verify level change on mixer | ☐ ✅ ☐ ❌ | |
| C6 | Remove SQ in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

> ⚠️ **Known issue — SQ7 MIDI channel:** The SQ7 defaults to MIDI channel **1**, but some firmware versions ship with channel **0** (which is invalid). If commands are ignored, verify the MIDI channel in both the mixer's **I/O → MIDI** menu and the church-client config match exactly.

**SQ sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3D — Allen & Heath Avantis Mixer

| # | Check | Result | Notes |
|---|-------|--------|-------|
| D1 | Add Avantis with correct IP; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| D2 | Portal card reflects current mute/fader state | ☐ ✅ ☐ ❌ | |
| D3 | Send a mute command from portal; confirm on physical Avantis | ☐ ✅ ☐ ❌ | |
| D4 | Send a fader move from portal; confirm on physical Avantis | ☐ ✅ ☐ ❌ | |
| D5 | Remove Avantis in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**Avantis sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3E — BirdDog PTZ Cameras

| # | Check | Result | Notes |
|---|-------|--------|-------|
| E1 | Add BirdDog camera with correct IP; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| E2 | Portal card shows camera name and online status | ☐ ✅ ☐ ❌ | |
| E3 | Send **Pan Left** command from portal; camera physically pans left | ☐ ✅ ☐ ❌ | |
| E4 | Send **Tilt Up** command from portal; camera physically tilts up | ☐ ✅ ☐ ❌ | |
| E5 | Call a **preset** (e.g., Preset 1) from portal; camera moves to preset position | ☐ ✅ ☐ ❌ | |
| E6 | Adjust **zoom** from portal; camera zoom changes | ☐ ✅ ☐ ❌ | |
| E7 | Remove camera in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**BirdDog sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3F — vMix

| # | Check | Result | Notes |
|---|-------|--------|-------|
| F1 | Add vMix with correct IP (IPv4); status shows **Connected** | ☐ ✅ ☐ ❌ | |
| F2 | Portal card shows current vMix input/output state | ☐ ✅ ☐ ❌ | |
| F3 | Send **Cut** command from portal; vMix switches active input | ☐ ✅ ☐ ❌ | |
| F4 | Start/stop **recording** from portal; vMix recording state changes | ☐ ✅ ☐ ❌ | |
| F5 | Start/stop **streaming** from portal; vMix streaming state changes | ☐ ✅ ☐ ❌ | |
| F6 | Remove vMix in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

> ⚠️ **Known issue — vMix IPv6:** vMix's API server binds to IPv4 by default. If the church-client machine resolves the hostname via IPv6, commands will silently fail. Always use a **bare IPv4 address** (e.g., `192.168.1.x`) in the vMix config — never a hostname.

**vMix sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3G — ProPresenter

| # | Check | Result | Notes |
|---|-------|--------|-------|
| G1 | Add ProPresenter with correct IP and port; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| G2 | Portal card shows current slide/presentation name | ☐ ✅ ☐ ❌ | |
| G3 | Send **Next Slide** from portal; ProPresenter advances slide | ☐ ✅ ☐ ❌ | |
| G4 | Send **Previous Slide** from portal; ProPresenter goes back | ☐ ✅ ☐ ❌ | |
| G5 | Trigger a **Stage Display** message from portal; stage display updates | ☐ ✅ ☐ ❌ | |
| G6 | Remove ProPresenter in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**ProPresenter sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3H — Blackmagic HyperDeck Recorders

| # | Check | Result | Notes |
|---|-------|--------|-------|
| H1 | Add HyperDeck with correct IP; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| H2 | Portal card shows current transport state (Idle / Record / Play) | ☐ ✅ ☐ ❌ | |
| H3 | Send **Record** command from portal; HyperDeck begins recording | ☐ ✅ ☐ ❌ | |
| H4 | Send **Stop** from portal; HyperDeck stops and portal state updates | ☐ ✅ ☐ ❌ | |
| H5 | Send **Play** command; HyperDeck plays back and portal reflects playback state | ☐ ✅ ☐ ❌ | |
| H6 | Remove HyperDeck in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**HyperDeck sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3I — OBS Studio

| # | Check | Result | Notes |
|---|-------|--------|-------|
| I1 | Add OBS with correct WebSocket IP and port; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| I2 | Portal card shows current scene name | ☐ ✅ ☐ ❌ | |
| I3 | Switch scene from portal; OBS changes active scene | ☐ ✅ ☐ ❌ | |
| I4 | Start **recording** from portal; OBS recording state changes and portal reflects it | ☐ ✅ ☐ ❌ | |
| I5 | Stop recording from portal; OBS stops and portal updates | ☐ ✅ ☐ ❌ | |
| I6 | Remove OBS in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**OBS sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3J — Bitfocus Companion

| # | Check | Result | Notes |
|---|-------|--------|-------|
| J1 | Add Companion with correct IP and port; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| J2 | Portal card shows Companion online | ☐ ✅ ☐ ❌ | |
| J3 | Trigger a **button press** from the portal; Companion executes associated action | ☐ ✅ ☐ ❌ | |
| J4 | Remove Companion in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**Companion sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 3K — Resolume

| # | Check | Result | Notes |
|---|-------|--------|-------|
| K1 | Add Resolume with correct IP and OSC port; status shows **Connected** | ☐ ✅ ☐ ❌ | |
| K2 | Portal card shows Resolume online | ☐ ✅ ☐ ❌ | |
| K3 | Send a **clip trigger** from the portal; Resolume triggers the clip | ☐ ✅ ☐ ❌ | |
| K4 | Send a **layer opacity** change from portal; Resolume reflects the change | ☐ ✅ ☐ ❌ | |
| K5 | Remove Resolume in client; portal card shows **Disconnected** | ☐ ✅ ☐ ❌ | |

**Resolume sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

## 4. Portal UI Checks

### 4A — Desktop Browser (Chrome or Firefox, latest version)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| DA1 | Portal loads at `api.tallyconnect.app/portal` with no visual errors | ☐ ✅ ☐ ❌ | |
| DA2 | Login/auth flow completes successfully | ☐ ✅ ☐ ❌ | |
| DA3 | Left sidebar shows all rooms; sidebar is scrollable when rooms exceed viewport | ☐ ✅ ☐ ❌ | |
| DA4 | All tabs (Dashboard, Equipment, AI Engineer, Network, Settings) load without blank panels | ☐ ✅ ☐ ❌ | |
| DA5 | Equipment cards display device name, connection status, and last-seen timestamp | ☐ ✅ ☐ ❌ | |
| DA6 | Equipment cards update in real-time when a device disconnects (no page refresh required) | ☐ ✅ ☐ ❌ | |
| DA7 | No JavaScript errors in browser DevTools → Console during a full walkthrough | ☐ ✅ ☐ ❌ | |
| DA8 | All buttons and controls are visually accessible (no clipped text, no overlapping elements) | ☐ ✅ ☐ ❌ | |

**Desktop Browser sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 4B — Mobile — iPhone (Safari, latest iOS)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| MB1 | Portal loads and renders correctly in portrait orientation | ☐ ✅ ☐ ❌ | |
| MB2 | Portal renders correctly in landscape orientation | ☐ ✅ ☐ ❌ | |
| MB3 | Sidebar opens/closes via hamburger or swipe gesture without layout breaking | ☐ ✅ ☐ ❌ | |
| MB4 | All tabs are reachable and load correctly on the iPhone viewport | ☐ ✅ ☐ ❌ | |
| MB5 | Equipment cards are fully visible and not cut off | ☐ ✅ ☐ ❌ | |
| MB6 | At least one command button (e.g., ATEM Cut) is tappable and executes successfully | ☐ ✅ ☐ ❌ | |
| MB7 | No horizontal scroll bleed (page does not scroll wider than the screen) | ☐ ✅ ☐ ❌ | |

**iPhone sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

### 4C — Mobile — iPad (Safari, latest iPadOS)

| # | Check | Result | Notes |
|---|-------|--------|-------|
| MC1 | Portal loads and renders correctly in portrait orientation | ☐ ✅ ☐ ❌ | |
| MC2 | Portal renders correctly in landscape orientation | ☐ ✅ ☐ ❌ | |
| MC3 | Sidebar is visible in landscape (not collapsed by default) if screen width allows | ☐ ✅ ☐ ❌ | |
| MC4 | All tabs load and equipment cards display correctly | ☐ ✅ ☐ ❌ | |
| MC5 | At least one command executes successfully from the iPad | ☐ ✅ ☐ ❌ | |

**iPad sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

## 5. AI Engineer Checks

> The AI Engineer tab allows natural language commands that get translated into device actions.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 5.1 | AI Engineer tab loads without error | ☐ ✅ ☐ ❌ | |
| 5.2 | Type a simple command: `"Switch the ATEM to input 2"` — command is understood and executed within 5 seconds | ☐ ✅ ☐ ❌ | |
| 5.3 | Portal equipment card updates to reflect the new state after the AI command | ☐ ✅ ☐ ❌ | |
| 5.4 | Type a multi-device command: `"Mute the front-of-house speakers and switch camera to preset 2"` — both actions execute | ☐ ✅ ☐ ❌ | |
| 5.5 | Type an ambiguous command: `"Turn off the lights"` — AI responds gracefully (either executes if applicable or explains it can't, rather than crashing) | ☐ ✅ ☐ ❌ | |
| 5.6 | Type a clearly invalid command: `"Make coffee"` — AI returns a friendly error, no crash, no unintended device action | ☐ ✅ ☐ ❌ | |
| 5.7 | AI command history is visible in the session (commands and results are logged in the UI) | ☐ ✅ ☐ ❌ | |
| 5.8 | AI Engineer works correctly from mobile (iPhone/iPad Safari) — type and submit a command successfully | ☐ ✅ ☐ ❌ | |

**AI Engineer sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

## 6. Network Scan

> Verify the built-in network scan discovers devices on the local LAN.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| 6.1 | Navigate to the **Network** tab in the portal | ☐ ✅ ☐ ❌ | |
| 6.2 | Initiate a network scan; a progress indicator appears | ☐ ✅ ☐ ❌ | |
| 6.3 | Scan completes within a reasonable time (< 60 seconds for a /24 subnet) | ☐ ✅ ☐ ❌ | |
| 6.4 | Results appear in the portal listing discovered devices by IP and (if available) hostname | ☐ ✅ ☐ ❌ | |
| 6.5 | At least one known AV device (e.g., ATEM, VideoHub) appears in the scan results at its correct IP | ☐ ✅ ☐ ❌ | |
| 6.6 | Device type is identified correctly where possible (e.g., Blackmagic device detected as such) | ☐ ✅ ☐ ❌ | |
| 6.7 | Scan results persist in the portal until manually cleared or a new scan is run | ☐ ✅ ☐ ❌ | |
| 6.8 | Running a second scan replaces (not duplicates) the previous results | ☐ ✅ ☐ ❌ | |

**Network Scan sign-off:** ☐ Pass &nbsp; ❌ Issues: `___________`

---

## 7. Known Edge Cases

> These are scenarios that have caused issues in past releases. Test each one explicitly.

### 7A — VideoHub Socket Reconnect

**Steps:**
1. Connect VideoHub in church-client — confirm Connected.
2. Unplug the VideoHub's network cable for ~15 seconds, then reconnect.
3. Watch the church-client log.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EA1 | Client logs show `socket closed` event within 30 seconds of cable pull | ☐ ✅ ☐ ❌ | |
| EA2 | Client attempts to reconnect automatically (logs show `reconnecting`) | ☐ ✅ ☐ ❌ | |
| EA3 | After cable is restored, client fully re-establishes connection (logs show `connected`) | ☐ ✅ ☐ ❌ | |
| EA4 | A routing command sent after reconnect executes correctly (no silent failure on a dead socket) | ☐ ✅ ☐ ❌ | |

---

### 7B — SQ7 MIDI Channel Mismatch

**Steps:**
1. Set the church-client SQ MIDI channel to **0** (invalid).
2. Send a mute command.
3. Reset MIDI channel to **1**, re-test.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EB1 | With MIDI channel 0: command fails gracefully with an error in the client (not a silent no-op) | ☐ ✅ ☐ ❌ | |
| EB2 | With MIDI channel 1: mute command executes correctly | ☐ ✅ ☐ ❌ | |
| EB3 | Portal reflects the failure state for EB1 rather than falsely showing success | ☐ ✅ ☐ ❌ | |

---

### 7C — vMix IPv6 Resolution

**Steps:**
1. In church-client, enter the vMix machine's **hostname** (not IP).
2. On a machine that prefers IPv6, observe whether the connection fails.
3. Swap to the explicit IPv4 address and retest.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EC1 | When hostname resolves to IPv6: connection fails with a clear error message (not a silent hang) | ☐ ✅ ☐ ❌ | |
| EC2 | Using explicit IPv4 address: connection succeeds | ☐ ✅ ☐ ❌ | |
| EC3 | Documentation / in-app tooltip advises using IPv4 for vMix | ☐ ✅ ☐ ❌ | |

---

### 7D — Portal Stale State After Client Reconnect

**Steps:**
1. Connect client with ATEM on Input 1.
2. Disconnect client.
3. Manually switch ATEM to Input 3 using physical buttons.
4. Reconnect client.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| ED1 | After reconnect, portal reflects the **current** ATEM state (Input 3), not the stale cached state (Input 1) | ☐ ✅ ☐ ❌ | |

---

### 7E — Multiple Simultaneous Portal Sessions

**Steps:**
1. Open the portal in two different browsers (or two incognito tabs) logged into the same room.
2. Send a command from Browser A.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EE1 | Browser B reflects the state change in real-time without a page refresh | ☐ ✅ ☐ ❌ | |
| EE2 | No duplicate commands are sent to the device (only one command per action) | ☐ ✅ ☐ ❌ | |

---

### 7F — Relay Downtime / Railway Restart

**Steps:**
1. With client connected, restart the Railway service (or simulate with a network block).
2. Wait for relay to come back online.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EF1 | Client shows **Disconnected** state during relay downtime | ☐ ✅ ☐ ❌ | |
| EF2 | Client automatically reconnects once relay is back (no manual intervention required) | ☐ ✅ ☐ ❌ | |
| EF3 | Room re-registers in portal after reconnect | ☐ ✅ ☐ ❌ | |
| EF4 | All equipment status is re-polled and portal reflects current state after reconnect | ☐ ✅ ☐ ❌ | |

---

### 7G — Large Room Config (Many Devices)

**Steps:**
1. Add 5+ devices simultaneously in church-client.

| # | Check | Result | Notes |
|---|-------|--------|-------|
| EG1 | All devices connect without timeouts or race conditions | ☐ ✅ ☐ ❌ | |
| EG2 | Portal loads all equipment cards without layout issues | ☐ ✅ ☐ ❌ | |
| EG3 | Commands to different devices do not interfere with each other | ☐ ✅ ☐ ❌ | |

**Edge Cases sign-off:** ☐ All edge cases passed &nbsp;|&nbsp; ❌ Issues: `___________`

---

## 8. Sign-Off Criteria

> Every row below must be ✅ before the release is approved. Enter your initials and date when complete.

| Section | Status | Sign-Off | Date |
|---------|--------|----------|------|
| 1. Pre-Flight Checks | ☐ ✅ ☐ ❌ | | |
| 2. Core Connection Flow | ☐ ✅ ☐ ❌ | | |
| 3A. ATEM Switcher | ☐ ✅ ☐ ❌ | | |
| 3B. VideoHub Router | ☐ ✅ ☐ ❌ | | |
| 3C. Allen & Heath SQ | ☐ ✅ ☐ ❌ | | |
| 3D. Allen & Heath Avantis | ☐ ✅ ☐ ❌ | | |
| 3E. BirdDog PTZ Cameras | ☐ ✅ ☐ ❌ | | |
| 3F. vMix | ☐ ✅ ☐ ❌ | | |
| 3G. ProPresenter | ☐ ✅ ☐ ❌ | | |
| 3H. HyperDeck Recorders | ☐ ✅ ☐ ❌ | | |
| 3I. OBS Studio | ☐ ✅ ☐ ❌ | | |
| 3J. Bitfocus Companion | ☐ ✅ ☐ ❌ | | |
| 3K. Resolume | ☐ ✅ ☐ ❌ | | |
| 4A. Portal — Desktop Browser | ☐ ✅ ☐ ❌ | | |
| 4B. Portal — iPhone Safari | ☐ ✅ ☐ ❌ | | |
| 4C. Portal — iPad Safari | ☐ ✅ ☐ ❌ | | |
| 5. AI Engineer | ☐ ✅ ☐ ❌ | | |
| 6. Network Scan | ☐ ✅ ☐ ❌ | | |
| 7. Known Edge Cases | ☐ ✅ ☐ ❌ | | |

---

### Overall Release Decision

| | |
|---|---|
| **Release approved?** | ☐ Yes — all sections passed &nbsp;&nbsp; ☐ No — see issues below |
| **Open issues blocking release** | |
| **Open issues not blocking (defer to next release)** | |
| **Approved by** | |
| **Date approved** | |

---

*TallyConnect QA Release Checklist — maintained by the TallyConnect team. Update this document whenever a new edge case is discovered or a new device type is added.*
