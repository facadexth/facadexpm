# Check-in Locations & Attendance — Design

Brainstormed live in chat + Artifact comments on 2026-09-29. Artifact: https://claude.ai/artifact/JnAeVGrw32Esp76zNWe9Zp

## Problem

`app_settings.factory_site_id` — the location used to validate GPS distance
for `type='factory'` worker check-ins — currently just points at a row in
`sites`. In practice it's set to the tenant's ส่วนกลาง (Central) site,
because there was no dedicated "location" concept, only "sites." This
collides with a separate, unrelated problem (ส่วนกลาง being miscategorized
as a site for profitability reporting — tracked separately, see below) and
caps the factory location at exactly one, with no way to add more (โรงงาน,
ออฟฟิศ, ...).

Separately, ADMIN/OWNER accounts who always work from the same fixed place
(e.g. head office) currently cannot check in at all unless they have a real
daily `worker_assignments` row — the existence check that exists specifically
to stop field crew checking in at sites they weren't sent to also blocks
office-based admins who have no site assignment on a given day.

And the existing check-in history (HR → เช็คอิน-เช็คเอาท์) is a flat,
date-range-filtered list — there's no at-a-glance week/month view of who
did or didn't check in.

## Relationship to the ส่วนกลาง site-categorization question

This spec is piece A of two related-but-separable problems raised in the
same conversation. Piece B — ส่วนกลาง carrying real expenses (1,357 rows,
~7.97M THB) but zero income because it's not a real customer project, while
still needing to stay assignable for small jobs that don't warrant a full
site record — is explicitly **out of scope here** and gets its own spec
later. Nothing in this spec requires piece B, and nothing here blocks it.

## Decisions

**Decision 1 — `checkin_locations` is a new table, not a `sites` flag.**
A location (โรงงาน, ออฟฟิศ, ...) has a name and coordinates and nothing
else a "site" has (no billing, no expenses, no income, no Kanban board).
Modeling it as a genuinely separate concept, rather than a `sites.is_location`
flag, keeps `sites` meaning "customer project" and avoids repeating the
exact confusion (ส่วนกลาง-as-a-site) that motivated this spec in the first
place.

**Decision 2 — `factory_site_id` is retired in favor of pointing at
`checkin_locations`, seeded from ส่วนกลาง's current coordinates.** Zero
behavior change on cutover day: the migration creates one `checkin_locations`
row named "โรงงาน (ส่วนกลาง)" with ส่วนกลาง's current lat/lng, and updates the
`app_settings` row's `value` to that new row's id. The owner can add more
locations afterward.

**Decision 3 — the no-assignment check-in path is scoped to ADMIN/OWNER
accounts only, checking in at an owner-assigned location (not a
self-service default).** Per the owner's own words in the Artifact
comments: "owner can assign stored location to admin... admin need to
checkin at assigned location." This is `user_roles.assigned_checkin_location_id`,
set from User Management by the OWNER, not something an ADMIN sets for
themselves. Field-crew workers keep the existing assignment-required rule
unchanged — this spec does not touch that guardrail for `type='site'` or
`type='subcontract'` check-ins.

**Decision 4 — an ADMIN/OWNER account needs a linked `workers` row before
it can be given an assigned location.** Check-ins are always logged against
`worker_checkins.worker_id`. Verified live against the real tenant: 3 of 4
ADMIN/OWNER accounts already have a linked worker record (matched by
email); one doesn't. Rather than build a second, account-only check-in
mechanism, User Management's location picker stays disabled for an account
with no linked worker, with an explanatory note. (User confirmed this via
AskUserQuestion: "Require a linked worker record.")

**Decision 5 — `worker_checkins` gets a second, mutually exclusive
reference: `checkin_location_id` alongside the existing `site_id`.** A
normal check-in has `site_id` set and `checkin_location_id` null; a
no-assignment location check-in has the reverse. `site_id` becomes
nullable to allow this. A `CHECK` constraint enforces exactly one of the
two is set. The existing `UNIQUE (worker_id, site_id, date)` constraint
can't just be widened (two NULLs don't collide in a plain unique index),
so it's replaced with two partial unique indexes — one per reference
column, each `WHERE ... IS NOT NULL`.

**Decision 6 — the no-assignment location check-in is web-app only for
this spec; LINE bot support is a deliberate follow-up, not built here.**
The existing check-in surface has four RPCs total (checkin/checkout ×
web-app-auth.email()-resolved / LINE-bot-explicit-worker-id), because the
LINE bot resolves a worker without a Supabase auth session. Mirroring
that exactly for the new no-assignment path would mean four *more* RPCs
plus changes to `line-webhook`'s already-large Edge Function. ADMIN/OWNER
users are primarily web-app users (per the existing `TodayCheckinCard`
pattern, which already only renders `type='site'` assignments — factory
check-in itself is LINE-only today, an existing asymmetry this spec
doesn't need to fix). YAGNI: build the two web-app RPCs now
(`perform_location_checkin`, `perform_location_checkout`), revisit LINE
support only if it's actually asked for.

**Decision 7 — the week/month grid distinguishes "not scheduled" from
"scheduled but never checked in."** A blank cell alone can't answer "does
this need attention" — cross-referencing `worker_assignments` for that
worker+day lets the grid render those two states differently, since the
second is the one a manager actually needs to see.

## Schema

New migration: `supabase/migrations/2026-09-29-03-checkin-locations.sql`

```sql
-- ============================================================
-- Check-in Locations & Attendance (spec: 2026-09-29-checkin-locations-design.md)
-- ============================================================

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
-- check-in flow and any future worker-facing "which location" picker need
-- this; only ADMIN/OWNER can write, per admin_full_access above.
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
-- app_settings.factory_site_id (see RPC changes below), so this migration
-- doesn't require backfilling every historical row.
ALTER TABLE worker_assignments ADD COLUMN checkin_location_id UUID REFERENCES checkin_locations(id);

-- user_roles: the owner-assigned fixed location for an ADMIN/OWNER
-- account's no-assignment check-in (Decision 3). NULL = this account has
-- no assigned location and cannot use the no-assignment path.
ALTER TABLE user_roles ADD COLUMN assigned_checkin_location_id UUID REFERENCES checkin_locations(id);

-- worker_checkins: add the second reference, make site_id nullable, swap
-- the old single UNIQUE for two partial ones (Decision 5).
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

> **Verify before writing the plan:** the real constraint name for
> `worker_checkins`' existing `UNIQUE (worker_id, site_id, date)` — it was
> declared inline in `2026-09-03-01-worker-checkin-schema.sql` without an
> explicit name, so Postgres auto-named it; confirm the actual name (almost
> certainly `worker_checkins_worker_id_site_id_date_key`, Postgres's default
> pattern, but confirm via `\d worker_checkins` or an `information_schema`
> query) before the `DROP CONSTRAINT` line runs against the real database.

## RPC changes

**Existing `perform_worker_checkin_by_id` / `perform_worker_checkout_by_id`**
(both, in `supabase/migrations/2026-09-28-01-factory-checkin-location.sql`):
the factory-branch's lookup source changes from `sites` to `checkin_locations`.

> **Correction to an earlier draft of this spec:** the web-app variants
> `perform_worker_checkin`/`perform_worker_checkout` (no `_by_id`, in
> `supabase/migrations/2026-09-03-02-worker-checkin-functions.sql`) were
> **never** given factory-branch logic — verified by reading both files in
> full. They only ever handle `type = 'site'` (matching
> `MySchedule.jsx`'s `todaySiteAssignments`, which only renders a
> `TodayCheckinCard` for `type === 'site'` assignments — factory check-in
> has only ever been reachable via the LINE bot). This spec's factory-branch
> swap therefore touches **only** the two `_by_id` functions; the two
> web-app functions are untouched by Decision 2 and need no change here.

Currently (both `_by_id` functions, identical shape):

```sql
if v_assignment_type = 'factory' then
  select nullif(value, '')::uuid into v_geo_site_id
  from app_settings where tenant_id = v_tenant_id and key = 'factory_site_id';
  ...
end if;
...
select lat, lng into v_site_lat, v_site_lng from sites where id = v_geo_site_id and tenant_id = v_tenant_id;
```

Becomes:

```sql
if v_assignment_type = 'factory' then
  -- Prefer the assignment's own checkin_location_id (once set); fall back
  -- to the tenant-wide factory_site_id app_setting for any assignment that
  -- hasn't been given a specific location yet (Decision: no backfill).
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
  select lat, lng into v_site_lat, v_site_lng from sites where id = p_site_id and tenant_id = v_tenant_id;
end if;
```

(Rename the declared `v_geo_site_id` variable to `v_geo_location_id` in
both `_by_id` functions for clarity, since it no longer holds a `sites.id`.
`p_worker_id` is a real parameter on both — this rename and the branch
change apply as written above, with no adaptation needed.)

**Two new RPCs**, `perform_location_checkin(p_lat, p_lng)` and
`perform_location_checkout(p_lat, p_lng)` — web-app only (Decision 6),
matching `perform_worker_checkin`'s own established resolution pattern
exactly (`v_tenant_id UUID := current_tenant_id()` as a column default
expression, worker resolved via `auth.email()`, not `auth.uid()` — verified
by reading `perform_worker_checkin`'s real body in
`2026-09-03-02-worker-checkin-functions.sql:25-44`, not assumed):

```sql
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
  if v_role not in ('ADMIN', 'OWNER') then
    return query select false, null::numeric, null::numeric, 'ฟีเจอร์นี้ใช้ได้เฉพาะแอดมิน/เจ้าของ'::text;
    return;
  end if;

  select id into v_worker_id from workers where email = auth.email() and tenant_id = v_tenant_id;
  if v_worker_id is null then
    return query select false, null::numeric, null::numeric, 'บัญชีนี้ยังไม่ได้เชื่อมกับข้อมูลพนักงาน — ติดต่อผู้ดูแลระบบ'::text;
    return;
  end if;

  if v_location_id is null then
    return query select false, null::numeric, null::numeric, 'ยังไม่ได้ตั้งค่าตำแหน่งเช็คอินสำหรับบัญชีนี้ — ติดต่อเจ้าของระบบ'::text;
    return;
  end if;

  select lat, lng into v_loc_lat, v_loc_lng from checkin_locations where id = v_location_id and tenant_id = v_tenant_id;
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
```

`perform_location_checkout(p_lat, p_lng)` mirrors this: requires an existing
`worker_checkins` row for `(v_worker_id, v_location_id, v_today)`, same
distance check, updates `checkout_at`/`checkout_lat`/`checkout_lng`/`checkout_distance_m`.
No OT handling is added here — `TodayCheckinCard`'s existing OT logic reads
`get_regular_shift_end_time()` client-side and passes `p_ot_*` params only
to the site-based `perform_worker_checkout`; extending OT to location
check-ins is out of scope (not asked for, and ADMIN/OWNER accounts aren't
typically on the hourly-OT payroll path field workers are).

> The `auth.email()` + `current_tenant_id()` resolution pattern above is
> copied directly from `perform_worker_checkin`'s real body (read in full
> during this spec's own research, not assumed) — no further verification
> needed at implementation time on that point.

## Settings UI

`src/pages/Settings.jsx`, the existing "📍 เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง"
card: below the existing checkin-radius/shift-end/factory-location block,
a new sub-section "จัดการตำแหน่งเช็คอิน" — a simple list of
`checkin_locations` rows (name, lat/lng, active toggle, delete), an
"+ เพิ่มตำแหน่ง" button opening a small inline form with the same
📍 "ใช้ตำแหน่งปัจจุบัน" geolocation button `Sites.jsx` already has
(`navigator.geolocation.getCurrentPosition`, same pattern, see
`Sites.jsx:167-173`).

The existing "ตำแหน่งโรงงาน" `<select>` (currently `sitesList.map(...)`)
switches its options source from `useSites()` to the new locations list.
Everything else about that dropdown (the `factorySiteId`/`saveAppSetting('factory_site_id', ...)`
plumbing) stays identical — it's still just storing a UUID string in
`app_settings`, only which table that UUID resolves against changes.

## User Management UI

`src/pages/UserManagement.jsx`'s edit form (EDIT mode only, not CREATE —
an account needs to exist and be linked to a worker before a location makes
sense to assign): when `form.role` is `ADMIN` or `OWNER`, show a
"ตำแหน่งเช็คอินที่กำหนด" `<select>` populated from `checkin_locations`,
bound to `assigned_checkin_location_id`. Disabled with the note
"ต้องเพิ่มเป็นพนักงานในหน้าบุคคลก่อน" (Decision 4) when no `workers` row
matches `editItem.user_email` by email — the same lookup
`perform_location_checkin` does at check-in time, so the UI's gate and the
RPC's gate can never disagree. `handleSave`'s edit-mode branch adds
`assigned_checkin_location_id: form.assigned_checkin_location_id || null`
to the existing `.update({ role: form.role })` call.

## MySchedule.jsx — the no-assignment check-in card

`src/pages/assign/MySchedule.jsx`: today, `todaySiteAssignments` (line 105)
filters to `type === 'site'` and renders one `TodayCheckinCard` per distinct
site. Add: when `todaySiteAssignments.length === 0` (no site assignment
today) AND the logged-in user's own `user_roles.assigned_checkin_location_id`
is set, render one new card — same visual shape as `TodayCheckinCard`, but
calling `perform_location_checkin`/`perform_location_checkout` (no
`p_site_id` param, since the location is implicit) instead of
`perform_worker_checkin`/`perform_worker_checkout`. Simplest as a small new
sibling component (`LocationCheckinCard.jsx`) reusing `TodayCheckinCard`'s
`getGeolocation()` helper and state shape, rather than overloading
`TodayCheckinCard` itself with a site-vs-location branch — the two RPCs
have different signatures and the "which location" concept doesn't need
`TodayCheckinCard`'s per-site key/name props at all.

## Week/month attendance grid

`src/pages/HR.jsx`'s เช็คอิน-เช็คเอาท์ tab: reuse `ViewToggle` from
`src/pages/assign/ViewToggle.jsx` directly (it already supports exactly
สัปดาห์/เดือน with anchor-date navigation — `addWeeks`/`addMonths` from
`date-fns`, no changes needed to that component). Below it, a new grid
component: one row per active worker, one column per day in the
week/month range. Query `worker_checkins` for the visible date range
(same shape `fetchCheckins` already builds, just driven by the
`ViewToggle` anchor+view instead of the free-form `checkinFrom`/`checkinTo`
date pickers) plus `worker_assignments` for the same range (to distinguish
the two blank-cell cases per Decision 7).

Cell states (same amber/red regardless of whether the cell's date is today
or in the past — a manager scanning a past week already reads amber as
"never checked out" and red as "never checked in" without needing a fifth
color to separate "today" from "history"):
- **checked in + out**: green ✓
- **checked in, not yet out**: amber
- **had an assignment, never checked in**: red — the one that needs attention
- **no assignment that day**: empty, no color

Clicking a cell filters the existing flat list (already built, just add a
`workerId`+`date` filter on top of the existing `checkinFrom`/`checkinTo`
range) to that one worker+day, showing the real timestamps/distances
already displayed today — no new detail UI needed, just a filter applied
to what's already there.

The existing free-form date-range list stays as-is below the grid (or
behind a toggle) for anyone who wants an arbitrary range rather than a
calendar page.

## Testing

- This feature is mostly RPC + UI, not a pure calc module, so a
  `bomEngine.test.js`-style broad test suite doesn't apply wholesale. The
  one genuinely pure piece worth extracting and testing is the grid's
  cell-state derivation (checked-in-and-out / checked-in-only / missed /
  not-scheduled) — a small pure function taking a worker's
  checkins+assignments for a date range and returning per-cell states,
  unit tested the same way `lineCommandSettings.js` was.
- Manual/live verification (per this project's established pattern for
  RPC + geolocation changes — see the factory-checkin-location fix and the
  BOM cost-factors plan's own deferred manual QA): a throwaway ADMIN
  account, assign it a `checkin_location_id`, confirm `perform_location_checkin`
  succeeds within radius and fails outside it, confirm checkout requires a
  prior checkin, confirm the existing site-based flow (`perform_worker_checkin`)
  is completely unaffected for a normal field-crew worker on the same day.
  Confirm the factory-branch's `checkin_locations` lookup still succeeds
  for an existing `type='factory'` assignment with no `checkin_location_id`
  set (the `app_settings.factory_site_id` fallback).

## Migration/backward-compatibility notes

- The data migration is idempotent-safe to re-run (the `DO $$` block only
  inserts for tenants with a non-blank `factory_site_id` currently pointing
  at a real site row; once repointed at a `checkin_locations` row, the
  `JOIN sites s ON ...` in the migration's `SELECT` no longer matches, so a
  second run is a no-op) — but migrations in this project run exactly once
  per environment via Supabase's own migration tracking, so this is a
  safety property, not something the plan needs to exercise.
- Existing `worker_assignments` rows with `type='factory'` and no
  `checkin_location_id` keep resolving via the `app_settings.factory_site_id`
  fallback indefinitely — there is no requirement to backfill every
  historical factory assignment with an explicit location.
- `worker_checkins.site_id` going from `NOT NULL` to nullable is additive
  and safe: every existing row already has a non-null `site_id`, so the
  constraint relaxation doesn't invalidate anything already stored.
