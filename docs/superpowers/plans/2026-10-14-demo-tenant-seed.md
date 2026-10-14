# Demo Tenant Seed and Reset Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the demo tenant "บจก. สร้างดี คอนสตรัคชั่น" with eight months of consistent, Thai, general-contractor data across every live module, and give the platform admin a one-click reset that wipes and re-seeds it.

**Architecture:** One SQL migration adds a marker-guarded `seed_demo_tenant(uuid)` built from section helpers (`demo_seed_core`, `demo_seed_sales`, `demo_seed_purchasing`, `demo_seed_people`), a multi-pass `reset_demo_tenant(uuid)` that deletes every tenant-scoped row then re-seeds, and `is_demo` on `platform_list_tenants()`. One SQL test file runs the whole thing inside a rolled-back transaction. One small React change adds the reset button to the platform-admin page.

**Tech Stack:** PostgreSQL 15 (plpgsql, SECURITY DEFINER), Supabase CLI `db query --linked`, React 18 + supabase-js, vitest (not used for the SQL), Chrome for live verification.

**Spec:** `docs/superpowers/specs/2026-10-14-demo-tenant-seed-design.md`

## Global Constraints

- Work only in the worktree `.claude/worktrees/demo-tenant-seed` (branch `feat/demo-tenant-seed`). It already has `.env` pointing at CHANG.
- Live Supabase project is CHANG `kntspldhvcjeaubtqtkn`. Never reference the Tokyo project.
- Demo tenant id `8b61c890-0a90-4223-91d3-b5f8f4e89908`; owner login `demo-owner@facadex.co.th`; worker login `demo-worker@facadex.co.th`.
- Every SECURITY DEFINER function: `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon;` then `GRANT EXECUTE ... TO authenticated;` (spec facts, restore lesson).
- Both public functions raise unless the caller's `auth.email()` is in `platform_admins` AND `app_settings` has `key='is_demo_tenant', value='true'` for the target tenant.
- All document numbers are written explicitly by the seed (triggers only fill NULLs). Formats: `QTYYMM-NNN`, `POYYMM-NNN`, `INYYMM-NNN`, `REYYMM-NNN`, `TRYYMM-NNN`, `IVYYMM-NNN`, `PYYYMM-NNN`, sites `SD-YYYY-NNN`, inventory codes `{code_prefix}-NNNN`. Client/supplier/subcontractor numbers are left to their triggers.
- The seed impersonates the demo owner with `set_config('request.jwt.claims', ..., true)` only (same as `supabase/tests/*.sql`); it does NOT `SET ROLE`. This differs from the spec's sentence about `SET LOCAL ROLE authenticated`; the spec note is superseded here because the existing tests prove the set_config-only pattern works and keeps RLS out of a definer function.
- Dates are relative to `current_date`; `setseed(0.42)` makes `random()` deterministic so two seeds produce identical data.
- Never touch `user_roles`, `auth.*`, `tenants.id`, `tenant_modules`, `platform_admins`, `packages*`, `contractor_type*`.
- Every migration/test run against CHANG is a dry-run inside `BEGIN ... ROLLBACK` until Task 8 says otherwise. A migration is live the instant it runs outside that wrapper.
- Commit after every task with the attribution line `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.

## Review Focus

1. Reset called on a non-demo tenant (marker missing) must raise before deleting anything. Test in Task 1 (`guard_no_marker`).
2. A table added in a future migration with a `tenant_id` column must be wiped by reset without editing the function. Test in Task 6 creates a throwaway table `zz_future(tenant_id)` with a row and asserts it is emptied.
3. A second seed after reset must produce identical counts and identical document numbers (no number drift from `MAX()+1`). Test in Task 6 compares the two summaries and the sorted list of `quotation_number`.
4. Stock balances must equal the ledger per (item, site) and never go negative. Test in Task 4.
5. Paid invoice math: `received_amount = subtotal + vat - tax_withheld - retention - deposit_deduction` and `incomes` count equals paid invoices. Test in Task 3.

---

## Dry-run harness (used by every task)

Create once, in the scratchpad, a runner that wraps migration + test in a transaction that always rolls back:

```bash
# file: /private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/191b1b35-20cc-480c-85fa-882aca564cf8/scratchpad/dryrun.sh
#!/bin/zsh
set -e
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/demo-tenant-seed
OUT=/private/tmp/claude-501/-Users-plfx-code-FacadeXPM-facadex-app/191b1b35-20cc-480c-85fa-882aca564cf8/scratchpad/dryrun.sql
{
  echo "BEGIN;"
  echo "SET LOCAL lock_timeout = '5s';"
  cat "$W/supabase/migrations/2026-10-15-01-demo-tenant-seed.sql"
  sed -e '/^BEGIN;$/d' -e '/^ROLLBACK;$/d' "$W/supabase/tests/demo_tenant_seed_test.sql"
  echo "ROLLBACK;"
} > "$OUT"
cd "$W" && npx supabase db query --linked -f "$OUT" 2>&1 | tail -20
```

Run: `zsh <scratchpad>/dryrun.sh`
Success = output contains `RESULT: demo_tenant_seed_test ALL PASSED`. Any other error = failure. Nothing persists either way.

The test file always has this frame; tasks add `-- ── Tn ──` blocks inside the DO body, before the final RAISE:

```sql
-- ================================================================
-- Tests for 2026-10-15-01-demo-tenant-seed.sql.
-- Dry-run only (see docs/superpowers/plans/2026-10-14-demo-tenant-seed.md "Dry-run harness").
-- Success = ERROR text contains 'RESULT: demo_tenant_seed_test ALL PASSED'.
-- ================================================================
BEGIN;
DO $$
DECLARE
  t_owner UUID; t_tenant UUID; t_other UUID; v_n INT; v_n2 INT; v_msg TEXT;
  admin_email TEXT := '__demo_test_admin__@example.com';
  owner_email TEXT := '__demo_test_owner__@example.com';
  worker_email TEXT := '__demo_test_worker__@example.com';
  s1 JSONB; s2 JSONB; d1 JSONB;
BEGIN
  SELECT id INTO t_owner FROM auth.users ORDER BY created_at ASC LIMIT 1;
  INSERT INTO platform_admins (user_email) VALUES (admin_email);
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at, plan_expires_at, package_id)
    VALUES ('__DEMO TEST__', t_owner, 'active', now() - interval '1 day', '2099-12-31', (SELECT id FROM packages WHERE name = 'Enterprise'))
    RETURNING id INTO t_tenant;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (owner_email, 'OWNER', 'approved', t_tenant);
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES (worker_email, 'WORKER', 'approved', t_tenant);
  INSERT INTO tenant_modules (tenant_id, module_key) SELECT t_tenant, k FROM unnest(ARRAY['quotations','invoices','cheque_tracking','client_deposits','purchase_orders','payroll','labor_subcontractors','line_bot']) k;
  INSERT INTO sites (tenant_id, site_number, name, is_default) VALUES (t_tenant, 'SD-0000-000', 'ส่วนกลาง', true);
  INSERT INTO app_settings (tenant_id, key, value) VALUES (t_tenant, 'travel_rate_per_km', '20'), (t_tenant, 'holiday_pay_multiplier', '1.5');
  INSERT INTO tenants (company_name, owner_user_id, plan, trial_ends_at) VALUES ('__DEMO OTHER__', t_owner, 'trial', now() + interval '14 days') RETURNING id INTO t_other;
  INSERT INTO user_roles (user_email, role, status, tenant_id) VALUES ('__demo_other_owner__@example.com', 'OWNER', 'approved', t_other);

  -- act as the platform admin for every call below
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);

  -- ── T1 ── (tasks append blocks here)

  RAISE EXCEPTION 'RESULT: demo_tenant_seed_test ALL PASSED';
END $$;
ROLLBACK;
```

Note: `seed_demo_tenant` reads the owner and worker emails from `user_roles` of the target tenant (role OWNER, role WORKER), so the test tenant works with its own fake emails and the live tenant with the real ones.

---

### Task 1: Migration skeleton, guard, marker, `platform_list_tenants.is_demo`, reset shell

**Files:**
- Create: `supabase/migrations/2026-10-15-01-demo-tenant-seed.sql`
- Create: `supabase/tests/demo_tenant_seed_test.sql`
- Create (scratchpad, not committed): `dryrun.sh` as above

**Interfaces:**
- Produces: `demo_tenant_guard(p_tenant uuid) RETURNS void` (raises `demo_not_platform_admin` / `demo_marker_missing`), `demo_owner_email(p_tenant uuid) RETURNS text`, `demo_worker_email(p_tenant uuid) RETURNS text`, `demo_impersonate(p_tenant uuid) RETURNS void`, `reset_demo_tenant(p_tenant_id uuid) RETURNS jsonb`, `seed_demo_tenant(p_tenant_id uuid) RETURNS jsonb` (stub returning `{}` until Task 2), `platform_list_tenants()` with new last column `is_demo boolean`.

- [ ] **Step 1: Write the failing test (guard behaviour)**

Create `supabase/tests/demo_tenant_seed_test.sql` with the frame above and this T1 block:

```sql
  -- ── T1 ── guard: no marker → raises, nothing deleted
  BEGIN
    PERFORM reset_demo_tenant(t_tenant);
    RAISE EXCEPTION 'T1 FAIL: reset without marker did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'demo_marker_missing%' THEN RAISE EXCEPTION 'T1 FAIL: expected demo_marker_missing, got %', v_msg; END IF;
  END;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: default site was deleted by a refused reset'; END IF;

  -- guard: marker present but caller not platform admin → raises
  INSERT INTO app_settings (tenant_id, key, value) VALUES (t_tenant, 'is_demo_tenant', 'true');
  PERFORM set_config('request.jwt.claims', json_build_object('email', owner_email, 'role', 'authenticated')::text, true);
  BEGIN
    PERFORM reset_demo_tenant(t_tenant);
    RAISE EXCEPTION 'T1 FAIL: non-admin reset did not raise';
  EXCEPTION WHEN OTHERS THEN
    GET STACKED DIAGNOSTICS v_msg = MESSAGE_TEXT;
    IF v_msg NOT LIKE 'demo_not_platform_admin%' THEN RAISE EXCEPTION 'T1 FAIL: expected demo_not_platform_admin, got %', v_msg; END IF;
  END;
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);

  -- platform_list_tenants exposes is_demo
  SELECT count(*) INTO v_n FROM platform_list_tenants() WHERE id = t_tenant AND is_demo;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: is_demo not true for demo tenant'; END IF;
  SELECT count(*) INTO v_n FROM platform_list_tenants() WHERE id = t_other AND is_demo;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T1 FAIL: is_demo true for non-demo tenant'; END IF;

  -- reset on an (almost) empty demo tenant: keeps the kept tables, returns jsonb
  d1 := reset_demo_tenant(t_tenant);
  IF d1 IS NULL OR NOT (d1 ? 'deleted') THEN RAISE EXCEPTION 'T1 FAIL: reset summary missing deleted'; END IF;
  SELECT count(*) INTO v_n FROM user_roles WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T1 FAIL: user_roles touched by reset'; END IF;
  SELECT count(*) INTO v_n FROM tenant_modules WHERE tenant_id = t_tenant;
  IF v_n <> 8 THEN RAISE EXCEPTION 'T1 FAIL: tenant_modules touched by reset'; END IF;
  SELECT count(*) INTO v_n FROM app_settings WHERE tenant_id = t_tenant AND key = 'is_demo_tenant';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T1 FAIL: marker not re-inserted after reset'; END IF;
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: an error that is NOT the ALL PASSED result (function `reset_demo_tenant` does not exist).

- [ ] **Step 3: Write the migration**

`supabase/migrations/2026-10-15-01-demo-tenant-seed.sql`:

```sql
-- ================================================================
-- Demo tenant: marker-guarded seed + reset for customer demos.
-- Design: docs/superpowers/specs/2026-10-14-demo-tenant-seed-design.md
-- Plan:   docs/superpowers/plans/2026-10-14-demo-tenant-seed.md
-- Both public entry points refuse to run unless (a) the caller is a
-- platform admin and (b) the tenant carries app_settings
-- is_demo_tenant='true'. (b) is the only thing between "reset the demo"
-- and "wipe a paying customer", so it is checked inside the functions.
-- ================================================================

-- ── guard + helpers ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION demo_tenant_guard(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email()) THEN
    RAISE EXCEPTION 'demo_not_platform_admin' USING ERRCODE = '42501';
  END IF;
  IF NOT EXISTS (SELECT 1 FROM app_settings WHERE tenant_id = p_tenant AND key = 'is_demo_tenant' AND value = 'true') THEN
    RAISE EXCEPTION 'demo_marker_missing: tenant % is not flagged is_demo_tenant', p_tenant USING ERRCODE = '42501';
  END IF;
END $$;
REVOKE ALL ON FUNCTION demo_tenant_guard(UUID) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION demo_owner_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'OWNER' ORDER BY created_at LIMIT 1;
$$;
CREATE OR REPLACE FUNCTION demo_worker_email(p_tenant UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER SET search_path = public AS $$
  SELECT user_email FROM user_roles WHERE tenant_id = p_tenant AND role = 'WORKER' ORDER BY created_at LIMIT 1;
$$;
REVOKE ALL ON FUNCTION demo_owner_email(UUID) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION demo_worker_email(UUID) FROM PUBLIC, anon, authenticated;

-- Triggers (numbering, seat limits, created_by defaults) read auth.email()
-- and current_tenant_id(); impersonating the demo owner for the rest of
-- the transaction makes them behave as if the owner typed the data in.
-- Same pattern as supabase/tests/*.sql. The caller's claims are restored
-- by the public entry points before they return.
CREATE OR REPLACE FUNCTION demo_impersonate(p_tenant UUID)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_email TEXT := demo_owner_email(p_tenant); v_uid UUID;
BEGIN
  IF v_email IS NULL THEN RAISE EXCEPTION 'demo_no_owner: tenant % has no OWNER role', p_tenant; END IF;
  SELECT id INTO v_uid FROM auth.users WHERE email = v_email;
  PERFORM set_config('request.jwt.claims',
    json_build_object('email', v_email, 'role', 'authenticated', 'sub', COALESCE(v_uid::text, ''))::text, true);
END $$;
REVOKE ALL ON FUNCTION demo_impersonate(UUID) FROM PUBLIC, anon, authenticated;

-- ── seed entry point (sections are added by later tasks) ───────
CREATE OR REPLACE FUNCTION seed_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE v_claims TEXT := current_setting('request.jwt.claims', true); v_out JSONB := '{}'::jsonb;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  PERFORM setseed(0.42);
  PERFORM demo_impersonate(p_tenant_id);
  -- sections: v_out := v_out || demo_seed_core(p_tenant_id); ... (Tasks 2-5)
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN v_out;
END $$;
REVOKE ALL ON FUNCTION seed_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION seed_demo_tenant(UUID) TO authenticated;

-- ── reset ───────────────────────────────────────────────────────
-- Deletes every row of the tenant in every public table that has a
-- tenant_id column, except the kept list. Order is discovered at run
-- time by retrying: a DELETE that hits a foreign key (or a "has children"
-- trigger such as expenses_block_receipt_bill_delete) is caught in a
-- sub-transaction and retried on the next pass once its children are
-- gone. A pass that deletes nothing while rows remain means a real
-- cycle or an unknown blocker: the function raises with the table list
-- and the whole transaction rolls back, so the demo is never half-empty.
CREATE OR REPLACE FUNCTION reset_demo_tenant(p_tenant_id UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_claims TEXT := current_setting('request.jwt.claims', true);
  v_keep TEXT[] := ARRAY['tenants','user_roles','tenant_modules','tenant_status_log','platform_admins','packages','package_modules'];
  v_tables TEXT[]; v_remaining TEXT[]; v_t TEXT; v_deleted JSONB := '{}'::jsonb;
  v_pass INT := 0; v_progress BOOLEAN; v_n BIGINT; v_err TEXT; v_errs JSONB := '{}'::jsonb; v_seed JSONB;
BEGIN
  PERFORM demo_tenant_guard(p_tenant_id);
  SELECT array_agg(c.table_name::text ORDER BY c.table_name) INTO v_tables
  FROM information_schema.columns c
  JOIN information_schema.tables t ON t.table_schema = c.table_schema AND t.table_name = c.table_name AND t.table_type = 'BASE TABLE'
  WHERE c.table_schema = 'public' AND c.column_name = 'tenant_id'
    AND NOT (c.table_name = ANY (v_keep)) AND c.table_name NOT LIKE 'contractor_type%';
  v_remaining := v_tables;
  LOOP
    v_pass := v_pass + 1; v_progress := false;
    IF v_pass > 25 THEN EXIT; END IF;
    FOREACH v_t IN ARRAY v_remaining LOOP
      BEGIN
        EXECUTE format('DELETE FROM %I WHERE tenant_id = $1', v_t) USING p_tenant_id;
        GET DIAGNOSTICS v_n = ROW_COUNT;
        v_deleted := v_deleted || jsonb_build_object(v_t, COALESCE((v_deleted->>v_t)::bigint, 0) + v_n);
        v_remaining := array_remove(v_remaining, v_t);
        v_progress := true;
      EXCEPTION WHEN foreign_key_violation OR raise_exception OR check_violation THEN
        GET STACKED DIAGNOSTICS v_err = MESSAGE_TEXT;
        v_errs := v_errs || jsonb_build_object(v_t, v_err);
      END;
    END LOOP;
    EXIT WHEN cardinality(v_remaining) = 0 OR NOT v_progress;
  END LOOP;
  IF cardinality(v_remaining) > 0 THEN
    RAISE EXCEPTION 'demo_reset_stuck: could not delete from % (last errors %)', v_remaining, v_errs;
  END IF;
  -- keep the marker and the two settings the signup trigger always creates
  INSERT INTO app_settings (tenant_id, key, value) VALUES
    (p_tenant_id, 'is_demo_tenant', 'true'),
    (p_tenant_id, 'travel_rate_per_km', '20'),
    (p_tenant_id, 'holiday_pay_multiplier', '1.5');
  v_seed := seed_demo_tenant(p_tenant_id);
  PERFORM set_config('request.jwt.claims', COALESCE(v_claims, ''), true);
  RETURN jsonb_build_object('deleted', v_deleted, 'passes', v_pass, 'seeded', v_seed);
END $$;
REVOKE ALL ON FUNCTION reset_demo_tenant(UUID) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION reset_demo_tenant(UUID) TO authenticated;

-- ── platform_list_tenants gains is_demo ─────────────────────────
DROP FUNCTION IF EXISTS platform_list_tenants();
CREATE FUNCTION platform_list_tenants()
RETURNS TABLE (
  id UUID, company_name TEXT, plan TEXT, trial_ends_at TIMESTAMPTZ, plan_expires_at TIMESTAMPTZ,
  package_id UUID, package_name TEXT, price_monthly NUMERIC, price_yearly NUMERIC, created_at TIMESTAMPTZ,
  is_demo BOOLEAN
)
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public AS $$
  SELECT t.id, t.company_name, t.plan, t.trial_ends_at, t.plan_expires_at, t.package_id, p.name,
         p.price_monthly, p.price_yearly, t.created_at,
         EXISTS (SELECT 1 FROM app_settings a WHERE a.tenant_id = t.id AND a.key = 'is_demo_tenant' AND a.value = 'true') AS is_demo
  FROM tenants t
  LEFT JOIN packages p ON p.id = t.package_id
  WHERE EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())
  ORDER BY t.company_name;
$$;
REVOKE EXECUTE ON FUNCTION platform_list_tenants() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION platform_list_tenants() TO authenticated;
```

Check before relying on `SD-` site numbers: run
`select conname, pg_get_constraintdef(oid) from pg_constraint where conrelid='sites'::regclass and contype='u';`
via the Supabase MCP. If `site_number` is globally unique (no `tenant_id` in the constraint), the `SD-` prefix is what keeps the demo from colliding with `FX-` numbers; keep it either way.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: `RESULT: demo_tenant_seed_test ALL PASSED`

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "feat(demo): marker-guarded reset/seed shell, is_demo on platform_list_tenants"
```

---

### Task 2: `demo_seed_core` — company profile, categories, bank, clients, suppliers, catalog, sites, phases

**Files:**
- Modify: `supabase/migrations/2026-10-15-01-demo-tenant-seed.sql` (insert the function BEFORE `seed_demo_tenant`, and add the call inside it)
- Modify: `supabase/tests/demo_tenant_seed_test.sql` (add T2 block after T1)

**Interfaces:**
- Consumes: `demo_impersonate`, test frame.
- Produces: `demo_seed_core(p_tenant UUID) RETURNS JSONB` returning `{clients, suppliers, catalog_items, sites, site_phases, phase_tasks, expense_categories}`. Later sections find rows by name: sites by `sites.name`, clients by `clients.name`, suppliers by `suppliers.name`, categories by `expense_categories.name`, catalog items by `catalog_items.name`. Site names (exact, used later): 'บ้านคุณวิชัย ลาดพร้าว', 'อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน', 'คลับเฮาส์ หมู่บ้านพฤกษา', 'โกดังสินค้า บางบัวทอง', 'รีโนเวทบ้าน คุณนภา', 'บ้านพักอาศัย 2 ชั้น ปากเกร็ด', 'ร้านกาแฟ เดอะ การ์เด้น', 'ต่อเติมครัว คุณสมศักดิ์', 'สำนักงานขาย โครงการเดอะพาร์ค', 'ศาลาริมน้ำ วัดบางพูด'. Helper `demo_m(k int) RETURNS date` = first day of the month k months before this month.

- [ ] **Step 1: Write the failing test**

Append T2 block to the test, after T1:

```sql
  -- ── T2 ── core data
  s1 := seed_demo_tenant(t_tenant);
  IF (s1->>'clients')::int <> 8 THEN RAISE EXCEPTION 'T2 FAIL: clients=%', s1->>'clients'; END IF;
  IF (s1->>'suppliers')::int <> 8 THEN RAISE EXCEPTION 'T2 FAIL: suppliers=%', s1->>'suppliers'; END IF;
  IF (s1->>'catalog_items')::int <> 15 THEN RAISE EXCEPTION 'T2 FAIL: catalog=%', s1->>'catalog_items'; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND NOT is_default;
  IF v_n <> 10 THEN RAISE EXCEPTION 'T2 FAIL: sites=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND status = 'Ongoing';
  IF v_n <> 5 THEN RAISE EXCEPTION 'T2 FAIL: ongoing=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND status = 'Completed' AND NOT retention_released;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T2 FAIL: completed retention pending=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_tenant AND lat IS NULL AND NOT is_default;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T2 FAIL: site without lat/lng'; END IF;
  SELECT count(DISTINCT site_number), count(*) INTO v_n, v_n2 FROM sites WHERE tenant_id = t_tenant;
  IF v_n <> v_n2 THEN RAISE EXCEPTION 'T2 FAIL: duplicate site numbers'; END IF;
  SELECT count(*) INTO v_n FROM site_phases WHERE tenant_id = t_tenant;
  IF v_n <> 40 THEN RAISE EXCEPTION 'T2 FAIL: phases=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM phase_tasks WHERE tenant_id = t_tenant;
  IF v_n < 80 THEN RAISE EXCEPTION 'T2 FAIL: tasks=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM expense_categories WHERE tenant_id = t_tenant;
  IF v_n <> 8 THEN RAISE EXCEPTION 'T2 FAIL: categories=% (defaults not replaced)', v_n; END IF;
  SELECT count(*) INTO v_n FROM expense_categories WHERE tenant_id = t_tenant AND use_for_cost_deduction AND code_prefix IS NOT NULL;
  IF v_n <> 4 THEN RAISE EXCEPTION 'T2 FAIL: deduction categories=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM bank_accounts WHERE tenant_id = t_tenant AND is_default;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: bank account'; END IF;
  SELECT count(*) INTO v_n FROM tenants WHERE id = t_tenant AND tax_id = '0125599000001' AND address IS NOT NULL AND document_template_key = 'classic';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T2 FAIL: tenant profile not filled'; END IF;
```

- [ ] **Step 2: Run the harness to verify it fails**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: `T2 FAIL: clients=` (seed returns `{}`).

- [ ] **Step 3: Write `demo_m` and `demo_seed_core`, wire the call**

Insert before `seed_demo_tenant` in the migration:

```sql
-- first day of the month k months ago (k=0 → this month)
CREATE OR REPLACE FUNCTION demo_m(k INT) RETURNS DATE LANGUAGE sql IMMUTABLE AS $$
  SELECT (date_trunc('month', current_date) - make_interval(months => k))::date;
$$;

CREATE OR REPLACE FUNCTION demo_seed_core(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_bank UUID; v_client UUID; v_site UUID; v_phase UUID; i INT; j INT; k INT;
  v_phase_names TEXT[] := ARRAY['งานเตรียมการและฐานราก','งานโครงสร้าง','งานสถาปัตย์และระบบ','งานตกแต่งและส่งมอบ'];
  v_task_names TEXT[][] := ARRAY[
    ARRAY['รังวัดและวางผัง','ขุดดินและเทฐานราก','ตอกเข็ม/คานคอดิน'],
    ARRAY['เสาและคาน ชั้น 1','พื้นและเสา ชั้น 2','โครงหลังคา'],
    ARRAY['ก่ออิฐฉาบปูน','เดินระบบไฟฟ้า-ประปา','มุงหลังคา/ฝ้า'],
    ARRAY['ปูกระเบื้องและทาสี','ติดตั้งประตู-หน้าต่าง','ทำความสะอาดและส่งมอบ']];
  -- name, status, start month-offset, duration months, contract, client idx, lat, lng, location, deposit_pct, progress(0..1)
  v_sites TEXT[][] := ARRAY[
    ARRAY['บ้านคุณวิชัย ลาดพร้าว','Ongoing','5','7','4850000','1','13.8166','100.5972','ลาดพร้าว 71 กรุงเทพฯ','30','0.85'],
    ARRAY['อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน','Ongoing','4','8','7200000','6','13.8520','100.5450','งามวงศ์วาน นนทบุรี','30','0.70'],
    ARRAY['คลับเฮาส์ หมู่บ้านพฤกษา','Ongoing','3','6','3600000','4','13.9120','100.4210','บางบัวทอง นนทบุรี','0','0.45'],
    ARRAY['โกดังสินค้า บางบัวทอง','Ongoing','2','6','5900000','7','13.9350','100.3980','บางบัวทอง นนทบุรี','30','0.30'],
    ARRAY['รีโนเวทบ้าน คุณนภา','Ongoing','1','3','1250000','2','13.8880','100.4890','เมืองนนทบุรี','0','0.15'],
    ARRAY['บ้านพักอาศัย 2 ชั้น ปากเกร็ด','Completed','8','6','3900000','3','13.9100','100.5000','ปากเกร็ด นนทบุรี','0','1'],
    ARRAY['ร้านกาแฟ เดอะ การ์เด้น','Completed','7','4','1850000','8','13.8700','100.5200','รัตนาธิเบศร์ นนทบุรี','0','1'],
    ARRAY['ต่อเติมครัว คุณสมศักดิ์','Completed','6','2','480000','1','13.8300','100.5700','ลาดพร้าว กรุงเทพฯ','0','1'],
    ARRAY['สำนักงานขาย โครงการเดอะพาร์ค','On Hold','3','5','2900000','5','13.9600','100.4500','ไทรน้อย นนทบุรี','0','0.20'],
    ARRAY['ศาลาริมน้ำ วัดบางพูด','Cancelled','4','3','650000','2','13.9300','100.5100','ปากเกร็ด นนทบุรี','0','0']];
  v_client_names TEXT[] := ARRAY['คุณวิชัย ศรีสุข','คุณนภา พงศ์ไพบูลย์','คุณอรุณ ตั้งใจดี','บจก. พฤกษา พร็อพเพอร์ตี้','บจก. เดอะพาร์ค ดีเวลลอปเมนท์','บจก. งามวงศ์วาน เทรดดิ้ง','หจก. บางบัวทอง โลจิสติกส์','คุณสมศักดิ์ มั่นคง'];
  v_client_types TEXT[] := ARRAY['ENDUSER','ENDUSER','ENDUSER','DEVELOPER','DEVELOPER','ENDUSER','ENDUSER','ENDUSER'];
  v_client_tax TEXT[] := ARRAY[NULL,NULL,NULL,'0105540000011','0105550000022','0125560000033','0123570000044',NULL];
  v_sup TEXT[][] := ARRAY[
    ARRAY['บจก. ไทยวัสดุก่อสร้าง','ปูน/ทราย/หิน','30','transfer'],
    ARRAY['ร้านเจริญเหล็ก','เหล็กเส้น/เหล็กรูปพรรณ','0','transfer'],
    ARRAY['หจก. ปูนดี ซัพพลาย','ปูนซีเมนต์','15','check'],
    ARRAY['ร้านไฟฟ้าสมบูรณ์','อุปกรณ์ไฟฟ้า','0','cash'],
    ARRAY['บจก. สุขภัณฑ์ไทย','สุขภัณฑ์/ท่อ','30','transfer'],
    ARRAY['ร้านสีสวย','สี/เคมีภัณฑ์','0','transfer'],
    ARRAY['บจก. เครื่องมือช่าง โปร','เครื่องมือ','0','check'],
    ARRAY['ร้านอิฐบล็อก บางใหญ่','อิฐ/บล็อก','7','transfer']];
  v_cat TEXT[][] := ARRAY[
    ARRAY['งานโครงสร้าง (ปูน/เหล็ก)','#8B5E3C','STR','t'],
    ARRAY['งานสถาปัตย์','#C9A227','ARC','t'],
    ARRAY['ไฟฟ้า/ประปา','#2E7D9A','MEP','t'],
    ARRAY['วัสดุสิ้นเปลือง','#7A7A7A','SUP','t'],
    ARRAY['ค่าแรง','#B23A48','', 'f'],
    ARRAY['ค่าเดินทาง','#4F7942','', 'f'],
    ARRAY['เครื่องมือ','#5A4E8C','', 'f'],
    ARRAY['เบ็ดเตล็ด','#999999','', 'f']];
  v_catalog TEXT[][] := ARRAY[
    ARRAY['งานฐานรากและเสาเข็ม','งาน','380000'], ARRAY['งานโครงสร้าง ค.ส.ล.','ตร.ม.','4200'],
    ARRAY['งานก่ออิฐฉาบปูน','ตร.ม.','650'], ARRAY['งานโครงหลังคาและมุงหลังคา','ตร.ม.','1850'],
    ARRAY['งานระบบไฟฟ้า','จุด','1200'], ARRAY['งานระบบประปา-สุขาภิบาล','จุด','1500'],
    ARRAY['งานทาสีภายใน-ภายนอก','ตร.ม.','180'], ARRAY['งานปูกระเบื้อง','ตร.ม.','550'],
    ARRAY['งานฝ้าเพดาน','ตร.ม.','420'], ARRAY['งานประตู-หน้าต่าง','ชุด','8500'],
    ARRAY['งานสุขภัณฑ์','ชุด','12000'], ARRAY['งานรั้วและประตูรั้ว','เมตร','3200'],
    ARRAY['งานถนนและลานจอดรถ','ตร.ม.','950'], ARRAY['งานรื้อถอน','งาน','45000'],
    ARRAY['ค่าดำเนินการและกำไร','งาน','1']];
  v_start DATE; v_end DATE; v_status TEXT; v_prog NUMERIC; v_dur INT;
BEGIN
  -- company profile
  UPDATE tenants SET
    address = '99/12 หมู่ 5 ถ.รัตนาธิเบศร์ ต.บางกระสอ อ.เมืองนนทบุรี จ.นนทบุรี 11000',
    tax_id = '0125599000001', phone = '02-000-0000', website = 'www.sangdee-demo.co.th',
    default_payment_terms = 'ชำระมัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน หักประกันผลงาน 5% คืนภายใน 90 วันหลังส่งมอบ',
    default_notes = 'ราคานี้ยังไม่รวมค่าขออนุญาตก่อสร้างและค่าธรรมเนียมราชการ',
    document_template_key = 'classic'
  WHERE id = p_tenant;

  INSERT INTO bank_accounts (tenant_id, bank_name, account_name, account_no, vat_category, is_default, active)
  VALUES (p_tenant, 'ธนาคารกสิกรไทย', 'บจก. สร้างดี คอนสตรัคชั่น', '012-3-45678-9', 'vat', true, true) RETURNING id INTO v_bank;

  -- replace the signup defaults (aluminium-flavoured) with contractor categories
  DELETE FROM expense_categories WHERE tenant_id = p_tenant;
  FOR i IN 1..8 LOOP
    INSERT INTO expense_categories (tenant_id, name, color, sort_order, use_for_cost_deduction, code_prefix)
    VALUES (p_tenant, v_cat[i][1], v_cat[i][2], i, v_cat[i][4] = 't', NULLIF(v_cat[i][3], ''));
  END LOOP;
  INSERT INTO units (tenant_id, name) SELECT p_tenant, u FROM unnest(ARRAY['งาน','ตร.ม.','จุด','ชุด','เมตร','ถุง','เส้น','ก้อน','คิว','กล่อง']) u;

  FOR i IN 1..8 LOOP
    INSERT INTO clients (tenant_id, name, client_type, tax_id, phone, address, province, contact_person)
    VALUES (p_tenant, v_client_names[i], v_client_types[i], v_client_tax[i], '08' || lpad((10000000 + i * 1234567)::text, 8, '0'),
            (ARRAY['12/3 ซ.ลาดพร้าว 71 แขวงวังทองหลาง กรุงเทพฯ 10310','45 ม.2 ต.บางกระสอ อ.เมืองนนทบุรี 11000','88/9 ม.7 ต.บางพูด อ.ปากเกร็ด นนทบุรี 11120','1 อาคารพฤกษา ถ.แจ้งวัฒนะ ปากเกร็ด นนทบุรี 11120','55 ถ.บางกรวย-ไทรน้อย อ.ไทรน้อย นนทบุรี 11150','210 ถ.งามวงศ์วาน อ.เมืองนนทบุรี 11000','9/9 ม.4 ต.ละหาร อ.บางบัวทอง นนทบุรี 11110','23 ซ.ลาดพร้าว 101 แขวงคลองจั่น กรุงเทพฯ 10240'])[i],
            (ARRAY['กรุงเทพมหานคร','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','นนทบุรี','กรุงเทพมหานคร'])[i],
            CASE WHEN v_client_types[i] = 'DEVELOPER' THEN 'คุณประสิทธิ์ (ฝ่ายจัดซื้อ)' ELSE NULL END);
  END LOOP;

  FOR i IN 1..8 LOOP
    INSERT INTO suppliers (tenant_id, name, category, credit_days, default_payment_method, phone, payment_terms, tax_id)
    VALUES (p_tenant, v_sup[i][1], to_jsonb(ARRAY[v_sup[i][2]]), v_sup[i][3]::int, v_sup[i][4], '02-5' || lpad((10000 + i * 777)::text, 5, '0'),
            CASE WHEN v_sup[i][3]::int > 0 THEN 'เครดิต ' || v_sup[i][3] || ' วัน' ELSE 'เงินสด' END,
            '01255' || lpad((60000000 + i * 1111)::text, 8, '0'));
  END LOOP;

  FOR i IN 1..15 LOOP
    INSERT INTO catalog_items (tenant_id, name, unit, default_unit_price, active)
    VALUES (p_tenant, v_catalog[i][1], v_catalog[i][2], v_catalog[i][3]::numeric, true);
  END LOOP;

  -- sites, phases, tasks
  FOR i IN 1..10 LOOP
    v_status := v_sites[i][2]; v_dur := v_sites[i][4]::int; v_prog := v_sites[i][11]::numeric;
    v_start := demo_m(v_sites[i][3]::int) + (i * 3);
    v_end := (v_start + make_interval(months => v_dur))::date;
    SELECT id INTO v_client FROM clients WHERE tenant_id = p_tenant AND name = v_client_names[v_sites[i][6]::int];
    INSERT INTO sites (tenant_id, site_number, name, status, start_date, end_date, contract_value, contract_value_no_vat, has_vat,
                       default_vat_pct, default_tax_withheld_pct, default_retention_pct, default_retention_period_days, default_deposit_pct,
                       retention_released, retention_released_date, client_id, client_name, location, lat, lng, distance_km, travel_minutes, is_default, notes)
    VALUES (p_tenant, 'SD-' || to_char(v_start, 'YYYY') || '-' || lpad(i::text, 3, '0'), v_sites[i][1], v_status, v_start,
            CASE WHEN v_status = 'Cancelled' THEN NULL ELSE v_end END,
            v_sites[i][5]::numeric * 1.07, v_sites[i][5]::numeric, true, 7, 3, 5, 90, v_sites[i][10]::numeric,
            (i = 8), CASE WHEN i = 8 THEN (v_end + 90) ELSE NULL END,
            v_client, v_client_names[v_sites[i][6]::int], v_sites[i][9], v_sites[i][7]::numeric, v_sites[i][8]::numeric,
            8 + i * 2.5, 20 + i * 4, false,
            CASE v_status WHEN 'On Hold' THEN 'ลูกค้าขอชะลอรอใบอนุญาต' WHEN 'Cancelled' THEN 'ลูกค้ายกเลิกก่อนเริ่มงาน' ELSE NULL END)
    RETURNING id INTO v_site;
    FOR j IN 1..4 LOOP
      INSERT INTO site_phases (tenant_id, site_id, name, sort_order, start_date, end_date, billing_weight_pct, status)
      VALUES (p_tenant, v_site, v_phase_names[j], j,
              (v_start + ((j - 1) * v_dur * 30 / 4))::date, (v_start + (j * v_dur * 30 / 4) - 1)::date, 25,
              CASE WHEN v_prog >= j * 0.25 THEN 'done' WHEN v_prog > (j - 1) * 0.25 THEN 'in_progress' ELSE 'not_started' END)
      RETURNING id INTO v_phase;
      FOR k IN 1..3 LOOP
        INSERT INTO phase_tasks (tenant_id, site_id, phase_id, name, sort_order, due_date, status)
        VALUES (p_tenant, v_site, v_phase, v_task_names[j][k], k, (v_start + ((j - 1) * v_dur * 30 / 4) + k * v_dur * 10 / 4)::date,
                CASE WHEN v_prog >= (j - 1) * 0.25 + k * 0.25 / 3 THEN 'done'
                     WHEN v_prog > (j - 1) * 0.25 + (k - 1) * 0.25 / 3 THEN 'in_progress' ELSE 'not_started' END);
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'clients', (SELECT count(*) FROM clients WHERE tenant_id = p_tenant),
    'suppliers', (SELECT count(*) FROM suppliers WHERE tenant_id = p_tenant),
    'catalog_items', (SELECT count(*) FROM catalog_items WHERE tenant_id = p_tenant),
    'expense_categories', (SELECT count(*) FROM expense_categories WHERE tenant_id = p_tenant),
    'sites', (SELECT count(*) FROM sites WHERE tenant_id = p_tenant AND NOT is_default),
    'site_phases', (SELECT count(*) FROM site_phases WHERE tenant_id = p_tenant),
    'phase_tasks', (SELECT count(*) FROM phase_tasks WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_core(UUID) FROM PUBLIC, anon, authenticated;
```

In `seed_demo_tenant`, replace the comment line with:

```sql
  v_out := v_out || demo_seed_core(p_tenant_id);
```

Note on the `v_task_names TEXT[][]` literal: PostgreSQL multi-dimensional arrays need equal inner lengths (they are). Index as `v_task_names[j][k]`.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: `RESULT: demo_tenant_seed_test ALL PASSED`. If the error is about `sites_site_number_key` (global unique), the `SD-` prefix is already distinct from live `FX-` numbers; if it still collides, the test tenant's default site `SD-0000-000` is the only overlap candidate and must not match any seeded number (seeded ones start at 001).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "feat(demo): seed core data (profile, categories, clients, suppliers, catalog, sites, phases)"
```

---

### Task 3: `demo_seed_sales` — quotations, revisions, invoices, draws, receipts, incomes

**Files:**
- Modify: migration (add `demo_quotation`, `demo_invoice`, `demo_seed_sales` before `seed_demo_tenant`; add the call)
- Modify: test (T3 block)

**Interfaces:**
- Consumes: sites/clients/catalog by name from Task 2; `demo_m`.
- Produces: `demo_seed_sales(p_tenant UUID) RETURNS JSONB` with keys `quotations, invoices, invoices_paid, receipts, incomes, revisions`. Internal helpers:
  - `demo_quotation(p_tenant, p_site_name TEXT, p_client_name TEXT, p_date DATE, p_seq INT, p_status TEXT, p_lines JSONB, p_opts JSONB) RETURNS UUID` where `p_lines` is `[{"name":catalog name,"qty":n,"price":x}|{"desc":text}|{"note":text}]` and `p_opts` may hold `valid_until`, `on_hold`, `revision_snapshot` (bool), `site_name_only` (bool: quotation without site link).
  - `demo_invoice(p_tenant, p_quotation UUID, p_date DATE, p_seq INT, p_prior NUMERIC, p_target NUMERIC, p_paid DATE, p_opts JSONB) RETURNS UUID`; `p_opts` may hold `deposit_pct` (creates a deposit invoice instead of draws), `deposit_deduction` (numeric, applied on this draw), `void` (bool), `due_days` (int).

- [ ] **Step 1: Write the failing test**

Append T3:

```sql
  -- ── T3 ── sales chain
  IF (s1->>'quotations')::int <> 18 THEN RAISE EXCEPTION 'T3 FAIL: quotations=%', s1->>'quotations'; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND status = 'accepted' AND site_id IS NOT NULL;
  IF v_n <> 9 THEN RAISE EXCEPTION 'T3 FAIL: accepted with site=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND status = 'sent';
  IF v_n <> 4 THEN RAISE EXCEPTION 'T3 FAIL: sent=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND on_hold;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T3 FAIL: on_hold=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_items WHERE tenant_id = t_tenant AND item_type IN ('item_description','note');
  IF v_n < 10 THEN RAISE EXCEPTION 'T3 FAIL: too few description/note lines=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_revisions WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T3 FAIL: revisions=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM quotation_revisions WHERE tenant_id = t_tenant AND NOT (snapshot->'items'->0 ? 'item_type');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: revision snapshot without item_type'; END IF;
  -- numbers: unique per tenant, month prefix matches the date
  SELECT count(*) INTO v_n FROM quotations WHERE tenant_id = t_tenant AND quotation_number !~ ('^QT' || to_char(date, 'YYMM') || '-[0-9]{3}$');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: quotation number/date mismatch'; END IF;
  SELECT count(*) - count(DISTINCT quotation_number) INTO v_n FROM quotations WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: duplicate quotation numbers'; END IF;
  SELECT count(*) - count(DISTINCT invoice_number) INTO v_n FROM invoices WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: duplicate invoice numbers'; END IF;
  -- invoices
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant;
  IF v_n < 24 THEN RAISE EXCEPTION 'T3 FAIL: invoices=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'unpaid';
  IF v_n <> 4 THEN RAISE EXCEPTION 'T3 FAIL: unpaid=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'void';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T3 FAIL: void=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND is_deposit;
  IF v_n <> 3 THEN RAISE EXCEPTION 'T3 FAIL: deposit invoices=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant
    AND abs(i.subtotal - (SELECT COALESCE(sum(line_total), 0) FROM invoice_items x WHERE x.invoice_id = i.id)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % invoices whose subtotal != items', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant AND abs(i.total - (i.subtotal + i.vat)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: total != subtotal+vat'; END IF;
  -- paid chain
  SELECT count(*) INTO v_n FROM invoices WHERE tenant_id = t_tenant AND status = 'paid';
  SELECT count(*) INTO v_n2 FROM incomes WHERE tenant_id = t_tenant AND source_invoice_id IS NOT NULL;
  IF v_n <> v_n2 OR v_n < 18 THEN RAISE EXCEPTION 'T3 FAIL: paid=% incomes=%', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n2 FROM receipts r JOIN invoices i ON i.id = r.invoice_id WHERE i.tenant_id = t_tenant;
  IF v_n <> v_n2 THEN RAISE EXCEPTION 'T3 FAIL: receipts=% paid=%', v_n2, v_n; END IF;
  SELECT count(*) INTO v_n FROM incomes n JOIN invoices i ON i.id = n.source_invoice_id WHERE n.tenant_id = t_tenant
    AND abs(n.received_amount - (i.subtotal + i.vat - n.tax_withheld - n.retention - COALESCE(n.deposit_deduction, 0))) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % incomes break the received_amount formula', v_n; END IF;
  SELECT count(*) INTO v_n FROM incomes WHERE tenant_id = t_tenant AND income_type = 'มัดจำ';
  IF v_n <> 3 THEN RAISE EXCEPTION 'T3 FAIL: deposit incomes=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM invoices i WHERE i.tenant_id = t_tenant AND i.status = 'paid' AND (i.income_id IS NULL OR i.paid_date IS NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: paid invoice without income_id/paid_date'; END IF;
  -- draws: cumulative pct never exceeds 100 and matches the last draw
  SELECT count(*) INTO v_n FROM quotation_item_units WHERE tenant_id = t_tenant AND cumulative_pct > 100;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: cumulative_pct > 100'; END IF;
  -- site contract value equals accepted quotation total (incl. VAT)
  SELECT count(*) INTO v_n FROM quotations q JOIN sites s ON s.id = q.site_id
    WHERE q.tenant_id = t_tenant AND q.status = 'accepted'
    AND abs(s.contract_value - (SELECT sum(line_total) * 1.07 FROM quotation_items x WHERE x.quotation_id = q.id AND x.item_type = 'item')) > 1;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T3 FAIL: % sites whose contract_value != accepted quotation', v_n; END IF;
```

- [ ] **Step 2: Run the harness to verify it fails**

Expected: `T3 FAIL: quotations=` (key missing → NULL → comparison fails; if the IF on NULL does not raise, the next count check raises).

Careful: `(s1->>'quotations')::int <> 18` is NULL when the key is missing and `IF NULL` does not raise. Make the first check `IF COALESCE((s1->>'quotations')::int, -1) <> 18`. Apply the same `COALESCE(..., -1)` to every summary-key check in T2 and T3.

- [ ] **Step 3: Write the helpers and the section**

```sql
-- One quotation with items. p_lines: [{"name":..,"qty":..,"price":..} | {"desc":..} | {"note":..}]
CREATE OR REPLACE FUNCTION demo_quotation(p_tenant UUID, p_site_name TEXT, p_client_name TEXT, p_date DATE, p_seq INT,
                                          p_status TEXT, p_lines JSONB, p_opts JSONB DEFAULT '{}'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_q UUID; v_site UUID; v_client UUID; v_bank UUID; l JSONB; i INT := 0; v_cat UUID; v_unit TEXT; v_item UUID;
  v_qty NUMERIC; v_price NUMERIC; v_snapshot JSONB;
BEGIN
  SELECT id INTO v_client FROM clients WHERE tenant_id = p_tenant AND name = p_client_name;
  IF v_client IS NULL THEN RAISE EXCEPTION 'demo_quotation: client % not found', p_client_name; END IF;
  IF p_site_name IS NOT NULL AND NOT COALESCE((p_opts->>'site_name_only')::boolean, false) THEN
    SELECT id INTO v_site FROM sites WHERE tenant_id = p_tenant AND name = p_site_name;
    IF v_site IS NULL THEN RAISE EXCEPTION 'demo_quotation: site % not found', p_site_name; END IF;
  END IF;
  SELECT id INTO v_bank FROM bank_accounts WHERE tenant_id = p_tenant AND is_default LIMIT 1;
  INSERT INTO quotations (tenant_id, quotation_number, client_id, site_id, site_name, date, valid_until, status, has_vat, price_includes_vat,
                          payment_terms, notes, revision, ever_sent, bank_account_id, pricing_mode, created_by, sent_at, follow_up_after_days, on_hold, held_at)
  VALUES (p_tenant, 'QT' || to_char(p_date, 'YYMM') || '-' || lpad(p_seq::text, 3, '0'), v_client, v_site, p_site_name, p_date,
          COALESCE((p_opts->>'valid_until')::date, p_date + 30), p_status, true, false,
          'ชำระมัดจำ 30% เมื่อเซ็นสัญญา ส่วนที่เหลือแบ่งจ่ายตามงวดงาน', 'ราคานี้ยังไม่รวมค่าขออนุญาตก่อสร้าง',
          CASE WHEN COALESCE((p_opts->>'revision_snapshot')::boolean, false) THEN 2 ELSE 1 END,
          p_status <> 'draft', v_bank, 'combined', demo_owner_email(p_tenant),
          CASE WHEN p_status <> 'draft' THEN (p_date + 1)::timestamptz ELSE NULL END, 7,
          COALESCE((p_opts->>'on_hold')::boolean, false), CASE WHEN COALESCE((p_opts->>'on_hold')::boolean, false) THEN now() - interval '3 days' ELSE NULL END)
  RETURNING id INTO v_q;
  FOR l IN SELECT * FROM jsonb_array_elements(p_lines) LOOP
    IF l ? 'name' THEN
      SELECT id, unit INTO v_cat, v_unit FROM catalog_items WHERE tenant_id = p_tenant AND name = l->>'name';
      IF v_cat IS NULL THEN RAISE EXCEPTION 'demo_quotation: catalog item % not found', l->>'name'; END IF;
      v_qty := (l->>'qty')::numeric; v_price := (l->>'price')::numeric;
      INSERT INTO quotation_items (tenant_id, quotation_id, catalog_item_id, description, unit, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, v_cat, l->>'name', v_unit, v_qty, v_price, v_qty * v_price, i, 'item') RETURNING id INTO v_item;
      -- units exactly as src/lib/invoiceCalc.js buildUnitSeedRows: integer qty 1..20 → one unit each, else one unit of the whole qty
      IF v_qty = trunc(v_qty) AND v_qty > 0 AND v_qty <= 20 THEN
        INSERT INTO quotation_item_units (tenant_id, quotation_item_id, unit_index, unit_qty, cumulative_pct)
        SELECT p_tenant, v_item, g, 1, 0 FROM generate_series(0, v_qty::int - 1) g;
      ELSE
        INSERT INTO quotation_item_units (tenant_id, quotation_item_id, unit_index, unit_qty, cumulative_pct) VALUES (p_tenant, v_item, 0, v_qty, 0);
      END IF;
    ELSIF l ? 'desc' THEN
      INSERT INTO quotation_items (tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, l->>'desc', 0, 0, 0, i, 'item_description');
    ELSE
      INSERT INTO quotation_items (tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order, item_type)
      VALUES (p_tenant, v_q, l->>'note', 0, 0, 0, i, 'note');
    END IF;
    i := i + 1;
  END LOOP;
  IF COALESCE((p_opts->>'revision_snapshot')::boolean, false) THEN
    -- revision 1 snapshot: same lines, first item 10% cheaper (what the client negotiated away)
    SELECT jsonb_build_object('client_id', v_client, 'client_name', p_client_name, 'date', p_date - 7, 'valid_until', p_date + 23,
      'has_vat', true, 'price_includes_vat', false, 'discount_amount', 0, 'discount_pct', 0, 'pricing_mode', 'combined',
      'payment_terms', 'ชำระมัดจำ 30% เมื่อเซ็นสัญญา', 'notes', NULL, 'bank_account', NULL,
      'items', jsonb_agg(jsonb_build_object('description', x.description, 'unit', x.unit, 'quantity', x.quantity,
                 'unit_price', CASE WHEN x.sort_order = 0 THEN round(x.unit_price * 1.1, 2) ELSE x.unit_price END,
                 'unit_price_material', NULL, 'unit_price_labor', NULL,
                 'line_total', CASE WHEN x.sort_order = 0 THEN round(x.line_total * 1.1, 2) ELSE x.line_total END,
                 'item_type', x.item_type) ORDER BY x.sort_order))
    INTO v_snapshot FROM quotation_items x WHERE x.quotation_id = v_q;
    INSERT INTO quotation_revisions (tenant_id, quotation_id, revision, snapshot, created_at) VALUES (p_tenant, v_q, 1, v_snapshot, (p_date + 3)::timestamptz);
  END IF;
  IF v_site IS NOT NULL AND p_status = 'accepted' THEN
    UPDATE sites SET contract_value_no_vat = (SELECT sum(line_total) FROM quotation_items WHERE quotation_id = v_q AND item_type = 'item'),
                     contract_value = (SELECT sum(line_total) * 1.07 FROM quotation_items WHERE quotation_id = v_q AND item_type = 'item')
    WHERE id = v_site;
  END IF;
  RETURN v_q;
END $$;
REVOKE ALL ON FUNCTION demo_quotation(UUID, TEXT, TEXT, DATE, INT, TEXT, JSONB, JSONB) FROM PUBLIC, anon, authenticated;

-- One invoice from a quotation: either a deposit invoice (opts.deposit_pct) or a progress draw
-- moving every unit from p_prior% to p_target% (mirrors Invoices.jsx handleSave + handleMarkPaid).
CREATE OR REPLACE FUNCTION demo_invoice(p_tenant UUID, p_quotation UUID, p_date DATE, p_seq INT, p_prior NUMERIC, p_target NUMERIC,
                                        p_paid DATE, p_opts JSONB DEFAULT '{}'::jsonb)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q RECORD; v_inv UUID; v_item UUID; v_sub NUMERIC := 0; v_line NUMERIC; v_draw NUMERIC; u RECORD; qi RECORD; i INT := 0;
  v_dep_pct NUMERIC := (p_opts->>'deposit_pct')::numeric; v_dep_ded NUMERIC := COALESCE((p_opts->>'deposit_deduction')::numeric, 0);
  v_void BOOLEAN := COALESCE((p_opts->>'void')::boolean, false); v_vat NUMERIC; v_total NUMERIC; v_num TEXT;
  v_tax NUMERIC; v_ret NUMERIC; v_income UUID; v_received NUMERIC; v_client TEXT; v_qsub NUMERIC;
BEGIN
  SELECT qu.*, s.default_tax_withheld_pct, s.default_retention_pct, c.name AS client_name
    INTO q FROM quotations qu JOIN sites s ON s.id = qu.site_id JOIN clients c ON c.id = qu.client_id WHERE qu.id = p_quotation;
  IF q.id IS NULL THEN RAISE EXCEPTION 'demo_invoice: quotation % has no site', p_quotation; END IF;
  v_num := 'IN' || to_char(p_date, 'YYMM') || '-' || lpad(p_seq::text, 3, '0');
  SELECT sum(line_total) INTO v_qsub FROM quotation_items WHERE quotation_id = p_quotation AND item_type = 'item';
  INSERT INTO invoices (tenant_id, invoice_number, quotation_id, site_id, date, status, has_vat, price_includes_vat, subtotal, vat, total,
                        bank_account_id, wht_pct, is_deposit, deposit_pct, deposit_deduction_amount, deposit_deduction_pct, notes)
  VALUES (p_tenant, v_num, p_quotation, q.site_id, p_date, 'unpaid', true, false, 0, 0, 0, q.bank_account_id, 3,
          v_dep_pct IS NOT NULL, v_dep_pct, NULLIF(v_dep_ded, 0), NULL,
          CASE WHEN COALESCE((p_opts->>'due_days')::int, 0) > 0 THEN 'ครบกำหนดชำระ ' || to_char(p_date + (p_opts->>'due_days')::int, 'DD/MM/YYYY') ELSE NULL END)
  RETURNING id INTO v_inv;
  IF v_dep_pct IS NOT NULL THEN
    v_line := round(v_qsub * v_dep_pct / 100, 2);
    INSERT INTO invoice_items (tenant_id, invoice_id, description, unit, unit_price, draw_qty, line_total, sort_order, item_type)
    VALUES (p_tenant, v_inv, 'เงินมัดจำ ' || v_dep_pct || '% ของมูลค่างานตามใบเสนอราคา ' || q.quotation_number, 'งวด', v_line, 1, v_line, 0, 'item');
    v_sub := v_line;
  ELSE
    FOR qi IN SELECT * FROM quotation_items WHERE quotation_id = p_quotation AND item_type = 'item' ORDER BY sort_order LOOP
      v_line := 0; v_draw := 0;
      FOR u IN SELECT * FROM quotation_item_units WHERE quotation_item_id = qi.id ORDER BY unit_index LOOP
        v_line := v_line + round((p_target - p_prior) / 100 * u.unit_qty * qi.unit_price, 2);
        v_draw := v_draw + (p_target - p_prior) / 100 * u.unit_qty;
      END LOOP;
      INSERT INTO invoice_items (tenant_id, invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, item_type)
      VALUES (p_tenant, v_inv, qi.id, qi.description, qi.unit, qi.unit_price, v_draw, v_line, i, 'item') RETURNING id INTO v_item;
      i := i + 1;
      FOR u IN SELECT * FROM quotation_item_units WHERE quotation_item_id = qi.id ORDER BY unit_index LOOP
        INSERT INTO invoice_item_draws (tenant_id, invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount)
        VALUES (p_tenant, v_item, u.id, p_prior, p_target, round((p_target - p_prior) / 100 * u.unit_qty * qi.unit_price, 2));
        IF NOT v_void THEN
          UPDATE quotation_item_units SET cumulative_pct = p_target, updated_at = p_date::timestamptz WHERE id = u.id;
        END IF;
      END LOOP;
      v_sub := v_sub + v_line;
    END LOOP;
  END IF;
  v_vat := round(v_sub * 0.07, 2); v_total := v_sub + v_vat;
  UPDATE invoices SET subtotal = v_sub, vat = v_vat, total = v_total, status = CASE WHEN v_void THEN 'void' ELSE 'unpaid' END WHERE id = v_inv;
  IF p_paid IS NOT NULL AND NOT v_void THEN
    INSERT INTO receipts (tenant_id, receipt_number, tax_invoice_number, invoice_id, date, amount)
    VALUES (p_tenant, 'RE' || to_char(p_paid, 'YYMM') || '-' || lpad(p_seq::text, 3, '0'),
            'TR' || to_char(p_paid, 'YYMM') || '-' || lpad(p_seq::text, 3, '0'), v_inv, p_paid, v_total);
    v_tax := round(greatest(0, v_sub - v_dep_ded) * 3 / 100, 2);
    v_ret := CASE WHEN v_dep_pct IS NOT NULL THEN 0 ELSE round(v_sub * COALESCE(q.default_retention_pct, 0) / 100, 2) END;
    v_received := round(v_sub + v_vat - v_tax - v_ret - v_dep_ded, 2);
    INSERT INTO incomes (tenant_id, invoice_no, source_invoice_id, date, site_id, client_name, description, amount_no_vat, vat,
                         tax_withheld, retention, income_type, deposit_deduction, received_amount)
    VALUES (p_tenant, 'IV' || to_char(p_paid, 'YYMM') || '-' || lpad(p_seq::text, 3, '0'), v_inv, p_paid, q.site_id, q.client_name,
            v_num || ' — ' || q.quotation_number, v_sub, v_vat, v_tax, v_ret,
            CASE WHEN v_dep_pct IS NOT NULL THEN 'มัดจำ' ELSE 'ปกติ' END, v_dep_ded, v_received)
    RETURNING id INTO v_income;
    UPDATE invoices SET status = 'paid', paid_date = p_paid, income_id = v_income WHERE id = v_inv;
  END IF;
  RETURN v_inv;
END $$;
REVOKE ALL ON FUNCTION demo_invoice(UUID, UUID, DATE, INT, NUMERIC, NUMERIC, DATE, JSONB) FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION demo_seed_sales(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  q UUID; s RECORD; v_sub NUMERIC; v_dep NUMERIC; v_seq INT; v_m0 DATE := demo_m(0);
  -- standard line sets by site size
  L_HOUSE JSONB := '[{"name":"งานฐานรากและเสาเข็ม","qty":1,"price":380000},{"desc":"เสาเข็มเจาะ ขนาด 0.35 ม. ลึก 21 ม. จำนวน 24 ต้น"},{"name":"งานโครงสร้าง ค.ส.ล.","qty":280,"price":4200},{"name":"งานก่ออิฐฉาบปูน","qty":620,"price":650},{"name":"งานโครงหลังคาและมุงหลังคา","qty":210,"price":1850},{"desc":"กระเบื้องหลังคาคอนกรีต สีเทาเข้ม พร้อมฉนวนกันความร้อน"},{"name":"งานระบบไฟฟ้า","qty":48,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":22,"price":1500},{"name":"งานทาสีภายใน-ภายนอก","qty":900,"price":180},{"name":"งานปูกระเบื้อง","qty":260,"price":550},{"name":"งานประตู-หน้าต่าง","qty":18,"price":8500},{"note":"ระยะเวลาก่อสร้าง 180 วัน นับจากวันเซ็นสัญญา"}]'::jsonb;
  L_COMM JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":45000},{"name":"งานฐานรากและเสาเข็ม","qty":1,"price":520000},{"name":"งานโครงสร้าง ค.ส.ล.","qty":540,"price":4200},{"desc":"พื้น post-tension ชั้น 2-3 รับน้ำหนัก 400 กก./ตร.ม."},{"name":"งานก่ออิฐฉาบปูน","qty":1100,"price":650},{"name":"งานระบบไฟฟ้า","qty":96,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":36,"price":1500},{"name":"งานฝ้าเพดาน","qty":500,"price":420},{"name":"งานทาสีภายใน-ภายนอก","qty":1600,"price":180},{"name":"งานปูกระเบื้อง","qty":520,"price":550},{"name":"งานประตู-หน้าต่าง","qty":20,"price":8500},{"name":"งานรั้วและประตูรั้ว","qty":40,"price":3200},{"name":"งานถนนและลานจอดรถ","qty":300,"price":950},{"note":"ผู้ว่าจ้างเป็นผู้ขออนุญาตก่อสร้าง"}]'::jsonb;
  L_SMALL JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":25000},{"name":"งานโครงสร้าง ค.ส.ล.","qty":40,"price":4200},{"name":"งานก่ออิฐฉาบปูน","qty":90,"price":650},{"desc":"ผนังก่ออิฐมวลเบา หนา 7.5 ซม."},{"name":"งานระบบไฟฟ้า","qty":12,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":6,"price":1500},{"name":"งานปูกระเบื้อง","qty":45,"price":550},{"name":"งานทาสีภายใน-ภายนอก","qty":180,"price":180},{"name":"งานประตู-หน้าต่าง","qty":3,"price":8500}]'::jsonb;
  L_RENO JSONB := '[{"name":"งานรื้อถอน","qty":1,"price":60000},{"desc":"รื้อพื้น ผนังเบา ฝ้า และระบบไฟเดิมทั้งชั้น 1"},{"name":"งานก่ออิฐฉาบปูน","qty":150,"price":650},{"name":"งานระบบไฟฟ้า","qty":30,"price":1200},{"name":"งานระบบประปา-สุขาภิบาล","qty":10,"price":1500},{"name":"งานฝ้าเพดาน","qty":120,"price":420},{"name":"งานปูกระเบื้อง","qty":140,"price":550},{"name":"งานทาสีภายใน-ภายนอก","qty":400,"price":180},{"name":"งานสุขภัณฑ์","qty":2,"price":12000},{"name":"งานประตู-หน้าต่าง","qty":6,"price":8500}]'::jsonb;
BEGIN
  -- accepted quotations, one per non-cancelled site (9). Sequence numbers restart per month;
  -- dates are the site's start month so the QT prefix matches.
  FOR s IN SELECT name, start_date, status, default_deposit_pct, row_number() OVER (ORDER BY start_date) AS rn,
                  (SELECT c.name FROM clients c WHERE c.id = x.client_id) AS client
           FROM sites x WHERE tenant_id = p_tenant AND NOT is_default AND status <> 'Cancelled' ORDER BY start_date LOOP
    q := demo_quotation(p_tenant, s.name, s.client, s.start_date - 14, 1,
           'accepted',
           CASE WHEN s.name IN ('อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน','โกดังสินค้า บางบัวทอง','สำนักงานขาย โครงการเดอะพาร์ค') THEN L_COMM
                WHEN s.name IN ('ต่อเติมครัว คุณสมศักดิ์','ร้านกาแฟ เดอะ การ์เด้น') THEN L_SMALL
                WHEN s.name = 'รีโนเวทบ้าน คุณนภา' THEN L_RENO ELSE L_HOUSE END,
           CASE WHEN s.name IN ('บ้านคุณวิชัย ลาดพร้าว','คลับเฮาส์ หมู่บ้านพฤกษา') THEN '{"revision_snapshot":true}'::jsonb ELSE '{}'::jsonb END);
    SELECT sum(line_total) INTO v_sub FROM quotation_items WHERE quotation_id = q AND item_type = 'item';
    v_dep := CASE WHEN s.default_deposit_pct > 0 THEN round(v_sub * s.default_deposit_pct / 100, 2) ELSE 0 END;
    -- invoices per site status. Sequence numbers: 10 + rn keeps them unique inside a month across sites.
    IF s.status = 'Completed' THEN
      PERFORM demo_invoice(p_tenant, q, s.start_date + 20, 10 + s.rn, 0, 40, s.start_date + 35);
      PERFORM demo_invoice(p_tenant, q, s.start_date + 65, 10 + s.rn, 40, 80, s.start_date + 80);
      PERFORM demo_invoice(p_tenant, q, s.start_date + 110, 10 + s.rn, 80, 100, s.start_date + 125);
    ELSIF s.status = 'On Hold' THEN
      PERFORM demo_invoice(p_tenant, q, s.start_date + 20, 10 + s.rn, 0, 20, s.start_date + 40);
    ELSE -- Ongoing: progress decides how many draws exist and which are still unpaid
      IF s.default_deposit_pct > 0 THEN
        PERFORM demo_invoice(p_tenant, q, s.start_date + 2, 10 + s.rn, 0, 0, s.start_date + 5, jsonb_build_object('deposit_pct', s.default_deposit_pct));
      END IF;
      IF s.name = 'บ้านคุณวิชัย ลาดพร้าว' THEN            -- 85%: 3 paid draws, 4th unpaid and overdue, deposit deducted on the last
        PERFORM demo_invoice(p_tenant, q, s.start_date + 30, 10 + s.rn, 0, 30, s.start_date + 45);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 75, 10 + s.rn, 30, 55, s.start_date + 90);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 120, 10 + s.rn, 55, 75, s.start_date + 135);
        PERFORM demo_invoice(p_tenant, q, current_date - 25, 10 + s.rn, 75, 85, NULL, jsonb_build_object('due_days', 15, 'deposit_deduction', v_dep));
      ELSIF s.name = 'อาคารพาณิชย์ 3 ชั้น งามวงศ์วาน' THEN -- 70%: 2 paid, 1 unpaid overdue, plus 1 void (re-issued)
        PERFORM demo_invoice(p_tenant, q, s.start_date + 40, 10 + s.rn, 0, 35, s.start_date + 55);
        PERFORM demo_invoice(p_tenant, q, s.start_date + 95, 10 + s.rn, 35, 60, s.start_date + 110);
        PERFORM demo_invoice(p_tenant, q, current_date - 40, 10 + s.rn, 60, 70, NULL, '{"void":true}'::jsonb);
        PERFORM demo_invoice(p_tenant, q, current_date - 35, 20 + s.rn, 60, 70, NULL, '{"due_days":30}'::jsonb);
      ELSIF s.name = 'คลับเฮาส์ หมู่บ้านพฤกษา' THEN        -- 45%: 1 paid, 1 unpaid (not yet due)
        PERFORM demo_invoice(p_tenant, q, s.start_date + 35, 10 + s.rn, 0, 30, s.start_date + 50);
        PERFORM demo_invoice(p_tenant, q, current_date - 5, 10 + s.rn, 30, 45, NULL, '{"due_days":30}'::jsonb);
      ELSIF s.name = 'โกดังสินค้า บางบัวทอง' THEN          -- 30%: 1 paid draw
        PERFORM demo_invoice(p_tenant, q, s.start_date + 40, 10 + s.rn, 0, 30, s.start_date + 55);
      ELSE                                                  -- รีโนเวท 15%: 1 unpaid (fresh)
        PERFORM demo_invoice(p_tenant, q, current_date - 3, 10 + s.rn, 0, 15, NULL, '{"due_days":15}'::jsonb);
      END IF;
    END IF;
  END LOOP;

  -- open pipeline: 3 drafts, 4 sent (one about to expire, one on hold), 2 rejected -- no site link
  PERFORM demo_quotation(p_tenant, 'บ้านพักอาศัย 2 ชั้น บางใหญ่', 'คุณอรุณ ตั้งใจดี', current_date - 2, 30, 'draft', L_HOUSE, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ต่อเติมโรงจอดรถ คุณวิชัย', 'คุณวิชัย ศรีสุข', current_date - 1, 31, 'draft', L_SMALL, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ปรับปรุงสำนักงาน ชั้น 2', 'บจก. งามวงศ์วาน เทรดดิ้ง', current_date, 32, 'draft', L_RENO, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'บ้านแฝด 2 หลัง โครงการพฤกษา', 'บจก. พฤกษา พร็อพเพอร์ตี้', current_date - 25, 33, 'sent', L_HOUSE, jsonb_build_object('site_name_only', true, 'valid_until', current_date + 5));
  PERFORM demo_quotation(p_tenant, 'คลังสินค้าหลัง 2 บางบัวทอง', 'หจก. บางบัวทอง โลจิสติกส์', current_date - 12, 34, 'sent', L_COMM, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'ร้านอาหารริมน้ำ ปากเกร็ด', 'คุณสมศักดิ์ มั่นคง', current_date - 40, 35, 'sent', L_SMALL, jsonb_build_object('site_name_only', true, 'on_hold', true, 'valid_until', current_date - 10));
  PERFORM demo_quotation(p_tenant, 'รีโนเวทคอนโด คุณนภา', 'คุณนภา พงศ์ไพบูลย์', current_date - 8, 36, 'sent', L_RENO, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'อาคารสำนักงานขาย เฟส 2', 'บจก. เดอะพาร์ค ดีเวลลอปเมนท์', demo_m(2) + 10, 40, 'rejected', L_COMM, '{"site_name_only":true}');
  PERFORM demo_quotation(p_tenant, 'บ้านพักตากอากาศ', 'คุณอรุณ ตั้งใจดี', demo_m(3) + 15, 41, 'rejected', L_HOUSE, '{"site_name_only":true}');

  RETURN jsonb_build_object(
    'quotations', (SELECT count(*) FROM quotations WHERE tenant_id = p_tenant),
    'revisions', (SELECT count(*) FROM quotation_revisions WHERE tenant_id = p_tenant),
    'invoices', (SELECT count(*) FROM invoices WHERE tenant_id = p_tenant),
    'invoices_paid', (SELECT count(*) FROM invoices WHERE tenant_id = p_tenant AND status = 'paid'),
    'receipts', (SELECT count(*) FROM receipts WHERE tenant_id = p_tenant),
    'incomes', (SELECT count(*) FROM incomes WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_sales(UUID) FROM PUBLIC, anon, authenticated;
```

Wire into `seed_demo_tenant`: `v_out := v_out || demo_seed_sales(p_tenant_id);` after the core call.

Number uniqueness note: quotation seq numbers are 1 for each accepted site (dates fall in different months because site starts are spread over months 1..8; two sites starting in the same month would collide). Site start months in Task 2 are 5,4,3,2,1,8,7,6,3,4 → month 3 and 4 each have two sites. Fix: use `p_seq = s.rn` instead of `1` for accepted quotations (rn is unique). Do that. Invoice seq uses `10 + rn` / `20 + rn`; two invoices of the same site in the same month would collide only if two draws fall in one month: the schedules above are ≥ 30 days apart except the void/re-issued pair, which uses 10+rn and 20+rn. Receipt/income seq reuse the invoice seq with the paid month, which keeps them unique for the same reason.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: `RESULT: demo_tenant_seed_test ALL PASSED`. On a `duplicate key ... invoice_number` error, print the colliding numbers with
`select invoice_number, count(*) from invoices where tenant_id = ... group by 1 having count(*) > 1` inside the test to find which schedule line needs a different seq.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "feat(demo): seed quotations, revisions, invoices, draws, receipts, incomes"
```

---

### Task 4: `demo_seed_purchasing` — POs, expenses, cheques, inventory ledger + balances

**Files:**
- Modify: migration (add `demo_seed_purchasing` before `seed_demo_tenant`; add call)
- Modify: test (T4 block)

**Interfaces:**
- Consumes: sites, suppliers, categories by name; `demo_m`.
- Produces: `demo_seed_purchasing(p_tenant UUID) RETURNS JSONB` with keys `purchase_orders, expenses, cheques, inventory_items, stock_movements, balances`.

- [ ] **Step 1: Write the failing test**

```sql
  -- ── T4 ── purchasing, expenses, cheques, stock
  IF COALESCE((s1->>'purchase_orders')::int, -1) <> 12 THEN RAISE EXCEPTION 'T4 FAIL: pos=%', s1->>'purchase_orders'; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND status = 'draft';
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: draft pos=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND status = 'received' AND (expense_id IS NULL OR received_date IS NULL);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: received PO without expense/received_date'; END IF;
  SELECT count(*) INTO v_n FROM purchase_orders WHERE tenant_id = t_tenant AND po_number !~ ('^PO' || to_char(date, 'YYMM') || '-[0-9]{3}$');
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: po number/date mismatch'; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant;
  IF v_n < 150 THEN RAISE EXCEPTION 'T4 FAIL: expenses=%', v_n; END IF;
  SELECT count(DISTINCT to_char(date, 'YYYY-MM')) INTO v_n FROM expenses WHERE tenant_id = t_tenant;
  IF v_n < 8 THEN RAISE EXCEPTION 'T4 FAIL: expenses cover only % months', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant AND status = 'pending' AND due_date BETWEEN current_date AND current_date + 30;
  IF v_n < 5 THEN RAISE EXCEPTION 'T4 FAIL: too few pending expenses for the forecast (%)', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses WHERE tenant_id = t_tenant AND category_id IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: expense without category'; END IF;
  SELECT count(*) INTO v_n FROM cheques WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T4 FAIL: cheques=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM cheques WHERE tenant_id = t_tenant AND status = 'issued' AND check_date BETWEEN current_date AND current_date + 3;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T4 FAIL: cheque due within 3 days=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM expenses e JOIN cheques c ON c.id = e.cheque_id WHERE e.tenant_id = t_tenant
    AND e.status <> CASE c.status WHEN 'cashed' THEN 'check_cleared' ELSE 'check_issued' END;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: % cheque-linked expenses out of sync with cheque status', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_items WHERE tenant_id = t_tenant;
  IF v_n <> 12 THEN RAISE EXCEPTION 'T4 FAIL: inventory items=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_items WHERE tenant_id = t_tenant AND code !~ '^[A-Z]{3}-[0-9]{4}$';
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: inventory code format'; END IF;
  -- ledger == balances, nothing negative
  SELECT count(*) INTO v_n FROM (
    SELECT inventory_item_id, site_id, sum(quantity) AS q FROM stock_movements WHERE tenant_id = t_tenant GROUP BY 1, 2) l
    FULL JOIN inventory_stock_balances b ON b.inventory_item_id = l.inventory_item_id AND b.site_id = l.site_id AND b.tenant_id = t_tenant
    WHERE b.id IS NULL OR l.inventory_item_id IS NULL OR abs(b.quantity_on_hand - l.q) > 0.0001;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: % (item,site) pairs where balance != ledger', v_n; END IF;
  SELECT count(*) INTO v_n FROM inventory_stock_balances WHERE tenant_id = t_tenant AND (quantity_on_hand < 0 OR weighted_average_cost < 0);
  IF v_n <> 0 THEN RAISE EXCEPTION 'T4 FAIL: negative balance or cost'; END IF;
  SELECT count(*) INTO v_n FROM stock_movements WHERE tenant_id = t_tenant AND movement_type = 'purchase_in' AND reference_type = 'purchase_order';
  IF v_n < 7 THEN RAISE EXCEPTION 'T4 FAIL: purchase_in movements=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM stock_movements WHERE tenant_id = t_tenant AND movement_type IN ('transfer_out','transfer_in');
  IF v_n < 4 THEN RAISE EXCEPTION 'T4 FAIL: transfers=%', v_n; END IF;
  -- bell: draft PO and cheque due
  PERFORM set_config('request.jwt.claims', json_build_object('email', owner_email, 'role', 'authenticated')::text, true);
  IF COALESCE((pending_counts()->>'po_draft')::int, 0) <> 1 THEN RAISE EXCEPTION 'T4 FAIL: pending_counts.po_draft=%', pending_counts()->>'po_draft'; END IF;
  IF COALESCE((pending_counts()->>'cheques_due')::int, 0) < 1 THEN RAISE EXCEPTION 'T4 FAIL: pending_counts.cheques_due'; END IF;
  PERFORM set_config('request.jwt.claims', json_build_object('email', admin_email, 'role', 'authenticated')::text, true);
```

If `pending_counts()` is SECURITY INVOKER and relies on RLS for scoping, running as postgres will count across tenants. In that case replace the two bell checks with direct counts (`purchase_orders` draft for the tenant = 1; cheques due = 1) and note it in the test comment.

- [ ] **Step 2: Run the harness to verify it fails**

Expected: `T4 FAIL: pos=`.

- [ ] **Step 3: Write the section**

```sql
CREATE OR REPLACE FUNCTION demo_seed_purchasing(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_central UUID; v_site UUID; v_sup UUID; v_cat UUID; v_po UUID; v_exp UUID; v_chq UUID; v_item UUID; k INT; i INT; j INT;
  v_date DATE; v_amt NUMERIC; v_sub NUMERIC; v_qty NUMERIC; v_price NUMERIC; v_bal NUMERIC; v_wac NUMERIC; v_status TEXT; v_seq INT;
  v_cats TEXT[] := ARRAY['งานโครงสร้าง (ปูน/เหล็ก)','งานสถาปัตย์','ไฟฟ้า/ประปา','วัสดุสิ้นเปลือง','ค่าแรง','ค่าเดินทาง','เครื่องมือ','เบ็ดเตล็ด'];
  v_sups TEXT[] := ARRAY['บจก. ไทยวัสดุก่อสร้าง','ร้านเจริญเหล็ก','หจก. ปูนดี ซัพพลาย','ร้านไฟฟ้าสมบูรณ์','บจก. สุขภัณฑ์ไทย','ร้านสีสวย','บจก. เครื่องมือช่าง โปร','ร้านอิฐบล็อก บางใหญ่'];
  v_desc TEXT[] := ARRAY['ปูนซีเมนต์และทราย','เหล็กเส้นและลวดผูก','อิฐมวลเบาและปูนก่อ','สายไฟและท่อร้อยสาย','ท่อ PVC และข้อต่อ','สีรองพื้นและสีทับหน้า','ค่าเช่าเครื่องตบดิน','ค่าแรงรายวันเหมาช่วง','น้ำมันรถขนของ','กระเบื้องและกาวซีเมนต์','ไม้แบบและตะปู','ค่าขนส่งวัสดุ'];
  -- inventory items: name, base unit, category prefix, unit cost
  v_inv TEXT[][] := ARRAY[
    ARRAY['ปูนซีเมนต์ปอร์ตแลนด์ 50 กก.','ถุง','STR','165'], ARRAY['เหล็กเส้นกลม RB9','เส้น','STR','185'],
    ARRAY['เหล็กข้ออ้อย DB12','เส้น','STR','320'], ARRAY['เหล็กข้ออ้อย DB16','เส้น','STR','560'],
    ARRAY['อิฐมอญ','ก้อน','ARC','1.2'], ARRAY['อิฐมวลเบา 7.5 ซม.','ก้อน','ARC','14'],
    ARRAY['ทรายหยาบ','คิว','STR','650'], ARRAY['หิน 3/4','คิว','STR','720'],
    ARRAY['ไม้แบบ 1x6 นิ้ว','แผ่น','SUP','95'], ARRAY['ลวดผูกเหล็ก','กก.','SUP','42'],
    ARRAY['สายไฟ THW 2.5 ตร.มม.','ม้วน','MEP','1850'], ARRAY['ท่อ PVC 4 นิ้ว','เส้น','MEP','310']];
  v_items UUID[] := '{}'; v_costs NUMERIC[] := '{}';
  v_sites UUID[]; v_site_names TEXT[]; v_site_status TEXT[]; v_site_start DATE[];
BEGIN
  SELECT id INTO v_central FROM sites WHERE tenant_id = p_tenant AND is_default;
  SELECT array_agg(id ORDER BY start_date), array_agg(name ORDER BY start_date), array_agg(status ORDER BY start_date), array_agg(start_date ORDER BY start_date)
    INTO v_sites, v_site_names, v_site_status, v_site_start
    FROM sites WHERE tenant_id = p_tenant AND NOT is_default AND status IN ('Ongoing','Completed','On Hold');

  -- inventory items
  FOR i IN 1..12 LOOP
    SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = p_tenant AND code_prefix = v_inv[i][3];
    INSERT INTO inventory_items (tenant_id, name, base_unit, active, unit_conversion_mode, category_id, code, item_kind)
    VALUES (p_tenant, v_inv[i][1], v_inv[i][2], true, 'plain', v_cat, v_inv[i][3] || '-' || lpad(i::text, 4, '0'), 'raw_material')
    RETURNING id INTO v_item;
    v_items := v_items || v_item; v_costs := v_costs || v_inv[i][4]::numeric;
  END LOOP;

  -- 12 purchase orders: 7 received (stock in at ส่วนกลาง), 3 ordered, 1 draft, 1 cancelled
  FOR k IN 1..12 LOOP
    v_status := CASE WHEN k <= 7 THEN 'received' WHEN k <= 10 THEN 'ordered' WHEN k = 11 THEN 'draft' ELSE 'cancelled' END;
    v_date := CASE WHEN k <= 7 THEN demo_m(8 - k) + 5 + k WHEN k <= 10 THEN current_date - (k - 7) * 4 WHEN k = 11 THEN current_date - 1 ELSE demo_m(2) + 12 END;
    i := ((k - 1) % 3) + 1;                       -- supplier: rotate the 3 material suppliers
    v_site := v_sites[((k - 1) % cardinality(v_sites)) + 1];
    SELECT id INTO v_sup FROM suppliers WHERE tenant_id = p_tenant AND name = v_sups[i];
    SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = p_tenant AND name = v_cats[1];
    INSERT INTO purchase_orders (tenant_id, po_number, site_id, supplier_id, category_id, date, status, has_vat, price_includes_vat, ordered_by, notes, received_date)
    VALUES (p_tenant, 'PO' || to_char(v_date, 'YYMM') || '-' || lpad(k::text, 3, '0'), v_site, v_sup, v_cat, v_date, v_status, true, false,
            demo_owner_email(p_tenant), CASE WHEN v_status = 'cancelled' THEN 'ซัพพลายเออร์ส่งของไม่ทัน ยกเลิกและสั่งเจ้าอื่น' ELSE NULL END,
            CASE WHEN v_status = 'received' THEN v_date + 3 ELSE NULL END)
    RETURNING id INTO v_po;
    v_sub := 0;
    FOR j IN 1..3 LOOP                              -- 3 lines per PO, items rotate through the list
      i := ((k + j * 4 - 1) % 12) + 1;
      v_qty := 20 + ((k * 7 + j * 11) % 60); v_price := v_costs[i] * (0.95 + ((k + j) % 5) * 0.025);
      INSERT INTO purchase_order_items (tenant_id, po_id, description, quantity, unit, unit_price, line_total, sort_order, inventory_item_id, discount_pct)
      VALUES (p_tenant, v_po, v_inv[i][1], v_qty, v_inv[i][2], round(v_price, 2), round(v_qty * v_price, 2), j - 1, v_items[i], 0);
      v_sub := v_sub + round(v_qty * v_price, 2);
      IF v_status = 'received' THEN
        -- ledger + weighted average, same arithmetic as record_stock_movement purchase_in
        SELECT quantity_on_hand, weighted_average_cost INTO v_bal, v_wac FROM inventory_stock_balances WHERE inventory_item_id = v_items[i] AND site_id = v_central;
        IF v_bal IS NULL THEN
          INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost) VALUES (p_tenant, v_items[i], v_central, v_qty, round(v_price, 4));
        ELSE
          UPDATE inventory_stock_balances SET quantity_on_hand = v_bal + v_qty,
            weighted_average_cost = round((v_bal * v_wac + v_qty * v_price) / (v_bal + v_qty), 4), updated_at = (v_date + 3)::timestamptz
            WHERE inventory_item_id = v_items[i] AND site_id = v_central;
        END IF;
        INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, reference_id, notes, created_by, created_at)
        VALUES (p_tenant, v_items[i], v_central, 'purchase_in', v_qty, round(v_price, 2), 'purchase_order', v_po, 'รับของตาม PO', demo_owner_email(p_tenant), (v_date + 3)::timestamptz);
      END IF;
    END LOOP;
    IF v_status = 'received' THEN
      INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount, payment_method,
                            status, invoice_no, po_id, billing_date, due_date)
      SELECT p_tenant, v_date + 3, 'รับของตามใบสั่งซื้อ ' || po_number, v_site, v_cat, v_sup, v_sups[((k - 1) % 3) + 1], v_sub, round(v_sub * 0.07, 2), round(v_sub * 1.07, 2),
             CASE WHEN s.credit_days > 0 THEN 'transfer' ELSE 'cash' END,
             CASE WHEN s.credit_days > 0 AND v_date + 3 + s.credit_days > current_date THEN 'pending' WHEN s.credit_days > 0 THEN 'paid' ELSE 'paid' END,
             'INV-' || to_char(v_date, 'YYMM') || '-' || lpad((500 + k)::text, 4, '0'), v_po, v_date + 3, v_date + 3 + COALESCE(s.credit_days, 0)
      FROM purchase_orders po JOIN suppliers s ON s.id = po.supplier_id WHERE po.id = v_po
      RETURNING id INTO v_exp;
      UPDATE purchase_orders SET expense_id = v_exp WHERE id = v_po;
    END IF;
  END LOOP;

  -- transfers from ส่วนกลาง to the two most active sites, and one count adjustment
  FOR j IN 1..4 LOOP
    i := j * 2; v_site := v_sites[cardinality(v_sites) - (j % 2)];   -- last two sites by start date = newest Ongoing
    SELECT quantity_on_hand, weighted_average_cost INTO v_bal, v_wac FROM inventory_stock_balances WHERE inventory_item_id = v_items[i] AND site_id = v_central;
    IF v_bal IS NOT NULL AND v_bal >= 10 THEN
      v_qty := floor(v_bal / 2);
      UPDATE inventory_stock_balances SET quantity_on_hand = quantity_on_hand - v_qty, updated_at = now() WHERE inventory_item_id = v_items[i] AND site_id = v_central;
      INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
      VALUES (p_tenant, v_items[i], v_central, 'transfer_out', -v_qty, v_wac, 'transfer', 'โอนไปหน้างาน', demo_owner_email(p_tenant), (current_date - 10 + j)::timestamptz);
      INSERT INTO inventory_stock_balances (tenant_id, inventory_item_id, site_id, quantity_on_hand, weighted_average_cost)
      VALUES (p_tenant, v_items[i], v_site, v_qty, v_wac)
      ON CONFLICT (inventory_item_id, site_id) DO UPDATE SET quantity_on_hand = inventory_stock_balances.quantity_on_hand + EXCLUDED.quantity_on_hand, updated_at = now();
      INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
      VALUES (p_tenant, v_items[i], v_site, 'transfer_in', v_qty, v_wac, 'transfer', 'รับโอนจากส่วนกลาง', demo_owner_email(p_tenant), (current_date - 10 + j)::timestamptz);
    END IF;
  END LOOP;
  -- adjustment: physical count found 3 fewer bags of cement at ส่วนกลาง
  SELECT quantity_on_hand, weighted_average_cost INTO v_bal, v_wac FROM inventory_stock_balances WHERE inventory_item_id = v_items[1] AND site_id = v_central;
  IF v_bal IS NOT NULL AND v_bal >= 3 THEN
    UPDATE inventory_stock_balances SET quantity_on_hand = v_bal - 3, updated_at = now() WHERE inventory_item_id = v_items[1] AND site_id = v_central;
    INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost, reference_type, notes, created_by, created_at)
    VALUES (p_tenant, v_items[1], v_central, 'adjustment', -3, v_wac, 'manual_adjustment', 'นับสต๊อกประจำเดือน ถุงแตก 3 ถุง', demo_owner_email(p_tenant), (current_date - 2)::timestamptz);
  END IF;

  -- cheques: 3 cashed (past), 3 issued (one due in 2 days)
  FOR k IN 1..6 LOOP
    INSERT INTO cheques (tenant_id, cheque_no, bank, status, check_date, cashed_at, created_by, notes)
    VALUES (p_tenant, lpad((1000200 + k * 7)::text, 8, '0'), CASE WHEN k % 2 = 0 THEN 'ธนาคารกสิกรไทย' ELSE 'ธนาคารกรุงเทพ' END,
            CASE WHEN k <= 3 THEN 'cashed' ELSE 'issued' END,
            CASE WHEN k <= 3 THEN demo_m(4 - k) + 10 + k WHEN k = 4 THEN current_date + 2 WHEN k = 5 THEN current_date + 12 ELSE current_date + 25 END,
            CASE WHEN k <= 3 THEN (demo_m(4 - k) + 11 + k)::timestamptz ELSE NULL END, demo_owner_email(p_tenant), NULL)
    RETURNING id INTO v_chq;
    -- one supplier bill paid by each cheque (expense status is synced from the cheque by trigger)
    SELECT id INTO v_sup FROM suppliers WHERE tenant_id = p_tenant AND name = v_sups[((k - 1) % 8) + 1];
    SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = p_tenant AND name = v_cats[((k - 1) % 4) + 1];
    v_amt := 18000 + k * 6500;
    INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount, payment_method, status, cheque_id, invoice_no)
    VALUES (p_tenant, CASE WHEN k <= 3 THEN demo_m(4 - k) + 3 + k ELSE current_date - 20 + k * 3 END, 'ค่าวัสดุ ' || v_desc[((k - 1) % 12) + 1] || ' (จ่ายเช็ค)',
            v_sites[((k - 1) % cardinality(v_sites)) + 1], v_cat, v_sup, v_sups[((k - 1) % 8) + 1], v_amt, round(v_amt * 0.07, 2), round(v_amt * 1.07, 2),
            'check', 'check_issued', v_chq, 'BILL-' || lpad((7000 + k)::text, 5, '0'));
  END LOOP;

  -- general expenses: months 8..0, 3-6 per active site per month; status by age
  v_seq := 0;
  FOR k IN REVERSE 8..0 LOOP
    FOR i IN 1..cardinality(v_sites) LOOP
      CONTINUE WHEN v_site_start[i] > demo_m(k) + 27;                                       -- site not started yet
      CONTINUE WHEN v_site_status[i] = 'Completed' AND v_site_start[i] + 190 < demo_m(k);   -- long finished
      FOR j IN 1..(3 + ((k + i) % 4)) LOOP
        v_seq := v_seq + 1;
        v_date := least(demo_m(k) + ((v_seq * 7 + j * 3) % 27) + 1, current_date);
        v_amt := round((2500 + random() * 38000)::numeric, 0);
        SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = p_tenant AND name = v_cats[((v_seq + j) % 8) + 1];
        SELECT id INTO v_sup FROM suppliers WHERE tenant_id = p_tenant AND name = v_sups[((v_seq) % 8) + 1];
        INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier_id, supplier, amount_no_vat, vat, amount, payment_method, status, due_date, payer)
        VALUES (p_tenant, v_date, v_desc[((v_seq + j) % 12) + 1], v_sites[i], v_cat,
                CASE WHEN (v_seq % 3) = 0 THEN NULL ELSE v_sup END, CASE WHEN (v_seq % 3) = 0 THEN NULL ELSE v_sups[((v_seq) % 8) + 1] END,
                v_amt, round(v_amt * 0.07, 2), round(v_amt * 1.07, 2),
                CASE (v_seq % 4) WHEN 0 THEN 'cash' ELSE 'transfer' END,
                CASE WHEN v_date >= current_date - 20 AND (v_seq % 3) <> 0 THEN 'pending' ELSE 'paid' END,
                CASE WHEN v_date >= current_date - 20 AND (v_seq % 3) <> 0 THEN v_date + 30 ELSE NULL END,
                CASE (v_seq % 5) WHEN 0 THEN 'สมหญิง' ELSE 'บริษัท' END);
      END LOOP;
    END LOOP;
  END LOOP;

  RETURN jsonb_build_object(
    'purchase_orders', (SELECT count(*) FROM purchase_orders WHERE tenant_id = p_tenant),
    'expenses', (SELECT count(*) FROM expenses WHERE tenant_id = p_tenant),
    'cheques', (SELECT count(*) FROM cheques WHERE tenant_id = p_tenant),
    'inventory_items', (SELECT count(*) FROM inventory_items WHERE tenant_id = p_tenant),
    'stock_movements', (SELECT count(*) FROM stock_movements WHERE tenant_id = p_tenant),
    'balances', (SELECT count(*) FROM inventory_stock_balances WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_purchasing(UUID) FROM PUBLIC, anon, authenticated;
```

Wire: `v_out := v_out || demo_seed_purchasing(p_tenant_id);`

Notes for the implementer:
- `inventory_stock_balances` has `UNIQUE(inventory_item_id, site_id)`; the `ON CONFLICT` above names exactly those columns (upsert lesson).
- `stock_movements.quantity` sign convention: check `record_stock_movement` in `migrations/2026-09-05-15-invoice-cogs-sale-movement-types.sql` lines 8-100. If it stores `transfer_out` as a positive quantity and subtracts by type, change the two `-v_qty`/`-3` inserts to positive and make the T4 ledger check sum with `CASE movement_type WHEN 'transfer_out' THEN -quantity WHEN 'sale_out' THEN -quantity WHEN 'adjustment' THEN quantity ELSE quantity END`. Match the RPC exactly; the test is the arbiter.
- The 150-expense floor: 9 sites × up to 9 months × 3-6 rows minus the skips lands around 200. If the count is lower than 150, widen `3 + ((k + i) % 4)` to `4 + ...`.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: ALL PASSED.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "feat(demo): seed purchase orders, expenses, cheques, stock ledger and balances"
```

---

### Task 5: `demo_seed_people` — workers, teams, assignments, check-ins, OT, leave, holidays, payroll, subcontractors, LINE group, issues

**Files:**
- Modify: migration (add `demo_seed_people`; add call)
- Modify: test (T5 block)

**Interfaces:**
- Consumes: sites by status; `demo_worker_email`; categories by name ('ค่าแรง').
- Produces: `demo_seed_people(p_tenant UUID) RETURNS JSONB` with keys `workers, teams, assignments, checkins, ot, leave_requests, salary_records, subcontractors, labor_contracts, labor_payments, line_groups, issue_reports`.

- [ ] **Step 1: Write the failing test**

```sql
  -- ── T5 ── people
  IF COALESCE((s1->>'workers')::int, -1) <> 12 THEN RAISE EXCEPTION 'T5 FAIL: workers=%', s1->>'workers'; END IF;
  SELECT count(*) INTO v_n FROM workers WHERE tenant_id = t_tenant AND email = worker_email;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: worker login not linked'; END IF;
  SELECT count(*) INTO v_n FROM worker_teams WHERE tenant_id = t_tenant;
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: teams=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_team_members WHERE tenant_id = t_tenant;
  IF v_n <> 12 THEN RAISE EXCEPTION 'T5 FAIL: team members=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant;
  IF v_n < 1000 THEN RAISE EXCEPTION 'T5 FAIL: assignments=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant AND type = 'site' AND site_id IS NULL;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: site assignment without site'; END IF;
  SELECT count(*) INTO v_n FROM worker_assignments WHERE tenant_id = t_tenant AND date > current_date;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: assignment in the future'; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant;
  IF v_n < 100 THEN RAISE EXCEPTION 'T5 FAIL: checkins=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM worker_checkins WHERE tenant_id = t_tenant AND checkin_distance_m > 200;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: checkin outside radius'; END IF;
  SELECT count(*) INTO v_n FROM worker_ot WHERE tenant_id = t_tenant;
  IF v_n < 12 THEN RAISE EXCEPTION 'T5 FAIL: ot=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM leave_requests WHERE tenant_id = t_tenant AND status = 'pending';
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: pending leave=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM leave_requests WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T5 FAIL: leave=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM company_holidays WHERE tenant_id = t_tenant AND date >= current_date;
  IF v_n < 2 THEN RAISE EXCEPTION 'T5 FAIL: upcoming holidays=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM salary_records WHERE tenant_id = t_tenant;
  IF v_n <> 24 THEN RAISE EXCEPTION 'T5 FAIL: salary records=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM salary_records WHERE tenant_id = t_tenant AND abs(net_pay - (base_salary - social_security_ded - leave_deduction + ot_amount)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: % salary records break the net formula', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_subcontractors WHERE tenant_id = t_tenant;
  IF v_n <> 3 THEN RAISE EXCEPTION 'T5 FAIL: subcontractors=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_contracts WHERE tenant_id = t_tenant;
  IF v_n <> 4 THEN RAISE EXCEPTION 'T5 FAIL: contracts=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant;
  IF v_n <> 6 THEN RAISE EXCEPTION 'T5 FAIL: payments=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND status = 'paid';
  SELECT count(*) INTO v_n2 FROM expenses WHERE tenant_id = t_tenant AND is_subcontract;
  IF v_n <> 5 OR v_n2 <> 5 THEN RAISE EXCEPTION 'T5 FAIL: paid payments=% subcontract expenses=%', v_n, v_n2; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND abs(net_amount - (gross_amount - withholding_tax - retention_amount)) > 0.01;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T5 FAIL: labor payment net formula'; END IF;
  SELECT count(*) INTO v_n FROM labor_payments WHERE tenant_id = t_tenant AND is_retention_release;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: retention release=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_groups WHERE tenant_id = t_tenant;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T5 FAIL: line groups=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM line_issue_reports WHERE tenant_id = t_tenant AND status = 'open';
  IF v_n <> 2 THEN RAISE EXCEPTION 'T5 FAIL: open issues=%', v_n; END IF;
  SELECT count(*) INTO v_n FROM app_settings WHERE tenant_id = t_tenant AND key IN ('sign_physical_enabled','checkin_radius_m','cheque_reminder_days','require_checkin_confirmation','regular_shift_end_time');
  IF v_n <> 5 THEN RAISE EXCEPTION 'T5 FAIL: app settings=%', v_n; END IF;
```

- [ ] **Step 2: Run the harness to verify it fails**

Expected: `T5 FAIL: workers=`.

- [ ] **Step 3: Write the section**

```sql
CREATE OR REPLACE FUNCTION demo_seed_people(p_tenant UUID)
RETURNS JSONB LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  v_w UUID[] := '{}'; v_wid UUID; v_team_a UUID; v_team_b UUID; v_office UUID; v_site UUID; v_sites UUID[]; v_lat NUMERIC[]; v_lng NUMERIC[];
  i INT; d DATE; dow INT; v_type TEXT; v_shift TEXT; v_dist NUMERIC; v_cat UUID; v_sub UUID; v_contract UUID; v_gross NUMERIC; v_wht NUMERIC; v_ret NUMERIC;
  v_sal NUMERIC; v_ss NUMERIC; v_leave NUMERIC; v_ot NUMERIC; v_month INT; v_year INT; m DATE; v_num INT := 0;
  v_names TEXT[] := ARRAY['สมชาย ใจดี','ประยุทธ์ มานะ','วีระ แก้วใส','สุรชัย ทองดี','อนันต์ ศรีสุข','บุญมี พรหมมา','ธงชัย รักงาน','สมศักดิ์ เพียรดี','กิตติ บุญช่วย','นพดล ยอดช่าง','สุเทพ มั่นคง','วิชิต แสงทอง'];
  v_nick TEXT[] := ARRAY['ชาย','ยุทธ','วี','ชัย','นันต์','มี','ธง','ศักดิ์','กิต','นพ','เทพ','ชิต'];
  v_pos TEXT[] := ARRAY['โฟร์แมน','ช่างปูน','ช่างปูน','ช่างเหล็ก','ช่างไฟ','กรรมกร','โฟร์แมน','ช่างปูน','ช่างเหล็ก','ช่างไฟ','ช่างประปา','กรรมกร'];
  v_salary NUMERIC[] := ARRAY[28000,16500,16000,17500,18000,12000,26000,16000,17000,18500,17000,12500];
  v_subs TEXT[] := ARRAY['ทีมช่างปูน นายสมบัติ','หจก. ไฟฟ้าสยาม เซอร์วิส','ทีมช่างเหล็ก นายวิรัตน์'];
  v_sub_ids UUID[] := '{}';
BEGIN
  SELECT array_agg(id ORDER BY start_date), array_agg(lat ORDER BY start_date), array_agg(lng ORDER BY start_date)
    INTO v_sites, v_lat, v_lng FROM sites WHERE tenant_id = p_tenant AND status = 'Ongoing';

  INSERT INTO app_settings (tenant_id, key, value) VALUES
    (p_tenant, 'sign_physical_enabled', 'true'), (p_tenant, 'checkin_radius_m', '200'), (p_tenant, 'cheque_reminder_days', '3'),
    (p_tenant, 'require_checkin_confirmation', 'false'), (p_tenant, 'regular_shift_end_time', '17:00')
  ON CONFLICT DO NOTHING;
  INSERT INTO checkin_locations (tenant_id, name, lat, lng, active) VALUES (p_tenant, 'สำนักงาน รัตนาธิเบศร์', 13.8640, 100.5110, true) RETURNING id INTO v_office;

  FOR i IN 1..12 LOOP
    INSERT INTO workers (tenant_id, name, nickname, position, monthly_salary, has_social_security, annual_leave_days, annual_sick_leave_days, status, show_in_assign, email)
    VALUES (p_tenant, v_names[i], v_nick[i], v_pos[i], v_salary[i], true, 6, 30, 'active', true, CASE WHEN i = 1 THEN demo_worker_email(p_tenant) ELSE NULL END)
    RETURNING id INTO v_wid;
    v_w := v_w || v_wid;
  END LOOP;
  INSERT INTO worker_teams (tenant_id, name) VALUES (p_tenant, 'ทีม A (โฟร์แมนสมชาย)') RETURNING id INTO v_team_a;
  INSERT INTO worker_teams (tenant_id, name) VALUES (p_tenant, 'ทีม B (โฟร์แมนธงชัย)') RETURNING id INTO v_team_b;
  FOR i IN 1..12 LOOP
    INSERT INTO worker_team_members (tenant_id, team_id, worker_id) VALUES (p_tenant, CASE WHEN i <= 6 THEN v_team_a ELSE v_team_b END, v_w[i]);
  END LOOP;
  INSERT INTO company_holidays (tenant_id, date, name) VALUES
    (p_tenant, current_date + 9, 'วันหยุดประจำปีบริษัท'), (p_tenant, current_date + 40, 'วันหยุดชดเชย'), (p_tenant, current_date - 30, 'วันหยุดตามประกาศ');

  -- assignments: last 10 weeks, Mon-Sat two shifts, team A on the newest site, team B on the second newest; Sundays = holiday
  FOR d IN SELECT generate_series(current_date - 69, current_date, '1 day')::date LOOP
    dow := extract(isodow FROM d);
    FOR i IN 1..12 LOOP
      v_site := CASE WHEN i <= 6 THEN v_sites[cardinality(v_sites)] ELSE v_sites[cardinality(v_sites) - 1] END;
      v_type := CASE WHEN dow = 7 THEN 'holiday'
                     WHEN (i + extract(doy FROM d)::int) % 23 = 0 THEN 'leave_personal'
                     WHEN (i + extract(doy FROM d)::int) % 31 = 0 THEN 'leave_sick'
                     WHEN i IN (1, 7) AND dow = 6 THEN 'office'
                     WHEN (i + extract(doy FROM d)::int) % 9 = 0 THEN 'factory' ELSE 'site' END;
      FOREACH v_shift IN ARRAY ARRAY['morning','evening'] LOOP
        INSERT INTO worker_assignments (tenant_id, worker_id, site_id, date, type, shift, is_team_leader, confirmed_at, confirmed_by, checkin_location_id)
        VALUES (p_tenant, v_w[i], CASE WHEN v_type IN ('site','factory') THEN v_site ELSE NULL END, d, v_type, v_shift, i IN (1, 7),
                CASE WHEN v_type = 'site' AND d >= current_date - 13 THEN (d + time '07:58')::timestamptz ELSE NULL END,
                CASE WHEN v_type = 'site' AND d >= current_date - 13 THEN 'checkin' ELSE NULL END,
                CASE WHEN v_type = 'office' THEN v_office ELSE NULL END);
      END LOOP;
      -- GPS check-in for the last two weeks of site shifts, within 50 m
      IF v_type = 'site' AND d >= current_date - 13 THEN
        v_dist := 15 + (i * 7 + extract(doy FROM d)::int) % 35;
        INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m, checkout_at, checkout_lat, checkout_lng, checkout_distance_m)
        SELECT p_tenant, v_w[i], v_site, d, (d + time '07:55' + make_interval(mins => (i * 3) % 20))::timestamptz,
               s.lat + v_dist / 111320.0, s.lng, v_dist,
               CASE WHEN d < current_date THEN (d + time '17:05' + make_interval(mins => (i * 5) % 25))::timestamptz ELSE NULL END,
               CASE WHEN d < current_date THEN s.lat + v_dist / 111320.0 ELSE NULL END, CASE WHEN d < current_date THEN s.lng ELSE NULL END,
               CASE WHEN d < current_date THEN v_dist ELSE NULL END
        FROM sites s WHERE s.id = v_site;
      END IF;
      -- OT on some weekday site shifts
      IF v_type = 'site' AND dow < 6 AND (i * 11 + extract(doy FROM d)::int) % 37 = 0 THEN
        INSERT INTO worker_ot (tenant_id, worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight)
        VALUES (p_tenant, v_w[i], v_site, d, '17:30', '19:30', 2, false);
      END IF;
    END LOOP;
  END LOOP;

  -- leave requests: 2 pending (bell), 3 approved, 1 rejected
  INSERT INTO leave_requests (tenant_id, worker_id, leave_type, date_from, date_to, reason, status, requested_at, shift) VALUES
    (p_tenant, v_w[3], 'leave_personal', current_date + 3, current_date + 3, 'ไปติดต่อราชการ', 'pending', now() - interval '2 hours', 'full_day'),
    (p_tenant, v_w[9], 'leave_sick', current_date + 1, current_date + 2, 'ไข้หวัด มีใบรับรองแพทย์', 'pending', now() - interval '1 day', 'full_day'),
    (p_tenant, v_w[5], 'leave_personal', current_date - 20, current_date - 20, 'ธุระครอบครัว', 'approved', (current_date - 25)::timestamptz, 'morning'),
    (p_tenant, v_w[8], 'leave_sick', current_date - 12, current_date - 11, 'ปวดหลัง', 'approved', (current_date - 13)::timestamptz, 'full_day'),
    (p_tenant, v_w[11], 'leave_personal', current_date - 6, current_date - 6, 'งานบวชญาติ', 'approved', (current_date - 10)::timestamptz, 'full_day'),
    (p_tenant, v_w[6], 'leave_personal', current_date - 2, current_date - 2, 'ขอลาด่วน', 'rejected', (current_date - 3)::timestamptz, 'full_day');
  UPDATE leave_requests SET reviewed_by = demo_owner_email(p_tenant), reviewed_at = requested_at + interval '3 hours' WHERE tenant_id = p_tenant AND status <> 'pending';

  -- payroll: last two full months, formulas from src/pages/Payroll.jsx
  FOR k IN 1..2 LOOP
    m := demo_m(k); v_month := extract(month FROM m); v_year := extract(year FROM m);
    FOR i IN 1..12 LOOP
      v_sal := v_salary[i];
      v_ss := least(750, round(v_sal * 0.05, 2));
      SELECT COALESCE(count(*) FILTER (WHERE type = 'leave_personal'), 0) * 0.5 INTO v_leave FROM worker_assignments
        WHERE worker_id = v_w[i] AND date >= m AND date < m + interval '1 month';
      SELECT COALESCE(sum(ot_hours), 0) INTO v_ot FROM worker_ot WHERE worker_id = v_w[i] AND date >= m AND date < m + interval '1 month';
      INSERT INTO salary_records (tenant_id, worker_id, month, year, base_salary, social_security_ded, leave_deduction, ot_amount, net_pay, paid_date)
      VALUES (p_tenant, v_w[i], v_month, v_year, v_sal, v_ss, round(v_leave * v_sal / 30, 2), round(v_ot * v_sal / 30 / 8 * 1.5, 2),
              round(v_sal - v_ss - round(v_leave * v_sal / 30, 2) + round(v_ot * v_sal / 30 / 8 * 1.5, 2), 2), (m + interval '1 month' - interval '1 day')::date);
    END LOOP;
  END LOOP;

  -- labor subcontractors: 3, contracts 4, payments 6 (5 paid with expenses, 1 pending; one retention release)
  SELECT id INTO v_cat FROM expense_categories WHERE tenant_id = p_tenant AND name = 'ค่าแรง';
  FOR i IN 1..3 LOOP
    INSERT INTO labor_subcontractors (tenant_id, name, contact_person, phone, id_card_number, address)
    VALUES (p_tenant, v_subs[i], (ARRAY['นายสมบัติ ขยันงาน','คุณพรทิพย์ (ธุรการ)','นายวิรัตน์ เหล็กกล้า'])[i], '08' || lpad((90000000 + i * 54321)::text, 8, '0'),
            (ARRAY['1100500000011','0105560000077','3100200000033'])[i], (ARRAY['22 ม.3 ต.บางรักพัฒนา อ.บางบัวทอง นนทบุรี','150 ถ.ติวานนท์ อ.เมืองนนทบุรี','8/1 ซ.วัดกู้ ปากเกร็ด นนทบุรี'])[i])
    RETURNING id INTO v_sub;
    v_sub_ids := v_sub_ids || v_sub;
  END LOOP;
  FOR i IN 1..4 LOOP
    v_sub := v_sub_ids[((i - 1) % 3) + 1]; v_site := v_sites[((i - 1) % cardinality(v_sites)) + 1];
    INSERT INTO labor_contracts (tenant_id, subcontractor_id, site_id, work_description, contract_amount, retention_pct, withholding_tax_pct, status, start_date)
    VALUES (p_tenant, v_sub, v_site, (ARRAY['เหมาค่าแรงงานก่ออิฐฉาบปูน ชั้น 1-2','เหมาค่าแรงเดินระบบไฟฟ้าทั้งหลัง','เหมาค่าแรงงานเหล็กโครงหลังคา','เหมาค่าแรงงานปูนภายนอก'])[i],
            (ARRAY[420000, 185000, 260000, 310000])[i], 5, 3, CASE WHEN i = 2 THEN 'completed' ELSE 'active' END, demo_m(4 - i) + 5)
    RETURNING id INTO v_contract;
    -- payments: contracts 1,3,4 → one paid progress payment; contract 2 → two paid + retention release; contract 1 also one pending
    FOR k IN 1..(CASE WHEN i = 2 THEN 3 WHEN i = 1 THEN 2 ELSE 1 END) LOOP
      v_num := v_num + 1;
      v_gross := CASE WHEN i = 2 AND k = 3 THEN round(185000 * 0.05, 2) ELSE round((ARRAY[420000, 185000, 260000, 310000])[i] * CASE WHEN i = 2 THEN 0.5 ELSE 0.4 END, 2) END;
      v_wht := round(v_gross * 3 / 100, 2);
      v_ret := CASE WHEN i = 2 AND k = 3 THEN 0 ELSE round(v_gross * 5 / 100, 2) END;
      INSERT INTO labor_payments (tenant_id, contract_id, payment_number, payment_date, work_description, progress_pct, gross_amount, withholding_tax, retention_amount, net_amount,
                                  is_retention_release, status, paid_date)
      VALUES (p_tenant, v_contract, 'P' || to_char(demo_m(4 - i) + 20 + k * 25, 'YYMM') || '-' || lpad(v_num::text, 3, '0'), demo_m(4 - i) + 20 + k * 25,
              CASE WHEN i = 2 AND k = 3 THEN 'คืนเงินประกันผลงาน' ELSE 'งวดที่ ' || k END, CASE WHEN i = 2 THEN least(100, k * 50) ELSE 40 * k END,
              v_gross, v_wht, v_ret, v_gross - v_wht - v_ret, (i = 2 AND k = 3),
              CASE WHEN i = 1 AND k = 2 THEN 'pending' ELSE 'paid' END, CASE WHEN i = 1 AND k = 2 THEN NULL ELSE demo_m(4 - i) + 22 + k * 25 END);
      IF NOT (i = 1 AND k = 2) THEN
        INSERT INTO expenses (tenant_id, date, description, site_id, category_id, supplier, amount, amount_no_vat, vat, payment_method, status, is_subcontract, invoice_no)
        VALUES (p_tenant, demo_m(4 - i) + 22 + k * 25, 'ค่าแรงเหมาช่วง ' || v_subs[((i - 1) % 3) + 1] || ' ' || CASE WHEN i = 2 AND k = 3 THEN 'คืนเงินประกัน' ELSE 'งวดที่ ' || k END,
                v_site, v_cat, v_subs[((i - 1) % 3) + 1], v_gross - v_ret, v_gross - v_ret, 0, 'transfer', 'paid', true,
                'P' || to_char(demo_m(4 - i) + 20 + k * 25, 'YYMM') || '-' || lpad(v_num::text, 3, '0'));
      END IF;
    END LOOP;
  END LOOP;

  -- LINE group (name only) and two open issue reports from the field
  INSERT INTO line_groups (tenant_id, group_id, label, is_notify) VALUES (p_tenant, 'Cdemo' || replace(p_tenant::text, '-', ''), 'กลุ่มช่าง สร้างดี', true);
  INSERT INTO line_issue_reports (tenant_id, site_id, worker_id, message, status, created_at) VALUES
    (p_tenant, v_sites[cardinality(v_sites)], v_w[1], 'เหล็ก DB16 หน้างานไม่พอ ขาดอีก 40 เส้น ขอเบิกเพิ่มด่วน', 'open', now() - interval '5 hours'),
    (p_tenant, v_sites[cardinality(v_sites) - 1], v_w[7], 'น้ำท่วมขังหลุมฐานราก F3 ต้องสูบน้ำก่อนเทคอนกรีต', 'open', now() - interval '1 day');

  RETURN jsonb_build_object(
    'workers', (SELECT count(*) FROM workers WHERE tenant_id = p_tenant),
    'teams', (SELECT count(*) FROM worker_teams WHERE tenant_id = p_tenant),
    'assignments', (SELECT count(*) FROM worker_assignments WHERE tenant_id = p_tenant),
    'checkins', (SELECT count(*) FROM worker_checkins WHERE tenant_id = p_tenant),
    'ot', (SELECT count(*) FROM worker_ot WHERE tenant_id = p_tenant),
    'leave_requests', (SELECT count(*) FROM leave_requests WHERE tenant_id = p_tenant),
    'salary_records', (SELECT count(*) FROM salary_records WHERE tenant_id = p_tenant),
    'subcontractors', (SELECT count(*) FROM labor_subcontractors WHERE tenant_id = p_tenant),
    'labor_contracts', (SELECT count(*) FROM labor_contracts WHERE tenant_id = p_tenant),
    'labor_payments', (SELECT count(*) FROM labor_payments WHERE tenant_id = p_tenant),
    'line_groups', (SELECT count(*) FROM line_groups WHERE tenant_id = p_tenant),
    'issue_reports', (SELECT count(*) FROM line_issue_reports WHERE tenant_id = p_tenant));
END $$;
REVOKE ALL ON FUNCTION demo_seed_people(UUID) FROM PUBLIC, anon, authenticated;
```

Wire: `v_out := v_out || demo_seed_people(p_tenant_id);`

Implementer notes:
- `worker_checkins` requires exactly one of `site_id` / `checkin_location_id` (check constraint from `2026-09-29-03-checkin-locations.sql:60-73`); the insert sets `site_id` only.
- `worker_assignments` has `UNIQUE(worker_id, date, shift)`; the loop inserts each pair once.
- `line_issue_reports` has an AFTER trigger that syncs `phase_tasks` by `issue_report_id`; with no linked task it is a no-op.
- If `labor_payments.payment_number` has a global unique index, the `P` prefix numbers may collide with FacadeX data on CHANG; the test will say so, and the fix is to let the trigger assign it (pass NULL) and drop the `payment_number` format assertion.

- [ ] **Step 4: Run the harness to verify it passes**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: ALL PASSED.

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "feat(demo): seed workers, assignments, check-ins, payroll, subcontractors, issues"
```

---

### Task 6: Reset end-to-end, future-table coverage, idempotent re-seed

**Files:**
- Modify: test (T6 block)
- Modify: migration only if T6 reveals a stuck table

**Interfaces:**
- Consumes: `reset_demo_tenant`, `seed_demo_tenant`.

- [ ] **Step 1: Write the test**

```sql
  -- ── T6 ── reset wipes everything (including a table that does not exist yet today), re-seed is identical
  CREATE TABLE zz_future_demo (id SERIAL PRIMARY KEY, tenant_id UUID NOT NULL, note TEXT);
  INSERT INTO zz_future_demo (tenant_id, note) VALUES (t_tenant, 'must be wiped'), (t_other, 'must stay');
  d1 := reset_demo_tenant(t_tenant);
  SELECT count(*) INTO v_n FROM zz_future_demo WHERE tenant_id = t_tenant;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: future table not wiped'; END IF;
  SELECT count(*) INTO v_n FROM zz_future_demo WHERE tenant_id = t_other;
  IF v_n <> 1 THEN RAISE EXCEPTION 'T6 FAIL: other tenant row deleted'; END IF;
  IF (d1->'deleted'->>'quotations')::int <> 18 THEN RAISE EXCEPTION 'T6 FAIL: deleted.quotations=%', d1->'deleted'->>'quotations'; END IF;
  s2 := d1->'seeded';
  IF s2 - 'passes' <> s1 - 'passes' THEN RAISE EXCEPTION 'T6 FAIL: second seed differs: % vs %', s1, s2; END IF;
  -- same document numbers both times
  SELECT string_agg(quotation_number, ',' ORDER BY quotation_number) INTO v_msg FROM quotations WHERE tenant_id = t_tenant;
  IF v_msg NOT LIKE 'QT%' OR length(v_msg) < 18 * 11 THEN RAISE EXCEPTION 'T6 FAIL: quotation numbers after reset: %', v_msg; END IF;
  -- other tenant untouched by the whole exercise
  SELECT count(*) INTO v_n FROM sites WHERE tenant_id = t_other;
  IF v_n <> 0 THEN RAISE EXCEPTION 'T6 FAIL: other tenant gained sites'; END IF;
  -- no tenant-scoped table still holds rows for the demo tenant after a bare delete pass
  -- (run the delete loop again through reset on an already-reset tenant: deleted counts must equal the seed counts, nothing more)
  d1 := reset_demo_tenant(t_tenant);
  IF (d1->'deleted'->>'sites')::int <> 11 THEN RAISE EXCEPTION 'T6 FAIL: expected 11 sites deleted (10 + ส่วนกลาง), got %', d1->'deleted'->>'sites'; END IF;
  DROP TABLE zz_future_demo;
```

Note: the test frame's `v_msg` is TEXT, `d1`/`s1`/`s2` are JSONB (declared in the frame). The quotation-number comparison across seeds is done by recomputing from the first seed: capture `string_agg` into a second variable before the reset (add `v_q1 TEXT; v_q2 TEXT;` to the DECLARE block) and compare `v_q1 = v_q2` instead of the length check above. Do that.

- [ ] **Step 2: Run the harness**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: ALL PASSED. If `demo_reset_stuck` appears, read the table list and last errors in the message: add any blocker to the retry exception list in `reset_demo_tenant` only if it is a legitimate "children first" condition; otherwise fix the seed so the blocker is not created.

Important: the seed deletes and re-creates `ส่วนกลาง`? No. The seed never creates the default site; reset deletes it (the `sites` delete is tenant-wide). Therefore `seed_demo_tenant` must create `ส่วนกลาง` when missing. Add to the top of `demo_seed_core`:

```sql
  IF NOT EXISTS (SELECT 1 FROM sites WHERE tenant_id = p_tenant AND is_default) THEN
    INSERT INTO sites (tenant_id, site_number, name, is_default, status) VALUES (p_tenant, 'SD-0000-000', 'ส่วนกลาง', true, 'Completed');
  END IF;
```

Check what status the signup trigger gives the default site (`migrations/2026-10-01-06-sites-default-flag-and-signup-seed.sql`) and use the same value instead of 'Completed' if it differs. Re-run T2-T5 (they still pass because `NOT is_default` filters it out).

- [ ] **Step 3: Commit**

```bash
git add supabase/migrations/2026-10-15-01-demo-tenant-seed.sql supabase/tests/demo_tenant_seed_test.sql
git commit -m "test(demo): reset wipes future tables, re-seed is identical; seed recreates the default site"
```

---

### Task 7: Reset button on the platform-admin page

**Files:**
- Modify: `src/pages/TenantManagement.jsx` (row actions near line 245; state + handler near the existing `handlePackageChange`)
- Modify: `src/hooks/useSupabase.js` (no change needed: `usePlatformTenants` already returns every column of `platform_list_tenants()`, so `t.is_demo` arrives automatically)

**Interfaces:**
- Consumes: `reset_demo_tenant(p_tenant_id uuid) → jsonb {deleted, passes, seeded}`; `platform_list_tenants().is_demo`.

- [ ] **Step 1: Add state and handler**

Next to the other `useState` calls at the top of the component in `TenantManagement.jsx`:

```jsx
  const [resetTenant, setResetTenant] = useState(null)   // tenant row awaiting confirm
  const [resetting, setResetting] = useState(false)

  const handleResetDemo = async () => {
    if (!resetTenant) return
    setResetting(true)
    try {
      const { data, error } = await supabase.rpc('reset_demo_tenant', { p_tenant_id: resetTenant.id })
      if (error) throw error
      const seeded = data?.seeded || {}
      setToast(`รีเซ็ตเดโม่ ${resetTenant.company_name} แล้ว: ไซท์ ${seeded.sites ?? '-'} ใบเสนอราคา ${seeded.quotations ?? '-'} ใบแจ้งหนี้ ${seeded.invoices ?? '-'} รายจ่าย ${seeded.expenses ?? '-'} ช่าง ${seeded.workers ?? '-'}`)
      setResetTenant(null)
      refetchTenants?.()
    } catch (err) {
      alert('รีเซ็ตไม่สำเร็จ: ' + (err.message || err))
    } finally {
      setResetting(false)
    }
  }
```

`setToast` and `refetchTenants` already exist in this file (the toast is rendered at the top of the page; find the `usePlatformTenants()` destructuring and make sure `refetch` is captured as `refetchTenants`, adding `refetch: refetchTenants` if it is not).

- [ ] **Step 2: Add the button and the confirm modal**

In the row actions cell (the `<td>` holding "จัดการสถานะ"):

```jsx
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => setStatusTenant(t)}>จัดการสถานะ</button>
                    {t.is_demo && (
                      <button className="btn btn-sm btn-ghost" style={{ marginLeft: 6 }} onClick={() => setResetTenant(t)}>🔄 รีเซ็ตเดโม่</button>
                    )}
                  </td>
```

After the existing status modal JSX (search for `statusTenant &&`), add:

```jsx
      {resetTenant && (
        <Modal title="รีเซ็ตข้อมูลเดโม่" onClose={() => !resetting && setResetTenant(null)}>
          <div className="modal-body">
            <p>ลบข้อมูลทั้งหมดของ <strong>{resetTenant.company_name}</strong> แล้วใส่ข้อมูลตัวอย่างชุดเดิมใหม่ ใช้เวลาไม่กี่วินาที บัญชีผู้ใช้ของ tenant นี้ไม่ถูกแตะ</p>
            <p style={{ color: 'var(--text3)', fontSize: 12 }}>ทำได้เฉพาะ tenant ที่ติดธง is_demo_tenant เท่านั้น ฐานข้อมูลจะปฏิเสธ tenant อื่น</p>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" disabled={resetting} onClick={() => setResetTenant(null)}>ยกเลิก</button>
            <button className="btn btn-primary" disabled={resetting} onClick={handleResetDemo}>{resetting ? 'กำลังรีเซ็ต…' : 'ยืนยันรีเซ็ต'}</button>
          </div>
        </Modal>
      )}
```

`Modal` is the component this page already imports for the status dialog (check the import line; if the status dialog uses a different component name, use that one with the same props).

- [ ] **Step 3: Lint, build, unit tests**

Run: `npx eslint src/pages/TenantManagement.jsx && npx vitest run && npm run build`
Expected: no lint errors in the file, 1181+ tests pass, build succeeds.

- [ ] **Step 4: Commit**

```bash
git add src/pages/TenantManagement.jsx src/hooks/useSupabase.js
git commit -m "feat(platform-admin): reset-demo button for tenants flagged is_demo"
```

---

### Task 8: Rollout to CHANG and live verification

**Files:**
- Modify: `src/changelog.json` (new entry at index 0), `package.json` (version 1.20.43)
- Reference: `.claude/skills/chang-ship/SKILL.md`

- [ ] **Step 1: Final dry-run on CHANG**

Run: `zsh <scratchpad>/dryrun.sh`
Expected: ALL PASSED. Also run the whole existing SQL test that touches `platform_list_tenants` if one exists (`grep -l platform_list_tenants supabase/tests/*.sql`); none is expected.

- [ ] **Step 2: Apply the migration (live from this moment)**

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/demo-tenant-seed
npx supabase db query --linked -f supabase/migrations/2026-10-15-01-demo-tenant-seed.sql
```

Expected: no error output.

- [ ] **Step 3: Flag and seed the demo tenant once**

Via the Supabase MCP `execute_sql` (project `kntspldhvcjeaubtqtkn`), one statement at a time:

```sql
insert into app_settings (tenant_id, key, value) values ('8b61c890-0a90-4223-91d3-b5f8f4e89908', 'is_demo_tenant', 'true') on conflict do nothing;
```

Then, because the MCP connection has no JWT, impersonate the platform admin inside a single `DO` block before calling the function (the guard reads `auth.email()`):

```sql
do $$ declare r jsonb; begin
  perform set_config('request.jwt.claims', json_build_object('email','contact@facadex.co.th','role','authenticated')::text, true);
  r := reset_demo_tenant('8b61c890-0a90-4223-91d3-b5f8f4e89908');
  raise notice 'seeded %', r->'seeded';
end $$;
```

Use `reset_demo_tenant` (not `seed_demo_tenant`) so the four signup-default categories and the trigger-made `ส่วนกลาง` are replaced consistently. Then verify:

```sql
select (select count(*) from sites where tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908') sites,
       (select count(*) from quotations where tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908') quotations,
       (select count(*) from invoices where tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908') invoices,
       (select count(*) from expenses where tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908') expenses,
       (select count(*) from workers where tenant_id = '8b61c890-0a90-4223-91d3-b5f8f4e89908') workers;
```

Expected: 11, 18, ≥24, ≥150, 12.

- [ ] **Step 4: Version bump, changelog, deploy**

`package.json` version `1.20.43`; `src/changelog.json` new first entry:

```json
{
  "version": "1.20.43",
  "date": "<today>",
  "notes": [
    "แอดมินแพลตฟอร์ม: ปุ่ม \"รีเซ็ตเดโม่\" สำหรับ tenant เดโม่ ล้างและใส่ข้อมูลตัวอย่างใหม่ในคลิกเดียว"
  ]
}
```

Commit, then `npm run deploy` (build → verify-bundle → smoke-boot → wrangler). Confirm `curl -s "https://changpm.app/build-info.json?x=$RANDOM"` shows the new commit.

- [ ] **Step 5: Live walkthrough in Chrome**

The owner logs in as `demo-owner@facadex.co.th` in the Chrome tab group (never type the password yourself). Force the PWA update per the chang-ship skill. Then open and screenshot: ภาพรวม (chart has 8 bars of income and expense, KPIs non-zero), ไซท์งาน → one Ongoing site → Gantt + S-curve, ใบเสนอราคา (18 rows; open QT with revision → ประวัติ; print one), ใบแจ้งหนี้ (unpaid 4; print one paid invoice + receipt), รายจ่าย (forecast box shows pending), เช็ค (3 issued, 1 due badge), คลังสินค้า (12 items with balances; movements on one item), HR → เงินเดือน (2 months), จ่ายงานช่าง (this week filled), ผู้รับเหมาค่าแรง (open a paid payment → 50 ทวิ), ตั้งค่า, ผู้ใช้งาน (3 users), bell shows leave 2 / PO draft 1 / issues 2 / cheque 1 / quotation follow-up ≥1. Log in as `demo-worker` (owner types it) and screenshot the worker home.

Then log in as `contact@facadex.co.th`, open ผู้ดูแลระบบ, confirm the demo row shows "🔄 รีเซ็ตเดโม่" and other rows do not; click it once, confirm, wait for the toast, and re-check ใบเสนอราคา count is still 18.

Report every item as "seen live" or "not checked", with the screenshot ids.

- [ ] **Step 6: Commit, push, merge**

```bash
git add package.json src/changelog.json
git commit -m "chore: version 1.20.43 and changelog (demo tenant seed/reset)"
git push -u origin feat/demo-tenant-seed
```

Then follow `superpowers:finishing-a-development-branch` (fast-forward `origin/main` as done for the previous fix). Update the memory file `project_demo_tenant.md` to "seeded and live" with the date.

---

## Self-review notes

- Spec coverage: marker + guard (T1), content table (T2-T5; supplier tax invoices etc. explicitly out of scope), reset mechanism and future-table safety (T1, T6), UI button (T7), tests list (T1-T6), rollout + walkthrough (T8). The spec's `SET LOCAL ROLE authenticated` sentence is superseded (Global Constraints) and the spec file should get a one-line note in T8 step 6's commit.
- Type consistency: `demo_m(int) → date`, `demo_quotation(... ) → uuid`, `demo_invoice(...) → uuid`, section functions `→ jsonb`, `reset_demo_tenant → jsonb {deleted, passes, seeded}`, `platform_list_tenants()` last column `is_demo boolean`. The UI reads `data.seeded.*` from the reset result.
- Known judgment calls the implementer may hit: quantity sign convention in `stock_movements` (T4 note), global vs per-tenant unique indexes on `sites.site_number` and `labor_payments.payment_number` (T2/T5 notes), `pending_counts()` scoping under postgres (T4 note), default site status (T6 note). Each has a stated fallback and the SQL test decides.
