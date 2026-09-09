# Tally Billing / Stripe Review

**Audience:** Andrew (platform operator). Prepare-mode: correctness and honesty, not GTM.  
**Repo:** `peterdisbrow/tally` @ `origin/main` (`527ca88`) plus this PR.  
**Live probe:** 2026-09-09 ~01:34–01:37 UTC. Stripe **livemode** account `Atemschool` (`acct_1B22ZuE1Xo2A4Mzy`) via API. Railway env **names** confirmed on service `tally` / production; **values not readable** through the connected Railway app (no secrets printed).  
**Deployed relay:** `1.1.67` build `527ca88` (Railway + Cloudflare). Health: **6 registered / 0 connected**.

This answers: *does Stripe match the site, and what actually breaks trials and payments?*

Companion: [`FEATURE_AUDIT_2026-09-08.md`](FEATURE_AUDIT_2026-09-08.md) §2, [`CHURCH_PORTAL_REVIEW.md`](CHURCH_PORTAL_REVIEW.md) §4, [`EMAIL_SYSTEM_REVIEW.md`](EMAIL_SYSTEM_REVIEW.md).

---

## Status legend

| Status | Meaning |
|--------|---------|
| **WORKING** | Code + live config agree; a probe or signed test shows the path can fire |
| **PARTIAL** | Implemented, but copy/catalog/env disagree, or a second path is unused |
| **BROKEN** | Confirmed miss: 404 return URL, handler that cannot retry, or advertised amount that is not what Stripe charges |
| **DEAD** | API exists with no operator UI (or leftover route) |
| **SALES-GATED** | Leave in place; do not grow until divorce is final |

---

## Summary verdict

**Stripe monthly amounts match the marketing site ($49 / $99 / $149 / Event $99). Annual “save 25%” does not. The church portal was still selling the old $79 / $149 / $199 ladder. Checkout fallback URLs 404’d if the landing page omitted `successUrl`.**

| Question | Answer |
|----------|--------|
| Do live Stripe prices match Connect $49 / Plus $99 / Pro $149 / Event $99? | **Yes (monthly + event).** Read from livemode `GetPrices`, not invented. |
| Founding $49 vs list $79? | **Marketing-only.** Live Connect **is** $49. There is no $79 Connect price in Stripe. Signup still says “limited spots.” |
| Annual −25%? | **No.** Live annual = **12 × monthly** ($588 / $1,188 / $1,788). Signup UI says “Annual (save 25%).” `setup-stripe.js` would create 9-month totals; those prices are **not** what is live. |
| Enterprise $499 vs Custom? | **Self-serve checkout is blocked** (`managed` → 400). Live Stripe still has $499 / $4,990 prices. Homepage **card** still shows $499; comparison table already says **Custom**. Do not change tally-landing in this repo. |
| What breaks a trial? | Production `TALLY_REQUIRE_ACTIVE_BILLING` defaults **true**. Onboard with Stripe on sets `billing_status=pending` and creates Checkout **with a 30-day Stripe trial (card collected)**. Hourly cron expires `trialing` rows only — **pending never auto-expires**. Lifecycle 7/5/1-day emails only query `trialing`. |
| What breaks a payment? | Live webhook **is** signed and subscribed to the events the code handles for money (`checkout.session.completed`, subscription CRUD, `invoice.payment_succeeded` / `failed`). Disputes and `invoice.upcoming` are coded but **not** on the Stripe endpoint. Idempotency used to swallow failed handlers (fixed here). |

**North-star read:** catalogs and Checkout can take money at the advertised **monthly** rates. Honesty fails on annual discount, founding-as-list, and “no credit card” vs Stripe Checkout trial. Referral free-month credits now match live list ($49/$99/$149). Retention coupon stays as-is.

---

## North-star scorecard

Scores are 1–5 against *Andrew can trust what a church is charged and whether access stays up*. Honesty over live proof: **0 connected churches**; no live Checkout was completed this session.

Pre-fix → post-fix where this PR changed the number.

| Pillar | Score | Why this number |
|--------|-------|-----------------|
| **Reliability** | **3 → 4 / 5** | Signed webhooks + hourly trial/grace crons exist. Checkout fallback was `/billing/success` **live 404** (fixed). Failed webhook handlers are now retryable (fixed). `checkAccess` / `requireFeature` now honor the same 7-day `past_due` grace as `checkChurchPaidAccess` (`hasPaidBillingAccess`). |
| **Trust** | **2 → 3 / 5** | Live monthly Stripe **matches** homepage $49/$99/$149. Portal still showed $149 Plus / $199 Pro (**fixed**). Annual 25% is **false** vs Stripe. Founding $49 is the list price. Referral credits now use live list $49/$99/$149 (**fixed**). |
| **Security** | **4 / 5** | `constructEvent` + raw body on `/api/billing/webhook`. CSRF-exempt correctly. Checkout/portal are admin or church-admin gated. Circuit breaker on outbound Stripe. Remaining: webhook secret required at boot; disputes not subscribed. |
| **Polish** | **3 / 5** | Portal billing tab, retention modal, Stripe Customer Portal (#158 return URL). Upgrade/downgrade copy was a version behind Stripe (fixed). Lifecycle billing CTAs still use `APP_URL/portal` (marketing now **307s** to `/church-portal`, so not a 404). |
| **Observability** | **2 / 5** | Status component `stripe_webhook` = keys present. Admin **Billing analytics** APIs are **DEAD** in the SPA. No Stripe Dashboard mismatch alarm. |

**Overall: ~3.2 / 5 — monthly Checkout can be honest after this PR; annual and founding copy are still wrong on the marketing site. Grace is now the same rule on WS and feature APIs.**

---

## 1. Inventory (what exists)

### Code

| Piece | Where |
|-------|--------|
| Price IDs + Checkout + webhooks + `checkAccess` | `relay-server/src/billing.js` |
| Admin Checkout / portal / webhook HTTP | `relay-server/src/routes/billing.js` |
| Church self-serve (status, upgrade, downgrade, cancel, reactivate, retention) | `relay-server/src/churchPortal.js` |
| Signup onboard + Stripe session | `relay-server/src/routes/churchAuth.js` `POST /api/church/app/onboard` |
| Paid WS gate | `checkChurchPaidAccess` in `server.js` |
| Feature middleware | `requireFeature` → `billing.checkAccess` |
| Trial + grace crons | `checkExpiredTrials` / `enforceGracePeriods` hourly in `server.js` |
| Trial/dunning emails | `lifecycleEmails.js` (7d / 5d / 1d / expired / payment-failed / grace) |
| Catalog bootstrap (not necessarily what is live) | `relay-server/scripts/setup-stripe.js` |
| Time-boxed event **without** Stripe | `eventMode.js` + `POST /api/events/create` (admin) |
| Portal UI copy | `public/portal/portal.js` + `portal.html` |

### Railway (names only)

Present on `ATEMSchool-Tally` / service `tally` / production:

`STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_CONNECT`, `STRIPE_PRICE_CONNECT_ANNUAL`, `STRIPE_PRICE_PLUS`, `STRIPE_PRICE_PLUS_ANNUAL`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_PRO_ANNUAL`, `STRIPE_PRICE_MANAGED`, `STRIPE_PRICE_MANAGED_ANNUAL`, `STRIPE_PRICE_EVENT`.

**Not present:** `STRIPE_PRICE_CONNECT_FOUNDING`, `TALLY_REQUIRE_ACTIVE_BILLING` (defaults **true** in production).

MCP did not return values. Do **not** paste secrets. Match IDs in Railway against the live price table below.

### Live Stripe webhook

Endpoint `https://api.tallyconnect.app/api/billing/webhook` (**enabled**), events:

`checkout.session.completed`, `customer.subscription.created`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_failed`, `invoice.payment_succeeded`.

**Not subscribed (code handles them anyway):** `invoice.paid`, `invoice.upcoming`, `customer.subscription.trial_will_end`, `charge.dispute.created`, `charge.dispute.closed`.

Live `POST` without signature still returns **400 Missing stripe-signature header** (feature audit + this probe’s class of check).

---

## 2. Price scorecard (live Stripe vs site)

Read 2026-09-09 from livemode `GET /v1/prices?active=true` (product names + `metadata.tally_tier`). Amounts in USD.

| Tier | Marketing monthly | Live Stripe monthly | Live Stripe annual | Annual vs 12× month | Self-serve? |
|------|-------------------|---------------------|--------------------|---------------------|-------------|
| **Connect** | Founding **$49** (list ~~$79~~) | **$49** `tally_connect_monthly` | **$588** `tally_connect_annual` | **0% off** | Yes |
| **Plus** | **$99** | **$99** `tally_plus_monthly` | **$1,188** | **0% off** | Yes |
| **Pro** | **$149** | **$149** `tally_pro_monthly` | **$1,788** | **0% off** | Yes |
| **Enterprise** | Card **$499**; table **Custom**; Andrew wants **Custom** | **$499** / yr **$4,990** (~2 months free) | Not −25% | Checkout **blocked** |
| **Event** | **$99** one-time | **$99** `tally_event_one_time` | n/a | Yes (`mode: payment`) |

Live price IDs (for Railway matching — not secrets):

| Env | Live id | Amount |
|-----|---------|--------|
| `STRIPE_PRICE_CONNECT` | `price_1T4BLvE1Xo2A4Mzyi4m5CbEZ` | $49 / mo |
| `STRIPE_PRICE_CONNECT_ANNUAL` | `price_1T4BUmE1Xo2A4Mzy8JiECBlX` | $588 / yr |
| `STRIPE_PRICE_PLUS` | `price_1T4BLwE1Xo2A4MzyuPQVtDGy` | $99 / mo |
| `STRIPE_PRICE_PLUS_ANNUAL` | `price_1T4BUnE1Xo2A4MzyndaHORrr` | $1,188 / yr |
| `STRIPE_PRICE_PRO` | `price_1T4BLxE1Xo2A4MzysmRYOYZs` | $149 / mo |
| `STRIPE_PRICE_PRO_ANNUAL` | `price_1T4BUnE1Xo2A4MzyD51iCCxE` | $1,788 / yr |
| `STRIPE_PRICE_EVENT` | `price_1T4BLzE1Xo2A4MzyI6Y9mwWX` | $99 once |
| `STRIPE_PRICE_MANAGED` | `price_1T5WyeE1Xo2A4MzytTbTcLtA` | $499 / mo |
| `STRIPE_PRICE_MANAGED_ANNUAL` | `price_1T5WykE1Xo2A4MzyeOB9TYl0` | $4,990 / yr |

`scripts/setup-stripe.js` intends Connect/Plus/Pro annual at **9 × monthly** ($441 / $891 / $1,341) and a duplicate founding product also at $49. **Those annual amounts are not live.** Re-running the script would attach env vars to **whichever active monthly/yearly price already exists** on the product (`findPrice` takes the first match) — it will not automatically create the −25% prices.

Referral credit table in `billing.js` (`TIER_MONTHLY_CENTS`) now matches live list **$49 / $99 / $149 / Event $99**. Enterprise stays `null` (manual follow-up).

---

## 3. End-to-end flows

### 3.1 Checkout (subscriptions)

```
POST /api/church/app/onboard  →  billing.createCheckout (if Stripe on)
POST /api/billing/checkout    →  requireAdmin  (staff)
```

- Tiers allowed: `connect | plus | pro | event`. **`managed` 400** (“custom pricing”).
- Subscriptions: Stripe Checkout `mode: subscription`, `trial_period_days: 30`, `allow_promotion_codes: true`.
- Event: `mode: payment`, no trial on the session.
- Metadata: `churchId`, `tier`, `billingInterval`.
- Default success/cancel **were** `{APP_URL}/billing/success` and `/billing/cancel`. Live: **both 404** on `tallyconnect.app` and `api.tallyconnect.app`. **Fixed** to `RELAY_URL/church-portal` (same pattern as #158 reactivate). Landing may still pass its own `successUrl`.

Onboard with Stripe enabled: church row `billing_status=pending`, `billing_trial_ends=+30d`, plus a pending `billing_customers` row. Product access: `REQUIRE_ACTIVE_BILLING` + Stripe → **denied** until webhook activates. Marketing copy: “no credit card required.” Stripe Checkout with a trial **collects a card** unless the session opts out (`payment_method_collection` is not set). If the landing page does not send the user to `checkoutUrl`, they have an account that **cannot connect**.

### 3.2 Customer portal

Church `GET /api/church/billing` builds `billingPortal.sessions.create` with `return_url` = `/church-portal` (#158). Admin `POST /api/billing/portal` default return was `APP_URL` (marketing home); **now** `/church-portal`.

Needs `stripe_customer_id`. No customer until Checkout completes.

### 3.3 Webhooks

Raw body captured in `server.js` for `/api/billing/webhook`. Signature required. Idempotency table `processed_webhook_events`.

| Event | Handler | Live subscribed? |
|-------|---------|------------------|
| `checkout.session.completed` | Activate church `active`; payment/reactivation email | Yes |
| `customer.subscription.created/updated` | Mirror Stripe status; `trialing`/`active` keep access | Yes |
| `customer.subscription.deleted` | `canceled` → deactivate | Yes |
| `invoice.payment_failed` | `past_due` + 7-day `grace_ends_at` + email | Yes |
| `invoice.payment_succeeded` | Recover `past_due` → `active` | Yes |
| `invoice.paid` | Same recovery (**aliased this PR**) | **No** (add in Dashboard if Stripe starts sending it) |
| `invoice.upcoming` | Email | **No** |
| `trial_will_end` | Log only (lifecycle emails own 7/5/1) | **No** |
| Disputes | Flag `disputed` / restore or deactivate | **No** |

Checkout completion sets local status **`active` even during the Stripe trial**. Stripe will also send `customer.subscription.updated` with `status=trialing`. Last writer wins — a later `updated` can set the church back to `trialing` (still allowed). Fine for access; confusing in the portal badge.

### 3.4 Trial expiry emails + cron

Lifecycle queries `billing_status = 'trialing'` at 7 / 5 / 1 days. Expired cron: `trialing` AND `billing_trial_ends < now` → `trial_expired`, email, WS close `billing_trial_expired`.

**Gap:** onboard-pending churches are not `trialing`, so they get **no** trial emails and **no** expiry cron. Stripe-side trial (after they complete Checkout) is the real trial clock; local `billing_trial_ends` from onboard may not match Stripe’s `trial_end`.

### 3.5 Grace + reactivate

Payment fail → 7 days grace. `checkChurchPaidAccess` **and** `billing.checkAccess` / `requireFeature` share `hasPaidBillingAccess`: WS **and** feature APIs stay up while `grace_ends_at` is in the future. (Previously feature APIs 403’d while the booth stayed connected.)

Grace cron → `inactive`, email, WS close `billing_grace_expired`.

Reactivate: Checkout **without** trial; statuses `canceled | inactive | trial_expired | disputed`. Enterprise → contact support. Success URL fixed in #158.

### 3.6 Event one-time

Two products share the word “event”:

1. **Paid Event tier** — `tier=event`, Stripe one-time $99, `mode: payment`. After `checkout.session.completed`, church is `active` with 1 room / all devices (`TIER_LIMITS.event`). No expiry from payment itself.
2. **Admin EventMode** — `POST /api/events/create`, `church_type=event`, `event_expires_at` (default 72h), **no Stripe**. Expiry loop disconnects when the window ends.

Self-serve Event Checkout does **not** call `EventMode.createEvent`. A church that pays $99 does not automatically get a 72-hour fuse unless someone also sets Profile `church_type`.

### 3.7 Enterprise / annual

Self-serve blocked in Checkout, onboard, upgrade, reactivate. Staff can still `PUT /api/churches/:id/billing` to `managed`. Live $499 prices exist for invoicing, not the public button.

Annual is a **separate Price ID**, not a Stripe coupon. Charging annual today is **full 12 months**, not −25%.

---

## 4. Trust: founding + Connect vs homepage

| Claim | Reality |
|-------|---------|
| Homepage Connect ~~$79~~ **$49** founding | Stripe Connect **$49**. No $79 price. Founding is not a discount in the catalog. |
| Signup “limited spots at $49/mo” | Every Connect Checkout uses `STRIPE_PRICE_CONNECT` ($49). No founding price env in Railway. |
| Signup “Annual (save 25%)” | Live annual = 12× month. **False.** |
| Homepage Enterprise **$499** vs table **Custom** | Checkout already Custom (blocked). Card sticker is tally-landing **P1** — not changed here. |
| Portal upgrade Plus **$149** / Pro **$199** | Was **BROKEN** vs Stripe $99/$149. **Fixed** to match live monthly. |
| Connect: 1 room, ATEM/OBS/vMix | `TIER_LIMITS.connect` matches. Homepage “one room on Connect” matches. Hero copy lists ProPresenter as a product capability (Plus+ in gates). |
| Plus Autopilot | `checkAccess('autopilot')` allows **Plus**. Portal billing JSON sets `features.autopilot` false for Plus (`!['connect','plus']`). UI sells Autopilot as **Pro**. Gates disagree. |
| Pro 5 rooms | Homepage + `TIER_LIMITS.pro.rooms = 5` + portal “Up to 5 rooms” agree. |

---

## 5. Security

| Control | Verdict |
|---------|---------|
| Webhook signature | **WORKING** — `constructEvent(rawBody, sig, STRIPE_WEBHOOK_SECRET)`. Boot throws if secret missing when key is set. |
| Raw body | **WORKING** — `express.json` `verify` keeps `req.rawBody` for `/api/billing/webhook`. |
| CSRF | **WORKING** — webhook exempt; church billing mutations use cookie CSRF. |
| Idempotency | **PARTIAL → WORKING (this PR)** — insert-before-process is correct for duplicates; delete-on-throw so Stripe retries are not skipped. |
| Customer portal | Session only if `stripe_customer_id`. Return URL is now `/church-portal`. |
| Admin Checkout | `requireAdmin` + rate limit 5/min. Church upgrade is church-admin + billing rate limit. |
| Secrets in repo | None. Price IDs above are Stripe object ids. |

---

## 6. Working as intended?

**Monthly Checkout vs homepage: yes. Annual, founding, portal copy (pre-fix), and “no CC trial”: no.**

### P0 — this PR

1. **Checkout fallback 404.** `createCheckout` defaulted to `/billing/success` and `/billing/cancel` (live 404). Now `/church-portal`. Portal session default return also `/church-portal`.
2. **Portal sold the old ladder.** Plus $149 / Pro $199 / Connect $79 vs Stripe $99 / $149 / $49. Copy updated.
3. **Webhook miss on retry.** Idempotency insert survived a thrown handler; Stripe’s retry was skipped. Delete on failure.
4. **`invoice.paid` alias.** Same recovery as `invoice.payment_succeeded`. Live endpoint still uses `payment_succeeded` only — add `invoice.paid` in Dashboard when convenient.

### P0 — Andrew / Stripe Dashboard (not this repo)

1. **Annual prices are not −25%.** Either create new yearly prices at 9× monthly and point `STRIPE_PRICE_*_ANNUAL` at them, or remove “save 25%” from tally-landing signup.
2. Confirm Railway price IDs equal the table in §2 (values not readable here).

### P1

- tally-landing Enterprise card still **$499**; Andrew wants **Custom**. Comparison table already Custom. **Do not change landing from this repo.**
- Founding / “limited spots” copy while Connect list is $49.
- Subscribe Stripe endpoint to disputes + `invoice.upcoming` (or delete dead handlers).
- `checkAccess` now honors grace the same way `checkChurchPaidAccess` does (`hasPaidBillingAccess`) (**fixed**).
- Portal `features.autopilot` vs `checkAccess` Plus vs Pro.
- Referral `TIER_MONTHLY_CENTS` now matches live list $49/$99/$149 (**fixed**).
- Onboard `pending` vs advertised no-CC 30-day trial; align Stripe `payment_method_collection` or local `trialing` without Checkout.
- Event $99 Checkout vs EventMode 72h fuse — pick one product story.
- Lifecycle billing CTAs still `APP_URL/portal` (now 307s; still messy).
- `setup-stripe.js` founding product duplicates Connect at $49; Enterprise $499 leftover.

### P2

- Admin billing analytics routes **DEAD** in SPA.
- `_onPaymentSucceeded` now clears `billing_customers.grace_ends_at` as well as runtime (**fixed**).
- Checkout completion marks `active` before Stripe trial ends (`trialing` webhook may follow).
- `requireFeature` returns **403**; OpenAPI mentions 402.
- No `integration_identifier` on Checkout (Stripe best practice, not customer-facing).

---

## 7. What this PR does **not** do

- Does not edit tally-landing (Enterprise Custom, annual 25%, founding copy).
- Does not write Stripe Prices or webhook subscriptions.
- Does not change the retention coupon (sales-gated).
- Referral free-month credits aligned to live list (#170).
- Does not invent Railway secret values.

Follow-up (this leftover): `checkAccess` / `requireFeature` now share `hasPaidBillingAccess` with the WS gate so `past_due` + unexpired 7-day grace keeps feature APIs up. `_onPaymentSucceeded` also nulls `billing_customers.grace_ends_at`. Trial calendar expiry is still live-checked only on the WS path (hourly cron is the other).

---

## Validation

- `cd relay-server && npx vitest run tests/billing.test.js tests/billing-edge-cases.test.js tests/billing.queryClient.test.js tests/stripe-webhook-edge.test.js tests/billing-webhook.test.js tests/billingRoutes.test.js tests/regression-billing.test.js tests/regression-feature-gating.test.js`
- Live unauth: `GET https://tallyconnect.app/billing/success` → **404**; `GET https://tallyconnect.app/church-portal` → **307** `api.tallyconnect.app/church-portal`; Stripe livemode prices as §2.
- Authenticated portal billing tab was **not** clicked (no church session). Price strings are in `portal.js` / `portal.html`.
