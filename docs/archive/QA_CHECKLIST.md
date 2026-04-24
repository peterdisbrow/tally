# TallyConnect QA Checklist

Use this checklist before declaring any work "done." Walk through every applicable section. If a section doesn't apply to the change, mark it N/A and move on.

---

## 1. Per-Surface Walkthrough

### Portal (relay-server/public/portal/)

**Login**
- [ ] Login page loads, fields accept input, error states display correctly
- [ ] Forgot password flow works end-to-end

**Overview (Dashboard)**
- [ ] Readiness status card — correct color/icon for current state
- [ ] Equipment status table — all devices listed with correct status dots
- [ ] Smart plugs card (if configured)
- [ ] Stream protection card — status, CDN health, last event
- [ ] Live stream health card — bitrate, FPS, audio, color-coded
- [ ] Broadcast health card — YouTube/Facebook platform status
- [ ] ATEM detail card — model, firmware, inputs, outputs
- [ ] ProPresenter detail card — current slide, timers
- [ ] VideoHub detail card — routing status
- [ ] Audio health card — mute, silence detection, levels
- [ ] Activity feed — recent events render correctly
- [ ] AI assistant coaching card
- [ ] Service schedule card — next service time

**Rooms & Equipment (3 tabs)**
- [ ] Rooms tab — room list, create room, assign desktop
- [ ] Equipment tab — all device config cards (ATEM, OBS, mixer, encoder, PTZ, Companion, ProPresenter, HyperDeck, VideoHub, stream keys, equipment roles)
- [ ] Schedule tab — service windows display and edit

**Team (2 tabs)**
- [ ] Tech Directors tab — table with name, role, access, email, portal login toggle, delete
- [ ] Copy invite link button works
- [ ] Guest Access tab — generate token, table with token/label/status/expiry/revoke

**Alerts**
- [ ] Alert history list — severity badges, timestamps, messages
- [ ] Stream auto-recovery configuration — enable toggle, action type, thresholds
- [ ] Failover drill simulator

**AI Assistant (Tally Engineer)**
- [ ] Training status badge
- [ ] Setup profile form — platform, viewers, experience, backup devices, notes
- [ ] AI memory display (readonly)
- [ ] Weekly engineer notes card
- [ ] Chat interface — send/receive messages, empty state suggestion pills

**Automation (2 tabs)**
- [ ] Macros tab — list, create modal (name, description, steps), edit/delete
- [ ] AutoPilot tab — upgrade gate for lower tiers, pause/resume, create rule modal, test rule modal, rules list with toggles

**Analytics**
- [ ] Room selector filters data correctly
- [ ] Sessions table — date, duration, peak viewers, status
- [ ] KPI cards — sessions, peak viewers, uptime, issues
- [ ] Stream health graph
- [ ] Viewer trends chart
- [ ] Audience by platform breakdown

**Reports (5 tabs)**
- [ ] Summary tab — date range selector, KPIs, room breakdown, uptime bars
- [ ] Events tab — search/filter, event list
- [ ] Windows tab — service schedule visualization
- [ ] Health tab — device health, incident breakdown
- [ ] AI tab — AI activity log, disabled state if AI off

**Diagnostics (AI Triage)**
- [ ] Error banner (dismissible)
- [ ] Time context banner (pre-service, service, post-service)
- [ ] KPI stat cards — events, critical, resolution rate, AI mode
- [ ] AI mode selector (Full Auto / Recommend Only / Monitor Only)
- [ ] Sensitivity slider
- [ ] Pre-service window selector
- [ ] Severity distribution chart
- [ ] Service window visualization
- [ ] Daily trend chart
- [ ] Severity filter + recent events table
- [ ] Load More pagination

**Streaming Connections**
- [ ] YouTube card — status badge, channel name, stream key status, expiry, connect/disconnect
- [ ] Facebook card — status badge, page name, page selector, connect/disconnect

**Billing & Subscription**
- [ ] Active plan display with KPIs
- [ ] Quick info table (Church ID, registered date, plan, room limit)
- [ ] Referral program — copy link, email/SMS share, progress, history

**Help & Support**
- [ ] SLA response time display
- [ ] Desktop app download links
- [ ] Companion integration guide
- [ ] Guided diagnostics form — category, severity, summary
- [ ] Run Triage / Open Ticket / Refresh buttons
- [ ] Platform status components list
- [ ] Support tickets table
- [ ] Migration wizard

**Modals**
- [ ] Add TD modal — fields, validation, submit
- [ ] Add Macro modal — fields, submit
- [ ] Add AutoPilot Rule modal — fields, test, submit
- [ ] Rule limit modal — upgrade CTA
- [ ] Help modal — context-aware content
- [ ] Review modal — rating, feedback
- [ ] Cancel retention modal
- [ ] Generic confirm/prompt dialog

---

### Mobile App (tally-connect-mobile/)

**Login**
- [ ] Email/password fields, sign-in button, loading spinner
- [ ] Custom server URL option
- [ ] Error message display

**Room Picker**
- [ ] Room list with icons, loading/error/empty states
- [ ] Auto-skip if previous room still exists

**Equipment Tab (Home)**
- [ ] Summary header — online count, active room, stream status, viewers
- [ ] Device categories: Switching, Streaming, Recording, Presentation, Audio, Network & Control, System
- [ ] Device cards — name, status dot, metrics (model, status, bitrate, CPU/RAM/disk)
- [ ] Live badge with duration on streaming devices
- [ ] Color-coded metrics (green/yellow/red thresholds)
- [ ] Simple vs Advanced mode differences

**Alerts Tab**
- [ ] Severity filters (ALL, EMERGENCY, CRITICAL, WARNING, INFO)
- [ ] Search bar filters by message/room
- [ ] Alert badges with severity color, timestamp, room, message
- [ ] Acknowledge button + acknowledged badge
- [ ] Dismiss icon per alert
- [ ] Unread badge on tab icon
- [ ] Pull-to-refresh

**Commands Tab**
- [ ] Connection banner (connected/reconnecting)
- [ ] Queued commands warning (offline)
- [ ] Quick actions — Start/Stop Stream, CUT
- [ ] Camera switching — tally cards with program/preview, CUT/AUTO
- [ ] Stream protection — status, toggle, CDN health, manual restart
- [ ] Recording — Start/Stop Rec
- [ ] ProPresenter — current slide, prev/next
- [ ] Offline queuing behavior

**Checks Tab (Pre-Service)**
- [ ] Status ring — icon, status text, pass/warning/fail counts
- [ ] Confirmation badge
- [ ] AI summary section
- [ ] Run Check Now button + running state
- [ ] Results by category — Devices, Stream, Presentation, Audio, Network, Companion, Versions, General
- [ ] Category headers with pass counts
- [ ] Individual check items with status icons

**Engineer Tab (Chat)**
- [ ] Header with profile icon, title, subtitle, pulse dot
- [ ] User messages (right-aligned, green)
- [ ] Engineer messages (left-aligned)
- [ ] Timestamps, auto-scroll
- [ ] Input area — text input, send button
- [ ] Error banner with retry
- [ ] Empty state with suggestions

**More Tab**
- [ ] Church info card
- [ ] Theme selector (System/Light/Dark)
- [ ] Active session — grade, duration, incidents
- [ ] Recent services list with grades
- [ ] Push notification status + token
- [ ] App updates — version, check button, restart button
- [ ] Menu items: Switch Room, Equipment Config, Service Rundown, Analytics, Service Reports, Settings, Help & Support
- [ ] Sign out with confirmation

**Analytics Screen**
- [ ] Date range picker (7d/30d/90d)
- [ ] Stat cards: Services, Avg Grade, Health Score, Alerts, Incidents, Uptime, Stream Hours
- [ ] Trending icons

**Service Reports Screen**
- [ ] Date range filter (30d/90d/1yr/All)
- [ ] Sort controls (Date/Grade with direction)
- [ ] Service list: date, name, duration, incidents, grade

**Service Rundown Screen**
- [ ] Header card with service title and time
- [ ] Sections: Pre-Service, Service Rundown, Post-Service
- [ ] Items: type icon, title, subtitle, author, duration, key
- [ ] Team section with groups, members, status badges

**Equipment Config Screen**
- [ ] Room name header, online/total badge
- [ ] Device cards with config details, nested fields

**Settings Screen**
- [ ] Theme picker
- [ ] View mode (Simple/Advanced)
- [ ] Language (English/Spanish)
- [ ] Push notifications toggle, alert sounds toggle
- [ ] Server URL display + reset
- [ ] Version and build number

---

### Desktop/Electron App (electron-app/)

**Sign-In Page**
- [ ] Email/password form, loading state, error messages
- [ ] Link to create account

**Room Selector**
- [ ] Room list, create room form, loading/error states

**Onboarding Wizard**
- [ ] Chat-based setup, progress bar (Gear > Schedule > Team > Stream)
- [ ] Clickable stage indicators, skip link

**Dashboard — Status Tab**
- [ ] System check bar + Run System Check button
- [ ] Pre-service readiness widget (conditional)
- [ ] Session recap card (collapsed by default)
- [ ] Pre-service check hero panel with fix-all
- [ ] ATEM section — model, program, preview, recording, audio delay warning
- [ ] Companion section — status, endpoint, active connections
- [ ] Streaming encoder section — health, FPS, bitrate, audio, firmware, CDN verification
- [ ] Signal failover section — state badge, safe source, timeline
- [ ] Stream protection section — status, CDN, events, alert bar
- [ ] Device identity section (collapsed)
- [ ] ProPresenter section — presentation, slide, timers
- [ ] OBS section — status, scenes
- [ ] Resolume section — status, composition
- [ ] vMix section — status, inputs/outputs
- [ ] Mixer section — type, state
- [ ] Network health section — ISP, ping, jitter
- [ ] Troubleshooter section

**Dashboard — Equipment Tab**
- [ ] Simple/Advanced mode toggle
- [ ] Simple mode: device list, Scan Network, stream platforms, switch-to-advanced link
- [ ] Advanced mode: active devices summary chips
- [ ] Network scan bar — NIC selector, scan button, progress, results
- [ ] Device catalog: ATEM, Encoder, Companion, ProPresenter, vMix, Resolume, HyperDeck, PTZ, VideoHub, Audio Mixer, Smart Plugs, ATEM Recording
- [ ] Stream destinations: YouTube OAuth, Facebook OAuth, manual entry (API keys, RTMP)
- [ ] Signal failover config
- [ ] Sticky save bar + reset to factory defaults

**Dashboard — Tally Engineer Tab**
- [ ] Go/No-Go badge
- [ ] KPI cards — Critical, High, Coverage, Total Issues, Last Run
- [ ] Camera verification checkbox
- [ ] Quick action buttons — Check System, Pre-Service Check
- [ ] Active issues list with Mark Fixed
- [ ] Action plan section (collapsible)
- [ ] Recent runs section (collapsible)
- [ ] Chat area — conversation with AI
- [ ] Chat input — attachment button, text field, send

**Dashboard — Commands Tab**
- [ ] ATEM commands — Cut, Auto, FTB, Program/Preview input, Record, Stream, Transition, DSK
- [ ] OBS commands — Stream, Recording, Scene switch, Transition, Replay Buffer
- [ ] vMix commands — Cut, Fade, Program/Preview, Stream, Record
- [ ] ProPresenter commands — Slides, Announcements, Macro, Clear
- [ ] Companion commands — Page/Row/Col press, Named button
- [ ] Encoder commands — Stream, Recording
- [ ] Smart plug commands — On/Off/Toggle/Power Cycle
- [ ] Recovery commands — Restart stream/recording/device/encoder, Reset audio

**Bottom Action Bar**
- [ ] Start/Stop Monitoring toggle
- [ ] Test Connection button
- [ ] Export Logs button
- [ ] Setup button
- [ ] Sign Out button
- [ ] Autostart checkbox

**System Tray**
- [ ] Tray icon color matches connection state (grey/amber/green)
- [ ] Status line (connections + billing)
- [ ] Open Dashboard, Start/Stop Monitoring
- [ ] Links: Client Portal, Help, Website
- [ ] Check for Updates, version display
- [ ] Sign Out, Reset to Factory Defaults, Quit

**Modals & Overlays**
- [ ] Fix All progress modal
- [ ] Troubleshooter overlay (guided walkthroughs)
- [ ] Confirmation dialogs (Sign Out, Factory Reset)

---

## 2. Cross-Surface Consistency

Check that these match across Portal, Mobile, and Desktop:

- [ ] **Status labels** — device connection states use identical wording (Connected/Disconnected, not Online/Offline in one place and Connected/Disconnected in another)
- [ ] **Severity levels** — EMERGENCY, CRITICAL, WARNING, INFO used consistently (not "Error" or "Danger")
- [ ] **Equipment names** — same device type names everywhere (e.g., "Streaming Encoder" not "Encoder" in one place and "Streaming Encoder" in another)
- [ ] **Status colors** — Red (#FF5252) = critical, Orange/Amber (#FFB74D) = warning, Green (#00E676) = healthy, Gray = offline/loading
- [ ] **Bitrate terminology** — always "Bitrate", never "Upload Speed"
- [ ] **Grade labels** — A-F letter grades with consistent color coding
- [ ] **Room names** — displayed identically across all surfaces for same room
- [ ] **Stream status** — "LIVE" / "OFF AIR" / "RECORDING" wording matches
- [ ] **Time formats** — consistent date/time formatting (relative vs absolute)
- [ ] **Plan tier names** — Connect, Plus, Pro used consistently
- [ ] **AI mode names** — Full Auto, Recommend Only, Monitor Only
- [ ] **No emoji anywhere** — SVG icons only (no Unicode symbols or emoji characters)

---

## 3. Empty State Audit

For every page/component, verify appearance with zero data, partial data, and full data.

### Portal Empty States
- [ ] Overview — no devices connected, no stream active
- [ ] Rooms tab — no rooms created
- [ ] Equipment tab — no devices configured
- [ ] Schedule tab — no service windows
- [ ] Team > TDs — no tech directors
- [ ] Team > Guests — no guest tokens
- [ ] Alerts — no alert history
- [ ] AI Assistant — no training profile, empty chat
- [ ] Automation > Macros — no macros
- [ ] Automation > AutoPilot — no rules (also: upgrade gate for lower tiers)
- [ ] Analytics — no sessions
- [ ] Reports > all 5 tabs — no data for selected range
- [ ] Diagnostics — no events, onboarding state
- [ ] Connections — YouTube/Facebook not connected
- [ ] Billing — no referrals, no invoice history
- [ ] Support — no tickets, no diagnostic bundles

### Mobile Empty States
- [ ] Room Picker — no rooms (message to add in portal)
- [ ] Equipment — no devices detected
- [ ] Alerts — "No alerts" with icon
- [ ] Commands — no devices connected (no command sections)
- [ ] Checks — "No check data available"
- [ ] Engineer chat — empty state with suggestion pills
- [ ] Analytics — "No Analytics Data Yet"
- [ ] Service Reports — "No reports in last X days"
- [ ] Service Rundown — "Planning Center Not Connected" / "No Upcoming Service"
- [ ] Equipment Config — "No Equipment Detected"

### Desktop Empty States
- [ ] Room Selector — no rooms (create form)
- [ ] Status tab — no devices, no session recap
- [ ] Equipment tab — no devices, empty catalog
- [ ] Tally Engineer tab — no issues, feature gate when unavailable
- [ ] Commands tab — no connected devices

### Cross-Surface Empty States
- [ ] Empty states use consistent messaging tone
- [ ] All empty states have clear next-action guidance (not just "Nothing here")
- [ ] No raw "Loading..." text left visible after data loads
- [ ] No broken layouts when data arrays are empty

---

## 4. Room Scoping

Every room-aware feature must filter correctly when switching rooms.

- [ ] **Portal room dropdown** — single global selector, no per-page selectors
- [ ] **Equipment** — shows only devices for selected room
- [ ] **Pre-service checks** — results scoped to selected room
- [ ] **Alerts** — filtered by selected room
- [ ] **Diagnostics/Triage** — events scoped to room
- [ ] **Analytics/Sessions** — data filtered by room
- [ ] **Stream status** — shows stream for selected room only
- [ ] **Chat history** — scoped per room (mobile clears on room switch)
- [ ] **Service schedule** — correct schedule for selected room
- [ ] **Commands** — sent to correct room's devices
- [ ] **Mobile room switch** — data refreshes completely, no stale data from previous room
- [ ] **Desktop room switch** — status/equipment/commands update for new room

---

## 5. Simple/Advanced Mode

### Portal
- [ ] Toggle persists in localStorage (`tally_view_mode`)
- [ ] **Simple mode shows**: Equipment summary (readonly), basic stats, simplified room card
- [ ] **Simple mode hides**: Add Room button, full equipment forms, Equipment Roles card, advanced stats grid, upgrade banners, activity feed, AI coaching card
- [ ] **Advanced mode shows**: All of the above hidden items
- [ ] No advanced-only data visible in simple mode
- [ ] No broken layout when switching modes on any page

### Mobile
- [ ] Toggle in Settings > View Mode
- [ ] **Equipment tab — Simple**: core metrics only (status, bitrate, basic info)
- [ ] **Equipment tab — Advanced**: full metrics (CPU, RAM, dropped frames, detailed errors)
- [ ] **Checks tab**: verify both modes display correctly
- [ ] No data leak — advanced metrics don't flash before hiding in simple mode

### Desktop
- [ ] Equipment tab has Simple/Advanced toggle
- [ ] **Simple mode**: streamlined device list + Scan Network + stream platforms
- [ ] **Advanced mode**: full device catalog, network scan bar, all config options
- [ ] Toggle state persists across sessions

---

## 6. Data Pipeline Verification

For each key feature, trace data from source to display.

### Equipment Status
- [ ] Desktop client detects device → sends `status_update` via WebSocket → relay stores/broadcasts → portal/mobile receive and render

### Alerts
- [ ] Event triggers alert → relay creates alert record → WebSocket broadcast → portal/mobile display with correct severity → acknowledge flows back to API

### Stream Health
- [ ] Encoder reports bitrate/FPS/audio → relay broadcasts → all surfaces show matching values → CDN verification confirms platform status

### Pre-Service Checks
- [ ] Desktop runs checks → results sent to relay → API stores → portal/mobile fetch and display with correct pass/fail/warning

### Chat
- [ ] User sends message → API stores → AI processes → response stored → all surfaces receive via polling/WebSocket

### Analytics/Sessions
- [ ] Session events accumulate → relay computes grade/metrics → API serves to portal/mobile → charts/tables render correctly

### Stream Protection
- [ ] Protection status changes → relay broadcasts → desktop/portal/mobile all show matching state

### OAuth/Stream Keys
- [ ] OAuth flow completes → tokens stored → stream keys fetched → displayed in portal connections page and desktop equipment tab

---

## 7. Deploy Verification

### Railway Deploy (Relay Server + Portal)
- [ ] Portal loads at production URL
- [ ] Cache-busted assets load (check `?v=` or hash in CSS/JS URLs)
- [ ] No console errors on page load
- [ ] WebSocket connection establishes
- [ ] Login flow works end-to-end
- [ ] API health endpoint returns healthy (`/health`)
- [ ] Deep health check passes (`/health/deep`)

### Electron App Release
- [ ] Mac build is **signed** (`build:mac:signed` — NEVER ship unsigned)
- [ ] Auto-updater detects new version
- [ ] Update downloads and installs correctly
- [ ] No Gatekeeper warnings on fresh install

### Mobile OTA (Expo Updates)
- [ ] OTA update published successfully
- [ ] App detects update on next launch
- [ ] Update applies and app restarts
- [ ] Version number increments in Settings
- [ ] No white screen or crash after update

### Post-Deploy Smoke Test
- [ ] Desktop connects to relay
- [ ] Mobile connects to relay
- [ ] Portal shows connected devices
- [ ] Send a test command from each surface
- [ ] Verify alert delivery path works

---

## 8. Regression Checks

Known issues that have recurred. Check these explicitly.

### Phantom Devices
- [ ] Disconnected devices don't show as connected after page refresh
- [ ] Room switch doesn't leave behind status from previous room
- [ ] Devices removed from config don't persist in status displays

### Status Label Flicker
- [ ] Status dots don't flash between states on page load
- [ ] WebSocket reconnect doesn't cause status to briefly show disconnected
- [ ] Loading states transition cleanly to actual data

### Emoji Remnants
- [ ] No emoji or Unicode symbols anywhere in the UI (portal, mobile, desktop)
- [ ] Status indicators use SVG icons, not emoji
- [ ] Alert severity uses styled badges, not emoji

### Terminology Drift
- [ ] "Bitrate" not "Upload Speed" in all surfaces
- [ ] Standard AV terms used consistently (don't oversimplify)
- [ ] Simple mode labels still use correct technical terms

### Room Selector Duplication
- [ ] Portal has ONE global room dropdown — no per-page selectors
- [ ] Mobile uses room from initial picker, switchable from More tab only

### Mode Leakage
- [ ] Advanced-only content doesn't render momentarily in simple mode
- [ ] Switching modes doesn't break card layouts
- [ ] Mode preference survives page refresh and app restart

### Empty State Polish
- [ ] No raw "Loading..." text stuck after data arrives
- [ ] Empty tables don't show broken headers with zero rows
- [ ] Charts/graphs handle zero data gracefully (no NaN, no broken axes)
- [ ] Error states have retry actions, not just error text

### Auth & Token
- [ ] Expired JWT shows warning, not silent failure
- [ ] Guest tokens respect expiry — revoked tokens can't access data
- [ ] OAuth token refresh doesn't break stream key display

---

## How to Use This Checklist

1. **Before declaring any PR done**: walk through sections 1-5 for surfaces you touched
2. **Before any deploy**: walk through sections 6-8
3. **Mark N/A** for sections that don't apply to your change
4. **If you find an issue**: fix it before marking done, don't file it for later
5. **Copy this into the PR description** (relevant sections only) as proof of QA
