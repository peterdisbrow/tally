# Tally How-To Guides

<!-- CATEGORIES
1. Getting Started | H01, H02, H03, H04
2. Equipment Integrations | H05, H07, H08, H09, H10, H11
3. Automation and Companion | H06, H13
4. Troubleshooting | H12, H14
5. Operations | H15
-->

---

## H01: Install Tally Desktop (Mac)
<!-- category: Getting Started -->
<!-- time: 5 min -->
<!-- summary: Install Tally, launch successfully, allow required permissions, and confirm app readiness. -->

### Who This Is For

Church tech directors and volunteers installing Tally on a Mac for the first time.

### What You Will Accomplish

- Install Tally on your Mac
- Launch the app successfully
- Allow required macOS permissions
- Confirm the app is ready for setup

### Prerequisites

- [ ] Supported macOS version for current build
- [ ] Local admin rights on the Mac
- [ ] Internet access for first login and relay connectivity

### Step-by-Step Setup

**Step 1 — Download the Installer**

Download the latest Tally `.dmg` file from the official source provided by your admin or reseller.

**Step 2 — Open the DMG**

Double-click the downloaded `.dmg` file to mount the disk image.

**Step 3 — Drag to Applications**

Drag `Tally by ATEM School.app` into the `Applications` folder.

**Step 4 — Eject the Installer**

Right-click the mounted disk image on your desktop and choose **Eject**.

**Step 5 — Launch Tally**

Open the app from `Applications`. If macOS shows a security warning, click **Open** to proceed.

> **Note:** If macOS blocks the app entirely, go to `System Settings > Privacy & Security` and click **Open Anyway**.

### Validation Checklist

- [ ] App opens to sign-in/setup screen
- [ ] No startup crash dialog appears
- [ ] UI is visible (not black screen)
- [ ] App can close and reopen cleanly

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "App can't be opened" | Gatekeeper blocking unsigned app | Right-click app in Applications → Open; allow in System Settings > Privacy & Security |
| Black screen on launch | Stale local config or rendering issue | Fully quit app, relaunch; clear stale local config if persistent |
| High helper resource usage | Multiple app instances running | Ensure only one instance of Tally is running |
| "Damaged app" warning | Corrupted download | Redownload the installer DMG and retry |

### Rollback / Fallback

1. Delete Tally from `Applications`.
2. Reboot the Mac.
3. Reinstall from a fresh DMG download.
4. Retry launch and validation.

### Screenshot Placeholders

![Download page](screenshot:H01-download-page)
![DMG drag to Applications](screenshot:H01-dmg-drag)
![First launch security prompt](screenshot:H01-security-prompt)
![Successful sign-in landing](screenshot:H01-signin-landing)

---

## H02: Create Church Account + First Sign-In
<!-- category: Getting Started -->
<!-- time: 8 min -->
<!-- summary: Create your church account, verify your email, and complete first sign-in to the Tally app. -->

### Who This Is For

Church admins creating their first Tally account and signing into the desktop app.

### What You Will Accomplish

- Register a new church account
- Verify your admin email address
- Complete your first successful app sign-in

### Prerequisites

- [ ] Access to church admin email inbox
- [ ] Internet access from the app machine
- [ ] Active relay environment (provided by your admin)

### Step-by-Step Setup

**Step 1 — Open the Signup Page**

Navigate to the account signup page in your browser.

**Step 2 — Enter Church Details**

Fill in your church name, admin email, and a strong password.

> **Safety:** Store your admin credentials in a password manager. Do not share them via email or chat.

**Step 3 — Submit Signup**

Click **Create Account** to submit your registration.

**Step 4 — Verify Your Email**

Open the verification email in your inbox and click the verify link.

> **Note:** Check your spam/junk folder if the email doesn't arrive within a few minutes.

**Step 5 — Launch the Tally App**

Open the Tally desktop app on your Mac.

**Step 6 — Sign In**

Enter your email and password, then click **Sign In**.

**Step 7 — Confirm Church Name**

Verify that your church name appears correctly in the app profile area.

### Validation Checklist

- [ ] Verification email received
- [ ] Email verification link succeeds
- [ ] App sign-in returns success
- [ ] Session persists after app restart

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid email or password" | Typo in credentials | Confirm exact email case/spacing and password |
| "Email not verified" | Verification not completed | Re-send verify email from the portal and retry |
| Sign-in fails after account creation | Wrong relay domain | Confirm app points to the correct relay URL |
| Session resets repeatedly | Clock skew or token expiry | Check system clock accuracy; contact admin if persistent |

### Rollback / Fallback

1. Reset your password from the portal login page.
2. Re-verify your email if the link expired.
3. Retry sign-in using the correct relay environment.

### Screenshot Placeholders

![Signup form](screenshot:H02-signup-form)
![Verification email example](screenshot:H02-verify-email)
![App sign-in form](screenshot:H02-signin-form)
![Successful signed-in state](screenshot:H02-signed-in)

---

## H03: Connect to Relay + Verify Connection
<!-- category: Getting Started -->
<!-- time: 5 min -->
<!-- summary: Confirm your relay target, establish a connection, and validate a healthy API response. -->

### Who This Is For

Operators who need to verify app-to-relay connectivity before service.

### What You Will Accomplish

- Confirm the correct relay URL in settings
- Establish a live WebSocket connection
- Validate a healthy API response from the relay

### Prerequisites

- [ ] Valid church credentials (signed in)
- [ ] Relay URL known for your environment
- [ ] Outbound network access from the booth machine

### Step-by-Step Setup

**Step 1 — Open App Settings**

Open the Tally app and navigate to the settings panel.

**Step 2 — Confirm Relay URL**

Verify that the relay URL is set to the production canonical URL (e.g., `wss://api.tallyconnect.app`).

**Step 3 — Save Settings**

Save any changes to the relay configuration.

**Step 4 — Run Connection Test**

Use the in-app connection test to verify connectivity.

**Step 5 — Verify Connected Status**

Confirm the app status indicator shows the relay as connected.

**Step 6 — Optional CLI Health Check**

From a terminal on the same network, run:

```bash
curl -sS https://api.tallyconnect.app/api/health
```

You should see a JSON response with `uptime` and `status` fields.

### Validation Checklist

- [ ] Relay connection test passes
- [ ] WebSocket connection established
- [ ] Health endpoint returns JSON with uptime/status
- [ ] No repeated auth/timeout errors in app logs

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Unauthorized error | Token/session mismatch or wrong relay | Re-authenticate and confirm relay URL |
| DNS resolution failure | Stale DNS or wrong CNAME | Flush DNS cache; verify domain records |
| Old relay URL in config | Legacy Railway URL not updated | Remove legacy URL and set canonical relay domain |
| Firewall blocking connection | Outbound TLS blocked | Allow outbound traffic to the relay domain on port 443 |

### Rollback / Fallback

1. Restore the known-good relay URL.
2. Re-authenticate your user session.
3. Retry the connection test.

### Screenshot Placeholders

![Relay settings panel](screenshot:H03-relay-settings)
![Connection test success](screenshot:H03-test-success)
![Connection test failure states](screenshot:H03-test-failure)
![Health endpoint JSON example](screenshot:H03-health-json)

---

## H04: First Equipment Setup Wizard
<!-- category: Getting Started -->
<!-- time: 10 min -->
<!-- summary: Complete the initial equipment setup wizard and save a stable baseline config. -->

### Who This Is For

New deployments configuring equipment quickly with minimal manual edits.

### What You Will Accomplish

- Run the setup wizard to completion
- Configure your primary devices (ATEM, encoder, Companion)
- Save a stable baseline configuration

### Prerequisites

- [ ] Signed in to the Tally app
- [ ] Device IP addresses known or network discovery available
- [ ] Correct NIC selected on multi-NIC systems

### Step-by-Step Setup

**Step 1 — Start the Setup Wizard**

Open the equipment configuration and start the setup wizard.

**Step 2 — Configure ATEM IP**

Enter the IP address of your ATEM switcher (e.g., `192.168.1.240`).

**Step 3 — Configure Primary Encoder**

Select your encoder type (OBS, vMix, or hardware) and enter the connection details.

**Step 4 — Configure Companion**

If you use Bitfocus Companion, enter the host and port (default: `8888`).

**Step 5 — Configure Optional Integrations**

Add any optional integrations: HyperDeck, ProPresenter, audio mixer, PTZ cameras.

> **Note:** You can skip optional integrations and add them later from the Equipment tab.

**Step 6 — Save Wizard Config**

Review your settings and click **Save**.

**Step 7 — Restart the App**

Restart the Tally app once to apply the new configuration.

### Validation Checklist

- [ ] Config persists after restart
- [ ] Required devices show connected/expected state
- [ ] Unconfigured devices are not treated as critical failures
- [ ] No repeated polling errors for disabled integrations

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Wrong ports entered | Vendor-specific default ports differ | Check vendor documentation for correct API ports |
| Device not discoverable | Subnet/NIC or VLAN routing issue | Verify network path between Tally machine and device |
| Config not persisting | Write permissions issue | Check write permissions to the config file path |
| Cluttered equipment UI | Unused integrations enabled | Disable integrations you are not using |

### Rollback / Fallback

1. Reopen the setup wizard.
2. Remove optional device configurations.
3. Save a minimal known-good config with only essential devices.

### Screenshot Placeholders

![Wizard start screen](screenshot:H04-wizard-start)
![Equipment configuration step](screenshot:H04-equipment-step)
![Save confirmation](screenshot:H04-save-confirm)
![Post-restart dashboard state](screenshot:H04-dashboard)

---

## H05: ATEM Setup + Auto-Detect Model
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- summary: Connect your ATEM switcher, verify model detection, and run control smoke tests. -->

### Who This Is For

Teams using Blackmagic ATEM switchers as their primary video control path.

### What You Will Accomplish

- Connect Tally to your ATEM switcher
- Verify automatic model detection
- Run smoke tests for switching, streaming, and recording

### Prerequisites

- [ ] ATEM and Tally machine on the same routable network
- [ ] ATEM IP address known or discovered via network scan
- [ ] ATEM reachable from the booth machine (ping test passes)

### Step-by-Step Setup

**Step 1 — Enter ATEM IP**

Open Equipment settings and enter your ATEM IP address.

**Step 2 — Connect and Wait**

Click **Connect** and wait for the status update. The connection typically takes 2-5 seconds.

**Step 3 — Confirm Model Detection**

Check that the detected model name appears in the ATEM status panel (e.g., "ATEM Mini Pro ISO").

**Step 4 — Run Smoke Commands**

Test these basic control commands:

1. Set preview input
2. Set program input
3. Execute a **Cut** transition
4. Execute an **Auto** transition
5. Check streaming/recording state readback

**Step 5 — Verify Audio Detection**

If using ATEM audio path, confirm that audio source detection shows expected inputs.

> **Implementation Note:** Audio source detection uses the ATEM SDK's audio state. If your model uses Fairlight audio, detection may differ from classic audio models.

### Validation Checklist

- [ ] ATEM connected state is stable (no reconnect loops)
- [ ] Model detected correctly
- [ ] Program/preview input changes succeed
- [ ] Cut/Auto transition commands succeed
- [ ] Stream/record state readback updates accurately

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| ATEM unreachable | Subnet mismatch or wrong IP | Verify IP and ensure both devices are on the same VLAN |
| Intermittent disconnects | Network instability | Use a wired Ethernet connection instead of Wi-Fi |
| Command errors | Unsupported function on model/firmware | Check ATEM firmware version; some commands require specific models |
| Audio source detection unclear | ATEM audio routing misconfigured | Validate audio routing in ATEM Software Control |

### Rollback / Fallback

1. Disable advanced ATEM commands.
2. Keep basic switching only (cut/auto).
3. Operate advanced functions from ATEM Software Control or hardware panel.

### Screenshot Placeholders

![ATEM config block](screenshot:H05-atem-config)
![Connected with model detected](screenshot:H05-connected-model)
![Program/preview test result](screenshot:H05-switching-test)
![Stream/record status panel](screenshot:H05-stream-status)

---

## H06: Companion Integration Quick Start
<!-- category: Automation and Companion -->
<!-- time: 8 min -->
<!-- summary: Connect Tally to Bitfocus Companion and trigger button actions reliably. -->

### Who This Is For

Teams already using Bitfocus Companion for device control and macros.

### What You Will Accomplish

- Connect Tally to your Companion instance
- Trigger button actions by page/row/column
- Trigger button actions by named button

### Prerequisites

- [ ] Companion host IP and port known (default port: 8888)
- [ ] Companion instance running with expected module connections
- [ ] Tally can reach Companion over the network

### Step-by-Step Setup

**Step 1 — Enter Companion URL**

In Tally Equipment settings, enter the Companion URL (e.g., `http://192.168.1.100:8888`).

**Step 2 — Save and Test Connection**

Save the setting and run the connection test. Companion should report as reachable.

**Step 3 — Create a Test Button in Companion**

In Companion's web UI, create a test button labeled `Test: Ping`.

**Step 4 — Trigger by Page/Row/Col**

From Tally, trigger the button using the page, row, and column coordinates:

```json
{
  "command": "companion.press",
  "params": { "page": 1, "row": 0, "col": 0 }
}
```

**Step 5 — Trigger by Named Button**

Trigger the same button using its label:

```json
{
  "command": "companion.pressNamed",
  "params": { "name": "Test: Ping" }
}
```

> **Note:** Named button matching is case-sensitive. The label must match exactly as shown in Companion.

### Validation Checklist

- [ ] Companion reports reachable from Tally
- [ ] `companion.connections` returns expected module list
- [ ] `companion.press` succeeds with correct coordinates
- [ ] `companion.pressNamed` succeeds with correct label
- [ ] Wrong button name returns a clear error message

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Companion shows 0 connections | Modules misconfigured or not loaded | Open Companion UI and verify module status |
| API path mismatch | Companion version incompatibility | Verify Companion version supports the HTTP API |
| Named press fails | Exact label mismatch (case-sensitive) | Copy the label directly from Companion's button config |
| Intermittent connection | Host instability or LAN issues | Check host machine stability and wired network path |

### Rollback / Fallback

1. Keep Companion in manual-only operation mode.
2. Disable Tally Companion triggers until the connection is stable.

### Screenshot Placeholders

![Companion config in Tally](screenshot:H06-companion-config)
![Companion status card](screenshot:H06-companion-status)
![Named button test example](screenshot:H06-named-test)
![Error handling example](screenshot:H06-error-example)

---

## H07: Control Multiple Power Outlets
<!-- category: Equipment Integrations -->
<!-- time: 12 min -->
<!-- summary: Control 3-12+ outlets from Tally via Companion with safe naming and sequencing. -->

### Who This Is For

Teams that want remote power control for AV equipment without enterprise PDU costs.

### What You Will Accomplish

- Set up outlet control via Companion modules
- Create safely-named power buttons
- Trigger on/off/cycle actions from Tally

### Prerequisites

- [ ] Tally connected to relay
- [ ] Companion reachable from Tally
- [ ] Outlet hardware installed and tested manually
- [ ] Network path between Companion and outlet devices confirmed

### Step-by-Step Setup

**Step 1 — Add Outlet Module in Companion**

In Companion, add the module for your outlet device (e.g., TP-Link Kasa, Shelly, Tasmota).

> **Note:** Budget path: TP-Link Kasa smart strips are the cheapest and easiest starting point. Pro path: managed PDU class (Digital Loggers, APC, CyberPower) for rack deployments.

**Step 2 — Confirm Module Connection**

Verify the module shows as connected in Companion with the expected device list.

**Step 3 — Create Named Buttons**

Create buttons using this naming standard:

- `Power: FOH Rack On`
- `Power: FOH Rack Off`
- `Power: FOH Rack Cycle`

**Step 4 — Test Directly in Companion**

Press each button in Companion's web UI to verify the outlet responds correctly.

**Step 5 — Trigger from Tally**

Send commands from Tally using `companion.pressNamed`:

```json
{
  "command": "companion.pressNamed",
  "params": { "name": "Power: FOH Rack Cycle" }
}
```

> **Safety:** Do not cycle your core network switch unintentionally. Do not cycle ATEM + encoder + switch simultaneously. Use cooldowns on repeated cycle actions. Always keep a manual rack fallback path.

### Validation Checklist

- [ ] Companion reachable from Tally
- [ ] On/off/cycle actions execute expected outlet state changes
- [ ] Gear reboots predictably when cycling
- [ ] Invalid button names return an actionable error

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No button found | Naming mismatch between Tally and Companion | Verify exact button label (case-sensitive) |
| Module connected but outlet not switching | Auth or IP issue on the outlet device | Check device credentials and IP in Companion module config |
| Unstable switching behavior | Wi-Fi path unreliable | Move outlet devices to wired LAN where possible |
| Gear fails after power cycle | No delay between power-off and power-on | Add delays and sequence rules between cycle actions |

### Rollback / Fallback

1. Disable outlet automations in Tally.
2. Keep manual control through Companion's web UI.
3. Reintroduce one outlet action at a time.

### Screenshot Placeholders

![Companion outlet module status](screenshot:H07-outlet-module)
![Power button bank naming example](screenshot:H07-button-naming)
![Tally named command mapping](screenshot:H07-tally-command)
![Validation checklist pass state](screenshot:H07-validation)

---

## H08: ProPresenter Setup + Deep Control
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- summary: Connect ProPresenter and control navigation, looks, timers, and stage messages from Tally. -->

### Who This Is For

Churches using ProPresenter for slides, stage display, and production messaging.

### What You Will Accomplish

- Connect Tally to ProPresenter
- Control slide navigation
- Use advanced features: looks, timers, and stage messages

### Prerequisites

- [ ] ProPresenter host IP and API port known
- [ ] API access enabled in ProPresenter settings
- [ ] Tally host can reach ProPresenter over the network

### Step-by-Step Setup

**Step 1 — Configure ProPresenter Connection**

In Equipment settings, enter the ProPresenter host and port.

**Step 2 — Connect and Verify**

Connect and confirm the running status shows as active.

**Step 3 — Test Baseline Commands**

Run these navigation commands:

1. Next slide / Previous slide
2. Go to slide by index
3. Clear current slide / Clear all

**Step 4 — Test Deep Commands**

Run these advanced commands:

1. Get looks → Set a specific look
2. Get timers → Start/stop a timer
3. Send stage message → Clear stage message

**Step 5 — Validate Status Readback**

Confirm version and current slide metadata updates in the Tally status panel.

### Validation Checklist

- [ ] ProPresenter connected and running status accurate
- [ ] Slide navigation commands succeed
- [ ] Look/timer/message commands succeed
- [ ] Current slide metadata updates in status panel

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Connected: false | Wrong host/port or API disabled | Verify ProPresenter network settings and enable API access |
| Command succeeds but no visual change | Wrong target playlist or trigger state | Check the active playlist and presentation in ProPresenter |
| Stage message not visible | Stage display misconfigured | Verify stage display layout in ProPresenter preferences |
| Timer actions do nothing | Timer ID mismatch | List timers first to get correct IDs, then use those IDs |

### Rollback / Fallback

1. Keep Tally in monitoring-only mode for ProPresenter.
2. Execute live slide actions directly from ProPresenter until control confidence is restored.

### Screenshot Placeholders

![ProPresenter connection config](screenshot:H08-pro-config)
![Command test panel](screenshot:H08-command-test)
![Looks and timers controls](screenshot:H08-looks-timers)
![Stage message action result](screenshot:H08-stage-message)

---

## H09: Encoder Setup (OBS/vMix/Hardware/NDI)
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- summary: Set your default encoder path, verify live status telemetry, and confirm control capabilities. -->

### Who This Is For

Teams streaming through OBS, vMix, TriCaster, hardware encoders, or NDI monitoring paths.

### What You Will Accomplish

- Configure your default encoder
- Verify live status telemetry
- Confirm control capabilities by encoder type

### Prerequisites

- [ ] Encoder type selected (OBS, vMix, TriCaster, hardware, NDI)
- [ ] Host/IP and credentials available
- [ ] Network route confirmed from Tally machine to encoder

### Step-by-Step Setup

**Step 1 — Choose Default Encoder**

In Equipment settings, select your encoder type from the dropdown.

**Step 2 — Configure Type-Specific Fields**

Enter the connection details for your encoder type:

- **OBS**: host, port, password
- **vMix**: host, port
- **TriCaster**: host, port, auth credentials if needed
- **Hardware encoder**: vendor-specific host and credentials
- **NDI monitor**: source name and ffprobe prerequisites

**Step 3 — Save and Connect**

Save the encoder configuration and initiate the connection.

**Step 4 — Run Status Check**

Verify the encoder status panel shows connected with live telemetry.

**Step 5 — Test Control Actions**

Test supported actions (availability varies by encoder type):

1. Start/stop stream
2. Start/stop recording
3. Status readback verification

> **Implementation Note:** Hardware encoders and NDI monitors are typically read-only. Unsupported actions will return an explicit error rather than failing silently.

### Validation Checklist

- [ ] Encoder connected state is accurate
- [ ] Live/recording status updates in near-real-time
- [ ] Unsupported actions return explicit "unsupported" error
- [ ] OBS/vMix telemetry fields populate when available

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| NDI monitor missing data | ffprobe or libndi support not installed | Install ffprobe and verify NDI runtime is available |
| TriCaster partial control | API surface varies by installation | Check TriCaster firmware version and API documentation |
| Hardware encoder read-only | Expected for RTMP push-only encoders | Use encoder's native UI for control; Tally monitors only |
| Wrong default encoder selected | Wizard set a different encoder type | Change selection in Equipment settings (not wizard) |

### Rollback / Fallback

1. Set the encoder to monitoring-only mode.
2. Control streaming from the native encoder UI until the integration is stable.

### Screenshot Placeholders

![Encoder type selector](screenshot:H09-encoder-selector)
![Type-specific config blocks](screenshot:H09-config-blocks)
![Status panel with live/recording](screenshot:H09-status-panel)
![Unsupported action error example](screenshot:H09-unsupported-error)

---

## H10: Audio Console Setup (X32/A&H/Yamaha)
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- summary: Configure supported audio console controls and understand model/protocol limitations. -->

### Who This Is For

Teams integrating audio console status and control into Tally workflows.

### What You Will Accomplish

- Connect your audio console to Tally
- Run supported control commands
- Understand capability differences by console model

### Prerequisites

- [ ] Console model known (Behringer/Midas X32/M32, Allen & Heath SQ/dLive, Yamaha CL/QL)
- [ ] Console IP and control protocol enabled
- [ ] Network path confirmed from Tally machine to console

### Step-by-Step Setup

**Step 1 — Select Console Type**

In Equipment settings, choose your console type from the dropdown.

**Step 2 — Enter Connection Details**

Enter the host IP, port, and any model-specific options.

- **Behringer/Midas X32/M32**: UDP port `10023`
- **Allen & Heath SQ/dLive**: UDP port `51326`
- **Yamaha CL/QL**: UDP port `8765`

**Step 3 — Connect and Verify**

Connect and verify the console shows as online in the status panel.

**Step 4 — Run Supported Commands**

Test available commands:

1. Mute/unmute a channel
2. Set fader level
3. Check main mute state
4. Scene recall (if supported by your console)

**Step 5 — Review Capability Map**

Check the capability notes in the app to understand which features are full, partial, or unsupported for your console model.

> **Implementation Note:** Allen & Heath and Yamaha consoles have more limited protocol support compared to Behringer/Midas. Scene save is not available via remote protocol on most models.

### Validation Checklist

- [ ] Console connected state is accurate
- [ ] Main mute status updates correctly
- [ ] Supported commands execute as expected
- [ ] Unsupported commands return a clear explanation

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Feature gaps on Yamaha/A&H | Protocol limitations by model/firmware | Check the capability map; some functions are console-only |
| Port mismatch | Non-default control port configured | Verify vendor default control port in documentation |
| Delayed state updates | Polling interval and network latency | Expected behavior; allow 1-2 seconds for state sync |
| Scene save unavailable | Protocol does not support remote scene save | Use console's native workflow for scene management |

### Rollback / Fallback

1. Keep the console in monitoring-only mode.
2. Use the console's physical controls for unsupported advanced functions.

### Screenshot Placeholders

![Console config panel](screenshot:H10-console-config)
![Connected state with model](screenshot:H10-connected-model)
![Command success and unsupported examples](screenshot:H10-command-results)
![Main mute warning example](screenshot:H10-mute-warning)

---

## H11: PTZ Setup (ONVIF/VISCA/PTZOptics)
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- summary: Connect PTZ cameras, control movement, and save/recall presets using supported protocols. -->

### Who This Is For

Teams operating one or more PTZ cameras from Tally.

### What You Will Accomplish

- Connect PTZ cameras using supported protocols
- Control pan, tilt, zoom, and home position
- Save and recall camera presets

### Prerequisites

- [ ] Camera IP addresses known
- [ ] Credentials available if required (ONVIF)
- [ ] Protocol choice known: `auto`, `onvif`, `visca-udp`, `visca-tcp`, `ptzoptics-tcp`, `ptzoptics-udp`

### Step-by-Step Setup

**Step 1 — Add Cameras**

In the PTZ equipment section, add each camera with:

1. Camera name (e.g., "Stage Left")
2. IP address
3. Protocol (`auto` recommended for first setup)
4. Port (if non-default)
5. Credentials (if using ONVIF)

**Step 2 — Connect All Cameras**

Click **Connect** for each camera and verify connectivity.

**Step 3 — Run Movement Tests**

Test basic movement commands for each camera:

1. Pan left / right
2. Tilt up / down
3. Zoom in / out
4. Stop
5. Home position

**Step 4 — Run Preset Tests**

Test preset operations:

1. Move camera to a desired position
2. Save as preset (e.g., preset 1)
3. Move camera away
4. Recall the preset and verify it returns

### Validation Checklist

- [ ] Camera connectivity status accurate for each camera
- [ ] Movement commands execute smoothly
- [ ] Home command returns camera to home position
- [ ] Preset set and recall works correctly

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Auto protocol picks wrong path | Camera reports conflicting capabilities | Force an explicit protocol (e.g., `visca-tcp`) |
| VISCA UDP/TCP mismatch | Wrong transport selected | Verify camera documentation for correct VISCA transport |
| ONVIF auth errors | Wrong username/password or profile issue | Check credentials and ONVIF profile support on camera |
| All cameras offline | NIC/subnet routing issue | Verify cameras and Tally are on the same VLAN |

### Rollback / Fallback

1. Disable PTZ automation in Tally.
2. Keep manual camera control from the native PTZ controller.

### Screenshot Placeholders

![PTZ list config](screenshot:H11-ptz-list)
![Per-camera connection status](screenshot:H11-camera-status)
![Movement controls](screenshot:H11-movement-controls)
![Preset save/recall confirmation](screenshot:H11-preset-confirm)

---

## H12: Alerts, Tally Engineer, and Auto-Recovery
<!-- category: Troubleshooting -->
<!-- time: 10 min -->
<!-- summary: Understand how Tally detects issues, triggers alerts, and attempts automated recovery. -->

### Who This Is For

Teams relying on proactive issue detection and guided remediation during services.

### What You Will Accomplish

- Configure alert channels
- Understand Tally Engineer diagnostics
- Test controlled failure and recovery scenarios

### Prerequisites

- [ ] Core integrations connected (ATEM, encoder, etc.)
- [ ] Alert channels configured (Telegram bot token, chat IDs)
- [ ] Support workflows enabled in the portal

### Step-by-Step Setup

**Step 1 — Open Alert Configuration**

Navigate to the alert settings in your church portal or app config.

**Step 2 — Enable Critical Warning Channels**

Configure which alert channels should receive critical warnings (e.g., Telegram).

**Step 3 — Confirm Tally Engineer Visibility**

Verify that the Tally Engineer diagnostics panel is visible and showing data.

**Step 4 — Trigger Test Conditions**

In a non-production environment, trigger controlled test conditions:

1. Disconnect the ATEM (unplug or change IP)
2. Stop the encoder stream
3. Mute audio master (test only — restore immediately)

> **Safety:** Only trigger test conditions in a non-production environment. Restore all connections immediately after testing.

**Step 5 — Confirm Alert Flow**

For each test condition, verify:

1. Alert appears in the configured channel
2. Diagnostic data is captured
3. Auto-recovery attempt is recorded in the timeline

### Validation Checklist

- [ ] Alerts are generated for critical conditions
- [ ] Dedup/cooldown behavior prevents alert flooding
- [ ] Auto-recovery attempts are visible in logs/timeline
- [ ] Manual escalation path is available when auto-recovery fails

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Too many repeated alerts | Dedup/cooldown window too short | Tune the cooldown interval in alert settings |
| Missing alerts | Status polling disabled or channel misconfigured | Verify polling is active and channel credentials are correct |
| Recovery actions not firing | Permission/capability issue on target integration | Check that Tally has control access (not monitoring-only) |
| AI triage shows low signal | Diagnostics payload incomplete | Include richer status data in the support payload |

### Rollback / Fallback

1. Keep detection active but disable auto-recovery actions.
2. Switch to manual operator confirmation for all recovery commands.

### Screenshot Placeholders

![Alert settings panel](screenshot:H12-alert-settings)
![Alert timeline example](screenshot:H12-alert-timeline)
![Auto-recovery event record](screenshot:H12-recovery-record)
![Triage summary view](screenshot:H12-triage-summary)

---

## H13: Service Schedule + Automation Rules
<!-- category: Automation and Companion -->
<!-- time: 12 min -->
<!-- summary: Create service windows and automation rules that run reliably with safety constraints. -->

### Who This Is For

Teams running repeatable weekend workflows and timed operational actions.

### What You Will Accomplish

- Create service windows by day and time
- Build automation rules with triggers and actions
- Test rules safely before production use

### Prerequisites

- [ ] Church timezone configured correctly
- [ ] Baseline integrations connected
- [ ] Automation feature enabled for your billing tier

### Step-by-Step Setup

**Step 1 — Open the Schedule Tab**

Navigate to the schedule/automation section in the portal.

**Step 2 — Create Service Windows**

Define service windows by day and time (e.g., Sunday 8:00 AM - 12:30 PM).

**Step 3 — Add Automation Rules**

Create rules by selecting a trigger type:

1. **Schedule timer** — fires at a specific time within a service window
2. **Status/event trigger** — fires when a device status changes
3. **Manual trigger** — fires when explicitly invoked

**Step 4 — Add Actions with Ordering**

Add one or more actions to each rule. Set explicit order and delays between actions.

> **Safety:** Always add delays between power-cycle actions and device commands. Gear needs time to boot before receiving further instructions.

**Step 5 — Run a Dry Test**

Save the rule and run a dry test for one service window to verify timing and execution.

### Validation Checklist

- [ ] Service windows trigger at expected local time
- [ ] Rules fire once per intended event (no duplicates)
- [ ] No duplicate or runaway actions
- [ ] Command log captures each action and its result

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Wrong execution time | Timezone mismatch between church and server | Verify church timezone setting matches your local timezone |
| Rule not firing | Trigger conditions never met | Check that the trigger event actually occurs during the service window |
| Rule fires in a loop | Missing guard conditions | Add a "once per window" or cooldown guard to the rule |
| Actions too fast for gear | No delays between sequential commands | Add appropriate delays (5-15 seconds) between actions |

### Rollback / Fallback

1. Pause all automation rules.
2. Keep manual command workflows for the next service.
3. Re-enable rules one by one after testing each individually.

### Screenshot Placeholders

![Service window editor](screenshot:H13-service-editor)
![Rule builder](screenshot:H13-rule-builder)
![Dry-run test result](screenshot:H13-dry-run)
![Command log timeline](screenshot:H13-command-log)

---

## H14: Support Workflow (Triage + Ticket + Update)
<!-- category: Troubleshooting -->
<!-- time: 8 min -->
<!-- summary: Run the full support flow: triage an issue, create a ticket, and post updates. -->

### Who This Is For

Church admins and support operators handling incidents from the church portal.

### What You Will Accomplish

- Run an AI-assisted triage for an issue
- Create a support ticket from triage results
- Post updates and manage ticket status

### Prerequisites

- [ ] Support routes enabled on the relay
- [ ] Authenticated as a church admin or support user
- [ ] Diagnostics collection available (app connected and reporting status)

### Step-by-Step Setup

**Step 1 — Open Help/Support**

Navigate to the Help or Support section in the church portal.

**Step 2 — Run Triage**

Select the issue category and run the AI-assisted triage. The system will collect diagnostics and analyze the issue.

**Step 3 — Review Triage Result**

Review the triage result, which includes:

- Issue classification
- Severity assessment
- Recommended next steps

**Step 4 — Create Ticket**

Click **Create Ticket** to generate a support ticket from the triage payload.

**Step 5 — Add Updates**

Post update messages to the ticket as the issue progresses.

**Step 6 — Change Ticket Status**

Update the ticket status as appropriate (e.g., In Progress, Resolved).

### Validation Checklist

- [ ] Triage run is saved with diagnostics
- [ ] Ticket created successfully with correct metadata
- [ ] Updates are appended in chronological order
- [ ] Access controls enforce church/admin boundaries

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Unauthorized error | Wrong token or user role | Re-authenticate with the correct church admin credentials |
| Ticket not visible | Scope mismatch (church vs admin view) | Switch to the correct view (church portal vs admin dashboard) |
| Missing diagnostics | Status ingestion incomplete | Ensure the Tally app is connected and reporting status |
| Metadata update blocked | Church role restricted by design | Some metadata fields are admin-only; contact your admin |

### Rollback / Fallback

1. Use a manual support channel (email, phone) for urgent incidents.
2. Log the event details and create the ticket after the support route recovers.

### Screenshot Placeholders

![Triage form](screenshot:H14-triage-form)
![Triage result](screenshot:H14-triage-result)
![Ticket detail view](screenshot:H14-ticket-detail)
![Ticket update timeline](screenshot:H14-ticket-timeline)

---

## H15: Ops — Backups, Status Page, Logs, Updates
<!-- category: Operations -->
<!-- time: 12 min -->
<!-- summary: Configure backup cadence, monitor platform status, export logs, and execute safe updates. -->

### Who This Is For

Platform operators responsible for uptime and launch readiness.

### What You Will Accomplish

- Configure automated database backups
- Monitor platform status components
- Export logs for incident review
- Execute a safe update workflow

### Prerequisites

- [ ] Admin access to the relay server
- [ ] Environment variables for backups configured (BACKUP_DIR, BACKUP_ENCRYPTION_KEY)
- [ ] Storage path for snapshots confirmed and writable

### Step-by-Step Setup

**Step 1 — Configure Backup Environment**

Set the backup environment variables:

```bash
DB_BACKUP_INTERVAL_MINUTES=15
BACKUP_DIR=/data/backups
BACKUP_ENCRYPTION_KEY=your-encryption-key
BACKUP_RETAIN_COUNT=96
```

> **Note:** In production, backups default to every 15 minutes if `DB_BACKUP_INTERVAL_MINUTES` is not explicitly set. A startup warning will appear if no backup schedule is configured.

**Step 2 — Verify Backup Snapshots**

Check that backup files are being created on schedule:

```bash
ls -la /data/backups/
```

You should see timestamped `.sqlite.gz` or `.sqlite.gz.enc` files.

**Step 3 — Check Status Page**

Open the status components page and run health checks. Verify that relay API, portal, and proxy checks show their expected state (operational, degraded, or outage).

**Step 4 — Export Logs**

Export logs from both the app and server when testing or reviewing incidents.

**Step 5 — Perform Updates**

Execute the update process during a maintenance window:

1. Notify users of the maintenance window
2. Create a pre-update backup snapshot
3. Deploy the update
4. Run smoke tests
5. Verify status page shows all components operational

> **Safety:** Always create a backup snapshot before deploying updates. Run smoke tests before and after every deploy.

### Validation Checklist

- [ ] Backup files are created and retained per policy
- [ ] Status page updates at the expected interval
- [ ] Incident history records state transitions
- [ ] Log export contains enough detail for incident review

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No backups being created | DB_BACKUP_INTERVAL_MINUTES not set or set to 0 | Set the environment variable to a positive number (e.g., 15) |
| False proxy outage on status page | Check targets or response classification wrong | Verify proxy check URLs; 404/auth errors should show as degraded, not outage |
| Large or noisy log files | Verbose logging level in production | Tune logging levels to reduce noise |
| Update causes regressions | No pre/post deploy smoke tests | Always run the full smoke test set before and after deploy |

### Rollback / Fallback

1. Restore the latest verified backup snapshot.
2. Roll back to the previous known-good release.
3. Re-run smoke checks and status page checks after rollback.

### Screenshot Placeholders

![Backup config and snapshot list](screenshot:H15-backup-config)
![Status components dashboard](screenshot:H15-status-dashboard)
![Incident history panel](screenshot:H15-incident-history)
![Log export success](screenshot:H15-log-export)
