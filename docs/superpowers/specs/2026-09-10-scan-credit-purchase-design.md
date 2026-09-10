# Self-Service Scan Credit Purchase — Design

## Problem

The document-scan monthly quota (shipped v1.16.2: `packages.max_document_scans_per_month`, tier-only — Free 10, Solo 50, Pro Team 100, Business 500, Enterprise unlimited) gives a tenant exactly one way to get more scans: upgrade their whole package tier. A tenant who just wants a handful of extra scans this month, without moving to a pricier tier permanently, has no path today.

## Goal

Let a tenant buy a fixed-size bundle of extra scan credits, paid for via the same self-service PromptPay flow already used for package upgrades, without touching that existing (working, proration-aware) subscription billing code at all.

## Decisions made (via direct conversation with the business owner)

1. **Fixed-size bundles, not pay-per-scan.** A tenant picks from a short list of preset bundles ("+20 scans for ฿X", "+50 for ฿Y", ...) rather than typing an arbitrary quantity. Simpler checkout, matches how package pricing is already a fixed number per tier.
2. **Credits roll over — they never expire.** Once purchased, credits sit in a balance until used, regardless of calendar month. Unlike the tier's monthly allowance (which resets every month), a paid credit is never silently lost.
3. **A ledger, not a mutable balance column.** `tenants.scan_credit_balance` would be simpler to query but every other valuable/quantity concept in this app (`stock_movements`, `audit_logs`, `quotation_revisions`) is an append-only ledger, not a bare counter — matches house convention, and gives a real audit trail for something tied to real money. Current balance = `SUM(delta)` for the tenant.
4. **A parallel table and edge-function pair, not an extension of `payment_intents`.** That table is tightly coupled to package/proration concepts (`package_id NOT NULL`, `target_plan_expires_at`, upgrade-vs-downgrade rejection logic) that don't apply to a credit purchase. Reusing it would mean loosening constraints on a table the existing, working subscription billing code depends on. A separate `credit_purchase_intents` table mirrors the same shape for the parts that do apply (Omise source/charge ids, status, confirmed_at) and nothing else.
5. **Bundles are platform-admin-configurable data, not hardcoded in frontend code.** Matches how `packages.max_document_scans_per_month` etc. are already admin-editable rather than constants — a new `scan_credit_bundles` table, managed the same place (`TenantManagement.jsx`) or a new small admin screen.

## Current system facts this design depends on

- **`omise-create-charge`** (edge function) is the existing self-service PromptPay pattern: validates the request against the caller's own JWT/RLS, computes an amount, inserts a `payment_intents` row, creates an Omise Source + Charge (PromptPay, THB), returns a scannable QR image URL. This spec's new purchase flow copies this shape for a `bundle_id` instead of a `package_id` — no proration logic needed (a credit purchase is always a flat bundle price, never prorated).
- **`omise-webhook`** (public, `verify_jwt: false`) receives Omise's event, re-fetches the charge server-to-server (never trusts the webhook body's own status field), looks up `omise_charge_id` in `payment_intents`, and on a confirmed successful charge calls `activateTenantFromIntent()`. This spec adds a second lookup: if the charge id isn't found in `payment_intents`, check `credit_purchase_intents` before giving up: `if (!intent) { check credit_purchase_intents too }`.
- **`UpgradeModal.jsx`** is the existing client UX pattern: shows a PromptPay QR code, polls the relevant intents table on an interval until `status` flips away from `pending`, then reports success/failure. This spec's new purchase modal reuses the same QR+poll shape against `credit_purchase_intents` instead of `payment_intents`.
- **`extract-po-document`** (edge function, v6 as of this session) currently calls `tenant_under_document_scan_limit()` (a boolean RPC) before the Anthropic call, and inserts a `document_scan_usage` row after a successful call. This spec changes both: the RPC needs to also report whether the allowed scan should draw from the monthly quota or from purchased credits, and the post-call step needs to debit a credit when the tier quota was already exhausted.

## Data model

```sql
-- Admin-configurable bundle catalog -- NOT hardcoded in the frontend, so a
-- pricing change doesn't need a deploy. Managed from TenantManagement.jsx
-- (or a small new admin screen), same platform-admin-only access as
-- editing packages' quota numbers.
CREATE TABLE scan_credit_bundles (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  label      TEXT NOT NULL,        -- e.g. "+20 ครั้ง"
  credits    INT NOT NULL CHECK (credits > 0),
  price_baht NUMERIC NOT NULL CHECK (price_baht > 0),
  active     BOOLEAN NOT NULL DEFAULT true,
  sort_order INT NOT NULL DEFAULT 0
);
-- No tenant_id -- this is a platform-wide catalog, not per-tenant data.
-- RLS: platform_admins-only write (mirrors how `packages` itself is
-- edited only by platform admins), authenticated read (every tenant needs
-- to see the options to buy one).

-- Append-only ledger. Purchase = +credits (inserted by the webhook on
-- confirmed payment). Usage = -1 (inserted by extract-po-document when a
-- scan draws from credit rather than the monthly tier allowance).
CREATE TABLE scan_credit_ledger (
  id             UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id      UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  delta          INT NOT NULL,        -- positive = purchase, negative = consumption
  reason         TEXT NOT NULL,       -- 'purchase' | 'scan_usage'
  reference_id   UUID,                -- credit_purchase_intents.id or document_scan_usage.id
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Balance = SUM(delta) WHERE tenant_id = X. Index on tenant_id for that
-- aggregate; no month-scoping (credits never expire, per Decision 2).

-- Mirrors payment_intents' shape for the parts that apply to a flat-price
-- bundle purchase -- no package_id, no proration/target_plan_expires_at.
CREATE TABLE credit_purchase_intents (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  bundle_id        UUID NOT NULL REFERENCES scan_credit_bundles(id),
  credits          INT NOT NULL,      -- copied from the bundle at purchase time, so a later bundle edit never changes a past order's meaning
  amount           NUMERIC NOT NULL,  -- baht, copied from the bundle at purchase time, same reason
  omise_source_id  TEXT,
  omise_charge_id  TEXT UNIQUE,
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','successful','failed','expired')),
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at     TIMESTAMPTZ
);
```

RLS shape for both new tenant-scoped tables mirrors `payment_intents` exactly: tenant members can `SELECT` their own tenant's rows; only `is_admin_or_owner()` can `INSERT` (starting a purchase is a billing-level action); no `authenticated` `UPDATE` policy on `credit_purchase_intents` (only the webhook, via service-role, transitions `status` — copying `payment_intents`' own documented reason for that restriction verbatim).

## Business logic

### Checking + consuming access (replaces the current boolean-only check)

`tenant_under_document_scan_limit()` becomes `tenant_scan_access_check()`, returning a row instead of a bare boolean:

```sql
CREATE OR REPLACE FUNCTION tenant_scan_access_check()
RETURNS TABLE(allowed BOOLEAN, source TEXT)  -- source: 'quota' | 'credit' | null
...
```

Logic: compute the tier's monthly usage the same way as today (`document_scan_usage` count since `date_trunc('month', now())`); if under the tier limit (or tier limit is NULL/unlimited), return `(true, 'quota')`. Otherwise compute the credit balance (`SUM(delta)` from `scan_credit_ledger`); if `> 0`, return `(true, 'credit')`. Otherwise `(false, null)`.

`extract-po-document` calls this before the Anthropic call (unchanged position — still before the money-spending step). On a successful Anthropic response, it still inserts into `document_scan_usage` unconditionally (that table stays a pure "a call happened" log, unchanged meaning) — but if `source = 'credit'`, it ALSO inserts a `-1` row into `scan_credit_ledger` with `reason = 'scan_usage'`, `reference_id` = the new `document_scan_usage` row's id.

### Buying a bundle

New edge function `credit-purchase-create-charge`, structurally a trimmed copy of `omise-create-charge`: validate JWT, look up the requested `scan_credit_bundles` row (must be `active`), insert a `credit_purchase_intents` row copying `credits`/`price_baht` from the bundle, create an Omise PromptPay Source + Charge for that flat amount (no proration branch — every bundle purchase goes through Omise, there's no "credit fully covers it" zero-cost case like the package-upgrade flow has), return the QR image URL. No `target_plan_expires_at`, no upgrade/downgrade branching — meaningfully simpler than `omise-create-charge` because bundles have no notion of a billing cycle.

### Confirming payment

`omise-webhook` gains one more branch: after its existing `payment_intents` lookup comes back empty, look up the same `charge.id` in `credit_purchase_intents`. If found and the confirmed charge is `successful`, mark that intent `successful`/`confirmed_at`, then insert a `+credits` row into `scan_credit_ledger` (`reason = 'purchase'`, `reference_id` = the intent's id) — this replaces the `activateTenantFromIntent()` call that path uses for package upgrades, since a credit purchase has no tenant-row fields to update at all (no package change, no plan_expires_at) — it's purely a ledger entry.

## UI

- New modal (name TBD, e.g. `BuyScanCreditsModal.jsx`), structurally a trimmed copy of `UpgradeModal.jsx`'s QR-display-and-poll pattern, polling `credit_purchase_intents` instead of `payment_intents`.
- Entry points: (a) inline in the quota-exceeded error message surfaced from `extract-po-document`'s 429 response — a "ซื้อโควต้าเพิ่ม" link/button right where the block happens, the moment it's actually relevant; (b) optionally also reachable from Settings for a tenant who wants to buy ahead of hitting the cap.
- A small "credits remaining: N" indicator somewhere reasonable (Settings, or near the scan upload button) — not required for the feature to work, but buying credits you can't see the balance of is a bad experience. Exact placement not decided.
- Platform-admin screen for managing `scan_credit_bundles` (create/edit/deactivate bundles) — likely a new small subtab in `TenantManagement.jsx`, same pattern as the existing package-quota editor.

## Error handling

- Bundle deactivated mid-purchase (between page load and clicking buy): `credit-purchase-create-charge` re-checks `active` server-side, not just trusting what the client displayed; returns a clear error if it's gone.
- Webhook receives a charge id matching neither table: unchanged existing behavior (ignore, per `omise-webhook`'s current "unknown charge" comment) — now correctly covers both intent types without special-casing.
- A tenant with a positive credit balance but their tier quota also has room left: quota is always consumed first (Decision embedded in `tenant_scan_access_check()`'s branch order) — credits are the fallback, not the first-choice source, so a paying tenant doesn't burn purchased credits while their free monthly allowance sits unused.

## Testing

- Unit tests for whatever pure logic can be extracted from `tenant_scan_access_check()`'s branch order (quota-first-then-credit) — the SQL function itself needs live-DB verification (same approach used for `tenant_under_document_scan_limit()` this session), not a JS unit test.
- Manual QA of the purchase flow end-to-end against a real (test-mode) Omise PromptPay charge, mirroring how the original package-upgrade flow was presumably verified — no automated test covers a real payment webhook round-trip.

## Open questions for the implementation plan

- **Actual bundle sizes and prices.** Nothing here — needs real numbers from the business owner before any migration seeds `scan_credit_bundles`. A reasonable starting shape to react to, not a proposal: bundles roughly scaled to each tier's own monthly number (e.g. something in the neighborhood of the Free tier's 10, Solo's 50, etc.) at a per-scan price the business owner sets — this spec deliberately does not guess actual baht amounts.
- **Where exactly the "credits remaining" indicator lives** — not decided, needs a placement call during implementation, not a blocking design question.
- **Whether Free-tier tenants can buy credits at all**, or only paid tiers — not discussed; current design doesn't exclude Free, but that's worth an explicit business decision before shipping (a Free tenant paying real money for scan credits is a different product posture than a paid tenant topping up).
