# Client Deposit Tracking — Design Spec

## Overview

FacadeXPM currently has no concept of a client deposit (มัดจำ). Contractors
often collect an upfront deposit from a client when a project starts, then
progressively deduct a percentage of it from every subsequent payment
collected for that site until the deposit is used up. This spec adds that
tracking as a **paid module** (`client_deposits`), gated the same way
`purchase_orders` and `labor_subcontractors` are gated today.

This is Sub-project A of a two-part effort. Sub-project B (a "full site
overview" popup — deposit + retention + income summary, opened by clicking
a site name from Sites.jsx or Dashboard.jsx) is out of scope here and will
get its own spec once this one ships, since it depends on the data this
spec introduces.

## Goals

- Record a client deposit as a real income transaction (not a separate
  ledger), tagged with a new `income_type`.
- Every subsequent normal income collected for that site automatically
  deducts a site-configured percentage of the deposit, computed on the
  pre-VAT amount, until the deposit balance reaches zero.
- Gate the whole feature behind a new `client_deposits` module — tenants
  without it see today's income form and tab list unchanged.
- Add a "มัดจำ" summary tab (visible only with the module) listing, per
  site, how much deposit was collected, how much has been deducted, and
  how much remains.

## Non-Goals

- No dedicated Dashboard KPI card for deposits (unlike the Retention
  feature). Not requested for this sub-project; can be added later or as
  part of Sub-project B's popup.
- No site-name-click popup (Sub-project B).
- No retroactive recalculation: if a site's `default_deposit_pct` changes,
  or a past income row is edited/deleted, already-saved
  `deposit_deduction` values on *other* rows are not rewritten. This
  matches the existing behavior of `retention`/`vat`/`tax_withheld`, which
  are computed once at save time from the site's *current* defaults, not
  live-recalculated. Documented as an explicit, deliberate simplification,
  not an oversight.
- No optimistic locking against concurrent income entry for the same
  site. Two admins saving income for the same site at nearly the same
  moment could each compute against a slightly stale remaining balance,
  causing the sum of `deposit_deduction` to overshoot the true remaining
  balance by a small amount in a rare race. The app has no concurrency
  control anywhere else (no other table uses row versioning), so this is
  an accepted, pre-existing risk class, not a new gap introduced here.

## Data Model

### `sites` — one new column

```sql
ALTER TABLE sites ADD COLUMN default_deposit_pct NUMERIC DEFAULT 0;
```

Same shape as `default_retention_pct`: nullable-by-default-zero, editable
in the Sites form's "Income defaults" section, used to auto-fill new
income entries for that site.

### `incomes` — two new columns

```sql
ALTER TABLE incomes ADD COLUMN income_type TEXT NOT NULL DEFAULT 'ปกติ'
  CHECK (income_type IN ('ปกติ', 'มัดจำ'));
ALTER TABLE incomes ADD COLUMN deposit_deduction NUMERIC DEFAULT 0;
```

- `income_type = 'มัดจำ'` marks a row as the deposit collection itself.
  It still goes through the normal VAT / withholding-tax / retention
  calculation exactly like any other income row (per explicit user
  decision) — the only thing special about it is that `deposit_deduction`
  is always `0` on a มัดจำ row (a deposit row never deducts from itself).
- `income_type = 'ปกติ'` (the existing default, unchanged for every
  current row) is a normal collection. If the site has
  `default_deposit_pct > 0` and a remaining deposit balance, its
  `deposit_deduction` is computed automatically (see Calculation Logic
  below) and subtracted from `received_amount`.
- Tenants without the `client_deposits` module never see the
  "ประเภท" selector; every row they create is `income_type = 'ปกติ'`
  with `deposit_deduction = 0`, which is indistinguishable from today's
  behavior.

### New view: `site_deposit_summary`

Mirrors `site_retention_summary`'s shape and security posture:

```sql
CREATE VIEW site_deposit_summary WITH (security_invoker = true) AS
SELECT
  s.id                      AS site_id,
  s.site_number,
  s.name,
  s.default_deposit_pct,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)  AS total_deposit,
  COALESCE(SUM(i.deposit_deduction), 0)                                    AS total_deducted,
  COALESCE(SUM(i.amount_no_vat) FILTER (WHERE i.income_type = 'มัดจำ'), 0)
    - COALESCE(SUM(i.deposit_deduction), 0)                                AS remaining_balance
FROM sites s
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.default_deposit_pct;
```

`WITH (security_invoker = true)` is mandatory — this codebase had a real
cross-tenant RLS leak in the past from a view that omitted it
(`sites_progress`); every new view carries it as a hard rule, not a
suggestion.

A single `LEFT JOIN` + `GROUP BY` (same shape as `site_retention_summary`
and `site_financial_summary`) avoids fan-out double-counting since there's
exactly one row per income per site.

## Calculation Logic

Extends the existing `calcIncomeAmounts` pattern (`ExcelUpload.jsx`) and
the equivalent live calculation in `Income.jsx`'s manual form.

**Saving a `มัดจำ` row:**
```
vat            = round2(noVat * site.default_vat_pct / 100)
taxWithheld    = round2(noVat * site.default_tax_withheld_pct / 100)
retention      = round2(noVat * site.default_retention_pct / 100)
depositDeduction = 0
receivedAmount = round2(noVat + vat - taxWithheld - retention)
```
(Identical to today's normal-row formula — a มัดจำ row behaves exactly
like a ปกติ row except it never deducts from itself.)

**Saving a `ปกติ` row:**
```
vat            = round2(noVat * site.default_vat_pct / 100)
taxWithheld    = round2(noVat * site.default_tax_withheld_pct / 100)
retention      = round2(noVat * site.default_retention_pct / 100)

remainingBalance   = site_deposit_summary.remaining_balance for this site
                      (+ this row's OWN prior deposit_deduction, if editing
                       an existing row — see "Editing" below)
proposedDeduction  = round2(noVat * site.default_deposit_pct / 100)
depositDeduction   = min(remainingBalance, proposedDeduction), floored at 0

receivedAmount = round2(noVat + vat - taxWithheld - retention - depositDeduction)
```

Once `remaining_balance` reaches `0`, every subsequent `ปกติ` row for that
site automatically computes `depositDeduction = 0` — no special-casing
needed elsewhere in the codebase; the `min()` clamp handles exhaustion
naturally.

**Editing an existing `ปกติ` row:** the row's own previously-saved
`deposit_deduction` must be added back to the fetched `remaining_balance`
before computing the new deduction, otherwise the row would be charged
against a balance that still includes its own earlier deduction (double
counting). Example: site has `remaining_balance = 5,000` in the view
*after* row R's existing `deposit_deduction = 2,000` was subtracted; the
true balance available to R when re-editing it is `5,000 + 2,000 =
7,000`.

**Fetching remaining balance:** a new hook `useSiteDepositBalance(siteId)`
queries `site_deposit_summary` filtered to the one site (thin wrapper
around `useQuery`, same pattern as `useSiteRetentionSummary`). The
Income form calls it whenever the selected site changes, to display the
computed `deposit_deduction` live (as a read-only helper line, the same
UI pattern already used for the VAT/retention amount previews at
`Income.jsx:106,118`).

## Module Gating

New module key `client_deposits`, added the same way `purchase_orders`
was added
(`supabase/migrations/2026-08-17-03-purchase-orders-module-key.sql` is
the exact precedent to follow):

```sql
ALTER TABLE tenant_modules DROP CONSTRAINT tenant_modules_module_key_check;
ALTER TABLE tenant_modules ADD CONSTRAINT tenant_modules_module_key_check
  CHECK (module_key IN ('payroll','labor_subcontractors','purchase_orders','client_deposits'));
```

Gated surfaces (all check `hasModuleAccess('client_deposits')`, same
pattern as `TABS[].module` / `ProtectedPage` elsewhere in `App.jsx`):
- The "ประเภท" (income_type) selector on the Income form — hidden
  entirely without the module, so every row a non-subscribed tenant
  creates stays `income_type='ปกติ'` with `deposit_deduction=0`.
- The `default_deposit_pct` field on the Sites form's Income-defaults
  section.
- The new "มัดจำ" tab (`TABS` entry, `module: 'client_deposits'`,
  `minRole: 'ADMIN'`, same role floor as `income`/`retention`).

Tenant admins configure module access exactly as they do for the other
three gated modules today (existing `tenant_modules` mechanism — no new
UI needed for *granting* the module in this sub-project; pricing tiers
are a separate business decision the user will set up later).

## New Page: `src/pages/Deposits.jsx`

Read-only table (no manual actions — deduction is fully automatic
through income entries, unlike Retention's manual "mark as released"),
filtered to sites where `total_deposit > 0` (mirrors Retention.jsx's
filter to `total_retention > 0`):

| Column | Source |
|---|---|
| ไซท์งาน | `site_deposit_summary.name` |
| % มัดจำ | `default_deposit_pct` |
| ยอดมัดจำที่เก็บ | `total_deposit` |
| หักไปแล้ว | `total_deducted` |
| คงเหลือ | `remaining_balance` |
| สถานะ | badge: `remaining_balance > 0` → "คงเหลือ" using the existing `.badge-paid` class (`src/index.css:142`, green — confirmed via direct read, not by name alone); `remaining_balance <= 0` → "หักครบแล้ว" using the existing `.badge-finished` class (`src/index.css:139`, muted gray — a fully-deducted deposit is a neutral/complete state, not an alarm, unlike Retention's red overdue case, so no red class is used here) |

Wired into `App.jsx` exactly like `Retention.jsx`: `lazy()` import, a
`TABS` entry (`id: 'deposits', label: '💰 มัดจำ', minRole: 'ADMIN',
module: 'client_deposits'`) placed after the `retention` entry, and a
`renderPage()` case.

## Testing

- Unit-level: extend the existing `calcIncomeAmounts`-style test coverage
  (if any exists for `ExcelUpload.jsx`'s helper) to cover the deposit
  deduction formula, including the exhaustion/clamp case
  (`proposedDeduction > remainingBalance`) and the edit-row add-back case.
- Manual (documented limitation, same as the Retention plan): no login
  credentials available to implementer/reviewer subagents, so full
  click-through in a live browser is not performed during
  implementation; build + `npm test` are the verification bar, consistent
  with how the Retention feature was verified.
- Migration verification: same rigor as the Retention migration —
  `information_schema.columns` check, a direct `SELECT` against the new
  view, and confirming `security_invoker=true` via `pg_class.reloptions`
  on the live database.

## Open Questions Resolved During Brainstorming

- Deposit scoped to site, not client (mirrors Retention's precedent).
- Deduction is automatic (%-based on pre-VAT amount), not manual entry.
- Deposit collection is a real `incomes` row (not a separate table).
- Deposit rows compute VAT/tax/retention identically to normal rows.
- A summary tab is wanted; a fuller "click site name → popup" view is
  wanted too but deferred to Sub-project B since it also needs retention
  data and touches Sites.jsx/Dashboard.jsx beyond this feature's scope.
