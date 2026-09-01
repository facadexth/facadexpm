# Location-Based Worker Check-In/Check-Out Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a field worker confirm their pre-planned shift via GPS-verified check-in/check-out, gating that shift's payroll on the confirmation instead of counting it unconditionally.

**Architecture:** Two new Postgres `SECURITY DEFINER` functions (`perform_worker_checkin`/`perform_worker_checkout`) are the only write path a WORKER-role user gets — they independently recompute distance server-side (never trust a client-supplied "I'm in range" claim), write to a new `worker_checkins` audit table, and set `confirmed_at`/`confirmed_by` on the matching `worker_assignments` row(s). Payroll's `labor_cost_by_site` view gates `type='site'` rows on `confirmed_at IS NOT NULL`. Office staff keep planning shifts exactly as today via the existing Assign grid, which gains a pending/confirmed indicator and a manual override button.

**Tech Stack:** Supabase Postgres (live project `yyzbgdmgyvvypfcjuhtr`, no local DB), React/Vite frontend, `navigator.geolocation` browser API, Playwright for live verification (this project's established norm this session — no unit-test framework is used for schema/RLS/integration work here).

**Spec:** `docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md`

## Global Constraints

- Migration workflow: dry-run every migration in `BEGIN; ... ROLLBACK;` via the `execute_sql` tool first, then apply live via `apply_migration`, then write the identical SQL to `supabase/migrations/YYYY-MM-DD-NN-<name>.sql`, then update `supabase/schema.sql` to match. Never skip the dry-run.
- After every frontend change: `npx vite build` must succeed before any live verification.
- Live verification is Playwright against a freshly created throwaway test tenant (see the exact `auth.users`/`auth.identities` INSERT pattern in Task 7, Step 1 — reuse it verbatim in every task's verification). Always clean up the test tenant fully afterward (verify 0 rows left) before moving on.
- Commit after each task; `git fetch origin main` and confirm no divergence before every push; push directly to `main` (`git push origin worktree-quotation-module:main`) — no PR workflow.
- `SECURITY DEFINER` functions bypass RLS entirely — every one written in this plan must explicitly filter `tenant_id = current_tenant_id()` itself wherever it touches a tenant-scoped table; RLS will not do this for you inside such a function.
- This feature only ever gates `worker_assignments` rows where `type = 'site'`. `factory`/`office`/`holiday`/`leave_sick`/`leave_personal`/`subcontract` rows are untouched by every task in this plan.

---

### Task 1: Schema — coordinates, confirmation columns, and the check-ins table

**Files:**
- Create: `supabase/migrations/2026-09-03-01-worker-checkin-schema.sql`
- Modify: `supabase/schema.sql` (add the same DDL near the `sites`/`worker_assignments` table definitions, and the new table near `document_receipts` for consistency with how other generic-audit tables are grouped)

**Interfaces:**
- Produces: `sites.lat NUMERIC(9,6)`, `sites.lng NUMERIC(9,6)`; `worker_assignments.confirmed_at TIMESTAMPTZ`, `worker_assignments.confirmed_by TEXT`; table `worker_checkins` with columns `id, tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m, checkout_at, checkout_lat, checkout_lng, checkout_distance_m, created_at`, unique on `(worker_id, site_id, date)`.

- [ ] **Step 1: Dry-run the migration**

Run via the `execute_sql` tool against project `yyzbgdmgyvvypfcjuhtr`:

```sql
BEGIN;

ALTER TABLE sites ADD COLUMN lat NUMERIC(9,6);
ALTER TABLE sites ADD COLUMN lng NUMERIC(9,6);

ALTER TABLE worker_assignments ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE worker_assignments ADD COLUMN confirmed_by TEXT;

CREATE TABLE worker_checkins (
  id                  UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id           UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  worker_id           UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id             UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date                DATE NOT NULL,
  checkin_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkin_lat         NUMERIC(9,6) NOT NULL,
  checkin_lng         NUMERIC(9,6) NOT NULL,
  checkin_distance_m  NUMERIC NOT NULL,
  checkout_at         TIMESTAMPTZ,
  checkout_lat        NUMERIC(9,6),
  checkout_lng        NUMERIC(9,6),
  checkout_distance_m NUMERIC,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, site_id, date)
);

CREATE INDEX idx_worker_checkins_tenant_id ON worker_checkins(tenant_id);
CREATE INDEX idx_worker_checkins_worker_date ON worker_checkins(worker_id, date);

ALTER TABLE worker_checkins ENABLE ROW LEVEL SECURITY;
-- Reads: same shape as worker_ot/salary_records -- admin sees everything,
-- a worker sees only their own rows. Writes are NOT granted here at all --
-- the only write path is the SECURITY DEFINER functions in Task 2, which
-- bypass RLS. This keeps direct table access (e.g. a stray client-side
-- .insert() call) impossible even for a WORKER's own rows -- they must go
-- through the distance-validating function.
CREATE POLICY admin_full_access ON worker_checkins FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY worker_reads_own ON worker_checkins FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id() AND worker_id IN (SELECT id FROM workers WHERE email = auth.email()));

ROLLBACK;
```

Expected: no errors.

- [ ] **Step 2: Apply live**

Run the same SQL via `apply_migration` (name: `worker_checkin_schema`), replacing the trailing `ROLLBACK;` with nothing (omit it — `apply_migration` commits automatically).

- [ ] **Step 3: Write the migration file**

Save the exact SQL from Step 1 (without `BEGIN;`/`ROLLBACK;`) to `supabase/migrations/2026-09-03-01-worker-checkin-schema.sql`, with this header comment:

```sql
-- supabase/migrations/2026-09-03-01-worker-checkin-schema.sql
-- Location-based worker check-in/check-out (see
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- sites gains coordinates; worker_assignments gains a confirmation gate
-- (set by a successful check-in or an admin override, see Task 2/6);
-- worker_checkins is the actual attendance event log, kept separate from
-- the plan. No RLS write policy is granted here for the worker's own
-- rows -- the only write path is the SECURITY DEFINER functions in
-- 2026-09-03-02, which independently re-validate distance server-side.
```

- [ ] **Step 4: Update schema.sql**

Add `lat NUMERIC(9,6),` and `lng NUMERIC(9,6),` as new columns in the `sites` table definition (after `map_url`). Add `confirmed_at TIMESTAMPTZ,` and `confirmed_by TEXT,` after `worker_assignments.notes`. Add the full `worker_checkins` table + indexes + RLS block right after the `document_receipt_links` block (same generic-audit-table grouping), with the header comment from Step 3 adapted to schema.sql's style (see how `document_receipts`'s own comment block reads for the pattern).

- [ ] **Step 5: Verify**

```sql
SELECT column_name FROM information_schema.columns WHERE table_name = 'sites' AND column_name IN ('lat','lng');
SELECT column_name FROM information_schema.columns WHERE table_name = 'worker_assignments' AND column_name IN ('confirmed_at','confirmed_by');
SELECT count(*) FROM worker_checkins;
```

Expected: first query returns 2 rows, second returns 2 rows, third returns `0`.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-03-01-worker-checkin-schema.sql supabase/schema.sql
git commit -m "feat: schema for location-based worker check-in/check-out"
```

---

### Task 2: SQL functions — distance check, check-in, check-out

**Files:**
- Create: `supabase/migrations/2026-09-03-02-worker-checkin-functions.sql`
- Modify: `supabase/schema.sql` (add the function definitions near the end, alongside other function definitions like `current_tenant_id()`)

**Interfaces:**
- Consumes: `worker_checkins`, `worker_assignments`, `sites`, `app_settings`, `workers` (Task 1's schema).
- Produces: `haversine_distance_m(lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC) RETURNS NUMERIC`; `perform_worker_checkin(p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC) RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)`; `perform_worker_checkout(p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC, p_ot_start TIME, p_ot_end TIME, p_ot_hours NUMERIC, p_ot_is_overnight BOOLEAN, p_ot_notes TEXT) RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)`. Both callable via `supabase.rpc('perform_worker_checkin', {...})` / `supabase.rpc('perform_worker_checkout', {...})` from the frontend (Task 7).

- [ ] **Step 1: Dry-run the migration**

```sql
BEGIN;

CREATE OR REPLACE FUNCTION haversine_distance_m(lat1 NUMERIC, lng1 NUMERIC, lat2 NUMERIC, lng2 NUMERIC)
RETURNS NUMERIC
LANGUAGE sql
IMMUTABLE
AS $$
  -- Standard haversine formula, earth radius 6371000m. Returns meters.
  SELECT 6371000 * 2 * asin(sqrt(
    sin(radians(lat2 - lat1) / 2) ^ 2 +
    cos(radians(lat1)) * cos(radians(lat2)) * sin(radians(lng2 - lng1) / 2) ^ 2
  ));
$$;

-- Both perform_worker_* functions run SECURITY DEFINER so a WORKER-role
-- caller (who has no direct write access to worker_checkins/
-- worker_assignments/worker_ot, and no read access to app_settings) can
-- still confirm their OWN attendance through a narrow, server-validated
-- path. v_worker_id is ALWAYS resolved from auth.email() internally --
-- never trust a client-supplied worker id -- so a worker can only ever
-- check themselves in/out.
CREATE OR REPLACE FUNCTION perform_worker_checkin(p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  IF v_site_lat IS NULL OR v_site_lng IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM worker_assignments
    WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today AND type = 'site'
  ) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน'::TEXT;
    RETURN;
  END IF;

  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คอินได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  INSERT INTO worker_checkins (tenant_id, worker_id, site_id, date, checkin_at, checkin_lat, checkin_lng, checkin_distance_m)
  VALUES (v_tenant_id, v_worker_id, p_site_id, v_today, now(), p_lat, p_lng, v_distance)
  ON CONFLICT (worker_id, site_id, date) DO UPDATE
    SET checkin_at = now(), checkin_lat = p_lat, checkin_lng = p_lng, checkin_distance_m = v_distance;

  -- First confirmation wins -- don't clobber an admin override that may
  -- already be set (confirmed_by = admin's email, not 'checkin').
  UPDATE worker_assignments
  SET confirmed_at = now(), confirmed_by = 'checkin'
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today
    AND type = 'site' AND confirmed_at IS NULL;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คอินสำเร็จ'::TEXT;
END;
$$;

CREATE OR REPLACE FUNCTION perform_worker_checkout(
  p_site_id UUID, p_lat NUMERIC, p_lng NUMERIC,
  p_ot_start TIME DEFAULT NULL, p_ot_end TIME DEFAULT NULL,
  p_ot_hours NUMERIC DEFAULT NULL, p_ot_is_overnight BOOLEAN DEFAULT false, p_ot_notes TEXT DEFAULT NULL
)
RETURNS TABLE(success BOOLEAN, distance_m NUMERIC, radius_m NUMERIC, message TEXT)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_worker_id UUID;
  v_site_lat NUMERIC;
  v_site_lng NUMERIC;
  v_radius NUMERIC;
  v_distance NUMERIC;
  v_today DATE := CURRENT_DATE;
BEGIN
  SELECT id INTO v_worker_id FROM workers WHERE email = auth.email() AND tenant_id = v_tenant_id;
  IF v_worker_id IS NULL THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้'::TEXT;
    RETURN;
  END IF;

  IF NOT EXISTS (SELECT 1 FROM worker_checkins WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today) THEN
    RETURN QUERY SELECT false, NULL::NUMERIC, NULL::NUMERIC, 'ยังไม่ได้เช็คอินวันนี้ — เช็คอินก่อนจึงจะเช็คเอาท์ได้'::TEXT;
    RETURN;
  END IF;

  SELECT lat, lng INTO v_site_lat, v_site_lng FROM sites WHERE id = p_site_id AND tenant_id = v_tenant_id;
  SELECT COALESCE((SELECT value::numeric FROM app_settings WHERE tenant_id = v_tenant_id AND key = 'checkin_radius_m'), 200)
    INTO v_radius;
  v_distance := haversine_distance_m(p_lat, p_lng, v_site_lat, v_site_lng);

  IF v_distance > v_radius THEN
    RETURN QUERY SELECT false, v_distance, v_radius,
      format('คุณอยู่ห่างจากไซท์งาน %s เมตร ต้องอยู่ในระยะ %s เมตรจึงจะเช็คเอาท์ได้', round(v_distance), round(v_radius))::TEXT;
    RETURN;
  END IF;

  UPDATE worker_checkins
  SET checkout_at = now(), checkout_lat = p_lat, checkout_lng = p_lng, checkout_distance_m = v_distance
  WHERE worker_id = v_worker_id AND site_id = p_site_id AND date = v_today;

  -- OT fields are optional -- the frontend (Task 7) decides whether the
  -- checkout time crosses the regular-shift-end setting and only passes
  -- these when it does. Trust level here matches admin-typed OT today
  -- (CellEditPopup.jsx): the number isn't re-derived server-side from
  -- p_ot_start/p_ot_end, same as an admin's manual entry isn't either.
  IF p_ot_hours IS NOT NULL THEN
    INSERT INTO worker_ot (worker_id, site_id, date, start_time, end_time, ot_hours, is_overnight, notes, tenant_id)
    VALUES (v_worker_id, p_site_id, v_today, p_ot_start, p_ot_end, p_ot_hours, p_ot_is_overnight, p_ot_notes, v_tenant_id)
    ON CONFLICT (worker_id, date) DO UPDATE
      SET site_id = p_site_id, start_time = p_ot_start, end_time = p_ot_end,
          ot_hours = p_ot_hours, is_overnight = p_ot_is_overnight, notes = p_ot_notes;
  END IF;

  RETURN QUERY SELECT true, v_distance, v_radius, 'เช็คเอาท์สำเร็จ'::TEXT;
END;
$$;

GRANT EXECUTE ON FUNCTION perform_worker_checkin(UUID, NUMERIC, NUMERIC) TO authenticated;
GRANT EXECUTE ON FUNCTION perform_worker_checkout(UUID, NUMERIC, NUMERIC, TIME, TIME, NUMERIC, BOOLEAN, TEXT) TO authenticated;

ROLLBACK;
```

Expected: no errors.

- [ ] **Step 2: Apply live** via `apply_migration` (name: `worker_checkin_functions`), same SQL minus `BEGIN;`/`ROLLBACK;`.

- [ ] **Step 3: Write the migration file** to `supabase/migrations/2026-09-03-02-worker-checkin-functions.sql` with a header comment explaining the SECURITY DEFINER rationale (reuse the comment already written inline above the functions in Step 1).

- [ ] **Step 4: Update schema.sql** — add all three function definitions (with their comments) and the two `GRANT EXECUTE` lines.

- [ ] **Step 5: Verify with a throwaway test tenant**

Create a test tenant, worker, site (with lat/lng set to a known point, e.g. Bangkok `13.756331, 100.501765`), and a `type='site'` assignment for today, using the exact pattern from Task 7 Step 1 (same migration applies here — create it once, reuse for both tasks' verification, or recreate per-task and clean up each time; either is fine as long as cleanup is verified).

Then, still with `SET LOCAL role = authenticated; SELECT set_config('request.jwt.claims', '{"email":"<test-worker-email>"}', true);` active in the same transaction as the test setup (or in a fresh `execute_sql` call with that same simulated context):

```sql
SELECT * FROM perform_worker_checkin('<site-id>', 13.756331, 100.501765);
```

Expected: `success = true`, `distance_m` near `0`. Then:

```sql
SELECT confirmed_at, confirmed_by FROM worker_assignments WHERE worker_id = '<worker-id>' AND site_id = '<site-id>';
```

Expected: `confirmed_at` is set, `confirmed_by = 'checkin'`.

Then test the hard block with a far-away point (e.g. `18.7883, 98.9853` — Chiang Mai):

```sql
SELECT * FROM perform_worker_checkin('<site-id-2-if-different-or-reset-first-row>', 18.7883, 98.9853);
```

Expected: `success = false`, `distance_m` is a large number (hundreds of km in meters), `message` contains the distance.

Clean up the test tenant fully afterward (verify `0` rows).

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-03-02-worker-checkin-functions.sql supabase/schema.sql
git commit -m "feat: SECURITY DEFINER functions for GPS-verified worker check-in/out"
```

---

### Task 3: Payroll — gate `labor_cost_by_site` on confirmation

**Files:**
- Create: `supabase/migrations/2026-09-03-03-gate-labor-cost-on-confirmation.sql`
- Modify: `supabase/schema.sql:2643-2657` (the `labor_cost_by_site` view definition)

**Interfaces:**
- Consumes: `worker_assignments.confirmed_at` (Task 1).
- Produces: `labor_cost_by_site` view, same columns as today, with `type='factory'` rows still counting unconditionally and `type='site'` rows only counting once confirmed.

- [ ] **Step 1: Dry-run**

```sql
BEGIN;

CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND(w.monthly_salary / 26 * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory' OR (wa.type = 'site' AND wa.confirmed_at IS NOT NULL)
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;

ROLLBACK;
```

Expected: no errors.

- [ ] **Step 2: Apply live** via `apply_migration` (name: `gate_labor_cost_on_confirmation`).

- [ ] **Step 3: Write the migration file** to `supabase/migrations/2026-09-03-03-gate-labor-cost-on-confirmation.sql`:

```sql
-- supabase/migrations/2026-09-03-03-gate-labor-cost-on-confirmation.sql
-- A 'site'-type shift only counts toward payroll once confirmed (a real
-- check-in, or an admin override -- see 2026-09-03-01/02 and
-- docs/superpowers/specs/2026-09-01-worker-checkin-checkout-design.md).
-- 'factory' rows are untouched -- there's no site to check in at, they
-- keep counting immediately as before.
CREATE OR REPLACE VIEW labor_cost_by_site WITH (security_invoker = true) AS
SELECT
  wa.site_id,
  s.name        AS site_name,
  s.site_number,
  wa.worker_id,
  w.name        AS worker_name,
  w.nickname,
  COUNT(*) * 0.5 AS days_worked,
  ROUND(w.monthly_salary / 26 * (COUNT(*) * 0.5), 2) AS labor_cost
FROM worker_assignments wa
JOIN workers w ON wa.worker_id = w.id
JOIN sites s ON wa.site_id = s.id
WHERE wa.type = 'factory' OR (wa.type = 'site' AND wa.confirmed_at IS NOT NULL)
GROUP BY wa.site_id, s.name, s.site_number, wa.worker_id, w.name, w.nickname, w.monthly_salary;
```

- [ ] **Step 4: Update schema.sql** — replace the view definition at `supabase/schema.sql:2643-2657` with the above (comment + SQL).

- [ ] **Step 5: Verify with a throwaway test tenant**

Create a worker with `monthly_salary = 26000` (so `monthly_salary/26 = 1000/day`), two `type='site'` assignment rows for two different dates (one with `confirmed_at` set, one left `NULL`), then:

```sql
SET LOCAL role = authenticated;
SELECT set_config('request.jwt.claims', '{"email":"<admin-email-of-test-tenant>"}', true);
SELECT * FROM labor_cost_by_site WHERE worker_id = '<worker-id>';
```

Expected: `days_worked = 0.5` (only the confirmed row counts, not 1.0), `labor_cost = 500`.

Clean up the test tenant fully afterward.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-03-03-gate-labor-cost-on-confirmation.sql supabase/schema.sql
git commit -m "fix: unconfirmed site shifts no longer count toward labor cost"
```

---

### Task 4: Admin UI — site coordinates in `SiteForm`

**Files:**
- Modify: `src/pages/Sites.jsx:40-48` (`EMPTY_FORM`), `src/pages/Sites.jsx:58-82` (`siteFormToPayload`), `src/pages/Sites.jsx:129-139` (the form JSX, right after the `map_url` field)

**Interfaces:**
- Produces: `sites.lat`/`sites.lng` get written from `SiteForm` on save. Consumed by Task 2's `perform_worker_checkin`/`perform_worker_checkout` (already live from Task 1/2 regardless of whether any site has coordinates set yet — this task is what lets office staff actually set them).

- [ ] **Step 1: Add fields to `EMPTY_FORM`**

In `src/pages/Sites.jsx`, change:

```js
const EMPTY_FORM = {
  name: '', client_id: '', location: '',
  distance_km: '', map_url: '',
```

to:

```js
const EMPTY_FORM = {
  name: '', client_id: '', location: '',
  distance_km: '', map_url: '', lat: '', lng: '',
```

- [ ] **Step 2: Add fields to `siteFormToPayload`**

Change:

```js
    location:       form.location || null,
    distance_km:    parseFloat(form.distance_km) || null,
    map_url:        form.map_url || null,
```

to:

```js
    location:       form.location || null,
    distance_km:    parseFloat(form.distance_km) || null,
    map_url:        form.map_url || null,
    lat:            form.lat === '' ? null : parseFloat(form.lat),
    lng:            form.lng === '' ? null : parseFloat(form.lng),
```

- [ ] **Step 3: Add the form fields with a "use my current location" button**

Right after the `map_url` field's closing `</div>` (the second `<div>` inside the `form-grid-2` that currently ends the row), add a new row:

```jsx
        <div className="form-grid-2">
          <div>
            <label className="label">พิกัด GPS ไซท์งาน (ละติจูด, ลองจิจูด)</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input type="number" step="any" className="input" value={form.lat}
                onChange={e => set('lat', e.target.value)} placeholder="ละติจูด เช่น 13.756331" />
              <input type="number" step="any" className="input" value={form.lng}
                onChange={e => set('lng', e.target.value)} placeholder="ลองจิจูด เช่น 100.501765" />
            </div>
          </div>
          <div style={{ display: 'flex', alignItems: 'flex-end' }}>
            <button type="button" className="btn btn-ghost" onClick={() => {
              if (!navigator.geolocation) { alert('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง'); return }
              navigator.geolocation.getCurrentPosition(
                pos => { set('lat', String(pos.coords.latitude)); set('lng', String(pos.coords.longitude)) },
                err => alert('ไม่สามารถอ่านตำแหน่งได้: ' + err.message)
              )
            }}>📍 ใช้ตำแหน่งปัจจุบัน</button>
          </div>
        </div>
        <p style={{ fontSize: 11.5, color: 'var(--text3)', marginTop: -6, marginBottom: 12 }}>
          ต้องตั้งพิกัดก่อน พนักงานจึงจะเช็คอินที่ไซท์นี้ได้ — ยืนที่ไซท์งานแล้วกดปุ่ม "ใช้ตำแหน่งปัจจุบัน" ง่ายที่สุด
        </p>
```

- [ ] **Step 4: Build**

```bash
npx vite build
```

Expected: succeeds, no errors.

- [ ] **Step 5: Verify with a throwaway test tenant + Playwright**

Log in as the test tenant's admin, open Sites, create or edit a site, click "📍 ใช้ตำแหน่งปัจจุบัน" (Playwright can grant geolocation via `context.grantPermissions(['geolocation'])` and `context.setGeolocation({latitude, longitude})` before navigating), confirm the lat/lng inputs populate, save, and confirm via SQL that `sites.lat`/`sites.lng` were written correctly.

Clean up the test tenant fully afterward.

- [ ] **Step 6: Commit**

```bash
git add src/pages/Sites.jsx
git commit -m "feat: capture site GPS coordinates in SiteForm"
```

---

### Task 5: Admin UI — Settings for check-in radius and regular shift end time

**Files:**
- Modify: `src/pages/Settings.jsx` (near the existing "✍️ วิธีเซ็นรับเอกสาร" card — see `src/pages/Settings.jsx:254-274` for the exact surrounding pattern this task mirrors)

**Interfaces:**
- Consumes: `useAppSetting(key, fallback)` / `saveAppSetting(key, value)` (`src/hooks/useSupabase.js:702-719`, already exist, no changes needed).
- Produces: `app_settings` keys `checkin_radius_m` (default `'200'`) and `regular_shift_end_time` (default `'17:00'`), read by Task 2's SQL functions and Task 7's frontend respectively.

- [ ] **Step 1: Add state + save handlers**

In `src/pages/Settings.jsx`, near the existing `signPhysicalVal`/`signDigitalVal` block (`src/pages/Settings.jsx:58-59`), add:

```js
  // เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง -- ระยะที่ยอมให้เช็คอินได้ (เมตร) และเวลา
  // เลิกงานปกติ (ใช้ตัดสินว่าการเช็คเอาท์หลังจากนี้นับเป็น OT หรือไม่)
  const { data: checkinRadiusVal, refetch: refetchCheckinRadius } = useAppSetting('checkin_radius_m', '200')
  const { data: shiftEndVal, refetch: refetchShiftEnd } = useAppSetting('regular_shift_end_time', '17:00')
  const [checkinRadius, setCheckinRadius] = useState('')
  const [shiftEnd, setShiftEnd] = useState('')
  const [savingCheckin, setSavingCheckin] = useState(false)
  useEffect(() => { if (checkinRadiusVal != null) setCheckinRadius(String(checkinRadiusVal)) }, [checkinRadiusVal])
  useEffect(() => { if (shiftEndVal != null) setShiftEnd(String(shiftEndVal)) }, [shiftEndVal])

  const handleSaveCheckinSettings = async () => {
    setSavingCheckin(true)
    try {
      await saveAppSetting('checkin_radius_m', parseFloat(checkinRadius) || 200)
      await saveAppSetting('regular_shift_end_time', shiftEnd || '17:00')
      refetchCheckinRadius(); refetchShiftEnd()
      alert('✅ บันทึกการตั้งค่าเช็คอินแล้ว')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSavingCheckin(false)
    }
  }
```

- [ ] **Step 2: Add the UI card**

Right after the "✍️ วิธีเซ็นรับเอกสาร" card's closing `)}` (`src/pages/Settings.jsx:274`), add:

```jsx
      {/* ── เช็คอินตำแหน่งที่ตั้ง ── */}
      <div className="card" style={{ marginBottom: 24, padding: '16px 20px' }}>
        <h2 style={{ marginBottom: 4, fontSize: 16, fontWeight: 700 }}>📍 เช็คอิน/เช็คเอาท์ตำแหน่งที่ตั้ง</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12 }}>
          พนักงานต้องอยู่ในระยะที่กำหนดจากไซท์งานจึงจะเช็คอินได้ — งานปกติเช็คอินอย่างเดียวก็ยืนยันแล้ว ส่วน OT ต้องเช็คเอาท์หลังเวลาเลิกงานปกติด้วย
        </p>
        <div style={{ display: 'flex', gap: 10, alignItems: 'flex-end', flexWrap: 'wrap' }}>
          <div>
            <label className="label">ระยะที่ยอมให้เช็คอิน (เมตร)</label>
            <input type="number" className="input" min="10" step="10" style={{ width: 160 }}
              value={checkinRadius} onChange={e => setCheckinRadius(e.target.value)} />
          </div>
          <div>
            <label className="label">เวลาเลิกงานปกติ (ใช้ตัดสิน OT)</label>
            <input type="time" className="input" style={{ width: 160 }}
              value={shiftEnd} onChange={e => setShiftEnd(e.target.value)} />
          </div>
          <button className="btn btn-primary" onClick={handleSaveCheckinSettings} disabled={savingCheckin}>
            {savingCheckin ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
          </button>
        </div>
      </div>
```

- [ ] **Step 3: Build**

```bash
npx vite build
```

- [ ] **Step 4: Verify with a throwaway test tenant + Playwright**

Log in as admin, open Settings, confirm the card renders with defaults (`200`, `17:00`), change both values, save, reload, confirm the new values persisted (both in the UI and via `SELECT value FROM app_settings WHERE key IN ('checkin_radius_m','regular_shift_end_time')`).

Clean up the test tenant fully afterward.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.jsx
git commit -m "feat: settings for check-in radius and regular shift end time"
```

---

### Task 6: Admin UI — confirmation status and manual override on the Assign grid

**Files:**
- Modify: `src/hooks/useSupabase.js:521-533` (`useAssignmentsRange` — add the two new columns to the select)
- Modify: `src/pages/assign/CellEditPopup.jsx` (show confirmation status, add an override button)
- Modify: `src/pages/Assign.jsx` (wire a new `handleConfirm` and pass it down; import `useUserRole` for the admin's own email)

**Interfaces:**
- Consumes: `worker_assignments.confirmed_at`/`confirmed_by` (Task 1).
- Produces: `CellEditPopup` gains an `onConfirm` prop (`() => void`), called when the admin clicks the override button.

- [ ] **Step 1: Add columns to the assignments query**

In `src/hooks/useSupabase.js`, change line 526's select from:

```js
      .select('id, worker_id, site_id, date, type, shift, ot_hours, notes, workers(name, nickname, monthly_salary), sites(name, site_number)')
```

to:

```js
      .select('id, worker_id, site_id, date, type, shift, ot_hours, notes, confirmed_at, confirmed_by, workers(name, nickname, monthly_salary), sites(name, site_number)')
```

- [ ] **Step 2: Add the confirmation status block to `CellEditPopup`**

In `src/pages/assign/CellEditPopup.jsx`, add a new prop `onConfirm` to the function signature:

```js
export default function CellEditPopup({ target, sites = [], onSave, onDelete, onSaveOT, onDeleteOT, onConfirm, onClose, saving }) {
```

Right after the `{needsSite && (...)}` block that renders the site `SearchableSelect` (ends at line 122), add:

```jsx
        {needsSite && existing && (
          <div style={{ fontSize: 12.5 }}>
            {existing.confirmed_at ? (
              <span style={{ color: 'var(--green)' }}>
                ✅ {existing.confirmed_by === 'checkin' ? 'ยืนยันแล้ว (เช็คอินจริง)' : `ยืนยันโดยแอดมิน (${existing.confirmed_by})`}
                {' '}· {new Date(existing.confirmed_at).toLocaleString('th-TH')}
              </span>
            ) : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ color: 'var(--yellow)' }}>⏳ รอการยืนยัน (ยังไม่นับเป็นค่าแรง)</span>
                <button type="button" className="btn btn-sm btn-ghost" onClick={onConfirm} disabled={saving}>ยืนยันเอง</button>
              </div>
            )}
          </div>
        )}
```

- [ ] **Step 3: Wire `handleConfirm` in `Assign.jsx`**

Confirm `useUserRole` is already imported in `Assign.jsx` (grep for it — if not, add `import { useUserRole } from '../hooks/useUserRole.js'` and `const { user } = useUserRole()` near the top of the component, following the same pattern `MySchedule.jsx` uses). Then, right after `handleCellDelete` (`src/pages/Assign.jsx:147-156`), add:

```js
  const handleConfirm = async () => {
    if (!cellTarget?.existing?.id) return
    setSaving(true)
    try {
      const { error } = await supabase.from('worker_assignments')
        .update({ confirmed_at: new Date().toISOString(), confirmed_by: user?.email })
        .eq('id', cellTarget.existing.id)
      if (error) throw error
      refetch()
      setCellTarget(t => t && { ...t, existing: { ...t.existing, confirmed_at: new Date().toISOString(), confirmed_by: user?.email } })
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }
```

Pass it to `CellEditPopup` (`src/pages/Assign.jsx:310-319`):

```jsx
        <CellEditPopup
          target={cellTarget}
          sites={ongoingSites}
          onSave={handleCellSave}
          onDelete={handleCellDelete}
          onSaveOT={handleOTSave}
          onDeleteOT={handleOTDelete}
          onConfirm={handleConfirm}
          onClose={() => setCellTarget(null)}
          saving={saving}
        />
```

- [ ] **Step 4: Build**

```bash
npx vite build
```

- [ ] **Step 5: Verify with a throwaway test tenant + Playwright**

Create a `type='site'` assignment with `confirmed_at IS NULL`. Log in as admin, open Assign, click that cell, confirm the "⏳ รอการยืนยัน" indicator and "ยืนยันเอง" button show. Click it, confirm the indicator switches to "✅ ยืนยันโดยแอดมิน (<admin email>)" without closing the popup, and confirm via SQL that `confirmed_at`/`confirmed_by` were written correctly.

Clean up the test tenant fully afterward.

- [ ] **Step 6: Commit**

```bash
git add src/hooks/useSupabase.js src/pages/assign/CellEditPopup.jsx src/pages/Assign.jsx
git commit -m "feat: confirmation status and manual override on the Assign grid"
```

---

### Task 7: Worker UI — check-in/check-out on `MySchedule`

**Files:**
- Create: `src/pages/assign/TodayCheckinCard.jsx`
- Modify: `src/pages/assign/MySchedule.jsx` (render one `TodayCheckinCard` per distinct site the worker is assigned to today)
- Modify: `src/hooks/useSupabase.js` (add `useTodayCheckin`)

**Interfaces:**
- Consumes: `perform_worker_checkin`/`perform_worker_checkout` RPCs (Task 2), `app_settings.regular_shift_end_time` — but note WORKER role can't `SELECT` from `app_settings` directly (RLS: `admin_reads` requires `is_admin_or_owner()`). Rather than adding a new RLS exception, this task reads it via a small dedicated read: since the OT decision must happen client-side (to decide whether to pass `p_ot_*` params to `perform_worker_checkout` at all), and the worker can't read `app_settings`, checkout always computes OT client-side using a value fetched through a new tiny SECURITY DEFINER function `get_regular_shift_end_time() RETURNS TEXT` (returns the tenant's setting or `'17:00'` default) — same SECURITY DEFINER rationale as Task 2's functions, and it's the only way a WORKER-role user can read this one setting without a broader `app_settings` RLS change. Add this function in Step 1 below.

- [ ] **Step 1: Add the `get_regular_shift_end_time` helper function**

Dry-run, apply live (name: `worker_shift_end_time_getter`), then write to a new migration file `supabase/migrations/2026-09-03-04-shift-end-time-getter.sql` and update `schema.sql`, following the exact same dry-run → apply → file → schema.sql sequence as Task 1/2:

```sql
CREATE OR REPLACE FUNCTION get_regular_shift_end_time()
RETURNS TEXT
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT COALESCE((SELECT value FROM app_settings WHERE tenant_id = current_tenant_id() AND key = 'regular_shift_end_time'), '17:00');
$$;

GRANT EXECUTE ON FUNCTION get_regular_shift_end_time() TO authenticated;
```

**Note on multi-site days:** a worker can have `type='site'` assignments at two *different* sites on the same day (spec edge case: "each site gets its own `worker_checkins` row... two 'Today' cards, independently confirmable"). This means the check-in UI must render one independent block per distinct `site_id` among today's `site`-type assignments, not just the first one found. Steps 2-4 below implement this via a small `TodayCheckinCard` subcomponent (one instance per distinct site) so each can call the `useTodayCheckin` hook independently — hooks can't be called in a loop directly, a subcomponent is the correct way to do this in React.

- [ ] **Step 2: Add the `useTodayCheckin` hook**

Add to `src/hooks/useSupabase.js` (near `useDocumentReceipt`, same shape):

```js
export function useTodayCheckin(workerId, siteId, date) {
  return useQuery(async () => {
    if (!workerId || !siteId || !date) return null
    const { data, error } = await supabase
      .from('worker_checkins')
      .select('*')
      .eq('worker_id', workerId).eq('site_id', siteId).eq('date', date)
      .maybeSingle()
    if (error) throw error
    return data
  }, [workerId, siteId, date])
}
```

- [ ] **Step 3: Create the `TodayCheckinCard` subcomponent**

Create `src/pages/assign/TodayCheckinCard.jsx`:

```jsx
// ============================================================
// TodayCheckinCard — one instance per distinct site a worker is
// assigned to today. Owns its own geolocation + RPC calls so multiple
// same-day site assignments (spec: "worker assigned to two different
// sites same day") each get an independent check-in/out flow.
// ============================================================
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useTodayCheckin } from '../../hooks/useSupabase.js'
import { computeOTHours } from './otMath.js'

const getGeolocation = () => new Promise((resolve, reject) => {
  if (!navigator.geolocation) { reject(new Error('เบราว์เซอร์นี้ไม่รองรับตำแหน่งที่ตั้ง')); return }
  navigator.geolocation.getCurrentPosition(
    pos => resolve(pos.coords),
    err => reject(new Error('ต้องเปิดสิทธิ์ตำแหน่งที่ตั้งเพื่อเช็คอิน: ' + err.message))
  )
})

export default function TodayCheckinCard({ workerId, siteId, siteName, date }) {
  const { data: checkin, refetch } = useTodayCheckin(workerId, siteId, date)
  const [state, setState] = useState(null) // { loading, message, success }

  const handleCheckIn = async () => {
    setState({ loading: true, message: null })
    try {
      const coords = await getGeolocation()
      const { data, error } = await supabase.rpc('perform_worker_checkin', {
        p_site_id: siteId, p_lat: coords.latitude, p_lng: coords.longitude,
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
      const shiftEndStr = await supabase.rpc('get_regular_shift_end_time').then(r => r.data)
      const nowStr = new Date().toTimeString().slice(0, 5)
      let otParams = {}
      if (shiftEndStr && nowStr > shiftEndStr) {
        const otHours = computeOTHours(shiftEndStr, nowStr, false)
        if (otHours != null && otHours > 0) {
          otParams = { p_ot_start: shiftEndStr, p_ot_end: nowStr, p_ot_hours: otHours, p_ot_is_overnight: false, p_ot_notes: 'auto จากเช็คเอาท์' }
        }
      }
      const { data, error } = await supabase.rpc('perform_worker_checkout', {
        p_site_id: siteId, p_lat: coords.latitude, p_lng: coords.longitude, ...otParams,
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
      <div style={{ fontSize: 11.5, color: 'var(--text3)', marginBottom: 4 }}>{siteName}</div>
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

- [ ] **Step 4: Wire it into `MySchedule.jsx`**

Import it: `import TodayCheckinCard from './TodayCheckinCard.jsx'`.

Right after the `myAssignmentsByDate` `useMemo` block, add a computed list of today's distinct site assignments:

```js
  const todayIso = new Date().toISOString().slice(0, 10)
  const todaySiteAssignments = useMemo(() => {
    const rows = (myAssignmentsByDate[todayIso] || []).filter(a => a.type === 'site')
    const bySite = new Map()
    rows.forEach(a => { if (!bySite.has(a.site_id)) bySite.set(a.site_id, a) })
    return [...bySite.values()]
  }, [myAssignmentsByDate, todayIso])
```

In the day/week view's card render (`src/pages/assign/MySchedule.jsx:137-170`), inside the `isToday` card, after the OT badge block (still inside the outer card `<div>`, which needs no layout change — `TodayCheckinCard` renders full-width block elements that naturally stack below the existing 3-column row), add:

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

Note this must be a sibling of the existing 3-column grid `<div>` inside the day card's outer container, not inside the 3-column grid itself — the outer `return (<div key={d.iso} style={{...}}>...)` at `src/pages/assign/MySchedule.jsx:137-142` currently returns ONE grid div directly; wrap it so the grid row and the (optional, today-only) checkin card(s) are both children of a new outer `<div key={d.iso}>` fragment, e.g. change the return to `<div key={d.iso}><div style={{ display:'grid', ...}}>...(existing grid content)...</div>{isToday && todaySiteAssignments.map(...)}</div>`.

- [ ] **Step 5: Build**

```bash
npx vite build
```

- [ ] **Step 6: Verify with a throwaway test tenant + Playwright**

Create a full test tenant using this exact pattern (used throughout this session):

```sql
BEGIN;
INSERT INTO auth.users (
  instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
  raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
  confirmation_token, recovery_token, email_change_token_new, email_change
) VALUES (
  '00000000-0000-0000-0000-000000000000', gen_random_uuid(), 'authenticated', 'authenticated',
  'checkin-worker@facadex-test.local', crypt('testpassword123', gen_salt('bf')), now(),
  '{"provider":"email","providers":["email"]}', '{}', now(), now(),
  '', '', '', ''
);
INSERT INTO auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
SELECT gen_random_uuid(), u.id, u.id::text, jsonb_build_object('sub', u.id::text, 'email', u.email), 'email', now(), now(), now()
FROM auth.users u WHERE u.email = 'checkin-worker@facadex-test.local';
-- user_roles row auto-created by handle_new_user() trigger; fetch tenant_id from it, then:
UPDATE tenants SET plan = 'active', plan_expires_at = now() + interval '30 days' WHERE id = (SELECT tenant_id FROM user_roles WHERE user_email = 'checkin-worker@facadex-test.local');
UPDATE user_roles SET role = 'WORKER' WHERE user_email = 'checkin-worker@facadex-test.local';
-- then, as that tenant's owner/admin context: create a workers row with email = 'checkin-worker@facadex-test.local',
-- a site with lat/lng set to a known point, and a type='site' worker_assignments row dated today for that worker/site.
COMMIT;
```

In Playwright: `context.grantPermissions(['geolocation']); context.setGeolocation({ latitude: <site lat>, longitude: <site lng> })` before `page.goto(...)`. Log in as `checkin-worker@facadex-test.local`, navigate to the Assign/schedule tab (`sessionStorage.setItem('pendingTab', 'assign')` then reload, matching this session's established deep-link pattern), confirm today's card shows "📍 เช็คอิน", click it, confirm it switches to "📍 เช็คเอาท์" and no error message shows. Click that, confirm it switches to "✅ เช็คอิน/เช็คเอาท์ครบแล้ววันนี้". Verify via SQL that `worker_checkins` has both timestamps and `worker_assignments.confirmed_at` is set.

Then repeat with `context.setGeolocation` pointing somewhere far away on a fresh test tenant (or delete the `worker_checkins` row and reset `confirmed_at` to NULL on the same one) and confirm the hard-block message renders instead, with `confirmed_at` still NULL afterward.

Clean up the test tenant fully afterward (verify `0` rows across `auth.users`, `workers`, `worker_checkins`, `worker_assignments`, `sites`, `tenants` for this test tenant).

- [ ] **Step 7: Commit**

```bash
git add src/pages/assign/MySchedule.jsx src/pages/assign/TodayCheckinCard.jsx src/hooks/useSupabase.js supabase/migrations/2026-09-03-04-shift-end-time-getter.sql supabase/schema.sql
git commit -m "feat: GPS check-in/check-out on the worker's schedule view"
```

---

## After all tasks: push

```bash
git fetch origin main
git log HEAD..origin/main --oneline   # must be empty
git push origin worktree-quotation-module:main
```
