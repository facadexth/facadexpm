# Site Kanban + Day View + Worker Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build screens 2-4 of the Gantt+Kanban mockup on top of the already-shipped Gantt tab (screen 1): a per-site Kanban board for phase tasks, an addition to the admin Day View showing today's active-phase mini task board per site, and an addition to the worker's own dashboard showing their assigned tasks today plus a team-today roster.

**Architecture:** Two new tables (`phase_tasks`, `phase_task_workers`) hold Kanban cards and their (0..N) assignees. A phase's Gantt display status becomes computed from its own tasks once it has any (falling back to the existing manually-set `site_phases.status` for phases with none). Three existing pages each get an additive UI piece reading/writing this same data: `SiteDetail.jsx` gains a 3rd "Kanban" tab, `DayView.jsx` gains a per-site mini-board section, `MySchedule.jsx` gains a team roster + personal task list. No new dependencies — drag-and-drop uses native HTML5 `draggable`, with click-to-open-editor as the universal (including touch) fallback for moving a card.

**Tech Stack:** React 18 + Vite, Supabase JS (`supabase.from(...)`, `.rpc(...)`), existing `useQuery`/`fetchAllRows` hook pattern in `src/hooks/useSupabase.js`, Vitest for pure-logic unit tests (no component-testing library in this repo — UI changes are verified live in the browser, matching how the Gantt tab itself was verified).

**Spec:** [`docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md`](../specs/2026-09-17-site-gantt-kanban-design.md)

## Global Constraints

- No new npm dependencies. Drag-and-drop is native HTML5 (`draggable`, `onDragStart`/`onDragOver`/`onDrop`); every drag interaction has a non-drag equivalent (click-to-open-editor) since HTML5 drag does not work on touch.
- Task status values are exactly `'not_started' | 'in_progress' | 'done'` everywhere (`phase_tasks.status`, matches `site_phases.status` and `ganttTimeline.js`'s `STATUS_COLOR` keys) — never introduce a different vocabulary (e.g. `'todo'/'doing'`).
- `zone` is free text (no `zones` table, no dropdown of predefined values beyond "distinct values already used on this phase's tasks").
- RLS is the real security boundary; `canEditPage()` / `isAtLeast('ADMIN')` are UI-only conveniences on top of it, matching this codebase's stated policy in `src/lib/permissions.js`'s header comment. Every new write policy must be tenant-scoped (`tenant_id = current_tenant_id()`) and gated by `tenant_can_write()` on top of the role/ownership check, matching every existing table's policy shape (see `supabase/migrations/2026-08-16-09-tenant-scoped-rls-core.sql`).
- A worker can update `phase_tasks.status` only on tasks they are an assignee of, enforced at the RLS row level (not just hidden in the UI) — mirrors the existing `worker_reads_own` pattern on `worker_assignments`/`worker_ot`/`salary_records` (`supabase/migrations/2026-08-16-05-security-advisor-fixes.sql`). A worker never has a path to change `name`/`zone`/`due_date`/assignees on any task — the app UI simply never exposes those controls to them, and RLS ownership scoping means a crafted API call could still only touch their own tasks.
- Worker-facing site-name/teammate lookups go through a `SECURITY DEFINER` RPC function scoped to `auth.email()`, exactly like the existing `get_my_site_names()` (`supabase/migrations/2026-09-03-09-worker-safe-site-names.sql`) — never add a direct WORKER SELECT policy on `sites` or on other workers' `worker_assignments` rows (would leak financial columns / other people's schedules).
- New pure-logic modules get colocated Vitest tests (`<name>.test.js` next to `<name>.js`) — this raises the bar slightly above `ganttTimeline.js`/`scurveCalc.js` (which relied on hand-verified worked examples in comments), which is appropriate since Vitest is already set up and used for 163 passing tests under `src/lib/`.
- Every task's UI changes must be verified live in the browser (build, `npm test`, then a real click-through with a console-error check) before being considered done — no claiming success from code review alone.
- Match the app's established style: Thai UI copy, inline styles (no CSS framework), `var(--token)` colors, `.card`/`.btn*`/`.input`/`.select` existing classes, literal hex colors (not `var()`) only inside SVG presentation attributes.

---

### Task 1: Data layer — migration, hooks, pure logic

**Files:**
- Create: `supabase/migrations/2026-09-17-03-add-phase-tasks.sql`
- Modify: `src/hooks/useSupabase.js` (add `usePhaseTasks()`, `useMyTeamToday()`)
- Create: `src/pages/sites/phaseTasksCalc.js`
- Create: `src/pages/sites/phaseTasksCalc.test.js`

**Interfaces:**
- Produces: DB tables `phase_tasks` (`id, phase_id, site_id, tenant_id, name, zone, status, due_date, sort_order, created_at, updated_at`) and `phase_task_workers` (`task_id, worker_id`), with RLS as specified below.
- Produces: DB function `get_my_team_today()` (extends the existing worker-safe-lookup pattern) and an extended `get_my_site_names()` that also covers sites reached only via a Kanban task assignment.
- Produces: `usePhaseTasks()` → `{ data, loading, error, refetch }`, `data` is an array of task rows each carrying a nested `phase_task_workers: [{ worker_id }]`.
- Produces: `useMyTeamToday()` → `{ data, loading, error, refetch }`, `data` is an array of `{ id, name, nickname }` for every worker (including the caller) assigned to the same site(s) as the caller today.
- Produces: `computePhaseTaskStats(tasks) → { total, done, pct, derivedStatus }`, `pickActivePhase(phases, tasksByPhaseId) → phase | null`, `isTaskOverdue(task, todayISO) → boolean` from `phaseTasksCalc.js`. Tasks 2-5 all consume these.

- [ ] **Step 1: Write the migration**

Create `supabase/migrations/2026-09-17-03-add-phase-tasks.sql`:

```sql
-- supabase/migrations/2026-09-17-03-add-phase-tasks.sql
--
-- Kanban task board for site phases (spec:
-- docs/superpowers/specs/2026-09-17-site-gantt-kanban-design.md).
-- phase_tasks = one Kanban card. phase_task_workers = many-to-many
-- assignees (0, 1, or many workers per card). A phase's Gantt status
-- becomes derived from its tasks once it has >=1 row here -- see
-- src/pages/sites/phaseTasksCalc.js -- the site_phases.status column
-- and its existing manual editor are untouched and still used as the
-- fallback for phases with zero tasks.

CREATE TABLE phase_tasks (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id    UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  site_id     UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id   UUID NOT NULL,
  name        TEXT NOT NULL,
  zone        TEXT,
  status      TEXT NOT NULL DEFAULT 'not_started'
              CHECK (status IN ('not_started','in_progress','done')),
  due_date    DATE,
  sort_order  INT NOT NULL DEFAULT 0,
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  updated_at  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_phase_tasks_phase_id ON phase_tasks(phase_id);
CREATE INDEX idx_phase_tasks_site_id ON phase_tasks(site_id);

CREATE TABLE phase_task_workers (
  task_id   UUID NOT NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  worker_id UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, worker_id)
);

CREATE INDEX idx_phase_task_workers_worker_id ON phase_task_workers(worker_id);

ALTER TABLE phase_tasks ENABLE ROW LEVEL SECURITY;
ALTER TABLE phase_task_workers ENABLE ROW LEVEL SECURITY;

-- phase_tasks: ADMIN/OWNER full access (tenant-scoped, same shape as
-- site_phases' own policies) + a worker can read/update ONLY tasks
-- they're an assignee of. Row-level only (no column-level GRANT,
-- matching this codebase's existing worker_assignments precedent) --
-- the app UI is what limits a worker's edit form to status alone.
CREATE POLICY admin_reads ON phase_tasks FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON phase_tasks FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON phase_tasks FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON phase_tasks FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY worker_reads_own ON phase_tasks FOR SELECT TO authenticated
  USING (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ));
CREATE POLICY worker_updates_own ON phase_tasks FOR UPDATE TO authenticated
  USING (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write())
  WITH CHECK (id IN (
    SELECT ptw.task_id FROM phase_task_workers ptw
    JOIN workers w ON w.id = ptw.worker_id
    WHERE w.email = (select auth.email())
  ) AND tenant_can_write());

-- phase_task_workers: ADMIN/OWNER manage assignments (tenant-scoped via
-- the parent phase_tasks row, since this junction table has no tenant_id
-- column of its own). A worker can read rows for tasks they're assigned
-- to -- needed so usePhaseTasks()'s embedded phase_task_workers(worker_id)
-- select returns their own assignee row alongside the task.
CREATE POLICY admin_reads ON phase_task_workers FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY admin_inserts ON phase_task_workers FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY admin_deletes ON phase_task_workers FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_can_write() AND EXISTS (
    SELECT 1 FROM phase_tasks pt WHERE pt.id = phase_task_workers.task_id AND pt.tenant_id = current_tenant_id()
  ));
CREATE POLICY worker_reads_own ON phase_task_workers FOR SELECT TO authenticated
  USING (worker_id IN (SELECT id FROM workers WHERE email = (select auth.email())));

-- get_my_site_names(): extend the existing WORKER-safe site-name lookup
-- (2026-09-03-09-worker-safe-site-names.sql) to also cover a site the
-- worker only reaches via a Kanban task assignment (no same-day
-- worker_assignments row necessarily exists yet). CREATE OR REPLACE
-- keeps the same signature/grants -- no need to re-grant EXECUTE.
CREATE OR REPLACE FUNCTION get_my_site_names()
RETURNS TABLE(id UUID, site_number TEXT, name TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN worker_assignments wa ON wa.site_id = s.id AND wa.tenant_id = current_tenant_id()
  JOIN workers w ON w.id = wa.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id()
  UNION
  SELECT DISTINCT s.id, s.site_number, s.name
  FROM sites s
  JOIN phase_tasks pt ON pt.site_id = s.id AND pt.tenant_id = current_tenant_id()
  JOIN phase_task_workers ptw ON ptw.task_id = pt.id
  JOIN workers w ON w.id = ptw.worker_id AND w.tenant_id = current_tenant_id()
  WHERE w.email = auth.email() AND s.tenant_id = current_tenant_id();
$$;

-- get_my_team_today(): a WORKER's own RLS on worker_assignments only
-- lets them read THEIR OWN rows (worker_reads_own policy in
-- 2026-08-16-05-security-advisor-fixes.sql), so there is no direct path
-- for MySchedule.jsx's new "team today" section to see teammates'
-- assignments. Mirrors get_my_site_names()'s SECURITY DEFINER pattern:
-- returns only name/nickname for workers sharing a site+date with the
-- caller today, nothing else.
CREATE OR REPLACE FUNCTION get_my_team_today()
RETURNS TABLE(id UUID, name TEXT, nickname TEXT)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT DISTINCT w2.id, w2.name, w2.nickname
  FROM worker_assignments wa_me
  JOIN workers w_me ON w_me.id = wa_me.worker_id AND w_me.tenant_id = current_tenant_id()
  JOIN worker_assignments wa2 ON wa2.site_id = wa_me.site_id AND wa2.date = wa_me.date AND wa2.tenant_id = current_tenant_id()
  JOIN workers w2 ON w2.id = wa2.worker_id AND w2.tenant_id = current_tenant_id()
  WHERE w_me.email = auth.email()
    AND wa_me.date = CURRENT_DATE
    AND wa_me.type = 'site'
    AND wa2.type = 'site';
$$;

REVOKE EXECUTE ON FUNCTION get_my_team_today() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION get_my_team_today() TO authenticated;
```

- [ ] **Step 2: Apply the migration**

Use the Supabase MCP tool `mcp__plugin_supabase_supabase__apply_migration` with `project_id: yyzbgdmgyvvypfcjuhtr`, `name: add_phase_tasks`, and the SQL above as `query`. Then verify:
```sql
select count(*) from pg_tables where tablename in ('phase_tasks','phase_task_workers');
-- expect 2
select count(*) from pg_policies where tablename in ('phase_tasks','phase_task_workers');
-- expect 10 (4+2 on phase_tasks incl. worker policies, 4 on phase_task_workers)
```

- [ ] **Step 3: Add the hooks**

In `src/hooks/useSupabase.js`, immediately after the existing `useSitePhases()` function (which ends with the closing `))` before `/** OT entries...`), insert:

```js
/** งานย่อยของขั้นตอน (Kanban) ทุกไซท์ — group ฝั่ง client ด้วย phase_id/
 *  site_id. phase_task_workers ฝังมาด้วย (embed) เป็น [{worker_id}] ต่อแถว. */
export function usePhaseTasks() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('phase_tasks')
    .select('*, phase_task_workers(worker_id)')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}
```

Immediately after the existing `useMySiteNames()` function (ends with `if (error) throw error \n return data \n })`), insert:

```js
/** ชื่อ+ชื่อเล่นเพื่อนร่วมทีมที่ลงไซท์เดียวกันวันเดียวกับตัวเองวันนี้ (รวมตัวเอง)
 *  ผ่าน SECURITY DEFINER (WORKER อ่าน worker_assignments ของคนอื่นตรงๆ ไม่ได้) */
export function useMyTeamToday() {
  return useQuery(async () => {
    const { data, error } = await supabase.rpc('get_my_team_today')
    if (error) throw error
    return data
  })
}
```

- [ ] **Step 4: Write the pure logic module**

Create `src/pages/sites/phaseTasksCalc.js`:

```js
// ============================================================
// phase_tasks (Kanban card) calculations -- pure functions, no
// React/DOM dependency. A phase's Gantt status becomes derived from
// its own tasks once it has >=1 row (see design spec 2026-09-17).
// Worked example used to hand-verify this file (also covered by
// phaseTasksCalc.test.js):
//   phase "ผลิต" has 5 tasks: 3 done, 1 in_progress, 1 not_started
//   computePhaseTaskStats -> { total: 5, done: 3, pct: 60, derivedStatus: 'in_progress' }
//   phase "ติดตั้ง" has 0 tasks -> { total: 0, done: 0, pct: 0, derivedStatus: null }
//     (caller falls back to phase.status, unaffected by this module)
// ============================================================

/** done/total/pct/derivedStatus for one phase's tasks. derivedStatus is
 *  null when the phase has zero tasks -- the caller's cue to fall back
 *  to the phase's own manually-set status instead. */
export function computePhaseTaskStats(tasks) {
  const total = tasks.length
  if (total === 0) return { total: 0, done: 0, pct: 0, derivedStatus: null }
  const done = tasks.filter((t) => t.status === 'done').length
  const derivedStatus = done === total
    ? 'done'
    : tasks.some((t) => t.status !== 'not_started') ? 'in_progress' : 'not_started'
  return { total, done, pct: Math.round((done / total) * 100), derivedStatus }
}

/** The phase to show on the Day View's per-site mini task board: the
 *  earliest (by sort_order) phase with tasks that's in_progress, falling
 *  back to the earliest with tasks that's not_started. null if no phase
 *  on this site has any tasks yet (caller skips the section entirely). */
export function pickActivePhase(phases, tasksByPhaseId) {
  const withTasks = [...phases]
    .filter((p) => (tasksByPhaseId[p.id] || []).length > 0)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
  const inProgress = withTasks.find((p) => computePhaseTaskStats(tasksByPhaseId[p.id]).derivedStatus === 'in_progress')
  if (inProgress) return inProgress
  return withTasks.find((p) => computePhaseTaskStats(tasksByPhaseId[p.id]).derivedStatus === 'not_started') || null
}

/** A task is overdue when it has a due_date in the past and isn't done
 *  yet -- computed on read, never stored (matches site_phases' own
 *  "no derived overdue column" precedent). */
export function isTaskOverdue(task, todayISO) {
  return !!task.due_date && task.due_date < todayISO && task.status !== 'done'
}
```

- [ ] **Step 5: Write the failing tests, then watch them pass**

Create `src/pages/sites/phaseTasksCalc.test.js`:

```js
import { describe, it, expect } from 'vitest'
import { computePhaseTaskStats, pickActivePhase, isTaskOverdue } from './phaseTasksCalc.js'

describe('computePhaseTaskStats', () => {
  it('returns derivedStatus null for a phase with zero tasks', () => {
    expect(computePhaseTaskStats([])).toEqual({ total: 0, done: 0, pct: 0, derivedStatus: null })
  })

  it('returns done when every task is done', () => {
    const tasks = [{ status: 'done' }, { status: 'done' }]
    expect(computePhaseTaskStats(tasks)).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done' })
  })

  it('returns in_progress with the correct done/total/pct when some but not all are done', () => {
    const tasks = [{ status: 'done' }, { status: 'done' }, { status: 'done' }, { status: 'in_progress' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks)).toEqual({ total: 5, done: 3, pct: 60, derivedStatus: 'in_progress' })
  })

  it('returns in_progress when a task has started even with zero done', () => {
    const tasks = [{ status: 'in_progress' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks).derivedStatus).toBe('in_progress')
  })

  it('returns not_started when every task is still not_started', () => {
    const tasks = [{ status: 'not_started' }, { status: 'not_started' }]
    expect(computePhaseTaskStats(tasks).derivedStatus).toBe('not_started')
  })
})

describe('pickActivePhase', () => {
  const phases = [
    { id: 'p1', sort_order: 1 },
    { id: 'p2', sort_order: 2 },
    { id: 'p3', sort_order: 3 },
  ]

  it('returns null when no phase has any tasks', () => {
    expect(pickActivePhase(phases, {})).toBeNull()
  })

  it('picks the earliest in_progress phase over a later not_started one', () => {
    const tasksByPhaseId = {
      p1: [{ status: 'done' }],
      p2: [{ status: 'in_progress' }],
      p3: [{ status: 'not_started' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p2')
  })

  it('falls back to the earliest not_started phase when none are in_progress', () => {
    const tasksByPhaseId = {
      p1: [{ status: 'done' }],
      p3: [{ status: 'not_started' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p3')
  })

  it('skips phases with zero tasks entirely, even if earlier by sort_order', () => {
    const tasksByPhaseId = {
      p3: [{ status: 'in_progress' }],
    }
    expect(pickActivePhase(phases, tasksByPhaseId).id).toBe('p3')
  })
})

describe('isTaskOverdue', () => {
  it('is true for a past due_date on a task that is not done', () => {
    expect(isTaskOverdue({ due_date: '2026-09-01', status: 'in_progress' }, '2026-09-17')).toBe(true)
  })

  it('is false once the task is done, even past its due_date', () => {
    expect(isTaskOverdue({ due_date: '2026-09-01', status: 'done' }, '2026-09-17')).toBe(false)
  })

  it('is false when due_date is null', () => {
    expect(isTaskOverdue({ due_date: null, status: 'not_started' }, '2026-09-17')).toBe(false)
  })

  it('is false when due_date is today or in the future', () => {
    expect(isTaskOverdue({ due_date: '2026-09-17', status: 'not_started' }, '2026-09-17')).toBe(false)
    expect(isTaskOverdue({ due_date: '2026-09-18', status: 'not_started' }, '2026-09-17')).toBe(false)
  })
})
```

Run: `npm test -- --run`
Expected: all new tests PASS, all 163 pre-existing tests still PASS.

- [ ] **Step 6: Commit**

```bash
git add supabase/migrations/2026-09-17-03-add-phase-tasks.sql src/hooks/useSupabase.js src/pages/sites/phaseTasksCalc.js src/pages/sites/phaseTasksCalc.test.js
git commit -m "Add phase_tasks/phase_task_workers schema, hooks, and pure task-stats logic"
```

---

### Task 2: Gantt tab — derive phase status from tasks when present

**Files:**
- Modify: `src/pages/sites/GanttView.jsx`

**Interfaces:**
- Consumes: `usePhaseTasks()`, `computePhaseTaskStats(tasks)` from Task 1.
- Produces: no new exports — this task only changes `GanttView.jsx`'s internal rendering to prefer a task-derived status when a phase has tasks.

- [ ] **Step 1: Replace `src/pages/sites/GanttView.jsx` with this full content**

(Only the single-site branch's status/label computation and the inline editor's status field change; everything else — the multi-site branch, add/edit/delete handlers' structure, template button — is unchanged from the current file.)

```jsx
// ============================================================
// GanttView — สองมุมมอง: หลายไซท์ (1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว, ใช้
// ในหน้ารายการไซท์แบบภาพรวม) กับไซท์เดียว (1 แถวต่อขั้นตอน พร้อมแกนเดือน,
// ใช้ในหน้า SiteDetail — sites.length === 1 สลับโหมดอัตโนมัติ)
// + ลูกศร dependency (soft) + แก้ไขขั้นตอนได้ในหน้านี้เลย (ไซท์เดียว) +
// เทมเพลตขั้นตอนงานแบบเพิ่มเมื่อต้องการ (ไม่ auto-seed ทุกไซท์แล้ว) +
// สถานะขั้นตอนที่มี phase_tasks (Kanban) คำนวณสดจากงานย่อย ไม่ใช่ตั้งเอง
// ============================================================
import { useMemo, useState } from 'react'
import { format } from 'date-fns'
import { th } from 'date-fns/locale'
import { useSitePhases, usePhaseTasks } from '../../hooks/useSupabase.js'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { computeTimelineRange, positionPercent, barStyle, computeDependencyArrows, computeDependencyArrowsByRow, computeMonthTicks, STATUS_COLOR, PHASE_TEMPLATE } from './ganttTimeline.js'
import { computePhaseTaskStats } from './phaseTasksCalc.js'
import { getEffectiveTheme } from '../../lib/theme.js'

const ROW_H = 34
const EDIT_H = 320
const LABEL_W = 170
const TODAY_ISO = new Date().toISOString().slice(0, 10)

const STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จ' },
]

const emptyDraft = (site, phases) => ({
  name: '', start_date: '', end_date: '', status: 'not_started',
  billing_weight_pct: 0, depends_on_phase_id: '', sort_order: phases.length + 1,
})

export default function GanttView({ sites, navigateTo, onManagePhases, selectedSiteId, onSelectSite, canEdit, onPhasesChanged }) {
  const { data: allPhases, refetch } = useSitePhases()
  const { data: allTasks } = usePhaseTasks()

  // แก้ไข/เพิ่ม/ลบขั้นตอนแบบ inline (ใช้เฉพาะมุมมองไซท์เดียว) -- hooks ต้อง
  // อยู่บนสุดเสมอ ไม่ผูกกับ branch ไหน
  const [editingId, setEditingId] = useState(null) // phase.id ที่กำลังแก้ หรือ '__new__'
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [applyingTemplate, setApplyingTemplate] = useState(false)

  // SVG presentation attributes (stroke=...) don't resolve CSS var() --
  // only real CSS property values do -- so derive a literal hex color here
  // instead, following Dashboard.jsx's chartColors pattern.
  const isDarkChart = getEffectiveTheme() === 'dark'
  const arrowColor = isDarkChart ? '#5c5f80' : '#928c7a'

  const phasesBySite = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => {
      if (!m[p.site_id]) m[p.site_id] = []
      m[p.site_id].push(p)
    })
    return m
  }, [allPhases])

  const tasksByPhaseId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => {
      if (!m[t.phase_id]) m[t.phase_id] = []
      m[t.phase_id].push(t)
    })
    return m
  }, [allTasks])

  const range = useMemo(() => computeTimelineRange(sites, phasesBySite), [sites, phasesBySite])

  const afterWrite = async () => {
    await refetch()
    onPhasesChanged?.()
  }

  const startEdit = (phase) => { setEditingId(phase.id); setDraft({ ...phase, depends_on_phase_id: phase.depends_on_phase_id || '' }) }
  const startAdd = (site, phases) => { setEditingId('__new__'); setDraft(emptyDraft(site, phases)) }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async (site) => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่อขั้นตอน'); return }
    setSaving(true)
    try {
      const payload = {
        name: draft.name.trim(),
        start_date: draft.start_date || null,
        end_date: draft.end_date || null,
        status: draft.status,
        billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
        depends_on_phase_id: draft.depends_on_phase_id || null,
        sort_order: draft.sort_order,
      }
      if (editingId === '__new__') {
        const { error } = await supabase.from('site_phases').insert({ site_id: site.id, ...payload })
        if (error) throw error
      } else {
        const { error } = await supabase.from('site_phases').update(payload).eq('id', editingId)
        if (error) throw error
      }
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (id) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('site_phases').delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === id) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }

  const applyTemplate = async (site) => {
    setApplyingTemplate(true)
    try {
      const rows = PHASE_TEMPLATE.map((t) => ({ site_id: site.id, ...t }))
      const { error } = await supabase.from('site_phases').insert(rows)
      if (error) throw error
      await afterWrite()
    } catch (e) {
      alert('เพิ่มเทมเพลตไม่สำเร็จ: ' + e.message)
    } finally {
      setApplyingTemplate(false)
    }
  }

  // ── ไซท์เดียว: 1 แถวต่อขั้นตอน (หน้า SiteDetail) ──
  if (sites.length === 1) {
    const site = sites[0]
    const phases = phasesBySite[site.id] || []
    const isAdding = editingId === '__new__'
    const rows = isAdding ? [...phases, { id: '__new__', isNew: true }] : phases

    // สถานะที่ "แสดงจริง" ต่อขั้นตอน: ถ้ามี phase_tasks (Kanban) แล้ว คำนวณสด
    // จาก done/total แทนค่า status ที่ตั้งเอง -- ขั้นตอนที่ไม่มี task เลย
    // ยังใช้ status ที่ตั้งเองเหมือนเดิมทุกประการ (ไม่มี regression)
    const phaseStatsById = {}
    phases.forEach((p) => {
      const stats = computePhaseTaskStats(tasksByPhaseId[p.id] || [])
      phaseStatsById[p.id] = { stats, displayStatus: stats.total > 0 ? stats.derivedStatus : p.status }
    })

    if (!phases.length && !isAdding) {
      return (
        <div className="card" style={{ padding: 32, textAlign: 'center' }}>
          <div style={{ color: 'var(--text3)', marginBottom: 14 }}>ไซท์นี้ยังไม่มีขั้นตอนงาน</div>
          {canEdit && (
            <div style={{ display: 'flex', gap: 8, justifyContent: 'center' }}>
              <button type="button" className="btn btn-primary btn-sm" disabled={applyingTemplate} onClick={() => applyTemplate(site)}>
                {applyingTemplate ? '⏳ กำลังเพิ่ม...' : '+ เริ่มใช้ Gantt (เทมเพลตขั้นตอนงาน)'}
              </button>
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(site, phases)}>+ เพิ่มขั้นตอนเอง</button>
            </div>
          )}
        </div>
      )
    }

    const monthTicks = range ? computeMonthTicks(range) : []
    const arrows = editingId ? [] : computeDependencyArrowsByRow(phases, range)
    const doneCount = phases.filter((p) => phaseStatsById[p.id].displayStatus === 'done').length
    const inProgressCount = phases.filter((p) => phaseStatsById[p.id].displayStatus === 'in_progress').length
    const overallPct = phases.length ? Math.round((doneCount / phases.length) * 100) : 0
    // Same reasoning as SCurveChart's todayInRange guard: only draw "today"
    // when it actually falls inside this site's own timeline, otherwise a
    // clamped line at 0%/100% would falsely read as "today = start/end".
    const todayInRange = range && range.start <= new Date(TODAY_ISO) && new Date(TODAY_ISO) <= range.end
    const todayX = todayInRange ? positionPercent(TODAY_ISO, range) : null

    // ยอดสะสมตามแนวตั้ง: แถวที่กำลังแก้ไข/เพิ่ม จะสูงกว่าแถวปกติ เพื่อดัน
    // แถวถัดไปลงแทนที่จะซ้อนทับ (เดิมใช้ i*ROW_H คงที่ ตอนนี้ต้องคำนวณสะสม)
    let cursor = 0
    const rowTops = rows.map((r) => {
      const top = cursor
      cursor += (editingId && (r.id === editingId || (isAdding && r.id === '__new__'))) ? ROW_H + EDIT_H : ROW_H
      return top
    })
    const bodyHeight = Math.max(cursor, ROW_H)

    return (
      <>
        <div className="kpi-grid kpi-grid-4">
          <div className="kpi-card green">
            <div className="kpi-label">ความคืบหน้ารวม</div>
            <div className="kpi-value">{overallPct}%</div>
            <div className="progress" style={{ marginTop: 8 }}><div className="progress-bar" style={{ width: `${overallPct}%` }} /></div>
          </div>
          <div className="kpi-card"><div className="kpi-label">เฟสทั้งหมด</div><div className="kpi-value">{phases.length}</div></div>
          <div className="kpi-card yellow"><div className="kpi-label">กำลังทำอยู่</div><div className="kpi-value" style={{ color: 'var(--yellow)' }}>{inProgressCount}</div></div>
          <div className="kpi-card green"><div className="kpi-label">เสร็จแล้ว</div><div className="kpi-value" style={{ color: 'var(--green)' }}>{doneCount}</div></div>
        </div>

        <div className="card" style={{ padding: 16 }}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div className="card-title">ไทม์ไลน์เฟสงาน</div>
            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(site, phases)}>+ เพิ่มขั้นตอน</button>
            )}
          </div>
          {monthTicks.length > 0 && (
            <div style={{ position: 'relative', height: 20, marginLeft: LABEL_W }}>
              {monthTicks.map((t, i) => (
                <div key={i} style={{ position: 'absolute', left: `${t.x}%`, fontSize: 10.5, color: 'var(--text3)', transform: 'translateX(-50%)' }}>
                  {format(t.date, 'MMM yy', { locale: th })}
                </div>
              ))}
            </div>
          )}
          <div style={{ position: 'relative', height: bodyHeight }}>
            {rows.map((phase, i) => {
              const top = rowTops[i]
              const isEditingThis = editingId && phase.id === editingId
              const style = phase.isNew ? null : barStyle(phase, range)
              const ps = phaseStatsById[phase.id]

              if (isEditingThis) {
                return (
                  <div key={phase.id} style={{ position: 'absolute', top, left: 0, right: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', height: ROW_H, gap: 8 }}>
                      <input
                        className="input input-sm" style={{ flex: 1, fontWeight: 600 }}
                        value={draft.name} placeholder="ชื่อขั้นตอน" autoFocus
                        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
                      />
                    </div>
                    <div style={{ background: 'var(--bg2)', border: '1px solid var(--border)', borderRadius: 6, padding: 10, marginTop: 4, display: 'grid', gap: 8 }}>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          เริ่ม
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.start_date || ''} onChange={(e) => setDraft((d) => ({ ...d, start_date: e.target.value }))} />
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สิ้นสุด
                          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.end_date || ''} onChange={(e) => setDraft((d) => ({ ...d, end_date: e.target.value }))} />
                        </label>
                      </div>
                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          สถานะ
                          {ps && ps.stats.total > 0 ? (
                            <div style={{ marginTop: 2, fontSize: 12, color: 'var(--text2)', padding: '6px 8px', background: 'var(--bg3)', borderRadius: 6 }}>
                              คำนวณอัตโนมัติจากงานย่อย ({ps.stats.done}/{ps.stats.total} เสร็จ)
                            </div>
                          ) : (
                            <select className="select" style={{ width: '100%', marginTop: 2 }}
                              value={draft.status} onChange={(e) => setDraft((d) => ({ ...d, status: e.target.value }))}>
                              {STATUS_OPTS.map((s) => <option key={s.value} value={s.value}>{s.label}</option>)}
                            </select>
                          )}
                        </label>
                        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                          % เบิกเงิน
                          <input type="number" min="0" max="100" className="input input-sm" style={{ width: '100%', marginTop: 2 }}
                            value={draft.billing_weight_pct} onChange={(e) => setDraft((d) => ({ ...d, billing_weight_pct: e.target.value }))} />
                        </label>
                      </div>
                      <label style={{ fontSize: 11, color: 'var(--text3)' }}>
                        ขึ้นอยู่กับขั้นตอน
                        <select className="select" style={{ width: '100%', marginTop: 2 }}
                          value={draft.depends_on_phase_id || ''} onChange={(e) => setDraft((d) => ({ ...d, depends_on_phase_id: e.target.value }))}>
                          <option value="">— ไม่ขึ้นกับขั้นตอนอื่น —</option>
                          {phases.filter((p) => p.id !== editingId).map((p) => (
                            <option key={p.id} value={p.id}>{p.name || '(ยังไม่ตั้งชื่อ)'}</option>
                          ))}
                        </select>
                      </label>
                      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 2 }}>
                        {!phase.isNew && (
                          <button type="button" className="btn btn-sm btn-danger" style={{ marginRight: 'auto' }}
                            disabled={saving} onClick={() => setConfirmDeleteId(editingId)}>🗑 ลบ</button>
                        )}
                        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={cancelEdit}>ยกเลิก</button>
                        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={() => saveDraft(site)}>
                          {saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
                        </button>
                      </div>
                    </div>
                  </div>
                )
              }

              const displayStatus = ps ? ps.displayStatus : phase.status
              const label = displayStatus === 'done' ? '✓'
                : displayStatus === 'in_progress' ? (ps && ps.stats.total > 0 ? `${ps.stats.pct}%` : 'กำลังทำ')
                : ''
              const titleSuffix = ps && ps.stats.total > 0 ? ` (${ps.stats.done}/${ps.stats.total} งานย่อยเสร็จ)` : ''

              return (
                <div key={phase.id} style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: LABEL_W, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={phase.name}>
                    {phase.name}
                  </div>
                  <div style={{ position: 'relative', flex: 1, height: 20, background: 'var(--bg3)', borderRadius: 5 }}>
                    {style && (
                      <div
                        title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${displayStatus}${titleSuffix}`}
                        style={{
                          position: 'absolute', top: 2, bottom: 2, left: style.left, width: style.width,
                          background: STATUS_COLOR[displayStatus] || STATUS_COLOR.not_started, borderRadius: 5,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: displayStatus === 'not_started' ? 'var(--text3)' : '#fff',
                          overflow: 'hidden', whiteSpace: 'nowrap',
                        }}
                      >
                        {label}
                      </div>
                    )}
                  </div>
                  {canEdit && !editingId && (
                    <button type="button" className="btn btn-sm btn-ghost" style={{ flexShrink: 0, padding: '2px 8px' }} onClick={() => startEdit(phase)}>✎</button>
                  )}
                </div>
              )
            })}
            {arrows.length > 0 && (
              <svg
                style={{ position: 'absolute', top: 0, left: LABEL_W, right: 0, bottom: 0, width: `calc(100% - ${LABEL_W}px)`, height: '100%', pointerEvents: 'none' }}
                preserveAspectRatio="none" viewBox={`0 0 100 ${phases.length}`}
              >
                {arrows.map((a, i) => (
                  <line
                    key={i}
                    x1={a.fromX} y1={a.fromRow + 0.5} x2={a.toX} y2={a.toRow + 0.5}
                    stroke={arrowColor} strokeWidth="0.4" strokeDasharray="1 0.8" vectorEffect="non-scaling-stroke"
                  />
                ))}
              </svg>
            )}
            {todayX != null && !editingId && (
              <div style={{ position: 'absolute', top: 0, left: LABEL_W, right: 0, bottom: 0, pointerEvents: 'none' }}>
                <div style={{ position: 'absolute', top: -16, left: `${todayX}%`, transform: 'translateX(-50%)', fontSize: 9.5, color: 'var(--text3)', whiteSpace: 'nowrap' }}>
                  วันนี้
                </div>
                <div style={{ position: 'absolute', top: 0, bottom: 0, left: `${todayX}%`, borderLeft: '1px dashed var(--text3)' }} />
              </div>
            )}
          </div>
          <div className="legend" style={{ display: 'flex', gap: 16, marginTop: 14, fontSize: 11.5, color: 'var(--text2)' }}>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--green)' }} />เสร็จแล้ว</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--yellow)' }} />กำลังทำ</span>
            <span><span className="dot" style={{ width: 8, height: 8, borderRadius: '50%', display: 'inline-block', marginRight: 5, background: 'var(--text3)' }} />ยังไม่เริ่ม</span>
          </div>
        </div>

        {confirmDeleteId && (
          <ConfirmDialog
            title="ลบขั้นตอนงาน"
            message="ต้องการลบขั้นตอนนี้ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้"
            danger
            onCancel={() => setConfirmDeleteId(null)}
            onConfirm={() => doDelete(confirmDeleteId)}
          />
        )}
      </>
    )
  }

  // ── หลายไซท์: 1 แถวต่อไซท์ ทุกขั้นตอนแชร์แถวเดียว (หน้ารายการไซท์) ──
  if (!range) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่มีไซท์ที่มีวันที่ให้แสดงบน Gantt
      </div>
    )
  }

  return (
    <div className="card">
      {sites.map((site) => {
        const phases = phasesBySite[site.id] || []
        const arrows = computeDependencyArrows(phases, range)
        const isSelected = selectedSiteId === site.id
        return (
          <div
            key={site.id}
            onClick={() => onSelectSite(site.id)}
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              padding: '10px 12px',
              borderBottom: '1px solid var(--border)',
              cursor: 'pointer',
              background: isSelected ? 'var(--bg2)' : 'transparent',
            }}
          >
            <div style={{ width: 180, flexShrink: 0 }}>
              <div
                style={{ fontWeight: 600, fontSize: 13, textDecoration: 'underline dotted' }}
                onClick={(e) => { e.stopPropagation(); navigateTo('assign', { siteId: site.id, siteName: site.name }) }}
                title="ไปหน้า Assign ของไซท์นี้"
              >
                {site.name}
              </div>
              <div style={{ fontSize: 11, color: 'var(--accent)' }}>{site.site_number}</div>
            </div>
            <div style={{ position: 'relative', flex: 1, height: 28, background: 'var(--bg2)', borderRadius: 4 }}>
              {phases.map((phase) => {
                const style = barStyle(phase, range)
                if (!style) return null
                return (
                  <div
                    key={phase.id}
                    title={`${phase.name}\n${phase.start_date} → ${phase.end_date}\nสถานะ: ${phase.status}`}
                    style={{
                      position: 'absolute',
                      top: 4,
                      bottom: 4,
                      left: style.left,
                      width: style.width,
                      background: STATUS_COLOR[phase.status] || STATUS_COLOR.not_started,
                      borderRadius: 3,
                    }}
                  />
                )
              })}
              {arrows.length > 0 && (
                <svg
                  style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none' }}
                  preserveAspectRatio="none" viewBox="0 0 100 28"
                >
                  {arrows.map((a, i) => (
                    <line
                      key={i}
                      x1={a.fromX} y1={14} x2={a.toX} y2={14}
                      stroke={arrowColor} strokeWidth="0.6" strokeDasharray="1.5 1"
                    />
                  ))}
                </svg>
              )}
            </div>
            {canEdit && (
              <button
                className="btn btn-sm btn-ghost"
                style={{ flexShrink: 0 }}
                onClick={(e) => { e.stopPropagation(); onManagePhases(site) }}
              >
                📋 จัดการขั้นตอน
              </button>
            )}
          </div>
        )
      })}
      {!sites.length && (
        <div style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไม่พบข้อมูลไซท์งาน</div>
      )}
    </div>
  )
}
```

Note: the multi-site (portfolio) branch intentionally still uses raw `phase.status` (not task-derived) — that branch is read-only, has no per-phase task context loaded for every site's every phase, and the spec only calls for derivation on the single-site Gantt tab. Leave it as-is.

- [ ] **Step 2: Build and test**

Run: `npm run build` — expect success.
Run: `npm test -- --run` — expect all tests (163 + Task 1's new ones) to pass.

- [ ] **Step 3: Verify live**

In the browser: open a site with phases but no tasks yet — confirm the Gantt tab and inline editor behave EXACTLY as before (manual status select still works, bars unchanged). This is the regression check; Task 3 is what actually creates tasks to test the derived path with, so full derived-status verification happens after Task 3 lands (note this in the task report).

- [ ] **Step 4: Commit**

```bash
git add src/pages/sites/GanttView.jsx
git commit -m "Gantt tab: derive phase status from phase_tasks when a phase has any"
```

---

### Task 3: Kanban board — new tab in SiteDetail

**Files:**
- Create: `src/pages/sites/PhaseKanbanBoard.jsx`
- Modify: `src/pages/SiteDetail.jsx`

**Interfaces:**
- Consumes: `useSitePhases()`, `usePhaseTasks()`, `useWorkers()` from `src/hooks/useSupabase.js`; `STATUS_COLOR` from `./ganttTimeline.js`; `ConfirmDialog` from `../../components/Modal.jsx`; `supabase` from `../../lib/supabase.js`.
- Produces: `PhaseKanbanBoard({ site, canEdit, onTasksChanged })` — a full page-section component, self-fetching, mounted as `SiteDetail.jsx`'s 3rd tab.

- [ ] **Step 1: Create `src/pages/sites/PhaseKanbanBoard.jsx`**

```jsx
// ============================================================
// PhaseKanbanBoard -- งานย่อย (task) ของแต่ละขั้นตอน แสดงเป็นบอร์ด 3 คอลัมน์
// (ยังไม่เริ่ม/กำลังทำ/เสร็จแล้ว) กรองตามขั้นตอน+ชั้น/โซน คลิกการ์ดเปิด panel
// แก้ไขในหน้าเดียว (ชื่อ/โซน/สถานะ/กำหนดเสร็จ/ผู้รับผิดชอบ) + ลากการ์ดย้าย
// คอลัมน์แบบด่วนบนเดสก์ท็อป (HTML5 native drag -- คลิกเปิด panel คือ
// fallback ที่ใช้ได้ทุกอุปกรณ์รวมถึงทัช). สถานะของขั้นตอนแม่บน Gantt
// คำนวณสดจาก phase_tasks นี้เอง (ดู GanttView.jsx) ไม่ได้เขียนกลับ
// site_phases.status ตรงๆ จากที่นี่
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { useSitePhases, usePhaseTasks, useWorkers } from '../../hooks/useSupabase.js'
import { STATUS_COLOR } from './ganttTimeline.js'

const COLUMNS = [
  { status: 'not_started', label: 'ยังไม่เริ่ม' },
  { status: 'in_progress', label: 'กำลังทำ' },
  { status: 'done', label: 'เสร็จแล้ว' },
]

const emptyDraft = (phaseId, status, sortOrder) => ({
  phase_id: phaseId, name: '', zone: '', status, due_date: '', sort_order: sortOrder, assigneeIds: [],
})

export default function PhaseKanbanBoard({ site, canEdit, onTasksChanged }) {
  const { data: allPhases } = useSitePhases()
  const { data: allTasks, refetch } = usePhaseTasks()
  const { data: workers } = useWorkers()

  const [selectedPhaseId, setSelectedPhaseId] = useState(null)
  const [selectedZone, setSelectedZone] = useState('all')
  const [editingId, setEditingId] = useState(null) // task.id หรือ '__new__:<status>'
  const [draft, setDraft] = useState(null)
  const [saving, setSaving] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState(null)
  const [dragOverStatus, setDragOverStatus] = useState(null)

  const phases = useMemo(() => (allPhases || [])
    .filter((p) => p.site_id === site.id)
    .sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0)), [allPhases, site.id])

  const tasksByPhaseId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => { (m[t.phase_id] ||= []).push(t) })
    return m
  }, [allTasks])

  const workerById = useMemo(() => {
    const m = {}
    ;(workers || []).forEach((w) => { m[w.id] = w })
    return m
  }, [workers])

  const activePhaseId = selectedPhaseId ?? phases.find((p) => (tasksByPhaseId[p.id] || []).length > 0)?.id ?? phases[0]?.id ?? null
  const phaseTasks = tasksByPhaseId[activePhaseId] || []

  const zones = useMemo(() => [...new Set(phaseTasks.map((t) => t.zone).filter(Boolean))].sort(), [phaseTasks])
  const visibleTasks = phaseTasks.filter((t) => selectedZone === 'all' || t.zone === selectedZone)

  const afterWrite = async () => {
    await refetch()
    onTasksChanged?.()
  }

  const startEdit = (task) => {
    setEditingId(task.id)
    setDraft({
      phase_id: task.phase_id, name: task.name, zone: task.zone || '', status: task.status,
      due_date: task.due_date || '', sort_order: task.sort_order,
      assigneeIds: (task.phase_task_workers || []).map((r) => r.worker_id),
    })
  }
  const startAdd = (status) => {
    if (!activePhaseId) return
    const sortOrder = phaseTasks.length ? Math.max(...phaseTasks.map((t) => t.sort_order || 0)) + 1 : 1
    setEditingId(`__new__:${status}`)
    setDraft(emptyDraft(activePhaseId, status, sortOrder))
  }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async () => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่องาน'); return }
    setSaving(true)
    try {
      const payload = {
        name: draft.name.trim(), zone: draft.zone.trim() || null, status: draft.status,
        due_date: draft.due_date || null, sort_order: draft.sort_order,
      }
      let taskId = editingId
      if (String(editingId).startsWith('__new__')) {
        const { data, error } = await supabase.from('phase_tasks')
          .insert({ phase_id: draft.phase_id, site_id: site.id, ...payload })
          .select().single()
        if (error) throw error
        taskId = data.id
      } else {
        const { error } = await supabase.from('phase_tasks').update(payload).eq('id', editingId)
        if (error) throw error
      }
      const { error: delErr } = await supabase.from('phase_task_workers').delete().eq('task_id', taskId)
      if (delErr) throw delErr
      if (draft.assigneeIds.length) {
        const { error: insErr } = await supabase.from('phase_task_workers')
          .insert(draft.assigneeIds.map((worker_id) => ({ task_id: taskId, worker_id })))
        if (insErr) throw insErr
      }
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (id) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('phase_tasks').delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === id) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }

  const quickMove = async (taskId, status) => {
    setSaving(true)
    try {
      const { error } = await supabase.from('phase_tasks').update({ status }).eq('id', taskId)
      if (error) throw error
      await afterWrite()
    } catch (e) {
      alert('ย้ายไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const toggleAssignee = (workerId) => {
    setDraft((d) => ({
      ...d,
      assigneeIds: d.assigneeIds.includes(workerId) ? d.assigneeIds.filter((id) => id !== workerId) : [...d.assigneeIds, workerId],
    }))
  }

  if (!phases.length) {
    return <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>ไซท์นี้ยังไม่มีขั้นตอนงาน — เพิ่มขั้นตอนก่อนในแท็บ Gantt</div>
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
        เฟส:
        {phases.map((p) => (
          <span key={p.id} onClick={() => { setSelectedPhaseId(p.id); setSelectedZone('all') }}
            style={{
              border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer',
              background: activePhaseId === p.id ? 'var(--accent)' : 'transparent',
              color: activePhaseId === p.id ? '#fff' : 'var(--text2)',
            }}>
            {p.name}
          </span>
        ))}
      </div>
      {zones.length > 0 && (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
          ชั้น:
          {['all', ...zones].map((z) => (
            <span key={z} onClick={() => setSelectedZone(z)}
              style={{
                border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer',
                background: selectedZone === z ? 'var(--accent)' : 'transparent',
                color: selectedZone === z ? '#fff' : 'var(--text2)',
              }}>
              {z === 'all' ? 'ทุกชั้น' : z}
            </span>
          ))}
        </div>
      )}

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 14 }}>
        {COLUMNS.map((col) => {
          const colTasks = visibleTasks.filter((t) => t.status === col.status)
          const isNewHere = editingId === `__new__:${col.status}`
          return (
            <div key={col.status}
              onDragOver={canEdit ? (e) => { e.preventDefault(); setDragOverStatus(col.status) } : undefined}
              onDragLeave={canEdit ? () => setDragOverStatus((s) => (s === col.status ? null : s)) : undefined}
              onDrop={canEdit ? (e) => {
                e.preventDefault()
                setDragOverStatus(null)
                const taskId = e.dataTransfer.getData('text/plain')
                if (taskId) quickMove(taskId, col.status)
              } : undefined}
              style={{
                background: dragOverStatus === col.status ? 'var(--bg3)' : 'transparent',
                borderRadius: 9, padding: 4, transition: 'background .1s',
              }}>
              <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text2)', marginBottom: 10, display: 'flex', justifyContent: 'space-between' }}>
                <span>{col.label}</span>
                <span style={{ background: 'var(--bg3)', borderRadius: 20, padding: '1px 8px', fontSize: 11, color: 'var(--text3)' }}>{colTasks.length}</span>
              </div>

              {colTasks.map((task) => {
                const assignees = (task.phase_task_workers || []).map((r) => workerById[r.worker_id]).filter(Boolean)
                if (editingId === task.id) {
                  return (
                    <TaskEditPanel key={task.id} draft={draft} setDraft={setDraft} workers={workers || []}
                      onToggleAssignee={toggleAssignee} onCancel={cancelEdit} onSave={saveDraft}
                      onDelete={() => setConfirmDeleteId(task.id)} saving={saving} />
                  )
                }
                return (
                  <div key={task.id}
                    draggable={canEdit}
                    onDragStart={canEdit ? (e) => e.dataTransfer.setData('text/plain', task.id) : undefined}
                    onClick={canEdit ? () => startEdit(task) : undefined}
                    style={{
                      background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${STATUS_COLOR[task.status] || STATUS_COLOR.not_started}`,
                      borderRadius: 9, padding: '11px 13px', marginBottom: 10, boxShadow: 'var(--shadow)', cursor: canEdit ? 'pointer' : 'default',
                    }}>
                    <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>{task.name}</div>
                    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 6 }}>
                      {task.zone
                        ? <span style={{ fontSize: 10, fontWeight: 700, color: 'var(--blue)', background: 'rgba(78,205,196,.14)', borderRadius: 20, padding: '2px 9px' }}>{task.zone}</span>
                        : <span />}
                      <div style={{ display: 'flex', gap: 4 }}>
                        {assignees.length
                          ? assignees.map((w) => (
                            <span key={w.id} title={w.nickname || w.name} style={{ width: 20, height: 20, borderRadius: '50%', background: 'var(--accent)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                              {(w.nickname || w.name || '?').slice(0, 2)}
                            </span>
                          ))
                          : <span style={{ fontSize: 10.5, color: 'var(--text3)' }}>ยังไม่มอบหมาย</span>}
                      </div>
                    </div>
                  </div>
                )
              })}

              {isNewHere && (
                <TaskEditPanel draft={draft} setDraft={setDraft} workers={workers || []}
                  onToggleAssignee={toggleAssignee} onCancel={cancelEdit} onSave={saveDraft} saving={saving} isNew />
              )}

              {canEdit && !editingId && (
                <button type="button" className="btn btn-ghost btn-sm" style={{ width: '100%' }} onClick={() => startAdd(col.status)}>+ เพิ่มงาน</button>
              )}
            </div>
          )
        })}
      </div>

      {confirmDeleteId && (
        <ConfirmDialog
          title="ลบงานย่อย"
          message="ต้องการลบงานนี้ใช่หรือไม่? การลบไม่สามารถย้อนกลับได้"
          danger
          onCancel={() => setConfirmDeleteId(null)}
          onConfirm={() => doDelete(confirmDeleteId)}
        />
      )}
    </div>
  )
}

function TaskEditPanel({ draft, setDraft, workers, onToggleAssignee, onCancel, onSave, onDelete, saving, isNew }) {
  return (
    <div style={{ background: 'var(--bg2)', border: '1px solid var(--accent)', borderRadius: 9, padding: 12, marginBottom: 10 }}>
      <input className="input input-sm" style={{ width: '100%', marginBottom: 8, fontWeight: 600 }}
        value={draft.name} placeholder="ชื่องาน" autoFocus
        onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))} />
      <div style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
        {COLUMNS.map((c) => (
          <button key={c.status} type="button"
            className={`btn btn-sm ${draft.status === c.status ? 'btn-primary' : 'btn-ghost'}`}
            style={{ flex: 1, fontSize: 11, padding: '5px 4px' }}
            onClick={() => setDraft((d) => ({ ...d, status: c.status }))}>
            {c.label}
          </button>
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 8 }}>
        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
          ชั้น/โซน
          <input className="input input-sm" style={{ width: '100%', marginTop: 2 }} placeholder="เช่น ชั้น 3" value={draft.zone}
            onChange={(e) => setDraft((d) => ({ ...d, zone: e.target.value }))} />
        </label>
        <label style={{ fontSize: 11, color: 'var(--text3)' }}>
          กำหนดเสร็จ
          <input type="date" className="input input-sm" style={{ width: '100%', marginTop: 2 }} value={draft.due_date || ''}
            onChange={(e) => setDraft((d) => ({ ...d, due_date: e.target.value }))} />
        </label>
      </div>
      <div style={{ fontSize: 11, color: 'var(--text3)', marginBottom: 4 }}>มอบหมายให้</div>
      <div style={{ maxHeight: 110, overflowY: 'auto', display: 'grid', gap: 4, marginBottom: 8, background: 'var(--bg3)', borderRadius: 6, padding: 8 }}>
        {workers.map((w) => (
          <label key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
            <input type="checkbox" checked={draft.assigneeIds.includes(w.id)} onChange={() => onToggleAssignee(w.id)} />
            {w.nickname || w.name}
          </label>
        ))}
        {!workers.length && <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>ไม่มีรายชื่อช่าง</div>}
      </div>
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
        {!isNew && (
          <button type="button" className="btn btn-sm btn-danger" style={{ marginRight: 'auto' }} disabled={saving} onClick={onDelete}>🗑 ลบ</button>
        )}
        <button type="button" className="btn btn-sm btn-ghost" disabled={saving} onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="btn btn-sm btn-primary" disabled={saving} onClick={onSave}>{saving ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: Wire the tab into `src/pages/SiteDetail.jsx`**

Replace the full contents of `src/pages/SiteDetail.jsx` with:

```jsx
// ============================================================
// SiteDetail -- per-site page (ภาพรวม / Gantt / Kanban tabs). Reached
// via navigateTo('site_detail', { siteId, siteName }) from Sites.jsx's
// site name click. Not a visible nav tab -- see App.jsx's ALL_TAB_ENTRIES.
// ============================================================
import { useState } from 'react'
import { useSiteOverview } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import SiteOverviewContent from '../components/SiteOverviewContent.jsx'
import GanttView from './sites/GanttView.jsx'
import SCurveChart from './sites/SCurveChart.jsx'
import PhaseKanbanBoard from './sites/PhaseKanbanBoard.jsx'

export default function SiteDetail({ navState, navigateTo }) {
  const siteId = navState?.siteId
  const siteName = navState?.siteName
  const [tab, setTab] = useState('overview') // 'overview' | 'gantt' | 'kanban'
  const [phasesRefreshKey, setPhasesRefreshKey] = useState(0)

  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'sites')

  const { data: site, error: siteError } = useSiteOverview(siteId)

  if (!siteId) {
    return (
      <div className="card" style={{ padding: 32, textAlign: 'center', color: 'var(--text3)' }}>
        ไม่พบไซท์งานที่เลือก — <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>กลับไปหน้าไซท์งาน</button>
      </div>
    )
  }

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
        <button className="btn btn-sm btn-ghost" onClick={() => navigateTo('sites')}>← ไซท์งานทั้งหมด</button>
      </div>
      <div style={{ fontSize: 18, fontWeight: 700, marginBottom: 14 }}>
        {site?.site_number ? `${site.site_number} · ` : ''}{site?.name || siteName || 'ไซท์งาน'}
      </div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        <button
          className={`btn btn-sm ${tab === 'overview' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('overview')}
        >ภาพรวม</button>
        <button
          className={`btn btn-sm ${tab === 'gantt' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('gantt')}
        >📅 Gantt</button>
        <button
          className={`btn btn-sm ${tab === 'kanban' ? 'btn-primary' : 'btn-ghost'}`}
          onClick={() => setTab('kanban')}
        >🗂 Kanban</button>
      </div>

      {tab === 'overview' && <SiteOverviewContent siteId={siteId} />}

      {tab === 'gantt' && (
        siteError ? (
          <div className="card" style={{ padding: 24, color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {siteError}</div>
        ) : !site ? (
          <div className="card" style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : (
          <>
            <GanttView
              key={phasesRefreshKey}
              sites={[site]}
              navigateTo={navigateTo}
              selectedSiteId={site.id}
              onSelectSite={() => {}}
              canEdit={canEdit}
              onPhasesChanged={() => setPhasesRefreshKey((k) => k + 1)}
            />
            <div style={{ marginTop: 16 }}>
              <SCurveChart key={phasesRefreshKey} site={site} />
            </div>
          </>
        )
      )}

      {tab === 'kanban' && (
        siteError ? (
          <div className="card" style={{ padding: 24, color: 'var(--red)', fontSize: 13 }}>โหลดข้อมูลไม่สำเร็จ: {siteError}</div>
        ) : !site ? (
          <div className="card" style={{ padding: 24, color: 'var(--text3)', fontSize: 13 }}>กำลังโหลด...</div>
        ) : (
          <PhaseKanbanBoard
            key={phasesRefreshKey}
            site={site}
            canEdit={canEdit}
            onTasksChanged={() => setPhasesRefreshKey((k) => k + 1)}
          />
        )
      )}
    </div>
  )
}
```

- [ ] **Step 3: Build and test**

Run: `npm run build` — expect success.
Run: `npm test -- --run` — expect all tests to pass (no new tests in this task — no automated component testing in this repo, see Global Constraints).

- [ ] **Step 4: Verify live**

In the browser, navigate to a site's SiteDetail page → Kanban tab:
- With `canEdit` true: pick a phase chip, click "+ เพิ่มงาน" in a column, fill a name, check 1-2 assignees, save — confirm the card appears in the right column with the right zone badge/avatars.
- Click the card to reopen the editor, change its status via the 3 status buttons, save — confirm it moved to the new column.
- Drag a card (desktop mouse) to a different column — confirm it moves and the count badges update.
- Delete a card via the editor's ลบ button + confirm dialog — confirm it's gone.
- Go back to the Gantt tab for the same site/phase — confirm the phase's bar now shows the computed `%`/✓ instead of the old manual status, and the inline editor's "สถานะ" field now shows the "คำนวณอัตโนมัติจากงานย่อย" readonly note instead of a select.
- Check the browser console for errors throughout.
- Clean up any test task/assignee data created during this walkthrough (delete the test card) unless it's useful to leave for Task 4/5's verification.

- [ ] **Step 5: Commit**

```bash
git add src/pages/sites/PhaseKanbanBoard.jsx src/pages/SiteDetail.jsx
git commit -m "Add per-site Kanban board (3rd SiteDetail tab)"
```

---

### Task 4: Day View — mini task board per site

**Files:**
- Modify: `src/pages/assign/DayView.jsx`

**Interfaces:**
- Consumes: `useSitePhases()`, `usePhaseTasks()` from `src/hooks/useSupabase.js`; `pickActivePhase` from `../sites/phaseTasksCalc.js`; `STATUS_COLOR` from `../sites/ganttTimeline.js`.
- Produces: no new exports — purely additive rendering inside the existing per-site card.

- [ ] **Step 1: Replace `src/pages/assign/DayView.jsx` with this full content**

(Adds two hooks, two `useMemo` groupings, a `MINI_COLUMNS` constant, and one new conditional section appended inside the existing per-site card, right after the existing OT section. Every existing line — the cost card header, morning/evening chips, OT section, the "others" leave/office card — is unchanged.)

```jsx
// ============================================================
// DayView — single day grouped by site, morning/evening columns + cost
// + mini task board of the site's active Kanban phase (if it has one)
// ============================================================
import { useMemo } from 'react'
import { fmt } from '../../lib/supabase.js'
import { TYPE_COLOR, TYPE_LABEL, SITE_TYPES } from './constants.js'
import { otCost } from './otMath.js'
import { useSitePhases, usePhaseTasks } from '../../hooks/useSupabase.js'
import { pickActivePhase } from '../sites/phaseTasksCalc.js'
import { STATUS_COLOR } from '../sites/ganttTimeline.js'

const dayRate = (w) => Math.round((w?.monthly_salary || 0) / 26)

const MINI_COLUMNS = [
  { status: 'not_started', label: 'ยังไม่เริ่ม' },
  { status: 'in_progress', label: 'กำลังทำ' },
  { status: 'done', label: 'เสร็จแล้ว' },
]

export default function DayView({ dayIso, assignments, otEntries, sites, travelRate, onEditHalf }) {
  const { data: allPhases } = useSitePhases()
  const { data: allTasks } = usePhaseTasks()

  const phasesBySite = useMemo(() => {
    const m = {}
    ;(allPhases || []).forEach((p) => { (m[p.site_id] ||= []).push(p) })
    return m
  }, [allPhases])

  const tasksByPhaseId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => { (m[t.phase_id] ||= []).push(t) })
    return m
  }, [allTasks])

  const siteMeta = useMemo(() => {
    const m = {}
    ;(sites || []).forEach(s => { m[s.id] = { name: s.name, site_number: s.site_number, distance_km: s.distance_km } })
    return m
  }, [sites])

  const rows = (assignments || []).filter(a => a.date === dayIso)
  const dayOT = (otEntries || []).filter(o => o.date === dayIso)
  const otBySite = {}
  dayOT.forEach(o => { (otBySite[o.site_id] ||= []).push(o) })

  // group site/factory/subcontract by site; keep others separately
  const bySite = {}
  const others = []  // leave/office/holiday
  rows.forEach(a => {
    if (a.site_id && (SITE_TYPES.includes(a.type) || a.type === 'subcontract')) {
      const g = bySite[a.site_id] ||= { morning: [], evening: [], hasSiteType: false, labor: 0 }
      g[a.shift]?.push(a)
      if (a.type === 'site') g.hasSiteType = true
      if (SITE_TYPES.includes(a.type)) g.labor += 0.5 * dayRate(a.workers)
    } else {
      others.push(a)
    }
  })

  // Sites with OT but no regular assignment that day still need a card,
  // otherwise their OT silently disappears from the view.
  Object.keys(otBySite).forEach(sid => {
    if (!bySite[sid]) bySite[sid] = { morning: [], evening: [], hasSiteType: false, labor: 0 }
  })

  const siteIds = Object.keys(bySite)

  const Chip = ({ a }) => {
    const tc = TYPE_COLOR[a.type] || TYPE_COLOR.site
    return (
      <span onClick={() => onEditHalf({ id: a.worker_id, name: a.workers?.name, nickname: a.workers?.nickname }, a.date, a.shift)}
        title={`${a.workers?.name || ''}${a.type === 'factory' ? ' (โรงงาน)' : ''}${a.ot_hours > 0 ? ' OT' + a.ot_hours + 'h' : ''}`}
        style={{ background: tc.bg, color: tc.color, borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
        {a.workers?.nickname || a.workers?.name}{a.type === 'factory' ? ' 🏭' : ''}{a.ot_hours > 0 ? ' ⚡' : ''}
      </span>
    )
  }

  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(320px, 1fr))', gap: 12 }}>
        {siteIds.map(sid => {
          const g = bySite[sid]
          const meta = siteMeta[sid] || {}
          const travel = g.hasSiteType ? (meta.distance_km || 0) * 2 * (travelRate || 0) : 0
          const siteOT = otBySite[sid] || []
          const otTotal = siteOT.reduce((s, o) => s + otCost(o.workers?.monthly_salary, o.ot_hours), 0)
          const total = g.labor + travel + otTotal
          const sitePhases = (phasesBySite[sid] || []).sort((a, b) => (a.sort_order || 0) - (b.sort_order || 0))
          const activePhase = pickActivePhase(sitePhases, tasksByPhaseId)
          const activeTasks = activePhase ? (tasksByPhaseId[activePhase.id] || []) : []
          return (
            <div key={sid} className="card card-body" style={{ padding: '14px 16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10, gap: 8 }}>
                <div style={{ minWidth: 0 }}>
                  <div style={{ fontSize: 11, color: 'var(--accent)' }}>{meta.site_number}</div>
                  <div style={{ fontWeight: 700, fontSize: 14, overflowWrap: 'anywhere' }}>{meta.name}</div>
                </div>
                <div style={{ textAlign: 'right', whiteSpace: 'nowrap' }}>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวมวันนี้</div>
                  <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 16 }}>{fmt(total)}</div>
                  <div style={{ fontSize: 10, color: 'var(--text3)' }}>
                    แรง {fmt(g.labor)}{travel > 0 && <> · เดินทาง {fmt(travel)}</>}{otTotal > 0 && <> · OT {fmt(otTotal)}</>}
                  </div>
                </div>
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--blue)', marginBottom: 4 }}>🌅 เช้า</div>
                  {g.morning.length ? g.morning.map(a => <Chip key={a.id} a={a} />) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>— ว่าง —</span>}
                </div>
                <div style={{ flex: 1 }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--yellow)', marginBottom: 4 }}>🌆 บ่าย</div>
                  {g.evening.length ? g.evening.map(a => <Chip key={a.id} a={a} />) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>— ว่าง —</span>}
                </div>
              </div>
              {siteOT.length > 0 && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--yellow)', marginBottom: 4 }}>⚡ OT</div>
                  {siteOT.map(o => (
                    <span key={o.id} onClick={() => onEditHalf({ id: o.worker_id, name: o.workers?.name, nickname: o.workers?.nickname }, o.date, 'morning')}
                      title={`${o.workers?.name || ''} · ${o.start_time?.slice(0,5)}-${o.end_time?.slice(0,5)}`}
                      style={{ background: 'rgba(255,209,102,0.25)', color: 'var(--yellow)', borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
                      {o.workers?.nickname || o.workers?.name} ({o.start_time?.slice(0,5)}-{o.end_time?.slice(0,5)})
                    </span>
                  ))}
                </div>
              )}
              {activePhase && (
                <div style={{ marginTop: 8, paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                  <div style={{ fontSize: 9, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--accent)', marginBottom: 6 }}>
                    🗂 {activePhase.name}
                  </div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 6 }}>
                    {MINI_COLUMNS.map((col) => (
                      <div key={col.status}>
                        <div style={{ color: 'var(--text3)', fontSize: 9.5, marginBottom: 4, fontWeight: 700 }}>{col.label}</div>
                        {activeTasks.filter((t) => t.status === col.status).map((t) => (
                          <div key={t.id} style={{ background: 'var(--bg3)', borderRadius: 6, padding: '4px 7px', marginBottom: 4, fontSize: 10.5, borderLeft: `3px solid ${STATUS_COLOR[col.status]}` }}>
                            {t.name}{t.zone ? ` ${t.zone}` : ''}
                          </div>
                        ))}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )
        })}
        {!siteIds.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีการ assign ในวันนี้</div>}
      </div>

      {others.length > 0 && (
        <div className="card card-body" style={{ padding: '12px 16px', marginTop: 12 }}>
          <div style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 1, color: 'var(--text3)', marginBottom: 6 }}>ลา / ออฟฟิศ / หยุด</div>
          {others.map(a => {
            const tc = TYPE_COLOR[a.type] || TYPE_COLOR.holiday
            return (
              <span key={a.id} onClick={() => onEditHalf({ id: a.worker_id, name: a.workers?.name, nickname: a.workers?.nickname }, a.date, a.shift)}
                style={{ background: tc.bg, color: tc.color, borderRadius: 5, padding: '3px 8px', margin: 2, fontSize: 11, cursor: 'pointer', display: 'inline-block' }}>
                {a.workers?.nickname || a.workers?.name} · {TYPE_LABEL[a.type] || a.type} ({a.shift === 'morning' ? 'เช้า' : 'บ่าย'})
              </span>
            )
          })}
        </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build and test**

Run: `npm run build` — expect success.
Run: `npm test -- --run` — expect all tests to pass.

- [ ] **Step 3: Verify live**

In the browser: Assign tab → Day view, on a date/site where Task 3's test task(s) still exist (or create a fresh one on the site's Kanban tab first) — confirm the mini task board section appears under that site's card with the right column/task, and that a site with tasks nowhere `in_progress`/`not_started` (i.e. every task done, or truly zero tasks) shows no section at all (no empty "🗂" header). Confirm every other part of the existing Day view (cost totals, chips, OT, leave/office card) still renders identically to before. Check console for errors.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/DayView.jsx
git commit -m "Day view: show each site's active-phase mini task board"
```

---

### Task 5: Worker Dashboard — team roster + today's tasks

**Files:**
- Modify: `src/pages/assign/MySchedule.jsx`

**Interfaces:**
- Consumes: `usePhaseTasks()`, `useMyTeamToday()` from `src/hooks/useSupabase.js`; `isTaskOverdue` from `../sites/phaseTasksCalc.js`; `supabase` from `../../lib/supabase.js`.
- Produces: no new exports — additive rendering inside the existing component, plus one new local `updateTaskStatus` write.

- [ ] **Step 1: Replace `src/pages/assign/MySchedule.jsx` with this full content**

(Adds `useState`, `supabase`, `usePhaseTasks`, `useMyTeamToday`, `isTaskOverdue` imports; a `TASK_STATUS_OPTS` constant; `myTasks`/`updateTaskStatus`/`openStatusMenuId`/`savingTaskId` state and logic; and two new rendered sections — "ทีมของคุณวันนี้" right after the leave-quota KPI cards, and "งานของคุณวันนี้" right after that, both before the existing day/month view. Every existing line is otherwise unchanged.)

```jsx
// ============================================================
// MySchedule — WORKER's personal view of the Assign page: their
// own days/shifts/OT for the current range, plus their leave quota,
// today's team roster, and today's assigned Kanban tasks.
// No team grid beyond "who's with me today", no cost figures — RLS
// also enforces this at the database level, this component is the
// matching restricted UI.
// Day/week views render a linear day list; month view renders a real
// calendar grid (reusing AssignCell so it matches ADMIN's month grid
// visually — same site colors/abbreviations, same OT badge).
// ============================================================
import { useMemo, useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { useAllActiveWorkers, useAssignmentsRange, useWorkerOTRange, useMySiteNames, useLeaveQuotaUsage, usePhaseTasks, useMyTeamToday } from '../../hooks/useSupabase.js'
import { supabase } from '../../lib/supabase.js'
import { isTaskOverdue } from '../sites/phaseTasksCalc.js'
import { DOW_TH } from './constants.js'
import AssignCell from './AssignCell.jsx'
import TodayCheckinCard from './TodayCheckinCard.jsx'

const OTHER_TYPE_LABEL = { office: 'ออฟฟิศ', leave: 'ลา', leave_sick: 'ลาป่วย', leave_personal: 'ลากิจ', holiday: 'หยุด' }
const DOW_MON_START = ['จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส', 'อา']
const TASK_STATUS_OPTS = [
  { value: 'not_started', label: 'ยังไม่เริ่ม' },
  { value: 'in_progress', label: 'กำลังทำ' },
  { value: 'done', label: 'เสร็จแล้ว' },
]
const noop = () => {}

export default function MySchedule({ from, to, days, view }) {
  const { user } = useUserRole()
  const { data: workers } = useAllActiveWorkers()
  const { data: assignments } = useAssignmentsRange(from, to)
  const { data: otEntries } = useWorkerOTRange(from, to)
  const { data: sites } = useMySiteNames()
  const { data: leaveUsed } = useLeaveQuotaUsage(new Date().getFullYear())
  const { data: myTasksRaw, refetch: refetchTasks } = usePhaseTasks()
  const { data: teamToday } = useMyTeamToday()

  const [openStatusMenuId, setOpenStatusMenuId] = useState(null)
  const [savingTaskId, setSavingTaskId] = useState(null)

  const me = useMemo(() => (workers || []).find(w => w.email === user?.email), [workers, user])

  const siteById = useMemo(() => {
    const m = {}
    ;(sites || []).forEach(s => { m[s.id] = s })
    return m
  }, [sites])

  const myAssignmentsByDate = useMemo(() => {
    const m = {}
    ;(assignments || []).forEach(a => {
      if (a.worker_id !== me?.id) return
      ;(m[a.date] ||= []).push(a)
    })
    return m
  }, [assignments, me])

  const myOtByDate = useMemo(() => {
    const m = {}
    ;(otEntries || []).forEach(o => {
      if (o.worker_id !== me?.id) return
      m[o.date] = o
    })
    return m
  }, [otEntries, me])

  const todayIso = new Date().toISOString().slice(0, 10)

  // งานที่มอบหมายให้ตัวเองและยังไม่เสร็จ -- RLS บน phase_tasks จำกัดผลลัพธ์
  // ของ usePhaseTasks() ไว้อยู่แล้วเฉพาะงานที่ตัวเองเป็น assignee (ดู
  // worker_reads_own policy) แต่ยังกรองซ้ำฝั่ง client ด้วย เผื่อกรณี role
  // สูงกว่า WORKER เปิดหน้านี้ (canEdit=false แต่ไม่ใช่ WORKER จริง) ให้
  // ตรงกับ pattern เดิมของไฟล์นี้ (myAssignmentsByDate/myOtByDate ก็กรองซ้ำ
  // ฝั่ง client เหมือนกันแม้ RLS จะจำกัดไว้แล้ว
  const myTasks = useMemo(() => {
    const mine = (myTasksRaw || []).filter((t) =>
      t.status !== 'done' && (t.phase_task_workers || []).some((r) => r.worker_id === me?.id))
    return mine.sort((a, b) => {
      const aOver = isTaskOverdue(a, todayIso), bOver = isTaskOverdue(b, todayIso)
      if (aOver !== bOver) return aOver ? -1 : 1
      const order = { in_progress: 0, not_started: 1 }
      return (order[a.status] ?? 2) - (order[b.status] ?? 2)
    })
  }, [myTasksRaw, me, todayIso])

  const updateTaskStatus = async (taskId, status) => {
    setSavingTaskId(taskId)
    try {
      const { error } = await supabase.from('phase_tasks').update({ status }).eq('id', taskId)
      if (error) throw error
      await refetchTasks()
      setOpenStatusMenuId(null)
    } catch (e) {
      alert('อัปเดตไม่สำเร็จ: ' + e.message)
    } finally {
      setSavingTaskId(null)
    }
  }

  // Today's distinct site assignments (site-type only) -- one
  // TodayCheckinCard per distinct site_id, since a worker can be
  // assigned to two different sites the same day (spec edge case).
  const todaySiteAssignments = useMemo(() => {
    const rows = (myAssignmentsByDate[todayIso] || []).filter(a => a.type === 'site')
    const bySite = new Map()
    rows.forEach(a => { if (!bySite.has(a.site_id)) bySite.set(a.site_id, a) })
    return [...bySite.values()]
  }, [myAssignmentsByDate, todayIso])

  // AssignCell-compatible cell for one date: { morning, evening } segments,
  // each carrying site_name/site_number resolved via sites_progress (not
  // the assignment row's own nested `sites` join, which RLS blocks for
  // WORKER once Task 6 goes live since it touches the base sites table).
  const cellFor = (iso) => {
    const dayAssignments = myAssignmentsByDate[iso] || []
    const toSeg = (a) => a && {
      type: a.type, site_id: a.site_id,
      site_name: siteById[a.site_id]?.name, site_number: siteById[a.site_id]?.site_number,
    }
    return {
      morning: toSeg(dayAssignments.find(a => a.shift === 'morning')),
      evening: toSeg(dayAssignments.find(a => a.shift === 'evening')),
    }
  }

  // Pad `days` (which only contains real days-in-month, no adjacent-month
  // filler) out to a Monday-start 7-column grid.
  const monthGrid = useMemo(() => {
    if (view !== 'month' || !days.length) return []
    const firstDow = (days[0].date.getDay() + 6) % 7 // 0=Mon..6=Sun
    const leading = Array.from({ length: firstDow }, () => null)
    const cells = [...leading, ...days]
    const trailing = (7 - (cells.length % 7)) % 7
    return [...cells, ...Array.from({ length: trailing }, () => null)]
  }, [view, days])

  if (!me) {
    return <div style={{ color: 'var(--text3)', fontSize: 13 }}>ไม่พบข้อมูลพนักงานที่ผูกกับบัญชีนี้</div>
  }

  const used = leaveUsed?.[me.id] || 0
  const remaining = (me.annual_leave_days || 0) - used

  return (
    <div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 18, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">วันลากิจใช้ไปแล้ว (ปีนี้)</div>
          <div className="kpi-value" style={{ color: used > 0 ? 'var(--red)' : 'var(--text)' }}>{used}</div>
        </div>
        <div className="kpi-card kpi-sm">
          <div className="kpi-label">คงเหลือ</div>
          <div className="kpi-value" style={{ color: remaining < 0 ? 'var(--red)' : 'var(--green)' }}>{remaining}</div>
        </div>
      </div>

      {teamToday && teamToday.length > 0 && (
        <div className="card" style={{ marginBottom: 14, padding: 14 }}>
          <div className="card-title" style={{ marginBottom: 10 }}>ทีมของคุณวันนี้</div>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
            {teamToday.map((w) => (
              <span key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
                <span style={{ width: 20, height: 20, borderRadius: '50%', background: w.id === me.id ? 'var(--blue)' : 'var(--accent)', color: '#fff', fontSize: 9.5, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  {(w.nickname || w.name || '?').slice(0, 2)}
                </span>
                <span style={{ fontSize: 11, color: 'var(--text2)' }}>{w.nickname || w.name}{w.id === me.id ? ' (คุณ)' : ''}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      <div style={{ fontSize: 12.5, fontWeight: 700, color: 'var(--text2)', marginBottom: 8 }}>งานของคุณวันนี้</div>
      {myTasks.length ? (
        <div style={{ marginBottom: 18 }}>
          {myTasks.map((t) => {
            const overdue = isTaskOverdue(t, todayIso)
            const borderColor = overdue ? 'var(--red)' : t.status === 'in_progress' ? 'var(--yellow)' : 'var(--text3)'
            const isOpen = openStatusMenuId === t.id
            return (
              <div key={t.id} style={{ marginBottom: 8 }}>
                <div onClick={() => setOpenStatusMenuId(isOpen ? null : t.id)}
                  style={{
                    background: 'var(--bg2)', border: '1px solid var(--border)', borderLeft: `3px solid ${borderColor}`,
                    borderRadius: 9, padding: '11px 13px', cursor: 'pointer',
                  }}>
                  <div style={{ fontSize: 13, fontWeight: 600, marginBottom: 4 }}>
                    {overdue && '⚠️ '}{t.name}
                    {overdue && <span style={{ fontWeight: 400, color: 'var(--red)', fontSize: 11 }}> เลยกำหนด</span>}
                    {!overdue && t.status === 'in_progress' && <span style={{ fontWeight: 400, color: 'var(--yellow)', fontSize: 11 }}> กำลังทำ</span>}
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11, color: 'var(--text3)' }}>
                    <span>{siteById[t.site_id]?.site_number || ''}{t.zone ? ` · ${t.zone}` : ''}</span>
                    <span>แตะเพื่ออัปเดต</span>
                  </div>
                </div>
                {isOpen && (
                  <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
                    {TASK_STATUS_OPTS.map((s) => (
                      <button key={s.value} type="button" className={`btn btn-sm ${t.status === s.value ? 'btn-primary' : 'btn-ghost'}`}
                        disabled={savingTaskId === t.id} style={{ flex: 1, fontSize: 11 }}
                        onClick={() => updateTaskStatus(t.id, s.value)}>
                        {s.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      ) : (
        <div style={{ color: 'var(--text3)', fontSize: 12.5, marginBottom: 18 }}>ไม่มีงานที่มอบหมายวันนี้</div>
      )}

      {view === 'month' ? (
        <div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4, marginBottom: 4 }}>
            {DOW_MON_START.map(d => (
              <div key={d} style={{ textAlign: 'center', fontSize: 10.5, color: 'var(--text3)', fontWeight: 700 }}>{d}</div>
            ))}
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, 1fr)', gap: 4 }}>
            {monthGrid.map((d, i) => {
              if (!d) return <div key={`blank-${i}`} />
              const ot = myOtByDate[d.iso]
              const isToday = d.iso === new Date().toISOString().slice(0, 10)
              return (
                <div key={d.iso} style={{
                  border: `1px solid ${isToday ? 'var(--accent)' : 'transparent'}`, borderRadius: 6, padding: 2,
                }}>
                  <div style={{ fontSize: 10, color: d.isSunday ? 'var(--text3)' : 'var(--text2)', textAlign: 'center', marginBottom: 2 }}>
                    {d.date.getDate()}
                  </div>
                  <AssignCell cell={cellFor(d.iso)} ot={ot} onEdit={noop} h={54} variant="month" />
                </div>
              )
            })}
          </div>
        </div>
      ) : (
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {days.map(d => {
          const dayAssignments = myAssignmentsByDate[d.iso] || []
          const ot = myOtByDate[d.iso]
          const morning = dayAssignments.find(a => a.shift === 'morning')
          const evening = dayAssignments.find(a => a.shift === 'evening')
          const isToday = d.iso === new Date().toISOString().slice(0, 10)
          const primary = morning || evening

          return (
            <div key={d.iso}>
              <div style={{
                display: 'grid', gridTemplateColumns: '56px 1fr auto', alignItems: 'center', gap: 14,
                background: 'var(--bg2)', border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                borderRadius: 9, padding: '12px 14px',
              }}>
                <div style={{ textAlign: 'center' }}>
                  <div style={{ fontSize: 10.5, color: 'var(--text3)' }}>{DOW_TH[d.dow]}</div>
                  <div style={{ fontSize: 20, fontWeight: 800, lineHeight: 1.1 }}>{d.date.getDate()}</div>
                </div>
                <div>
                  {primary ? (
                    <>
                      <div style={{ fontWeight: 700, fontSize: 13.5, marginBottom: 3 }}>
                        {['site', 'factory'].includes(primary.type)
                          ? `${primary.type === 'factory' ? '🏭' : '🏗️'} ${siteById[primary.site_id]?.site_number || ''} · ${siteById[primary.site_id]?.name || '—'}`
                          : (OTHER_TYPE_LABEL[primary.type] || primary.type)}
                      </div>
                      <div style={{ display: 'flex', gap: 6 }}>
                        {morning && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(255,209,102,.16)', color: 'var(--yellow)' }}>เช้า</span>}
                        {evening && <span style={{ fontSize: 10.5, fontWeight: 700, padding: '2px 8px', borderRadius: 999, background: 'rgba(108,99,255,.18)', color: 'var(--accent)' }}>บ่าย</span>}
                      </div>
                    </>
                  ) : (
                    <div style={{ color: 'var(--text3)' }}>— ไม่มีงาน —</div>
                  )}
                </div>
                {ot && (
                  <div style={{ fontSize: 11, fontWeight: 700, color: 'var(--green)', background: 'rgba(0,212,170,.13)', borderRadius: 999, padding: '5px 10px', whiteSpace: 'nowrap' }}>
                    ⚡ OT {ot.ot_hours} ชม.
                  </div>
                )}
              </div>
              {isToday && todaySiteAssignments.map(a => (
                <TodayCheckinCard
                  key={a.site_id}
                  workerId={me.id} siteId={a.site_id}
                  siteName={siteById[a.site_id]?.name || a.site_id}
                  date={todayIso}
                />
              ))}
            </div>
          )
        })}
      </div>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Build and test**

Run: `npm run build` — expect success.
Run: `npm test -- --run` — expect all tests to pass.

- [ ] **Step 3: Verify live**

This needs a WORKER-role login to see the real restricted view (or temporarily assign yourself a task via the ADMIN Kanban board to a worker whose account you can log into, per this session's established browser-testing pattern of navigating as the logged-in test user). At minimum, verify via code review + build/test that:
- `useMyTeamToday()`/`usePhaseTasks()` don't throw for an ADMIN session either (since MySchedule.jsx also renders for a non-`canEdit` ADMIN per `Assign.jsx`'s `!canEdit ? <MySchedule/> : ...` branch) — confirm no console errors when an ADMIN-but-view-only session opens the Assign tab.
- If a WORKER test account is available: assign that worker a task via the Kanban board, log in as them (or use the existing browser session if it's already scoped to a worker), open "จ่ายงานช่าง" → confirm "ทีมของคุณวันนี้" and "งานของคุณวันนี้" render, tap a task to open the status menu, change its status, confirm it updates (and disappears from the list once marked เสร็จแล้ว, since the list excludes done tasks).
- Note in the task report if a WORKER test account wasn't available and this step was therefore verified only via build/test/code-review — do not claim live verification that didn't happen.

- [ ] **Step 4: Commit**

```bash
git add src/pages/assign/MySchedule.jsx
git commit -m "Worker dashboard: today's team roster + assigned tasks with tap-to-update"
```
