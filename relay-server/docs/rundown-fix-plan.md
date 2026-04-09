# TallyConnect Rundown System: Phased Implementation Plan

**Generated:** 2026-04-09
**Source audits:**

| Audit | Abbreviation | File |
|-------|-------------|------|
| Solo Worship Leader | **SWL** | `audit-solo-worship-leader.md` |
| Large-Church Technical Director | **TD** | `audit-large-church-td.md` |
| Volunteer AV Operator | **VOL** | `audit-volunteer-operator.md` |
| Pastor / Speaker | **PAS** | `audit-pastor-speaker.md` |
| Remote Campus Producer | **RCP** | `audit-remote-campus-producer.md` |

**Persona key:** When a fix lists multiple audit sources, it means the finding appeared independently in each audit. Cross-cutting fixes are consolidated into a single task.

---

## Phase 1: Quick Wins — Cross-Cutting Polish

**Theme:** Low-effort fixes that immediately improve the experience for the most user types. No architectural changes. Mostly UI tweaks and small additions.

**Estimated duration:** 1-2 sprints
**Dependencies:** None
**Benefits:** All 5 personas

### 1.1 One-click "Share / Copy Link" button on portal editor

- **Effort:** Small
- **Source:** SWL (sharing flow is 5-7 steps), VOL (portal share UX for volunteers)
- **What:** Add a prominent "Share" button in the rundown editor toolbar that copies the public view URL to clipboard in one click. Replace the current flow of Outputs > find URL > copy.
- **Benefits:** SWL, VOL, PAS, TD

### 1.2 Show toolbar at full opacity on first load

- **Effort:** Small
- **Source:** SWL (timer toolbar invisible), SWL (public view toolbar invisible), VOL (display toolbar labels are cryptic), PAS (stage mode poorly discoverable)
- **What:** On `rundown-timer.html` and `rundown-view.html`, render the display toolbar at full opacity for 10 seconds after page load, then fade to the current 40% opacity. Add a visible gear/settings icon as a persistent anchor.
- **Benefits:** SWL, VOL, PAS

### 1.3 Prominent connection-lost banner

- **Effort:** Small
- **Source:** SWL (WebSocket status too subtle), SWL (offline resilience — connection drop warning)
- **What:** When the polling or WebSocket connection fails, display a full-width top banner: "Connection lost — reconnecting..." in red/orange. Replace the current tiny colored dot. Apply to `rundown-timer.html`, `rundown-show.html`, and `rundown-view.html`.
- **Benefits:** SWL, VOL, PAS, RCP

### 1.4 Implement Screen Wake Lock API

- **Effort:** Small
- **Source:** SWL (screen dims during service), SWL (timer view no wake lock)
- **What:** Call `navigator.wakeLock.request('screen')` on `rundown-timer.html` and `rundown-show.html` when a live show is active. Release on show end. Include a `visibilitychange` listener to re-acquire when the tab becomes visible again.
- **Benefits:** SWL, VOL, PAS

### 1.5 Native time picker for hard starts

- **Effort:** Small
- **Source:** SWL (24-hour raw text input)
- **What:** Replace the `<input type="text">` for hard start times with `<input type="time">` (native 12-hour AM/PM picker on mobile). Add a one-line explanation: "This item must start at exactly this time."
- **Benefits:** SWL, TD

### 1.6 Add remaining-time countdown to live banner in public view

- **Effort:** Small
- **Source:** PAS (no countdown in public view), PAS (prompter hero shows duration, not remaining)
- **What:** In `rundown-view.html`, compute `remaining = lengthSeconds - elapsedSeconds` and display it in the live banner alongside elapsed time. Add a `setInterval` tick-down in prompter mode so the hero shows a live countdown.
- **Benefits:** PAS, SWL, VOL

### 1.7 Add green/yellow/red time indicators to public view live banner

- **Effort:** Small
- **Source:** PAS (no color-coded time warnings on public view)
- **What:** Apply the same color thresholds used in `rundown-timer.html` (green > yellow at ≤120s > red at ≤30s) to the live banner in `rundown-view.html`. Change the banner's accent color as time runs out.
- **Benefits:** PAS, VOL

### 1.8 Replace browser `confirm()` with styled modals

- **Effort:** Small
- **Source:** SWL (End Show uses native confirm dialog)
- **What:** Replace all `confirm()` calls in `rundown-show.html` (End Show, possibly others) with the same bottom-sheet modal pattern used elsewhere in the app.
- **Benefits:** SWL, VOL, TD

### 1.9 Allow pinch-zoom on show mode and timer

- **Effort:** Small
- **Source:** SWL (pinch-zoom disabled via `user-scalable=no`)
- **What:** Remove `user-scalable=no` from the viewport meta tag on `rundown-show.html` and `rundown-timer.html`. Test that layout doesn't break with zoom.
- **Benefits:** SWL, PAS

### 1.10 Add room label to show mode and public view headers

- **Effort:** Small
- **Source:** RCP (no room identification in show mode or public view)
- **What:** Include the plan's `roomId` (room name) in the header bar of `rundown-show.html` and `rundown-view.html` so users can identify which campus/room they're viewing.
- **Benefits:** RCP, TD

---

## Phase 2: Read-Only Show Mode and Sharing Improvements

**Theme:** Fix the dangerous "anyone with a show link can control the service" problem, and make sharing department-specific links practical.

**Estimated duration:** 1-2 sprints
**Dependencies:** None (can run in parallel with Phase 1)
**Benefits:** VOL, PAS, SWL, TD

### 2.1 Read-only show mode (`?readonly=1`)

- **Effort:** Medium
- **Source:** VOL (show mode exposes full cue control to anyone), PAS (operator controls exposed to viewers), PAS (keyboard shortcuts advance the show)
- **What:** Add a `?readonly=1` URL parameter to `rundown-show.html`. When active: hide GO/Back/Start/Stop/End buttons, disable keyboard shortcuts that advance cues, disable double-click inline editing. Keep the live-following cue list, countdown timer, and Next Up panel. Generate this URL variant in the portal share modal.
- **Benefits:** VOL, PAS, SWL

### 2.2 "Share with Volunteer" flow in portal

- **Effort:** Medium
- **Source:** VOL (portal share UX gaps), SWL (sharing flow too complex)
- **What:** In the Outputs/Share modal, add a "Share with Team" section that: (a) lists each custom column with a "Copy Link" button generating a filtered URL, (b) includes pre-written text message templates ("Hey [Name], here's your rundown for Sunday: [link]"), (c) renames "Column feeds" to "Department / Volunteer Links" with clearer descriptions.
- **Benefits:** VOL, TD, SWL

### 2.3 Rename "Outputs" to "Share" in portal toolbar

- **Effort:** Small
- **Source:** SWL (label "Outputs" is opaque)
- **What:** Rename the portal toolbar button from "Outputs" to "Share & Outputs" or just "Share." Keep the full modal content but lead with the share links.
- **Benefits:** SWL, VOL, TD

### 2.4 Hide operator-specific badges in public view

- **Effort:** Small
- **Source:** SWL (Hard Start/Auto badges confuse pastors)
- **What:** In `rundown-view.html`, hide "Hard start" pills and "Auto" badges by default. Show them only in a "Detailed" or "Operator" toggle, or when accessed with a `?detail=1` parameter.
- **Benefits:** SWL, PAS, VOL

### 2.5 Mirror mode confirmation

- **Effort:** Small
- **Source:** SWL (mirror mode is mystifying)
- **What:** When the Mirror button is clicked, show a brief tooltip or confirmation: "Mirror mode flips the display for teleprompter glass. Enable?" Or move Mirror behind a settings/gear submenu.
- **Benefits:** SWL, PAS, VOL

---

## Phase 3: Mobile and Responsive Layout Overhaul

**Theme:** Make the system work well on phones and tablets — the primary devices for worship leaders, pastors, and volunteer operators at their stations.

**Estimated duration:** 2-3 sprints
**Dependencies:** Phase 1 (toolbar visibility fixes feed into responsive work)
**Benefits:** SWL, VOL, PAS

### 3.1 Mobile card layout for portal rundown items

- **Effort:** Large
- **Source:** SWL (8+ column table requires horizontal scroll on phone), SWL (no mobile-optimized card layout)
- **What:** Below 768px, render rundown items as stacked cards instead of table rows. Each card shows: title, type badge, duration, and an expand toggle for notes/assignee/custom columns. Preserve inline editing via tap-to-edit on the card.
- **Benefits:** SWL, VOL

### 3.2 Collapse portal toolbar to overflow menu

- **Effort:** Medium
- **Source:** SWL (9 action buttons in toolbar)
- **What:** On screens below 768px, collapse secondary toolbar actions (Status, Team, Outputs, Edit, Save as Template, Delete) into a "..." overflow menu. Keep only the 3 primary actions visible: Show Mode, Share (new), and one contextual action.
- **Benefits:** SWL

### 3.3 Tablet breakpoint (768px) for public view

- **Effort:** Medium
- **Source:** VOL (only one breakpoint at 600px, no tablet layout), VOL (touch targets too small)
- **What:** Add a 768px responsive breakpoint to `rundown-view.html`. At this width: hide Start/End time columns in Full mode, increase mode-switcher button touch targets (minimum 44px), increase toolbar button sizes.
- **Benefits:** VOL, PAS, SWL

### 3.4 Default to Prompter mode on small screens

- **Effort:** Small
- **Source:** VOL (Prompter is best mobile experience but not suggested), PAS (full table view not phone-friendly)
- **What:** On screens under 768px, auto-select Prompter mode for `rundown-view.html` unless the user has explicitly chosen another mode (store preference in localStorage).
- **Benefits:** VOL, PAS, SWL

### 3.5 Landscape tablet layout for show mode

- **Effort:** Medium
- **Source:** SWL (no landscape-optimized layout for tablets on music stands)
- **What:** Add a landscape breakpoint for tablets (1024px width, landscape orientation). In this layout: show the cue list on the left 60%, and a persistent "current cue + notes + timer" panel on the right 40%.
- **Benefits:** SWL, VOL

### 3.6 Improve GO/Back button layout on mobile show mode

- **Effort:** Small
- **Source:** SWL (GO and Back are side-by-side, easy to mis-tap on phone)
- **What:** On screens below 600px, stack the GO button above the Back button (or increase spacing significantly) to prevent accidental taps. Make GO substantially larger than Back.
- **Benefits:** SWL, VOL

### 3.7 Compact status bar on narrow screens

- **Effort:** Small
- **Source:** SWL (status bar pills are small and tightly packed)
- **What:** On narrow viewports, reduce the status bar to show only the most critical info (current cue number, remaining time) and put secondary stats behind a tap-to-expand.
- **Benefits:** SWL, VOL

---

## Phase 4: Terminology, Onboarding, and Simplified Mode

**Theme:** Reduce the learning curve for non-technical users — worship leaders, pastors, and volunteers — through terminology changes, guided onboarding, and a "simple mode" that hides pro features.

**Estimated duration:** 2-3 sprints
**Dependencies:** Phase 2 (sharing improvements inform onboarding copy)
**Benefits:** SWL, VOL, PAS

### 4.1 Rename terminology to church vocabulary

- **Effort:** Medium
- **Source:** SWL (full terminology mismatch table — Cue→Item, Outputs→Share, Show Mode→Live Mode, etc.), VOL (Hard/Soft/Auto badges opaque to volunteers), PAS (no explanation of production terms)
- **What:** Implement a terminology mapping across all pages:

  | Current term | New term |
  |---|---|
  | Cue | Item |
  | Rundown | Service Plan (or keep "Rundown" but add subtitle "Service Plan") |
  | Show Mode | Live Mode |
  | Outputs | Share |
  | Station | Device |
  | Hard Start | Fixed Time |
  | Soft Start | Flexible |
  | Prompter | Large Text |
  | Stage (mode) | Detailed |
  | Confidence Monitor | Stage Display |
  | Demo Set | (remove or rename to "Sample Setup") |

- **Benefits:** SWL, VOL, PAS

### 4.2 First-run onboarding flow (portal)

- **Effort:** Medium
- **Source:** SWL (no guided setup), VOL (no onboarding for new users)
- **What:** On first visit (no plans exist), show a welcome overlay: "Welcome to TallyConnect! Let's create your first service plan." Guide the user through: (1) create a plan with name + date, (2) add 3-4 items, (3) share the link. Dismissible, with a "skip" option. Store completion in localStorage.
- **Benefits:** SWL, VOL

### 4.3 First-visit orientation banner on public view

- **Effort:** Small
- **Source:** VOL (no onboarding on public view), PAS (no orientation for pastors)
- **What:** On first visit to `rundown-view.html`, show a dismissible banner: "You're viewing the service plan for [Title]. The current item is highlighted in green. [Choose your view: Full Detail | Summary | Large Text]"
- **Benefits:** VOL, PAS, SWL

### 4.4 Glossary tooltips on badges and column headers

- **Effort:** Small
- **Source:** VOL (display toolbar labels cryptic), VOL (glossary tooltips recommended), SWL (12 item types without guidance)
- **What:** Add `title` attributes and info-icon hover/tap tooltips explaining: item type badges, "Fixed Time" / "Flexible" / "Auto" pills, column header abbreviations, and mode switcher options. On mobile, tapping the info icon shows a popover.
- **Benefits:** VOL, PAS, SWL

### 4.5 Simplified "Simple Mode" for portal

- **Effort:** Large
- **Source:** SWL (no worship leader mode / simplified view), SWL (system presents same complexity to all users)
- **What:** Add a toggle (room-level or account-level) for "Simple Mode" that hides: status lifecycle (auto-manage draft→live→archived), team/station management, custom columns, batch operations, hard starts, auto-advance, and the full Outputs modal. Simple mode shows: create plan, add items (title + type + duration + notes), share link, start live, timer view. Advanced features accessible via an "Advanced" toggle.
- **Benefits:** SWL

### 4.6 Reduce item types from 12 to sensible defaults

- **Effort:** Small
- **Source:** SWL (12 types without guidance, Song vs. Worship unclear)
- **What:** Consolidate or rename types: merge "Song/Worship" into "Song", merge "Sermon/Message" into "Message", keep Prayer, Announcement, Media, Transition, Offering, Communion, Scripture, Section Header, and Other. Add short one-line descriptions in the dropdown. Show the 6 most common first, then "More..." for the rest.
- **Benefits:** SWL, VOL

### 4.7 Auto-manage plan status lifecycle

- **Effort:** Small
- **Source:** SWL (5 status states confuse solo users, plans left as Draft forever)
- **What:** Auto-transition statuses based on actions: Draft (on create) → Live (when show starts) → Archived (24 hours after show ends or when a new plan is created for the same room+date). Keep manual status control available in Advanced/Simple mode toggle, but make it automatic by default.
- **Benefits:** SWL

### 4.8 Plain text notes by default, rich text opt-in

- **Effort:** Small
- **Source:** SWL (rich text editor overkill for simple notes)
- **What:** Default the notes field to a plain `<textarea>`. Add a "Format" toggle that switches to the rich text contentEditable editor. Preserve existing rich content when switching modes.
- **Benefits:** SWL

---

## Phase 5: Department Filtering and "My Next Cue"

**Theme:** Let volunteers and pastors see only what's relevant to them — the single biggest gap for multi-department churches.

**Estimated duration:** 2 sprints
**Dependencies:** Phase 2 (share flow generates filtered links)
**Benefits:** VOL, PAS, TD

### 5.1 Row-level department filtering (`&hideEmpty=1`)

- **Effort:** Medium
- **Source:** VOL (critical: no row-level department filtering), VOL (column filter is URL-only, not interactive)
- **What:** Extend the `?columns=` URL parameter with an `&hideEmpty=1` flag. When active, rows where the filtered column(s) have no value are either hidden entirely or shown at 50% opacity with a "Show all / Show mine" toggle. Display a count badge: "Showing 8 of 23 items."
- **Benefits:** VOL, TD

### 5.2 Interactive column/department picker in public view

- **Effort:** Medium
- **Source:** VOL (column filter requires URL parameters, not discoverable)
- **What:** Add a dropdown or filter bar at the top of `rundown-view.html` listing all custom columns. Selecting a column activates the column filter + hideEmpty behavior without requiring URL manipulation.
- **Benefits:** VOL, TD

### 5.3 "My Next Cue" floating indicator

- **Effort:** Medium
- **Source:** VOL (critical: no "what's next for me" indicator), PAS (no way to filter to "my segments")
- **What:** When a column filter is active and the show is live, compute the next cue where that column has a value. Display it in a sticky floating card at the bottom of the viewport: "Your next: [Title] — in ~[X] minutes." Persist across scroll positions.
- **Benefits:** VOL, PAS

### 5.4 Assignee filter (`?assignee=`)

- **Effort:** Medium
- **Source:** PAS (cannot filter to "my segments"), PAS (speaker sees full 20+ item rundown)
- **What:** Add an `?assignee=Name` URL parameter to `rundown-view.html`. When active, highlight rows assigned to that person and de-emphasize others. Combine with the "My Next Cue" indicator to show "You're up next in ~5 minutes."
- **Benefits:** PAS

### 5.5 Department context on timer/stage mode

- **Effort:** Medium
- **Source:** VOL (timer has no department context), PAS (no notes on confidence monitor)
- **What:** When the timer URL includes a column filter parameter, show that column's value for the current cue below the cue title in stage mode. Example: "CUE: Worship Set — GRAPHICS: Lyrics slide 1."
- **Benefits:** VOL, PAS

---

## Phase 6: WebSocket Migration for Live Views

**Theme:** Replace HTTP polling with WebSocket push across all live-facing views. The timer page already uses WebSocket; extend this to show mode and public view.

**Estimated duration:** 2-3 sprints
**Dependencies:** None (can start in parallel with earlier phases, but should land before Phase 8)
**Benefits:** All 5 personas

### 6.1 WebSocket transport for show mode (`rundown-show.html`)

- **Effort:** Large
- **Source:** TD (1.5s polling latency unacceptable for production), RCP (1.5s polling borderline for tight transitions), PAS (polling-based show mode), VOL (polling inconsistency across views)
- **What:** Replace the `setInterval(pollLiveState, 1500)` in show mode with WebSocket subscription to the live session. Use the same WebSocket infrastructure as the timer page. Fall back to 1.5s polling if WebSocket fails.
- **Benefits:** TD, RCP, VOL, PAS

### 6.2 WebSocket transport for public view (`rundown-view.html`)

- **Effort:** Large
- **Source:** VOL (30s polling in Full mode is unusable for live), PAS (30s poll means stale data), RCP (30s polling unusable for coordination)
- **What:** Replace polling in `rundown-view.html` with WebSocket for live state updates. Eliminate the 30s/5s poll interval distinction. Fall back to polling only when WebSocket is unavailable.
- **Benefits:** VOL, PAS, SWL, RCP

### 6.3 Cue-change visual/audio notification

- **Effort:** Medium
- **Source:** VOL (no alert when cue approaches), PAS ("you're on next" notification), RCP (no notification when main campus advances cue)
- **What:** Add an optional notification system triggered by WebSocket cue-change events. Options: browser Notification API, screen flash/pulse, or audio chime. Configurable via a "Notify me" toggle in the view toolbar. When a department filter is active, only fire notifications for cues relevant to that department.
- **Benefits:** VOL, PAS, RCP

### 6.4 Server-provided sync timestamp for cross-campus accuracy

- **Effort:** Small
- **Source:** RCP (client-side timer interpolation causes clock drift between campuses)
- **What:** Include a server timestamp in every WebSocket tick and poll response. Clients compute local offset and correct timer display accordingly. Eliminates inter-campus drift.
- **Benefits:** RCP, TD

---

## Phase 7: Light/Dark Theme and Print Support

**Theme:** Visual accessibility — let users choose themes appropriate to their environment, and support paper-based workflows.

**Estimated duration:** 1-2 sprints
**Dependencies:** Phase 3 (responsive layout work should land first)
**Benefits:** SWL, PAS, VOL

### 7.1 Light theme toggle on public view and show mode

- **Effort:** Medium
- **Source:** SWL (dark theme only, hard to read in bright sanctuary), VOL (dark theme only on public views), PAS (no dark/light toggle on public view)
- **What:** Port the light theme toggle from `rundown-timer.html` to `rundown-view.html` and `rundown-show.html`. Use `prefers-color-scheme` media query to auto-detect system preference. Default public view to light theme. Store preference in localStorage.
- **Benefits:** SWL, PAS, VOL

### 7.2 Rename view modes to plain language

- **Effort:** Small
- **Source:** SWL (Prompter/Stage are production terms), SWL (too many display modes confuse pastors)
- **What:** Rename across all pages: "Prompter" → "Large Text", "Stage" → "Detailed", "Full" → "Full Detail", "Compact" → "Summary". Keep old names as URL parameter aliases for backward compatibility.
- **Benefits:** SWL, PAS, VOL

### 7.3 Print stylesheet / PDF export for public view

- **Effort:** Medium
- **Source:** SWL (no print/PDF export)
- **What:** Add a `@media print` stylesheet to `rundown-view.html` that: switches to light theme, hides toolbar/header/mode-switcher, formats items as a clean numbered list with title, type, duration, and notes. Add a "Print / Save PDF" button in the toolbar that triggers `window.print()`.
- **Benefits:** SWL, PAS

---

## Phase 8: Multi-Room Live Sessions (Architecture)

**Theme:** Remove the single-live-session-per-church constraint. This is the critical architectural change for multi-campus churches.

**Estimated duration:** 3-4 sprints
**Dependencies:** Phase 6 (WebSocket migration should land first so room-scoped broadcasts work)
**Benefits:** RCP, TD

### 8.1 Room-scoped live sessions

- **Effort:** Large
- **Source:** RCP (P0: only one live session per church — the single biggest blocker), TD (multi-room control needed)
- **What:** Change the live session key in `liveRundown.js` from `churchId` to `churchId:roomId`. Allow each room to have an independent live session with its own cue position, timers, and state. The database already supports this (per-plan `rundown_live_state` rows) — the bottleneck is the API/session layer.
- **Scope:** `liveRundown.js` session management, portal `_rundownState` from single object to map keyed by `roomId`, WebSocket broadcast changes.
- **Benefits:** RCP, TD

### 8.2 Room-scoped WebSocket channels

- **Effort:** Medium
- **Source:** RCP (P1: all portal users receive all broadcasts regardless of room)
- **What:** Change `broadcastToChurch(churchId, msg)` to `broadcastToRoom(churchId, roomId, msg)`. Allow clients to subscribe to specific rooms. A remote campus producer subscribes to their room's channel plus optionally the main room's channel.
- **Benefits:** RCP, TD

### 8.3 Room-scoped API filtering

- **Effort:** Medium
- **Source:** RCP (P2: API returns all plans regardless of room), RCP (room filter is client-side only)
- **What:** Add `?roomId=X` query parameter to `GET /api/churches/{churchId}/rundown-plans`. Return only plans for the specified room. Add server-side room-based access control for write operations.
- **Benefits:** RCP, TD

### 8.4 Room-level access control

- **Effort:** Medium
- **Source:** TD (no room-level permissions), RCP (any user can edit any room's plans), RCP (device command cross-contamination risk)
- **What:** Add room-scoped permissions so that editors can be restricted to specific rooms. A youth director can only edit youth room plans; a campus B producer can only control campus B's live session. Prevent device command execution across room boundaries.
- **Benefits:** TD, RCP

### 8.5 Template room inheritance

- **Effort:** Small
- **Source:** RCP (duplicating a template resets room_id to empty)
- **What:** When creating a plan from a template, preserve the template's `room_id` by default (with an option to change). Allow templates to be scoped to a room.
- **Benefits:** RCP, TD

---

## Phase 9: Collaboration and Rehearsal Workflow

**Theme:** Make real-time collaboration robust for large teams and add rehearsal-specific features.

**Estimated duration:** 3-4 sprints
**Dependencies:** Phase 6 (WebSocket migration), Phase 8 (room-scoped sessions)
**Benefits:** TD, VOL

### 9.1 Cell-level edit conflict detection

- **Effort:** Large
- **Source:** TD (P0: two editors modify same item, last write wins silently)
- **What:** Track which item is being edited by which station. When a user starts editing an item, broadcast a lock/editing indicator. If another user tries to edit the same item, show a warning: "This item is being edited by [Station Name]." At minimum, show a "modified by someone else" toast if the item changes while being edited.
- **Benefits:** TD, VOL

### 9.2 Edit history with undo

- **Effort:** Large
- **Source:** TD (P2: no recovery from accidental deletes or overwrites)
- **What:** Store item-level revision history (last N changes per item). Provide plan-level undo/redo (Ctrl+Z/Cmd+Z). Show a revision history panel with diff view and one-click revert.
- **Benefits:** TD

### 9.3 Plan locking ("Lock for Show")

- **Effort:** Medium
- **Source:** TD (P2: prevent editors from modifying plan during live), VOL (security concern — show mode exposes editing)
- **What:** Add a "Lock for Show" toggle in the portal editor. When locked: editors become viewers (read-only), only the owner/TD can unlock. Auto-lock when show goes live, auto-unlock when show ends. Show a visual "locked" indicator.
- **Benefits:** TD, VOL

### 9.4 Rehearsal run mode

- **Effort:** Large
- **Source:** TD (P1: no rehearsal-specific features), TD (rehearsal status is just a label)
- **What:** Add a "Rehearsal" button alongside "Start Show" in the portal. Rehearsal mode: tracks timing per item (actual vs. planned), stores run-through results, does NOT mark the session as "live" for public views, allows multiple run-throughs with comparison. After rehearsal, show a summary: items that ran over/under, total variance.
- **Benefits:** TD

### 9.5 Post-show timing report

- **Effort:** Medium
- **Source:** TD (P1: no show report or post-service summary)
- **What:** After a live show ends, generate a summary: planned vs. actual duration per item, total over/under time, items that ran overtime, overall service duration. Persist in the plan record. Export as PDF or shareable link.
- **Benefits:** TD, SWL

### 9.6 Director notes (private notes field)

- **Effort:** Small
- **Source:** TD (P2: no private TD notes separate from public notes)
- **What:** Add a separate "Director Notes" field per item, visible only to owner/editor roles. Hidden on public views, timer, and share links. Shown in the portal editor and show mode (for operators).
- **Benefits:** TD

---

## Phase 10: Advanced Cueing and Production Features

**Theme:** Professional production features that differentiate TallyConnect for large-church technical directors.

**Estimated duration:** 3-4 sprints
**Dependencies:** Phase 8 (room-scoped sessions), Phase 9 (collaboration)
**Benefits:** TD, RCP

### 10.1 Cue stacks / nested items

- **Effort:** Large
- **Source:** TD (P1: all items are flat, no parent/child grouping)
- **What:** Allow grouping items under a parent. Example: "Worship Set" contains "Song 1", "Song 2", "Song 3." The parent shows aggregate duration; children advance independently. GO on the parent enters the stack; GO within the stack advances to the next child; GO on the last child exits the stack. Render with indentation and collapse/expand.
- **Benefits:** TD

### 10.2 Column grouping by department with collapse/expand

- **Effort:** Medium
- **Source:** TD (P1: 6+ department columns make table too wide)
- **What:** Allow columns to be grouped by department tag. Each group has a collapse/expand toggle. When collapsed, the group shows as a single summary column. Preserves through templates.
- **Benefits:** TD

### 10.3 Column-level edit permissions

- **Effort:** Medium
- **Source:** TD (audio engineer shouldn't edit lighting cues)
- **What:** Allow column-level permissions tied to collaborator roles. An editor can be restricted to editing only specific columns. Changes to other columns are read-only for them.
- **Benefits:** TD

### 10.4 Conditional formatting / validation on columns

- **Effort:** Medium
- **Source:** TD (no way to flag empty cells or highlight conflicts)
- **What:** Add simple rules: "Highlight if empty", "Highlight if value is X." Show a visual indicator (red border, warning icon) on cells that need attention. Summary count in the toolbar: "3 items need attention."
- **Benefits:** TD

### 10.5 Standby/blackout cue types

- **Effort:** Small
- **Source:** TD (no standby or blackout cue types)
- **What:** Add "Standby" and "Blackout" as item types. These render distinctly in show mode (grey bar for standby, black bar for blackout) and don't show on public views unless in detailed mode.
- **Benefits:** TD

### 10.6 Cue preview/preload

- **Effort:** Medium
- **Source:** TD (can't "arm" or preview the next cue before pressing GO)
- **What:** Show a preview panel for the next cue's equipment changes (ATEM input switch, ProPresenter slide, Companion actions) before GO is pressed. Allow the TD to "arm" the next cue without firing it.
- **Benefits:** TD

---

## Phase 11: Multi-Campus Coordination Features

**Theme:** Purpose-built features for remote campus producers coordinating with main campus.

**Estimated duration:** 2-3 sprints
**Dependencies:** Phase 8 (room-scoped live sessions), Phase 6 (WebSocket migration)
**Benefits:** RCP, TD

### 11.1 "Follow Room" mode for public views

- **Effort:** Medium
- **Source:** RCP (P1: no way to follow a specific room's live state)
- **What:** Add a `?follow=ROOM_ID` URL parameter to `rundown-view.html` and `rundown-show.html`. When active, the view subscribes to the specified room's live state via WebSocket, showing that room's current cue and timing regardless of which plan the URL was generated from.
- **Benefits:** RCP

### 11.2 Split-screen / dual-rundown monitor

- **Effort:** Large
- **Source:** RCP (P2: producer must juggle two browser tabs)
- **What:** Build a "Multi-Campus Monitor" view (`rundown-multicampus.html`) showing two or more rooms side by side. Each panel shows: room name, current cue, countdown timer, next cue. Clicking a panel expands it to full detail. Link from the portal's room management section.
- **Benefits:** RCP, TD

### 11.3 Cross-room timing sync

- **Effort:** Medium
- **Source:** TD (no "follow main room" or "sync to room X" feature)
- **What:** Add a "Sync to Room" option on a plan. When enabled, the plan's live session automatically mirrors cue advances from the synced room with a configurable delay (0-10 seconds). Useful for overflow rooms and satellite campuses showing the same content.
- **Benefits:** RCP, TD

### 11.4 Cross-room ready-check / status system

- **Effort:** Medium
- **Source:** TD (P3: no standby/ready check across departments), RCP (P3: no way to signal readiness back to main campus)
- **What:** Add a lightweight status system where each room can signal "Ready" / "Standby" / "Issue" visible to the main campus TD. Display as colored dots on the multi-room dashboard. Optional per-department ready check within a room.
- **Benefits:** RCP, TD

---

## Phase 12: Offline Resilience and Performance

**Theme:** Make the system work when church WiFi is unreliable, and improve load performance.

**Estimated duration:** 2-3 sprints
**Dependencies:** Phase 6 (WebSocket migration enables better reconnection logic)
**Benefits:** SWL, VOL, PAS

### 12.1 Cache rundown in localStorage / Service Worker

- **Effort:** Large
- **Source:** SWL (no offline resilience — WiFi drop kills everything)
- **What:** On first load of any view, cache the full rundown data in localStorage. Register a Service Worker that serves the cached rundown if the network is unavailable. Run timers locally from cached data. Show a persistent banner: "Offline — running from cached data" when the connection drops.
- **Benefits:** SWL, VOL, PAS

### 12.2 Optimistic updates for portal editing

- **Effort:** Medium
- **Source:** TD (no offline support during collaborative editing)
- **What:** When editing items in the portal, apply changes optimistically to the local state before the server confirms. Queue failed writes and retry when connection resumes. Show a "saving..." indicator during sync and a "saved" confirmation.
- **Benefits:** TD, SWL

### 12.3 Estimated start times that update live

- **Effort:** Medium
- **Source:** PAS (estimated start times based on static 9:00 AM, don't update during live)
- **What:** During a live show, recalculate the estimated start time for each future item based on the current cue's actual elapsed time plus the remaining items' planned durations. Update these in real-time on the public view and show mode.
- **Benefits:** PAS, TD, VOL

---

## Phase 13: New Features and Differentiation

**Theme:** Net-new capabilities that expand TallyConnect's value beyond what competitors offer.

**Estimated duration:** 4-6 sprints (can be broken into sub-phases)
**Dependencies:** Phases 8-10 (architecture must be solid first)
**Benefits:** TD, RCP, SWL

### 13.1 Speaker/pastor dedicated page (`/rundown/speaker/:token`)

- **Effort:** Large
- **Source:** PAS (P2: no speaker-specific countdown page)
- **What:** Build a new page designed for speakers: large countdown for the current segment, speaker's notes displayed prominently, "You're up next in X minutes" preview, filtered to show only segments assigned to the speaker. URL format: `/rundown/speaker/:token?person=PastorName`.
- **Benefits:** PAS

### 13.2 "Auto-pilot" mode for show mode

- **Effort:** Medium
- **Source:** SWL (show mode requires active operator; solo leader can't tap between songs)
- **What:** Add an "Auto-Pilot" toggle to show mode. When enabled, items auto-advance based on their duration timers with no operator input needed. Show mode becomes a monitoring view. The operator can still override with manual GO/Back if needed. Visual indicator: "Auto-Pilot: ON."
- **Benefits:** SWL

### 13.3 Notes on timer page (stage/confidence mode)

- **Effort:** Medium
- **Source:** PAS (high: timer/confidence monitor shows no notes at all)
- **What:** Include the current cue's notes in the WebSocket/API payload sent to the timer page. Render notes below the cue title in stage mode, with text scaling to fit. Allow toggling notes on/off.
- **Benefits:** PAS

### 13.4 Recurring plan automation

- **Effort:** Medium
- **Source:** TD (P3: TD manually duplicates or creates from template each week)
- **What:** Add a "Recurring" option to templates. When enabled, auto-create a new plan from the template on a configurable schedule (e.g., every Monday at 9am for the coming Sunday). The TD finds a pre-populated plan ready to customize each week.
- **Benefits:** TD, SWL

### 13.5 Template categories / folders

- **Effort:** Small
- **Source:** TD (P2: 20+ templates listed flat)
- **What:** Add categories or folders for templates: "Sunday AM", "Midweek", "Special Events", etc. Allow drag-to-categorize and filtering by category.
- **Benefits:** TD

### 13.6 Room-specific equipment presets

- **Effort:** Medium
- **Source:** TD (P2: each room has different equipment but bindings are per-plan)
- **What:** Define equipment configurations per room (which ATEM, which encoder, etc.). When creating a plan for a room, auto-populate equipment-bound columns with that room's known devices.
- **Benefits:** TD, RCP

### 13.7 @Mentions and in-app notifications

- **Effort:** Large
- **Source:** TD (no notifications or @mentions in the rundown)
- **What:** Allow collaborators to @mention other collaborators in item notes. Mentioned users see a notification badge in the portal. Optional push notification via browser Notification API.
- **Benefits:** TD

### 13.8 Volunteer scheduling basics

- **Effort:** Large
- **Source:** TD (P3: major gap vs PCO Services — no accept/decline, availability, notifications)
- **What:** Add ability to assign team members to plan items with accept/decline workflow. Send email/SMS notifications for assignments. Track availability and blockout dates. This is a large feature that brings TallyConnect closer to PCO Services parity.
- **Benefits:** TD

### 13.9 Song/media library integration

- **Effort:** Large
- **Source:** TD (PCO comparison: no integrated song database)
- **What:** Create a reusable library of songs, media, and recurring items. When adding an item to a plan, search the library to auto-fill title, duration, type, and notes. Track usage history.
- **Benefits:** TD, SWL

### 13.10 Reporting and analytics

- **Effort:** Large
- **Source:** TD (PCO comparison: no reporting or analytics)
- **What:** Service time reports (planned vs. actual per week), team participation stats, most-used items, and trend analysis. Dashboard in the portal with exportable charts.
- **Benefits:** TD

---

## Cross-Reference: Findings by Audit Source

Every finding from every audit appears in the plan above. This table maps each audit's recommendations to their phase and task.

### Solo Worship Leader (SWL)

| Finding | Phase.Task |
|---------|-----------|
| One-click Share / Copy Link button | 1.1 |
| Timer toolbar invisible (40% opacity) | 1.2 |
| Public view toolbar invisible | 1.2 |
| Connection-lost banner (WebSocket status too subtle) | 1.3 |
| Screen wake lock missing | 1.4 |
| Native time picker for hard starts | 1.5 |
| Browser confirm() → styled modals | 1.8 |
| Pinch-zoom disabled | 1.9 |
| Mobile card layout for rundown items | 3.1 |
| Collapse toolbar to overflow menu (9 buttons) | 3.2 |
| GO/Back button layout on mobile | 3.6 |
| Status bar pills on narrow screens | 3.7 |
| Terminology mismatch (full table) | 4.1 |
| No onboarding / guided setup | 4.2 |
| 12 item types without guidance | 4.6 |
| Status lifecycle confusing (5 states) | 4.7 |
| Rich text notes overkill | 4.8 |
| "Auto-pilot" mode for solo operator | 13.2 |
| Hide operator badges in public view | 2.4 |
| Mirror mode mystifying | 2.5 |
| Too many display modes for pastor | 7.2 |
| Dark theme only on public view | 7.1 |
| Print stylesheet / PDF export | 7.3 |
| No offline resilience | 12.1 |
| Simplified mode (hide pro features) | 4.5 |
| Landscape tablet layout for show mode | 3.5 |
| Share flow too complex (Outputs modal) | 1.1, 2.2, 2.3 |
| "Team Access" model is enterprise-grade | 2.2, 4.5 |
| Default to light theme on public view | 7.1 |
| "Cue" terminology → "Item" | 4.1 |
| Show mode is two-handed operator view | 13.2 |
| Double-click to edit is invisible | 4.4 (tooltip), 2.1 (readonly) |
| First-run experience | 4.2 |

### Large-Church Technical Director (TD)

| Finding | Phase.Task |
|---------|-----------|
| Multi-room control dashboard | 11.2 |
| WebSocket-based live state | 6.1, 6.2 |
| Cell-level edit conflict detection | 9.1 |
| Column grouping by department | 10.2 |
| Column-level edit permissions | 10.3 |
| Column templates (independent of plan) | 10.2 (partial), 13.6 |
| Conditional formatting / validation | 10.4 |
| No cursor/cell-level presence | 9.1 |
| Edit history with undo | 9.2 |
| No @mentions or notifications | 13.7 |
| No offline support for editing | 12.2 |
| Heartbeat polling → WebSocket | 6.1, 6.2 |
| Plan lock mechanism | 9.3 |
| Template categories/folders | 13.5 |
| Template versioning | 9.2 (partial via edit history) |
| No partial template application | Future consideration |
| Recurring plan automation | 13.4 |
| Duplication collaborator selection | Future consideration |
| Cross-room dashboard | 11.2 |
| Room-specific defaults/equipment presets | 13.6 |
| Cross-room timing coordination | 11.3 |
| Room-level permissions | 8.4 |
| Simultaneous live sessions | 8.1 |
| Share tokens per-room | 8.3 (partial) |
| Cue stacks / nested items | 10.1 |
| Department-specific GO commands | Future consideration |
| Cue preview/preload | 10.6 |
| Director notes (private) | 9.6 |
| Standby/ready check | 11.4 |
| Multi-action/macro cues | Future consideration |
| Post-show timing report | 9.5 |
| Polling-based live state | 6.1 |
| Standby/blackout cue types | 10.5 |
| Rehearsal run mode | 9.4 |
| Run-through history | 9.4 |
| Timing comparison (rehearsal vs live) | 9.4 |
| Blocking/staging notes | 9.6 (partial via director notes) |
| PCO comparison: volunteer scheduling | 13.8 |
| PCO comparison: song/media library | 13.9 |
| PCO comparison: reporting | 13.10 |
| PCO comparison: recurring plans | 13.4 |

### Volunteer AV Operator (VOL)

| Finding | Phase.Task |
|---------|-----------|
| No row-level department filtering (critical) | 5.1 |
| No "what's next for me" indicator (critical) | 5.3 |
| No onboarding on public view | 4.3 |
| Show mode exposes full control (high) | 2.1 |
| Column filter is URL-only | 5.2 |
| Table horizontal scroll on tablets | 3.3 |
| Timer view has no department context | 5.5 |
| Keyboard shortcuts unusable on tablets | 3.5 (indirect — landscape layout) |
| Display toolbar labels cryptic | 4.4 |
| 30s polling on public view | 6.2 |
| Dark theme only | 7.1 |
| No audio/visual cue alert | 6.3 |
| Tablet breakpoint (768px) needed | 3.3 |
| Glossary tooltips | 4.4 |
| Portal "Column feeds" labeling | 2.2 |
| Default to Prompter on mobile | 3.4 |
| First-visit orientation | 4.3 |
| Share UX: pre-written text messages | 2.2 |
| Interactive column picker | 5.2 |
| Current-row highlight too subtle | 6.2 (WebSocket enables better UX), 5.1 |

### Pastor / Speaker (PAS)

| Finding | Phase.Task |
|---------|-----------|
| No countdown timer in public view (high) | 1.6 |
| No green/yellow/red indicators in public view (high) | 1.7 |
| Cannot filter to "my segments" | 5.4 |
| Prompter hero no remaining time (high) | 1.6 |
| 30s poll interval in non-prompter modes | 6.2 |
| Phone experience dense | 3.4 |
| No notes on timer/confidence (high) | 13.3 |
| No assignee context on timer | 5.5 |
| Stage mode requires manual URL parameter | 1.2, 4.4 |
| Default timer mode is minimal | 7.2 (rename modes) |
| Waiting screen no actionable info | 4.4 (tooltip/info) |
| Show mode exposes operator controls (high) | 2.1 |
| Keyboard shortcuts advance show | 2.1 |
| Small countdown text in show mode | 3.5 (landscape layout) |
| No large single-cue focus | 13.1 |
| Polling-based show mode | 6.1 |
| No speaker-specific page | 13.1 |
| No "you're on next" notification | 6.3 |
| No dark/light toggle on public view | 7.1 |
| Estimated start times don't update live | 12.3 |

### Remote Campus Producer (RCP)

| Finding | Phase.Task |
|---------|-----------|
| Only one live session per church (critical) | 8.1 |
| No split-screen / dual-rundown view | 11.2 |
| No room identification in show mode | 1.10 |
| 1.5s polling borderline for transitions | 6.1 |
| Client-side timer drift | 6.4 |
| 30s polling on public view unusable | 6.2 |
| No "main campus current + my next" view | 11.2 |
| No cue-change notification | 6.3 |
| Room filter is client-side only | 8.3 |
| Cannot go live independently | 8.1 |
| No "follow main campus" mode | 11.1 |
| Device command cross-contamination | 8.4 |
| WebSocket broadcasts are church-wide | 8.2 |
| No cross-room subscription | 8.2, 11.1 |
| Session failover not supported | Future consideration |
| Template room inheritance | 8.5 |
| Room-level access control | 8.4 |
| Cross-room ready-check / status | 11.4 |
| Two parallel live architectures (confusing) | 8.1 (consolidate) |

---

## Phase Dependency Graph

```
Phase 1 (Quick Wins)            ──┐
Phase 2 (Read-Only & Sharing)   ──┼── No dependencies; can run in parallel
Phase 3 (Mobile/Responsive)     ──┤
                                  │
Phase 4 (Terminology/Onboarding) ─┤── Depends on Phase 2 (sharing)
                                  │
Phase 5 (Dept Filtering)        ──┤── Depends on Phase 2 (share links)
                                  │
Phase 6 (WebSocket Migration)   ──┤── No dependencies; can start early
                                  │
Phase 7 (Theme & Print)         ──┤── Depends on Phase 3 (responsive)
                                  │
Phase 8 (Multi-Room Sessions)   ──┤── Depends on Phase 6 (WebSocket)
                                  │
Phase 9 (Collaboration/Rehearsal)─┤── Depends on Phases 6, 8
                                  │
Phase 10 (Advanced Cueing)      ──┤── Depends on Phases 8, 9
                                  │
Phase 11 (Multi-Campus)         ──┤── Depends on Phases 6, 8
                                  │
Phase 12 (Offline/Performance)  ──┤── Depends on Phase 6
                                  │
Phase 13 (New Features)         ──┘── Depends on Phases 8-10
```

**Recommended parallel tracks:**

- **Track A (UX Polish):** Phase 1 → Phase 3 → Phase 7
- **Track B (Sharing & Filtering):** Phase 2 → Phase 4 → Phase 5
- **Track C (Real-Time & Architecture):** Phase 6 → Phase 8 → Phase 11
- **Track D (Pro Features):** Phase 9 → Phase 10 → Phase 13
- **Track E (Reliability):** Phase 12 (after Phase 6)

---

## Effort Summary

| Phase | Theme | Tasks | Small | Medium | Large | Total Effort |
|-------|-------|-------|-------|--------|-------|-------------|
| 1 | Quick Wins | 10 | 9 | 1 | 0 | ~1-2 sprints |
| 2 | Read-Only & Sharing | 5 | 3 | 2 | 0 | ~1-2 sprints |
| 3 | Mobile/Responsive | 7 | 3 | 2 | 1 | ~2-3 sprints |
| 4 | Terminology & Onboarding | 8 | 5 | 2 | 1 | ~2-3 sprints |
| 5 | Dept Filtering | 5 | 0 | 5 | 0 | ~2 sprints |
| 6 | WebSocket Migration | 4 | 1 | 1 | 2 | ~2-3 sprints |
| 7 | Theme & Print | 3 | 1 | 2 | 0 | ~1-2 sprints |
| 8 | Multi-Room Architecture | 5 | 1 | 3 | 1 | ~3-4 sprints |
| 9 | Collaboration & Rehearsal | 6 | 1 | 2 | 3 | ~3-4 sprints |
| 10 | Advanced Cueing | 6 | 1 | 4 | 1 | ~3-4 sprints |
| 11 | Multi-Campus | 4 | 0 | 3 | 1 | ~2-3 sprints |
| 12 | Offline & Performance | 3 | 0 | 2 | 1 | ~2-3 sprints |
| 13 | New Features | 10 | 1 | 4 | 5 | ~4-6 sprints |
| **Total** | | **76** | **26** | **33** | **16** | **~28-42 sprints** |

---

## Items Noted but Deferred

These items were mentioned in audits but are either very low priority, not actionable as discrete tasks, or dependent on strategic product decisions:

| Item | Source | Reason for deferral |
|------|--------|-------------------|
| Department-specific GO commands | TD | Requires rethinking the cue model fundamentally |
| Multi-action/macro cues | TD | Companion actions partially cover this; revisit after Phase 10 |
| Native mobile app | TD (PCO comparison) | Responsive web is the current strategy; revisit based on adoption |
| Partial template application | TD | Low demand; full templates + duplication cover most cases |
| Duplication collaborator selection | TD | Minor UX irritant; low priority |
| Session failover / handoff | RCP | Important but complex; revisit after Phase 8 |
| Template versioning | TD | Edit history (Phase 9.2) partially addresses this |
| Diff/merge when duplicating from changed template | TD | Complex feature; revisit after Phase 13.4 (recurring plans) |
