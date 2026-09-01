# Location-Based Worker Check-In/Check-Out — Design

## Purpose

Field workers currently have no way to interact with the app beyond viewing their own schedule (`MySchedule.jsx`, read-only) and their own HR records (also read-only). Office staff plan every worker's shift in advance via the Assign grid, and once a shift row exists in `worker_assignments`, it counts toward payroll unconditionally — there is no verification that the worker was actually at the site.

This feature adds GPS-verified check-in/check-out so a pre-planned shift only counts toward pay once the worker confirms their presence from the correct location, with a manual admin override for legitimate failures (dead phone, no signal, forgot).

**UI surface:** this spec covers the check-in/check-out mechanism itself (data model, verification logic, payroll integration). It assumes a worker-facing "today" screen to put the buttons on — reusing/extending `MySchedule.jsx`'s existing day view is enough for v1; a dedicated simplified landing page (suggested separately, alongside other mobile-worker-interface ideas) is not required before this can ship and isn't designed here.

## Current system facts this design depends on

- **Payroll is not hourly.** Each `worker_assignments` row (`type IN ('site','factory')`) is a flat 0.5-day unit: `labor_cost_by_site` computes `days_worked = COUNT(*) * 0.5` and `labor_cost = monthly_salary/26 * days_worked`. There is no clock-time concept in regular-shift pay today.
- **OT is separate and already time-based.** `worker_ot` has `start_time`/`end_time`/`ot_hours`/`is_overnight`. `ot_hours` is computed client-side via `computeOTHours(start, end, isOvernight)` in `src/pages/assign/otMath.js` (0.5h rounding), currently from an admin-typed form (`CellEditPopup.jsx`). Pay: `ot_hours * (monthly_salary/26/8) * 1.5`.
- **No confirmed/pending concept exists anywhere.** A row in `worker_assignments` or `worker_ot` is created and immediately final. This is new.
- **Worker identity is via email, not a user_id FK.** `workers.email` is matched against `auth.email()` at query/RLS time (see `MySchedule.jsx`: `workers.find(w => w.email === user?.email)`). No `user_id UUID` column exists on `workers`.
- **WORKER role has zero write access today.** RLS on `worker_assignments`, `worker_ot`, and `workers` restricts all INSERT/UPDATE/DELETE to `is_admin_or_owner()`; WORKER-role SELECT is scoped to their own rows only. New RLS policies are required for any worker self-service write.
- **`sites` has no coordinates.** Only `location` (free text) and `map_url` (a pasted Google Maps link) exist. `distance_km` is a manually-entered straight-line factory distance used only for travel-cost calculation — unrelated to live proximity.
- **`type` scoping:** only `type = 'site'` assignments represent the worker physically going to a client site. `factory` means production work happens at the company's own factory (site_id still references the client site for cost attribution, but the worker isn't physically there) — GPS verification against `sites.lat/lng` would be meaningless for `factory` rows. `office`/`holiday`/`leave_sick`/`leave_personal`/`subcontract` aren't site presence at all. **This feature only ever gates `type = 'site'` assignments.** Every other type is unaffected and stays exactly as it works today (admin-created, immediately final).

## Decisions already made (via brainstorming)

1. Check-in outside the allowed radius is a **hard block** — no way to check in from the wrong place.
2. Admin still plans shifts in advance via the existing Assign grid — unchanged. Check-in is a **confirmation gate** on top of that plan, not a replacement for planning.
3. A regular `site`-type shift needs **check-in only** to be confirmed for payroll. **OT needs both check-in and check-out** — the checkout timestamp (if later than the regular shift's end) is what populates `worker_ot.start_time`/`end_time` via the existing `computeOTHours()`.
4. If a worker never checks in, the shift is **not paid by default**, but an **admin can manually confirm it** from the Assign grid (same trust level the system already extends to admin today).

## Data model

### `sites` — add coordinates

```sql
ALTER TABLE sites ADD COLUMN lat NUMERIC(9,6);
ALTER TABLE sites ADD COLUMN lng NUMERIC(9,6);
```

Both nullable. A site with no coordinates set simply can't be checked into yet (see UI section) — existing sites are unaffected until someone sets them.

### `worker_assignments` — add confirmation

```sql
ALTER TABLE worker_assignments ADD COLUMN confirmed_at TIMESTAMPTZ;
ALTER TABLE worker_assignments ADD COLUMN confirmed_by TEXT; -- 'checkin' or an admin's email
```

`confirmed_at IS NULL` = pending (today's behavior, minus counting toward payroll — see Payroll section). Set automatically on a successful check-in, or manually by an admin (`confirmed_by` = their email, distinguishing an admin override from a real check-in in the UI).

### New table: `worker_checkins`

One row per worker/site/day — the actual attendance event, kept separate from the plan (`worker_assignments`) so the plan-vs-actual distinction stays clean and a check-in can be recorded even in edge cases (see Edge Cases below).

```sql
CREATE TABLE worker_checkins (
  id               UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id        UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  worker_id        UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  site_id          UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  date             DATE NOT NULL,
  checkin_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  checkin_lat      NUMERIC(9,6) NOT NULL,
  checkin_lng      NUMERIC(9,6) NOT NULL,
  checkin_distance_m NUMERIC NOT NULL,   -- computed distance from site at check-in time, stored for audit
  checkout_at      TIMESTAMPTZ,
  checkout_lat     NUMERIC(9,6),
  checkout_lng     NUMERIC(9,6),
  checkout_distance_m NUMERIC,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (worker_id, site_id, date)
);
```

RLS: a WORKER can INSERT/UPDATE only where `worker_id IN (SELECT id FROM workers WHERE email = auth.email())` — the one new write surface this feature grants to non-admin users. Admin/owner get full access as usual.

### `app_settings` — radius tolerance

New key `checkin_radius_m` (default `200`), same pattern as the existing `travel_rate_per_km` (`useAppSetting`/`saveAppSetting`). Configurable per tenant in Settings.

## Business logic

### Distance check

Haversine formula, client-side (no new Edge Function needed — this is a pure math comparison against data already fetched, and the hard-block decision means the worker's own device is the right place to reject a bad check-in immediately, before any write). Standard formula, ~10 lines, no new dependency.

### Check-in flow (worker-facing)

1. Worker's "Today" view shows their `site`-type assignment(s) for today (from `worker_assignments`, filtered to their own `worker_id`, `type = 'site'`).
2. If the assigned site has no `lat`/`lng` set, show "ไซท์งานนี้ยังไม่ได้ตั้งพิกัด — ติดต่อสำนักงาน" (site has no coordinates yet — contact the office) instead of a check-in button. No silent fallback that skips verification.
3. Tap "เช็คอิน" → browser requests geolocation permission → on success, compute distance to the assigned site.
   - Within radius: insert a `worker_checkins` row (or update if checking in again same day — see Edge Cases), then set `worker_assignments.confirmed_at = now()`, `confirmed_by = 'checkin'` for every `site`-type assignment row matching that worker/site/date (covers both morning and evening shift rows in one check-in).
   - Outside radius: hard block. Show the actual distance ("คุณอยู่ห่างจากไซท์งาน 850 เมตร ต้องอยู่ในระยะ 200 เมตรจึงจะเช็คอินได้") — no write happens.
   - Permission denied / geolocation unavailable: show a clear error ("ต้องเปิดสิทธิ์ตำแหน่งที่ตั้งเพื่อเช็คอิน") — no silent bypass.
4. "เช็คเอาท์" appears once checked in. Tapping it fills `checkout_at`/`checkout_lat`/`checkout_lng`/`checkout_distance_m` on the same `worker_checkins` row (same radius check, same hard block on failure). If `checkout_at` is later than the site's expected regular-shift end (see Edge Cases — this needs a reference end time), call the existing `computeOTHours()` and upsert `worker_ot` exactly the way `CellEditPopup.jsx` does today, just triggered by the worker's own checkout instead of an admin typing it in.

### Payroll query changes

`labor_cost_by_site`'s `COUNT(*) * 0.5 AS days_worked` needs a `WHERE` addition: a `site`-type row only counts once `confirmed_at IS NOT NULL`. `factory`/`office`/`holiday`/`leave_*`/`subcontract` rows are untouched (no confirmation gate applies to them — they keep counting immediately, as today). `Payroll.jsx`'s equivalent client-side calculation (if it duplicates this logic rather than reading the view) needs the same filter.

### Admin override

On the existing Assign grid, a `site`-type cell with `confirmed_at IS NULL` shows a pending indicator (distinct from confirmed). Admin gets a button to set `confirmed_at = now(), confirmed_by = <their email>` directly — no `worker_checkins` row gets created for an admin override (there's nothing to record — no real check-in happened), so "confirmed via checkin" vs "confirmed by admin override" stays distinguishable by whether `confirmed_by = 'checkin'` or an email.

## Edge cases

- **Multiple `site`-type assignment rows same worker/site/day (morning + evening).** One check-in confirms both — `worker_checkins` is keyed per worker/site/day, not per shift, matching how workers actually experience a workday (one arrival, one departure).
- **Worker assigned to two different sites same day.** Each site gets its own `worker_checkins` row (different `site_id`) and its own check-in/check-out. Two "Today" cards, independently confirmable.
- **Check-in with no matching `worker_assignments` row** (admin hasn't planned this worker/site/day, or plan doesn't exist yet). Reject with "ไม่พบตารางงานของคุณที่ไซท์นี้วันนี้ — ติดต่อสำนักงาน" (no schedule found for you at this site today) — this feature confirms an existing plan, it never creates one (per the "admin still plans" decision).
- **What counts as "the regular shift's expected end time" for OT triggering?** No such time exists anywhere in the current schema (shifts are morning/evening halves with no clock times). **Open question for the implementation plan, not resolved here** — simplest option: a per-tenant `app_settings` value (e.g. `regular_shift_end_time`, default `17:00`), same pattern as `checkin_radius_m`. Flag this explicitly when writing the implementation plan.
- **Re-checking in the same day** (app closed and reopened, accidental double-tap). `UNIQUE (worker_id, site_id, date)` means a second check-in is an UPDATE, not a new row — refreshes `checkin_at`/coordinates rather than erroring. `confirmed_at` on the assignment doesn't get re-set once already confirmed (avoid clobbering an admin override's `confirmed_by` with a later real check-in, or vice versa — first confirmation wins).
- **GPS accuracy in the field.** `navigator.geolocation` can return low-accuracy fixes (large `accuracy` radius) especially indoors/under structures. Out of scope for v1 per the "hard block" decision already made, but worth a follow-up if workers report frequent false rejections — noted here so it isn't forgotten, not solved now.

## Out of scope for this spec

- Capturing site coordinates via an interactive map picker (v1 is manual lat/lng entry in `SiteForm`, plus a "📍 use my current location" convenience button for an admin standing at the site — no map UI).
- Any LINE bot integration (tracked separately per existing project notes on the LINE bot phase).
- An immutable audit log of blocked/failed check-in attempts (considered as "Approach C" during brainstorming, deferred — `worker_checkins` only records successful events).
- Changing how `factory`/`office`/`holiday`/`leave_*`/`subcontract` assignments are confirmed — unaffected by this feature.
