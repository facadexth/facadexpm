# Assembly-point check-in (รวมพลที่โรงงาน/บริษัทก่อน) — design

Date: 2026-10-21 · Branch: feat/assembly-checkin · Mockup (approved):
`FactoryCheckin.dc.html` (scratchpad artifact 95a53ff4).

## Goal

Crews often meet at the factory/office first, ride to the site together, and come back.
The owner wants the real working day measured from **leaving the assembly point** to
**arriving back**, with the site arrive/leave taps in between, all from the SAME LINE
เช็คอิน button the crew uses today.

## Owner decisions (binding)

1. **One button.** Rich Menu เช็คอิน → line-webhook → one-time `/f/<token>` link →
   `FieldFormPage`. The link page works out the step from the day's order + GPS and shows it
   big: 🏭 "ออกจาก{assembly}" · 🏗️ "ถึงไซท์" · 🏗️ "ออกจากไซท์" · 🏭 "กลับถึง{assembly}".
   Labels use the real location name. Multi-site: arrive/leave A, then arrive/leave B.
   Outside the radius of the expected place → refused, distance shown.
2. **Assembly setting.** Tenant default (Settings › 📍, OWNER): "ไปไซท์เลย" or
   "รวมพลที่บริษัท/โรงงานก่อน" + which `checkin_locations` row, in `app_settings`.
   Per-site override in the site form: ตามบริษัท (default) / ไปไซท์เลย / รวมพล, a column on
   `sites`. A worker's mode for the day comes from their FIRST site that day. On
   ไปไซท์เลย days only site arrive/leave apply, exactly as today.
3. **Work time** = leave assembly → back at assembly; on no-assembly days first site arrival →
   last site departure. Shown in HR › 🕐 เช็คอิน-เช็คเอาท์ with all 4 points, travel time and
   work time. OT = work time beyond the standard day, fed to payroll ONLY behind a new tenant
   setting "คิด OT จากเวลาเช็คอิน" (default OFF).
4. **Missed assembly tap** → use the team leader's time that day (same site, same date,
   `worker_assignments.is_team_leader`), labelled "ตามหัวหน้าทีม". Leader missed it too →
   fall back to the site time and flag red for the admin.
5. **Self vs filled.** Each point records whether the worker tapped it. Filled values are
   computed at read time, never written as fake check-ins.
6. **Monthly summary per worker** on the HR page: days worked, taps made, taps expected,
   % self-tapped. No rewards.

## Data (migration 2026-10-21-02-assembly-checkin.sql)

| Change | Why |
|---|---|
| `sites.assembly_mode text NULL CHECK IN ('none','assembly')` | per-site override; NULL = ตามบริษัท |
| `app_settings` keys `assembly_mode` (`none`/`assembly`, missing = none) and `assembly_location_id` (checkin_locations.id) | tenant default |
| `app_settings` keys `ot_from_checkin` (`true`/`false`, missing = false) and `checkin_standard_day_hours` (missing = 8) | payroll switch |
| `worker_checkins.is_assembly boolean NOT NULL DEFAULT false` | marks the assembly row |
| `worker_checkins.checkin_at/lat/lng/distance_m` NOT NULL dropped, replaced by `CHECK (is_assembly OR all four NOT NULL)` | an assembly row may hold only the return tap when the worker missed the leave tap; every other row keeps the old guarantee |
| token `action_type` + `'time_clock'` | the one link for an assembly day |
| `worker_assembly_location(worker, date)` (SQL, service_role) | the single rule for "is this an assembly day, and where" |
| `perform_assembly_tap_by_id(worker, step 'leave'/'return', lat, lng)` (service_role) | geofenced write of the assembly row |

**One assembly row per worker per day**, keyed like the office check-in:
`(worker_id, checkin_location_id, date)`, `is_assembly = true`.
`checkin_at` = left the assembly point, `checkout_at` = back at the assembly point. A NULL
column = not tapped. Rows are written only by taps, so every non-null time IS self-tapped.

Mode resolution (SQL and the web share the same rule): the worker's first site today
(`worker_assignments` of type site/factory/subcontract, morning before evening, then site
name) → `sites.assembly_mode`, else the tenant `assembly_mode`, else `none`. The day is an
assembly day only when the mode is `assembly` AND `assembly_location_id` names a
checkin_locations row of this tenant with coordinates. Anything else → today's behaviour.

## Step resolver (`supabase/functions/_shared/assembly-day.ts`, pure, vitest)

Order on an assembly day: `assembly_leave` → for each site in todaysSites order
`site_arrive`, `site_leave` → `assembly_return`. The next step:

1. a site checked in but not out → `site_leave` of it (one open check-in at a time);
2. nothing tapped yet today (no leave, no site check-in) → `assembly_leave`;
3. a site still to check in → `site_arrive` of the first such;
4. return not tapped → `assembly_return`; else `done`.

GPS choice: the expected step's place within the radius wins. One forward skip is allowed:
when the expected step is `assembly_leave` and the worker is already inside the first site's
radius (forgot to tap at the factory), the page records `site_arrive` instead; the leave is
then filled from the team leader at read time. Otherwise outside the radius → refused,
"คุณอยู่ห่างจาก{place} N เมตร". The RPC re-checks the radius; the client never decides.

## Flow

- **line-webhook `sendTimeClockLinks`**: when the worker has a site today and
  `worker_assembly_location` returns a row, every time-clock command (Rich Menu button,
  typed เช็คอิน/เช็คเอาท์) issues ONE `time_clock` token, unless the day is done
  (TIME_CLOCK_DONE_MESSAGE). The check-in/check-out on/off settings still apply (leave/arrive =
  check_in, leave site/return = check_out). Assembly off → unchanged code path.
- **field-form** `time_clock`: `info` returns the plan (steps with labels + done flags and the
  next step); `submit` recomputes the plan server-side, picks the step by GPS, calls
  `perform_assembly_tap_by_id` or the existing `perform_worker_checkin/checkout_by_id`, and
  marks the token used on success (a refusal keeps the token, as today).
- **FieldFormPage** `TimeClockFlow`: big coloured step card, then the request-GPS → submit →
  result cycle of the existing CheckInFlow, plus the day's step list.

## Read-time day view (`src/lib/checkinDay.js`, pure, vitest)

Per worker-date: `leave`, `arrive` (first site), `depart` (last site), `return`, each
`{ at, source }` with source `self` | `leader` | `site` | null, plus `travelOutMin`
(leave→arrive), `travelBackMin` (depart→return), `workMin`, `flag` (true when a point fell back
to the site time or work time is incomplete), `tapsMade`, `tapsExpected`
(assembly: 2 + 2×sites; otherwise 2×sites). Leader = another worker with
`is_team_leader` at the worker's first site (leave) / last site (return) that date. Monthly
summary: `daysWorked` (dates with a site assignment or a tap), `tapsMade`, `tapsExpected`, `%`.

HR › 🕐 tab gets a per-day table (worker, 4 points with "ตามหัวหน้าทีม"/red tags, travel,
work time, OT) and the monthly summary table; the raw log stays below.

## Payroll / OT (documented behaviour)

Today `summarizeAttendance` sums `worker_assignments.ot_hours` (site rows) + `worker_ot.ot_hours`
(admin-typed or the "auto จากเช็คเอาท์" row) into `otHours`; `calc.js` pays
`otHours × rate / 8 × multiplier`.

With `ot_from_checkin = 'true'`: for every worker-date whose work time is known (both ends,
filled values included), OT for that date = max(0, workMin − standard×60)/60, standard =
`checkin_standard_day_hours` (default 8, ×0.5 for a one-shift day), rounded to 2 decimals.
That value REPLACES the assignment/worker_ot OT of that date (no double counting); dates
without a work time keep the manual OT. Off (default) → payroll is byte-for-byte unchanged.

## Not changed

Single-site / multi-site / office location check-in when assembly is off; the existing
RPCs; auto-OT on web checkout; AttendanceGrid.

## Known limits

- An office admin whose assembly location is the same office row and who does an office
  check-in the same day collides with the one-row-per-location key: the assembly tap is
  refused with a message instead of overwriting the office row.
- Return tap requires the last site to be checked out (one open check-in at a time).

## Review fixes (2026-10-21)

1. The office location RPCs (`perform_location_checkin/checkout` and their `_by_id` twins) are re-issued in this migration, with bodies copied from 2026-10-20-05 and 2026-10-21-01. When today's row at that location is an assembly row they refuse with "วันนี้ตำแหน่งนี้เป็นจุดรวมพลของคุณแล้ว…". The conflict update and the checkout update also skip assembly rows (`not is_assembly`). The dry run checks this in case (i).
2. Second GPS skip: when the expected step is `site_arrive` but the worker is inside the assembly radius (a site was skipped that day), the page records `assembly_return`.
3. OT = (กลับถึงโรงงาน − ออกจากโรงงาน − พัก) − ชั่วโมงทำงานปกติ. The break comes from `checkin_break_minutes` (default 60). For a one-shift day both the break and the standard are halved. The formula is shown next to the switch.
4. Check-in OT applies only on a date that has a counted site shift: type site, and confirmed when confirmation is required. On every other date the typed OT stays.
5. On an assembly day, `flag` is set when leave or return is still missing after every fallback. A flagged (red) day pays no check-in OT; that date keeps its typed OT, which is how an admin fixes it.
6. Factory work never says "ถึงไซท์". The page and the LINE reply use the work-place name, for example "ถึงโรงงาน (ส่วนกลาง) — งานX".
