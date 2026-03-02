# Tally How-To Guides

<!-- CATEGORIES
1. Getting Started | H01, H02, H03, H04, H16
2. Equipment Integrations | H05, H07, H08, H09, H10, H11
3. Automation and Companion | H06, H13
4. Troubleshooting | H12, H14
5. Operations | H15
-->

---

## H01: Install Tally Desktop (Mac)
<!-- category: Getting Started -->
<!-- time: 5 min -->
<!-- difficulty: Beginner -->
<!-- summary: Install Tally on your Mac, open it for the first time, and confirm it's ready to go. -->

### Quick Start

1. Download the Tally installer file from the link your admin gave you
2. Double-click the downloaded file, then drag the Tally app into your Applications folder
3. Open Tally from Applications — if Mac asks for permission, click **Open**
4. Confirm you see the sign-in screen

### Who This Is For

Church tech directors and volunteers installing Tally on a Mac for the first time.

### What You Will Accomplish

- Install Tally on your Mac
- Launch the app successfully
- Allow required macOS permissions
- Confirm the app is ready for setup

### Prerequisites

- [ ] A Mac running a recent version of macOS
- [ ] Admin rights on the Mac (you can install apps)
- [ ] Internet access

### Step-by-Step Setup

**Step 1 — Download the Installer**

Download the Tally installer file from the link provided by your admin or reseller.

**Step 2 — Open the Installer**

Double-click the downloaded file to open it. You'll see the Tally app icon and an Applications folder shortcut.

**Step 3 — Drag to Applications**

Drag the Tally app into the Applications folder.

**Step 4 — Eject the Installer**

Right-click the installer icon on your desktop and choose **Eject**.

**Step 5 — Launch Tally**

Open the app from Applications. If macOS shows a security warning, click **Open** to continue.

> **Note:** If macOS blocks the app entirely, go to **System Settings > Privacy & Security** and click **Open Anyway**.

### Validation Checklist

- [ ] App opens to the sign-in screen
- [ ] No crash or error appears on launch
- [ ] The window is visible (not a black screen)
- [ ] App can close and reopen without issues

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "App can't be opened" | Mac is blocking an unrecognized app | Right-click the app in Applications → Open; or allow in System Settings > Privacy & Security |
| Black screen on launch | Stale settings or display glitch | Fully quit and reopen the app; delete any old config files if it persists |
| App feels slow | Multiple copies running | Make sure only one copy of Tally is open |
| "Damaged app" warning | The download was incomplete | Download the installer again and retry |

### Rollback / Fallback

1. Delete Tally from Applications.
2. Reboot the Mac.
3. Download a fresh installer and try again.

### Screenshot Placeholders

![Download page](screenshot:H01-download-page)
![Drag to Applications](screenshot:H01-dmg-drag)
![First launch security prompt](screenshot:H01-security-prompt)
![Successful sign-in screen](screenshot:H01-signin-landing)

---

## H02: Create Church Account + First Sign-In
<!-- category: Getting Started -->
<!-- time: 8 min -->
<!-- difficulty: Beginner -->
<!-- summary: Create your church account, verify your email, and sign in to the Tally app for the first time. -->

### Quick Start

1. Go to the signup page and enter your church name, email, and password
2. Open the verification email and click the link to confirm
3. Open the Tally app, enter your email and password, and click **Sign In**
4. Check that your church name appears in the app

### Who This Is For

Church admins creating their first Tally account and signing into the desktop app.

### What You Will Accomplish

- Register a new church account
- Verify your admin email address
- Complete your first successful app sign-in

### Prerequisites

- [ ] Access to your church admin email inbox
- [ ] Internet access on the computer running Tally
- [ ] Relay server address (provided by your admin)

### Step-by-Step Setup

**Step 1 — Open the Signup Page**

Go to the account signup page in your web browser.

**Step 2 — Enter Church Details**

Fill in your church name, admin email, and a strong password.

> **Security tip:** Save your login details in a password manager. Don't share them over email or chat.

**Step 3 — Submit Signup**

Click **Create Account** to register.

**Step 4 — Verify Your Email**

Open the verification email and click the link inside.

> **Note:** Check your spam or junk folder if the email doesn't arrive within a few minutes.

**Step 5 — Launch the Tally App**

Open the Tally desktop app on your Mac.

**Step 6 — Sign In**

Enter your email and password, then click **Sign In**.

**Step 7 — Confirm Church Name**

Make sure your church name appears correctly in the app.

### Validation Checklist

- [ ] Verification email received
- [ ] Email verification link works
- [ ] Sign-in completes successfully
- [ ] You stay signed in after restarting the app

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Invalid email or password" | Typo in email or password | Double-check your email spelling and password |
| "Email not verified" | You haven't clicked the verification link | Open the verification email and click the link, then try again |
| Sign-in fails after creating account | Wrong server address | Confirm the app is pointed at the correct server address |
| You keep getting signed out | Clock on your computer is wrong | Check that your computer's date and time are correct |

### Rollback / Fallback

1. Reset your password from the login page.
2. Re-send the verification email if the link expired.
3. Try signing in again with the correct server address.

### Screenshot Placeholders

![Signup form](screenshot:H02-signup-form)
![Verification email example](screenshot:H02-verify-email)
![App sign-in form](screenshot:H02-signin-form)
![Successful signed-in state](screenshot:H02-signed-in)

---

## H03: Connect to Relay + Verify Connection
<!-- category: Getting Started -->
<!-- time: 5 min -->
<!-- difficulty: Beginner -->
<!-- summary: Make sure your Tally app can talk to the server and confirm the connection is working. -->

### Quick Start

1. Open Tally and go to **Settings**
2. Confirm the server address is correct (your admin will provide this)
3. Click the **Test Connection** button
4. Look for the green "Connected" indicator

### Who This Is For

Anyone who needs to confirm the Tally app is connected to the server before a service.

### What You Will Accomplish

- Confirm the correct server address in settings
- Test the connection
- Verify everything is communicating properly

### Prerequisites

- [ ] Signed in to the Tally app
- [ ] Server address from your admin
- [ ] Internet access from the booth computer

### Step-by-Step Setup

**Step 1 — Open App Settings**

Open the Tally app and go to the settings panel.

**Step 2 — Confirm Server Address**

Make sure the server address matches what your admin provided (e.g., `api.tallyconnect.app`).

**Step 3 — Save Settings**

Save any changes you made.

**Step 4 — Run Connection Test**

Click the **Test Connection** button to check connectivity.

**Step 5 — Verify Connected Status**

Confirm the status indicator shows green / connected.

### Advanced Details

If the in-app test isn't enough, you can verify from a terminal:

```bash
curl -sS https://api.tallyconnect.app/api/health
```

You should see a response with `uptime` and `status` fields. This confirms the server is running and reachable from your network.

Common network terms your IT team may mention:
- **Port 443** — the standard secure web port (this should already be open on most networks)
- **DNS** — the system that converts web addresses to IP numbers
- **VLAN** — a network segment; your Tally computer and server need to be able to reach each other

### Validation Checklist

- [ ] Connection test passes in the app
- [ ] Status shows as connected
- [ ] No repeated errors in the app

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Unauthorized" error | Login expired or wrong server | Sign out, sign back in, and confirm the server address |
| Can't reach the server | Network or internet issue | Check your internet connection; ask IT if your network blocks outgoing connections |
| Old server address | Settings weren't updated | Remove the old address and enter the current one from your admin |
| Connection drops repeatedly | Firewall or network restriction | Ask your IT team to allow traffic to the server address |

### Rollback / Fallback

1. Put back the last known working server address.
2. Sign out and sign back in.
3. Retry the connection test.

### Screenshot Placeholders

![Server settings panel](screenshot:H03-relay-settings)
![Connection test success](screenshot:H03-test-success)
![Connection test failure](screenshot:H03-test-failure)
![Health check example](screenshot:H03-health-json)

---

## H04: First Equipment Setup Wizard
<!-- category: Getting Started -->
<!-- time: 10 min -->
<!-- difficulty: Beginner -->
<!-- summary: Walk through the setup wizard to connect your main equipment and save a working configuration. -->

### Quick Start

1. Open the equipment section and click **Start Setup Wizard**
2. Enter the IP address of your ATEM switcher
3. Add your streaming software (OBS, vMix, etc.) and any other equipment
4. Click **Save** and restart the app

### Who This Is For

New setups configuring equipment for the first time.

### What You Will Accomplish

- Run the setup wizard from start to finish
- Connect your main devices (ATEM, encoder, Companion)
- Save a working configuration

### Prerequisites

- [ ] Signed in to the Tally app
- [ ] Device IP addresses (ask your IT person or check each device's settings)
- [ ] All devices on the same network as the Tally computer

### Step-by-Step Setup

**Step 1 — Start the Setup Wizard**

Open the equipment settings and click **Start Setup Wizard**.

**Step 2 — Configure ATEM IP**

Enter the IP address of your ATEM switcher (e.g., `192.168.1.240`).

**Step 3 — Configure Streaming Software**

Select your streaming software (OBS, vMix, or hardware encoder) and enter the connection details.

**Step 4 — Configure Companion (optional)**

If your team uses Bitfocus Companion for button control, enter the address and port (default: `8888`).

**Step 5 — Add Optional Equipment**

Add any other equipment you use: HyperDeck, ProPresenter, audio mixer, PTZ cameras.

> **Note:** You can skip optional items and add them later from the Equipment tab.

**Step 6 — Save Your Settings**

Review everything and click **Save**.

**Step 7 — Restart the App**

Restart Tally to apply the new settings.

### Validation Checklist

- [ ] Settings are saved after restart
- [ ] Connected devices show the expected status
- [ ] Skipped devices aren't showing errors
- [ ] No repeated error messages

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Wrong port numbers | Different equipment uses different ports | Check your device's documentation for the correct port |
| Device not found | Tally computer can't reach the device | Make sure both are on the same network; try pinging the device IP |
| Settings disappear after restart | File permission issue | Check that Tally can save to its settings folder |
| Too many devices showing errors | Equipment you're not using is still enabled | Turn off integrations you're not using |

### Rollback / Fallback

1. Reopen the setup wizard.
2. Remove optional devices.
3. Save a simple configuration with just your essential equipment.

### Screenshot Placeholders

![Wizard start screen](screenshot:H04-wizard-start)
![Equipment configuration step](screenshot:H04-equipment-step)
![Save confirmation](screenshot:H04-save-confirm)
![Dashboard after restart](screenshot:H04-dashboard)

---

## H05: ATEM Setup + Auto-Detect Model
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- difficulty: Intermediate -->
<!-- summary: Connect your ATEM video switcher, verify it's detected, and test basic switching controls. -->

### Quick Start

1. Go to Equipment settings and enter your ATEM's IP address
2. Click **Connect** and wait a few seconds
3. Confirm the model name appears (e.g., "ATEM Mini Pro ISO")
4. Test switching between camera inputs

### Who This Is For

Teams using Blackmagic ATEM switchers for video switching.

### What You Will Accomplish

- Connect Tally to your ATEM switcher
- Verify the model is detected automatically
- Test basic switching, streaming, and recording controls

### Prerequisites

- [ ] ATEM and Tally computer on the same network
- [ ] ATEM IP address (check ATEM Software Control or your IT person)
- [ ] You can reach the ATEM from the booth computer

### Step-by-Step Setup

**Step 1 — Enter ATEM IP**

Open Equipment settings and enter your ATEM's IP address.

**Step 2 — Connect and Wait**

Click **Connect** and wait for the status to update. This usually takes 2-5 seconds.

**Step 3 — Confirm Model Detection**

Check that the correct model name appears in the ATEM status panel (e.g., "ATEM Mini Pro ISO").

**Step 4 — Test Basic Controls**

Try these basic controls:

1. Change the preview input
2. Change the program input
3. Do a **Cut** transition
4. Do an **Auto** transition
5. Check that streaming/recording status updates correctly

**Step 5 — Verify Audio Detection**

If you're using the ATEM for audio, confirm that audio sources show up correctly.

> **Note:** Audio detection works slightly differently depending on your ATEM model. Newer models use the Blackmagic Fairlight audio system, while older models use the classic audio mixer.

### Validation Checklist

- [ ] ATEM stays connected (no repeated disconnects)
- [ ] Model name is detected correctly
- [ ] Camera input changes work
- [ ] Cut/Auto transitions work
- [ ] Stream/record status updates properly

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| ATEM not reachable | Wrong IP or different network | Double-check the IP address; make sure both devices are on the same network |
| Keeps disconnecting | Unstable network connection | Use a wired Ethernet cable instead of Wi-Fi |
| Some commands fail | Feature not supported on your model | Check your ATEM's firmware version; some features need newer firmware |
| Audio sources not showing | Audio routing needs adjusting | Check audio routing in ATEM Software Control |

### Rollback / Fallback

1. Turn off advanced ATEM commands.
2. Keep basic switching only (cut/auto transitions).
3. Use ATEM Software Control or the hardware panel for advanced features.

### Screenshot Placeholders

![ATEM settings](screenshot:H05-atem-config)
![Connected with model name](screenshot:H05-connected-model)
![Switching test results](screenshot:H05-switching-test)
![Stream/record status](screenshot:H05-stream-status)

---

## H06: Companion Integration Quick Start
<!-- category: Automation and Companion -->
<!-- time: 8 min -->
<!-- difficulty: Advanced -->
<!-- summary: Connect Tally to Bitfocus Companion so you can trigger button actions from Tally. -->

### Quick Start

1. In Tally Equipment settings, enter your Companion address (e.g., `http://192.168.1.100:8888`)
2. Click **Save** and test the connection
3. Create a test button in Companion's web interface
4. Trigger the button from Tally and confirm it works

### Who This Is For

Teams already using Bitfocus Companion for device control and button macros.

### What You Will Accomplish

- Connect Tally to your Companion instance
- Trigger buttons by their position on the grid
- Trigger buttons by their name

### Prerequisites

- [ ] Companion address and port (default port: 8888)
- [ ] Companion running with at least one module connected
- [ ] Tally computer can reach Companion over the network

### Step-by-Step Setup

**Step 1 — Enter Companion Address**

In Tally Equipment settings, enter the Companion address (e.g., `http://192.168.1.100:8888`).

**Step 2 — Save and Test Connection**

Save and run the connection test. Companion should show as reachable.

**Step 3 — Create a Test Button in Companion**

In Companion's web interface, create a test button labeled `Test: Ping`.

**Step 4 — Trigger by Button Position**

From Tally, trigger the button using its position on the Companion grid — specify the page, row, and column.

**Step 5 — Trigger by Button Name**

Trigger the same button using its label name. The name must match exactly (including uppercase/lowercase letters).

### Advanced Details

When sending commands programmatically, Tally uses this format:

```json
{
  "command": "companion.press",
  "params": { "page": 1, "row": 0, "col": 0 }
}
```

Or by name:

```json
{
  "command": "companion.pressNamed",
  "params": { "name": "Test: Ping" }
}
```

The `companion.connections` command returns a list of all connected modules. Button names are case-sensitive — `"Test: Ping"` is not the same as `"test: ping"`.

API compatibility depends on your Companion version. Check Companion's documentation if commands aren't working.

### Validation Checklist

- [ ] Companion shows as reachable from Tally
- [ ] Button trigger by position works
- [ ] Button trigger by name works
- [ ] A wrong button name gives a clear error message

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Companion shows 0 connections | Modules not loaded or misconfigured | Open Companion and check that your modules are connected |
| Commands not working | Companion version doesn't support this feature | Update Companion and check its API documentation |
| Button name not found | Name doesn't match exactly | Copy the exact name from Companion's button settings |
| Connection drops | Network or Companion host instability | Check your network cable and make sure the Companion computer is stable |

### Rollback / Fallback

1. Use Companion manually from its own web interface.
2. Turn off Tally's Companion triggers until the connection is stable.

### Screenshot Placeholders

![Companion settings in Tally](screenshot:H06-companion-config)
![Companion status](screenshot:H06-companion-status)
![Button test example](screenshot:H06-named-test)
![Error example](screenshot:H06-error-example)

---

## H07: Control Multiple Power Outlets
<!-- category: Equipment Integrations -->
<!-- time: 12 min -->
<!-- difficulty: Beginner -->
<!-- summary: Turn AV equipment on and off from Tally using smart power outlets and Companion. -->

### Quick Start

1. Add your smart outlet module in Companion (e.g., TP-Link Kasa, Shelly)
2. Create buttons in Companion named like `Power: FOH Rack On` and `Power: FOH Rack Off`
3. Test each button directly in Companion first
4. Trigger the buttons from Tally

### Who This Is For

Teams that want to turn AV equipment on and off remotely without expensive rack power systems.

### What You Will Accomplish

- Set up outlet control through Companion
- Create clearly-named power buttons
- Turn equipment on, off, or restart from Tally

### Prerequisites

- [ ] Tally connected to the server
- [ ] Companion reachable from Tally
- [ ] Smart outlets plugged in and working (test manually first)
- [ ] Companion can reach the outlet devices over the network

### Step-by-Step Setup

**Step 1 — Add Outlet Module in Companion**

In Companion, add the module for your outlet brand (e.g., TP-Link Kasa, Shelly, Tasmota).

> **Note:** For budget setups, TP-Link Kasa smart power strips are the easiest starting point. For rack installations, look at Digital Loggers, APC, or CyberPower managed power units.

**Step 2 — Confirm Module Connection**

Check that the module shows as connected in Companion with the right devices listed.

**Step 3 — Create Named Buttons**

Create buttons using clear names like:

- `Power: FOH Rack On`
- `Power: FOH Rack Off`
- `Power: FOH Rack Cycle`

**Step 4 — Test in Companion First**

Press each button in Companion's web interface to make sure the outlet responds correctly.

**Step 5 — Trigger from Tally**

Send the commands from Tally by using the button names you created.

> **Safety:** Be careful not to accidentally restart your network switch or too many devices at once. Add delays between restart actions so equipment has time to boot up. Always have a way to manually flip power if something goes wrong.

### Validation Checklist

- [ ] Companion can reach your outlet devices
- [ ] On/off/restart buttons work as expected
- [ ] Equipment reboots properly when restarted
- [ ] Wrong button names show a helpful error

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Button not found | Name in Tally doesn't match Companion exactly | Check the exact button name (including capitalization) |
| Module connected but outlet won't switch | Wrong password or IP for the outlet | Check device login details in Companion's module settings |
| Unreliable switching | Wi-Fi connection is unstable | Move outlet devices to a wired network connection if possible |
| Equipment fails after restart | No delay between power off and power on | Add a 10-15 second delay between off and on actions |

### Rollback / Fallback

1. Turn off outlet automation in Tally.
2. Control outlets manually through Companion's web interface.
3. Add back one outlet action at a time.

### Screenshot Placeholders

![Companion outlet module](screenshot:H07-outlet-module)
![Power button naming](screenshot:H07-button-naming)
![Tally command mapping](screenshot:H07-tally-command)
![Validation results](screenshot:H07-validation)

---

## H08: ProPresenter Setup + Control
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- difficulty: Beginner -->
<!-- summary: Connect ProPresenter to Tally so you can control slides, timers, and stage messages. -->

### Quick Start

1. In Equipment settings, enter your ProPresenter computer's address and port
2. Click **Connect** and confirm ProPresenter shows as active
3. Test next/previous slide commands
4. Try changing a look, starting a timer, or sending a stage message

### Who This Is For

Churches using ProPresenter for worship slides, stage displays, and countdown timers.

### What You Will Accomplish

- Connect Tally to ProPresenter
- Control slide navigation from Tally
- Use advanced features like looks (visual presets), timers, and stage messages (text sent to the stage screen)

### Prerequisites

- [ ] ProPresenter computer's IP address and port number
- [ ] API access turned on in ProPresenter's settings
- [ ] Tally computer can reach the ProPresenter computer over the network

### Step-by-Step Setup

**Step 1 — Configure ProPresenter Connection**

In Equipment settings, enter the ProPresenter host address and port.

**Step 2 — Connect and Verify**

Connect and confirm the status shows as active.

**Step 3 — Test Slide Navigation**

Try these basic navigation commands:

1. Next slide / Previous slide
2. Go to a specific slide number
3. Clear the current slide / Clear all

**Step 4 — Test Advanced Controls**

Try these advanced features:

1. **Looks** — switch between visual presets (different screen layouts)
2. **Timers** — start or stop a countdown timer
3. **Stage messages** — send a text message to the stage display, then clear it

**Step 5 — Check Status Updates**

Confirm that the current slide name and ProPresenter version appear in the Tally status panel.

### Validation Checklist

- [ ] ProPresenter shows as connected and active
- [ ] Slide navigation works
- [ ] Looks, timers, and stage messages work
- [ ] Current slide info updates in the status panel

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Can't connect | Wrong address/port or API not enabled | Check ProPresenter's network settings and make sure API access is turned on |
| Command works but nothing changes visually | Wrong playlist or presentation is active | Check which playlist is loaded in ProPresenter |
| Stage message doesn't appear | Stage display not set up | Check stage display settings in ProPresenter's preferences |
| Timer commands do nothing | Wrong timer ID | List all timers first to get the correct IDs, then use those |

### Rollback / Fallback

1. Put Tally in monitoring-only mode for ProPresenter.
2. Control slides directly from ProPresenter until the connection is stable.

### Screenshot Placeholders

![ProPresenter connection settings](screenshot:H08-pro-config)
![Command test panel](screenshot:H08-command-test)
![Looks and timers controls](screenshot:H08-looks-timers)
![Stage message result](screenshot:H08-stage-message)

---

## H09: Encoder Setup (OBS/vMix/Hardware/NDI)
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- difficulty: Intermediate -->
<!-- summary: Connect your streaming software or hardware to Tally to monitor and control streaming/recording. -->

### Quick Start

1. In Equipment settings, select your encoder type (OBS, vMix, TriCaster, hardware, or NDI)
2. Enter the address, port, and password (if needed)
3. Click **Save** and connect
4. Confirm the status shows your stream/recording state

### Who This Is For

Teams streaming through OBS, vMix, TriCaster, hardware encoders, or NDI.

### What You Will Accomplish

- Connect your streaming software or hardware to Tally
- See live streaming and recording status
- Control start/stop for supported encoders

### Prerequisites

- [ ] Encoder type selected (OBS, vMix, TriCaster, hardware, NDI)
- [ ] Address and login details ready
- [ ] Tally computer can reach the encoder over the network

### Step-by-Step Setup

**Step 1 — Choose Your Encoder**

In Equipment settings, select your encoder type from the dropdown.

**Step 2 — Enter Connection Details**

Enter the details for your encoder:

- **OBS**: address, port, password
- **vMix**: address, port
- **TriCaster**: address, port, login details if needed
- **Hardware encoder**: address and login details (varies by brand)
- **NDI monitor**: the NDI source name

**Step 3 — Save and Connect**

Save your settings and start the connection.

**Step 4 — Check Status**

Verify the encoder status shows as connected with live information updating.

**Step 5 — Test Controls**

Test the available controls (not all encoders support all actions):

1. Start/stop stream
2. Start/stop recording
3. Verify the status updates correctly

> **Note:** Hardware encoders and NDI monitors are usually read-only — Tally can see their status but can't control them. That's normal.

### Advanced Details

**NDI setup** requires the NDI runtime software to be installed on the Tally computer. You may also need `ffprobe` (a video analysis tool) for some NDI features.

**Hardware encoders** that only push a stream (RTMP-only devices) cannot be controlled remotely — Tally monitors their output but can't start/stop them.

**TriCaster** API support varies by model and firmware version. Check your TriCaster's documentation for available remote control features.

### Validation Checklist

- [ ] Encoder shows as connected
- [ ] Streaming and recording status updates in real-time
- [ ] Unsupported actions show a clear "not supported" message
- [ ] OBS/vMix status details appear when available

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| NDI monitor shows no data | NDI software not installed | Install the NDI runtime on the Tally computer |
| TriCaster only partially works | Not all features available on your model | Check your TriCaster firmware version and documentation |
| Hardware encoder is read-only | That's expected for stream-only devices | Use the encoder's own controls; Tally will monitor the status |
| Wrong encoder selected | Setup wizard chose a different type | Change the selection in Equipment settings |

### Rollback / Fallback

1. Set the encoder to monitoring-only mode.
2. Control streaming from your encoder's own interface until the connection is stable.

### Screenshot Placeholders

![Encoder type selector](screenshot:H09-encoder-selector)
![Connection settings](screenshot:H09-config-blocks)
![Status panel](screenshot:H09-status-panel)
![Unsupported action message](screenshot:H09-unsupported-error)

---

## H10: Audio Console Setup (X32/A&H/Yamaha)
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- difficulty: Advanced -->
<!-- summary: Connect your audio mixing console to Tally for monitoring and basic remote control. -->

### Quick Start

1. In Equipment settings, select your console brand (Behringer/Midas, Allen & Heath, or Yamaha)
2. Enter the console's IP address
3. Click **Connect** and confirm it shows as online
4. Test muting and unmuting a channel

### Who This Is For

Teams connecting their audio mixing console to Tally for monitoring and control.

### What You Will Accomplish

- Connect your audio console to Tally
- Run basic control commands (mute, volume)
- Understand what's available for your specific console

### Prerequisites

- [ ] Console brand and model known
- [ ] Console's IP address
- [ ] Console and Tally computer on the same network

### Step-by-Step Setup

**Step 1 — Select Console Type**

In Equipment settings, choose your console brand from the dropdown.

**Step 2 — Enter Connection Details**

Enter the console's IP address. The port number is filled in automatically for your brand.

**Step 3 — Connect and Verify**

Connect and confirm the console shows as online in the status panel.

**Step 4 — Test Basic Controls**

Try the available commands:

1. Mute/unmute a channel
2. Adjust a channel's volume level
3. Check the main output mute status
4. Load a saved mix setup (if supported by your console)

**Step 5 — Check What's Available**

Look at the capability notes in the app to see which features are fully supported, partially supported, or not available for your console.

> **Note:** Behringer/Midas consoles (X32/M32) have the most complete support. Allen & Heath and Yamaha consoles have fewer remote control features available. Loading saved mixes remotely isn't possible on most consoles — use the console's built-in controls for that.

### Advanced Details

The connection details for each console brand:

- **Behringer/Midas X32/M32**: UDP port `10023`
- **Allen & Heath SQ/dLive**: UDP port `51326`
- **Yamaha CL/QL**: UDP port `8765`

Each brand uses a different communication protocol with different capabilities. "Scene recall" (loading a saved mixer setup) is only available on some Behringer/Midas consoles. Allen & Heath and Yamaha consoles have more limited remote control due to protocol restrictions.

State updates (like seeing volume changes) may take 1-2 seconds to sync — this is normal network behavior, not an error.

### Validation Checklist

- [ ] Console shows as connected
- [ ] Main mute status updates correctly
- [ ] Supported commands work as expected
- [ ] Unsupported commands show a clear explanation

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Some features missing | Not all consoles support all features remotely | Check the capability list; some functions are console-only |
| Can't connect | Wrong port number | Use the default port for your console brand (see Advanced Details) |
| Slow status updates | Normal network delay | Allow 1-2 seconds for changes to show up |
| Can't load saved mixes | Not supported remotely on your console | Use the console's physical controls for that |

### Rollback / Fallback

1. Put the console in monitoring-only mode.
2. Use the console's physical controls for features Tally can't handle remotely.

### Screenshot Placeholders

![Console settings](screenshot:H10-console-config)
![Connected status with model](screenshot:H10-connected-model)
![Command results](screenshot:H10-command-results)
![Main mute warning](screenshot:H10-mute-warning)

---

## H11: PTZ Camera Setup
<!-- category: Equipment Integrations -->
<!-- time: 10 min -->
<!-- difficulty: Advanced -->
<!-- summary: Connect PTZ cameras to Tally so you can move them and recall saved positions. -->

### Quick Start

1. In the PTZ section, add each camera with a name and IP address
2. Set the connection method to **Auto** (recommended)
3. Click **Connect** and test moving each camera
4. Save a camera position as a preset and recall it

### Who This Is For

Teams using PTZ (pan-tilt-zoom) cameras that they want to control from Tally.

### What You Will Accomplish

- Connect PTZ cameras
- Control pan, tilt, zoom, and home position
- Save and recall camera positions (presets)

### Prerequisites

- [ ] Camera IP addresses
- [ ] Camera login credentials (if required)
- [ ] Cameras and Tally computer on the same network

### Step-by-Step Setup

**Step 1 — Add Cameras**

In the PTZ equipment section, add each camera with:

1. A friendly name (e.g., "Stage Left", "Wide Shot")
2. IP address
3. Connection method — choose **Auto** to let Tally detect the best method
4. Login credentials (if your camera requires them)

**Step 2 — Connect All Cameras**

Click **Connect** for each camera and wait for the status to update.

**Step 3 — Test Movement**

Test basic movement for each camera:

1. Pan left and right
2. Tilt up and down
3. Zoom in and out
4. Stop
5. Return to home position

**Step 4 — Test Presets**

Test saving and recalling camera positions:

1. Move the camera to the position you want
2. Save it as a preset (e.g., Preset 1)
3. Move the camera somewhere else
4. Recall the preset and confirm it returns to the right spot

### Advanced Details

Tally supports several camera connection methods (protocols):

- **Auto** — recommended; Tally tries to detect the best method
- **ONVIF** — an industry-standard camera protocol; may require username and password
- **VISCA (UDP or TCP)** — a common PTZ control protocol
- **PTZOptics (UDP or TCP)** — specific to PTZOptics brand cameras

If Auto doesn't work reliably, you can force a specific method. Check your camera's documentation to see which protocols it supports.

Common protocol issues:
- ONVIF may require credentials even if the camera doesn't prompt for them
- Some cameras report conflicting capabilities that confuse auto-detection — forcing a specific method usually fixes this

### Validation Checklist

- [ ] All cameras show as connected
- [ ] Movement commands work smoothly
- [ ] Home command returns the camera to its default position
- [ ] Preset save and recall works correctly

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Auto-detect picks wrong method | Camera sends conflicting information | Choose a specific connection method instead of Auto |
| Camera won't connect | Wrong address or login credentials | Double-check the IP address and credentials |
| All cameras offline | Network issue | Make sure cameras and Tally are on the same network |
| Presets don't save | Camera doesn't support remote preset saving | Check your camera's documentation |

### Rollback / Fallback

1. Turn off PTZ control in Tally.
2. Use your camera's own controller or joystick for manual control.

### Screenshot Placeholders

![PTZ camera list](screenshot:H11-ptz-list)
![Camera connection status](screenshot:H11-camera-status)
![Movement controls](screenshot:H11-movement-controls)
![Preset save/recall](screenshot:H11-preset-confirm)

---

## H12: Alerts, Tally Engineer, and Auto-Recovery
<!-- category: Troubleshooting -->
<!-- time: 10 min -->
<!-- difficulty: Intermediate -->
<!-- summary: Set up alerts so Tally can warn you about problems and try to fix them automatically. -->

### Quick Start

1. Go to alert settings and turn on notifications (e.g., Telegram)
2. Confirm the Tally Engineer panel is visible and showing data
3. Simulate a problem (like disconnecting the ATEM) and check that you receive an alert
4. Confirm the app tries to reconnect automatically

### Who This Is For

Teams that want Tally to detect problems and alert them during services.

### What You Will Accomplish

- Set up alert notifications
- Understand the Tally Engineer diagnostics system
- Test alerts and auto-recovery

### Prerequisites

- [ ] Main equipment connected (ATEM, encoder, etc.)
- [ ] Notification channel set up (e.g., a Telegram bot — your admin will provide the bot details and chat ID)
- [ ] Support features enabled in the portal

### Step-by-Step Setup

**Step 1 — Open Alert Settings**

Go to the alert settings in your church portal or app settings.

**Step 2 — Turn On Notification Channels**

Set up which channels should receive alerts (e.g., Telegram). Your admin will provide the bot details and chat ID.

**Step 3 — Confirm Tally Engineer is Working**

Check that the Tally Engineer diagnostics panel is visible and showing system data.

**Step 4 — Test with a Simulated Problem**

In a non-production environment, create a controlled problem:

1. Disconnect the ATEM (unplug or change its IP)
2. Stop the stream in your encoder
3. Mute the main audio output (restore it immediately after)

> **Safety:** Only do this during testing — not during a live service! Restore all connections right away.

**Step 5 — Confirm the Alert System Works**

For each test problem, check:

1. You received a notification in the right channel
2. System information was captured
3. Tally attempted to reconnect or fix the problem automatically

### Validation Checklist

- [ ] Alerts arrive for real problems
- [ ] Repeated alerts are suppressed (you don't get flooded with the same message)
- [ ] Auto-recovery attempts show in the timeline
- [ ] You can escalate manually if auto-recovery doesn't work

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Getting too many repeat alerts | Alert suppression window is too short | Increase the cooldown time in alert settings |
| No alerts at all | Notifications turned off or wrong channel settings | Check that notifications are on and channel details are correct |
| Auto-recovery not working | Tally doesn't have control access to the device | Make sure Tally has full control access, not just monitoring |
| Diagnostics look incomplete | Not enough status data being collected | Make sure all equipment is connected and reporting |

### Rollback / Fallback

1. Keep monitoring active but turn off automatic recovery actions.
2. Switch to manual confirmation for all recovery actions.

### Screenshot Placeholders

![Alert settings](screenshot:H12-alert-settings)
![Alert timeline](screenshot:H12-alert-timeline)
![Auto-recovery record](screenshot:H12-recovery-record)
![Triage summary](screenshot:H12-triage-summary)

---

## H13: Service Schedule + Automation Rules
<!-- category: Automation and Companion -->
<!-- time: 12 min -->
<!-- difficulty: Intermediate -->
<!-- summary: Create service time windows and automation rules so Tally can run actions on schedule. -->

### Quick Start

1. Open the Schedule tab and create a service window (e.g., Sunday 8:00 AM - 12:30 PM)
2. Add an automation rule — pick a trigger (time, event, or manual) and an action
3. Run a dry test to verify timing
4. Enable the rule for the next service

### Who This Is For

Teams with repeatable weekend workflows that want to automate routine actions.

### What You Will Accomplish

- Create service time windows by day and time
- Build automation rules with triggers and actions
- Test rules safely before using them in a live service

### Prerequisites

- [ ] Church timezone set correctly in settings
- [ ] Main equipment connected
- [ ] Automation feature available on your billing plan

### Step-by-Step Setup

**Step 1 — Open the Schedule Tab**

Go to the schedule/automation section in the portal.

**Step 2 — Create Service Windows**

Set up your service times by day and time (e.g., Sunday 8:00 AM - 12:30 PM).

**Step 3 — Add Automation Rules**

Create rules by choosing a trigger:

1. **Timer** — runs at a specific time during the service window
2. **Event trigger** — runs when something happens (like a device disconnecting)
3. **Manual trigger** — runs when you press a button

**Step 4 — Add Actions**

Add one or more actions to each rule. Set the order and add delays between actions.

> **Important:** Always add delays between restart actions and device commands. Equipment needs time to boot up before it can accept new instructions.

**Step 5 — Run a Dry Test**

Save the rule and run a test for one service window to make sure the timing and actions are correct.

### Validation Checklist

- [ ] Service windows trigger at the right local time
- [ ] Rules run once per event (no accidental repeats)
- [ ] No actions running in a loop
- [ ] Action log shows each action and whether it succeeded

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| Actions run at the wrong time | Timezone mismatch | Check that your church timezone in settings matches your actual timezone |
| Rule never fires | Trigger condition never happens | Make sure the triggering event actually occurs during the service window |
| Rule fires over and over | No safety limit set | Add a "once per window" or cooldown limit to the rule |
| Actions happen too fast | No delays between steps | Add 5-15 second delays between actions so equipment can keep up |

### Rollback / Fallback

1. Pause all automation rules.
2. Run things manually for the next service.
3. Re-enable rules one at a time after testing each one.

### Screenshot Placeholders

![Service window editor](screenshot:H13-service-editor)
![Rule builder](screenshot:H13-rule-builder)
![Dry test result](screenshot:H13-dry-run)
![Action log](screenshot:H13-command-log)

---

## H14: Support Workflow (Triage + Ticket)
<!-- category: Troubleshooting -->
<!-- time: 8 min -->
<!-- difficulty: Beginner -->
<!-- summary: Report a problem, get an AI-assisted diagnosis, and create a support ticket. -->

### Quick Start

1. Go to the Help section in the portal
2. Select your issue type and run the AI triage
3. Review the diagnosis and recommendations
4. Click **Create Ticket** to submit a support request

### Who This Is For

Church admins and operators who need to report and track technical issues.

### What You Will Accomplish

- Run an AI-assisted diagnosis for an issue
- Create a support ticket from the results
- Post updates and manage ticket status

### Prerequisites

- [ ] Signed in as a church admin or support user
- [ ] Tally app connected and reporting status
- [ ] Support features enabled on the server

### Step-by-Step Setup

**Step 1 — Open Help/Support**

Go to the Help or Support section in the church portal.

**Step 2 — Run Triage**

Select the type of issue and run the AI-assisted triage. The system will gather information and analyze the problem.

**Step 3 — Review the Diagnosis**

Review what the system found:

- What type of issue it is
- How serious it is
- What to do next

**Step 4 — Create Ticket**

Click **Create Ticket** to submit a support request based on the diagnosis.

**Step 5 — Add Updates**

Post update messages to the ticket as the issue progresses.

**Step 6 — Change Ticket Status**

Update the status as needed (e.g., In Progress, Resolved).

### Validation Checklist

- [ ] Triage runs successfully and saves results
- [ ] Ticket is created with the correct details
- [ ] Updates appear in order
- [ ] Only authorized users can see and edit tickets

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| "Unauthorized" error | Wrong login or user role | Sign in again with the correct admin account |
| Can't find a ticket | Looking in the wrong view | Switch between the church portal and admin dashboard views |
| Missing information in diagnosis | Tally app not fully connected | Make sure the Tally app is running and connected to all equipment |
| Can't update some fields | Some fields are admin-only | Contact your admin to update those fields |

### Rollback / Fallback

1. For urgent issues, use your manual support channel (email, phone).
2. Log the details and create the ticket later once the system is working.

### Screenshot Placeholders

![Triage form](screenshot:H14-triage-form)
![Triage result](screenshot:H14-triage-result)
![Ticket detail view](screenshot:H14-ticket-detail)
![Ticket update timeline](screenshot:H14-ticket-timeline)

---

## H15: Ops — Backups, Status Page, Logs, Updates
<!-- category: Operations -->
<!-- time: 12 min -->
<!-- difficulty: Advanced -->
<!-- summary: Set up backups, monitor system health, review logs, and safely deploy updates. -->

### Quick Start

1. Open the admin panel and go to Backup Settings
2. Confirm backups are running and check that backup files are being created
3. Open the Status Page and verify all systems show as operational
4. Before any update, always create a backup first

### Who This Is For

Platform administrators responsible for keeping Tally running and up to date.

### What You Will Accomplish

- Confirm automated backups are working
- Monitor platform health on the status page
- Review and export logs
- Safely deploy updates

### Prerequisites

- [ ] Admin access to the server
- [ ] Backup settings configured (your deployment admin will set this up)
- [ ] Access to the status page

### Step-by-Step Setup

**Step 1 — Check Backup Settings**

Open the admin panel and confirm backup settings are active. Backups should run automatically (typically every 15 minutes).

**Step 2 — Verify Backups Are Being Created**

Check that backup files are appearing on schedule. You should see timestamped backup files in the storage location.

**Step 3 — Check the Status Page**

Open the status page and verify that all components show their expected status (operational, degraded, or outage).

**Step 4 — Review Logs**

Review recent logs from both the app and server when investigating issues or preparing for an update.

**Step 5 — Deploy Updates Safely**

When it's time to update, follow this process:

1. Tell users about the maintenance window
2. Create a backup before starting
3. Deploy the update
4. Run basic tests to confirm everything works
5. Check the status page — all components should be operational

> **Important:** Always create a backup before deploying any update. Run tests before and after every deployment.

### Advanced Details

For administrators who manage the server directly, here are the technical details:

**Backup environment variables:**
```bash
DB_BACKUP_INTERVAL_MINUTES=15
BACKUP_DIR=/data/backups
BACKUP_ENCRYPTION_KEY=your-encryption-key
BACKUP_RETAIN_COUNT=96
```

**Checking backups from the command line:**
```bash
ls -la /data/backups/
```

You should see timestamped `.sqlite.gz` or `.sqlite.gz.enc` files.

If `DB_BACKUP_INTERVAL_MINUTES` is not set, backups default to every 15 minutes. A warning will appear at startup if no backup schedule is configured.

### Validation Checklist

- [ ] Backup files are being created on schedule
- [ ] Status page updates correctly
- [ ] Past incidents are recorded
- [ ] Log exports contain enough detail for troubleshooting

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| No backups being created | Backup interval not configured | Ask your deployment admin to set the backup interval |
| Status page shows false alarm | Health check targets not configured correctly | Verify the check URLs; some expected errors shouldn't count as outages |
| Log files are too large | Too much detail being logged | Ask your admin to adjust logging levels |
| Update causes problems | No testing before/after deployment | Always run tests before and after every update |

### Rollback / Fallback

1. Restore the most recent backup.
2. Go back to the previous version of the software.
3. Re-run health checks after rolling back.

### Screenshot Placeholders

![Backup settings](screenshot:H15-backup-config)
![Status page](screenshot:H15-status-dashboard)
![Incident history](screenshot:H15-incident-history)
![Log export](screenshot:H15-log-export)

---

## H16: Network Setup for Church AV
<!-- category: Getting Started -->
<!-- time: 15 min -->
<!-- difficulty: Intermediate -->
<!-- summary: Configure your church network so Tally, your ATEM, cameras, and streaming gear all communicate reliably. -->

### Quick Start

1. Put all AV gear on the same subnet (e.g. 192.168.1.x) using a dedicated switch
2. Assign static IPs to every piece of AV equipment — never rely on DHCP for production gear
3. Connect the Tally computer to the same switch and confirm it can reach each device
4. Verify connectivity from Tally's Equipment Setup screen — every device should show a green dot

### Who This Is For

Church tech directors and volunteers setting up or troubleshooting the network that connects an ATEM switcher, cameras, streaming encoder, and Tally.

### What You Will Accomplish

- Understand why AV gear needs its own network segment
- Assign static IPs to your ATEM, PTZ cameras, encoder, and other devices
- Wire everything through a dedicated AV switch
- Verify end-to-end connectivity from the Tally computer
- Avoid the most common network mistakes that cause dropped connections

### Prerequisites

- [ ] A managed or unmanaged gigabit network switch (8-port minimum, 16-port recommended)
- [ ] Ethernet cables for every piece of AV gear
- [ ] Access to each device's network settings (ATEM Software Control, camera web UI, etc.)
- [ ] Tally installed and signed in (see H01 and H02)

### Step-by-Step Setup

**Step 1 — Plan Your IP Scheme**

Pick a subnet for all AV equipment. A common choice:

| Device | IP Address |
|--------|------------|
| ATEM Switcher | 192.168.1.10 |
| PTZ Camera 1 | 192.168.1.21 |
| PTZ Camera 2 | 192.168.1.22 |
| PTZ Camera 3 | 192.168.1.23 |
| OBS / Encoder PC | 192.168.1.30 |
| Audio Console (X32, etc.) | 192.168.1.40 |
| Companion | 192.168.1.50 |
| HyperDeck | 192.168.1.60 |
| Tally Computer | 192.168.1.100 |

> **Tip:** Write these on a label and stick it to the inside of your rack or tech booth desk. You will need them again.

Use subnet mask **255.255.255.0** and gateway **192.168.1.1** everywhere. If your church internet router is on 192.168.1.1, this lets AV gear reach the internet for relay connections. If the router uses a different range, adjust your AV subnet to match or add a route.

**Step 2 — Set Static IPs on Every Device**

Never rely on DHCP for production AV gear. A DHCP lease change mid-service will drop your ATEM or camera connection instantly.

- **ATEM** — Open ATEM Software Control → Switcher Settings → Network. Set a static IP, subnet mask, and gateway. Click Apply and wait for the switcher to restart its network.
- **PTZ Cameras** — Open each camera's web interface (usually at the camera's current IP). Go to Network settings and assign the planned static IP.
- **OBS / Encoder** — Set a static IP on the computer's Ethernet adapter in your OS network settings.
- **Audio Console** — Access the console's Setup/Network screen and assign a static IP.
- **Tally Computer** — Set a static IP on the Ethernet adapter. On Mac: System Settings → Network → Ethernet → Details → TCP/IP → Configure IPv4: Manually.

**Step 3 — Wire Through a Dedicated Switch**

Connect every piece of AV gear and the Tally computer to the same physical switch. This keeps AV traffic off the church Wi-Fi and general office network.

```
[Internet Router]
       |
[AV Switch] ─── ATEM Switcher
       |─────── PTZ Camera 1
       |─────── PTZ Camera 2
       |─────── PTZ Camera 3
       |─────── Encoder / OBS PC
       |─────── Audio Console
       |─────── Tally Computer
       |─────── HyperDeck
       |─────── Companion
```

> **Important:** Use Cat6 cables for runs longer than 10 feet. Use Cat5e only for short patch cables. Never use Wi-Fi for ATEM, cameras, or Tally — it is not reliable enough for live production.

**Step 4 — Verify Connectivity from the Tally Computer**

Open a terminal on the Tally computer and ping each device:

```bash
ping 192.168.1.10    # ATEM
ping 192.168.1.21    # Camera 1
ping 192.168.1.40    # Audio Console
```

Every device should respond in under 5 ms on a local switch. If any device does not respond:

1. Check that the cable is seated — try a different port on the switch
2. Confirm the static IP was saved on the device (some devices need a reboot)
3. Make sure the Tally computer and the device are on the same subnet

**Step 5 — Confirm in Tally**

Open Tally and go to the Equipment Setup screen. Every connected device should show a green status dot. If a device shows red:

- Double-check the IP address entered in Tally matches the static IP you assigned
- Confirm the device is powered on and the Ethernet link light is active on the switch
- Try unplugging and re-plugging the Ethernet cable

**Step 6 — Verify Relay Connectivity**

Tally connects to the cloud relay over the internet. Make sure the Tally computer (or the switch uplink) has a path to the internet.

- The relay connection uses standard HTTPS (port 443) — no special firewall rules needed
- If your church uses a firewall or content filter, make sure `api.tallyconnect.app` is allowed
- Check the Tally app — the relay status should show "Connected" with a green dot

### Advanced Details

**VLANs (for managed switches):**

If your church has a managed switch or enterprise network, create a dedicated VLAN for AV equipment. This isolates AV traffic from office computers and guest Wi-Fi while still allowing internet access for the relay connection.

Typical VLAN setup:
- VLAN 10 — AV Production (ATEM, cameras, Tally, encoder)
- VLAN 20 — Church Office (staff computers, printers)
- VLAN 30 — Guest Wi-Fi

Configure the router to route between VLANs only if cross-VLAN access is needed (it usually isn't).

**Multicast and IGMP:**

ATEM discovery and some NDI workflows use multicast. If you're on a managed switch, enable **IGMP snooping** to prevent multicast traffic from flooding all ports. Most unmanaged switches handle this fine without configuration.

**PoE (Power over Ethernet):**

PTZ cameras and some devices support PoE. If your switch provides PoE, you can power cameras directly from the switch — no separate power adapter needed. Check your camera specs for PoE requirements (most PTZ cameras need PoE+ / 802.3at, 30W).

**Bandwidth planning:**

| Traffic Type | Bandwidth (per stream) |
|-------------|----------------------|
| ATEM control | < 1 Mbps |
| PTZ control (VISCA/TCP) | < 1 Mbps |
| Tally status updates | < 1 Mbps |
| NDI video stream | 100–150 Mbps |
| Relay (internet) | < 1 Mbps |

A standard gigabit switch handles all of this comfortably. The only high-bandwidth item is NDI — if you use NDI, make sure your switch is gigabit and avoid daisy-chaining consumer switches.

### Validation Checklist

- [ ] Every AV device has a static IP (not DHCP)
- [ ] All devices respond to ping from the Tally computer in under 5 ms
- [ ] Tally Equipment Setup shows green dots for all connected devices
- [ ] Relay status shows "Connected"
- [ ] IP assignments are documented (label, spreadsheet, or config file)
- [ ] No AV gear is relying on Wi-Fi

### Common Issues and Fixes

| Symptom | Cause | Fix |
|---------|-------|-----|
| ATEM drops out randomly | DHCP lease expired or IP conflict | Assign a static IP to the ATEM; check no other device uses the same address |
| Camera unreachable after power cycle | Camera reverted to DHCP or a different IP | Re-assign the static IP in the camera's web interface |
| Tally shows "Relay Disconnected" | No internet on the AV network | Confirm the switch uplink reaches a router with internet; allow `api.tallyconnect.app` on any firewall |
| High latency on pings (>5 ms) | Traffic congestion or bad cable | Use a dedicated AV switch; replace suspect cables; check for broadcast storms |
| Device works alone but fails when everything is on | IP address conflict — two devices share an IP | Audit every device IP; use the planned IP table to confirm no overlaps |
| NDI video stutters | Not enough bandwidth or consumer switch | Use a gigabit managed switch; avoid daisy-chaining cheap switches |

### Rollback / Fallback

1. If a device becomes unreachable after changing its IP, connect a laptop directly to the device with a crosshair cable and reset its network settings.
2. Most ATEM switchers can be factory-reset via the physical control panel (hold RESET on boot) which restores DHCP mode.
3. PTZ cameras typically have a hardware reset button (pinhole on the back) that restores default network settings.

### Screenshot Placeholders

![IP address planning table](screenshot:H16-ip-plan)
![ATEM network settings](screenshot:H16-atem-network)
![Switch wiring diagram](screenshot:H16-switch-diagram)
![Tally equipment status](screenshot:H16-tally-status)
![Ping test results](screenshot:H16-ping-test)
