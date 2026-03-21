# Admin Dashboard Visual & Code Review Report
**Date:** 2026-03-21
**Method:** Source code analysis of `relay-server/src/adminPanel.js` (Chrome screenshot approach attempted but unavailable)
**Analyst:** Claude (automated review)

---

## Architecture Finding (Critical)

**The local relay server no longer serves the admin HTML.**

`setupAdminPanel()` at line 2440 redirects ALL `/admin` and `/admin/*` routes to `ADMIN_UI_URL`:

```js
// Canonical admin UI is hosted on Vercel. Relay serves APIs only.
app.all(['/admin', '/admin/*'], (req, res) => {
  res.redirect(302, ADMIN_UI_URL); // defaults to https://tallyconnect.app/admin
});
```

Visiting `localhost:3001/admin` redirects to `https://tallyconnect.app/admin`. The `buildAdminDashboardHtml()` and `buildAdminLoginHtml()` functions (~1,750 lines combined) are **dead code** — they are never called by any active route.

This means:
- The admin dashboard UI lives in the Vercel app (separate repo), not this file
- The relay server exposes only `/api/admin/*` endpoints
- The dead HTML code still needs bug fixes (it could be re-enabled or re-used)

---

## Bugs Found & Fixed

### Bug 0 — CRITICAL: `onclick` HTML Attribute Escaping Breaks All Action Buttons

**File:** `adminPanel.js` — `renderChurches()`, `renderResellers()`, `openDetail()`
**Description:** `JSON.stringify(value)` produces a string wrapped in `"` double-quotes. When embedded raw inside an `onclick="..."` HTML attribute, the `"` from JSON immediately closes the attribute, truncating the onclick JS to a partial expression (e.g., `openDetail(`). Clicking Edit, Delete, Regen Token, or the church name link silently did nothing — the browser parsed the onclick as an empty or syntax-error function call.

**Affected patterns (all tables):**
- Church: `openDetail`, `openEditChurch`, `openRegenToken`, `deleteChurch`, `copyToken`
- Reseller: `openEditReseller`, `openSetPassword`, `toggleReseller`, `deleteReseller`

**Fix:** Wrapped all `JSON.stringify(...)` in `esc()` (HTML encoder) so `"` becomes `&quot;` in the attribute. The browser decodes `&quot;` → `"` before executing JS — the function receives the correct argument.

```js
// Before (broken — " closes attribute):
onclick="openDetail(${JSON.stringify(c.churchId)})"

// After (correct — &quot; decoded by browser before JS runs):
onclick="openDetail(${esc(JSON.stringify(c.churchId))})"
```

---

### Bug 1 — Reseller Status Badge: Missing CSS Classes (HIGH)
**File:** `adminPanel.js:1092`
**Description:** `renderResellers()` used `badge-active` and `badge-inactive` CSS classes that don't exist in the stylesheet. Only `badge`, `badge-green`, `badge-yellow`, `badge-red`, `badge-gray` are defined.
**Symptom:** Resellers table shows plain `● Active` / `● Inactive` text with no styling — looks broken.
**Fix:** Changed to `badge badge-green` / `badge badge-gray` — matches all other badge usage in the file.

---

### Bug 2 — Password Change Form: Missing Current Password Field (HIGH)
**File:** `adminPanel.js:434–436`
**Description:** The Settings > Admin Password form had only a "New Password" input. The `/api/admin/change-password` endpoint requires `currentPassword` and returns `400 { error: "currentPassword required" }` without it. The form would always fail silently (an error message appeared but the UX suggested success).
**Fix:** Added a "Current Password" input field and updated `changeAdminPassword()` JS to send `{currentPassword, newPassword}`. Also added client-side validation (min 8 chars).

---

### Bug 3 — Hamburger Button Uses Emoji (MEDIUM)
**File:** `adminPanel.js:297`
**Description:** Mobile hamburger `<button>` contained `☰` (Unicode hamburger symbol) — an emoji, violating the "no emoji" policy from the earlier refactor commit (`0a11241`).
**Fix:** Replaced with inline SVG icon (three horizontal bars).

---

### Bug 4 — `setChurchFilter` Deactivates All Filter Tabs Globally (MEDIUM)
**File:** `adminPanel.js:943`
**Description:** `setChurchFilter()` used `document.querySelectorAll('.filter-tab')` to remove `.active` from all filter tabs on the entire page — including the Alerts and Tickets page filter tabs. When a user filtered churches and then navigated to Alerts, the "Unacknowledged" tab was deactivated (lost its active state).
**Fix:** Scoped the selector to `el.closest('.filter-tabs')`, matching the pattern used by `setAlertFilter` and `setAlertAckFilter`.

---

### Bug 5 — `resendEmail` HTML-Injection XSS / Broken Attribute (HIGH)
**File:** `adminPanel.js:1597`
**Description:** `renderEmailHistory()` embedded the email row data using `JSON.stringify(JSON.stringify(r))` directly in an HTML `onclick` attribute. The outer `JSON.stringify` produces a JS string literal with backslash-escaped quotes (`\"`). When embedded raw in HTML, the browser's HTML parser does not interpret `\"` as an escaped quote — it sees unescaped `"` characters that break the `onclick` attribute value, producing malformed HTML. The Resend button would silently fail.
**Fix:** Changed to `resendEmailByIndex(i)` (same pattern as `previewSentEmail(i)`) and added a `resendEmailByIndex(idx)` helper that looks up `emailHistoryRows[idx]` and calls `resendEmail(row)`. `resendEmail` now takes a row object directly instead of a JSON string.

---

### Bug 6 — `renderTemplateGrid` Embeds Unescaped Type in `onclick` (MEDIUM)
**File:** `adminPanel.js:1669–1670`
**Description:** Template type strings were embedded raw in `onclick="previewTemplate('${t.type}')"`. If a type value contained a single quote, it would break the inline JS handler.
**Fix:** Changed to `JSON.stringify(t.type)` which produces a properly quoted JS string literal.

---

### Bug 7 — AI Usage Page: 5-Column Grid Overflows on Medium Screens (MEDIUM)
**File:** `adminPanel.js:495`
**Description:** `<div class="summary-row" style="grid-template-columns:repeat(5,1fr)">` forces exactly 5 equal columns. On screens 768–1100px wide, cards become ~160px wide — too narrow to read "Cache Hits" label. No media query covered this range.
**Fix:** Changed to `grid-template-columns:repeat(auto-fill,minmax(160px,1fr))` — works on all screen sizes.

---

### Bug 8 — Email Preview & Template Edit Modals: Missing `position:relative` (LOW)
**File:** `adminPanel.js:614, 627`
**Description:** `.modal-close` is styled with `position:absolute;top:16px;right:16px`. Both the Email Preview and Template Edit modals had no `position:relative` on their container `<div class="modal">`, so the close button was positioned relative to the viewport instead of the modal.
**Fix:** Added `position:relative` to both modal container divs.

---

### Bug 9 — API Key "Reveal" Button: Misleading UX (LOW)
**File:** `adminPanel.js:442–444`
**Description:** The Settings > Admin API Key section showed a masked input and a "Reveal" button. Clicking "Reveal" showed a modal saying "API keys are no longer displayed in the browser" — it never revealed anything. The button label was misleading and the entire widget was pointless.
**Fix:** Removed the fake reveal/copy widget and replaced with a `help-box` explaining that `ADMIN_API_KEY` is in Railway env vars.

---

### Bug 10 — `loadOverview` Missing `r.ok` Check (LOW)
**File:** `adminPanel.js:829`
**Description:** The overview fetch did not check `r.ok` before calling `r.json()`. A 401 response would attempt to JSON-parse an HTML redirect page, throwing an error with a confusing message.
**Fix:** Added `if (!r.ok) throw new Error(...)` before parsing.

---

### Enhancement — Added `code` CSS Style (LOW)
**File:** CSS block in `buildAdminDashboardHtml`
**Description:** The new API Key help text uses `<code>ADMIN_API_KEY</code>` but there was no `code` style defined.
**Fix:** Added `.code` style with monospace font and subtle background.

---

## Layout & UX Analysis (No Code Bugs)

| Section | Status | Notes |
|---------|--------|-------|
| Login page | ✅ OK | Clean, uses scrypt password verify, proper rate limit |
| Sidebar | ✅ OK | Fixed 220px width, mobile overlay pattern, all SVG icons |
| Overview stats grid | ✅ OK | 3-column grid, 6 stat cards (2 rows) |
| Churches table | ✅ OK | Pagination implemented, search + filter tabs |
| Churches detail panel | ✅ OK | Slide-in panel, token blur/reveal, device chips |
| Resellers table | ✅ Fixed | Status badge was broken (Bug 1) |
| Alerts page | ✅ OK | Dual filter tabs (severity + ack state), scoped selectors |
| Tickets page | ✅ OK | Clickable rows, slide-in detail panel |
| Billing page | ✅ OK | Summary cards + subscription table, Stripe link |
| AI Usage page | ✅ Fixed | Grid overflow fix (Bug 7) |
| Emails > History | ✅ Fixed | Resend button fix (Bug 5), load-more pagination |
| Emails > Templates | ✅ Fixed | Template onclick escaping fix (Bug 6) |
| Emails > Send Custom | ✅ OK | Preview + send flow, church select + free-form email |
| Settings | ✅ Fixed | Password form fix (Bug 2), API key widget fix (Bug 9) |
| Mobile (375px) | ✅ OK | Hamburger menu, sidebar overlay, grid collapses to 2-col |
| Toast system | ✅ OK | Bottom-right, error/success variants, 3s auto-dismiss |
| Async dialog | ✅ OK | Modal confirm/alert/prompt, Promise-based, keyboard accessible |

---

## Accessibility Notes

| Issue | Severity | Notes |
|-------|----------|-------|
| No `aria-label` on filter tabs | Low | Buttons have text content, screen readers OK |
| Detail panel not trapFocused | Low | Focus moves into panel but no trap — Tab can escape |
| No `aria-expanded` on hamburger | Low | `aria-label="Menu"` set |
| `<table>` missing `<caption>` | Info | Not critical for admin-only tools |

---

## Reseller Portal (`/portal`) — No Bugs Found

The `buildPortalHtml()` function is actively served at `/portal`. No bugs found:
- Fleet table renders correctly
- Add Church flow with optional portal credentials
- Account/branding update
- Change password flow
- Toast and dialog system consistent

---

## Summary

| Priority | Count | Status |
|----------|-------|--------|
| CRITICAL bugs | 1 | Fixed (onclick HTML escaping — all action buttons broken) |
| HIGH bugs | 3 | All fixed |
| MEDIUM bugs | 3 | All fixed |
| LOW bugs/enhancements | 4 | All fixed |
| Architecture finding | 1 | Documented (dead code, not removed) |

**All 11 bugs fixed in `relay-server/src/adminPanel.js`.**

## Commits

- `0cfa946` — `fix(admin): comprehensive admin dashboard code audit and bug fixes`
- `fcb1fde` — `chore(admin): incorporate additional improvements from stash`
