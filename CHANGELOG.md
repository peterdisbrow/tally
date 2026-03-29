# Changelog

All notable changes to Tally are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/) and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased]

## [1.1.37] - 2026-03-29

### Added
- Portal room selector wired to filter overview dashboard by instance.
- Room selector added to Equipment tab in portal.
- Room-based filtering replaces instance-based filtering on overview page.
- Room description field restored in portal UI.
- Per-instance status storage replaces shallow-merge status.

### Changed
- Portal sidebar consolidated from 18 to 11 nav items (tabbed sub-navigation).
- Schedule/Preferences moved under consolidated sidebar items; Analytics tabs reordered.
- Rooms-first refactor: removed campus-mode endpoints and all campus references across codebase.
- Pricing, tier names, and room limits aligned across codebase.
- Volunteer mode UI toggle removed from portal.

### Fixed
- Encoder metrics (CPU, congestion, details) now display in portal equipment card.
- vMix and VideoHub card rendering added; HyperDeck naming corrected.
- Room ID gap on reconnect eliminated by sending room_id at connect time.
- Exponential backoff with jitter added to relay reconnection.
- Cascade cleanup of related data when a room is deleted.
- CSP-safe event delegation for room edit/delete buttons.
- npm audit vulnerabilities resolved across all packages.
- i18n translations added for consolidated nav items.
- Stale page references fixed after sidebar consolidation.

## [1.1.36] - 2026-03-29

### Added
- Equipment configuration page in portal with forms for ATEM, OBS, mixer, encoder, PTZ, Companion, ProPresenter/vMix/Resolume, HyperDecks, and VideoHubs.
- Timezone dropdown on Profile page, church type toggle (recurring/event) with conditional event fields.
- Ingest stream key display with copy and regenerate on Equipment tab.
- AI memory summary display on Engineer page.
- Recovery-outside-service-hours toggle on Alerts Preferences.
- Config sync between portal Equipment settings and desktop app.

## [1.1.35] - 2026-03-28

### Added
- Windows exe published to GitHub Release for electron-updater auto-update.

### Fixed
- Mark Fixed button now transitions issues to GO state instead of just clearing them.
- Checkbox styling fixed across status page.
- vMix configuration debug output corrected.

## [1.1.34] - 2026-03-28

### Added
- CDN stream verification: after encoder starts streaming, relay checks YouTube liveBroadcasts and Facebook live_videos APIs to confirm platforms are receiving the stream. Fires critical alert if not.
- Windows installer build via GitHub Actions.
- Audio level monitoring broadened to vMix and any encoder (not just Blackmagic), with level tracking.

### Fixed
- Illegal `break` statement in relay websocketRouter.js.
- Allen & Heath SQ mixer connection reset prevented on initial state query.
- Smart parser `stop stream` now defaults to encoder when device status is unavailable.
- `--publish never` added to Windows build workflow to prevent accidental publishing.
- Version string comparison strips non-numeric prefix (e.g., `v1.1.34` → `1.1.34`).
- Missing tables added to church delete cascade in admin.

## [1.1.33] - 2026-03-28

### Fixed
- HyperDeck false positives eliminated: scanner now validates with protocol banner (port 9993 shared by ATEM and HyperDeck).
- ProPresenter scan falls back to `/v1/status/slide` if `/v1/version` fails.
- Encoder status now reads streaming/fps/bitrate from `status.encoder` object (relay SSE nests them there, not top-level).
- Identity log spam eliminated: streaming duration stripped from encoder identity before dedup cache check.
- Problem Finder false positives fixed for encoder and Companion (object check vs boolean).
- AI confirmation prompts removed that conflicted with stream guard.

### Changed
- "Blackmagic" renamed to "Streaming Encoder" in display labels.
- Stream Destinations purpose clarified in equipment tab labels.
- Import/Export Config buttons removed (config is server-side now).

## [1.1.32] - 2026-03-28

### Added
- RTMP stream analytics: bitrate, resolution, FPS, and codec parsed from FFmpeg output and exposed via API.
- Direct HLS serving with short-lived HMAC signed tokens, bypassing Vercel proxy (removes 4.5MB body limit, lower latency).
- `getStreamInfo` endpoint with `startedAt` for stream uptime tracking.

### Fixed
- RTMP public URL uses `RTMP_PUBLIC_URL` for Railway TCP proxy.
- Node-Media-Server event handlers updated for v4.x API.
- Smoother HLS playback with larger segment buffer (3s) and atomic file writes.
- FFmpeg progress output enabled for real-time stream analytics.
- Recording buttons removed from status page (kept only in equipment tab).
- Encoder shows "Standby/Idle" when connected but not streaming.
- Simple device list corrected: proper field names, all device types.
- Pre-service readiness widget hidden when unavailable instead of showing dimmed.

## [1.1.31] - 2026-03-28

### Added
- Full ATEM recording controls in equipment and status tabs (start/stop recording, disk status).

### Fixed
- Network scanner finds Companion and ProPresenter on real local IP, not just 127.0.0.1.

## [1.1.30] - 2026-03-28

### Added
- Device-specific AI rules so Tally Engineer executes commands directly instead of suggesting them.

### Fixed
- Grey status dots shown during startup instead of misleading red.
- Problem Finder auto-run delayed until initial device status arrives.
- ATEM status pill shows green when connected.

## [1.1.29] - 2026-03-28

### Added
- YouTube OAuth "Change Account" button with current account name display.

## [1.1.28] - 2026-03-28

### Fixed
- ATEM, SmartScope, and MultiView devices rejected from Videohub detection (prevents false positive scan results).

## [1.1.27] - 2026-03-28

### Added
- Facebook OAuth "Change Page" button for destination switching.
- Facebook personal account streaming support (user live_videos endpoint).
- SSE-based device status stream from relay to Electron app (`/api/church/app/status/stream` endpoint).
- Collapsible toggles added to all status page sections.

### Fixed
- Ghost Videohub detections eliminated from network scanner.
- Facebook OAuth scopes reduced to those not requiring app review.
- YouTube OAuth uses relay-redirect flow instead of localhost loopback.
- YouTube/Facebook OAuth client IDs fetched from relay server (not hardcoded).
- Unconfigured device pills hidden; ProPresenter pill added to status bar.
- STATUS_JSON stdout spam removed (status delivered via relay SSE).
- ProPresenter slide data updated from poll loop; PP 21 response logging added.
- Device status piped from agent to Electron via STATUS_JSON lines.
- Device identity log lines parsed for status page display.
- Infinite WebSocket replacement loop stopped in relay.

## [1.1.26] - 2026-03-28

### Added
- Facebook OAuth "Change Page" button for destination switching.

## [1.1.25] - 2026-03-28

### Added
- Facebook personal account streaming via user `live_videos` endpoint.

## [1.1.24] - 2026-03-28

### Fixed
- Facebook OAuth scopes reduced to those not requiring Meta app review.

## [1.1.23] - 2026-03-28

### Fixed
- YouTube OAuth switched to relay-redirect flow instead of localhost loopback (fixes callback on headless/remote setups).

## [1.1.22] - 2026-03-28

### Fixed
- YouTube and Facebook OAuth client IDs fetched from relay server instead of being hardcoded in the desktop app.

## [1.1.21] - 2026-03-28

### Fixed
- Unconfigured device pills hidden from status bar; ProPresenter pill added.

## [1.1.20] - 2026-03-28

### Added
- Collapsible toggles on all status page sections.

## [1.1.19] - 2026-03-28

### Fixed
- Removed STATUS_JSON stdout spam; status now delivered exclusively via relay SSE stream.

## [1.1.18] - 2026-03-28

### Fixed
- ProPresenter slide data updated from poll loop instead of stale cached data.
- PP 21 response logging added for diagnostics.

## [1.1.17] - 2026-03-28

### Added
- Device status pulled from relay via SSE instead of unreliable stdout log parsing. New `/api/church/app/status/stream` endpoint provides real-time status with Bearer token auth.

## [1.1.16] - 2026-03-28

### Changed
- Full device status piped from church-client agent to Electron via STATUS_JSON protocol.

## [1.1.15] - 2026-03-28

### Added
- Device identity log lines parsed in Electron for status page display (model names, firmware versions).

## [1.1.14] - 2026-03-28

### Fixed
- Infinite WebSocket replacement loop stopped in relay: stale close handler no longer resets church state when a new connection already exists.
- Relay logs old/new remote address on WebSocket replacement for debugging.

## [1.1.13] - 2026-03-28

### Fixed
- ProPresenter 21 integration rewritten to match proven Tally Clicker patterns: `isRunning()` uses `/v1/status/slide`, `getVersion()` uses `/version`, chunked HTTP streaming replaced with 2s polling, `goToSlide` uses `/focused/` endpoint, response bodies consumed to prevent TCP socket hangs.

## [1.1.12] - 2026-03-28

### Changed
- ProPresenter integration switched from WebSocket to REST API polling for PP 21.x. The old "Remote Classic" WebSocket protocol (`/stagedisplay`) was removed in PP 21; replaced with chunked HTTP on `/v1/status/slide` for real-time slide events.

### Fixed
- "ProPresenter not configured" errors when sending commands via Tally Engineer.
- Perpetual WebSocket ECONNREFUSED errors with ProPresenter 21.

## [1.1.11] - 2026-03-28

### Added
- ProPresenter status tracking in Electron wrapper (connection state, current slide, timers).

## [1.1.10] - 2026-03-28

### Fixed
- ProPresenter WebSocket and REST API now use the same port (avoids split configuration).
- Tally Engineer AI updated with ProPresenter 21.x version rebranding knowledge.

## [1.1.9] - 2026-03-27

### Added
- Factory reset option in Equipment tab and system tray menu.

### Changed
- PTZ cameras moved from Recording to Core device category.

### Removed
- NDI device type removed entirely (registry, UI, IPC handlers, preview, equipment tester, locales).
- Dante/NMOS device type removed (registry, tester, config save/load).
- Empty Monitoring category removed (NDI was sole member).

## [1.1.8] - 2026-03-27

### Added
- Room/campus picker moved to header bar below church name with optgroup campus grouping.

### Fixed
- Apple Silicon click regression: `trafficLightPosition`, platform detection, and `pointer-events` corrected for ARM64 Macs.

### Changed
- Quick Chat bar removed from Status tab (chat lives in Tally Engineer tab).
- Old room assignment section removed from Equipment simple mode.

### Security
- Bumped `path-to-regexp` to 0.1.13 in relay-server, tally-encoder, and companion-ai-builder.
- Bumped `brace-expansion` to 1.1.13 in relay-server.
- Bumped `picomatch` to 2.3.2 in church-client.

## [1.1.7] - 2026-03-27

### Fixed
- ProPresenter `isRunning()` treats any HTTP response (including error codes) as "running" — previously only 2xx was accepted, causing false "not configured" status.

## [1.1.6] - 2026-03-27

### Added
- Room selector always visible in Electron app (not just multi-room setups).
- `system.diagnosticBundle` command for exporting full diagnostic snapshots.

### Fixed
- Reconnect storm stopped: relay close handler guarded with `church.ws !== ws` check; church-client skips reconnect on intentional "replaced by new connection" close code 1000.
- Relay latency climb fixed: stale pong timeout cleared before setting a new one in heartbeat loop.
- `wsConnectionsByIp` entries deleted when count reaches 0 (prevents unbounded Map growth).
- ProPresenter slide numbers displayed as 1-based in AI context and diagnostic output.
- Six Telegram bot bugs fixed: status display, slide indexing, last slide detection.
- `lastSlide` and `goToSlide` fixes registered in main commands.js registry.

### Changed
- Internal dev artifact docs removed from repo root.

## [1.1.5] - 2026-03-27

### Fixed
- Status reporting race conditions fixed across all devices: `sendStatus()` called after initial connection checks for Companion, vMix, mixer, and encoder.
- HEAD request bugs fixed: ProPresenter and vMix `isRunning()` switched from HEAD to GET (HEAD may return 405 on some firmware).
- Encoder status pushed immediately on connect/disconnect and stream start/stop transitions (was only updated by 10s periodic timer).
- Companion status pushed immediately on connection state transitions.

## [1.1.4] - 2026-03-27

### Added
- Resolume Arena row in portal Equipment Status table.

### Fixed
- Resolume `isRunning()` switched from HEAD to GET (HEAD returns 405 on Resolume's REST API).
- Resolume connected state pushed to relay after initial connection check.
- `CHURCH_ID` moved from blocked inline script to `data-church-id` attribute (CSP fix).
- AI model IDs corrected from invalid `-20250627` suffix to `claude-sonnet-4-6`.

## [1.1.3] - 2026-03-27

_Version bump only — no code changes._

## [1.1.2] - 2026-03-27

### Added
- Companion deep integration: read any module variable via HTTP API, read/set custom variables, variable watch system with polling and change events, auto-subscribe to common variables per device type (13 module profiles).
- Portal Companion setup guide with smart button suggestions.
- AI-powered triage: routes troubleshooting to Claude Sonnet for root cause analysis with confidence percentages and step-by-step remediation.
- AutoPilot alert triggers: new `alert_condition` trigger type with pattern matching and severity filtering. Four recovery templates (stream restart, audio silence, encoder reconnect, ATEM failover).
- AI Engineer: Sonnet diagnostics for troubleshooting, proactive memory references ("last time this happened..."), incident chain tracking within 5-minute windows.

### Changed
- Lite Mode renamed to Volunteer Mode.
- Dark/light theme toggle with localStorage persistence.
- Download links use stable filenames (Tally-arm64.dmg, Tally-intel.dmg).

### Fixed
- Telegram webhook handler missing `async` (crash on unhandled promise).
- Weekly digest `setInterval` never stored — now tracked for cleanup.
- UUID fallback dead code removed (Node 22 always has `randomUUID`).
- Tier downgrade crash on unknown tier (`-1` indexOf) — now validates.
- Clipboard copy promise unhandled — now catches errors gracefully.
- CSP blocking inline handlers and null crash in pre-service readiness widget.
- ARM64: remove `aria-live` from `tab-status`; fix `aria-modal` on hidden fix-all modal.

## [1.1.1] - 2026-03-26

### Added
- Portal Lite Mode toggle: hides advanced nav items, shows only Overview/Alerts/Help.
- Login page extracted to static HTML/CSS files (no more inline template).
- Portable config export/import for multi-campus deployment.
- Auto-update state surfacing, What's New splash screen, window bounds clamping.
- ARIA live regions and accessible sparkline for screen readers.
- i18n framework, netmask auto-detect, deep links, Windows ARM64 support.
- P2 UX improvements: quality indicator, JWT warning, log toggle, backup rotation, CLI.

### Fixed
- 23 escaped template literals (`\${name}` → `${name}`) in portal.js.
- Unicode entities (`\u2014`, `\u2026`) showing as literal text in HTML.
- Analytics 503: `days` variable scoped correctly for custom date ranges.
- Trial duration corrected; readonly role added; `x-csrf-token` added to CORS.
- Campus endpoints, room ownership, reseller password minimum length, null guards.
- Locale persistence, reseller lifecycle emails, timeline limits, ticket SSE.
- `canAutoFix` accuracy, monthly report catch-up, `logo_url` validation.
- `unsafe-inline` removed from CSP — portal onclick handlers migrated to event delegation.
- Versioned config schema, better sign-in error messages, crash cascade fix.
- Viewer snapshots 90-day pruning added; viewer_update broadcast to portal SSE.

### Security
- Full codebase security audit: SQL injection allowlists, XSS escaping, HTTPS validation on email URLs, admin session TTL reduced from 8h to 2h, session secret required (no weak fallback), error messages sanitized, audit log 90-day retention, CSP hardened, fetch timeouts on all API calls, timer/listener leak cleanup.

## [1.1.0] - 2026-03-26

### Added
- YouTube OAuth fallback for viewer counts on private/unlisted broadcasts.
- Facebook API v21.0 integration with token expiry alerts.
- Live viewer widget on portal dashboard via SSE.
- Portal extracted to separate HTML/CSS/JS files.
- Electron dark/light theme toggle and collapsible sections.
- Friendly ATEM input names in commands and portal.
- AI chat improvements: ATEM priority routing, preview routing, MP1/MP2 direct cut.
- Check for Updates menu item.

### Changed
- App version bumped to 1.1.0 across all packages.

### Fixed
- Retry on timeout for all stream platform API calls.
- Hide unconfigured gear pills; suppress OBS when not configured.
- Sharp fix for Intel Mac builds in `afterPack.js`.

## [1.0.1] - 2026-03-22

### Added
- Room layer under Campus in the Church → Campus → Room hierarchy.
- Main church always shown with Rooms button in campuses table.
- Circuit breakers for Telegram and Stripe external calls.
- SQLite `busy_timeout` and health endpoint rate limiting.
- Graceful server shutdown with uncaught exception safety net.
- Structured error logging and enhanced health endpoints.
- Direct HyperDeck and encoder controls via hardened parser/status.
- Coverage tooling installed across all codebases with blocking CI gates.
- 1,200+ new tests: encoders, mixers, IPC contracts, WebSocket routing, commands, routes, operational flows, state machines.

### Fixed
- Four production reliability bugs found in beta testing.
- vMix and Resolume parameter validation and null-safe status checks.
- ProPresenter and disk monitoring crashes from missing names and `df` output.
- Session and encoder alert scoping tightened; encoder status null safety.
- NaN propagation in Allen & Heath SQ channel index conversion.
- Timezone awareness bugs in scheduler, health checks, Telegram, and stream modules.
- Auth, billing, and OBS critical bugs across relay-server and church-client.
- Campus picker showing hardcoded "Main Campus" instead of actual church name.
- AI parser `SYSTEM_PROMPT` missing closing tag; full commands.js restored.
- E2E wizard selectors updated to match refactored UI.

### Security
- Bumped flatted from 3.3.3 to 3.4.2 in relay-server.

## [1.0.0] - 2026-02-22

### Added
- Initial production baseline for Tally relay, church client, and Electron app.
- Plus tier support and feature gating.
- Dynamic encoder UI support and Companion 4.x compatibility improvements.

### Changed
- Rebrand pass across desktop and web surfaces to Tally positioning.
- Reseller web experience moved to a commission-based model.

### Fixed
- Stale relay URL persistence and session invalidation issue.
- Chat panel tab visibility bug.
- Church portal billing tier display without requiring Stripe at runtime.
