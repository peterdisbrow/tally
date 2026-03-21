# Tally Connect — Quick Start Guide

**Version 1.1 · tallyconnect.app**

Get up and running in about 15 minutes.

---

## Prerequisites

Before you start, make sure you have:

- **A Windows or Mac computer** in your production booth (the machine that runs OBS, ProPresenter, or sits next to your ATEM)
- **A Tally Connect account** — sign up at [tallyconnect.app](https://tallyconnect.app)
- **Your connection token** — sent by email after signup (it's a long JWT string starting with `eyJ…`)
- **Telegram installed** on your phone — free at telegram.org or the App Store / Play Store
- **Node.js 18 or later** — only needed if you're running the relay server yourself; the desktop app bundles everything it needs

---

## Step 1: Sign Up at the Landing Page

1. Go to **[tallyconnect.app](https://tallyconnect.app)**
2. Click **Get Started** and create your church account
3. Enter your church name, location, and service schedule
4. Check your email — you'll receive a **connection token** and a **6-character registration code**

> **Already have an account?** Log in at tallyconnect.app/portal to retrieve your token from the Settings tab.

---

## Step 2: Download and Install the Desktop App

1. From the landing page, click **Download for Mac** or **Download for Windows**
2. Run the installer:
   - **Mac:** Drag Tally to your Applications folder. On first launch, right-click → Open (macOS security prompt)
   - **Windows:** Run the `.exe` installer and click through the prompts
3. The Setup Wizard opens automatically on first launch

---

## Step 3: Connect Your First Device

The Setup Wizard walks you through each device type. You can also add or change devices later from the **Equipment** tab.

### ATEM Switcher

1. Enter your ATEM's IP address in the **ATEM IP Address** field
   - Not sure? Click **Auto-Discover on Network** — Tally scans your subnet and lists any ATEMs it finds
   - Common defaults: `192.168.1.10`, `192.168.10.240` (ATEM Mini), `192.168.0.1` (Television Studio)
2. Click **Test** — you should see a green confirmation
3. See [atem-setup.md](./atem-setup.md) for detailed ATEM configuration

### OBS Studio

1. In OBS: **Tools → WebSocket Server Settings → Enable WebSocket server**
2. Default port is `4455` — leave it unless you changed it
3. In Tally, the default URL is `ws://localhost:4455` — update the host if OBS is on a different computer
4. Click **Test**

### ProPresenter

1. In ProPresenter: **Preferences → Network → Enable Network**
2. Note the port (default: `1025`)
3. In Tally, enter `localhost` (or the ProPresenter computer's IP) and the port

### PTZ Cameras

1. Click **+ Add Camera**
2. Enter the camera's IP address and a name (e.g., `Camera 1 — Stage Left`)
3. Repeat for each PTZ camera

---

## Step 4: Set Up Telegram Alerts

Tally sends real-time alerts to your Technical Director's phone via Telegram.

1. Open Telegram and search for **@TallyConnectBot**
2. Tap **Start**
3. Send `/register YOUR_CODE` — use the 6-character code from your welcome email
4. You're registered. Alerts will now arrive as Telegram messages.

For a deep-link shortcut: in the Tally portal, go to **Team → Copy Invite Link** and share it with your TD — they just tap the link and registration happens automatically.

See [telegram-setup.md](./telegram-setup.md) for full Telegram configuration.

---

## Step 5: Run Your First Pre-Service Check

Tally runs a pre-service check automatically **30 minutes before** each scheduled service. You can also trigger it manually at any time.

**Via Telegram:**

```
pre-service check
```

**Via the portal:**
Go to the **Status** tab and click **Run Pre-Service Check**.

The check tests:
- ATEM connectivity and program/preview state
- OBS connection and scene status
- Stream key and platform readiness
- Recording drive space
- Camera power and signal
- ProPresenter playlist loaded

Results arrive as a Telegram message with a pass/fail for each item. Fix any ❌ items before service starts.

---

## Step 6: Invite Your Team

Share the registration code so your AV volunteers can join on Telegram.

1. In the portal, go to **Team → Share Code**
2. Copy the invite message — it includes your church's registration code
3. Share it via your group chat, email, or any messaging app

Each team member sends `/register YOUR_CODE` to @TallyConnectBot and they're connected immediately.

---

## Tray Icon Status

The Tally app lives in your system tray (Mac menu bar / Windows taskbar) and runs continuously in the background.

| Icon color | Meaning |
|-----------|---------|
| 🟢 Green | Connected and healthy |
| 🟡 Yellow | Relay connected, ATEM not found |
| ⚫ Grey | Not connected (check your internet) |
| 🔴 Red | Connected but something is wrong |

Tally starts automatically when your computer boots — no action needed on Sunday morning.

---

## Troubleshooting — Common First-Run Issues

### "Cannot reach ATEM"
- Confirm the IP in the Equipment tab matches what ATEM Software Control shows
- Both the booth computer and the ATEM must be on the same subnet (e.g., both `192.168.1.x`)
- Ping the ATEM to verify network reachability: open Terminal (Mac) or Command Prompt (Windows) and run `ping 192.168.1.10`

### "Cannot reach OBS"
- Make sure OBS is open before testing
- In OBS: Tools → WebSocket Server Settings → confirm **Enable WebSocket server** is checked
- Check the port matches (default `4455`)

### Tray icon is grey on Sunday morning
1. Click the tray icon → **Start Monitoring**
2. If that doesn't work, check your internet connection
3. Still grey? Email support@atemschool.com or contact Andrew directly

### Token expired or invalid
- Your token was emailed when you signed up; retrieve a fresh one from the portal Settings tab
- Email support@atemschool.com if you can't access the portal

### Telegram bot not responding
- Send `/start` first, then `/register YOUR_CODE`
- Make sure you're messaging **@TallyConnectBot** (not a different bot)
- See [telegram-setup.md](./telegram-setup.md#troubleshooting) for more

---

## Getting Help

- **Email:** support@atemschool.com
- **Documentation:** tallyconnect.app/docs
- **Production emergencies:** Contact Andrew directly — your account includes a support number
