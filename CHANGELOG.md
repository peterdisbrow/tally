# Changelog

All notable changes to Tally are documented in this file.

The format follows Keep a Changelog and this project uses Semantic Versioning.

## [Unreleased]

### Deployment Baseline (Verified 2026-02-24)
- Railway production (`tally`) deployment: `dac49099-e392-4262-b837-c764e4916de4` at `2026-02-24T22:24:23Z` (image `sha256:266a570b2ded8e1b48a5441a8bc3cbface51c551a2c80186ac5a2b4fcda3fe10`).
- Vercel production (`tallyconnect.app`) deployment: `dpl_Cvhoe7K22EhZefbpFYtr3R6wBXvq` created `2026-02-24` (`tally-landing-jq4funjfp-peters-projects-8e626471.vercel.app`).
- Vercel CLI metadata for this deployment does not expose a git SHA (manual/CLI deployment metadata only).
- Relay git baseline in this repo: `0be81f3` (`2026-02-23`, before local release patches applied and deployed).

### Fixed
- Platform status check for `admin_api_proxy` now supports explicit `ADMIN_PROXY_URL` and automatic `api.<host>` fallback when `APP_URL` points to the marketing site.

### Added
- Added this root changelog so product, relay, and desktop release changes are tracked in one place.

## [1.1.0] - 2026-02-23

### Added
- Launch support workflow in Church Portal (diagnostics, triage, ticket create/update, and status components/incidents).
- Billing and lifecycle hardening (plan gates, Stripe wiring readiness, autopilot/incident flows).
- Security and operational guardrails for encoder auth and admin/sensitive routes.

### Changed
- Stabilized reseller/event route behavior and integration smoke paths.
- Improved launch readiness based on full feature audit findings.

### Fixed
- Multiple launch-blocking regressions found during audit and smoke testing.

## [1.0.0] - 2026-02-22

### Added
- Initial production baseline for Tally relay, church client, and Electron app.
- Plus tier support and feature gating.
- Dynamic encoder UI support and Companion 4.x compatibility improvements.

### Changed
- Rebrand pass across desktop and web surfaces to Tally positioning.
- Reseller web experience moved to a commission-based model.

### Fixed
- Stale relay URL persistence/session invalidation issue.
- Chat panel tab visibility bug.
- Church portal billing tier display without requiring Stripe at runtime.
