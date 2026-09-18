# Gantt Subtask Hierarchy — Design Spec

## Problem

Today the Gantt/Kanban feature has two levels: **Phase** (Gantt row, dated,
billed) and **Kanban card** (day-to-day microtask, assigned to workers,
no dates of its own beyond an optional due date). Everything a phase
breaks into lands directly on the Kanban board.

The user's own mental model draws a line the current schema doesn't:

- **Subtask** — a real chunk of scheduled work with its own start/end
  dates and its own slice of its parent's billing weight (e.g. "ตัดวัสดุ
  ชั้น 3" running 2026-03-15 → 2026-03-22). Belongs on the **Gantt**
  timeline, as its own row, nested under its parent. **Subtasks can nest
  arbitrarily deep** — a subtask can itself be broken into subtasks, and
  so on (confirmed: "subtask มีหลายชั้นได้").
- **Microtask** — day-to-day, no independent schedule of its own,
  assigned to specific workers, tracked as a Kanban card (checklist-style
  work). Belongs on the **Kanban** board, and only ever attaches to a
  **leaf** node (a phase or subtask with no children of its own).

Today, what the Kanban board calls a "task" is really doing double duty as
both of these. This spec introduces Subtask as a real, recursively
nestable level between Phase and Kanban card, and re-parents Kanban cards
under whichever node ends up being the leaf.

```
Site → Phase (Gantt row, billed)
         → Subtask (Gantt row, nested, billed)
             → Subtask (nested further, same shape)
                 → ... (arbitrary depth)
                     → Microtask (Kanban card, assigned to workers)
                       -- only at a LEAF node (no child subtasks)
```

A secondary, related problem this spec also resolves: the S-curve's plan
line currently jumps the phase's entire billing weight in one lump at the
phase's `end_date` (a staircase), instead of climbing progressively across
the phase's dated span. Once Subtask carries its own dates + billing
weight, the natural fix is to ramp the plan line across each **leaf**
node's own start→end window — finer-grained and more accurate than
ramping at the phase level would have been.

## Data Model

### New table: `phase_subtasks`

A single, **self-referencing** table holds every subtask at every depth —
depth isn't a schema-level concept, it falls out of `parent_subtask_id`
chains. Shape mirrors `site_phases` closely:

| column | type | notes |
|---|---|---|
| `id` | uuid | PK |
| `phase_id` | uuid | FK → `site_phases.id` — the ultimate top-level phase this subtask belongs to, **denormalized down the whole chain** (every subtask at any depth carries its ancestor phase's id directly, not just its immediate parent), so queries/RLS never need a recursive walk to answer "which phase is this under" |
| `parent_subtask_id` | uuid, nullable | FK → another `phase_subtasks.id`. **NULL** = this subtask is a direct child of `phase_id` (depth 1). **Non-null** = this subtask is nested under another subtask (depth 2+) |
| `site_id` | uuid | denormalized, same pattern as `phase_tasks.site_id` today |
| `tenant_id` | uuid | denormalized, flat RLS scoping (matches `site_phases`/`phase_tasks`) |
| `name` | text | required |
| `start_date` | date | nullable until set |
| `end_date` | date | nullable until set |
| `billing_weight_pct` | numeric | see "Billing roll-up" below |
| `status` | text | `not_started` / `in_progress` / `done` — manual value, overridden by roll-up once this subtask has ≥1 child subtask or ≥1 microtask (same pattern `site_phases.status` uses today) |
| `depends_on_subtask_id` | uuid | FK → another `phase_subtasks.id`, **siblings only** — both subtasks must share the same `parent_subtask_id` (or both be NULL, i.e. both direct children of the same phase). No cross-branch dependencies in this spec |
| `sort_order` | integer | ordering among siblings |
| `created_at` / `updated_at` | timestamptz | |

RLS: same four policies as `site_phases` (`admin_reads`/`admin_inserts`/
`admin_updates`/`admin_deletes`), flat `tenant_id = current_tenant_id()`
scoping — no join needed, matching the existing pattern for tables that
carry their own `tenant_id`. `parent_subtask_id` needs no special RLS
handling since every row is already tenant-scoped directly.

### Changed table: `phase_tasks` (Kanban microtasks)

Add `subtask_id uuid REFERENCES phase_subtasks(id)` **nullable**. A
microtask attaches to *either* a phase directly (`phase_id` set,
`subtask_id` null — a phase with no subtasks, exactly like today) *or* a
leaf subtask (`subtask_id` set, pointing at whichever `phase_subtasks` row
is the actual leaf — its own `phase_id` column, already denormalized down
the chain, is copied across so `phase_tasks.phase_id` keeps meaning "which
top-level phase," unchanged). Every existing query, RLS policy, and hook
that filters `phase_tasks` by `phase_id` keeps working unchanged;
`subtask_id` is purely additive and app logic enforces "microtasks only
attach to a leaf" (a subtask that gains its first child subtask must have
its existing microtasks, if any, refused/blocked at the UI level — see
Open Question below).

### Migration for existing data

For every phase that currently has ≥1 `phase_tasks` row, those rows keep
`subtask_id = NULL` and stay attached directly to the phase — the phase
itself is already a valid leaf (it has microtasks and, at migration time,
no subtasks). No default subtask is fabricated; nothing moves. A user who
later wants to break that phase into real subtasks does so explicitly
(see Open Question below for what happens to the existing microtasks at
that point).

## Roll-up & Derivation

Reuses the derive-if-children-exist pattern already shipped for
Phase ← Kanban-card this session (`phaseTasksCalc.js`), generalized to
apply recursively at every level of the tree, phase included:

- **A node's status** (phase, or subtask at any depth) ←
  - if it has ≥1 child subtask: derived from those children's statuses
    (done/total), via the same `computePhaseTaskStats`-shaped function,
    generalized to take "children" (subtasks) instead of always meaning
    "microtasks."
  - else if it has ≥1 microtask: derived from those microtasks (today's
    existing behavior, unchanged).
  - else: its own manually-set `status` field.
- **A node's `billing_weight_pct`** becomes **read-only, computed as the
  sum of its child subtasks' `billing_weight_pct`**, the moment it has
  ≥1 child subtask, recursively — a phase's weight is the sum of its
  direct children's weights, whatever those children's own weights
  resolved to (each possibly itself a sum, if it has grandchildren). A
  node with zero child subtasks keeps its `billing_weight_pct` directly
  editable (a leaf still bills, same as a phase with no subtasks does
  today).
- **Overflow rule**: adding/editing a subtask whose `billing_weight_pct`
  would push its **parent's** children-sum over 100% is a **hard block**
  — the save is refused with an inline error, not merely a warning, at
  *every* level (a phase's direct children must sum to ≤100%, and so must
  any subtask's own children). Decided: differs from this app's usual
  "warn, don't block" convention, because a node's billing % is *derived*
  from this sum and directly feeds the S-curve's plan total — letting it
  silently exceed 100% anywhere in the tree would make the site's total
  contract billing plan internally inconsistent, not just cosmetically
  off.

## Gantt UI

- Every row (phase or subtask) that has ≥1 child subtask gets an
  expand/collapse affordance: **clicking the bar itself** (not a separate
  chevron icon) toggles showing/hiding its children. Rows with zero
  children are not clickable-to-expand.
- Expanding a row reveals its children as their own rows, indented one
  level deeper than their parent, directly underneath — same visual
  language as phase rows today (bar, status color, ✎ edit affordance,
  dates), recursively (a subtask's own children indent one level deeper
  still). Indentation depth is visual only — the underlying row layout
  reuses the exact `trackLeft`/`trackRight` shared-geometry constants
  introduced in this session's alignment fix (commit `40af6c2`) at every
  depth, only the **label column**'s text gets progressively indented; the
  bar track itself stays pinned to the same `trackLeft` regardless of
  depth, so bars at every depth stay comparable/aligned against the same
  time axis.
- **Clicking a leaf row's bar** (a phase or subtask with zero children)
  navigates to the Kanban tab, pre-filtered to that leaf's board. This is
  the "smallest subtask leads to Kanban" behavior generalized: Kanban is
  reached by clicking whichever bar is currently a leaf, at whatever
  depth that happens to be — never a row that still has children to
  expand into first.
- Dependency arrows and the vertical grid reuse the same shared-geometry
  constants as above, so they can't drift out of alignment with rows at
  any depth.
- Sibling dependency arrows (via `depends_on_subtask_id`) use the same
  elbow-routed, thicker-stroke rendering as phase-to-phase arrows,
  restricted to arrows between two rows that are both currently visible
  (both siblings' rows only exist on-screen while their shared parent is
  expanded).

### Adding a subtask: unified entry point

The existing **"+ เพิ่มขั้นตอน"** button becomes the single entry point
for creating a new item at *any* level — a brand-new top-level phase, or
a subtask nested under an existing phase/subtask at any depth:

1. Clicking "+ เพิ่มขั้นตอน" opens the same inline add-form used today,
   with one new first field: **"เพิ่มภายใต้"** (add under), a picker
   listing every currently-visible row — every phase, plus every subtask
   whose parent chain is currently expanded — defaulting to **"— ไม่มี
   (ขั้นตอนใหม่ระดับบนสุด) —"** (top-level phase, today's existing
   behavior, unchanged) when nothing is selected.
2. If the user selects an existing phase or subtask as the parent here,
   the new item being created is automatically a subtask of it (no
   separate "is this a subtask?" toggle needed — selecting a parent *is*
   the decision). Its `phase_id` is copied from the selected parent
   (itself, if a phase was picked; the parent's own `phase_id` if a
   subtask was picked), and its `parent_subtask_id` is set to the
   selected subtask's id (or left null if a phase was picked).
3. A "+" affordance next to each expanded row (phase or subtask) offers
   the same form pre-filled with that row already selected as the
   parent — a shortcut into the same flow, not a separate mechanism.

## Kanban UI

The phase chip row gains further tiers as needed: selecting a phase whose
children are subtasks reveals a second row of chips for those subtasks;
selecting a subtask that itself has children reveals a third row, and so
on, until a leaf is reached and its board renders (plus the existing
"🗂 ทั้งหมด" behavior, now grouping by the full chain down to each leaf
instead of just by phase). Clicking a leaf's Gantt bar (see above) jumps
directly to its chip chain already selected, rather than requiring manual
clicks through each tier.

## S-curve

`buildPlanSeries` switches from iterating `phases` to iterating **every
leaf node flattened across the whole tree** (a phase counts as a leaf
when it has zero subtasks, exactly as it does today), ramping linearly
across each leaf's own `start_date → end_date` window using its own
`billing_weight_pct` (contract_value-scaled), instead of jumping a
phase's full weight in one lump at the phase's `end_date`. A site that
never adopts subtasks at all has every phase as a leaf, reproducing
today's per-phase behavior unchanged — only sites that actually use
subtasks get the finer-grained ramp, and the deeper the tree goes, the
finer it gets automatically (no extra work needed to "support" deeper
nesting here — flattening to leaves handles any depth uniformly).

## Resolved: a leaf's existing microtasks when it gains its first child

**Decided:** when a phase or subtask that already has microtasks
("board contained") gets its first child subtask added under it, its
existing microtasks do **not** move into the subtask the user is actively
creating (that one stays clean — the user is naming it for new, unrelated
work). Instead, the app **auto-creates a second, sibling subtask named
"Kanban เก่า"** ("old Kanban") in the same write, and moves the node's
existing microtasks there (`subtask_id` repointed to this auto-created
subtask; `phase_id` unchanged). Dates/billing % on "Kanban เก่า" start
blank/zero — it's a holding pen, not a scheduled chunk of work — editable
afterward like any other subtask if the user wants to give it real dates.

So one user action (adding the first real subtask under a node that had
microtasks) produces two new subtask rows: the one the user named, empty;
and "Kanban เก่า", holding everything that node used to have directly.
Nothing is blocked or deleted, and the user's new subtask never starts
out cluttered with unrelated old cards.

This only fires the **first** time a formerly-microtask-holding node
gains a child — every subsequent "add another subtask here" goes through
the normal empty-subtask path, since by then the node's own microtasks
have already moved to "Kanban เก่า" and it holds none directly any more.

## Out of scope for this spec

- Cross-branch subtask dependencies (`depends_on_subtask_id` is
  siblings-only, at every depth).
- Any change to who can edit (`canEdit` / ADMIN+ gate) — subtasks and
  their microtasks follow the exact same permission model phases and
  Kanban cards already use today.
- Reworking the existing Kanban card UI itself (assignees, 👑 team lead,
  drag-across-columns) — unchanged, just re-parented from phase to
  whichever leaf owns it.
- A cap on nesting depth — none is imposed; arbitrarily deep trees are
  allowed, per "subtask มีหลายชั้นได้."
