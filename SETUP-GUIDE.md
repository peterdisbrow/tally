# Tally by ATEM School — Church Setup Guide

**Version 1.0 · tally.atemschool.com**

---

## What You're Setting Up

Tally connects your production booth to ATEM School's remote monitoring system. Once it's running:

- Your TD gets a phone alert the moment something goes wrong during service
- Andrew can see your system status and control it remotely if needed
- Problems get caught before the congregation notices

Setup takes about 15 minutes. You'll need your connection token (sent by email when you signed up).

---

## Before You Start

**What you need:**
- A Windows or Mac computer in your production booth (the one that runs OBS, ProPresenter, or sits near your ATEM)
- Your Tally connection token (from your welcome email)
- Your ATEM switcher's IP address (see step 3 if you don't know it)
- Your local network's WiFi password if the booth computer is on WiFi

**Optional but recommended:**
- OBS Studio installed and running
- Bitfocus Companion installed (if you use it)

---

## Step 1: Download and Install Tally

1. Go to **tally.atemschool.com** and click **Download for Mac** or **Download for Windows**
2. Run the installer
3. On Mac: drag Tally to your Applications folder, then right-click → Open (first launch only)
4. On Windows: run the `.exe` installer, click through the prompts

When it opens, you'll see the Setup Wizard. Keep going.

---

## Step 2: Enter Your Connection Token

Your token was emailed to you when you signed up. It looks like this:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...
```

1. Paste it into the **Connection Token** field
2. Click **Next**

> **Don't have a token?** Visit tally.atemschool.com or email support@atemschool.com

---

## Step 3: Connect Your ATEM Switcher

Your ATEM switcher needs an IP address on your local network. There are two ways to find it:

**Option A — ATEM Setup Utility (easiest)**
1. Open ATEM Setup on any computer on the same network
2. Your switcher will appear in the list with its IP address
3. Copy that IP into the **ATEM IP Address** field

**Option B — Auto-Discover**
1. Click **Auto-Discover on Network**
2. Tally will scan your local network and list any ATEM switchers it finds
3. Click **Use This** next to yours

**Common default IPs:**
- ATEM Mini / Mini Pro: `192.168.1.10` or `192.168.10.240`
- ATEM Television Studio: `192.168.0.1`
- If you set it up yourself, it's whatever you assigned

---

## Step 4: Optional Devices

You can skip this step and come back to it later from the Equipment tab.

**OBS Studio** — if you use OBS for streaming or recording:
- Enable WebSocket server: Tools → WebSocket Server Settings → Enable
- If you set a password, enter it here
- Default URL is `ws://localhost:4455` — don't change it unless OBS is on a different computer

**Bitfocus Companion** — if you use Companion:
- Default URL is `http://localhost:8888`
- If Companion is on a different computer, replace `localhost` with that computer's IP

**System Name** — give this installation a name like "Main Sanctuary" or "Chapel". This shows up in alerts so you know which church is having an issue.

---

## Step 5: Finish and Test

1. Click **Finish & Connect**
2. Tally will test the connection to the relay server
3. If it says **🟢 Connected**, you're done

The app minimizes to your system tray (Mac: menu bar, Windows: taskbar). It starts automatically when your computer boots.

---

## Verifying It Works

After setup, check the status bar at the top of the Tally app:

| Dot | Meaning |
|-----|---------|
| 🟢 Green | Connected and healthy |
| 🟡 Yellow | Relay connected, ATEM not found |
| ⚫ Grey | Not connected (check your network) |
| 🔴 Red | Connected but something is wrong |

Andrew's dashboard will show your church as online within 60 seconds of Tally connecting.

---

## Equipment Configuration (Advanced)

After setup, click the **Equipment** tab to configure additional devices.

### ATEM Switcher
Enter the IP address. Click **Test** to verify connectivity.

### Bitfocus Companion
Tally uses Companion to control 600+ devices — Stream Decks, routers, audio consoles, and more. Enter your Companion URL and click **Test**.

### OBS Studio
Enter the WebSocket URL. If OBS is on the same computer, use `ws://localhost:4455`.

### HyperDecks
Click **+ Add HyperDeck** for each recorder. Enter its IP address. Repeat for multiple units.

### PTZ Cameras
Click **+ Add Camera** for each PTZ camera. Enter its IP address and a name (e.g., "Camera 1 — Stage Left").

### ProPresenter
Enter the host (usually `localhost` if it's on the same computer) and port (default: `1025`).

### Resolume Arena
For churches running LED walls or video projection through Resolume:
1. In Resolume, go to **Preferences → Web Server** and enable the web server
2. Note the port (default: `8080`)
3. Enter `localhost` (or the Resolume computer's IP) and the port in Tally
4. Click **Test** — you should see the Resolume version number

### Dante Audio
Dante routing is handled through Companion. Create Companion buttons named `Dante: [Scene Name]` and Tally will use them. No additional configuration needed here unless you have a dedicated NMOS registry.

### Scan Network
Click **🔍 Scan Network** to automatically find all compatible devices on your local network. The scan takes 10–15 seconds and covers your full subnet. Click **Use This** next to any device to apply it.

---

## Telegram Alerts

To receive alerts on your phone, you need a Telegram account.

1. Search for **@ATEMSchoolTallyBot** on Telegram
2. Send `/start`
3. Send `/register [your 6-character code]` — Andrew will provide this code when your account is active
4. You're set. Alerts will arrive as Telegram messages.

**What you'll receive:**
- 🟡 Warning: something needs attention (e.g., low FPS, audio dropout detected)
- 🔴 Critical: service-impacting issue (stream stopped, ATEM disconnected)
- ✅ Recovery: issue was auto-fixed or resolved

If you don't respond to a Critical alert within 90 seconds, it escalates to Andrew automatically.

---

## TD Quick Reference — Telegram Commands

Once registered, your TD can type these commands to Tally:

```
status                  — full system health check
pre-service check       — run all checks before service starts
cut                     — cut to preview on ATEM
camera 1                — switch program to input 1
next slide              — advance ProPresenter
previous slide          — go back one slide
start stream            — start OBS stream
stop stream             — stop OBS stream
preview                 — get a screenshot of what's on screen
what's on screen        — same as preview
resolume status         — see what's playing on video wall
resolume trigger column "Worship" — trigger a scene
resolume clear          — blackout the video wall
```

---

## Keeping Tally Running

Tally is designed to run continuously in the background. A few things to know:

**Auto-start:** Tally starts automatically when Windows or Mac boots. No action needed on Sunday morning — it's already running.

**Tray icon colors:**
- 🟢 Green = all good
- 🟡 Yellow = relay connected, waiting for ATEM
- ⚫ Grey = not connected
- 🔴 Red = active issue

**If the icon is grey on Sunday morning:**
1. Click the tray icon → **Start Agent**
2. If that doesn't work, check your internet connection
3. If still grey, text or call Andrew

**If you get an unexpected alert:**
- Read it — most include the fix
- Reply with what you tried
- If it's auto-fixed, you'll get a ✅ follow-up message

---

## Troubleshooting

### "Cannot reach ATEM"
- Check the ATEM IP in the Equipment tab matches what ATEM Setup shows
- Make sure the booth computer and ATEM are on the same network
- Try pinging the IP: open Terminal (Mac) or Command Prompt (Windows) and type `ping 192.168.1.10`

### "Cannot reach OBS"
- Make sure OBS is running
- In OBS: Tools → WebSocket Server Settings → confirm it's enabled
- If you changed the port, update it in the Equipment tab

### "Relay disconnected"
- Check your internet connection
- The tray icon turns grey — click it and choose **Start Agent**

### "Stream stopped" alert during service
- This is the most common real alert
- In OBS: click **Start Streaming** again
- If OBS crashed: relaunch it, then start streaming
- Text Andrew if you can't recover in 2 minutes

### Token expired or invalid
- Contact support@atemschool.com for a new token
- Your settings are preserved — just paste the new token in the Settings tab

---

## Updating Tally

Tally updates automatically in the background. When an update is ready, you'll see a notification: **"Restart to install update."** Quit and relaunch the app at a convenient time (not during service).

---

## Getting Help

- **Email:** support@atemschool.com
- **Phone (production emergencies):** Contact Andrew directly — your account includes a support number
- **Documentation:** tally.atemschool.com/docs

---

## For Andrew's Reference — Church Onboarding Checklist

When activating a new church:

- [ ] Create church record in relay: `POST /api/churches/register`
- [ ] Generate JWT token, send in welcome email
- [ ] Confirm Tally app installed and tray icon green
- [ ] Register TD in Telegram bot, send 6-char code
- [ ] Set church service schedule (for watchdog windows)
- [ ] Test pre-service check via Telegram: `@ATEMSchoolTallyBot status`
- [ ] Confirm alerts route correctly (TD → Andrew 90s escalation)
- [ ] Note TD contact info in relay database

---

*Tally by ATEM School · tally.atemschool.com · Built for people who care about Sunday morning.*
