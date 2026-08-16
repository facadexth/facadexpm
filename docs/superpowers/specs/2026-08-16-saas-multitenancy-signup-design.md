# SaaS Multi-Tenancy + Signup Flow — Design

## Purpose

Convert FacadeX Dashboard from a single-company internal tool into a
self-serve, subscription-sellable product for SME contractors, without
disrupting the current FacadeX tenant's live data.

This spec covers the first two of four planned sub-projects:

1. **Multi-tenant data model + RLS** (this spec)
2. **Signup / new-company flow** (this spec)
3. Billing / Stripe — future spec, not covered here
4. Tenant admin / team invites — future spec, not covered here

## Background / decisions already made

- **Tenancy model:** 1 user = 1 tenant. No company-switcher (unlike PEAK
  Account, which the user considered and explicitly rejected as
  unnecessary complexity for this product).
- **Target customer:** SME contractors generally, not facade/glazing
  contractors specifically — the product must not assume FacadeX's own
  niche vocabulary is universal.
- **Monetization shape:** core subscription + paid add-on modules, not a
  single flat tier. Modules named so far: Payroll/HR/Assign, ผู้รับเหมาช่วง
  (labor subcontractors), Quotation (not yet built), แบบ/Takeoff estimate
  reading (not yet built).
- **Trial:** free, no credit card required.

## Core vs. module boundary

| Tier | Features |
|---|---|
| **Core** (every tenant, every plan) | Dashboard, ไซท์งาน (Sites), รายจ่าย (Expenses), รายรับ (Income), ลูกค้า (Clients), Supplier, หมวดหมู่ (Categories) |
| **Module: Payroll/HR** | Assign ช่าง, HR tab, worker OT/leave, salary records |
| **Module: ผู้รับเหมาช่วง** | Labor subcontractors, labor contracts, labor payments |
| **Module: Quotation** *(not yet built)* | future spec |
| **Module: Takeoff estimate** *(not yet built)* | future spec |

Sites was confirmed as core over async discussion: every Expenses and
Income row carries a `site_id` foreign key, so Sites is load-bearing for
both core financial features, not a separable add-on.

## 1. Multi-tenant data model

### New tables

```sql
CREATE TABLE tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  company_name TEXT NOT NULL,
  owner_user_id UUID NOT NULL REFERENCES auth.users(id),
  plan TEXT NOT NULL DEFAULT 'trial',       -- 'trial' | 'active' | 'expired'
  trial_ends_at TIMESTAMPTZ NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tenant_modules (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  module_key TEXT NOT NULL,                  -- 'payroll' | 'labor_subcontractors' | ...
  enabled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, module_key)
);
```

`tenant_modules` only ever holds rows for **paid, enabled** add-ons.
Core features need no row (always on). During an active trial, every
module is unlocked regardless of `tenant_modules` contents (see §3).

### Existing tables

Add `tenant_id UUID NOT NULL REFERENCES tenants(id)` to every
company-scoped table: `sites`, `expenses`, `incomes`, `suppliers`,
`clients`, `categories`, `workers`, `worker_assignments`, `worker_ot`,
`salary_records`, `labor_subcontractors`, `labor_contracts`,
`labor_payments`, `site_phases`, `user_roles`, `company_holidays`, and
any other table currently scoped only by RLS role checks (same set of
~19 tables covered by the 2026-08-15 RLS rollout).

FacadeX's own existing data gets backfilled into one `tenants` row
(`plan = 'active'`, `trial_ends_at` in the past) as part of the
migration — this is an existing-customer backfill, not a new-signup
path, and stays out of scope for the signup flow itself.

### `current_tenant_id()` helper

Mirrors the existing `current_user_role()` pattern:

```sql
CREATE OR REPLACE FUNCTION current_tenant_id()
RETURNS UUID
LANGUAGE sql STABLE SECURITY DEFINER
SET search_path = public
AS $$
  SELECT tenant_id FROM user_roles WHERE user_id = auth.uid() LIMIT 1;
$$;
```

Every existing RLS policy gets `AND tenant_id = current_tenant_id()`
added to its `USING`/`WITH CHECK` clause, on top of the existing role
check. This is a mechanical rewrite of all policies from the
2026-08-15 rollout — sized as its own implementation task per table.

### Module-gated RLS

Tables belonging to a paid module (`workers`, `worker_assignments`,
`worker_ot`, `salary_records`, `labor_subcontractors`,
`labor_contracts`, `labor_payments`) get a further condition:

```sql
AND (
  (SELECT trial_ends_at FROM tenants WHERE id = current_tenant_id()) > now()
  OR EXISTS (
    SELECT 1 FROM tenant_modules
    WHERE tenant_id = current_tenant_id() AND module_key = 'payroll'
  )
)
```

This is enforced at the database layer, not just hidden in the UI —
a tenant whose trial has expired and who hasn't purchased the module
cannot read or write these tables via direct API calls, even bypassing
the frontend.

## 2. Signup flow

1. Signup page collects: company name, email, password. No payment
   method.
2. `supabase.auth.signUp()` creates the `auth.users` row.
3. A new `handle_new_tenant_signup()` trigger (analogous to the
   existing `handle_new_user()` trigger) fires on `auth.users` insert
   and, in one transaction:
   - Inserts a `tenants` row: `owner_user_id = new user`,
     `plan = 'trial'`, `trial_ends_at = now() + interval '14 days'`.
   - Inserts a `user_roles` row linking the new user to the new tenant
     as `OWNER`.
   - Does **not** insert into `tenant_modules` — trial unlocks
     everything without needing rows there (see §3).
4. User is redirected into the app. All tabs are visible (trial
   grants every module). A persistent banner shows days remaining in
   the trial.

## 3. Entitlement resolution

Single function, used by both frontend gating and (conceptually)
mirrored in RLS:

```
hasModuleAccess(tenant, module_key) =
  tenant.trial_ends_at > now()
  OR module_key IN core-modules  // always true, no check needed
  OR module_key IN tenant.enabled_modules  // from tenant_modules
```

**Frontend:** `TABS` in `App.jsx` gains a `module` field per tab (null
for core tabs). `visibleTabs` filtering gains a `hasModuleAccess` check
alongside the existing `minRole` check.

**Backend:** RLS enforces the same rule directly in SQL (§1), which is
the actual security boundary — the frontend check exists only to avoid
showing a tab whose API calls would fail with a permission error.

## 4. Trial expiry behavior

When `trial_ends_at` has passed and the tenant has not selected a paid
plan:

- Tenant can still **log in and view** all previously-entered data
  (read-only) — this avoids a jarring full lockout that could cause a
  prospect to abandon rather than convert.
- **Writes are blocked** (RLS `WITH CHECK` fails) on all tenant-scoped
  tables until `plan` is updated to `'active'` via the billing flow
  (out of scope here — sub-project 3).
- An upgrade prompt is shown in place of the trial-countdown banner.

This is a working default, not yet independently re-confirmed by the
user after an earlier related question went unanswered — flagged here
explicitly so it's visible before implementation starts.

## Out of scope for this spec

- Billing / Stripe integration, plan selection UI, payment collection.
- Tenant admin: inviting teammates, seat management, role assignment
  within a tenant beyond the initial OWNER.
- Quotation and Takeoff-estimate modules' own feature designs — only
  their existence as future `module_key`s is assumed here.
- Migrating FacadeX's own production data into the new `tenants` model
  (mentioned in §1 as necessary, but its migration script is an
  implementation-task concern, not a design concern — the shape is
  fully determined by §1).
