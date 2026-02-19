# Tally Encoder

A dedicated hardware device that captures HDMI or SDI video from the church's AV equipment and streams a low-bitrate (3 Mbps) H.264 monitoring feed to the Tally relay server. This gives the relay server a live video preview of the church's program output without requiring OBS.

---

## Hardware Tiers

### Standard — Raspberry Pi 4 + Elgato Cam Link 4K

| Component | Details |
|-----------|---------|
| **SBC** | Raspberry Pi 4 (2GB+ RAM) |
| **Capture** | Elgato Cam Link 4K (USB 3.0 HDMI capture) |
| **OS** | Raspberry Pi OS Lite (64-bit) |
| **Input** | HDMI from program output / confidence monitor out |
| **Audio** | Embedded in USB capture (ALSA `hw:0,0`) |

**Pros:** Low cost (~$80), widely available, simple USB setup  
**Cons:** USB bandwidth limits practical capture to 1080p30

### Pro — Intel NUC + Blackmagic UltraStudio Recorder 3G

| Component | Details |
|-----------|---------|
| **Computer** | Intel NUC (i3/i5 10th gen+, 8GB RAM) |
| **Capture** | Blackmagic UltraStudio Recorder 3G (Thunderbolt 3) |
| **OS** | Ubuntu 22.04 LTS |
| **Input** | HDMI **or** SDI (3G-SDI) |
| **Audio** | Embedded in DeckLink capture stream |

**Pros:** SDI support, broadcast-grade capture, rock solid  
**Cons:** Higher cost (~$500), requires Thunderbolt 3

---

## Software Architecture

```
Church AV Equipment
       │
       │ HDMI / SDI
       ▼
┌─────────────────────┐
│  Tally Encoder      │
│  ┌───────────────┐  │
│  │  encoder.sh   │  │  ← ffmpeg pipeline
│  │  (ffmpeg)     │  │
│  └───────┬───────┘  │
│          │ RTMP      │
│  ┌───────▼───────┐  │
│  │  api-server   │  │  ← Remote management (port 7070)
│  │  (Node.js)    │  │
│  └───────────────┘  │
└────────┬────────────┘
         │ rtmp://relay/live/{TOKEN}
         ▼
   Tally Relay Server
```

---

## Installation

### Quick Install (Raspberry Pi OS Lite or Ubuntu)

```bash
# Clone or copy the tally-encoder directory to the device
git clone https://github.com/your-org/church-av.git
cd church-av/tally-encoder

# Run the installer (requires root)
sudo bash setup.sh
```

The script will:
1. Install `ffmpeg`, `nodejs`, `npm`
2. Create a `tally` system user
3. Copy files to `/opt/tally-encoder/`
4. Install npm dependencies
5. Deploy systemd service units
6. Enable and start the API server

### Manual Setup

```bash
# Install dependencies
sudo apt-get update
sudo apt-get install -y ffmpeg nodejs npm

# Copy files
sudo mkdir -p /opt/tally-encoder
sudo cp encoder.sh api-server.js package.json /opt/tally-encoder/
sudo chmod +x /opt/tally-encoder/encoder.sh

# Install Node packages
cd /opt/tally-encoder && sudo npm install --omit=dev

# Config
sudo mkdir -p /etc/tally-encoder
sudo cp config.env.example /etc/tally-encoder/config.env
sudo nano /etc/tally-encoder/config.env   # edit your settings

# Systemd
sudo cp tally-encoder.service tally-api.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now tally-encoder tally-api
```

---

## Configuration

Edit `/etc/tally-encoder/config.env`:

```bash
# Your relay server's RTMP URL
RELAY_URL=rtmp://your-relay.railway.app/live

# Token from the relay dashboard (Settings > Churches > your church)
CHURCH_TOKEN=abc123xyz

# Encoding bitrate (3 Mbps is recommended for 1080p monitoring)
BITRATE=3000k

# v4l2 = USB capture (Cam Link), decklink = Blackmagic UltraStudio
INPUT_TYPE=v4l2
INPUT_DEVICE=/dev/video0

# ALSA audio device (v4l2 only — decklink uses embedded audio)
AUDIO_DEVICE=hw:0,0

# Local API server port and auth token
TALLY_API_PORT=7070
TALLY_API_TOKEN=your-random-api-secret
```

### Finding your v4l2 device

```bash
# List video devices
ls -la /dev/video*
v4l2-ctl --list-devices

# Test capture (open in VLC or similar)
ffplay -f v4l2 -i /dev/video0
```

### Finding your audio device

```bash
# List ALSA capture devices
arecord -l
# Use hw:<card>,<device> — e.g., hw:1,0
```

### DeckLink (UltraStudio) device name

```bash
# List available DeckLink devices
ffmpeg -hide_banner -f decklink -list_devices 1 -i dummy
```

---

## Service Management

```bash
# Status
sudo systemctl status tally-encoder
sudo systemctl status tally-api

# Logs (live tail)
sudo journalctl -fu tally-encoder
sudo tail -f /var/log/tally-encoder.log

# Restart
sudo systemctl restart tally-encoder

# Stop
sudo systemctl stop tally-encoder
```

---

## Remote Management API

The API server runs on port `7070` and requires a `Bearer` token.

### Check health (no auth)

```bash
curl http://encoder-ip:7070/health
```

### Get status

```bash
curl -H "Authorization: Bearer YOUR_TALLY_API_TOKEN" \
     http://encoder-ip:7070/status
```

Response:
```json
{
  "connected": true,
  "streamActive": true,
  "uptime": 3600,
  "bitrate": "3000k",
  "inputDevice": "/dev/video0",
  "inputType": "v4l2",
  "relayUrl": "rtmp://relay.example.com/live"
}
```

### Update config and restart

```bash
curl -X POST -H "Authorization: Bearer YOUR_TALLY_API_TOKEN" \
     -H "Content-Type: application/json" \
     -d '{"bitrate": "1500k"}' \
     http://encoder-ip:7070/config
```

### Restart encoder

```bash
curl -X POST -H "Authorization: Bearer YOUR_TALLY_API_TOKEN" \
     http://encoder-ip:7070/restart
```

---

## Troubleshooting

### Stream not appearing on relay

1. Check encoder logs: `sudo journalctl -fu tally-encoder`
2. Verify `RELAY_URL` and `CHURCH_TOKEN` in config
3. Test RTMP manually: `ffmpeg -f lavfi -i testsrc=size=1280x720:rate=30 -f flv rtmp://your-relay/live/YOUR_TOKEN`
4. Check firewall — outbound TCP port 1935 must be open

### Black screen / no video

1. Check device is connected: `ls /dev/video*`
2. Verify capture works: `ffplay -f v4l2 -i /dev/video0`
3. For Cam Link: ensure input source is active (HDMI signal present)
4. For UltraStudio: check Blackmagic drivers: `ffmpeg -f decklink -list_devices 1 -i dummy`

### DeckLink not detected

```bash
# Install Blackmagic Desktop Video drivers
# Download from: https://www.blackmagicdesign.com/support/
sudo apt-get install dkms
sudo dpkg -i desktopvideo_*.deb
sudo reboot

# Verify
blackmagic-io-list
```

### High CPU on Raspberry Pi

Reduce resolution or use hardware encoding:
```bash
# In config.env, the encoder defaults to libx264 veryfast
# For RPi, you can try h264_v4l2m2m (hardware H.264):
# Edit encoder.sh and replace -c:v libx264 with -c:v h264_v4l2m2m
```

---

## Security Notes

- The API server binds to `0.0.0.0` by default — use a firewall to restrict access
- Set a strong `TALLY_API_TOKEN` (32+ random characters)
- The config file contains the `CHURCH_TOKEN` — ensure it's readable only by the `tally` user (`chmod 640`)
- Consider putting the API behind a VPN (e.g., Tailscale) for additional security
