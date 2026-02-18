# Tally — Hardware Spec & Business Model

**For:** ATEM School Premium Plan  
**Author:** Andrew Disbrow  
**Status:** Planning

---

## The Value Prop

Churches pay staff and volunteers to run their production. When something goes wrong live, they troubleshoot blind — pulling cables, rebooting gear, calling Andrew. With Tally:

- Andrew sees the issue on his screen before the church notices
- He pushes a fix from Telegram in seconds
- The congregation never knows anything happened

That's worth real money to any church doing live production or streaming.

---

## Church-Side Hardware

### Option A: Church Already Has ATEM Mini Pro/ISO ← Most Common
**Extra hardware cost: $0**

The ATEM Mini Pro/ISO has H.264 streaming built in. Just configure a second RTMP destination pointing at Andrew's relay. Church is already paying for the upload — Andrew's monitoring stream adds 2-4 Mbps on top of their YouTube stream.

Steps:
1. Open ATEM Software Control → Output → Streaming
2. Set secondary destination to Andrew's RTMP server
3. Done. Andrew is now monitoring their program output.

### Option B: Church Has ATEM Mini (non-Pro) or Other Switcher
**Extra hardware cost: ~$495**

**Blackmagic Web Presenter HD** (~$495)
- HDMI or SDI input from any ATEM program out
- H.264 encoder built in
- Streams to any RTMP destination
- Runs standalone — plug and forget
- Powers via USB-C

Plug ATEM HDMI program → Web Presenter HDMI in → Web Presenter ethernet → router. Done.

### Option C: No Blackmagic at All (Cameras Direct, PTZ, etc.)
**Extra hardware cost: ~$495 + $150**

Web Presenter HD ($495) + small HDMI switch ($50-150) to grab a program mix. Or: Church installs the Tally client app and Andrew monitors via OBS/Companion only (no video feed, software-only tier).

---

## Andrew's Side — The Mission Control

### Tier 1: Software Only (0-10 clients)
**Cost: $0**

OBS Multiview mode receives all church RTMP streams simultaneously. Free, scales to 10+ churches on a standard internet connection. One screen with a 4-9 tile multiview of every active church.

Setup:
- SRS or Mediamtx media server (Railway, $5/month) receives all RTMP streams
- OBS on Andrew's Mac connects to each stream via RTMP/SRT
- OBS Studio multiview shows 4-9 churches at once
- Tally dashboard overlays status (ATEM, OBS, Companion)

### Tier 2: Hardware Multiview (5-20 active clients, premium feel)
**One-time cost: ~$1,500-3,000**

| Hardware | Price | Purpose |
|---|---|---|
| Blackmagic ATEM Streaming Bridge × 4 | ~$1,200 ($295 each) | RTMP → SDI for 4 churches |
| ATEM Mini Extreme ISO | ~$1,495 | 8-input multiviewer, Andrew's main monitor |
| 27" monitor | ~$300-500 | Mission control display |
| Small managed switch | ~$80 | Network for the bridges |
| **Total** | **~$3,075** | |

What Andrew sees: 4 live church feeds in a proper multiviewer, ATEM tally lights showing who's live, SDI quality. Feels like a real broadcast facility.

Scale up: Add Streaming Bridges as needed. 8 bridges → 8 churches on one ATEM Extreme multiview.

### Tier 3: Full Mission Control (20+ clients)
**One-time cost: ~$5,000-8,000**

- Mediamtx media server on a dedicated VPS (Hetzner, ~$15/month)
- Custom web dashboard (already built in Tally) shows all clients
- 2× ATEM Constellation 8K for true 4K multiview of 8+ churches simultaneously
- Dedicated monitoring workstation
- This is infrastructure for a professional monitoring business, not just a side feature

---

## Bandwidth Math

Per church streaming scenario:
| Stream | Bitrate | Direction |
|---|---|---|
| YouTube/Facebook (existing) | 6 Mbps | Upload (church) |
| Andrew's monitoring stream | 3-4 Mbps | Upload (church) |
| **Total church upload** | **~10 Mbps** | |
| Business fiber (typical church) | 25-100 Mbps up | Available |
| **Headroom** | **15-90 Mbps** | ✅ No problem |

Small churches on residential cable (20 Mbps up): May need to reduce monitoring stream to 1080p at 2 Mbps. Still works.

---

## The Tiered ATEM School Plan

### Tier 1 — ATEM School Standard (existing)
**$XX/month**
- Courses, tutorials, guides
- ATEM School community
- Member pricing on Blackmagic gear

### Tier 2 — Tally (new)
**$49/month per church**
- Tally app installed + configured
- Status monitoring via Telegram (ATEM, OBS, Companion)
- Remote command control (cut cameras, start recording, fire Companion buttons)
- Pre-service automated checklist (alerts 30 min before service)
- Screenshot preview (visual confirmation of what's on screen)
- No video feed, no active human monitoring

**Target customer:** Churches that want self-service remote control + monitoring. DIY-capable.

### Tier 3 — Tally Pro (new)
**$149/month per church**
- Everything in Connect tier
- Live video monitoring feed (church adds second RTMP destination)
- Andrew's team monitors during Sunday services (active eyes on)
- Real-time intervention — something breaks, Andrew fixes it remotely
- Post-service report (recording saved, stream uptime, issues encountered)
- Direct line to Andrew during service hours

**Target customer:** Churches doing broadcast-quality productions who want a "remote TD on call."

### Tier 4 — Managed (new)
**$299/month per church**
- Everything in Pro tier
- Hardware installation included (Andrew or certified installer configures the full system)
- Weekly remote system health check
- Priority response during services
- Annual system audit + recommendations
- Member pricing on all gear purchases

**Target customer:** Multi-campus churches, churches with paid staff, churches spending $1,000+/month on production already.

---

## Revenue Projections

| Tier | Churches | MRR |
|---|---|---|
| Connect ($49) | 20 | $980 |
| Pro ($149) | 10 | $1,490 |
| Managed ($299) | 5 | $1,495 |
| **Total** | **35** | **$3,965/month** |

At 100 churches across tiers: **~$8,000-12,000 MRR**

This is realistic for someone with Andrew's existing church relationships and ATEM School platform. The install base is already warm.

---

## Hardware Bundle Option

**"Tally Starter Kit" — $695**

What's included:
- Blackmagic Web Presenter HD (pre-configured for Andrew's relay)
- HDMI cable (6ft)
- USB-C power cable
- Setup guide card with QR code to ATEM School onboarding
- Tally app pre-configured with their token

Church receives a box, plugs HDMI from their ATEM/switcher into the Web Presenter, plugs ethernet, powers on. App auto-connects. Andrew is now monitoring.

**Economics:**
- Web Presenter HD wholesale: ~$380 (Blackmagic authorized reseller pricing Andrew already has)
- Bundle retail: $695
- Margin: ~$315/unit hardware + monthly monitoring subscription
- Most churches buy the bundle + Pro tier = $695 one-time + $149/month

---

## Go-to-Market

**Phase 1: Pilot (Next 30 days)**
- 5 existing ATEM School members (churches Andrew already knows)
- Free Connect tier for 60 days in exchange for feedback
- Identify friction points in install + onboarding

**Phase 2: Launch (Month 2)**
- Announce to ATEM School email list
- "Tally" as a premium plan option during checkout
- Hardware bundle listed on atemschool.com

**Phase 3: Scale (Month 3+)**
- Partner with church AV integrators (they install, Andrew monitors)
- White-label option for other AV consultants
- Case studies from pilot churches

---

## Competitive Moat

No one else is doing this specifically for churches with Blackmagic gear. The combination of:
1. Deep ATEM/Blackmagic expertise (15 years)
2. Existing church relationships
3. Purpose-built software (not generic remote desktop)
4. Hardware reseller relationships (wholesale pricing)
5. ATEM School platform (warm audience)

...creates a defensible position. A church that uses Tally, buys gear through Andrew, and trains on ATEM School is unlikely to leave.
