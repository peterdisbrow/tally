# Changelog

All notable changes to Tally are documented in this file.

The format follows [Keep a Changelog](https://keepachangelog.com/) and this project uses [Semantic Versioning](https://semver.org/).

## [Unreleased] — Rooms-First Refactor (Phase A complete, Phase B in progress)

### Added
- **Room selector** on Overview and Equipment tabs — filter by individual room instance
- **Equipment config panel** in portal with field-level editing and config sync to relay
- **Per-instance status tracking** in relay websocketRouter
- **Windows installer build** via GitHub Actions with auto-update publishing
- **CDN stream verification** — confirm YouTube/Facebook streams are actually live
- **RTMP stream analytics** — bitrate, resolution, fps, codec monitoring
- **Direct HLS serving** with signed tokens (bypasses Vercel)
- **RTMP uptime tracking** via getStreamInfo with startedAt
- **Audio level monitoring** broadened to vMix and any encoder
- **ATEM full recording controls** in equipment and status tabs
- **YouTube/Facebook OAuth** — Change button for YouTube account, Change Page for Facebook destination switching, personal Facebook account support
- **Collapsible toggles** on all status page sections
- **Device status via SSE** — pull status from relay instead of stdout parsing
- **AI device-specific rules** so Tally Engineer executes commands instead of suggesting

### Changed
- **Sidebar consolidated** from 18 items to 10 with tab system (Schedule/Prefs moved under Profile, Analytics tabs swapped)
- Demo mode removed from portal
- Room/campus picker moved to header bar, quick chat bar removed
- NDI + Dante modules removed from Electron; PTZ moved to core; factory reset added
- AI confirmation prompts removed (conflicted with stream guard)

### Fixed
- Portal i18n translations for consolidated nav items
- Stale page references after sidebar consolidation
- Mark fixed → GO state transitions, checkbox styling, vMix config debug
- Missing tables in church delete cascade
- Version string comparison strips non-numeric prefixes
- SQ mixer connection reset on initial state query
- Relay illegal break statement in websocketRouter
- Smart-parser stop stream defaults to encoder when device status unavailable
- RTMP: NMS v4.x event handlers, Railway TCP proxy URL, FFmpeg progress output, HLS buffer/atomic writes
- Scanner: find Companion/ProPresenter on real local IP; reject ATEM/SmartScope/MultiView from Videohub detection; eliminate ghost Videohub detections
- UI: ATEM pill green when connected, grey dots during startup, delayed problem finder auto-run, hide unconfigured device pills
- OAuth: relay-redirect for YouTube instead of loopback, fetch client IDs from relay, remove Facebook scopes requiring app review
- STATUS_JSON stdout spam removed
- ProPresenter slide data polling, PP 21 response logging
- Relay WebSocket infinite replacement loop
- Apple Silicon click regression (trafficLightPosition, platform detection, pointer-events)

### Security
- Bump path-to-regexp to 0.1.13 (relay-server, tally-encoder, companion-ai-builder)
- Bump picomatch to 2.3.2 (church-client)
- Bump brace-expansion to 1.1.13 (relay-server)

## [1.1.7] — 2026-03-27

### Fixed
- ProPresenter: treat any HTTP response as "running" in isRunning() detection
- ProPresenter: PP detection accuracy, watchdog reconnect storm, config bleed (resetConfig refactor)
- Portal display bugs: coverage cap, unicode escapes, ATEM config snapshot
- Status bar: hide unconfigured device pills, add Resolume Arena chip, fix Resolume identity
- Auto-update repo URL corrected; Resolume scan detection improved; VideoHub false positives eliminated
- ARM64: remove aria-live from tab-status, fix aria-modal on hidden fix-all modal

### Added
- Resolume Arena added to Equipment Status portal display
- Sign Out option added to system tray menu

## [1.1.6] — 2026-03-27

### Fixed
- Reconnect storm, relay latency climb, and missing Sign Out
- ProPresenter: lastSlide + goToSlide fix in main commands.js registry
- ProPresenter: 6 Telegram bot bugs (status, slide indexing, last slide)
- ProPresenter: display 1-based slide numbers in AI context and diagnostic output

### Added
- Electron: always show room selector; add system.diagnosticBundle command

## [1.1.5] — 2026-03-27

### Fixed
- Status reporting race conditions and HEAD request bugs across all devices (ProPresenter, vMix, Companion, Mixer, Encoder)
- Tests updated to match HEAD → GET detection method changes

## [1.1.4] — 2026-03-27

### Added
- Resolume Arena row in Equipment Status portal table

### Fixed
- Resolume isRunning() changed from HEAD to GET request
- Push Resolume connected state to relay after initial connection check
- Correct AI model IDs from invalid -20250627 suffix to claude-sonnet-4-6
- Move CHURCH_ID from blocked inline script to data-church-id attribute (CSP fix)

## [1.1.3] — 2026-03-27

Version bump only (no functional changes beyond v1.1.2).

## [1.1.2] — 2026-03-27

### Added
- Companion deep integration: variables, watch system, device profiles
- Companion setup guide in portal with smart button suggestions
- AI diagnostics + AutoPilot alert triggers + smart rule suggestions
- AI Engineer: Sonnet diagnostics, proactive memory, incident chains

### Changed
- Volunteer Mode renamed; light theme improvements; stable download links

### Fixed
- CSP inline handler violations and pre-service null crash
- Async triage handler crash (await in sync function)
- 4 additional bug fixes: crash, memory leak, logic errors

## [1.1.1] — 2026-03-26

### Added
- i18n support, netmask auto-detect, deep links, Windows ARM64
- Portable config export/import for multi-campus deployment
- Auto-update state surfacing, What's New splash screen, window bounds clamping
- ARIA live regions and accessible sparkline (a11y)
- Versioned config schema and improved sign-in errors
- Lite Mode for portal, login extraction, template literal fixes

### Fixed
- P0: trial duration, readonly role, x-csrf-token in CORS
- P1: campus endpoints, room ownership, reseller password min, null guard
- P2: locale persistence, reseller lifecycle emails, timeline limits, ticket SSE
- P3: canAutoFix accuracy, monthly report catch-up, logo_url validation
- P3: remove unsafe-inline CSP — migrate portal onclick to event delegation
- Crash cascade fix

### Changed
- P2 UX improvements: quality indicator, JWT warning, log toggle, backup, rotation, CLI

### Security
- Full codebase security audit fixes

## [1.1.0] — 2026-02-23

### Added
- Launch support workflow in Church Portal (diagnostics, triage, ticket create/update, status components/incidents)
- Billing and lifecycle hardening (plan gates, Stripe wiring readiness, autopilot/incident flows)
- Security and operational guardrails for encoder auth and admin/sensitive routes

### Changed
- Stabilized reseller/event route behavior and integration smoke paths
- Improved launch readiness based on full feature audit findings

### Fixed
- Multiple launch-blocking regressions found during audit and smoke testing

## [1.0.0] — 2026-02-22

### Added
- Initial production baseline for Tally relay, church client, and Electron app
- Plus tier support and feature gating
- Dynamic encoder UI support and Companion 4.x compatibility improvements

### Changed
- Rebrand pass across desktop and web surfaces to Tally positioning
- Reseller web experience moved to a commission-based model

### Fixed
- Stale relay URL persistence/session invalidation issue
- Chat panel tab visibility bug
- Church portal billing tier display without requiring Stripe at runtime
