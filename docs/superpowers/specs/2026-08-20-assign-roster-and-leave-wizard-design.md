# Assign Roster Visibility + Leave in the Assign Wizard — Design Spec

## Overview

Two independent fixes to FacadeXPM's Assign (ช่าง scheduling) system, bundled into one spec because they touch overlapping files (`src/pages/assign/`, `src/pages/HR.jsx`) but don't depend on each other and can ship separately if needed.

**A. Roster visibility toggle.** Today every `status='active'` worker automatically appears in every Assign screen's roster (the day-grid, both wizards, the OT wizard). Not every HR employee needs day-to-day site scheduling — office staff, management, etc. clutter the picker. Add a per-worker toggle, settable from HR, that hides a worker from the Assign roster without touching their HR record or any of their existing assignment history.

**B. Leave options in the main Assign wizard.** The primary "+ Assign งาน" bulk-entry flow (`AssignWizard.jsx`) only offers งานไซท์/ผลิตที่โรงงาน as work types and mandates picking a site. ลาป่วย/ลากิจ (sick/personal leave) already exist as assignable types, but only through the less-visible single-cell edit popup (`CellEditPopup.jsx`). Add them to the main wizard too, matching how `CellEditPopup` already treats them (no site required).

## Part A: Roster Visibility Toggle

### Goals

- ADMIN+ can mark a worker as "not shown in the Assign roster" from HR's existing add/edit worker form — no new page.
- Every existing worker keeps appearing exactly as today when this ships (explicit user decision: default `true`/shown, not an opt-in that would silently empty everyone's roster on deploy).
- Un-ticking the toggle is purely a display filter on the picker. It never deletes, archives, or otherwise touches that worker's existing `worker_assignments` rows — those keep rendering wherever they're already stored (explicit user correction: "ถ้ามีข้อมูลอยู่แล้ว ไป tick ออกไม่ต้องลบ ให้ใช้ซ่อนแทน" — if there's already data, unticking must hide, not delete).
- `MySchedule.jsx` (a worker's own self-service schedule view, keyed off their logged-in email matching `workers.email`) is completely unaffected by this flag — a worker hidden from the admin-facing roster still sees and manages their own schedule normally (explicit user decision).

### Non-Goals

- No separate "roster management" screen — the toggle lives on the existing per-worker form in HR, per explicit user choice.
- No cascading behavior on existing `worker_assignments`/`ot_assignments` rows — this flag only affects which workers appear in the *picker* UI going forward.
- No change to `useWorkers()`'s existing `status='active'` filter — this is an additional filter alongside it, not a replacement. A worker must be both `status='active'` AND `show_in_assign=true` to appear in Assign; an inactive worker (already excluded today) stays excluded regardless of this new flag.

### Design

**1. Schema.** `ALTER TABLE workers ADD COLUMN show_in_assign BOOLEAN NOT NULL DEFAULT true;`. `workers_with_rate` (the view `useWorkers()` actually queries — confirmed by reading `supabase/schema.sql`, this view has an explicit column list, not `SELECT *`) must be updated in the same migration to include `show_in_assign` in its `SELECT` list, or the new column would be invisible to every consumer of `useWorkers()` despite existing on the base table. `WITH (security_invoker = true)` must be preserved on the re-created view (this codebase's hard rule — a prior real cross-tenant leak came from a view that dropped this).

**2. Query filter.** `useWorkers()` (`src/hooks/useSupabase.js`) adds `.eq('show_in_assign', true)` alongside its existing `.eq('status', 'active')`. Since every Assign-facing screen (`GridView.jsx`, `AssignWizard.jsx`, `AssignOTWizard.jsx`, the day view) already consumes this one shared hook, this single change propagates everywhere without touching those files individually. `MySchedule.jsx` calls the same `useWorkers()` hook today but only to find "me" by matching `email` (`(workers || []).find(w => w.email === user?.email)`) — since that lookup only needs the logged-in user's own row (which is `show_in_assign`-filtered along with everyone else's), this needs a small carve-out: `MySchedule.jsx` must use a variant that does NOT apply the `show_in_assign` filter, so a worker hidden from the admin roster can still find their own record. The cleanest way: add a second export, `useAllActiveWorkers()` (status-only filter, no `show_in_assign` filter), and switch `MySchedule.jsx` to call that instead of `useWorkers()`. Every other consumer keeps calling `useWorkers()` unchanged.

**3. HR form.** `WorkerForm` in `src/pages/HR.jsx` gains a checkbox in its "สถานะ" area (next to the existing `status` select), labeled "แสดงในตาราง Assign" (shown in the Assign roster), bound to `form.show_in_assign`. `EMPTY_WORKER` gets `show_in_assign: true` added. `handleSaveWorker`'s payload gains `show_in_assign: form.show_in_assign`.

## Part B: Leave Options in the Assign Wizard

### Goals

- `AssignWizard.jsx`'s type-picker (currently งานไซท์/ผลิตที่โรงงาน only) gains ลาป่วย/ลากิจ as two more type buttons, matching `CellEditPopup.jsx`'s existing `TYPE_OPTS` labels/emoji exactly (🤒 ลาป่วย, 🏖️ ลากิจ) for consistency between the two entry points.
- Selecting a leave type skips the site-selection step entirely — leave doesn't have a site (explicit user decision, matching `CellEditPopup`'s existing `needsSite = SITE_TYPES.includes(form.type)` logic, where `SITE_TYPES = ['site', 'factory']` already excludes leave types).

### Non-Goals

- No change to `CellEditPopup.jsx` itself — it already handles these two types correctly; this only extends the *other* entry point (the bulk wizard) to match it.
- No new leave-specific fields (no reason/half-day/approval workflow) — this only lets the bulk wizard write the same `{worker_id, date, shift, site_id: null, type}` shape `CellEditPopup` already writes for a leave row, just for multiple workers/days at once instead of one cell at a time.

### Design

**1. Type picker.** `AssignWizard.jsx`'s step-2 button row extends from `[{k:'site',...}, {k:'factory',...}]` to include `{k:'leave_sick', l:'🤒 ลาป่วย'}` and `{k:'leave_personal', l:'🏖️ ลากิจ'}` (four buttons total, same row).

**2. Conditional site step.** Step 3 ("3 · ไซท์งาน") only renders when `SITE_TYPES.includes(form.type)` (`SITE_TYPES` imported from `./constants.js`, the same constant `CellEditPopup.jsx` already imports for identical purpose) — when a leave type is selected, this whole step disappears from the wizard, and the step numbering shifts down by one visually (a small copy change to keep "4 · ช่าง"/"5 · รายละเอียด" as "3 · ช่าง"/"4 · รายละเอียด" when the site step is hidden — the labels are just static strings, no functional impact, so this can be a straightforward conditional label change, not a big renumbering system).

**3. Submit validation.** The existing `submit()` guard `if (!form.siteId) return alert('เลือกไซท์งาน')` must become conditional: only required when `SITE_TYPES.includes(form.type)`. The row-building loop's `site_id: form.siteId` becomes `site_id: SITE_TYPES.includes(form.type) ? form.siteId : null`, matching `CellEditPopup`'s `site_id: needsSite ? form.siteId : null` exactly.

## Testing

- No new pure-logic function beyond the `SITE_TYPES.includes(form.type)` conditional (already an existing, already-used constant/pattern from `CellEditPopup.jsx`) — verification is `npm test`/`npm run build` regression plus a documented, disclosed manual-browser-check limitation (no test login credentials available to implementer/reviewer subagents this session, consistent with every other UI feature built this session).
- Manual verification checklist for Part A: unticking a worker's "แสดงในตาราง Assign" in HR removes them from the Assign grid/wizards' worker pickers on next load, without deleting their existing assignment history (spot-check by re-ticking and confirming past assignments are still intact); that same worker's own `MySchedule.jsx` view is unaffected the whole time.
- Manual verification checklist for Part B: selecting ลาป่วย/ลากิจ in the main wizard hides the site-selection step and successfully submits a leave assignment for multiple workers/days at once; the resulting rows show up correctly in the day grid the same way a `CellEditPopup`-created leave row does today.
