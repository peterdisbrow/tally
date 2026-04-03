# ATEM Switcher Setup Guide

**Tally Connect · tallyconnect.app**

This guide covers everything you need to connect your Blackmagic ATEM switcher to Tally Connect and verify it's working correctly.

---

## Network Requirements

### Same subnet — mandatory

The computer running Tally and your ATEM switcher **must be on the same local subnet**. Tally communicates with the ATEM over the local network using Blackmagic's control protocol; it cannot cross a router or VLAN boundary.

**Correct:** Tally computer at `192.168.1.50`, ATEM at `192.168.1.240` → same `/24` subnet ✅
**Wrong:** Tally computer at `192.168.1.50`, ATEM at `192.168.10.240` → different subnets ❌

### Static IP — strongly recommended

By default, ATEMs use a fixed IP set during factory configuration. If your church network has a DHCP server, the ATEM will typically keep its assigned address, but it's safer to set a static IP so the address never changes between Sunday services.

**To set a static IP on the ATEM:**
1. Open **ATEM Setup** utility on any Mac or Windows computer on the same network
2. Click on your ATEM in the device list
3. Under **Network**, disable DHCP and enter:
   - IP Address (e.g., `192.168.1.240`)
   - Subnet Mask (`255.255.255.0` for most churches)
   - Gateway (your router's IP, typically `192.168.1.1`)
4. Click **Change**

### Firewall and switches

- ATEM uses **UDP and TCP** on several ports; no specific port needs to be opened in most church setups because the traffic stays on the local network
- If you have a managed switch with port isolation or VLAN separation between production and office networks, make sure the Tally computer and the ATEM are on the same VLAN

---

## Finding Your ATEM's IP Address

### Method 1 — ATEM Software Control (easiest)

1. Open **ATEM Software Control** on any computer on the same network
2. Your ATEM appears in the switcher list with its IP address displayed
3. Copy that address

### Method 2 — ATEM Setup utility

1. Open **ATEM Setup**
2. The utility auto-discovers ATEMs on your network and shows each one's current IP

### Method 3 — ATEM Mini front panel

On ATEM Mini and Mini Pro models:
- Hold the **Cut** button on the front panel for 3 seconds
- The current IP address is displayed on the multiview output

### Method 4 — Auto-Discover in Tally

1. In the Tally Setup Wizard or Equipment tab, click **Auto-Discover on Network**
2. Tally scans your local subnet and lists any ATEMs it finds
3. Click **Use This** next to your switcher

### Common factory defaults

| ATEM model | Default IP |
|-----------|-----------|
| ATEM Mini, Mini Pro, Mini Extreme | `192.168.10.240` |
| ATEM Television Studio HD/4K | `192.168.0.1` |
| ATEM 1 M/E, 2 M/E, Constellation | `192.168.10.240` |

> **Note:** If your church network uses a `192.168.1.x` range, the ATEM's factory IP (`192.168.10.240`) will be on a different subnet. You'll need to change either the ATEM's IP (using ATEM Setup from a computer temporarily on `192.168.10.x`) or connect the ATEM to your regular network and use ATEM Setup to reassign it.

---

## Configuring the Connection in Tally

### Setup Wizard (first run)

1. The Setup Wizard prompts for an **ATEM IP Address** during initial configuration
2. Enter the IP address you found above
3. Click **Next** — Tally tests the connection before proceeding

### Equipment tab (after setup)

1. Open the Tally app and go to the **Equipment** tab
2. Find **ATEM Switcher** in the device list
3. Enter or update the IP address
4. Click **Test** — a green indicator confirms connectivity

---

## Testing Tally/Preview/Program Status

Once connected, Tally receives live tally data from the ATEM — the same data that drives tally lights on camera operators' monitors.

**To verify tally is working:**

1. In the Tally app's **Status** tab, confirm the ATEM shows as **Connected** (🟢)
2. On the ATEM, cut to a different camera — the Tally status display updates in real time to show which inputs are on Program and Preview
3. Send the following command to your Telegram bot to get a live status readout:

```
status
```

The response includes:
- Which ATEM input is on Program
- Which input is on Preview
- Whether recording is active (if your ATEM has built-in recording)
- Any DSK (downstream keyer) state

---

## Multi-ATEM Setups

Tally supports multiple ATEM switchers — useful for churches with separate sanctuary and overflow rooms, or a main switcher plus a streaming switcher.

**To add a second ATEM:**

1. Go to the **Equipment** tab
2. Click **+ Add ATEM**
3. Enter the IP address for the second ATEM and give it a name (e.g., `Overflow Room`)
4. Click **Test**

Each ATEM is independently monitored. Alerts and status messages include the ATEM name so you know which room is affected.

**Telegram commands with multiple ATEMs:**

When you have more than one ATEM, commands default to the primary (first) ATEM. To target a specific one, reference it by name:

```
cut to camera 2        → cuts on the primary ATEM
```

> For more granular multi-ATEM control, configure Bitfocus Companion as a middleman — Tally can drive Companion, which routes commands to the correct ATEM.

---

## ATEM Commands via Telegram

Once connected, your TD can control the ATEM directly from Telegram:

| Command | Action |
|---------|--------|
| `cut to camera 2` | Cut to input 2 on Program |
| `camera 3 to preview` | Set input 3 on Preview |
| `auto transition` or `take` | Fire the auto transition |
| `fade to black` or `ftb` | Fade to black |
| `start recording` | Start ATEM built-in recording |
| `stop recording` | Stop ATEM built-in recording |
| `rename camera 4 to "Fog GFX"` | Set input 4's long name |
| `run macro 3` | Run ATEM macro index 3 |
| `stop macro` | Abort current macro |
| `set aux 1 to camera 4` | Route input 4 to Aux 1 output |
| `dsk 1 on` | Put DSK 1 on air |
| `dsk 1 off` | Take DSK 1 off air |
| `set transition style mix` | Change transition style (mix/dip/wipe/dve) |
| `set transition rate 30` | Set transition rate in frames |

> **Safety:** Commands that could interrupt a live service (stop recording, fade to black) require an inline confirmation before executing.

---

## Troubleshooting

### Connection drops intermittently

**Symptom:** ATEM status flips between 🟢 and 🟡 every few minutes.

1. Check the ethernet cable between the ATEM and your network switch — try a new cable
2. Check the switch port — look for link lights; a flapping link causes connection drops
3. If the ATEM is on WiFi (unusual but possible on Mini models with a USB adapter), switch to wired ethernet
4. Make sure the Tally computer isn't going to sleep — go to System Settings (Mac) or Power Options (Windows) and set the display sleep to "Never" on the booth computer

### Firewall blocking the connection

**Symptom:** ATEM is on the network (ATEM Software Control connects), but Tally can't connect.

1. Temporarily disable any third-party firewall on the Tally computer and test again
2. Add an exception for the Tally app in your firewall settings
3. On Windows, check Windows Defender Firewall → allow Tally through for Private networks
4. On Mac, check System Settings → Network → Firewall → Options, and ensure Tally is set to "Allow incoming connections"

### "ATEM Connected" in Software Control but not in Tally

1. Confirm both the ATEM Software Control computer and the Tally computer show the same ATEM IP — there may be two ATEMs on the network
2. Check that the IP entered in the Tally Equipment tab exactly matches the ATEM's address (no trailing spaces)
3. Some ATEM models have a maximum concurrent connection limit; if ATEM Software Control, a third-party tally system, and Tally are all connected simultaneously, you may hit this limit — disconnect other control applications temporarily to test

### ATEM defaults to `192.168.10.240` but my network is `192.168.1.x`

You have two options:

**Option A (preferred): Change the ATEM's IP**
- Connect a laptop directly to the ATEM with an ethernet cable
- Set the laptop's IP to `192.168.10.100` (same subnet as the ATEM)
- Open ATEM Setup — the ATEM appears in the list
- Change the ATEM's IP to an address on your church network (e.g., `192.168.1.240`)
- Reconnect the ATEM to your regular network switch

**Option B: Connect the ATEM to both networks**
Not recommended for production environments.

### "Cannot reach ATEM" after power cycle

The ATEM can take 30–60 seconds to become network-accessible after booting. If Tally shows the ATEM as disconnected right after a restart, wait a minute and check again — it will reconnect automatically.

---

## Getting Help

- **Email:** support@tallyconnect.app
- **Documentation:** tallyconnect.app/docs
- **Telegram quick fix:** Send `/fix atem` to @TallyConnectBot for an inline troubleshooting guide
