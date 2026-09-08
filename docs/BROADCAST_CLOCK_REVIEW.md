# Broadcast Clock review

**Repo:** `peterdisbrow/tally`  
**Branch base:** `origin/main`  
**Reviewed:** 2026-09-08  
**Method:** source + built SPA string extraction + live HTTP on `tallyconnect.app` / `api.tallyconnect.app` + new unit tests for `clockLayouts`

This answers: what Broadcast Clock is supposed to do for a church booth, what actually ships, whether that is Sunday-usable, and what to build next. No customer quotes. Claims below are from this repo, live routes, or the committed clock bundle.

---

## Summary verdict

**Partial. Two products share a “clock” name and are not cohesive.**

| Surface | Booth intent | As built | Sunday-usable? |
|---------|--------------|----------|----------------|
| **Production Clock SPA** (`/clock` → `/tools/clock/clock`) | Free booth clock: wall time, countdowns, NTP, optional multi-zone | Works as a **local** clock/timer. Settings persist in `localStorage`. NTP uses third-party APIs, not Tally `/api/time`. | **Yes for wall clock + manual timers.** Not wired to rundown or booth devices. |
| **Multi-clock** (`/tools/clock/multi-clock`) | Several clocks on one display (FOH / stream / campus) | Grid + per-cell modes exist. Extra modes (ProPresenter, HyperDeck, ATEM, stream/record) render **“Not Connected”** because live Tally status is never passed in. | **Yes for local cells.** Live-device modes are dead UI. |
| **Studio Clock** (`/rundown/clock/:token`) | Control-room display: wall time + live cue countdown from the rundown share | Page and WebSocket exist. Portal “Studio Clock” previously opened `/rundown/view/:token?mode=clock`, which the view page **does not implement**. | **Yes once opened at the dedicated URL.** Share-card path was broken (fixed in this PR). |
| **`clock_layouts` API** | Church-scoped saved layouts | Table + CRUD routes exist. SPA never calls them. Routes used `req.churchId` (unset by auth) and `log.error` (ctx `log` is a function). | **Not used.** Would not have persisted correctly even if called (fixed in this PR). |

**North-star read:** the free clock is a useful standalone booth tool. It is not yet the Sunday-indispensable “same time as the rundown / same time as the switcher” display. The highest-leverage work is reliability (same-origin time sync, reconnect, correct share URLs) and rundown cohesion — not more clock modes.

`broadcastMonitor.js` is YouTube/Facebook stream health. It does not feed the clock.

`church-client` / `electron-app` / mobile have **no** Broadcast Clock UI. Companion has unused `clock_state` handlers; the relay never emits `clock_state`.

---

## 1. Intent (what it is supposed to do)

Inferred from committed copy, routes, portal cards, and the rundown-v3 plan — not from interviews.

### A. Production Clock (marketing “Broadcast Clock”)

Booth operators need a large, glanceable clock that stays honest when a laptop’s clock is wrong, plus simple timers for “back in 5” / “doors at 10:00”.

Shipped modes on the **single-clock** page (`/tools/clock/clock`):

- **Clock** — analog or digital wall time, optional 12/24h, timezone picker, named color/font
- **Count Up** — operator-started elapsed timer
- **Countdown** — duration timer with overtime flash after 30s past zero
- **Count To** — countdown to a time of day

Shipped extra modes on **multi-clock cells only** (labels in the bundle): ProPresenter, HyperDeck, Service (until / elapsed), Stream Time, Recording, Last Cue, ATEM Rec, ATEM TC.

Operator vs display: one browser page is both. Chrome auto-hides after 3s of idle. Keyboard shortcuts exist on the single-clock page (color, font, analog/digital, etc.). There is no separate “operator remote + locked display” pair and no share-URL for a configured layout.

### B. Studio Clock (rundown output)

Portal copy (before this PR): *“Large wall-clock display with current time, service elapsed time, and current cue countdown.”*

`docs/archive/rundown-v3-plan.html` specified `/rundown/clock/:token`: wall clock, current-item countdown, optional next item, wall-mount chrome, theme support.

Operator vs display: **display only**. Auth is the rundown **share token** (public, no church login). Control stays on Live Mode / portal. Same token family as view / timer / show / confidence / prompter.

### C. What it is not

- Not an overlay engine for program video (no keyer / NDI / SDI output in this repo).
- Not NTP in the protocol sense; “NTP sync” is HTTP time offset.
- Not connected to `broadcastMonitor` (CDN health).

---

## 2. As built — end-to-end flows

### 2.1 Open the free clock

```
/clock                          301 → /tools/clock/clock
/tools/clock/                   SPA home (see gap: marketing page)
/tools/clock/clock              single Production Clock
/tools/clock/multi-clock        multi-zone grid
/tools/multi-clock/             redirect (was /tools/clock/; now /tools/clock/multi-clock)
```

Live probe 2026-09-08:

- `GET https://tallyconnect.app/clock` and `GET https://api.tallyconnect.app/clock` → Production Clock (200).
- `GET https://api.tallyconnect.app/tools/clock/` → **Disbrow Productions quote / services landing** (title still “TallyConnect Production Clock”).
- `GET https://api.tallyconnect.app/tools/clock/clock` → clock UI; status line showed **“Local clock”** (NTP fallback) in the probe.
- `GET https://api.tallyconnect.app/api/time` → `{ serverTime, isoTime }` (200). Same-origin time API is live and unused by the SPA.

**Auth:** none. **Persistence:** `localStorage` keys `broadcast-clock-settings`, `broadcast-clock-presets`, `broadcast-multi-clocks`, `broadcast-multi-layout`. Browser-local; not church-scoped; lost on another machine or private window.

**Timezone:** IANA list (US + a few world cities) or `local`. Display uses `toLocaleString({ timeZone })` plus an NTP offset applied to `Date.now()`.

**Time sync (SPA):**

1. Supabase Edge Function `time-sync` on project `swybspstyyhopcmcngmi`
2. `https://timeapi.io/api/time/current/zone?timeZone=UTC`
3. `https://worldtimeapi.org/api/timezone/UTC`
4. Else offset `0` and label “Local clock”

Retry every 60s. Half-RTT compensation. **Does not call Tally `/api/time`.**

**Reconnect:** no Tally WebSocket on this SPA, so no reconnect story for rundown/devices.

### 2.2 Configure → save layout

Single clock: settings auto-save to `localStorage`. Presets are named snapshots in the same browser.

Multi-clock: layout mode (`2x1`, `2x2`, `1x3`, `1x4`, `featured`) and cell configs auto-save locally.

**Server `POST /api/church/app/clock-layouts` is not called** (zero matches in the committed bundle). OpenAPI does not document the route. Auth is **church-app Bearer JWT only** (`requireChurchAppAuth`) — portal cookie sessions would not work even after a wiring job.

### 2.3 Share / display

Production Clock: no generated share URL. Fullscreen is a local browser gesture. Anyone with `/clock` gets a blank default clock, not your booth layout.

Studio Clock:

1. Portal rundown → share token  
2. Intended URL: `/rundown/clock/:token`  
3. WS `wss://…/rundown-clock?token=…`  
4. `resolvePublicRundownAccess` → `buildPublicTimerStateForPlan`  
5. Messages: `timer_state` / `rundown_timer` / `rundown_ended`; client pings every 25s  

Themes: `?theme=` or `t` cycles dark / light / red-green. `n` toggles next-cue. `f` fullscreen. Wake Lock requested.

Wall clock on this page is **`new Date()` on the display machine** — it ignores `server_timestamp` on the WS payload.

### 2.4 Sync with rundown

| Path | Rundown sync? |
|------|----------------|
| Production Clock SPA | **No.** Bundle has no `rundown` string, no `/rundown-clock` WS, no `rundown-timer-client.js` usage. |
| `/tools/rundown-timer-client.js` | Helper for **timer** WS (`/rundown-timer`), written “for the clock app or any external display”. Clock SPA does not load it. |
| Studio Clock | **Yes**, when the plan is live. Idle copy: “Waiting for live rundown”. |
| Companion `clock_*` variables | **No.** Listens for `clock_state`; relay never sends it. Rundown variables are a separate channel. |

### 2.5 Device integration (ProPresenter / HyperDeck / ATEM)

Clock cell component accepts `proPresenter`, `hyperdecks`, `atem`, `isTallyConnected`, stream/record start timestamps.

Multi-clock renders that cell **without those props**. Single-clock page does not include those modes at all.

Marketing meta on `index.html`: *“live integration with ProPresenter and HyperDeck via TallyConnect.”* That path is not present in this build.

---

## 3. Working as intended?

**Standalone clock/timer: mostly yes. Product story (Tally-synced booth clock): no.**

### Bugs / dead UI (verified)

1. **Portal Studio Clock opened the wrong page.** Card used `/rundown/view/:token?mode=clock`. `rundown-view.html` only handles `compact` / `operator` / `summary` and `prompter` / `large-text`. Operators got a normal rundown table, not the studio clock. **Fixed in this PR.**
2. **`/tools/multi-clock/` redirected to the marketing home** (`/tools/clock/`), not `/tools/clock/multi-clock`. **Fixed in this PR.**
3. **`clock-layouts` used `req.churchId`.** `requireChurchAppAuth` sets `req.church.churchId`. Saves would have stored `NULL`; lists would miss rows. **Fixed in this PR.**
4. **`clock-layouts` called `log.error(...)`.** `routeCtx.log` is `function log(msg, meta)`. An error path would throw `TypeError` and skip the 500 JSON. **Fixed in this PR.**
5. **Studio Clock heartbeat leaked on reconnect** (new `setInterval` per `connect()`). **Fixed in this PR.**
6. **Live-device modes are dead UI** in the committed multi-clock build (props never supplied).
7. **`/tools/clock/` is a Disbrow Productions sales page** (quote estimator, `info@disbrowproductions.com`, ATEM School footer). `/clock` skips it; anyone opening `/tools/clock/` does not get a clock. Live-confirmed.
8. **Portal Studio Clock copy claimed “service elapsed time.”** `rundown-clock.html` has wall clock + cue remaining/elapsed/overtime + next cue. No service-elapsed field. Copy corrected in this PR to match the page.
9. **Companion clock variables stay empty.** Comment in `companion-module-tallyconnect/src/main.ts`: “future Tally Clock tool.”
10. **Invalid studio-clock tokens** still serve HTML and reconnect forever (“Connection lost”). Close reason `invalid share token` is not shown.

### Related (same share suite; not clock-only)

- Production displays card: Teleprompter → `?mode=teleprompter` (view wants `prompter` or `/rundown/prompter/:token`).
- Confidence Monitor on that card → `?mode=confidence` on the **view** URL. Confidence is `/rundown/confidence/:token` or timer `?mode=confidence`.

### Stale / source-of-truth

- Clock **source is not in this monorepo**. Shipped artifact: `relay-server/public/tools/clock/assets/index-BREot0gW.js` (~819 KB). `QA-CHECKLIST.md` already flags drift vs `tally-landing`.
- Bundle embeds a **Supabase anon JWT** and calls `send-email` / `time-sync` on that project. Time sync and the home-page quote form are off-Tally infrastructure.
- `index.html` references `/tools/clock/favicon.png`; that file is not in the tree (404).
- OpenAPI (`relay-server/docs/openapi.yaml`) omits `/api/time` and `/api/church/app/clock-layouts`.
- No prior tests for clock layouts, studio clock WS, or portal clock URLs.

### Tests run

```
cd relay-server && npx vitest run tests/clockLayouts.test.js
```

(See “Fixed in this PR” — these tests were added in this change.)

---

## 4. Fixed in this PR

Small, local fixes only. No SPA rebuild (source lives elsewhere).

| Fix | Why it was safe |
|-----|-----------------|
| Portal Studio Clock → `/rundown/clock/:token` | Card now hits the page that already exists. |
| `GET /rundown/view/:token?mode=clock` → 302 to `/rundown/clock/:token` | Old copied links keep working; other view modes unchanged. |
| Share API adds `clock_url` | Same pattern as `timer_url`. |
| `/tools/multi-clock/` → `/tools/clock/multi-clock` | Matches the unified SPA route. |
| `clockLayouts` uses `req.church.churchId` | Matches every other church-app route. |
| `clockLayouts` logger accepts function-style `log` | Error path no longer throws. |
| Read-only church-app tokens cannot POST/DELETE layouts | Aligns with other write routes. |
| DELETE scoped by `church_id` | Avoids deleting another tenant’s row if id leaked. |
| Studio Clock: single heartbeat interval | Stops stacked pings after reconnect. |
| `tests/clockLayouts.test.js` | Locks church scoping + logger behavior. |

---

## 5. Prioritized improvements

Effort is engineering scope (files / risk), not a calendar estimate.

### P0 — reliability / Sunday-critical

| Item | Why | Effort |
|------|-----|--------|
| **Point Production Clock NTP at same-origin `GET /api/time` first** | Booth clocks must not depend on Supabase + timeapi.io + worldtimeapi.org. Those failed in the live probe (“Local clock”) while `/api/time` returned 200. Wrong wall time is a trust-breaker. Needs a clock-app rebuild from `tally-landing` (or equivalent source). | Small in the SPA; **blocked on source-of-truth**. |
| **Keep Studio Clock share path correct** | Done in this PR. Add a portal/e2e assert that the card href contains `/rundown/clock/`. | Small |
| **Studio Clock: use `server_timestamp` for wall time (or show drift)** | Display PCs in the booth are often wrong. Rundown already sends `server_timestamp`. Apply the same half-RTT offset the SPA uses, or show “display clock disagrees with server.” | Small (`rundown-clock.html` only) |
| **Decide source of truth for the clock SPA** | Editing the minified bundle is unsafe. Until `tally-landing` (or a folder in this repo) is canonical, NTP and dead device modes cannot be fixed cleanly. `QA-CHECKLIST.md` already has this. | Small process; medium if the app is imported here |
| **Do not ship `/tools/clock/` as the default booth URL** | Either redirect `/tools/clock/` → `/tools/clock/clock`, or replace the home route with the clock. The sales page is fine at a different path. | Small (redirect) or medium (rebuild) |

### P1 — polish that strengthens rundown cohesion

| Item | Why | Effort |
|------|-----|--------|
| **One “Sunday clock” mental model** | Today: free clock (no rundown) vs studio clock (rundown only). Add a Production Clock cell mode **Rundown** that uses `rundown-timer-client.js` + the plan share token (query `?token=`). Same token as the portal card. | Medium |
| **Wire or hide live-device modes** | ProPresenter / HyperDeck / ATEM / stream/record labels without data look broken. Either pass church status (portal WS / church-app status) or remove the modes until a connection exists. Prefer hide-until-connected over more settings. | Medium |
| **Invalid / expired studio-clock token → static error, not reconnect loop** | Green-room display should say “link expired” once, not flash “Connection lost” all morning. | Small |
| **Studio Clock: optional service elapsed** | Portal promised it; Live Mode already has `totalElapsed`. One extra line under the wall clock when `is_live`. | Small |
| **Fix sibling production-display URLs** (teleprompter / confidence) | Same class of bug as Studio Clock. Operators will distrust the whole share suite. | Small |
| **Portal cookie auth or drop `clock-layouts`** | Layouts API is church-app-only and unused. Either delete it, or accept portal sessions and actually call it from the clock. Half-built persistence is worse than localStorage-only. | Small to delete; medium to wire |

### P2 — nice-to-have (do not start until P0/P1)

| Item | Why | Effort |
|------|-----|--------|
| Companion `clock_state` broadcast | Only useful after there is one canonical live clock state on the relay. | Medium |
| Named shareable layout URLs (`/tools/clock/d/:id`) | Multi-campus / spare laptop. Requires working `clock-layouts` + a public read token. | Medium |
| OpenAPI entries for `/api/time` and clock-layouts | Docs completeness only. | Small |
| Favicon file for `/tools/clock/favicon.png` | Cosmetic 404. | Small |
| Tests for `handleClockWsConnection` + theme/reconnect | Reliability net for the rundown path. | Small |
| Remove ATEM School / quote form from the booth bundle | Splits attention; pulls Supabase into a Sunday tool. | Medium (rebuild) |

---

## 6. Suggested next build (if picking one)

**Make Studio Clock the Sunday clock, and make the free clock honest.**

1. Ship this PR (share URL + layouts API correctness).  
2. Rebuild the SPA so time sync hits `/api/time` and `/tools/clock/` is the clock, not a quote page.  
3. Add a rundown-token cell/mode so a booth can put “cue remaining” next to “wall clock” without opening a second product.  
4. Hide device modes until a Tally connection exists.

That is cohesion and reliability, not feature sprawl.

---

## Appendix — file map

| Path | Role |
|------|------|
| `relay-server/public/tools/clock/` | Built Production Clock SPA (no source here) |
| `relay-server/public/tools/multi-clock/index.html` | Redirect into unified SPA |
| `relay-server/public/rundown-clock.html` | Rundown Studio Clock display |
| `relay-server/public/tools/rundown-timer-client.js` | Unused-by-clock helper for timer WS |
| `relay-server/src/routes/clockLayouts.js` | Church-app layout CRUD |
| `relay-server/src/routes/time.js` | `GET /api/time` |
| `relay-server/src/routes/liveRundown.js` | Share URLs including `clock_url` |
| `relay-server/server.js` | `/clock` redirect, `/rundown/clock/:token`, `handleClockWsConnection`, SPA fallback |
| `relay-server/public/portal/portal.js` | Share output suite |
| `relay-server/src/broadcastMonitor.js` | Unrelated YT/FB health |
| `companion-module-tallyconnect/src/main.ts` | Unused `clock_state` listener |
