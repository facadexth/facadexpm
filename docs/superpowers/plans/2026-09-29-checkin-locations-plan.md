# Check-in Locations & Attendance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the single hardcoded `factory_site_id`-points-at-a-site hack with a real, owner-manageable `checkin_locations` concept; let ADMIN/OWNER accounts with a fixed owner-assigned location check in without a daily site assignment; and add a week/month attendance grid to HR's check-in history tab.

**Architecture:** One new reference table (`checkin_locations`) plus two small FK columns (`worker_assignments.checkin_location_id`, `user_roles.assigned_checkin_location_id`) and a dual-reference on `worker_checkins` (nullable `site_id` + new `checkin_location_id`, exactly one set). Two existing LINE-bot check-in RPCs get their factory-branch lookup swapped from `sites` to `checkin_locations`; two brand-new web-app-only RPCs (`perform_location_checkin`/`checkout`) handle the no-assignment path. Three UI surfaces (Settings, User Management, MySchedule) plus one new grid component in HR.

**Tech Stack:** React 18, Vite, Supabase (Postgres + PostgREST + RPC), Vitest, date-fns (already a dependency via `ViewToggle.jsx`).

**Spec:** `docs/superpowers/specs/2026-09-29-checkin-locations-design.md`

## Global Constraints

- Piece B (recategorizing the ส่วนกลาง site itself) is explicitly out of scope — nothing in this plan touches `sites` rows or site-profitability reporting.
- The no-assignment check-in path is ADMIN/OWNER only, and the location is **owner-assigned** (via User Management), never self-service (spec Decision 3).
- An ADMIN/OWNER account needs a linked `workers` row (matched by email) before it can be given an assigned location — enforced identically in both the UI (disabled picker) and the RPC (spec Decision 4).
- `worker_checkins` rows are mutually exclusive: exactly one of `site_id`/`checkin_location_id` is set, enforced by a `CHECK` constraint (spec Decision 5).
- The no-assignment path is web-app only this round — no LINE-bot RPCs, no `line-webhook` changes (spec Decision 6).
- The existing field-crew assignment-required check-in rule (`type='site'`/`type='subcontract'`) is completely unchanged by this plan.
- The factory-branch logic that swaps from `sites` to `checkin_locations` exists **only** in `perform_worker_checkin_by_id`/`perform_worker_checkout_by_id` — the web-app variants (`perform_worker_checkin`/`perform_worker_checkout`, no `_by_id`) never had factory-branch logic and are not touched by Task 2.

---

### Task 1: Migration — schema, data migration, RLS

**Files:**
- Create: `supabase/migrations/2026-09-29-03-checkin-locations.sql`

**Interfaces:**
- Produces: table `checkin_locations(id, tenant_id, name, lat, lng, active, created_at)`; column `worker_assignments.checkin_location_id` (nullable UUID FK); column `user_roles.assigned_checkin_location_id` (nullable UUID FK); column `worker_checkins.checkin_location_id` (nullable UUID FK); `worker_checkins.site_id` becomes nullable; `worker_checkins` gets a `CHECK` constraint `worker_checkins_exactly_one_target` and two partial unique indexes `worker_checkins_site_unique`/`worker_checkins_location_unique` replacing the old `worker_checkins_worker_id_site_id_date_key` constraint.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-29-03-checkin-locations.sql
-- Check-in Locations & Attendance (spec: docs/superpowers/specs/2026-09-29-checkin-locations-design.md)

CREATE TABLE checkin_locations (
  id         UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id  UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  name       TEXT NOT NULL,
  lat        NUMERIC NOT NULL,
  lng        NUMERIC NOT NULL,
  active     BOOLEAN NOT NULL DEFAULT true,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_checkin_locations_tenant_id ON checkin_locations(tenant_id);
ALTER TABLE checkin_locations ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON checkin_locations FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- Everyone at the tenant can READ (WORKER included) -- the no-assignment
-- check-in flow and MySchedule.jsx's own location card need this; only
-- ADMIN/OWNER can write, per admin_full_access above.
CREATE POLICY tenant_read_access ON checkin_locations FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());

-- Seed one row per tenant that currently has a factory_site_id set, from
-- that site's own name/lat/lng, then repoint the app_setting at it. Wrapped
-- so a tenant with no factory_site_id set (or an already-blank one) is a
-- no-op.
DO $$
DECLARE
  r RECORD;
  v_new_id UUID;
BEGIN
  FOR r IN
    SELECT a.tenant_id, a.value AS old_site_id, s.name, s.lat, s.lng
    FROM app_settings a
    JOIN sites s ON s.id = nullif(a.value, '')::uuid AND s.tenant_id = a.tenant_id
    WHERE a.key = 'factory_site_id' AND nullif(a.value, '') IS NOT NULL
  LOOP
    INSERT INTO checkin_locations (tenant_id, name, lat, lng)
    VALUES (r.tenant_id, 'โรงงาน (' || r.name || ')', r.lat, r.lng)
    RETURNING id INTO v_new_id;

    UPDATE app_settings SET value = v_new_id::text
    WHERE tenant_id = r.tenant_id AND key = 'factory_site_id';
  END LOOP;
END $$;

-- worker_assignments: which checkin_locations row a type='factory'
-- assignment resolves to, once more than one location exists. Nullable --
-- an existing/new factory assignment with this unset still falls back to
-- app_settings.factory_site_id (see Task 2), so this migration doesn't
-- require backfilling every historical row.
ALTER TABLE worker_assignments ADD COLUMN checkin_location_id UUID REFERENCES checkin_locations(id);

-- user_roles: the owner-assigned fixed location for an ADMIN/OWNER
-- account's no-assignment check-in. NULL = this account has no assigned
-- location and cannot use the no-assignment path.
ALTER TABLE user_roles ADD COLUMN assigned_checkin_location_id UUID REFERENCES checkin_locations(id);

-- worker_checkins: add the second reference, make site_id nullable, swap
-- the old single UNIQUE for two partial ones.
ALTER TABLE worker_checkins ALTER COLUMN site_id DROP NOT NULL;
ALTER TABLE worker_checkins ADD COLUMN checkin_location_id UUID REFERENCES checkin_locations(id);
ALTER TABLE worker_checkins ADD CONSTRAINT worker_checkins_exactly_one_target
  CHECK ((site_id IS NOT NULL) <> (checkin_location_id IS NOT NULL));

ALTER TABLE worker_checkins DROP CONSTRAINT worker_checkins_worker_id_site_id_date_key;
CREATE UNIQUE INDEX worker_checkins_site_unique
  ON worker_checkins(worker_id, site_id, date) WHERE site_id IS NOT NULL;
CREATE UNIQUE INDEX worker_checkins_location_unique
  ON worker_checkins(worker_id, checkin_location_id, date) WHERE checkin_location_id IS NOT NULL;
```

The exact constraint name `worker_checkins_worker_id_site_id_date_key` has already been
verified live against the real database (`SELECT conname FROM pg_constraint WHERE
conrelid = 'worker_checkins'::regclass AND contype = 'u'` returned exactly this name) —
no need to re-verify before the `DROP CONSTRAINT` line.

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP `apply_migration` tool with name `checkin_locations` and the SQL
from Step 1, against project `yyzbgdmgyvvypfcjuhtr`.

- [ ] **Step 3: Verify the migration applied correctly**

Run via `execute_sql`:
```sql
SELECT table_name, column_name FROM information_schema.columns
WHERE (table_name = 'checkin_locations')
   OR (table_name = 'worker_assignments' AND column_name = 'checkin_location_id')
   OR (table_name = 'user_roles' AND column_name = 'assigned_checkin_location_id')
   OR (table_name = 'worker_checkins' AND column_name IN ('site_id', 'checkin_location_id'))
ORDER BY table_name, column_name;
```
Expected: `checkin_locations` shows all 7 columns; the three other rows show the new
columns present; `worker_checkins.site_id` shows `is_nullable = YES` (also check that
column specifically, e.g. add `AND is_nullable` to the select list).

Then verify the data migration, for the real tenant `1b9affc4-2136-4ed1-b168-a36e6624e743`
which is known to have had `factory_site_id` set to the ส่วนกลาง site:
```sql
SELECT cl.name, cl.lat, cl.lng, a.value
FROM app_settings a JOIN checkin_locations cl ON cl.id = nullif(a.value,'')::uuid
WHERE a.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743' AND a.key = 'factory_site_id';
```
Expected: one row, `name` starting with `โรงงาน (ส่วนกลาง`, `lat`/`lng` matching
ส่วนกลาง's site coordinates (`13.759235`, `100.548085` — already confirmed during spec
research), and `a.value` now a UUID (not the old site id).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-29-03-checkin-locations.sql
git commit -m "feat: checkin_locations table, migrate factory_site_id off sites"
```

---

### Task 2: Existing RPC changes — factory-branch swap in the LINE-bot check-in functions

**Files:**
- Create: `supabase/migrations/2026-09-29-04-checkin-rpc-factory-branch.sql`

**Interfaces:**
- Consumes: `checkin_locations` table, `worker_assignments.checkin_location_id` (Task 1).
- Produces: `perform_worker_checkin_by_id(p_worker_id, p_site_id, p_lat, p_lng)` and
  `perform_worker_checkout_by_id(p_worker_id, p_site_id, p_lat, p_lng)` redefined —
  same signature and return shape, factory-branch now reads `checkin_locations`.

- [ ] **Step 1: Write the migration file**

Full `CREATE OR REPLACE FUNCTION` for both, based on the real current bodies in
`supabase/migrations/2026-09-28-01-factory-checkin-location.sql`, with the factory
branch swapped and `v_geo_site_id` renamed to `v_geo_location_id`:

```sql
-- supabase/migrations/2026-09-29-04-checkin-rpc-factory-branch.sql
-- Swaps perform_worker_checkin_by_id/perform_worker_checkout_by_id's
-- factory-branch lookup from `sites` to `checkin_locations` (spec:
-- 2026-09-29-checkin-locations-design.md). The web-app variants
-- (perform_worker_checkin/perform_worker_checkout, no _by_id) never had
-- factory-branch logic and are untouched by this migration.

CREATE OR REPLACE FUNCTION public.perform_worker_checkin_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_location_id uuid;   -- the checkin_locations/sites row whose coordinates actually get distance-checked
  v_site_lat numeric;
  v_site_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  select type into v_assignment_type from worker_assignments
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type in ('site', 'factory', 'subcontract') and tenant_id = v_tenant_id
  limit 1;

  if v_assignment_type is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::text;
    return;
  end if;

  -- งานที่โรงงาน (factory) เช็คอินตามพิกัดตำแหน่งที่ตั้งค่าไว้ ไม่ใช่พิกัด
  -- ไซท์ลูกค้าที่งานนั้นถูกเบิกไป -- คนทำงานโรงงานตัวจริงอยู่ที่โรงงาน.
  -- Prefer the assignment's own checkin_location_id (once set); fall back
  -- to the tenant-wide factory_site_id app_setting for any assignment that
  -- hasn't been given a specific location yet (no backfill of history).
  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
      (select nullif(value, '')::uuid from app_settings
         where tenant_id = v_tenant_id and key = 'factory_site_id')
    ) into v_geo_location_id;
    if v_geo_location_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
    select lat, lng into v_site_lat, v_site_lng from checkin_locations where id = v_geo_location_id and tenant_id = v_tenant_id;
  else
    v_geo_location_id := p_site_id;
    select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_location_id and tenant_id = v_tenant_id;
  end if;

  if v_site_lat is null or v_site_lng is null then
    return query select false, null::numeric, null::numeric, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200)
    into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, p_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, site_id, date) where site_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  update worker_assignments
  set confirmed_at = now(), confirmed_by = 'checkin'
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type = v_assignment_type and confirmed_at is null and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$function$;

CREATE OR REPLACE FUNCTION public.perform_worker_checkout_by_id(p_worker_id uuid, p_site_id uuid, p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid;
  v_assignment_type text;
  v_geo_location_id uuid;
  v_site_lat numeric;
  v_site_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select tenant_id into v_tenant_id from workers where id = p_worker_id;
  if v_tenant_id is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบข้อมูลพนักงาน'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_checkins
    where worker_id = p_worker_id and site_id = p_site_id and date = v_today and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::text;
    return;
  end if;

  -- Same factory-location substitution as check-in, keyed off today's
  -- assignment type for this same worker/site (not stored on
  -- worker_checkins itself).
  select type into v_assignment_type from worker_assignments
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today
    and type in ('site', 'factory', 'subcontract') and tenant_id = v_tenant_id
  limit 1;

  if v_assignment_type = 'factory' then
    select coalesce(
      (select checkin_location_id from worker_assignments
         where worker_id = p_worker_id and site_id = p_site_id and date = v_today
           and type = 'factory' and tenant_id = v_tenant_id limit 1),
      (select nullif(value, '')::uuid from app_settings
         where tenant_id = v_tenant_id and key = 'factory_site_id')
    ) into v_geo_location_id;
    if v_geo_location_id is null then
      return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งโรงงาน — ติดต่อสำนักงาน'::text;
      return;
    end if;
    select lat, lng into v_site_lat, v_site_lng from checkin_locations where id = v_geo_location_id and tenant_id = v_tenant_id;
  else
    v_geo_location_id := p_site_id;
    select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_location_id and tenant_id = v_tenant_id;
  end if;

  if v_site_lat is null or v_site_lng is null then
    return query select false, null::numeric, null::numeric, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200)
    into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  update worker_checkins
  set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  where worker_id = p_worker_id and site_id = p_site_id and date = v_today and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;
```

Note: the `insert ... on conflict` clause in checkin was changed from
`on conflict (worker_id, site_id, date)` to `on conflict (worker_id, site_id, date)
where site_id is not null` — required because Task 1 replaced the plain unique
constraint with the partial index `worker_checkins_site_unique`, and Postgres'
`ON CONFLICT` inference must match a partial index's predicate exactly.

- [ ] **Step 2: Apply the migration**

Use `apply_migration` with name `checkin_rpc_factory_branch` and the SQL from Step 1.

- [ ] **Step 3: Verify — factory branch resolves via checkin_locations**

```sql
-- Confirm the function body now references checkin_locations, not sites, in its factory branch
SELECT prosrc FROM pg_proc WHERE proname = 'perform_worker_checkin_by_id';
```
Expected: the returned source contains `from checkin_locations` and does not contain
`from sites where id = v_geo_site_id` (the old variable name).

Then confirm behavior against the real tenant's data (read-only assertions, no writes):
`app_settings.factory_site_id` for tenant `1b9affc4-2136-4ed1-b168-a36e6624e743` should
resolve to a row in `checkin_locations` (already verified as part of Task 1's Step 3 —
re-confirm here that the RPC's own `coalesce` fallback logic would find that same row):
```sql
SELECT cl.name, cl.lat, cl.lng FROM app_settings a
JOIN checkin_locations cl ON cl.id = nullif(a.value,'')::uuid
WHERE a.tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743' AND a.key = 'factory_site_id';
```
Expected: one row returned (same as Task 1 Step 3's check) — confirms the fallback path
the RPC's `coalesce(...)` will hit for any `type='factory'` assignment that has no
`checkin_location_id` of its own yet (i.e. every existing one, since Task 1 didn't
backfill).

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files (this task touches no test-covered JS/TS file — this
confirms nothing else in the repo broke).

- [ ] **Step 5: Commit**

```bash
git add supabase/migrations/2026-09-29-04-checkin-rpc-factory-branch.sql
git commit -m "feat: perform_worker_checkin_by_id/checkout_by_id factory branch reads checkin_locations"
```

---

### Task 3: New RPCs — perform_location_checkin / perform_location_checkout

**Files:**
- Create: `supabase/migrations/2026-09-29-05-perform-location-checkin.sql`

**Interfaces:**
- Consumes: `checkin_locations`, `user_roles.assigned_checkin_location_id`,
  `worker_checkins.checkin_location_id` (Task 1).
- Produces: `perform_location_checkin(p_lat numeric, p_lng numeric)` and
  `perform_location_checkout(p_lat numeric, p_lng numeric)` — same
  `TABLE(success boolean, distance_m numeric, radius_m numeric, message text)`
  return shape as every other check-in RPC in this codebase.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-29-05-perform-location-checkin.sql
-- New web-app-only check-in path for an ADMIN/OWNER account with a fixed
-- owner-assigned location (spec: 2026-09-29-checkin-locations-design.md,
-- Decision 3/6). Mirrors perform_worker_checkin's own established
-- resolution pattern exactly (v_tenant_id via current_tenant_id() default,
-- worker resolved via auth.email(), not auth.uid() -- copied from that
-- function's real body in 2026-09-03-02-worker-checkin-functions.sql).

CREATE OR REPLACE FUNCTION public.perform_location_checkin(p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := current_tenant_id();
  v_worker_id uuid;
  v_role text;
  v_location_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER') then
    return query select false, null::numeric, null::numeric, 'ฟีเจอร์นี้ใช้ได้เฉพาะแอดมิน/เจ้าของ'::text;
    return;
  end if;

  if v_location_id is null then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select id into v_worker_id from workers where email = auth.email() and tenant_id = v_tenant_id;
  if v_worker_id is null then
    return query select false, null::numeric, null::numeric, 'บัญชีนี้ยังไม่ได้เชื่อมกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = v_location_id and tenant_id = v_tenant_id;
  if v_loc_lat is null or v_loc_lng is null then
    return query select false, null::numeric, null::numeric, 'ไม่พบตำแหน่งที่กำหนด — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc_lat, v_loc_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากตำแหน่งที่กำหนด %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  insert into worker_checkins (tenant_id, worker_id, checkin_location_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  values (v_tenant_id, v_worker_id, v_location_id, v_today, now(), p_lat, p_lng, v_distance)
  on conflict (worker_id, checkin_location_id, date) where checkin_location_id is not null do update
    set checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  return query select true, v_distance, v_radius, 'เช็คอินสำเร็จ'::text;
end;
$function$;

REVOKE EXECUTE ON FUNCTION perform_location_checkin(NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION perform_location_checkin(NUMERIC, NUMERIC) TO authenticated;

CREATE OR REPLACE FUNCTION public.perform_location_checkout(p_lat numeric, p_lng numeric)
 RETURNS TABLE(success boolean, distance_m numeric, radius_m numeric, message text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_tenant_id uuid := current_tenant_id();
  v_worker_id uuid;
  v_role text;
  v_location_id uuid;
  v_loc_lat numeric;
  v_loc_lng numeric;
  v_radius numeric;
  v_distance numeric;
  v_today date := current_date;
begin
  select role, assigned_checkin_location_id into v_role, v_location_id
  from user_roles where user_email = auth.email() and tenant_id = v_tenant_id;

  if v_role is null or v_role not in ('ADMIN', 'OWNER') then
    return query select false, null::numeric, null::numeric, 'ฟีเจอร์นี้ใช้ได้เฉพาะแอดมิน/เจ้าของ'::text;
    return;
  end if;

  if v_location_id is null then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select id into v_worker_id from workers where email = auth.email() and tenant_id = v_tenant_id;
  if v_worker_id is null then
    return query select false, null::numeric, null::numeric, 'บัญชีนี้ยังไม่ได้เชื่อมกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ'::text;
    return;
  end if;

  if not exists (
    select 1 from worker_checkins
    where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id
  ) then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = v_location_id and tenant_id = v_tenant_id;
  select coalesce((select value::numeric from app_settings where tenant_id = v_tenant_id and key = 'checkin_radius_m'), 200) into v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_loc_lat, v_loc_lng);

  if v_distance > v_radius then
    return query select false, v_distance, v_radius,
      format('คุณอยู่ห่างจากตำแหน่งที่กำหนด %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::text;
    return;
  end if;

  update worker_checkins
  set checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  where worker_id = v_worker_id and checkin_location_id = v_location_id and date = v_today and tenant_id = v_tenant_id;

  return query select true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::text;
end;
$function$;

REVOKE EXECUTE ON FUNCTION perform_location_checkout(NUMERIC, NUMERIC) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION perform_location_checkout(NUMERIC, NUMERIC) TO authenticated;
```

No OT handling here (spec: out of scope — `TodayCheckinCard`'s OT logic is specific
to the site-based `perform_worker_checkout` and ADMIN/OWNER accounts aren't on the
hourly-OT payroll path field workers are).

- [ ] **Step 2: Apply the migration**

Use `apply_migration` with name `perform_location_checkin` and the SQL from Step 1.

- [ ] **Step 3: Verify both functions exist with the right signature**

```sql
SELECT proname, pg_get_function_arguments(oid) FROM pg_proc
WHERE proname IN ('perform_location_checkin', 'perform_location_checkout');
```
Expected: two rows, both with arguments `p_lat numeric, p_lng numeric`.

- [ ] **Step 4: Manual live check with a throwaway ADMIN account**

Per this project's established live-testing pattern for RPC + geolocation changes:
create a throwaway ADMIN `user_roles` row (with a linked `workers` row, matched by
email) on the real tenant, set its `assigned_checkin_location_id` to the
`checkin_locations` row from Task 1's data migration, then call
`select * from perform_location_checkin(13.759235, 100.548085)` via `execute_sql`
(the exact coordinates of the seeded location — should succeed, `distance_m` ≈ 0) and
`select * from perform_location_checkin(0, 0)` (should fail with the
out-of-radius message). Clean up the throwaway account and any `worker_checkins` row
it created afterward.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-29-05-perform-location-checkin.sql
git commit -m "feat: perform_location_checkin/checkout RPCs for the no-assignment path"
```

---

### Task 4: Settings UI — checkin_locations CRUD + factory dropdown source swap

**Files:**
- Modify: `src/hooks/useSupabase.js`
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: `checkin_locations` table (Task 1).
- Produces: `useCheckinLocations()` hook — `{ data, loading, error, refetch }`, `data`
  an array of `{id, tenant_id, name, lat, lng, active, created_at}` ordered by name.

- [ ] **Step 1: Add the `useCheckinLocations` hook**

In `src/hooks/useSupabase.js`, add near `useSites` (the pattern is identical to
`useBomTemplates`/`useInfillTypes`, already in this file):

```javascript
export function useCheckinLocations() {
  return useQuery(async () => {
    const { data, error } = await supabase.from('checkin_locations').select('*').order('name')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 2: Import the hook and add CRUD state in Settings.jsx**

In `src/pages/Settings.jsx`, add `useCheckinLocations` to the existing import from
`../hooks/useSupabase.js` (the line already importing `useAppSetting, saveAppSetting,
..., useSites`). Then, near the existing check-in settings state (around the
`factorySiteId` state block), add:

```javascript
const { data: checkinLocations, refetch: refetchCheckinLocations } = useCheckinLocations()
const [showLocationForm, setShowLocationForm] = useState(false)
const [editLocation, setEditLocation] = useState(null)
const [savingLocation, setSavingLocation] = useState(false)
const [deleteLocationId, setDeleteLocationId] = useState(null)

const handleSaveLocation = async (form) => {
  setSavingLocation(true)
  try {
    const payload = {
      name: form.name,
      lat: parseFloat(form.lat) || 0,
      lng: parseFloat(form.lng) || 0,
      active: form.active,
    }
    const { error } = editLocation
      ? await supabase.from('checkin_locations').update(payload).eq('id', editLocation.id)
      : await supabase.from('checkin_locations').insert(payload)
    if (error) throw error
    setShowLocationForm(false)
    setEditLocation(null)
    refetchCheckinLocations()
  } catch (e) {
    alert('Error: ' + e.message)
  } finally {
    setSavingLocation(false)
  }
}

const handleDeleteLocation = async () => {
  if (!deleteLocationId) return
  try {
    const { error } = await supabase.from('checkin_locations').delete().eq('id', deleteLocationId)
    if (error) throw error
    setDeleteLocationId(null)
    refetchCheckinLocations()
  } catch (e) {
    alert('Error: ' + e.message)
  }
}
```

`Modal`/`ConfirmDialog` are already imported at the top of `Settings.jsx` if any
other card in the file uses them; if not already imported, add
`import { Modal, ConfirmDialog } from '../components/Modal.jsx'` (check the file's
existing imports first — do not add a duplicate import if `Modal.jsx` is already
imported under a different combination of named exports).

- [ ] **Step 3: Add the `LocationForm` component**

Add this component near the top of `Settings.jsx` (or as a small local component just
above the default export, matching where similar small form components live in
`BomTemplates.jsx` for its `FinishForm`/`InfillTypeForm`):

```javascript
function LocationForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('checkin-location-form', { name: '', lat: '', lng: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อตำแหน่ง ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น โรงงาน, ออฟฟิศ" />
        </div>
        <div>
          <label className="label">พิกัด GPS (ละติจูด, ลองจิจูด) ★</label>
          <div style={{ display: 'flex', gap: 8 }}>
            <input type="number" step="any" className="input" required value={form.lat}
              onChange={e => set('lat', e.target.value)} placeholder="ละติจูด" />
            <input type="number" step="any" className="input" required value={form.lng}
              onChange={e => set('lng', e.target.value)} placeholder="ลองจิจูด" />
          </div>
        </div>
        <button type="button" className="btn btn-ghost" onClick={() => {
          if (!navigator.geolocation) { alert('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง'); return }
          navigator.geolocation.getCurrentPosition(
            pos => { set('lat', String(pos.coords.latitude)); set('lng', String(pos.coords.longitude)) },
            err => alert('ไม่สามารถอ่านตำแหน่งได้: ' + err.message)
          )
        }}>📍 ใช้ตำแหน่งปัจจุบัน</button>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}
```

Add `import { useDraftForm } from '../hooks/useDraftForm.js'` if not already imported
in `Settings.jsx`.

- [ ] **Step 4: Add the locations list + swap the factory dropdown's source**

In the existing "📍 เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง" card (around line 490-521 as read
during planning — confirm exact current line numbers first, since other work may have
shifted them), replace the "ตำแหน่งโรงงาน" sub-block's `<select>` options source and
add a new sub-section below it:

Find:
```jsx
          <select className="select" style={{ maxWidth: 360 }} value={factorySiteId} onChange={e => setFactorySiteId(e.target.value)}>
            <option value="">-- ยังไม่ได้ตั้งค่า --</option>
            {(sitesList || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
```
Replace with:
```jsx
          <select className="select" style={{ maxWidth: 360 }} value={factorySiteId} onChange={e => setFactorySiteId(e.target.value)}>
            <option value="">-- ยังไม่ได้ตั้งค่า --</option>
            {(checkinLocations || []).filter(l => l.active).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
          </select>
```

Then, immediately after that sub-block's closing `</div>` (the one starting at the
`borderTop` div around the current "ตำแหน่งโรงงาน" label), add a new sub-section
inside the same card:

```jsx
        <div style={{ marginTop: 14, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <label className="label" style={{ marginBottom: 0 }}>จัดการตำแหน่งเช็คอิน</label>
            <button className="btn btn-sm btn-ghost" onClick={() => { setEditLocation(null); setShowLocationForm(true) }}>+ เพิ่มตำแหน่ง</button>
          </div>
          <div className="table-wrap">
            <table>
              <thead><tr><th>ชื่อตำแหน่ง</th><th>พิกัด</th><th>สถานะ</th><th></th></tr></thead>
              <tbody>
                {(checkinLocations || []).map(l => (
                  <tr key={l.id}>
                    <td style={{ fontWeight: 600 }}>{l.name}</td>
                    <td className="font-mono" style={{ fontSize: 11.5 }}>{l.lat}, {l.lng}</td>
                    <td>{l.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => { setEditLocation(l); setShowLocationForm(true) }}>แก้ไข</button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteLocationId(l.id)}>ลบ</button>
                    </td>
                  </tr>
                ))}
                {!(checkinLocations || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีตำแหน่งเช็คอิน</td></tr>}
              </tbody>
            </table>
          </div>
        </div>

        {showLocationForm && (
          <Modal title={editLocation ? `แก้ไข ${editLocation.name}` : 'เพิ่มตำแหน่งเช็คอินใหม่'} onClose={() => { setShowLocationForm(false); setEditLocation(null) }} maxWidth={420}>
            <LocationForm initial={editLocation || {}} onSave={handleSaveLocation} onCancel={() => { setShowLocationForm(false); setEditLocation(null) }} loading={savingLocation} />
          </Modal>
        )}
        {deleteLocationId && <ConfirmDialog title="ลบตำแหน่งเช็คอิน" message="ยืนยันการลบ?" onConfirm={handleDeleteLocation} onCancel={() => setDeleteLocationId(null)} />}
```

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/Settings.jsx
git commit -m "feat: checkin_locations CRUD in Settings, factory dropdown reads locations"
```

---

### Task 5: User Management UI — owner-assigned location picker

**Files:**
- Modify: `src/pages/UserManagement.jsx`

**Interfaces:**
- Consumes: `useCheckinLocations()` (Task 4), `user_roles.assigned_checkin_location_id` (Task 1).
- Produces: `UserManagement.jsx`'s edit form writes `assigned_checkin_location_id` on
  `user_roles` update.

- [ ] **Step 1: Import the hook and add form state**

Add `import { useCheckinLocations } from '../hooks/useSupabase.js'` to
`UserManagement.jsx`'s imports. In the component body, near the existing
`const { data: seat, refetch: refetchSeat } = useSeatStatus()` line, add:

```javascript
const { data: checkinLocations } = useCheckinLocations()
const [linkedWorkerEmails, setLinkedWorkerEmails] = useState(new Set())

useEffect(() => {
  supabase.from('workers').select('email').then(({ data }) => {
    setLinkedWorkerEmails(new Set((data || []).map(w => w.email).filter(Boolean)))
  })
}, [])
```

Add `assigned_checkin_location_id: ''` to the initial `form` state
(`useState({ email: '', password: '', role: 'ADMIN' })` becomes
`useState({ email: '', password: '', role: 'ADMIN', assigned_checkin_location_id: '' })`).

- [ ] **Step 2: Populate the field when opening edit mode**

Find the function that sets `editItem` and seeds `form` for editing (the one around
`setForm({ email: item.user_email, password: '', role: item.role })`). Change it to
also carry the existing assigned location:

```javascript
setForm({ email: item.user_email, password: '', role: item.role, assigned_checkin_location_id: item.assigned_checkin_location_id || '' })
```

- [ ] **Step 3: Save the field in edit mode**

Find `handleSave`'s edit-mode branch:
```javascript
        const { error } = await supabase
          .from('user_roles')
          .update({ role: form.role })
          .eq('id', editItem.id)
```
Replace with:
```javascript
        const { error } = await supabase
          .from('user_roles')
          .update({ role: form.role, assigned_checkin_location_id: form.assigned_checkin_location_id || null })
          .eq('id', editItem.id)
```

- [ ] **Step 4: Render the picker in the edit form (edit mode only)**

Find where the form's `role` `<select>` renders (inside the edit-mode form JSX — this
form is shared between create and edit; the location picker must only show when
`editItem` is truthy). Add immediately after the role field:

```jsx
{editItem && (form.role === 'ADMIN' || form.role === 'OWNER') && (
  <div>
    <label className="label">ตำแหน่งเช็คอินที่กำหนด</label>
    <select
      className="select"
      value={form.assigned_checkin_location_id}
      disabled={!linkedWorkerEmails.has(form.email)}
      onChange={e => set('assigned_checkin_location_id', e.target.value)}
    >
      <option value="">-- ไม่กำหนด --</option>
      {(checkinLocations || []).filter(l => l.active).map(l => <option key={l.id} value={l.id}>{l.name}</option>)}
    </select>
    {!linkedWorkerEmails.has(form.email) && (
      <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: 4 }}>
        ต้องเพิ่มเป็นพนักงานในหน้าบุคคลก่อน (ใช้อีเมลเดียวกัน) จึงจะกำหนดตำแหน่งเช็คอินได้
      </p>
    )}
  </div>
)}
```

This uses the same `email` match `perform_location_checkin` does at check-in time
(Task 3), so the UI's gate and the RPC's gate can never disagree.

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 6: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors.

- [ ] **Step 7: Commit**

```bash
git add src/pages/UserManagement.jsx
git commit -m "feat: owner-assigned check-in location picker in User Management"
```

---

### Task 6: MySchedule.jsx — the no-assignment check-in card

**Files:**
- Modify: `src/hooks/useSupabase.js`
- Create: `src/pages/assign/LocationCheckinCard.jsx`
- Modify: `src/pages/assign/MySchedule.jsx`

**Interfaces:**
- Consumes: `perform_location_checkin`/`perform_location_checkout` (Task 3),
  `user_roles.assigned_checkin_location_id` (Task 1).
- Produces: `useMyAssignedCheckinLocation()` hook — resolves the CURRENT session's
  assigned location as `{id, name}` or `null`; `useTodayLocationCheckin(workerId,
  locationId, date)` hook — mirrors `useTodayCheckin`, returns today's
  `worker_checkins` row for that worker+location or `null`;
  `LocationCheckinCard({ workerId, locationId, locationName, date })` component.

- [ ] **Step 1: Add the two new hooks**

In `src/hooks/useSupabase.js`, add near `useTodayCheckin` (read that function's exact
current body first — it is the direct model for `useTodayLocationCheckin`):

```javascript
export function useMyAssignedCheckinLocation() {
  return useQuery(async () => {
    const { data: { session } } = await supabase.auth.getSession()
    if (!session?.user) return null
    const { data, error } = await supabase
      .from('user_roles')
      .select('assigned_checkin_location_id, checkin_locations(id, name)')
      .eq('user_email', session.user.email)
      .maybeSingle()
    if (error) throw error
    return data?.checkin_locations || null
  })
}

export function useTodayLocationCheckin(workerId, locationId, date) {
  return useQuery(async () => {
    if (!workerId || !locationId || !date) return null
    const { data, error } = await supabase
      .from('worker_checkins')
      .select('*')
      .eq('worker_id', workerId).eq('checkin_location_id', locationId).eq('date', date)
      .maybeSingle()
    if (error) throw error
    return data
  }, [workerId, locationId, date])
}
```

- [ ] **Step 2: Create `LocationCheckinCard.jsx`**

Directly modeled on `src/pages/assign/TodayCheckinCard.jsx` (read that file's exact
86-line body first) — same structure, swapping the RPC names and dropping the
`siteId`/`p_site_id` plumbing (the location is implicit server-side, resolved from
the caller's own `user_roles.assigned_checkin_location_id`):

```javascript
// ============================================================
// LocationCheckinCard -- like TodayCheckinCard, but for an ADMIN/OWNER
// account's owner-assigned fixed location instead of a daily site
// assignment. Calls perform_location_checkin/checkout (no p_site_id --
// the location is implicit, resolved server-side from
// user_roles.assigned_checkin_location_id) instead of
// perform_worker_checkin/checkout. Rendered only when the logged-in user
// has no site assignment today AND has an assigned location (see
// MySchedule.jsx).
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useTodayLocationCheckin } from '../../hooks/useSupabase.js'

const getGeolocation = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง')); return }
  navigator.geolocation.getCurrentPosition(
    pos => resolve(pos.coords),
    err => reject(new Error('ต้องเปิดสิทธิ์ตำแหน่งที่ตั้งเพื่อเช็คอิน: ' + err.message))
  )
})

export default function LocationCheckinCard({ workerId, locationId, locationName, date }) {
  const { data: checkin, refetch } = useTodayLocationCheckin(workerId, locationId, date)
  const [state, setState] = useState(null) // { loading, message, success }

  const handleCheckIn = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_location_checkin', {
        p_lat: coords.latitude, p_lng: coords.longitude,
      })
      if (error) throw error
      const result = data?.[0]
      setState({ loading: false, message: result?.message, success: result?.success })
      if (result?.success) refetch()
    } catch (e) {
      setState({ loading: false, message: e.message, success: false })
    }
  }

  const handleCheckOut = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_location_checkout', {
        p_lat: coords.latitude, p_lng: coords.longitude,
      })
      if (error) throw error
      const result = data?.[0]
      setState({ loading: false, message: result?.message, success: result?.success })
      if (result?.success) refetch()
    } catch (e) {
      setState({ loading: false, message: e.message, success: false })
    }
  }

  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 8, marginTop: 8 }}>
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{locationName}</div>
      {!checkin?.checkin_at ? (
        <button className="btn btn-primary btn-sm" onClick={handleCheckIn} disabled={state?.loading}>
          {state?.loading ? '⏳...' : '📍 เช็คอิน'}
        </button>
      ) : !checkin?.checkout_at ? (
        <button className="btn btn-primary btn-sm" onClick={handleCheckOut} disabled={state?.loading}>
          {state?.loading ? '⏳...' : '📍 เช็คเอาท์'}
        </button>
      ) : (
        <span style={{ color: 'var(--green)', fontSize: 12.5 }}>✅ เช็คอิน/เช็คเอาท์ครบแล้ววันนี้</span>
      )}
      {state?.message && (
        <div style={{ marginTop: 6, fontSize: 12, color: state.success ? 'var(--green)' : 'var(--red)' }}>
          {state.message}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 3: Wire it into MySchedule.jsx**

Add `useMyAssignedCheckinLocation` to the existing import from `../../hooks/useSupabase.js`,
and `import LocationCheckinCard from './LocationCheckinCard.jsx'` alongside the
existing `import TodayCheckinCard from './TodayCheckinCard.jsx'`.

Near the top of the component (where `me` is computed via
`useMemo(() => (workers || []).find(w => w.email === user?.email), [workers, user])`),
add:
```javascript
const { data: myLocation } = useMyAssignedCheckinLocation()
```

Find the existing render block:
```jsx
              {isToday && todaySiteAssignments.map(a => (
                <TodayCheckinCard
                  key={a.site_id}
                  workerId={me.id} siteId={a.site_id}
                  siteName={siteById[a.site_id]?.name || a.site_id}
                  date={todayIso}
                />
              ))}
```
Add immediately after it (same conditional scope, `isToday`):
```jsx
              {isToday && todaySiteAssignments.length === 0 && myLocation && (
                <LocationCheckinCard
                  workerId={me.id} locationId={myLocation.id}
                  locationName={myLocation.name} date={todayIso}
                />
              )}
```

- [ ] **Step 4: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files.

- [ ] **Step 5: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/assign/LocationCheckinCard.jsx src/pages/assign/MySchedule.jsx
git commit -m "feat: no-assignment location check-in card in MySchedule"
```

---

### Task 7: HR.jsx week/month attendance grid

**Files:**
- Create: `src/lib/checkinGrid.js`
- Test: `src/lib/checkinGrid.test.js`
- Create: `src/pages/hr/AttendanceGrid.jsx`
- Modify: `src/pages/HR.jsx`

**Interfaces:**
- Consumes: `worker_checkins.checkin_location_id` (Task 1), `useAllActiveWorkers()`
  (existing hook, already used by `HR.jsx`).
- Produces: `deriveCellStates(checkins, assignments)` — pure function, returns
  `cellState(workerId, dateIso)` returning `'done' | 'open' | 'missed' | null`;
  `AttendanceGrid({ workers, onCellClick })` component.

- [ ] **Step 1: Write the failing tests**

```javascript
// src/lib/checkinGrid.test.js
import { describe, it, expect } from 'vitest'
import { deriveCellStates } from './checkinGrid.js'

describe('deriveCellStates', () => {
  it('returns "done" when both checkin_at and checkout_at are set', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: '2026-09-29T17:00:00Z' }]
    const cellState = deriveCellStates(checkins, [])
    expect(cellState('w1', '2026-09-29')).toBe('done')
  })

  it('returns "open" when checkin_at is set but checkout_at is not', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: null }]
    const cellState = deriveCellStates(checkins, [])
    expect(cellState('w1', '2026-09-29')).toBe('open')
  })

  it('returns "missed" when there is a site assignment but no check-in row', () => {
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'site' }]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBe('missed')
  })

  it('treats factory and subcontract assignment types as scheduled too', () => {
    const assignments = [
      { worker_id: 'w1', date: '2026-09-29', type: 'factory' },
      { worker_id: 'w2', date: '2026-09-29', type: 'subcontract' },
    ]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBe('missed')
    expect(cellState('w2', '2026-09-29')).toBe('missed')
  })

  it('returns null when there is no assignment and no check-in', () => {
    const cellState = deriveCellStates([], [])
    expect(cellState('w1', '2026-09-29')).toBeNull()
  })

  it('does not treat leave/office/holiday assignment types as scheduled', () => {
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'leave_personal' }]
    const cellState = deriveCellStates([], assignments)
    expect(cellState('w1', '2026-09-29')).toBeNull()
  })

  it('a completed check-in takes priority over a matching assignment (done, not missed)', () => {
    const checkins = [{ worker_id: 'w1', date: '2026-09-29', checkin_at: '2026-09-29T08:00:00Z', checkout_at: '2026-09-29T17:00:00Z' }]
    const assignments = [{ worker_id: 'w1', date: '2026-09-29', type: 'site' }]
    const cellState = deriveCellStates(checkins, assignments)
    expect(cellState('w1', '2026-09-29')).toBe('done')
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/checkinGrid.test.js`
Expected: FAIL with "Failed to resolve import" or "checkinGrid.js" not found (the
module doesn't exist yet).

- [ ] **Step 3: Implement `checkinGrid.js`**

```javascript
// ============================================================
// Pure cell-state derivation for HR's week/month attendance grid
// (spec: 2026-09-29-checkin-locations-design.md, "Week/month attendance
// grid" + Decision 7). No I/O -- AttendanceGrid.jsx fetches
// worker_checkins/worker_assignments once per visible range and calls
// this to decide what each cell shows.
// ============================================================

// Assignment types that count as "this worker was scheduled today" for
// the grid's blank-vs-missed distinction -- mirrors the same set
// perform_worker_checkin_by_id's own existence check uses.
const SCHEDULED_TYPES = ['site', 'factory', 'subcontract']

export function deriveCellStates(checkins, assignments) {
  const key = (workerId, date) => `${workerId}::${date}`

  const checkinByKey = new Map()
  for (const c of checkins) checkinByKey.set(key(c.worker_id, c.date), c)

  const scheduledKeys = new Set()
  for (const a of assignments) {
    if (SCHEDULED_TYPES.includes(a.type)) scheduledKeys.add(key(a.worker_id, a.date))
  }

  return function cellState(workerId, date) {
    const c = checkinByKey.get(key(workerId, date))
    if (c) return c.checkout_at ? 'done' : 'open'
    return scheduledKeys.has(key(workerId, date)) ? 'missed' : null
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/checkinGrid.test.js`
Expected: PASS, all 7 tests.

- [ ] **Step 5: Create `AttendanceGrid.jsx`**

```javascript
// ============================================================
// AttendanceGrid -- workers × days check-in/checkout grid for HR's
// เช็คอิน-เช็คเอาท์ tab (spec: 2026-09-29-checkin-locations-design.md).
// Owns its own view/anchor/data-fetching, completely independent of the
// existing free-form checkinFrom/checkinTo list below it in HR.jsx --
// reuses ViewToggle as-is (day/week/month; day view naturally degrades to
// a 1-column grid, no special-casing needed).
// ============================================================
import { useState, useMemo, useEffect } from 'react'
import { startOfWeek, endOfWeek, startOfMonth, endOfMonth, eachDayOfInterval, format } from 'date-fns'
import { supabase } from '../../lib/supabase.js'
import ViewToggle from '../assign/ViewToggle.jsx'
import { deriveCellStates } from '../../lib/checkinGrid.js'

const STATE_STYLE = {
  done:   { background: 'var(--green)', title: 'เช็คอิน/เช็คเอาท์ครบ' },
  open:   { background: 'var(--yellow)', title: 'เช็คอินแล้ว ยังไม่เช็คเอาท์' },
  missed: { background: 'var(--red)', title: 'มีตารางงาน ไม่ได้เช็คอิน' },
}

export default function AttendanceGrid({ workers, onCellClick }) {
  const [view, setView] = useState('week')
  const [anchor, setAnchor] = useState(new Date())
  const [checkins, setCheckins] = useState([])
  const [assignments, setAssignments] = useState([])
  const [loading, setLoading] = useState(true)

  const days = useMemo(() => {
    if (view === 'day') return [format(anchor, 'yyyy-MM-dd')]
    const start = view === 'month' ? startOfMonth(anchor) : startOfWeek(anchor, { weekStartsOn: 1 })
    const end = view === 'month' ? endOfMonth(anchor) : endOfWeek(anchor, { weekStartsOn: 1 })
    return eachDayOfInterval({ start, end }).map(d => format(d, 'yyyy-MM-dd'))
  }, [view, anchor])

  useEffect(() => {
    if (!days.length) return
    let cancelled = false
    setLoading(true)
    const from = days[0], to = days[days.length - 1]
    Promise.all([
      supabase.from('worker_checkins').select('worker_id, date, checkin_at, checkout_at').gte('date', from).lte('date', to),
      supabase.from('worker_assignments').select('worker_id, date, type').gte('date', from).lte('date', to),
    ]).then(([c, a]) => {
      if (cancelled) return
      setCheckins(c.data || [])
      setAssignments(a.data || [])
      setLoading(false)
    })
    return () => { cancelled = true }
  }, [days])

  const cellState = useMemo(() => deriveCellStates(checkins, assignments), [checkins, assignments])

  return (
    <div style={{ marginBottom: 20 }}>
      <ViewToggle view={view} onView={setView} anchor={anchor} onAnchor={setAnchor} />
      {loading ? (
        <div style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div>
      ) : (
        <div className="card" style={{ overflowX: 'auto', marginTop: 10 }}>
          <table>
            <thead>
              <tr>
                <th>ช่าง</th>
                {days.map(d => <th key={d} style={{ fontSize: 11, textAlign: 'center' }}>{format(new Date(d + 'T00:00:00Z'), 'd/M')}</th>)}
              </tr>
            </thead>
            <tbody>
              {(workers || []).map(w => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>{w.nickname || w.name}</td>
                  {days.map(d => {
                    const st = cellState(w.id, d)
                    const style = st ? STATE_STYLE[st] : null
                    return (
                      <td key={d} style={{ textAlign: 'center', padding: 4 }}>
                        <button
                          type="button"
                          title={style?.title}
                          onClick={() => st && onCellClick?.(w.id, d)}
                          style={{
                            width: 18, height: 18, borderRadius: 4, border: 'none', padding: 0,
                            cursor: st ? 'pointer' : 'default',
                            background: style?.background || 'transparent',
                          }}
                        />
                      </td>
                    )
                  })}
                </tr>
              ))}
              {!(workers || []).length && (
                <tr><td colSpan={days.length + 1} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลช่าง</td></tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 6: Integrate into HR.jsx**

Add `import AttendanceGrid from './hr/AttendanceGrid.jsx'` to `HR.jsx`'s imports.

Add a worker-filter to the existing check-in fetch. Find:
```javascript
  const fetchCheckins = async () => {
    if (!canEdit) return
    setLoadingCheckins(true)
    const { data } = await supabase.from('worker_checkins')
      .select('*, workers(name, nickname), sites(name)')
      .gte('date', checkinFrom).lte('date', checkinTo)
      .order('date', { ascending: false }).order('checkin_at', { ascending: false })
    setCheckins(data || [])
    setLoadingCheckins(false)
  }
  useEffect(() => { fetchCheckins() }, [canEdit, checkinFrom, checkinTo])
```
Replace with:
```javascript
  const [checkinWorkerFilter, setCheckinWorkerFilter] = useState(null)

  const fetchCheckins = async () => {
    if (!canEdit) return
    setLoadingCheckins(true)
    let q = supabase.from('worker_checkins')
      .select('*, workers(name, nickname), sites(name), checkin_locations(name)')
      .gte('date', checkinFrom).lte('date', checkinTo)
      .order('date', { ascending: false }).order('checkin_at', { ascending: false })
    if (checkinWorkerFilter) q = q.eq('worker_id', checkinWorkerFilter)
    const { data } = await q
    setCheckins(data || [])
    setLoadingCheckins(false)
  }
  useEffect(() => { fetchCheckins() }, [canEdit, checkinFrom, checkinTo, checkinWorkerFilter])
```

Update the list's site/location column. Find:
```jsx
                      <th>ไซต์</th>
```
Replace with:
```jsx
                      <th>ไซต์/ตำแหน่ง</th>
```
Find:
```jsx
                        <td>{c.sites?.name || '—'}</td>
```
Replace with:
```jsx
                        <td>{c.sites?.name || c.checkin_locations?.name || '—'}</td>
```

Add the grid and a filter-clear affordance above the existing date-range controls.
Find the start of the `checkins` tab's JSX:
```jsx
      {innerTab === 'checkins' && (
        <div>
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="label" style={{ marginBottom: 0 }}>จาก</label>
```
Replace with:
```jsx
      {innerTab === 'checkins' && (
        <div>
          <AttendanceGrid
            workers={workers}
            onCellClick={(workerId, date) => { setCheckinFrom(date); setCheckinTo(date); setCheckinWorkerFilter(workerId) }}
          />
          <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
            <label className="label" style={{ marginBottom: 0 }}>จาก</label>
```

And add a clear-filter chip right after the existing `<span>{checkins.length} รายการ</span>`:
```jsx
            <span style={{ color: 'var(--text3)', fontSize: 12 }}>{checkins.length} รายการ</span>
            {checkinWorkerFilter && (
              <button className="btn btn-sm btn-ghost" onClick={() => setCheckinWorkerFilter(null)}>✕ ล้างตัวกรองช่าง</button>
            )}
```

- [ ] **Step 7: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all files (263+ prior tests plus the 7 new `checkinGrid.test.js` cases).

- [ ] **Step 8: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors.

- [ ] **Step 9: Commit**

```bash
git add src/lib/checkinGrid.js src/lib/checkinGrid.test.js src/pages/hr/AttendanceGrid.jsx src/pages/HR.jsx
git commit -m "feat: week/month attendance grid in HR check-in tab"
```

---

### Task 8: Final verification

**Files:** none (verification + docs only)

- [ ] **Step 1: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, every test file in the project (this project's full suite, not just
the ones touched by this plan).

- [ ] **Step 2: Run a production build**

Run: `npm run build`
Expected: builds cleanly with no errors.

- [ ] **Step 3: Confirm the blast-radius grep is clean**

Run: `grep -rln "factory_site_id.*sites\|v_geo_site_id" src/ supabase/functions/ supabase/migrations/2026-09-29-*.sql 2>/dev/null`
Expected: no output from this plan's own new/modified files (a match inside an OLDER
migration file, e.g. `2026-09-28-01-factory-checkin-location.sql`, is expected and
fine — that file's `CREATE OR REPLACE` has since been superseded by Task 2's, and
migration files are an append-only historical record, never edited after the fact).

Run: `grep -rln "\.select('\*, workers(name, nickname), sites(name)')" src/` — expected:
no output (Task 7 Step 6 replaced the one place this pattern existed).

- [ ] **Step 4: Manual smoke test**

Using a throwaway OWNER test account against the local dev build (`npm run dev`), per
this project's established live-testing pattern:
1. Settings → add a second check-in location (e.g. "ออฟฟิศ") with real coordinates.
2. User Management → edit an ADMIN/OWNER account that has a linked worker, assign it
   the new location.
3. Log in as that account (or impersonate via the throwaway-account pattern) →
   MySchedule shows the new location check-in card (only when that account has no
   site assignment today) → check in → confirm success and the card flips to the
   check-out state.
4. HR → เช็คอิน-เช็คเอาท์ tab → confirm the new grid renders, the just-created check-in
   shows as a green/amber cell for today, clicking that cell filters the list below to
   that worker+day and shows the location's name in the ไซต์/ตำแหน่ง column.
5. Untick nothing needed — confirm a normal field-crew worker's existing site-based
   check-in flow (`TodayCheckinCard`, `perform_worker_checkin`) still works unaffected.

Clean up the throwaway account and any test `checkin_locations`/`worker_checkins`
rows afterward.

- [ ] **Step 5: Update `package.json` version and `src/changelog.json`**

Bump the patch version and add a new top entry to `src/changelog.json` in Thai,
matching the style of every prior entry.

- [ ] **Step 6: Update both manual copies**

Find the existing "🕐 เช็คอิน-เช็คเอาท์" reference in `public/manual/index.html` (search
for the HR appendix section) and add a short callout describing: (a) owner can now add
multiple named check-in locations instead of one hardcoded factory site, (b) an
ADMIN/OWNER with an assigned location can check in without a daily site assignment,
(c) the new week/month attendance grid. Then read the Claude Artifact manual copy
(the Artifact tool's `action: "read"` on `https://claude.ai/artifact/XTuSvCZRTdN8kDztUKed7G`),
apply the same addition via the established `python str.replace` diff-verify pattern,
and republish with `action: "publish"` passing `url` to update in place.

- [ ] **Step 7: Commit**

```bash
git add package.json src/changelog.json public/manual/index.html
git commit -m "docs: bump version, changelog, and manual for check-in locations & attendance grid"
```
