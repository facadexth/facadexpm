# Gantt Subtask Hierarchy — Design Spec

## Problem

Today the Gantt/Kanban feature has two levels: **Phase** (Gantt row, dated,
billed) and **Kanban card** (day-to-day microtask, assigned to workers,
no dates of its own beyond an optional due date). Everything a phase
breaks into lands directly on the Kanban board.

The user's own mental model draws a line the current schema doesn't:

- **Subtask** — a real chunk of scheduled work with its own start/end
  dates and its own slice of the phase's billing weight (e.g. "ตัดวัสดุ
  ชั้น 3" running 2026-03-15 → 2026-03-22). Belongs on the **Gantt**
  timeline, as its own row, nested under its phase.
- **Microtask** — day-to-day, no independent schedule of its own,
  assigned to specific workers, tracked as a Kanban card (checklist-style
  work). Belongs on the **Kanban** board.

Today, what the Kanban board calls a "task" is really doing double duty as
both of these. This spec introduces Subtask as a real third level between
Phase and Kanban card, and re-parents Kanban cards under it.

```
Site → Phase (Gantt row, billed)
         → Subtask (Gantt row, nested, billed)
             → Microtask (Kanban card, assigned to workers)
```

A secondary, related problem this spec also resolves: the S-curve's plan
line currently jumps the phase's entire billing weight in one lump at the
phase's `end_date` (a staircase), instead of climbing progressively across
the phase's dated span. Once Subtask carries its own dates + billing
weight, the natural fix is to ramp the plan line across each *subtask's*
own start→end window — finer-grained and more accurate than ramping at
the phase level would have been.

## Data Model

### New table: `phase_subtasks`

Mirrors `site_phases` closely (same shape, same RLS pattern, scoped one
level deeper):

| column | type | notes |
|---|---|---|
| `id` | uuid | PK |
| `phase_id` | uuid | FK → `site_phases.id` |
| `site_id` | uuid | denormalized, same pattern as `phase_tasks.site_id` today |
| `tenant_id` | uuid | denormalized, flat RLS scoping (matches `site_phases`/`phase_tasks`) |
| `name` | text | required |
| `start_date` | date | nullable until set |
| `end_date` | date | nullable until set |
| `billing_weight_pct` | numeric | see "Billing roll-up" below |
| `status` | text | `not_started` / `in_progress` / `done` — manual value, overridden by roll-up once the subtask has ≥1 microtask (same pattern `site_phases.status` uses today) |
| `depends_on_subtask_id` | uuid | FK → another `phase_subtasks.id`, **same-phase only** (no cross-phase subtask dependencies in this spec) |
| `sort_order` | integer | ordering within the phase |
| `created_at` / `updated_at` | timestamptz | |

RLS: same four policies as `site_phases` (`admin_reads`/`admin_inserts`/
`admin_updates`/`admin_deletes`), flat `tenant_id = current_tenant_id()`
scoping — no join needed, matching the existing pattern for tables that
carry their own `tenant_id`.

### Changed table: `phase_tasks` (Kanban microtasks)

Add `subtask_id uuid NOT NULL REFERENCES phase_subtasks(id)`. Keep the
existing `phase_id` column as-is (denormalized, kept in sync with the
owning subtask's `phase_id` at write time) — every existing query, RLS
policy, and hook that filters `phase_tasks` by `phase_id` keeps working
unchanged; `subtask_id` is purely additive.

### Migration for existing data

For every phase that currently has ≥1 `phase_tasks` row, auto-create one
default subtask to hold them (e.g. named `"งานทั่วไป"`, dates copied from
the phase's own `start_date`/`end_date`, `billing_weight_pct` = the
phase's current full weight), then backfill `phase_tasks.subtask_id` to
point at it. Nothing is lost or orphaned; users can split further into
separate subtasks manually afterward. Phases with zero existing
`phase_tasks` get no default subtask — they simply have none yet, same as
today.

## Roll-up & Derivation

Reuses the derive-if-children-exist pattern already shipped for
Phase ← Kanban-card this session (`phaseTasksCalc.js`), generalized to
apply at both levels:

- **Subtask status** ← derived from its own microtasks (done/total), via
  the same `computePhaseTaskStats`-shaped function. Falls back to its own
  manually-set `status` field when it has zero microtasks.
- **Phase status** ← derived from its subtasks' statuses (done/total
  subtasks), via the same function one level up. Falls back to its own
  manually-set `status` field when it has zero subtasks — this is what
  keeps every phase on every site that never adopts subtasks working
  exactly as it does today, unchanged.
- **Phase `billing_weight_pct`** becomes **read-only, computed as the sum
  of its subtasks' `billing_weight_pct`**, the moment a phase has ≥1
  subtask. The input field in the phase edit panel switches from an
  editable number input to a computed, non-editable display in that case
  (mirrors how the phase's "สถานะ" field already switches from a
  `<select>` to a computed line once it has ≥1 Kanban card, today).
  Phases with zero subtasks keep the field fully editable, unchanged.
- **Overflow rule**: adding/editing a subtask whose `billing_weight_pct`
  would push its phase's subtask-sum over 100% is a **hard block** — the
  save is refused with an inline error, not merely a warning. (Decided:
  differs from this app's usual "warn, don't block" convention, because
  here the phase's own billing % is *derived* from this sum and directly
  feeds the S-curve's plan total — letting it silently exceed 100%
  would make the site's total contract billing plan internally
  inconsistent, not just cosmetically off.)

## Gantt UI

- Each phase row gets an expand/collapse affordance. **Clicking the
  phase's bar itself** (not a separate chevron icon) toggles expansion
  when the phase has ≥1 subtask — bars with zero subtasks are not
  clickable-to-expand (nothing to show).
- Expanding a phase reveals its subtasks as their own rows, indented,
  directly underneath — same visual language as phase rows today (bar,
  status color, ✎ edit affordance, dates), just nested one level and at
  a slightly smaller scale (matches the existing `ROW_H`/`EDIT_H`
  pattern, with a `SUBTASK_ROW_H` a bit shorter).
- **Clicking a subtask's bar** (a leaf — subtasks don't nest further)
  navigates to the Kanban tab, pre-filtered to that subtask's board.
  This is the "smallest subtask leads to Kanban" behavior — Kanban is
  never reached by clicking a *phase* bar, only a *subtask* bar.
- Dependency arrows, the vertical grid, and the today-line all reuse the
  exact `trackLeft`/`trackRight` shared-geometry constants introduced in
  this session's alignment fix (commit `40af6c2`) — subtask rows are laid
  out in the *same* coordinate space as phase rows, so they can never
  drift out of alignment with each other the way the header/arrows/bars
  briefly did before that fix.
- Subtask-to-subtask dependency arrows (via `depends_on_subtask_id`) use
  the same elbow-routed, thicker-stroke rendering as phase-to-phase
  arrows, restricted to arrows between subtasks of the *same expanded
  phase* (a subtask row's `y` position only exists while its parent phase
  is expanded).

## Kanban UI

The phase chip row gains a second tier: selecting a phase reveals a
second row of chips for that phase's subtasks (plus the existing
"🗂 ทั้งหมด" behavior, now grouping by phase → subtask instead of just
phase). Clicking a subtask's Gantt bar (see above) jumps directly to this
second-tier chip already selected, rather than requiring a second manual
click.

## S-curve

`buildPlanSeries` switches from iterating `phases` to iterating
**subtasks flattened across all phases** of the site, ramping linearly
across each subtask's own `start_date → end_date` window using its own
`billing_weight_pct` (contract_value-scaled), instead of jumping the
phase's full weight in one lump at the phase's `end_date`. A phase with
zero subtasks falls back to ramping across the *phase's own* dates using
the phase's own (still-editable, in that case) `billing_weight_pct` —
this is what keeps sites that never adopt subtasks producing the same
S-curve shape as before, unchanged, rather than reverting to a flat
staircase for them specifically.

## Out of scope for this spec

- Cross-phase subtask dependencies (`depends_on_subtask_id` is same-phase
  only).
- Any change to who can edit (`canEdit` / ADMIN+ gate) — subtasks and
  their microtasks follow the exact same permission model phases and
  Kanban cards already use today.
- Reworking the existing Kanban card UI itself (assignees, 👑 team lead,
  drag-across-columns) — unchanged, just re-parented from phase to
  subtask.
