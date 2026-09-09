# Tally AI surfaces review

**Audience:** Andrew (platform operator). Church TDs see the *effects* of these surfaces, not this doc.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`d0174b9`) plus this PR.  
**Live probe:** 2026-09-09 01:08 UTC, read-only health/status only. **No Anthropic calls. No church PII sent to Claude.**  
**Deployed relay:** `1.1.67` build `d0174b974210765fd229e6c570a6fbb320d4e8f1` (Railway + Cloudflare)

This answers: *which AI features are real, which are decorative, and what must be true before Sunday should rely on them.*

Companion docs: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md), [`ADMIN_DASHBOARD_REVIEW.md`](ADMIN_DASHBOARD_REVIEW.md), [`ALERTS_REVIEW.md`](ALERTS_REVIEW.md).

North star: **Sunday-indispensable.** AI is assistive polish on top of failover, alerts, and booth reconnect — not the reliability core. Template fallbacks must never block a Sunday path.

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | Code + tests, and a live or config probe shows the path can fire |
| **PARTIAL** | Implemented, but untested live, env-gated, or missing usage/fallback honesty |
| **BROKEN** | Confirmed miss: crash / missing fallback / Sunday path blocked / secret leak |
| **DECORATIVE** | UI or copy says “AI” but no Claude call happens (or the call is optional prose) |
| **DEAD** | Code exists with no UI, or a leftover parallel endpoint |

---

## Summary verdict

**Partial. The key is in Railway. Almost nothing has been proven with a connected booth.**

`ANTHROPIC_API_KEY` is set in production (feature audit, Sep 2026). Health/status endpoints **do not** expose AI readiness — clients discover a missing/invalid key only when a feature fails. Live probe this run: **6 registered churches, 0 connected booths, 0 relayed messages.** No live Claude path can be exercised without auth + a booth.

| Claim TDs / marketing might believe | Reality |
|-------------------------------------|---------|
| “AI already fixed the stream” | **Not Claude.** Stream restart is `autoRecovery` + optional **rule-based** AI Triage `full_auto`. Failover is a state machine. |
| “Talk to Tally and it switches cameras” | **Real code** (Haiku parser + stream-safety confirm). **Untested live** — needs a connected agent. |
| “Upload a bulletin, get a rundown” | **Real code**, stale Sonnet model ID, **never dogfooded**. Import does not fire live cues. |
| “AI writes the incident summary” | **Real**, fire-and-forget, **template fallback** if Claude is down. Failover does **not** wait. |
| Portal nav “AI Assistant” / “AI Triage” | Engineer **profile + chat** is Claude. AI Triage page is **heuristics**, not Claude. Copy blurs the two. |

**Do not treat AI as a Sunday dependency.** Direct commands, templates, and rule engines already cover the critical path. This PR only ships three small honesty/fallback fixes (onboarding crash-on-API-error, rundown-import 503 + no raw-model leak, setup-assistant env-var name no longer posted to church chat).

---

## 1. North-star scorecard

Scores are 1–5. **5 = Sunday-ready and honest.** Scores assume the Railway key stays set.

| Surface | What it actually is | Rel. | Trust | Sec. | Polish | Obs. | Sunday-usable? |
|---------|---------------------|:----:|:-----:|:----:|:------:|:----:|----------------|
| **Incident summarizer** | Sonnet prose on failover transitions; templates if Claude fails | 5 | 4 | 4 | 4 | 4 | **Yes as copy.** Failover does not wait. |
| **Post-service report recs** | **Rule-built** recs; optional Haiku paragraph | 4 | 3 | 4 | 3 | 2 | **Yes without AI.** Recs do not need Claude. |
| **Session recap recs** | Optional Haiku; recap sends without it | 4 | 3 | 4 | 3 | 1 | **Yes without AI.** |
| **Pre-service rundown AI blurb** | Background Haiku after rundown already broadcast | 4 | 3 | 4 | 3 | 1 | **Yes without AI.** |
| **Command parser (portal / Telegram)** | Haiku → live gear commands | 3 | 3 | 2 | 3 | 4 | **Only as assist.** Direct commands + confirm gates are the real path. |
| **Diagnostic chat (Sonnet)** | Troubleshooting answers, no command exec | 3 | 3 | 2 | 3 | 4 | **No.** Chat-only. Needs booth telemetry to be useful. |
| **Setup assistant (mixer / cameras)** | Haiku vision → **immediate** OSC / ATEM labels | 2 | 2 | 2 | 2 | 3 | **No.** Can mutate a live console with no `confirm:`. Prepare-mode only. |
| **Onboarding chat (Electron)** | Haiku wizard; **template fallback** (this PR: also on API error) | 4 | 3 | 3 | 3 | 1 | **N/A** (setup, not Sunday). |
| **Portal rundown AI import** | Separate Sonnet path (`claude-sonnet-4-20250514`); parse only | 2 | 2 | 3 | 2 | 1 | **No.** Untested. Does not block Go Live. |
| **Telegram rundown NL** | `rundown-ai.js` Haiku → draft + save | 3 | 3 | 3 | 3 | 1 | **No until saved.** Plus+ scheduler gate. |
| **Portal support triage RCA** | Optional Sonnet JSON; rule checks always return | 3 | 3 | 2 | 3 | 1 | **No.** Support workflow. |
| **AI Triage (`full_auto` / `recommend_only`)** | **Not Claude** — weighted scoring + safe remediations | 4 | 2 | 3 | 3 | 3 | **Maybe.** Default is `recommend_only`. `full_auto` can restart stream **without** an LLM. |
| **Admin AI drawer / outreach / landing chat** | Haiku for Andrew / marketing | 3 | 3 | 3 | 3 | 3 | **No** (ops / sales). |
| **Church documents / KB** | Haiku extract + summary → later injected into parser context | 3 | 3 | 2 | 2 | 3 | **No.** Knowledge ingest. |

**Overall: Reliability 3 / Trust 2 / Security 2 / Polish 2 / Observability 2.**

Honesty gap is the trust score: portal copy says “AI Assistant” for rule-based recovery and for Claude chat. Observability gap: several Claude calls never hit `ai_usage_log`. Security gap: user text + bulletins + TD names go to Anthropic; `ai_chat_log` stores **full** user messages.

---

## 2. Inventory (every Anthropic call site)

Models in code: **Haiku** `claude-haiku-4-5-20251001` (most paths), **Sonnet** `claude-sonnet-4-6` (diagnostics, incident summaries, portal RCA), **stale Sonnet** `claude-sonnet-4-20250514` (**only** portal rundown import). Pricing table in `server.js` also lists unused `claude-opus-4-6`.

| # | Trigger | File | Model | Timeout | Usage log | Missing / invalid key | Fallback | Sunday-critical? |
|---|---------|------|-------|---------|-----------|------------------------|----------|------------------|
| 1 | Portal / Electron / admin church chat → natural language command | `ai-parser.js` via `server.js` `handleChatCommandMessage` | Haiku | 15s | `command_parser` | Friendly chat error | Regex / smart-parser, then error message | **Indirect** — can cut/stream if parsed + safety allows |
| 2 | Same chat, diagnostic / ambiguous intent | `server.js` `callDiagnosticAI` | Sonnet → Haiku | 25s / 15s | `diagnostic_chat` (+ `_fallback`) | String in chat: “AI is not configured…” | Haiku, then apology string | No (no commands) |
| 3 | Telegram after regex miss | `telegramBot.js` → #1 / #2 | Haiku / Sonnet | inherited | chat log (model field often hardcoded Haiku) | Config / parser error text | “I didn't understand…” | **Indirect** — same as #1 |
| 4 | Chat attachment / “setup mixer” / camera plot | `ai-setup-assistant.js` via `handleSetupRequest` | Haiku | **none** | `setup_assistant` | Error posted to chat (sanitized in this PR) | None — chat ❌ | **Indirect** — **executes live mixer/ATEM with no confirm** |
| 5 | Telegram “create rundown …” | `rundown-ai.js` | Haiku | 20s / 15s | **No** | `e.message` to TD (can name the env var) | Example prompt | No until `save` |
| 6 | Portal **Import from Document** | `routes/liveRundown.js` (**not** `rundown-ai.js`) | `claude-sonnet-4-20250514` | 20s (this PR) | **No** | **503** honest message (this PR; was 500 + env name) | Manual builder | No |
| 7 | Electron `POST /api/church/onboarding/chat` | `onboardingChat.js` | Haiku | 15s | **No** | Template `FALLBACK_FLOW` | Same on API error (this PR; was 500) | No |
| 8 | Failover `onTransition` | `incidentSummarizer.js` `_generateAISummary` | Sonnet | **8s** | `incident_summary` | Template | Template; outer catch never throws | **No block** — fire-and-forget |
| 9 | Schedule window close | `incidentSummarizer.js` `generatePostServiceNarrative` | Sonnet | 15s | `post_service_narrative` | Template | Template / `null` | No |
| 10 | `PostServiceReport.generate` | `postServiceReport.js` `_generateAiSummary` | Haiku | 15s | **No** | Skip AI block | HTML report without prose | No (recs are rules) |
| 11 | Session end Telegram recap | `sessionRecap.js` `_generateRecommendations` | Haiku | 10s | **No** | `null` | Recap without recs | No |
| 12 | Pre-service rundown after broadcast | `preServiceRundown.js` `generateAISummary` | Haiku | 15s | **No** | `null` | Rundown already sent | No |
| 13 | Chat “upload document” | `churchDocuments.js` | Haiku | 30s / 10s | `document_extract` / `document_summary` | Throw / filename | Upload error in chat | No |
| 14 | Portal Support → Run Triage | `churchPortal.js` | Sonnet | 15s | **No** | Skip `aiAnalysis` | Rule checks still 201 | No |
| 15 | Admin `AIChatDrawer` | `POST /api/admin/chat` | Haiku | 15s | `dashboard_chat` | HTTP 500 “AI not configured” | None | No |
| 16 | Admin Outreach ghostwriter | `POST /api/admin/generate` | Haiku | 30s | `outreach_generate` | HTTP 500 | None | No |
| 17 | Legacy `POST /api/chat` | `routes/sessions.js` | Haiku | 15s | `dashboard_chat` | HTTP **503** | None | No (**DEAD**-ish parallel) |
| 18 | Landing `POST /api/chat/stream` | `server.js` | Haiku | 15s | `landing_chat` | HTTP 500 | SSE error | No — needs `CHAT_PROXY_SECRET` |

**Not Claude (do not count as AI reliability):**

| Surface | What it is |
|---------|------------|
| `aiTriage.js` | Heuristic score + `SAFE_REMEDIATIONS`. Modes: `full_auto` / `recommend_only` (default) / `monitor_only`. |
| `autoPilot.js` | User-authored rules → immediate device commands. Session fire cap. |
| `intent-classifier.js` | Regex router (Haiku vs Sonnet). |
| `smart-parser.js` | Regex command fallback before/after Haiku. |
| Portal Reports “AI Activity” | Triage/auto-recovery **actions**, not token usage. Hidden when `aiEnabled` is false (triage mode, not API key). |

---

## 3. Sunday-critical paths vs Claude

| Sunday path | Blocks on Claude? | Notes |
|-------------|-------------------|-------|
| Failover state machine | **No** | Summarizer is async, 8s cap, templates. |
| Alerts / Telegram / Slack | **No** | Engine is independent. |
| Booth reconnect / watchdog | **No** | No AI in church-client command path. |
| Live rundown Go / public views | **No** | Import is optional parse. |
| Stream restart | **No Claude** | `autoRecovery` and AI Triage `full_auto` are rules. |
| Mixer / ATEM via chat setup | **Can mutate live** | No `confirm:` — prepare-mode risk, not a hang on failover. |
| NL “go live” / “cam 2” | **User-initiated** | Stream-safety `confirm:` for stop/FTB. Hourly Haiku limits; **incident bypass** during outage. |

**Missing/invalid key:** Sunday-critical automation keeps working. Assistive surfaces fail **loudly in chat** (parser, diagnostics) or **silently skip** (reports, recaps, triage RCA). Health JSON never says “AI ready.”

---

## 4. What church data goes to Anthropic

| Data | Surfaces |
|------|----------|
| Church name, room name, live device JSON | Command parser, diagnostics, rundown-ai, admin drawer (up to 50 church states) |
| Full user / TD chat text | Parser, diagnostics, Telegram, onboarding, `ai_chat_log` (**untruncated**) |
| Engineer profile, memory, document chunks, PCO, alerts, health score, failover state | Parser + diagnostic context (`tally-engineer` / `diagnostic-context`) |
| Patch lists, camera plots, **images / PDFs as base64** | Setup assistant, church documents, rundown import |
| Bulletin / order-of-service + **assignee names** | Portal rundown import |
| TD names, emails, phones (if typed) | Onboarding |
| Session grades, alert types, incident summary text | Post-service / recap / narrative |

**Prompt injection:** User text is concatenated into the same turn as telemetry (parser: `` `[${contextBlock}]\n${text}` ``). Support triage puts `USER DESCRIPTION` in the **system** prompt. Document KB is later retrieved into the parser. Command allowlists and `checkStreamSafety` are the real backstops — not prompt isolation.

**Logging:** Console truncates (60–80 char user, 300 char model). `ai_chat_log` stores full `user_message`. Anthropic error bodies are sliced 100–300 chars in server logs — **not** the API key. Telegram rundown errors still forward `e.message` to the TD (can say `ANTHROPIC_API_KEY not set`).

**Retention:** `ai_usage_log` purge job is 90 days (`server.js` cleanup list). `ai_chat_log` has **no** matching retention in that list.

---

## 5. Rate limits, cost, per-church modes

**Haiku commands** (`ai-parser.js`): per church per hour — connect 5, plus 30, pro 60, managed 250, event 15. Bypassed in `CONFIRMED_OUTAGE` / `FAILOVER_ACTIVE` (via `aiRateLimiter` hook).

**Sonnet diagnostics** (`aiRateLimiter.js`): per church per month — connect 20, plus 100, pro 300, managed ∞, event 10. 80% warning. Incident bypass. **Portal chat enforces this. Telegram diagnostic path does not.**

**Incident summaries:** never rate-limited (by design).

**AI Triage modes** (portal Settings / AI Triage page, table `church_ai_settings`):

| Mode | Behavior |
|------|----------|
| `recommend_only` (default) | Score + ticket / recommendation. No auto command. |
| `full_auto` | Safe remediations only (`recovery.restartStream`, `restartRecording`, `resetAudio`). **No LLM.** |
| `monitor_only` | Log only. |

There is **no** per-church “Claude off” switch. Turning triage to `monitor_only` does **not** disable Engineer chat or rundown import.

---

## 6. UX honesty (admin vs portal vs booth)

| Surface | Discoverable? | Honest when AI is down? |
|---------|---------------|-------------------------|
| Portal **AI Assistant** nav | Yes — profile + “Chat with Tally Engineer” | Chat posts “not configured” / friendly parser errors. No preflight banner. Page subtitle overclaims “diagnose problems faster.” |
| Portal **AI Triage** | Yes | This is **not** Claude. Onboarding banner is about modes, not the API key. |
| Portal **rundown import** | Sparkle modal | Toast on failure. This PR: 503 copy does not name env vars or dump model text. |
| Portal Reports AI Activity | Yes | Shows triage actions; “disabled” = triage off, not “no Anthropic.” |
| Electron onboarding | App-only (not portal checklist) | Fallback wizard still talks like an assistant (this PR: also when Claude 500s). |
| Telegram | Implicit after command miss | Errors are usable. Rundown path can leak `ANTHROPIC_API_KEY` in the error string. |
| Admin FAB “AI” | Always visible | Drawer shows `Error: …` / “AI not configured.” No health chip. |
| Admin AI Usage tab | Yes | Token/cost from `ai_usage_log`. Labels miss `incident_summary`, `diagnostic_chat`, `landing_chat`, etc. Empty until something logs. |
| Booth / Companion | No AI entry | Correct — booth is reliability core. |

---

## 7. Tests vs dogfood

| Covered (unit / query-client) | **No tests** |
|-------------------------------|--------------|
| `ai-parser` (sigs / integrity), intent classifier, rate limiter, AI Triage, incident summarizer, onboarding (+ API-fail fallback this PR), church documents, post-service report, session recap, AutoPilot, Telegram parser | `rundown-ai.js`, `ai-setup-assistant.js`, liveRundown AI import, `callDiagnosticAI`, admin generate/chat, landing proxy, portal RCA |

E2E: `scripts/e2e/scenarios/30-ai-engineer.js` — skips if relay says AI not configured. Not a substitute for a Sunday booth.

**Live probe possible without a booth (this run):**

```
GET https://api.tallyconnect.app/api/health  → 200, healthy, connectedChurches: 0
GET https://api.tallyconnect.app/api/status  → operational, 0 connected
```

No `anthropic` / `aiConfigured` field. Authenticated import/chat/onboarding were **not** called (would send church or fixture data to Claude).

---

## 8. P0 / P1 / P2

### P0 — shipped in this PR (small, high-confidence)

| ID | Issue | Fix |
|----|-------|-----|
| **P0-1** | Onboarding used `FALLBACK_FLOW` only when the key was **unset**. Production **has** a key, so Anthropic timeout/5xx **500’d** Electron onboarding. | `callOnboardingAI` returns `null` on HTTP/network/empty; wizard continues. Tests for reject + HTTP 500. |
| **P0-2** | Rundown import returned **500** + `ANTHROPIC_API_KEY` name; parse failure returned **500 chars of model output** to the browser. | **503** honest copy; 20s SDK timeout; parse failure **502** without `detail`. |
| **P0-3** | Setup assistant posted raw `err.message` to church chat (includes `ANTHROPIC_API_KEY not configured`). | Sanitize that class of errors. |

### P1 — fix before treating AI as a product pillar

1. **Do not auto-apply mixer / camera / media-to-program from chat.** Require the same `confirm:` (or a preview) as stream-stop. Prepare-mode default.
2. **Align rundown import model** to `claude-sonnet-4-6` (or a pinned current snapshot). `claude-sonnet-4-20250514` is the odd one out after the `-20250627` cleanup.
3. **Timeouts** on `ai-setup-assistant.js` (unbounded `fetch`).
4. **Telegram diagnostic monthly cap** — same `checkDiagnosticLimit` as portal, or document the bypass as intentional.
5. **`logAiUsage` on the silent majority:** rundown-ai, onboarding, pre-service blurb, session recap recs, liveRundown import, portal RCA.
6. **Stop forwarding raw Anthropic errors to Telegram** (`_handleCreateRundownAI`).
7. **Portal copy:** “AI Assistant” vs “Auto-recovery” vs “Triage.” TDs should know which button talks to Claude.
8. **Dogfood** Engineer chat + one rundown import + one staged failover summary with a **connected booth** (see below).

### P2 — polish / hygiene

1. Merge the two rundown AI stacks (`rundown-ai.js` vs inline SDK) or document them as different products (cues vs plan items).
2. Admin `AIUsageTab` feature labels for every `feature` string.
3. Retention on `ai_chat_log` (full user text) — 90 days to match usage, or redact.
4. Health/admin chip: `aiConfigured: boolean` (never the key).
5. Tests for import route (missing key → 503) and setup-assistant timeout.
6. Landing chat abuse surface if `CHAT_PROXY_SECRET` leaks (public Haiku).
7. Deduplicate `/api/admin/chat` vs `/api/chat`.

---

## 9. What needs dogfood

Cannot be proven while `connectedChurches: 0`. **Do not paste production bulletins or TD PII into exploratory scripts.**

| # | Exercise | Why | How without leaking PII |
|---|----------|-----|-------------------------|
| 1 | **Engineer chat** on a lab church with a connected booth | Proves Haiku commands + Sonnet diagnostics + safety confirm | Synthetic room; “cam 2” / “status” / “why is bitrate low” |
| 2 | **Rundown AI import** | Only portal Claude path using the stale Sonnet ID | Fixture PDF you wrote (“Song 1, Welcome, Message 25 min”) |
| 3 | **Telegram NL rundown** | Separate Haiku stack + save/cancel | Same fixture text, Plus+ church |
| 4 | **Staged failover** | Proves template vs Sonnet summary in chat/Telegram | Lab encoder drop; compare `incident_summaries.model_used` |
| 5 | **Onboarding with key set** | Proves conversational path (fallback is now tested without Claude) | Electron against staging; fake IPs |
| 6 | **Setup assistant on a dark console** | Proves vision parse — **not** during service | Photo of a **dummy** patch sheet; confirm labels, then undo |
| 7 | **Admin drawer + usage tab** | Proves Andrew’s ops loop | After #1–4, confirm rows in AI Usage |
| 8 | **Triage `recommend_only` vs `full_auto`** | Prove the non-Claude automation TDs think is “AI” | Lab `stream_stopped`; watch whether restart fires |

**Success for Andrew:** after 1–4, you know which buttons spend tokens, which buttons restart the stream without Claude, and that Sunday still works if Anthropic is down.

---

## 10. Validation notes (this PR)

- Unit: `relay-server/tests/onboarding-chat.test.js` — missing key, fetch reject, HTTP 500 all use `FALLBACK_FLOW`.
- No Anthropic calls in CI or in the live probe.
- Health/status remain AI-agnostic (unchanged).
- Rundown import and setup-assistant changes are error-path only; happy path behavior unchanged aside from a 20s import timeout.
