# TallyConnect QA Checklist

Generated: 2026-04-08 | Covers: relay-server, portal, church-client, electron-app

---

## P0 — Critical (blocks beta/launch)

- [ ] **Security** Hardcoded JWT secret fallbacks — if `JWT_SECRET` env var is unset, tokens are signed with publicly known defaults, enabling token forgery — `relay-server/src/eventMode.js:86`, `adminPanel.js:815,869`, `reseller.js:662,685` — Est: 1hr
- [ ] **Security** XSS in Electron renderer — `action` variable interpolated directly into innerHTML without escaping — `electron-app/src/renderer.js:613` — Est: 0.5hr
- [ ] **Feature** Email unsubscribe missing — no unsubscribe link, opt-out, or CAN-SPAM compliance in any email flow; portal has notification toggles but transactional emails lack one-click unsubscribe — `relay-server/src/weeklyDigest.js`, `monthlyReport.js` — Est: 4hr
- [ ] **Bug** Silent `.catch(() => {})` swallows problem-finder failures — relay push and analysis errors are invisible to users — `electron-app/src/problem-finder-bridge.js:290,326,345,383` — Est: 1hr
- [ ] **Security** Unsafe file upload path — `fs.readFileSync(filePath)` with user-supplied path lacks realpath validation or sandboxing — `electron-app/src/main.js:1543` — Est: 1hr

---

## P1 — High (should fix before wider release)

- [ ] **Bug** Unhandled async rejection in `requireReseller()` middleware — async IIFE has no `.catch()`, so DB query failures cause unhandled rejection — `relay-server/src/routes/authMiddleware.js:135-145` — Est: 0.5hr
- [ ] **Bug** Infinite polling loops with no backoff — polling catch blocks silently retry forever, potential DoS on API — `portal.js:2918,3764,4023,4075,4133` — Est: 2hr
- [ ] **Bug** 13+ silent catch blocks in portal — drag reorder, localStorage, profile load, and poll failures are invisible to users — `portal.js:1034,1175,1181,1184,2918,4398,4423` — Est: 3hr
- [ ] **UX** Missing loading states for async card updates — ATEM, ProPresenter, VideoHub, SmartPlugs, EquipmentRoles, StreamStats, BroadcastHealth cards have no spinner/skeleton — `portal.js:1704-1717` — Est: 3hr
- [ ] **Bug** WeeklyDigest error logging only captures `.message`, not full stack — `relay-server/src/weeklyDigest.js:694` — Est: 0.5hr
- [ ] **Security** Stripe price IDs fall back to `'placeholder'` strings — billing could silently use wrong price in non-prod — `relay-server/src/billing.js:56-72` — Est: 1hr
- [ ] **Bug** Memory leak — keydown listener not removed after modal closes — `electron-app/src/renderer.js:647` — Est: 0.5hr
- [ ] **UX** No confirmation dialog for stream key regeneration or macro/equipment config deletion — accidental data loss possible — `portal.js` (regenRoomKey action, macro delete) — Est: 2hr
- [ ] **Bug** Multiple iOS Safari scroll issues — recent commits (846380f, aa4af76, 7aa72f2, d4da41f, a218063, feb2a9c, ccfe5df) show repeated fixes; `-webkit-overflow-scrolling: touch` on sidebar may still cause bounce/jank — `portal.css:512`, `portal.js:469` — Est: 3hr

---

## P2 — Medium (quality of life)

- [ ] **UX** Missing HTML5 form validation — email, IP address, URL, and port inputs lack `required`, `type`, and `pattern` attributes — `portal.html:545-564,768,777,836,845,882,892,902,912` — Est: 3hr
- [ ] **UX** Inconsistent button loading/disabled states — mixed `btn.disabled`, `btn.textContent`, `opacity:0.5` vs `0.7` patterns — `portal.js:1772,1942,7136` — Est: 2hr
- [ ] **UX** No modal focus trap or escape key stack management — multiple overlays with hardcoded z-index (9999, 8000) can conflict — `portal.html:105,98` — Est: 2hr
- [ ] **Performance** Unmanaged intervals without shutdown cleanup — `relay-server/src/planningCenter.js:2065`, `monthlyReport.js:67` — Est: 1.5hr
- [ ] **UX** Inconsistent error display — mix of toasts (ephemeral), DOM injection (persistent), and console-only; abbreviations like SP, BH, PP, VH make debugging hard — `portal.js:1704-1717,5490` — Est: 3hr
- [ ] **UX** No responsive breakpoints for small phones (<480px) or large displays (>1920px) — only 4 media queries at 768px — `portal.css:470,510,748,1193` — Est: 4hr
- [ ] **UX** Accessibility gaps — most form fields missing `for` attributes, limited `aria-label` usage, no `:focus-visible` for keyboard nav, no high-contrast error states — `portal.html`, `portal.css:191` — Est: 4hr
- [ ] **UX** Hardcoded fallback URLs may cause failures in non-prod environments — `churchAuth.js:168`, `churchPortal.js:1589` — Est: 1hr
- [ ] **Bug** Client-side password validation checks length (8 chars) but not complexity; email format not validated client-side — `portal.js:4275-4321` — Est: 1hr
- [ ] **UX** Section drag reorder saves to localStorage with no success feedback — `portal.js:1175` — Est: 0.5hr

---

## P3 — Low (polish/nice-to-have)

- [ ] **Polish** Extensive inline styles on form elements — makes theming/maintenance difficult — `portal.html:768,777,801,805,822,836,840,861,882` — Est: 4hr
- [ ] **Polish** Placeholder text used as only field label indicator — disappears on focus, no `required` asterisks — `portal.html:545` — Est: 1hr
- [ ] **Polish** Custom dropdown keyboard navigation — Facebook page selector may not be keyboard-accessible — `portal.html:859-866` — Est: 1hr
- [ ] **Polish** Missing `-webkit-touch-callout: none` on long-pressable elements and `-webkit-user-select: none` on all drag handles — `portal.css` — Est: 1hr
- [ ] **Feature** Ecamm encoder Bonjour/mDNS discovery not implemented — falls back to hardcoded port 65194 — `church-client/src/encoders/ecamm.js:60` — Est: 3hr
- [ ] **Polish** Nudge element opacity animation has no CSS transition — `portal.js:937` — Est: 0.5hr
- [ ] **Polish** Console error messages use unclear abbreviations (SP, BH, PP, VH) — `portal.js:1714,1717,1705,1706` — Est: 0.5hr

---

## Summary

| Priority | Items | Est. Hours |
|----------|-------|------------|
| **P0 — Critical** | 5 | 7.5 |
| **P1 — High** | 9 | 16.5 |
| **P2 — Medium** | 10 | 22.0 |
| **P3 — Low** | 7 | 11.0 |
| **Total** | **31** | **57.0** |

### Notes
- Time estimates assume a single developer familiar with the codebase
- iOS Safari scroll (P1) has been fixed 7 times in recent commits — needs a root-cause investigation rather than another patch
- Email unsubscribe (P0) is a legal/compliance requirement (CAN-SPAM), not just a feature gap
- JWT secret fallback (P0) is the single highest-risk security item — a one-line startup check eliminates it
