# TallyConnect QA Checklist

Generated: 2026-04-08 | Covers: relay-server, portal, church-client, electron-app, tally-connect-mobile

---

## P0 — Critical (Fix Before Next Deploy)

- [ ] **[deploy]** Rundown creation 500 error — BIGINT fix pushed, needs deploy verification. Create a manual rundown in the portal and confirm no 500 error — `relay-server/src/manualRundown.js createPlan()` — Est: 30min to verify
- [ ] **[mobile]** Mobile sidebar scroll on iOS — `touch-action` removal fix pushed, needs verification on actual iOS hardware (not simulator) — Est: 15min to verify
- [ ] **[security]** Hardcoded JWT secret fallbacks — if `JWT_SECRET` env var is unset, tokens are signed with publicly known defaults, enabling token forgery — `relay-server/src/eventMode.js:86`, `adminPanel.js:815,869`, `reseller.js:662,685` — Est: 1hr
- [ ] **[security]** XSS in Electron renderer — `action` variable interpolated directly into innerHTML without escaping — `electron-app/src/renderer.js:613` — Est: 30min
- [ ] **[security]** Unsafe file upload path — `fs.readFileSync(filePath)` with user-supplied path lacks realpath validation or sandboxing — `electron-app/src/main.js:1543` — Est: 1hr
- [ ] **[bug]** Silent `.catch(() => {})` swallows problem-finder failures — relay push and analysis errors are invisible to users — `electron-app/src/problem-finder-bridge.js:290,326,345,383` — Est: 1hr

---

## P1 — High (Fix This Week)

- [ ] **[email]** Unsubscribe link missing from onboarding and transactional emails — CAN-SPAM compliance requirement. Check `relay-server/src/weeklyDigest.js`, `monthlyReport.js`, and all email-sending code for missing one-click unsubscribe footer — Est: 2-4hr
- [ ] **[diagnostics]** Diagnostics page shows no data when desktop app is offline — should backfill from existing alert history rather than showing empty state — Est: 4hr
- [ ] **[diagnostics]** "Service windows not configured" message is a dead end — replace with a direct link to schedule setup page — Est: 30min
- [ ] **[bug]** Unhandled async rejection in `requireReseller()` middleware — async IIFE has no `.catch()`, DB query failures cause unhandled rejection — `relay-server/src/routes/authMiddleware.js:135-145` — Est: 30min
- [ ] **[bug]** Infinite polling loops with no backoff — polling catch blocks silently retry forever, potential DoS on API — `portal.js:2918,3764,4023,4075,4133` — Est: 2hr
- [ ] **[bug]** 13+ silent catch blocks in portal — drag reorder, localStorage, profile load, and poll failures are invisible to users — `portal.js:1034,1175,1181,1184,2918,4398,4423` — Est: 3hr
- [ ] **[security]** Stripe price IDs fall back to `'placeholder'` strings — billing could silently use wrong price in non-prod — `relay-server/src/billing.js:56-72` — Est: 1hr
- [ ] **[bug]** WeeklyDigest error logging only captures `.message`, not full stack — `relay-server/src/weeklyDigest.js:694` — Est: 30min
- [ ] **[bug]** Memory leak — keydown listener not removed after modal closes — `electron-app/src/renderer.js:647` — Est: 30min
- [ ] **[ux]** No confirmation dialog for stream key regeneration or macro/equipment config deletion — accidental data loss possible — `portal.js` (regenRoomKey action, macro delete) — Est: 2hr
- [ ] **[ux]** Missing loading states for async card updates — ATEM, ProPresenter, VideoHub, SmartPlugs, EquipmentRoles, StreamStats, BroadcastHealth cards have no spinner/skeleton — `portal.js:1704-1717` — Est: 3hr

---

## P2 — Medium (Fix This Sprint)

- [ ] **[portal]** Overview drag-and-drop needs post-fix verification — snap-back-on-drop bug was just fixed; confirm fix holds under normal usage — Est: 15min to verify
- [ ] **[portal]** `alert()` used for error messages — replace browser `alert()` calls with styled toast/modal notifications. `grep -n "alert(" relay-server/public/portal/portal.js` — Est: 2hr
- [ ] **[companion]** Companion disconnecting repeatedly — 15+ disconnect/reconnect cycles in logs. Investigate `relay-server/src/signalFailover.js` and websocket reconnect logic for root cause — Est: 2hr
- [ ] **[propresenter]** ProPresenter disconnecting repeatedly — same pattern, 14+ disconnects in logs. Check ProPresenter handler in `church-client/src/` and relay-side session tracking — Est: 2hr
- [ ] **[clock-app]** Clock app out of sync with tally-landing repo — recent builds live in `relay-server/public/tools/clock/`; sync to `tally-landing` and confirm source of truth — Est: 1hr
- [ ] **[ux]** Missing HTML5 form validation — email, IP, URL, and port inputs lack `required`, `type`, and `pattern` attributes — `portal.html:545-564,768,777,836,845,882,892,902,912` — Est: 3hr
- [ ] **[ux]** Inconsistent button loading/disabled states — mixed `btn.disabled`, `btn.textContent`, `opacity:0.5` vs `0.7` patterns — `portal.js:1772,1942,7136` — Est: 2hr
- [ ] **[ux]** No modal focus trap or escape key stack management — multiple overlays with hardcoded z-index (9999, 8000) can conflict — `portal.html:105,98` — Est: 2hr
- [ ] **[ux]** Inconsistent error display — mix of toasts, DOM injection, and console-only; abbreviations like SP, BH, PP, VH make debugging hard — `portal.js:1704-1717,5490` — Est: 3hr
- [ ] **[ux]** No responsive breakpoints for small phones (<480px) or large displays (>1920px) — only 4 media queries at 768px — `portal.css:470,510,748,1193` — Est: 4hr
- [ ] **[ux]** Accessibility gaps — most form fields missing `for` attributes, limited `aria-label`, no `:focus-visible` for keyboard nav — `portal.html`, `portal.css:191` — Est: 4hr
- [ ] **[performance]** Unmanaged intervals without shutdown cleanup — `relay-server/src/planningCenter.js:2065`, `monthlyReport.js:67` — Est: 1.5hr
- [ ] **[bug]** Client-side password validation checks length only — no complexity check; email format not validated client-side — `portal.js:4275-4321` — Est: 1hr
- [ ] **[ux]** Hardcoded fallback URLs may cause failures in non-prod environments — `churchAuth.js:168`, `churchPortal.js:1589` — Est: 1hr

---

## P3 — Low (Backlog / Tech Debt)

- [ ] **[mobile]** Sentry DSN is a placeholder — crash reports silently dropped until replaced — `tally-connect-mobile/src/lib/sentry.ts:4` — Est: 15min
- [ ] **[mobile]** SSL certificate pinning not implemented — MITM risk on guest/church networks — `tally-connect-mobile/src/api/client.ts:82` — Est: 4hr
- [ ] **[error-handling]** Unguarded `JSON.parse()` calls — malformed payload will throw and crash the handler in: `relay-server/src/autoRecovery.js:347`, `onboardingChat.js:274,275,379,384`, `aiTriage.js:386`, `mobileWebSocket.js:175`, `churchMemory.js:31`, `preServiceCheck.js:214,234,283,298,347`, `churchPortal.js:124` — Est: 2hr
- [ ] **[error-handling]** Promise chains without `.catch()` in health routes — `relay-server/src/routes/health.js:162,244,319,323` — Est: 30min
- [ ] **[code-quality]** `parseInt()` calls missing radix — 10 instances in `churchPortal.js:2546,2985,4041,4200,4248,4734,4820,4821,4884,4946` — Est: 30min
- [ ] **[code-quality]** Health probe ID uses `Math.random()` — replace with `crypto.randomBytes()` for collision-safe IDs — `relay-server/src/routes/health.js:292` — Est: 15min
- [ ] **[feature]** Ecamm Bonjour/mDNS discovery not implemented — falls back to hardcoded port 65194 — `church-client/src/encoders/ecamm.js:60` — Est: 3hr
- [ ] **[polish]** Section drag reorder saves to localStorage with no success feedback — `portal.js:1175` — Est: 30min
- [ ] **[polish]** Nudge element opacity animation has no CSS transition — `portal.js:937` — Est: 30min
- [ ] **[polish]** Console error messages use unclear abbreviations (SP, BH, PP, VH) — `portal.js:1714,1717,1705,1706` — Est: 30min
- [ ] **[polish]** Extensive inline styles on form elements — makes theming/maintenance difficult — `portal.html:768,777,801,805,822,836,840,861,882` — Est: 4hr
- [ ] **[polish]** Placeholder text used as only field label — disappears on focus, no `required` asterisks — `portal.html:545` — Est: 1hr
- [ ] **[polish]** Custom Facebook page dropdown may not be keyboard-accessible — `portal.html:859-866` — Est: 1hr

---

## Scan Notes (Investigated, Not Actionable)

- **Hardcoded localhost URLs** (`localhost:8888`, `localhost:8088`, etc.) in `church-client/src/setup.js` — these are default placeholder values for user-configurable fields, not actual hardcoded endpoints.
- **Hardcoded IPs in portal.html** (`192.168.x.x`, `ws://localhost`) — these are HTML `placeholder` attributes, not live values.
- **All credentials use `process.env.*`** — no hardcoded secrets found in source. Env var hygiene is good.
- **`console.log` statements** in relay-server use context prefixes and appear intentional for operational logging. No cleanup needed.
- **`innerHTML` in electron-app/src/renderer.js** — assignments use hardcoded SVG strings, not user input. No XSS risk from these specific sites.

---

## Summary

| Priority | Items | Est. Hours |
|----------|-------|------------|
| **P0 — Critical** | 6 | ~6 |
| **P1 — High** | 11 | ~18 |
| **P2 — Medium** | 14 | ~27 |
| **P3 — Low** | 13 | ~17 |
| **Total** | **44** | **~68** |

> Time estimates assume one developer familiar with the codebase. Deploy verification items (P0 rundown, P0 mobile scroll, P2 DnD) are mostly confirm-only and can be knocked out in under an hour total.
