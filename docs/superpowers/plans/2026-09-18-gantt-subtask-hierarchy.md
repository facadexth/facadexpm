# Gantt Subtask Hierarchy Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a Gantt phase be broken into subtasks that nest arbitrarily deep (subtask of a subtask, etc.), each with its own dates and billing %, with Kanban microtasks attaching only to whichever node is currently a leaf — and make the S-curve's plan line ramp progressively per-leaf instead of jumping per-phase.

**Architecture:** One new self-referencing table (`phase_subtasks`, `parent_subtask_id` nullable) sits between `site_phases` and `phase_tasks` (Kanban cards get a new nullable `subtask_id`). Status and billing % roll up recursively (derive from children if any exist, else from microtasks, else manual) using the exact same "derive-if-children-exist, else fall back" shape as the existing Phase↔Kanban roll-up already shipped this session — just applied at every level instead of one. The Gantt UI grows an expand/collapse tree; the Kanban UI grows extra chip tiers; the S-curve iterates flattened leaves instead of phases.

**Tech Stack:** React 18, Vite 5, Supabase (Postgres + RLS), Vitest.

**Spec:** `docs/superpowers/specs/2026-09-18-gantt-subtask-hierarchy-design.md`

## Global Constraints

- ADMIN+ only (`canEdit`) for every write in this plan — same gate phases and Kanban cards already use. No new permission model.
- Every multi-step write (insert + reassign, e.g. the "Kanban เก่า" auto-create) must be non-destructive under partial failure: create the new row(s) before repointing/deleting anything old, exactly like this session's established `upsert(ignoreDuplicates)`-then-`delete` pattern for `phase_task_workers`.
- RLS on every new/changed table stays flat `tenant_id = current_tenant_id()` scoping (no cross-table join needed for the tenant check), mirroring `site_phases`/`phase_tasks`'s existing policies exactly — copy their shape, don't invent a new one.
- Hard-block (refuse to save, inline error) when a node's direct-child subtasks would sum to >100% billing weight — never silently clamp or just warn.
- All new pure logic (`src/pages/sites/subtaskCalc.js`) has zero React/DOM dependency and ships with Vitest tests in the same `describe`/`it`/`expect` style as `phaseTasksCalc.test.js`.
- Reuse `trackLeft`/`trackRight`/`GAP`/`EDIT_BTN_W`/`LABEL_W` from `GanttView.jsx` (added in commit `40af6c2`) for every new row — never hardcode a new offset.
- `npm run build` and `npm test -- --run` (176 existing + new tests) must stay green after every task.

---

### Task 1: `phase_subtasks` table, RLS, and `phase_tasks.subtask_id`

**Files:**
- Create: `supabase/migrations/2026-09-18-03-phase-subtasks.sql`

**Interfaces:**
- Produces: table `phase_subtasks(id, phase_id, parent_subtask_id, site_id, tenant_id, name, start_date, end_date, billing_weight_pct, status, depends_on_subtask_id, sort_order, created_at, updated_at)`; column `phase_tasks.subtask_id` (nullable FK).

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-18-03-phase-subtasks.sql
--
-- Adds a recursively-nestable Subtask level between Phase (site_phases)
-- and Kanban microtask (phase_tasks) -- spec:
-- docs/superpowers/specs/2026-09-18-gantt-subtask-hierarchy-design.md
--
-- parent_subtask_id NULL means "direct child of phase_id"; non-null means
-- "nested under another phase_subtasks row" -- depth is not a schema
-- concept, it falls out of following this chain. phase_id is carried on
-- EVERY row regardless of depth (denormalized down the whole chain) so
-- "which top-level phase is this under" never needs a recursive walk.
--
-- phase_tasks.subtask_id is nullable: a microtask attaches to a phase
-- directly (subtask_id NULL, today's existing shape, unchanged) OR to a
-- leaf subtask (subtask_id set). App logic enforces "only a leaf may
-- carry microtasks" -- not a DB constraint, matching this schema's
-- existing style of keeping such rules in the write path.

CREATE TABLE phase_subtasks (
  id                     UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  phase_id               UUID NOT NULL REFERENCES site_phases(id) ON DELETE CASCADE,
  parent_subtask_id      UUID REFERENCES phase_subtasks(id) ON DELETE CASCADE,
  site_id                UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  tenant_id              UUID NOT NULL,
  name                   TEXT NOT NULL,
  start_date             DATE,
  end_date               DATE,
  billing_weight_pct     NUMERIC NOT NULL DEFAULT 0,
  status                 TEXT NOT NULL DEFAULT 'not_started'
                         CHECK (status IN ('not_started','in_progress','done')),
  depends_on_subtask_id  UUID REFERENCES phase_subtasks(id),
  sort_order             INT NOT NULL DEFAULT 0,
  created_at             TIMESTAMPTZ DEFAULT NOW(),
  updated_at             TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_phase_subtasks_phase_id ON phase_subtasks(phase_id);
CREATE INDEX idx_phase_subtasks_parent_subtask_id ON phase_subtasks(parent_subtask_id);
CREATE INDEX idx_phase_subtasks_site_id ON phase_subtasks(site_id);

ALTER TABLE phase_subtasks ENABLE ROW LEVEL SECURITY;

-- Same shape as site_phases' own four policies -- ADMIN/OWNER only, flat
-- tenant_id scoping, no join needed (this table carries tenant_id
-- directly). No worker-level policy: workers interact with Kanban cards
-- (phase_tasks), never with subtasks themselves, same as they never
-- touch site_phases directly today.
CREATE POLICY admin_reads ON phase_subtasks FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_inserts ON phase_subtasks FOR INSERT TO authenticated
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_updates ON phase_subtasks FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON phase_subtasks FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- phase_tasks re-parenting: nullable FK, ON DELETE CASCADE matches the
-- existing phase_tasks.phase_id -> site_phases behavior (deleting a
-- phase already deletes its microtasks today; deleting a subtask does
-- the same for consistency -- the existing delete confirmation dialog's
-- "ลบไม่สามารถย้อนกลับได้" copy already sets that expectation).
ALTER TABLE phase_tasks ADD COLUMN subtask_id UUID REFERENCES phase_subtasks(id) ON DELETE CASCADE;
CREATE INDEX idx_phase_tasks_subtask_id ON phase_tasks(subtask_id);
```

- [ ] **Step 2: Apply the migration**

Apply it the same way every migration this session was applied: via the
Supabase MCP tool (`mcp__plugin_supabase_supabase__apply_migration`,
`project_id: yyzbgdmgyvvypfcjuhtr`, `name` derived from the filename,
`query` = the file's contents). Confirm the tool returns `{"success":true}`.

- [ ] **Step 3: Verify live**

Run this query via the Supabase MCP tool and confirm it returns the new
table's columns and the four `admin_*` policies, nothing else:

```sql
select column_name, data_type, is_nullable from information_schema.columns where table_name = 'phase_subtasks' order by ordinal_position;
select policyname, cmd from pg_policies where tablename = 'phase_subtasks' order by policyname;
select column_name from information_schema.columns where table_name = 'phase_tasks' and column_name = 'subtask_id';
```

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-18-03-phase-subtasks.sql
git commit -m "feat: add phase_subtasks table (recursive) and phase_tasks.subtask_id"
```

---

### Task 2: Pure recursive calc module — `subtaskCalc.js`

**Files:**
- Create: `src/pages/sites/subtaskCalc.js`
- Test: `src/pages/sites/subtaskCalc.test.js`

**Interfaces:**
- Consumes: `computePhaseTaskStats(tasks)` from `./phaseTasksCalc.js` — `(tasks: {status}[]) => {total, done, pct, derivedStatus}`.
- Produces (used by Tasks 4, 5, 6, 7):
  - `groupSubtasksByParent(subtasks) => { [parentKey: string]: subtask[] }`
  - `computeNodeStats(nodeId, subtasksByParent, microtasksByNodeId) => { total, done, pct, derivedStatus, billingWeightPct, source }`
  - `isLeaf(nodeId, subtasksByParent) => boolean`
  - `flattenLeaves(phases, subtasksByParent) => node[]` (each a phase or subtask object, whichever is the leaf)
  - `flattenVisibleRows(phases, subtasksByParent, expandedIds) => {node, depth, isPhase}[]`
  - `siblingWeightSum(parentId, subtasksByParent, excludeSubtaskId) => number`

- [ ] **Step 1: Write the failing tests**

```js
// src/pages/sites/subtaskCalc.test.js
import { describe, it, expect } from 'vitest'
import {
  groupSubtasksByParent, computeNodeStats, isLeaf, flattenLeaves,
  flattenVisibleRows, siblingWeightSum,
} from './subtaskCalc.js'

describe('groupSubtasksByParent', () => {
  it('groups direct children of a phase under the phase id', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null },
    ]
    const g = groupSubtasksByParent(subtasks)
    expect(g.p1.map((s) => s.id)).toEqual(['s1', 's2'])
  })

  it('groups nested children under their parent subtask id, separately from the phase', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
    ]
    const g = groupSubtasksByParent(subtasks)
    expect(g.p1.map((s) => s.id)).toEqual(['s1'])
    expect(g.s1.map((s) => s.id)).toEqual(['s1a'])
  })
})

describe('isLeaf', () => {
  it('is true for a node with no entry in the parent map', () => {
    expect(isLeaf('p1', {})).toBe(true)
  })

  it('is false for a node that has child subtasks', () => {
    const g = groupSubtasksByParent([{ id: 's1', phase_id: 'p1', parent_subtask_id: null }])
    expect(isLeaf('p1', g)).toBe(false)
    expect(isLeaf('s1', g)).toBe(true)
  })
})

describe('computeNodeStats', () => {
  it('falls back to manual (source: manual) for a leaf with zero microtasks', () => {
    expect(computeNodeStats('p1', {}, {})).toEqual({
      total: 0, done: 0, pct: 0, derivedStatus: null, billingWeightPct: null, source: 'manual',
    })
  })

  it('derives from microtasks (source: microtasks) when a leaf has them, billingWeightPct stays null', () => {
    const microtasksByNodeId = { p1: [{ status: 'done' }, { status: 'in_progress' }] }
    expect(computeNodeStats('p1', {}, microtasksByNodeId)).toEqual({
      total: 2, done: 1, pct: 50, derivedStatus: 'in_progress', billingWeightPct: null, source: 'microtasks',
    })
  })

  it('derives from a single level of child subtasks, summing their weights', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 20 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    const microtasksByNodeId = { s1: [{ status: 'done' }], s2: [{ status: 'done' }] }
    const stats = computeNodeStats('p1', subtasksByParent, microtasksByNodeId)
    expect(stats).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done', billingWeightPct: 30, source: 'subtasks' })
  })

  it('recurses through a second level of nesting (worked example from the spec)', () => {
    // phase "ผลิต" (p1) has 2 child subtasks: "ตัดวัสดุ" (s1, done, weight 10)
    // and "เชื่อมประกอบ" (s2, weight 20) which itself has 1 child subtask
    // "เชื่อมชั้น 3" (s2a, done, weight 20).
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 20 },
      { id: 's2a', phase_id: 'p1', parent_subtask_id: 's2', billing_weight_pct: 20 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    const microtasksByNodeId = { s1: [{ status: 'done' }], s2a: [{ status: 'done' }] }

    const s2Stats = computeNodeStats('s2', subtasksByParent, microtasksByNodeId)
    expect(s2Stats).toEqual({ total: 1, done: 1, pct: 100, derivedStatus: 'done', billingWeightPct: 20, source: 'subtasks' })

    const p1Stats = computeNodeStats('p1', subtasksByParent, microtasksByNodeId)
    expect(p1Stats).toEqual({ total: 2, done: 2, pct: 100, derivedStatus: 'done', billingWeightPct: 30, source: 'subtasks' })
  })

  it('is in_progress when some but not all children are done, not_started when none have started', () => {
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
      { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 10 },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    expect(computeNodeStats('p1', subtasksByParent, { s1: [{ status: 'done' }], s2: [{ status: 'not_started' }] }).derivedStatus).toBe('in_progress')
    expect(computeNodeStats('p1', subtasksByParent, {}).derivedStatus).toBe('not_started')
  })
})

describe('flattenLeaves', () => {
  it('returns a phase itself when it has no subtasks', () => {
    const phases = [{ id: 'p1' }, { id: 'p2' }]
    expect(flattenLeaves(phases, {}).map((n) => n.id)).toEqual(['p1', 'p2'])
  })

  it('returns leaf subtasks instead of a phase that has subtasks, at any depth', () => {
    const phases = [{ id: 'p1' }, { id: 'p2' }]
    const subtasks = [
      { id: 's1', phase_id: 'p1', parent_subtask_id: null },
      { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
    ]
    const subtasksByParent = groupSubtasksByParent(subtasks)
    // p1 has a child (s1) so it's not a leaf; s1 has a child (s1a) so it's
    // not a leaf either; s1a has no children -> the only leaf under p1.
    // p2 has no subtasks -> it is itself a leaf.
    expect(flattenLeaves(phases, subtasksByParent).map((n) => n.id)).toEqual(['s1a', 'p2'])
  })
})

describe('flattenVisibleRows', () => {
  const phases = [{ id: 'p1' }, { id: 'p2' }]
  const subtasks = [
    { id: 's1', phase_id: 'p1', parent_subtask_id: null },
    { id: 's1a', phase_id: 'p1', parent_subtask_id: 's1' },
  ]
  const subtasksByParent = groupSubtasksByParent(subtasks)

  it('shows only phases when nothing is expanded', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set())
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['p2', 0]])
  })

  it('reveals depth-1 children when their phase is expanded, without revealing depth-2 yet', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set(['p1']))
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['s1', 1], ['p2', 0]])
  })

  it('reveals depth-2 children only once both ancestors are expanded', () => {
    const rows = flattenVisibleRows(phases, subtasksByParent, new Set(['p1', 's1']))
    expect(rows.map((r) => [r.node.id, r.depth])).toEqual([['p1', 0], ['s1', 1], ['s1a', 2], ['p2', 0]])
  })
})

describe('siblingWeightSum', () => {
  const subtasks = [
    { id: 's1', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 30 },
    { id: 's2', phase_id: 'p1', parent_subtask_id: null, billing_weight_pct: 40 },
  ]
  const subtasksByParent = groupSubtasksByParent(subtasks)

  it('sums every sibling under a parent', () => {
    expect(siblingWeightSum('p1', subtasksByParent)).toBe(70)
  })

  it('excludes the subtask being edited, so re-saving it at its own weight does not double-count', () => {
    expect(siblingWeightSum('p1', subtasksByParent, 's1')).toBe(40)
  })

  it('is 0 for a parent with no children yet', () => {
    expect(siblingWeightSum('nonexistent', subtasksByParent)).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --run subtaskCalc`
Expected: FAIL — `subtaskCalc.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// src/pages/sites/subtaskCalc.js
// ============================================================
// Recursive Phase/Subtask tree math -- pure functions, no React/DOM
// dependency. Subtasks nest arbitrarily deep (subtask of a subtask, of
// a subtask, ...); a phase's own id and every subtask's own id share one
// flat id-space (both real UUIDs from different tables, never collide),
// so one map keyed by "parent id" -> "direct children" safely serves
// phases and subtasks alike at every depth.
//
// Worked example used to hand-verify this file (also covered by
// subtaskCalc.test.js): phase "ผลิต" (p1) has 2 child subtasks:
// "ตัดวัสดุ" (s1, done, weight 10) and "เชื่อมประกอบ" (s2, weight 20)
// which itself has 1 child subtask "เชื่อมชั้น 3" (s2a, done, weight 20).
//   computeNodeStats('s2', ...) -> derives from s2a (1/1 done) -> done, weight 20
//   computeNodeStats('p1', ...) -> derives from s1+s2 (2/2 done) -> done, weight 30
// ============================================================
import { computePhaseTaskStats } from './phaseTasksCalc.js'

/**
 * Groups subtasks by their direct parent's id: a phase's id maps to its
 * direct-child subtasks (parent_subtask_id null); a subtask's id maps to
 * ITS direct-child subtasks (parent_subtask_id === that subtask's id).
 */
export function groupSubtasksByParent(subtasks) {
  const m = {}
  subtasks.forEach((s) => {
    const key = s.parent_subtask_id || s.phase_id
    ;(m[key] ||= []).push(s)
  })
  return m
}

/** True when a node (identified by id -- a phase or a subtask) has zero
 *  child subtasks, i.e. it's where Kanban microtasks may attach. */
export function isLeaf(nodeId, subtasksByParent) {
  return !(subtasksByParent[nodeId] && subtasksByParent[nodeId].length > 0)
}

/**
 * Recursive status/billing roll-up for one node:
 *   - >=1 child subtask -> derive done/total + derivedStatus from the
 *     children's OWN derived statuses (recursing), and billingWeightPct
 *     = sum of the children's own billingWeightPct-or-manual-weight
 *   - else >=1 microtask -> derive from microtasks via the existing
 *     computePhaseTaskStats (source: 'microtasks'); billingWeightPct
 *     stays null (the node's own manual billing_weight_pct still
 *     applies -- microtasks never carry a weight of their own)
 *   - else -> not derivable; source: 'manual', caller uses the node's
 *     own manual status/billing_weight_pct fields directly
 */
export function computeNodeStats(nodeId, subtasksByParent, microtasksByNodeId) {
  const children = subtasksByParent[nodeId] || []
  if (children.length > 0) {
    const childStats = children.map((c) => {
      const stats = computeNodeStats(c.id, subtasksByParent, microtasksByNodeId)
      const weight = stats.billingWeightPct != null ? stats.billingWeightPct : (Number(c.billing_weight_pct) || 0)
      return { ...stats, weight }
    })
    const total = childStats.length
    const done = childStats.filter((s) => s.derivedStatus === 'done').length
    const derivedStatus = done === total
      ? 'done'
      : childStats.some((s) => s.derivedStatus && s.derivedStatus !== 'not_started') ? 'in_progress' : 'not_started'
    const billingWeightPct = childStats.reduce((sum, s) => sum + s.weight, 0)
    return { total, done, pct: Math.round((done / total) * 100), derivedStatus, billingWeightPct, source: 'subtasks' }
  }
  const microtasks = microtasksByNodeId[nodeId] || []
  if (microtasks.length > 0) {
    const stats = computePhaseTaskStats(microtasks)
    return { ...stats, billingWeightPct: null, source: 'microtasks' }
  }
  return { total: 0, done: 0, pct: 0, derivedStatus: null, billingWeightPct: null, source: 'manual' }
}

/**
 * Every leaf node (phase or subtask with zero child subtasks) across a
 * site's full tree, each still carrying its own dates/billing_weight_pct
 * -- flattened once here so callers (the S-curve) never need to know or
 * care how deep any branch goes.
 */
export function flattenLeaves(phases, subtasksByParent) {
  const leaves = []
  const walk = (node) => {
    const children = subtasksByParent[node.id] || []
    if (children.length === 0) { leaves.push(node); return }
    children.forEach(walk)
  }
  phases.forEach(walk)
  return leaves
}

/**
 * Depth-first list of every row to render: each phase, then (only if its
 * id is in expandedIds) its direct child subtasks, then (only if THAT
 * subtask's id is also in expandedIds) its own children, recursively.
 * depth is for indentation only (0 = phase row).
 */
export function flattenVisibleRows(phases, subtasksByParent, expandedIds) {
  const rows = []
  const walk = (node, depth, isPhase) => {
    rows.push({ node, depth, isPhase })
    if (!expandedIds.has(node.id)) return
    ;(subtasksByParent[node.id] || []).forEach((c) => walk(c, depth + 1, false))
  }
  phases.forEach((p) => walk(p, 0, true))
  return rows
}

/** Sum of billing_weight_pct among a parent's current direct-child
 *  subtasks, excluding one (the subtask being edited, so re-saving it at
 *  its own existing weight doesn't double-count against itself). Used to
 *  hard-block a save that would push the parent's children over 100%. */
export function siblingWeightSum(parentId, subtasksByParent, excludeSubtaskId) {
  const siblings = subtasksByParent[parentId] || []
  return siblings
    .filter((s) => s.id !== excludeSubtaskId)
    .reduce((sum, s) => sum + (Number(s.billing_weight_pct) || 0), 0)
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --run subtaskCalc`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/pages/sites/subtaskCalc.js src/pages/sites/subtaskCalc.test.js
git commit -m "feat: recursive subtask tree math (status/billing roll-up, leaf-flatten, visible-rows)"
```

---

### Task 3: Hooks — `useSubtasks()` and `usePhaseTasks()` update

**Files:**
- Modify: `src/hooks/useSupabase.js:684-700` (the existing `useSitePhases`/`usePhaseTasks` block)

**Interfaces:**
- Produces: `useSubtasks() => { data: subtask[], refetch }` — every `phase_subtasks` row across every site, same shape/ordering convention as `useSitePhases()`.
- Consumes: `useQuery`, `fetchAllRows`, `supabase` — already defined earlier in this file, unchanged.

- [ ] **Step 1: Add `useSubtasks()` and update `usePhaseTasks()`'s select**

The current block (verify against your own read of the file — line numbers
may have shifted slightly since this plan was written):

```js
export function useSitePhases() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('site_phases')
    .select('*')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}

/** งานย่อยของขั้นตอน (Kanban) ทุกไซท์ — group ฝั่ง client ด้วย phase_id/
 *  site_id. phase_task_workers ฝังมาด้วย (embed) เป็น [{worker_id}] ต่อแถว. */
export function usePhaseTasks() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('phase_tasks')
    .select('*, phase_task_workers(worker_id, is_lead)')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}
```

Replace with:

```js
export function useSitePhases() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('site_phases')
    .select('*')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}

/** ขั้นตอนย่อย (Subtask) ทุกไซท์ ทุกชั้น -- ซ้อนกันได้ไม่จำกัดชั้นผ่าน
 *  parent_subtask_id (null = ลูกตรงของ phase_id) -- group/จัดชั้นฝั่ง
 *  client ด้วย src/pages/sites/subtaskCalc.js's groupSubtasksByParent. */
export function useSubtasks() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('phase_subtasks')
    .select('*')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}

/** งานย่อยของขั้นตอน (Kanban) ทุกไซท์ — group ฝั่ง client ด้วย phase_id/
 *  subtask_id/site_id. phase_task_workers ฝังมาด้วย (embed) เป็น
 *  [{worker_id}] ต่อแถว. subtask_id เป็น null เมื่อการ์ดนี้ติดอยู่กับ
 *  phase โดยตรง (ยังไม่มีขั้นตอนย่อย) หรือมีค่าเมื่อติดอยู่กับ subtask
 *  ที่เป็น leaf. */
export function usePhaseTasks() {
  return useQuery(async () => fetchAllRows(() => supabase
    .from('phase_tasks')
    .select('*, phase_task_workers(worker_id, is_lead)')
    .order('site_id', { ascending: true })
    .order('sort_order', { ascending: true })))
}
```

(`usePhaseTasks`'s `select('*, ...)` already returns every column including
the new `subtask_id` via `*` — no select-string change needed there, only
the new `useSubtasks()` hook is new code.)

- [ ] **Step 2: Build**

Run: `npm run build`
Expected: succeeds, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/hooks/useSupabase.js
git commit -m "feat: add useSubtasks() hook for phase_subtasks"
```

---

### Task 4: GanttView — recursive row rendering, expand/collapse, click-to-Kanban

**Files:**
- Modify: `src/pages/sites/GanttView.jsx`

**Interfaces:**
- Consumes: `useSubtasks()` (Task 3), `groupSubtasksByParent`, `computeNodeStats`, `isLeaf`, `flattenVisibleRows` (Task 2).
- Produces: `GanttView` gains a new optional prop `onOpenKanban?: (site, leafNode, isPhase) => void` — called when a leaf row's bar is clicked. `SiteDetail.jsx` (the parent that renders both `GanttView` and `PhaseKanbanBoard` as tabs) wires this to switch to the Kanban tab and pass down which leaf to pre-select — that wiring is Task 6, not this task; for now `onOpenKanban` may be left undefined and the click becomes a no-op, so this task ships and is reviewable standalone.

**Design notes for the implementer:**

This task is READ/render-only — it does **not** change how adding, editing,
or deleting a phase works (that stays exactly as today's code, unchanged,
including the top "+ เพิ่มขั้นตอน" button). It only adds: fetching
subtasks, computing recursive stats instead of the current one-level
`phaseStatsById`, rendering subtask rows nested under their expanded
parents, and the leaf-click-to-Kanban callback. Task 5 is what changes
the add/edit flow itself.

- [ ] **Step 1: Import the new hook and calc functions**

At the top of the file (currently lines 9-17), add to the existing imports:

```js
import { useSitePhases, usePhaseTasks, useSubtasks, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
```
(added `useSubtasks` to the existing import line)

```js
import { computePhaseTaskStats } from './phaseTasksCalc.js'
import { groupSubtasksByParent, computeNodeStats, isLeaf, flattenVisibleRows } from './subtaskCalc.js'
```
(new import line, right after the existing `phaseTasksCalc.js` import)

- [ ] **Step 2: Fetch subtasks and build lookup maps**

Right after the existing `const { data: allTasks } = usePhaseTasks()` (line 43), add:

```js
  const { data: allSubtasks } = useSubtasks()
```

Right after the existing `tasksByPhaseId` useMemo block (lines 71-78), add two new memos:

```js
  // งานย่อย (Kanban) group ตาม "โหนดแม่" ที่แท้จริง -- ติดกับ subtask_id
  // ถ้ามี (แปลว่าติดอยู่กับ subtask ที่เป็น leaf) ไม่งั้นติดกับ phase_id ตรงๆ
  // (โหนดแม่คนละใบไม่มีทางชนกัน id เพราะมาจากคนละตาราง)
  const microtasksByNodeId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => {
      const key = t.subtask_id || t.phase_id
      ;(m[key] ||= []).push(t)
    })
    return m
  }, [allTasks])

  // subtask ทุกไซท์ -- filter เฉพาะของไซท์นี้ในมุมมองไซท์เดียวด้านล่าง
  const subtasksBySite = useMemo(() => {
    const m = {}
    ;(allSubtasks || []).forEach((s) => { (m[s.site_id] ||= []).push(s) })
    return m
  }, [allSubtasks])
```

- [ ] **Step 3: Add expand/collapse state**

Right after the existing `const [applyingTemplate, setApplyingTemplate] = useState(false)` (line 54), add:

```js
  // id ของ phase/subtask ที่กางลูกอยู่ (Set รวม id ทั้งสองตารางในที่เดียว
  // เพราะไม่มีทางชนกัน -- ดู subtaskCalc.js's groupSubtasksByParent)
  const [expandedIds, setExpandedIds] = useState(() => new Set())
  const toggleExpanded = (nodeId) => setExpandedIds((prev) => {
    const next = new Set(prev)
    if (next.has(nodeId)) next.delete(nodeId); else next.add(nodeId)
    return next
  })
```

- [ ] **Step 4: Replace the one-level `phaseStatsById` with recursive node stats**

Replace this block (lines 182-189):

```js
    // สถานะที่ "แสดงจริง" ต่อขั้นตอน: ถ้ามี phase_tasks (Kanban) แล้ว คำนวณสด
    // จาก done/total แทนค่า status ที่ตั้งเอง -- ขั้นตอนที่ไม่มี task เลย
    // ยังใช้ status ที่ตั้งเองเหมือนเดิมทุกประการ (ไม่มี regression)
    const phaseStatsById = {}
    phases.forEach((p) => {
      const stats = computePhaseTaskStats(tasksByPhaseId[p.id] || [])
      phaseStatsById[p.id] = { stats, displayStatus: stats.total > 0 ? stats.derivedStatus : p.status }
    })
```

with:

```js
    const subtasks = subtasksBySite[site.id] || []
    const subtasksByParent = useMemo(() => groupSubtasksByParent(subtasks), [subtasks])
    const byNodeId = {} // phase or subtask id -> the object itself, for O(1) lookup by id
    phases.forEach((p) => { byNodeId[p.id] = p })
    subtasks.forEach((s) => { byNodeId[s.id] = s })

    // สถานะ/% เบิกเงินที่ "แสดงจริง" ต่อโหนด (phase หรือ subtask ชั้นไหนก็ได้):
    // มี subtask ลูก -> คำนวณสดจากลูก (ซ้ำไปเรื่อยๆ); ไม่มีลูกแต่มี
    // phase_tasks (Kanban) -> คำนวณสดจากงานย่อย; ไม่มีทั้งคู่ -> ใช้ค่าที่
    // ตั้งเอง (ไม่มี regression กับ node ที่ยังไม่มี subtask เลย)
    const nodeStatsById = {}
    const collectStats = (node) => {
      const stats = computeNodeStats(node.id, subtasksByParent, microtasksByNodeId)
      const displayStatus = stats.derivedStatus != null ? stats.derivedStatus : node.status
      const displayWeight = stats.billingWeightPct != null ? stats.billingWeightPct : node.billing_weight_pct
      nodeStatsById[node.id] = { stats, displayStatus, displayWeight }
      ;(subtasksByParent[node.id] || []).forEach(collectStats)
    }
    phases.forEach(collectStats)
```

(Note: `useMemo` cannot normally be called conditionally/after an early
`if` — but this whole block already lives inside `if (sites.length === 1)`,
which itself comes after every OTHER hook call in the component, matching
this file's existing pattern (see the file's own top comment: "hooks ต้อง
อยู่บนสุดเสมอ" refers to the OUTER component-level hooks, all already
called unconditionally above; nothing inside this `if` block below calls
a NEW hook — `subtasksByParent` uses `useMemo`, which... is itself a hook.
**Fix:** hoist `const subtasksByParent = useMemo(() => groupSubtasksByParent(allSubtasks || []), [allSubtasks])`
up to the component's top level, alongside the other memos in Step 2,
computed once over ALL sites' subtasks (cheap, small dataset, same
pattern `phasesBySite`/`tasksByPhaseId` already use), then simply reuse
that top-level `subtasksByParent` here instead of recomputing it inside
the `if` block. Remove the `useMemo(...)` line shown above from inside
the `if` block and keep only:
`const subtasks = subtasksBySite[site.id] || []` followed directly by
`const byNodeId = {}` — `subtasksByParent` here refers to the top-level
one from Step 2.)

Revised Step 2 addition (supersedes the version above — add this instead,
right after `subtasksBySite`):

```js
  const subtasksByParent = useMemo(() => groupSubtasksByParent(allSubtasks || []), [allSubtasks])
```

- [ ] **Step 5: Update every other use of `phaseStatsById`/`p.status`/`p.billing_weight_pct` in this branch to `nodeStatsById`**

Three call sites need updating (`ps = phaseStatsById[phase.id]` and its
two field accesses, `ps.stats.total`/`ps.displayStatus`):

Line 218-219 (`doneCount`/`inProgressCount`) — change
`phaseStatsById[p.id].displayStatus` to `nodeStatsById[p.id].displayStatus`
(phase-level KPI cards stay phase-only, unaffected by nesting).

Line 278 (`const ps = phaseStatsById[phase.id]`) — this line moves into
the new recursive row-rendering loop written in Step 6 below; don't edit
it in place, it's replaced wholesale.

- [ ] **Step 6: Replace `rows`/row-rendering with the recursive flattened list**

Replace the `rows` construction (lines 179-180):

```js
    const isAdding = editingId === '__new__'
    const rows = isAdding ? [...phases, { id: '__new__', isNew: true }] : phases
```

with (the `isAdding`/`'__new__'` editing-row insertion is deferred to
Task 5 — for this task, `rows` is simply the flattened visible tree):

```js
    const visibleRows = flattenVisibleRows(phases, subtasksByParent, expandedIds)
```

Replace the row-rendering loop (lines 274-390, the `{rows.map((phase, i) => { ... })}` block) —
keep the existing `isEditingThis` branch's JSX **completely unchanged**
(editing still only ever targets a phase in this task; Task 5 generalizes
it), but change what feeds it and add the depth-based indent + expand
toggle + leaf-click-to-Kanban:

```js
            {visibleRows.map(({ node, depth, isPhase }, i) => {
              const top = rowTops[i]
              const isEditingThis = editingId === node.id
              const style = barStyle(node, range)
              const ns = nodeStatsById[node.id]
              const nodeIsLeaf = isLeaf(node.id, subtasksByParent)

              if (isEditingThis) {
                // ... existing edit-panel JSX from lines 281-345, unchanged,
                // with every `phase.` reference renamed to `node.` and
                // `phases.filter((p) => p.id !== editingId)` (the "ขึ้นอยู่กับ
                // ขั้นตอน" dependency dropdown) staying phase-only for now
                // (Task 5 generalizes depends_on to subtask siblings)
              }

              const displayStatus = ns.displayStatus
              const label = displayStatus === 'done' ? '✓'
                : displayStatus === 'in_progress' ? (ns.stats.total > 0 ? `${ns.stats.pct}%` : 'กำลังทำ')
                : ''
              const titleSuffix = ns.stats.total > 0 ? ` (${ns.stats.done}/${ns.stats.total} ${ns.stats.source === 'subtasks' ? 'ขั้นตอนย่อยเสร็จ' : 'งานย่อยเสร็จ'})` : ''
              const hasChildren = !nodeIsLeaf

              return (
                <div key={node.id} style={{ position: 'absolute', top, left: 0, right: 0, height: ROW_H, display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ width: LABEL_W, flexShrink: 0, fontSize: 12.5, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', paddingLeft: depth * 16 }} title={node.name}>
                    {node.name}
                  </div>
                  <div
                    style={{ position: 'relative', flex: 1, height: 20, background: 'var(--bg3)', borderRadius: 5, cursor: hasChildren || (!isPhase && nodeIsLeaf) ? 'pointer' : 'default' }}
                    onClick={() => {
                      if (hasChildren) toggleExpanded(node.id)
                      else if (nodeIsLeaf) onOpenKanban?.(site, node, isPhase)
                    }}
                  >
                    {style && (
                      <div
                        title={`${node.name}\n${node.start_date} → ${node.end_date}\nสถานะ: ${displayStatus}${titleSuffix}`}
                        style={{
                          position: 'absolute', top: 2, bottom: 2, left: style.left, width: style.width,
                          background: STATUS_COLOR[displayStatus] || STATUS_COLOR.not_started, borderRadius: 5,
                          display: 'flex', alignItems: 'center', justifyContent: 'center',
                          fontSize: 10, fontWeight: 700, color: displayStatus === 'not_started' ? 'var(--text3)' : '#fff',
                          overflow: 'hidden', whiteSpace: 'nowrap',
                        }}
                      >
                        {hasChildren ? (expandedIds.has(node.id) ? '▾ ' : '▸ ') : ''}{label}
                      </div>
                    )}
                    {canEdit && !editingId && isPhase && (
                      <button type="button" className="btn btn-sm btn-ghost"
                        style={{ position: 'absolute', top: '50%', right: 2, transform: 'translateY(-50%)', width: EDIT_BTN_W, padding: '2px 0', opacity: 0.85 }}
                        onClick={(e) => { e.stopPropagation(); startEdit(node) }}>✎</button>
                    )}
                  </div>
                </div>
              )
            })}
```

(The ✎ edit button is scoped to `isPhase` rows only in this task —
subtask edit/add is Task 5's job. `rowTops`/`bodyHeight`/`cursor` just
above this loop already iterate `rows` generically by array index, so
they keep working unchanged once `rows` → `visibleRows.map(r => r.node)`-
shaped for that computation; update the `rows.map((r) => {...})` at
lines 230-234 to `visibleRows.map(({ node }) => {...})` using `node.id`
in place of `r.id` for the `editingId` comparison.)

- [ ] **Step 7: Build and test**

Run: `npm run build && npm test -- --run`
Expected: build succeeds; all existing 176+ tests plus Task 2's new
`subtaskCalc.test.js` tests pass. No visual regression for any site that
has zero subtasks (every node stays a leaf, `hasChildren` is always
false, rendering is pixel-identical to before this task).

- [ ] **Step 8: Live-verify**

On a site with zero subtasks (e.g. any existing seeded site), confirm the
Gantt tab renders identically to before. This task ships no way to
actually CREATE a subtask yet (that's Task 5) — verification here is
"nothing broke," not "subtasks work."

- [ ] **Step 9: Commit**

```bash
git add src/pages/sites/GanttView.jsx
git commit -m "feat: recursive subtask row rendering, expand/collapse, leaf click-through"
```

---

### Task 5: GanttView — unified add flow, subtask edit/delete, "Kanban เก่า" auto-move

**Files:**
- Modify: `src/pages/sites/GanttView.jsx` (continues directly on top of Task 4)

**Interfaces:**
- Consumes: `siblingWeightSum`, `isLeaf` (Task 2); `phase_subtasks` table (Task 1).
- Produces: the "+ เพิ่มขั้นตอน" button and the row-level (non-phase) ✎ button both open the same add/edit form, now with a "เพิ่มภายใต้" parent picker.

**Design notes for the implementer:** this is the task that changes what
`editingId`/`draft`/`saveDraft`/`doDelete` mean. Read Task 4's diff fully
first — this task edits several of the same regions again.

- [ ] **Step 1: Generalize the editing-id encoding**

Replace the `emptyDraft` helper (lines 36-39):

```js
const emptyDraft = (site, phases) => ({
  name: '', start_date: '', end_date: '', status: 'not_started',
  billing_weight_pct: 0, depends_on_phase_id: '', sort_order: phases.length + 1,
})
```

with:

```js
// editingId แทนด้วย string เข้ารหัสไว้ (ไม่ใช้ object) เพื่อคง pattern
// `editingId === someId` แบบเดิมของไฟล์นี้ให้มากที่สุด:
//   "phase:<id>"                      -- แก้ไข phase เดิม
//   "subtask:<id>"                    -- แก้ไข subtask เดิม
//   "new-phase"                       -- เพิ่ม phase ใหม่ระดับบนสุด
//   "new-subtask:<parentKind>:<parentId>" -- เพิ่ม subtask ใหม่ ใต้ parentKind
//                                         ('phase' หรือ 'subtask') id=parentId
const parseEditingId = (editingId) => {
  if (!editingId) return null
  if (editingId === 'new-phase') return { kind: 'phase', isNew: true }
  if (editingId.startsWith('new-subtask:')) {
    const [, parentKind, parentId] = editingId.split(':')
    return { kind: 'subtask', isNew: true, parentKind, parentId }
  }
  const [kind, id] = editingId.split(':')
  return { kind, id, isNew: false }
}

const emptyDraft = (sortOrder) => ({
  name: '', start_date: '', end_date: '', status: 'not_started',
  billing_weight_pct: 0, depends_on_id: '', sort_order: sortOrder,
})
```

- [ ] **Step 2: Rewrite `startEdit`/`startAdd`/`saveDraft`/`doDelete`**

Replace lines 113-159 (`startEdit` through the end of `doDelete`) with:

```js
  const startEdit = (kind, node) => {
    setEditingId(`${kind}:${node.id}`)
    setDraft({
      ...node,
      depends_on_id: kind === 'phase' ? (node.depends_on_phase_id || '') : (node.depends_on_subtask_id || ''),
    })
  }
  const startAdd = (parentKind, parentId, sortOrder) => {
    setEditingId(parentKind ? `new-subtask:${parentKind}:${parentId}` : 'new-phase')
    setDraft(emptyDraft(sortOrder))
  }
  const cancelEdit = () => { setEditingId(null); setDraft(null) }

  const saveDraft = async (site) => {
    if (!draft.name.trim()) { alert('กรุณาตั้งชื่อขั้นตอน'); return }
    const parsed = parseEditingId(editingId)
    const isSubtask = parsed.kind === 'subtask'

    // hard-block: ผลรวม % เบิกเงินของ "พี่น้อง" ใต้พ่อแม่เดียวกันต้องไม่เกิน
    // 100 -- ตรวจก่อนเขียนเสมอ ทั้งตอนแก้ subtask เดิมและเพิ่มใหม่
    if (isSubtask) {
      const parentId = parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)
      const excludeId = parsed.isNew ? null : parsed.id
      const already = siblingWeightSum(parentId, subtasksByParent, excludeId)
      const thisWeight = parseFloat(draft.billing_weight_pct) || 0
      if (already + thisWeight > 100) {
        alert(`% เบิกเงินรวมของขั้นตอนย่อยใต้พ่อแม่เดียวกันเกิน 100% (มีอยู่แล้ว ${already}% + ${thisWeight}% ที่กำลังบันทึก) — กรุณาปรับตัวเลข`)
        return
      }
    }

    setSaving(true)
    try {
      if (!isSubtask) {
        // ── Phase (site_phases) -- เหมือนเดิมทุกประการ ──
        const payload = {
          name: draft.name.trim(), start_date: draft.start_date || null, end_date: draft.end_date || null,
          status: draft.status, billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
          depends_on_phase_id: draft.depends_on_id || null, sort_order: draft.sort_order,
        }
        if (parsed.isNew) {
          const { error } = await supabase.from('site_phases').insert({ site_id: site.id, ...payload })
          if (error) throw error
        } else {
          const { error } = await supabase.from('site_phases').update(payload).eq('id', parsed.id)
          if (error) throw error
        }
      } else {
        // ── Subtask (phase_subtasks) ──
        const parentId = parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)
        const parentKind = parsed.isNew ? parsed.parentKind : (draft.parent_subtask_id ? 'subtask' : 'phase')
        const parentPhaseId = parentKind === 'phase' ? parentId : byNodeId[parentId].phase_id
        const payload = {
          name: draft.name.trim(), start_date: draft.start_date || null, end_date: draft.end_date || null,
          status: draft.status, billing_weight_pct: parseFloat(draft.billing_weight_pct) || 0,
          depends_on_subtask_id: draft.depends_on_id || null, sort_order: draft.sort_order,
        }
        if (parsed.isNew) {
          const { data: created, error } = await supabase.from('phase_subtasks').insert({
            site_id: site.id, tenant_id: site.tenant_id, phase_id: parentPhaseId,
            parent_subtask_id: parentKind === 'subtask' ? parentId : null,
            ...payload,
          }).select().single()
          if (error) throw error

          // โหนดแม่มีงานย่อย (Kanban) ติดอยู่โดยตรงอยู่แล้ว และนี่คือลูกใบ
          // แรกที่เพิ่มให้มัน -- ย้ายงานย่อยเดิมไปไว้ใน subtask ใหม่ชื่อ
          // "Kanban เก่า" (สร้างแยกจาก subtask ที่ผู้ใช้กำลังตั้งชื่อ ไม่ปน
          // กัน) แทนที่จะบล็อกหรือทำหาย -- สร้างที่เก็บใหม่ก่อน ค่อย repoint
          // ของเดิมเข้าไป (ปลอดภัยถ้า step หลังพลาด ของเดิมก็แค่ยังอยู่ที่เดิม)
          const existingMicrotasks = microtasksByNodeId[parentId] || []
          const wasFirstChild = (subtasksByParent[parentId] || []).length === 0
          if (existingMicrotasks.length > 0 && wasFirstChild) {
            const { data: oldHolder, error: holderErr } = await supabase.from('phase_subtasks').insert({
              site_id: site.id, tenant_id: site.tenant_id, phase_id: parentPhaseId,
              parent_subtask_id: parentKind === 'subtask' ? parentId : null,
              name: 'Kanban เก่า', start_date: null, end_date: null, billing_weight_pct: 0,
              status: 'not_started', sort_order: (draft.sort_order || 0) + 1,
            }).select().single()
            if (holderErr) throw holderErr
            const { error: moveErr } = await supabase.from('phase_tasks')
              .update({ subtask_id: oldHolder.id })
              .in('id', existingMicrotasks.map((t) => t.id))
            if (moveErr) throw moveErr
          }
        } else {
          const { error } = await supabase.from('phase_subtasks').update(payload).eq('id', parsed.id)
          if (error) throw error
        }
      }
      await afterWrite()
      cancelEdit()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (kind, id) => {
    setSaving(true)
    try {
      const table = kind === 'phase' ? 'site_phases' : 'phase_subtasks'
      const { error } = await supabase.from(table).delete().eq('id', id)
      if (error) throw error
      await afterWrite()
      if (editingId === `${kind}:${id}`) cancelEdit()
    } catch (e) {
      alert('ลบไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
      setConfirmDeleteId(null)
    }
  }
```

(`confirmDeleteId` becomes a `{kind, id}` object instead of a bare id —
update its `useState(null)` initializer's usages accordingly wherever
it's set/read in this file, e.g. `setConfirmDeleteId({kind, id})` and
`onConfirm={() => doDelete(confirmDeleteId.kind, confirmDeleteId.id)}`.)

- [ ] **Step 3: The "+ เพิ่มขั้นตอน" button gains the parent picker**

Replace the existing button (lines 253-255):

```jsx
            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(site, phases)}>+ เพิ่มขั้นตอน</button>
            )}
```

with a button that opens the SAME inline edit panel shape (reusing
`isEditingThis`'s JSX from Task 4, which needs one addition: a "เพิ่ม
ภายใต้" select as the FIRST field, visible only while `parsed.isNew`):

```jsx
            {canEdit && !editingId && (
              <button type="button" className="btn btn-ghost btn-sm" onClick={() => startAdd(null, null, phases.length + 1)}>+ เพิ่มขั้นตอน</button>
            )}
```

Inside the edit-panel JSX (from Task 4's `if (isEditingThis) { ... }`
branch), immediately before the existing "ชื่อขั้นตอน" name input, add:

```jsx
{parsed.isNew && (
  <label style={{ fontSize: 11, color: 'var(--text3)' }}>
    เพิ่มภายใต้
    <select className="select" style={{ width: '100%', marginTop: 2 }}
      value={parsed.parentKind ? `${parsed.parentKind}:${parsed.parentId}` : ''}
      onChange={(e) => {
        const v = e.target.value
        if (!v) { setEditingId('new-phase'); return }
        const [pk, pid] = v.split(':')
        setEditingId(`new-subtask:${pk}:${pid}`)
      }}>
      <option value="">— ไม่มี (ขั้นตอนใหม่ระดับบนสุด) —</option>
      {visibleRows.map(({ node, isPhase }) => (
        <option key={node.id} value={`${isPhase ? 'phase' : 'subtask'}:${node.id}`}>
          {'　'.repeat(visibleRows.find((r) => r.node.id === node.id).depth)}{node.name}
        </option>
      ))}
    </select>
  </label>
)}
```

- [ ] **Step 4: Add the per-row "+" affordance for adding a subtask under a specific node**

In the row JSX from Task 4, next to the phase-only ✎ button, add (for
EVERY row now, not just phases):

```jsx
{canEdit && !editingId && (
  <button type="button" className="btn btn-sm btn-ghost"
    style={{ position: 'absolute', top: '50%', right: isPhase ? EDIT_BTN_W + 6 : 2, transform: 'translateY(-50%)', width: EDIT_BTN_W, padding: '2px 0', opacity: 0.85 }}
    title="เพิ่มขั้นตอนย่อยใต้นี้"
    onClick={(e) => { e.stopPropagation(); startAdd(isPhase ? 'phase' : 'subtask', node.id, ((subtasksByParent[node.id] || []).length) + 1) }}>
    +
  </button>
)}
```

- [ ] **Step 5: "ขึ้นอยู่กับขั้นตอน" dependency dropdown scopes to siblings**

Replace the existing dropdown (from the edit panel, currently scoped to
`phases.filter((p) => p.id !== editingId)`) with a version scoped to
siblings under the same parent (matches the spec's "siblings only"
dependency rule):

```jsx
<label style={{ fontSize: 11, color: 'var(--text3)' }}>
  ขึ้นอยู่กับขั้นตอน
  <select className="select" style={{ width: '100%', marginTop: 2 }}
    value={draft.depends_on_id || ''} onChange={(e) => setDraft((d) => ({ ...d, depends_on_id: e.target.value }))}>
    <option value="">— ไม่ขึ้นกับขั้นตอนอื่น —</option>
    {(parsed.kind === 'phase'
      ? phases.filter((p) => p.id !== parsed.id)
      : (subtasksByParent[parsed.isNew ? parsed.parentId : (draft.parent_subtask_id || draft.phase_id)] || []).filter((s) => s.id !== parsed.id)
    ).map((n) => (
      <option key={n.id} value={n.id}>{n.name || '(ยังไม่ตั้งชื่อ)'}</option>
    ))}
  </select>
</label>
```

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test -- --run`
Expected: green.

- [ ] **Step 7: Live-verify**

On a test site: add a phase (top-level, parent picker left as "ไม่มี") —
confirm unchanged from before. Add a subtask under a phase that already
has ≥1 Kanban card — confirm the new subtask is created empty AND a
second "Kanban เก่า" sibling appears holding the old cards (check via
Supabase MCP: `select name, subtask_id from phase_tasks where phase_id = '<phase id>'`
shows the old cards' `subtask_id` now pointing at "Kanban เก่า"'s id).
Try to push a subtask's weight over 100% among siblings — confirm the
save is refused with the inline alert, nothing written. Clean up test
data afterward (delete the test phase/subtasks), matching this session's
established practice.

- [ ] **Step 8: Commit**

```bash
git add src/pages/sites/GanttView.jsx
git commit -m "feat: unified add-subtask flow with parent picker and Kanban-เก่า auto-move"
```

---

### Task 6: PhaseKanbanBoard — multi-tier chip navigation

**Files:**
- Modify: `src/pages/sites/PhaseKanbanBoard.jsx`
- Modify: whichever parent component renders both `<GanttView onOpenKanban=.../>` and `<PhaseKanbanBoard/>` as sibling tabs (locate it: `grep -rn "PhaseKanbanBoard" src/pages/sites/` — likely `SiteDetail.jsx`) — wire `GanttView`'s `onOpenKanban` callback (added in Task 4) to switch to the Kanban tab and pass the clicked leaf down.

**Interfaces:**
- Consumes: `useSubtasks()` (Task 3), `groupSubtasksByParent`, `isLeaf` (Task 2).
- Produces: `PhaseKanbanBoard` gains an optional prop `initialLeafId?: string` — when set on mount, pre-selects the chip chain down to that leaf instead of defaulting to "ทั้งหมด".

**Design notes for the implementer:** the existing component's chip row
and board-selection state (`selectedPhaseId`, `ALL_PHASES`) generalizes to
a **chain** of selected ids, one per tier, instead of a single id.

- [ ] **Step 1: Replace single-tier selection state with a chain**

Replace:
```js
  const [selectedPhaseId, setSelectedPhaseId] = useState(ALL_PHASES)
```
with:
```js
  // เชนของ id ที่เลือกไว้ต่อชั้น: selectedChain[0] = phase (หรือ ALL_PHASES),
  // selectedChain[1] = subtask ชั้น 1 ที่เลือกใต้ phase นั้น, [2] = ชั้น 2, ...
  // ยาวเท่าที่ลึกจนถึง leaf ที่กำลังโฟกัสอยู่
  const [selectedChain, setSelectedChain] = useState(() => [ALL_PHASES])
  const { data: allSubtasks } = useSubtasks()
```

- [ ] **Step 2: Build subtask lookup, generalize `tasksByPhaseId` to `microtasksByNodeId`**

Replace the `tasksByPhaseId` memo with the same `microtasksByNodeId`
shape Task 4 introduced in `GanttView.jsx` (identical logic, duplicated
here since these are separate components — acceptable per this file's
existing self-containedness), plus a `subtasksByParent` memo:

```js
  const subtasksByParent = useMemo(() => groupSubtasksByParent((allSubtasks || []).filter((s) => s.site_id === site.id)), [allSubtasks, site.id])
  const microtasksByNodeId = useMemo(() => {
    const m = {}
    ;(allTasks || []).forEach((t) => { const key = t.subtask_id || t.phase_id; (m[key] ||= []).push(t) })
    return m
  }, [allTasks])
```

- [ ] **Step 3: Derive the active leaf from the chain, and the chip options at each tier**

Replace `isAllPhases`/`activePhaseId`/`phaseTasks` (lines 62-64) with:

```js
  const isAllPhases = selectedChain[0] === ALL_PHASES
  // เดินตาม chain ทีละชั้น หยุดที่ node สุดท้ายที่ระบุไว้จริง (ชั้นที่ยังไม่
  // ได้เลือกอะไรก็หยุดตรงนั้น) -- activeLeafId คือโหนดที่บอร์ดกำลังโฟกัส
  const activeLeafId = isAllPhases ? null : selectedChain[selectedChain.length - 1]
  const leafMicrotasks = activeLeafId ? (microtasksByNodeId[activeLeafId] || []) : []
```

- [ ] **Step 4: Render one chip row per tier, only while the previous tier's selection has children**

Replace the single chip row (lines 209-229) with:

```jsx
      {selectedChain.map((selectedAtThisTier, tier) => {
        const parentId = tier === 0 ? null : selectedChain[tier - 1]
        const options = tier === 0 ? phases : (subtasksByParent[parentId] || [])
        if (tier > 0 && options.length === 0) return null // พ่อแม่ชั้นก่อนไม่มีลูกแล้ว ไม่ต้องโชว์แถวนี้
        return (
          <div key={tier} style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 8, flexWrap: 'wrap', fontSize: 12.5, color: 'var(--text2)' }}>
            {tier === 0 ? 'เฟส:' : 'ขั้นตอนย่อย:'}
            {tier === 0 && (
              <span onClick={() => setSelectedChain([ALL_PHASES])}
                style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer', background: isAllPhases ? 'var(--accent)' : 'transparent', color: isAllPhases ? '#fff' : 'var(--text2)' }}>
                🗂 ทั้งหมด
              </span>
            )}
            {options.map((n) => (
              <span key={n.id}
                onClick={() => setSelectedChain([...selectedChain.slice(0, tier), n.id])}
                style={{ border: '1px solid var(--border)', borderRadius: 20, padding: '5px 13px', fontWeight: 600, cursor: 'pointer', background: selectedAtThisTier === n.id ? 'var(--accent)' : 'transparent', color: selectedAtThisTier === n.id ? '#fff' : 'var(--text2)' }}>
                {n.name}
              </span>
            ))}
          </div>
        )
      })}
```

- [ ] **Step 5: Board rendering uses `leafMicrotasks`/`activeLeafId` instead of `phaseTasks`/`activePhaseId`**

Every remaining reference to `phaseTasks`, `activePhaseId`,
`tasksByPhaseId[phase.id]` in the render body and in `startAdd`/
`saveDraft`'s insert payload (`phase_id: draft.phase_id`) needs the
generalized equivalent: `leafMicrotasks`, `activeLeafId`, and the insert
payload becomes `{ phase_id: isLeafAPhase ? activeLeafId : byNodeId[activeLeafId].phase_id, subtask_id: isLeafAPhase ? null : activeLeafId, ...payload }`
(mirrors the `phase_id`/`subtask_id` shape Task 5 already established in
`GanttView.jsx`'s subtask-insert path — copy that exact convention here).
The "ทั้งหมด" overview loop (`phasesWithTasks.map(...)`) stays phase-only
groupings for now (out of scope per the spec — "Kanban UI" section only
requires groupings "down the full chain... until a leaf," which the
per-phase overview already satisfies when a phase itself is the leaf; a
phase WITH subtasks simply shows nothing in the "ทั้งหมด" view for now,
matching the existing "skip empty phases" precedent — note this as a
known limitation in the commit message, not a blocker).

- [ ] **Step 6: Accept `initialLeafId` prop and wire it from the parent**

Add to the component's props and an effect near the top:

```js
export default function PhaseKanbanBoard({ site, canEdit, onTasksChanged, initialLeafId }) {
  // ...
  useEffect(() => {
    if (!initialLeafId || !allSubtasks) return
    // เดินจาก leaf ย้อนกลับขึ้นไปหา phase เพื่อสร้าง chain ทั้งเส้น
    const chain = [initialLeafId]
    let cur = (allSubtasks || []).find((s) => s.id === initialLeafId)
    while (cur && cur.parent_subtask_id) {
      chain.unshift(cur.parent_subtask_id)
      cur = allSubtasks.find((s) => s.id === cur.parent_subtask_id)
    }
    const phaseId = cur ? cur.phase_id : initialLeafId
    setSelectedChain([phaseId, ...chain.filter((id) => id !== phaseId)])
  }, [initialLeafId, allSubtasks])
```
(add `useEffect` to this file's existing `import { useState, useMemo } from 'react'` line)

In the parent component located at the start of this task, wire
`GanttView`'s `onOpenKanban={(site, leafNode, isPhase) => { setActiveTab('kanban'); setKanbanInitialLeafId(leafNode.id) }}`
and pass `initialLeafId={kanbanInitialLeafId}` to `<PhaseKanbanBoard>` —
match that file's own existing tab-switching state pattern (read it
first; don't guess the exact state variable names).

- [ ] **Step 7: Build and test**

Run: `npm run build && npm test -- --run`

- [ ] **Step 8: Live-verify**

Create a subtask with a Kanban card on it (from Task 5's test site).
Click that subtask's bar on the Gantt tab — confirm it switches to
Kanban tab with that subtask's chip chain pre-selected and its card
visible. Clean up test data afterward.

- [ ] **Step 9: Commit**

```bash
git add src/pages/sites/PhaseKanbanBoard.jsx <the wired parent file>
git commit -m "feat: multi-tier Kanban chip navigation + deep-link from Gantt leaf click"
```

---

### Task 7: S-curve — leaf-flattened progressive ramp

**Files:**
- Modify: `src/pages/sites/scurveCalc.js:11-22` (`buildPlanSeries`)
- Modify: `src/pages/sites/scurveCalc.test.js` if it exists (`find . -name scurveCalc.test.js`) — if not, this task creates it
- Modify: `src/pages/sites/SCurveChart.jsx` (the `buildPlanSeries(phasesForSite, ...)` call site, plus fetching subtasks)

**Interfaces:**
- Consumes: `flattenLeaves` (Task 2), `useSubtasks()` (Task 3).
- Changes: `buildPlanSeries(leaves, contractValue)` — same exported name,
  but now ramps linearly across each leaf's own date span instead of
  jumping the whole weight at one date. **Breaking signature change**:
  callers must pass flattened leaves (each with `start_date`, `end_date`,
  `billing_weight_pct`), not raw phases — `SCurveChart.jsx` is this
  function's only caller in the codebase (confirm with
  `grep -rn "buildPlanSeries" src`), so this is safe.

- [ ] **Step 1: Write the failing test**

```js
// src/pages/sites/scurveCalc.test.js (add this describe block; create the
// file with this content if it doesn't already exist — check first)
import { describe, it, expect } from 'vitest'
import { buildPlanSeries } from './scurveCalc.js'

describe('buildPlanSeries', () => {
  it('ramps linearly across a single leaf\'s own date span instead of jumping at the end', () => {
    const leaves = [{ start_date: '2026-08-01', end_date: '2026-08-11', billing_weight_pct: 30 }]
    const series = buildPlanSeries(leaves, 1000000)
    // 10-day span, 30% of 1,000,000 = 300,000 total -> 30,000/day
    expect(series[0]).toEqual({ date: '2026-08-01', value: 0 })
    expect(series.find((p) => p.date === '2026-08-06').value).toBeCloseTo(150000, -2)
    expect(series[series.length - 1]).toEqual({ date: '2026-08-11', value: 300000 })
  })

  it('accumulates across multiple leaves in date order, each ramping across its own span', () => {
    const leaves = [
      { start_date: '2026-08-01', end_date: '2026-08-10', billing_weight_pct: 30 },
      { start_date: '2026-08-11', end_date: '2026-08-20', billing_weight_pct: 30 },
    ]
    const series = buildPlanSeries(leaves, 1000000)
    expect(series[0]).toEqual({ date: '2026-08-01', value: 0 })
    expect(series.find((p) => p.date === '2026-08-10').value).toBeCloseTo(300000, -2)
    expect(series[series.length - 1]).toEqual({ date: '2026-08-20', value: 600000 })
  })

  it('treats a leaf with no dates as contributing nothing (same as the old "filter((p) => p.end_date)" behavior)', () => {
    const leaves = [{ start_date: null, end_date: null, billing_weight_pct: 30 }]
    expect(buildPlanSeries(leaves, 1000000)).toEqual([])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm test -- --run scurveCalc`
Expected: FAIL (`buildPlanSeries` still does the old lump-sum-at-end-date
behavior, values won't match the ramped expectations).

- [ ] **Step 3: Rewrite `buildPlanSeries`**

Replace (current `scurveCalc.js` lines 11-22):

```js
/** Cumulative planned billing: jumps by billing_weight_pct% of contract_value at each phase's end_date. */
export function buildPlanSeries(phases, contractValue) {
  const withEndDate = phases
    .filter((p) => p.end_date)
    .slice()
    .sort((a, b) => a.end_date.localeCompare(b.end_date))
  let cumulative = 0
  return withEndDate.map((p) => {
    cumulative += ((Number(p.billing_weight_pct) || 0) / 100) * (Number(contractValue) || 0)
    return { date: p.end_date, value: cumulative }
  })
}
```

with:

```js
/**
 * Cumulative planned billing: ramps LINEARLY across each leaf's own
 * start_date -> end_date span (contract_value * billing_weight_pct% of
 * that leaf, spread evenly over its days) instead of jumping the whole
 * amount at one date. `leaves` is the flattened leaf list from
 * subtaskCalc.js's flattenLeaves() -- a phase with no subtasks is
 * already its own leaf, so a site that never adopts subtasks ramps
 * across each PHASE's own dates, unchanged in shape from before this
 * function started using per-day interpolation instead of a single
 * end-of-phase jump.
 *
 * Worked example (see scurveCalc.test.js): leaf 2026-08-01..2026-08-11
 * (10 days), weight 30%, contract_value 1,000,000 -> 300,000 total,
 * 30,000/day -> day 2026-08-06 (5 days in) = 150,000, not a jump to
 * 300,000 at the end.
 */
export function buildPlanSeries(leaves, contractValue) {
  const dated = leaves
    .filter((l) => l.start_date && l.end_date)
    .slice()
    .sort((a, b) => a.start_date.localeCompare(b.start_date))

  const points = []
  let cumulative = 0
  dated.forEach((leaf) => {
    const start = new Date(leaf.start_date)
    const end = new Date(leaf.end_date)
    const totalDays = Math.max(1, Math.round((end - start) / 86400000))
    const totalAmount = ((Number(leaf.billing_weight_pct) || 0) / 100) * (Number(contractValue) || 0)
    const perDay = totalAmount / totalDays
    for (let day = 0; day <= totalDays; day++) {
      const d = new Date(start.getTime() + day * 86400000)
      cumulative = (day === totalDays ? cumulative + (totalAmount - perDay * (totalDays - 1)) : cumulative + perDay)
      // ^ ensures the final day lands EXACTLY on cumulative += totalAmount's
      // running total (avoids float drift from perDay*totalDays != totalAmount)
      points.push({ date: d.toISOString().slice(0, 10), value: Math.round(cumulative * 100) / 100 })
    }
    // first point of a leaf double-counts day 0 as "0 progress" relative
    // to the running cumulative BEFORE this leaf -- overwrite it to the
    // pre-leaf cumulative value (a leaf's own day 0 is its start, 0%
    // through ITS OWN span, not day-1-of-progress)
    points[points.length - totalDays - 1] = { date: leaf.start_date, value: Math.round((cumulative - totalAmount) * 100) / 100 }
  })
  return points
}
```

(**Implementer note:** the day-0/day-N boundary bookkeeping above is
fiddly — re-derive it carefully against the two worked test cases rather
than trusting this sketch verbatim; the important invariants the tests
pin down are: (1) the first point of the whole series is `{date: <first
leaf's start_date>, value: <cumulative before this leaf>}`, (2) the last
point of each leaf is exactly `{date: <that leaf's end_date>, value:
<cumulative after adding its full totalAmount>}`, (3) points in between
increase by a constant `perDay` amount. Get Step 2's failing tests to
pass via Step 4 below — don't move on until they do.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --run scurveCalc`
Expected: PASS.

- [ ] **Step 5: Update `SCurveChart.jsx`'s call site**

In `SCurveChart.jsx`, add `useSubtasks` to its existing hooks import and
compute the flattened leaves before calling `buildPlanSeries`:

```js
import { useSitePhases, useSubtasks, useIncomes, useExpenses } from '../../hooks/useSupabase.js'
import { flattenLeaves, groupSubtasksByParent } from './subtaskCalc.js'
```

Where the file currently has (per the earlier full read of this file):
```js
  const plan = buildPlanSeries(phasesForSite, site.contract_value)
```
replace with:
```js
  const { data: allSubtasks } = useSubtasks()
  const subtasksForSite = useMemo(() => (allSubtasks || []).filter((s) => s.site_id === site.id), [allSubtasks, site.id])
  const subtasksByParent = useMemo(() => groupSubtasksByParent(subtasksForSite), [subtasksForSite])
  const leaves = useMemo(() => flattenLeaves(phasesForSite, subtasksByParent), [phasesForSite, subtasksByParent])
  // ...
  const plan = buildPlanSeries(leaves, site.contract_value)
```
(place the three new `useMemo`/hook lines alongside this file's existing
top-level hooks/memos, before `chartData`'s own `useMemo` which is where
`buildPlanSeries` is actually called — re-read the file's current exact
line numbers before editing, they may have shifted from earlier reads
this session.)

- [ ] **Step 6: Build and test**

Run: `npm run build && npm test -- --run`
Expected: green, no regressions on the existing worked-example comment at
the top of `scurveCalc.js` (update that comment's own numbers if this
task's ramping changes what it describes — re-derive it against the new
`buildPlanSeries` behavior rather than leaving it stale).

- [ ] **Step 7: Live-verify**

On a site with no subtasks, confirm the S-curve's plan line now ramps
smoothly between phase boundaries instead of stair-stepping (visually
compare a before/after screenshot). On the Task 5 test site (with a
dated subtask), confirm the ramp ties to the subtask's own dates, not
its parent phase's.

- [ ] **Step 8: Commit**

```bash
git add src/pages/sites/scurveCalc.js src/pages/sites/scurveCalc.test.js src/pages/sites/SCurveChart.jsx
git commit -m "feat: progressive per-leaf S-curve ramp instead of per-phase jump"
```

---

## Final Integration Notes (for the controller, not a task)

- After Task 7, run the full manual smoke test from Task 5/6's live-verify
  steps once more end-to-end on a single site: create a phase, add 2
  sibling subtasks under it (weights summing to ≤100%), nest a 3rd
  subtask under one of those two, add a Kanban card to the deepest leaf,
  confirm status/% roll up correctly all the way to the phase's own KPI
  card, confirm the S-curve reflects it, then delete everything created.
- Per this project's "Update Manual On Push" standing rule, update both
  manual copies (`public/manual/index.html` + the Artifact) for this
  feature once the branch is finished — not part of any task above,
  raise it explicitly when this plan completes.
- This plan does not touch the `depends_on_phase_id ` cross-phase arrow
  rendering math (`computeDependencyArrowsByRow` in `ganttTimeline.js`)
  beyond what Task 4 already reuses as-is for phase-level rows — sibling
  subtask arrows are read but a dedicated recursive arrow-drawing pass
  for subtask rows was intentionally left implicit in Task 4's row loop
  (each row only knows its own bar position, not a full arrow list) and
  should be double-checked/extended during Task 4's review if the
  reviewer judges it materially incomplete against the spec's "Gantt UI"
  section.
