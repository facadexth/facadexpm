# Tenant Management Page — Design Spec

## Overview

FacadeXPM is genuinely multi-tenant in production (12+ tenants today),
but there has never been any way for FacadeX (the company operating this
software) to see or manage data across tenants. Every RLS policy in the
schema scopes strictly to the caller's own tenant via
`current_tenant_id()`, and even `tenant_modules` writes are
service-role-only — enabling a module for a tenant has always meant
someone with direct DB access running SQL by hand.

This spec covers **Phase 1 only**: giving a small set of trusted people
("platform admins") a page to see every tenant and assign each one a
package (a named bundle of modules), replacing the current one-module-
at-a-time-by-hand workflow. It corresponds to "sub-project 4" in
`2026-08-16-saas-multitenancy-signup-design.md`'s roadmap, which
explicitly deferred tenant admin as future work.

**Phase 2** (paid status, subscription duration, payment history) is
explicitly out of scope here and will get its own spec later — confirmed
with the user this can be built as a pure addition on top of Phase 1's
data model, with no rework.

## Goals

- A `platform_admins` allowlist, checked by new `SECURITY DEFINER`
  functions — not a raw RLS bypass on tenant tables, so the blast radius
  of a bug or mistake stays contained to the specific functions this
  page calls, not "any authenticated user with the right role can read
  every tenant's data."
- A `packages` table: each package is just a named, ordered set of
  module keys (reusing the existing `tenant_modules.module_key` CHECK
  values — no new module concept). Three starter tiers seeded at
  creation time (see Data Model).
- Assigning a tenant to a package **syncs `tenant_modules` to match**
  (adds missing keys, removes ones not in the new package) — so
  `has_module_access()` and every existing module gate keeps working
  completely unchanged. Packages are a management convenience over
  `tenant_modules`, not a parallel access-control system.
- A new page, visible in the nav only to `platform_admins` members,
  listing every tenant with its current package, `plan` status, and
  `trial_ends_at`, with a package-picker per row.

## Non-Goals

- **No payment/billing tracking.** Confirmed with the user: Phase 2,
  separate spec, later.
- **No self-service plan changes.** Tenants cannot change their own
  package from inside their own account — this page is
  platform-admin-only.
- **No per-tenant custom module sets.** A tenant is on exactly one
  package at a time; if a tenant needs a one-off extra module outside
  their package, that stays a direct `tenant_modules` edit (rare, not
  worth a UI path in Phase 1).
- **No changes to `has_module_access()` or any existing module-gating
  code.** Packages sit entirely upstream of `tenant_modules`, which
  remains the single source of truth every existing check already reads.

## Data Model

```sql
CREATE TABLE platform_admins (
  user_email  TEXT PRIMARY KEY,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Seeded with contact@facadex.co.th at migration time.

CREATE TABLE packages (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name        TEXT NOT NULL UNIQUE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE package_modules (
  package_id  UUID NOT NULL REFERENCES packages(id) ON DELETE CASCADE,
  module_key  TEXT NOT NULL CHECK (module_key IN
    ('payroll','labor_subcontractors','purchase_orders','client_deposits','quotations','invoices')),
  PRIMARY KEY (package_id, module_key)
);

ALTER TABLE tenants ADD COLUMN package_id UUID REFERENCES packages(id) ON DELETE SET NULL;
```

**Starter packages** (seeded by the migration, matching the module list
that exists today):

| Package | Modules |
|---|---|
| Basic | quotations, invoices |
| Standard | + purchase_orders, client_deposits |
| Full | + payroll, labor_subcontractors |

`platform_admins`/`packages`/`package_modules` get RLS enabled with a
single policy each: readable/writable only when
`auth.email() IN (SELECT user_email FROM platform_admins)`. This is a
direct, self-referencing check (no `SECURITY DEFINER` needed for
`platform_admins` itself, since it's the root of trust) — but reading
*other tenants'* data (the `tenants` list, `tenant_modules` writes) does
need `SECURITY DEFINER` functions, since `tenants`/`tenant_modules`
RLS is and stays scoped to `current_tenant_id()` for every other caller.

## Functions

```sql
-- Returns every tenant with enough detail for the list page. Bypasses
-- tenant RLS entirely, but ONLY for callers in platform_admins.
CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, created_at TIMESTAMPTZ
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.package_id, p.name, t.created_at
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;

-- Assigns a tenant to a package and syncs tenant_modules to match in the
-- same statement (add what's missing, remove what's not in the new
-- package) -- a tenant is never left in a state where package_id and
-- tenant_modules disagree.
CREATE FUNCTION platform_set_tenant_package(p_tenant_id UUID, p_package_id UUID)
RETURNS VOID
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'not a platform admin';
  END IF;

  UPDATE tenants SET package_id = p_package_id WHERE id = p_tenant_id;

  DELETE FROM tenant_modules
  WHERE tenant_id = p_tenant_id
    AND module_key NOT IN (SELECT module_key FROM package_modules WHERE package_id = p_package_id);

  INSERT INTO tenant_modules (tenant_id, module_key)
  SELECT p_tenant_id, module_key FROM package_modules WHERE package_id = p_package_id
  ON CONFLICT (tenant_id, module_key) DO NOTHING;
END;
$$;

REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
REVOKE EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
GRANT EXECUTE ON FUNCTION platform_set_tenant_package(UUID, UUID) TO authenticated;
```

Both functions re-check `platform_admins` membership internally (not just
via RLS on the tables they touch), since they run as `SECURITY DEFINER`
and therefore bypass RLS on `tenants`/`tenant_modules` by design — the
membership check is the only thing standing between "authenticated user"
and "can see/edit every tenant," so it must be enforced in the function
body, not assumed from the caller's own row-level permissions.

## UI

New nav item (e.g. "จัดการ Tenant" / "Platform Admin"), rendered only
when the logged-in user's email is a member of `platform_admins` —
checked client-side via a small `usePlatformAdmin()` hook that calls
`platform_list_tenants()` and treats a permission-denied response as
"not an admin, hide the nav item" (the function itself is the real
guard; the nav check is just UX, not security).

Page body: a single table, one row per tenant —

| Company | Package | Plan | Trial ends |
|---|---|---|---|
| Facade X | Full ▾ | active | — |
| (other tenant) | Basic ▾ | trial | 2026-09-15 |

The package cell is a `<select>` — changing it calls
`platform_set_tenant_package(tenant.id, newPackageId)` immediately (no
separate save step, matching the existing Settings page's per-field save
pattern isn't needed here since there's only one editable field per row).
`plan`/`trial_ends_at` are read-only display in Phase 1 (editing those is
Phase 2's "paid status" work).

## Open Questions Resolved

- **Where do `platform_admins` rows come from?** Seeded directly in the
  migration (`contact@facadex.co.th`). No UI to add/remove platform
  admins in Phase 1 — vanishingly rare operation, direct SQL is fine for
  now.
- **What happens to a tenant's existing `tenant_modules` the first time
  it's assigned a package?** The three starter tiers are exact supersets
  of each other (Basic ⊂ Standard ⊂ Full), so the backfill migration
  assigns each existing tenant the **smallest package whose module set
  is a superset of that tenant's current `tenant_modules`**. A tenant
  whose current modules aren't a subset of any starter tier (e.g.
  `labor_subcontractors` enabled without `quotations`) is left with
  `package_id = NULL` and its `tenant_modules` untouched — the backfill
  never calls `platform_set_tenant_package` (which would delete
  modules) for a tenant that doesn't cleanly fit a tier; it only sets
  `package_id` directly via plain `UPDATE` for the clean-fit cases. A
  `package_id = NULL` tenant keeps working exactly as today
  (`tenant_modules` unaffected) until a platform admin explicitly picks
  a package for it on the new page.
