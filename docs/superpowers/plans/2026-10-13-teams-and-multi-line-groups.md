# Teams + Multiple LINE Groups Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an owner group workers into teams (1 worker = 1 team) to assign whole teams at once, and let a tenant link several LINE groups (cap per package tier) with exactly one "notify" group.

**Architecture:** Teams are a thin membership layer: the Assign wizard expands selected teams into the same per-worker `worker_assignments` rows it writes today, so payroll/cost views are untouched. LINE groups move from the single `line_settings.crew_group_id` column to a `line_groups` table; the webhook resolves a tenant from any linked group, and the (currently unscheduled) daily push targets only the `is_notify` group.

**Tech Stack:** React (Vite) + Supabase (Postgres/RLS, Deno edge functions), vitest. Thai UI copy.

**Spec:** `docs/superpowers/specs/2026-10-12-teams-and-multi-line-groups-design.md`
**Mockup:** https://claude.ai/artifact/Em8v7EpU8eniwDxXCMjSVf

## Global Constraints

- **NEVER apply a migration, deploy an edge function, or run SQL that writes to the live CHANG database without asking the owner first.** Migration tasks only write the `.sql` file and verify on a Supabase branch or by reading; the apply/deploy step is Task 9 and needs explicit owner OK. (Migrations go live the instant `apply_migration` runs.)
- Every new table: `tenant_id UUID NOT NULL REFERENCES tenants(id)`, RLS on, policies scoped by `current_tenant_id()`. Writes by teams: `is_owner()` only.
- Every new SQL function that only the server should call: `REVOKE ALL ... FROM PUBLIC, anon, authenticated; GRANT EXECUTE ... TO service_role` (a past restore left anon able to call server-only functions).
- No `x.*` views over tables that later get new columns; embedding a table that has FKs both ways needs the exact constraint name.
- `upsert` `onConflict` must name the real PK/unique index exactly.
- Tier caps for LINE groups: Free 1, Solo 1, Pro Team 5, Business 10, Enterprise unlimited (NULL). Tenant with no package = unlimited. A tenant already over a cap keeps its groups, it just cannot add more.
- Exactly one `is_notify = true` group per tenant when the tenant has any group.
- UI copy in Thai, matching existing pages. Use existing CSS classes (`card`, `btn`, `btn-ghost`, `btn-sm`, `label`).
- Run tests with `npx vitest run <file>`; full suite `npm test` (baseline: 1137 passing).
- Migration filenames: `supabase/migrations/2026-10-13-NN-<name>.sql` (existing convention `YYYY-MM-DD-NN-name.sql`).

## Review Focus

1. Worker moved from team A to team B: must end in exactly one team, never zero or two (PK on `worker_id`; test `moveWorkerPlan`).
2. A team selected in the wizard whose members include someone already assigned that day/shift: must go through the existing overwrite-confirm dialog, not silently overwrite (Task 4 test on `expandTeamSelection` keeps worker ids so `handleWizardSubmit` conflict check still sees them).
3. Empty team selected: wizard must not report "assign 0 people" as success.
4. Third group linked when the tier cap is 2: refused with a reply in the group, nothing inserted (Task 6 `decideGroupClaim`).
5. Removing the notify group while others exist: must force choosing a new notify group first, else the daily push goes silent (Task 8 `planGroupRemoval`).
6. A LINE group id already linked to a *different* tenant must not be claimable (unique `group_id`).
7. Existing single-group tenant after migration: webhook still resolves its group and photos still file (backfill row has `is_notify = true`).

---

## File Structure

| File | Responsibility |
|---|---|
| `supabase/migrations/2026-10-13-01-worker-teams.sql` | `worker_teams`, `worker_team_members` + RLS |
| `supabase/migrations/2026-10-13-02-line-groups.sql` | `line_groups`, `packages.max_line_groups`, backfill, `can_add_line_group()` |
| `src/lib/teamAssign.js` (+ `.test.js`) | Pure: expand teams → worker ids, move-worker plan |
| `src/hooks/useTeams.js` | Fetch teams + members, mutations |
| `src/pages/assign/TeamManager.jsx` | Owner-only modal to manage teams |
| `src/pages/assign/AssignWizard.jsx` | Modify: team picker above worker list |
| `src/pages/Assign.jsx` | Modify: pass teams, owner-only "จัดการทีม" button |
| `supabase/functions/_shared/line-groups.ts` (+ test `src/lib/lineGroups.test.js`) | Pure: `decideGroupClaim`, `planGroupRemoval` |
| `supabase/functions/line-webhook/index.ts` | Modify: lookup + claim via `line_groups` |
| `supabase/functions/line-push-daily-assignments/index.ts` | Modify: push to `is_notify` group |
| `src/hooks/useLineGroups.js` | Fetch/mutate `line_groups` |
| `src/pages/CommunicationCenter.jsx` | Modify: group list UI |
| `src/hooks/useGuideFacts.js` | Modify: connected = any `line_groups` row |

---

### Task 1: Teams tables migration (file only)

**Files:**
- Create: `supabase/migrations/2026-10-13-01-worker-teams.sql`

**Interfaces:**
- Produces: tables `worker_teams(id, tenant_id, name, created_at)` unique `(tenant_id, name)`; `worker_team_members(worker_id PK, team_id, tenant_id)`.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-13-01-worker-teams.sql
-- Teams for the Assign wizard. 1 worker = 1 team (PK on worker_id).
-- Assignments are still written per worker, so payroll/cost are unaffected.
CREATE TABLE worker_teams (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(btrim(name)) > 0),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (tenant_id, name)
);

CREATE TABLE worker_team_members (
  worker_id UUID PRIMARY KEY REFERENCES workers(id) ON DELETE CASCADE,
  team_id   UUID NOT NULL REFERENCES worker_teams(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE
);
CREATE INDEX idx_worker_team_members_team ON worker_team_members(team_id);

ALTER TABLE worker_teams ENABLE ROW LEVEL SECURITY;
ALTER TABLE worker_team_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_reads ON worker_teams FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
CREATE POLICY owner_writes ON worker_teams FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

CREATE POLICY tenant_reads ON worker_team_members FOR SELECT TO authenticated
  USING (tenant_id = current_tenant_id());
-- team_id and worker_id must both belong to the caller's tenant (a member row
-- cannot point at another tenant's team or worker).
CREATE POLICY owner_writes ON worker_team_members FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND EXISTS (SELECT 1 FROM worker_teams t WHERE t.id = team_id AND t.tenant_id = current_tenant_id())
    AND EXISTS (SELECT 1 FROM workers w WHERE w.id = worker_id AND w.tenant_id = current_tenant_id())
  );

GRANT SELECT, INSERT, UPDATE, DELETE ON worker_teams, worker_team_members TO authenticated;
REVOKE ALL ON worker_teams, worker_team_members FROM anon;
```

- [ ] **Step 2: Sanity-check the helper names exist**

Run: `grep -rn "FUNCTION current_tenant_id\|FUNCTION is_owner\|FUNCTION tenant_can_write" supabase/migrations | head`
Expected: all three found. If a name differs, fix the migration to match.

- [ ] **Step 3: Commit (do NOT apply)**

```bash
git add supabase/migrations/2026-10-13-01-worker-teams.sql
git commit -m "feat(teams): worker_teams + worker_team_members tables (migration file only, not applied)"
```

---

### Task 2: Pure team logic (TDD)

**Files:**
- Create: `src/lib/teamAssign.js`
- Test: `src/lib/teamAssign.test.js`

**Interfaces:**
- Produces:
  - `expandTeamSelection(teamIds: string[], members: {worker_id, team_id}[], activeWorkerIds: Set<string>) => string[]` unique worker ids of those teams, only workers in `activeWorkerIds`, order by first appearance.
  - `moveWorkerPlan(workerId: string, toTeamId: string, members) => { action: 'add'|'move'|'noop', fromTeamId: string|null }`

- [ ] **Step 1: Write the failing tests**

```js
import { describe, it, expect } from 'vitest'
import { expandTeamSelection, moveWorkerPlan } from './teamAssign.js'

const members = [
  { worker_id: 'w1', team_id: 'A' }, { worker_id: 'w2', team_id: 'A' },
  { worker_id: 'w3', team_id: 'B' }, { worker_id: 'w4', team_id: 'B' },
]
const active = new Set(['w1', 'w2', 'w3'])

describe('expandTeamSelection', () => {
  it('returns members of the chosen teams, skipping inactive/hidden workers', () => {
    expect(expandTeamSelection(['A', 'B'], members, active)).toEqual(['w1', 'w2', 'w3'])
  })
  it('returns [] for an empty or unknown team', () => {
    expect(expandTeamSelection(['Z'], members, active)).toEqual([])
    expect(expandTeamSelection([], members, active)).toEqual([])
  })
  it('never duplicates a worker', () => {
    const dup = [...members, { worker_id: 'w1', team_id: 'B' }]
    expect(expandTeamSelection(['A', 'B'], dup, active)).toEqual(['w1', 'w2', 'w3'])
  })
})

describe('moveWorkerPlan', () => {
  it('adds a worker with no team', () => {
    expect(moveWorkerPlan('w9', 'A', members)).toEqual({ action: 'add', fromTeamId: null })
  })
  it('moves a worker from another team', () => {
    expect(moveWorkerPlan('w3', 'A', members)).toEqual({ action: 'move', fromTeamId: 'B' })
  })
  it('is a noop when already in that team', () => {
    expect(moveWorkerPlan('w1', 'A', members)).toEqual({ action: 'noop', fromTeamId: 'A' })
  })
})
```

- [ ] **Step 2: Run, expect FAIL**

Run: `npx vitest run src/lib/teamAssign.test.js`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement**

```js
// Pure helpers for the teams feature (spec 2026-10-12). 1 worker = 1 team.
export function expandTeamSelection(teamIds, members, activeWorkerIds) {
  const wanted = new Set(teamIds)
  const out = []
  const seen = new Set()
  for (const m of members) {
    if (!wanted.has(m.team_id) || seen.has(m.worker_id) || !activeWorkerIds.has(m.worker_id)) continue
    seen.add(m.worker_id)
    out.push(m.worker_id)
  }
  return out
}

export function moveWorkerPlan(workerId, toTeamId, members) {
  const cur = members.find(m => m.worker_id === workerId)
  if (!cur) return { action: 'add', fromTeamId: null }
  if (cur.team_id === toTeamId) return { action: 'noop', fromTeamId: cur.team_id }
  return { action: 'move', fromTeamId: cur.team_id }
}
```

- [ ] **Step 4: Run, expect PASS**

Run: `npx vitest run src/lib/teamAssign.test.js` → PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/lib/teamAssign.js src/lib/teamAssign.test.js
git commit -m "feat(teams): pure team expansion + move-plan helpers"
```

---

### Task 3: Team data hook + owner-only TeamManager

**Files:**
- Create: `src/hooks/useTeams.js`, `src/pages/assign/TeamManager.jsx`

**Interfaces:**
- Consumes: Task 2 `moveWorkerPlan`; tables from Task 1; `useQuery` from `src/hooks/useSupabase.js` (returns `{ data, loading, refetch }`, same as `useWorkers`); `Modal` from `src/components/Modal.jsx`.
- Produces: `useTeams() => { teams, members, loading, refetch }` where `teams: {id,name}[]`, `members: {worker_id,team_id}[]`; `<TeamManager workers teams members onChanged onClose />`.

- [ ] **Step 1: Write `useTeams.js`**

```js
import { supabase } from '../lib/supabase.js'
import { useQuery } from './useSupabase.js'

// Teams + membership for the current tenant (RLS scopes both queries).
export function useTeams() {
  const { data, loading, refetch } = useQuery(async () => {
    const [t, m] = await Promise.all([
      supabase.from('worker_teams').select('id, name').order('name'),
      supabase.from('worker_team_members').select('worker_id, team_id'),
    ])
    if (t.error) throw t.error
    if (m.error) throw m.error
    return { teams: t.data || [], members: m.data || [] }
  })
  return { teams: data?.teams || [], members: data?.members || [], loading, refetch }
}
```

- [ ] **Step 2: Check `useQuery`'s real return shape before relying on it**

Run: `sed -n 1,40p src/hooks/useSupabase.js`
Expected: confirm it returns `{ data, loading, error, refetch }`. If names differ, adjust Step 1.

- [ ] **Step 3: Write `TeamManager.jsx`**

Behavior (all via `supabase` directly, then `onChanged()`):
- list teams with member counts; "+ สร้างทีม" inserts `{ name, tenant_id }` (get `tenant.id` from `useTenant()` as `CommunicationCenter.jsx` does); rename; delete (ConfirmDialog; deleting a team deletes memberships via cascade, never assignments).
- selecting a team shows its members and a `SearchableSelect` of active workers to add. On add, call `moveWorkerPlan(workerId, teamId, members)`: `noop` → nothing; `add` → insert `{ worker_id, team_id, tenant_id }`; `move` → show inline note "`{ชื่อ}` อยู่ทีม `{ทีมเดิม}` แล้ว ย้ายมาทีมนี้ไหม?" with buttons "ย้ายมาทีมนี้" (`upsert({worker_id, team_id, tenant_id}, { onConflict: 'worker_id' })`) and "ไม่ย้าย".
- remove member: `delete().eq('worker_id', id)`.
- Errors surfaced with `alert('Error: ' + e.message)` like neighbouring code.

Follow the layout/classes of `src/pages/assign/CellEditPopup.jsx` for modal chrome.

- [ ] **Step 4: Manual smoke (no DB write)**

Run: `npm run build`
Expected: build succeeds (component compiles). Live behavior is verified in Task 9 on a test tenant after the migration is applied with owner approval.

- [ ] **Step 5: Commit**

```bash
git add src/hooks/useTeams.js src/pages/assign/TeamManager.jsx
git commit -m "feat(teams): useTeams hook + owner-only TeamManager modal"
```

---

### Task 4: Team picker in AssignWizard + owner button

**Files:**
- Modify: `src/pages/assign/AssignWizard.jsx` (workers step, ~line 118; `toggleWorker` ~line 27)
- Modify: `src/pages/Assign.jsx` (props passed to `AssignWizard`; header buttons)
- Test: extend `src/lib/teamAssign.test.js`

**Interfaces:**
- Consumes: `useTeams()`, `expandTeamSelection` (Tasks 2-3).
- Produces: `AssignWizard` new optional props `teams = []`, `members = []`. Selecting a team sets `form.sel[workerId] = { am: true, pm: true }` for each expanded worker not already selected (same shape `toggleWorker` writes). It does NOT write to the DB; the existing `handleWizardSubmit` conflict check and overwrite-confirm dialog still run on the resulting rows.

- [ ] **Step 1: Add the failing test for the add-team reducer**

Add to `teamAssign.js` a pure `applyTeamToSelection(sel, workerIds)` returning a new `sel` that adds missing ids as `{ am: true, pm: true }` and leaves existing entries untouched. Test first:

```js
import { applyTeamToSelection } from './teamAssign.js'
describe('applyTeamToSelection', () => {
  it('adds missing workers as am+pm and keeps existing choices', () => {
    const sel = { w1: { am: true, pm: false } }
    expect(applyTeamToSelection(sel, ['w1', 'w2'])).toEqual({
      w1: { am: true, pm: false }, w2: { am: true, pm: true },
    })
  })
  it('does not mutate its input and handles an empty list', () => {
    const sel = { w1: { am: true, pm: true } }
    applyTeamToSelection(sel, [])
    expect(sel).toEqual({ w1: { am: true, pm: true } })
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/teamAssign.test.js` (`applyTeamToSelection` is not exported).

- [ ] **Step 3: Implement**

```js
export function applyTeamToSelection(sel, workerIds) {
  const next = { ...sel }
  for (const id of workerIds) if (!next[id]) next[id] = { am: true, pm: true }
  return next
}
```

- [ ] **Step 4: Run, expect PASS.**

- [ ] **Step 5: Wire the wizard**

In `AssignWizard.jsx`, above the worker list in step 4, when `teams.length > 0` render chips "เลือกทีม": one `button` per team (`{name} ({count})`). Clicking calls:

```js
const addTeam = (teamId) => setForm(f => {
  const ids = expandTeamSelection([teamId], members, new Set(workers.map(w => w.id)))
  if (!ids.length) { alert('ทีมนี้ยังไม่มีช่างที่เลือกได้'); return f }
  return { ...f, sel: applyTeamToSelection(f.sel, ids) }
})
```

(Empty team must warn, not silently do nothing — Review Focus #3. `workers` here is already the `show_in_assign` active list, so hidden/inactive workers are skipped.) Teams stay toggle-free: individual checkboxes still let the user untick anyone.

In `Assign.jsx`: call `const { teams, members, refetch: refetchTeams } = useTeams()`, pass `teams`/`members` to `AssignWizard`; add a "👥 จัดการทีม" button next to the wizard-open button, rendered only when `role === 'OWNER'`, opening `TeamManager` (state `teamMgrOpen`), `onChanged={refetchTeams}`.

- [ ] **Step 6: Run full tests + build**

Run: `npm test && npm run build`
Expected: all pass (baseline 1137 + new tests), build OK.

- [ ] **Step 7: Commit**

```bash
git add src/lib/teamAssign.js src/lib/teamAssign.test.js src/pages/assign/AssignWizard.jsx src/pages/Assign.jsx
git commit -m "feat(teams): pick whole teams in the Assign wizard; owner-only team manager button"
```

---

### Task 5: LINE groups migration (file only)

**Files:**
- Create: `supabase/migrations/2026-10-13-02-line-groups.sql`

**Interfaces:**
- Produces: table `line_groups(id, tenant_id, group_id UNIQUE, label, is_notify, created_at)`; `packages.max_line_groups`; function `can_add_line_group(p_tenant UUID) RETURNS BOOLEAN` (service_role only; edge functions run without a user JWT so `tenant_under_seat_limit` cannot be used there); extend `tenant_under_seat_limit(p_kind)` with `'line_groups'` for the UI.

- [ ] **Step 1: Write the migration**

```sql
-- supabase/migrations/2026-10-13-02-line-groups.sql
-- Several LINE groups per tenant, capped per package tier. Replaces the single
-- line_settings.crew_group_id (column kept, unused, for rollback).
CREATE TABLE line_groups (
  id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id  UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  group_id   TEXT NOT NULL UNIQUE,            -- a LINE group belongs to ONE tenant
  label      TEXT,
  is_notify  BOOLEAN NOT NULL DEFAULT false,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX line_groups_one_notify_per_tenant ON line_groups(tenant_id) WHERE is_notify;
CREATE INDEX line_groups_tenant ON line_groups(tenant_id);

ALTER TABLE line_groups ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_groups FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- Owner may rename / change notify group / unlink. Inserts come only from the
-- webhook (service role), which enforces the tier cap.
CREATE POLICY owner_updates ON line_groups FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY owner_deletes ON line_groups FOR DELETE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
GRANT SELECT, UPDATE, DELETE ON line_groups TO authenticated;
REVOKE ALL ON line_groups FROM anon;

-- Tier caps (NULL = unlimited). Same pattern as 2026-08-29-14-package-seat-limits.sql.
ALTER TABLE packages ADD COLUMN max_line_groups INT;
UPDATE packages SET max_line_groups = 1    WHERE name = 'Free';
UPDATE packages SET max_line_groups = 1    WHERE name = 'Solo';
UPDATE packages SET max_line_groups = 5    WHERE name = 'Pro Team';
UPDATE packages SET max_line_groups = 10   WHERE name = 'Business';
UPDATE packages SET max_line_groups = NULL WHERE name = 'Enterprise';

-- Existing linked groups become the notify group, so nothing changes for them.
INSERT INTO line_groups (tenant_id, group_id, is_notify)
SELECT tenant_id, crew_group_id, true FROM line_settings WHERE crew_group_id IS NOT NULL
ON CONFLICT (group_id) DO NOTHING;

-- Server-side check for the webhook (no user JWT there).
CREATE OR REPLACE FUNCTION can_add_line_group(p_tenant UUID)
RETURNS BOOLEAN
LANGUAGE sql SECURITY DEFINER STABLE SET search_path = public
AS $$
  SELECT COALESCE(
    (SELECT p.max_line_groups IS NULL
            OR (SELECT count(*) FROM line_groups g WHERE g.tenant_id = p_tenant) < p.max_line_groups
     FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
     WHERE t.id = p_tenant),
    true)
$$;
REVOKE ALL ON FUNCTION can_add_line_group(UUID) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION can_add_line_group(UUID) TO service_role;
```

(Do not redefine `tenant_under_seat_limit` unless the UI needs the same number: the UI reads `max_line_groups` via a normal `packages` select and counts `line_groups` itself, so skip changing that function. YAGNI.)

- [ ] **Step 2: Check `packages` is readable by the tenant UI**

Run: `grep -rn "packages" supabase/migrations/2026-08-29-11-tenant-management-packages.sql | grep -i "policy\|grant"`
Expected: find the SELECT policy. If tenants cannot read their own package row, add to this migration a `SECURITY DEFINER` function `my_line_group_limit() RETURNS INT` granted to `authenticated` and use it in Task 8 instead.

- [ ] **Step 3: Commit (do NOT apply)**

```bash
git add supabase/migrations/2026-10-13-02-line-groups.sql
git commit -m "feat(line): line_groups table, per-tier max_line_groups, backfill, can_add_line_group() (migration file only, not applied)"
```

---

### Task 6: Pure group-claim/removal rules (TDD) + webhook wiring

**Files:**
- Create: `supabase/functions/_shared/line-groups.ts`
- Test: `src/lib/lineGroups.test.js` (imports the `.ts` the way `chequeDigest.test.js` does)
- Modify: `supabase/functions/line-webhook/index.ts` (~1251-1285, comment ~1528)

**Interfaces:**
- Produces:
  - `decideGroupClaim(input: { alreadyLinkedTenantId: string|null, claimingTenantId: string, canAdd: boolean, existingCount: number }) => { action: 'insert', isNotify: boolean } | { action: 'already-linked' } | { action: 'refuse-other-tenant' } | { action: 'refuse-cap' }`
  - `planGroupRemoval(groups: {id: string, is_notify: boolean}[], removeId: string, newNotifyId?: string) => { ok: true, setNotifyId: string|null } | { ok: false, reason: 'must-pick-notify' }`

- [ ] **Step 1: Write failing tests**

```js
import { describe, it, expect } from 'vitest'
import { decideGroupClaim, planGroupRemoval } from '../../supabase/functions/_shared/line-groups.ts'

describe('decideGroupClaim', () => {
  const base = { claimingTenantId: 'T1', canAdd: true, existingCount: 0, alreadyLinkedTenantId: null }
  it('first group becomes the notify group', () => {
    expect(decideGroupClaim(base)).toEqual({ action: 'insert', isNotify: true })
  })
  it('later groups are not notify', () => {
    expect(decideGroupClaim({ ...base, existingCount: 2 })).toEqual({ action: 'insert', isNotify: false })
  })
  it('refuses when the tier cap is reached', () => {
    expect(decideGroupClaim({ ...base, existingCount: 2, canAdd: false })).toEqual({ action: 'refuse-cap' })
  })
  it('refuses a group already linked to another tenant', () => {
    expect(decideGroupClaim({ ...base, alreadyLinkedTenantId: 'T2' })).toEqual({ action: 'refuse-other-tenant' })
  })
  it('re-claiming own group is a no-op', () => {
    expect(decideGroupClaim({ ...base, alreadyLinkedTenantId: 'T1', existingCount: 1 })).toEqual({ action: 'already-linked' })
  })
})

describe('planGroupRemoval', () => {
  const gs = [{ id: 'a', is_notify: true }, { id: 'b', is_notify: false }, { id: 'c', is_notify: false }]
  it('removing a non-notify group needs nothing else', () => {
    expect(planGroupRemoval(gs, 'b')).toEqual({ ok: true, setNotifyId: null })
  })
  it('removing the notify group requires picking a new one when others remain', () => {
    expect(planGroupRemoval(gs, 'a')).toEqual({ ok: false, reason: 'must-pick-notify' })
    expect(planGroupRemoval(gs, 'a', 'c')).toEqual({ ok: true, setNotifyId: 'c' })
  })
  it('removing the only group is fine', () => {
    expect(planGroupRemoval([gs[0]], 'a')).toEqual({ ok: true, setNotifyId: null })
  })
  it('rejects a new notify id that is the removed group or not in the list', () => {
    expect(planGroupRemoval(gs, 'a', 'a')).toEqual({ ok: false, reason: 'must-pick-notify' })
    expect(planGroupRemoval(gs, 'a', 'zzz')).toEqual({ ok: false, reason: 'must-pick-notify' })
  })
})
```

- [ ] **Step 2: Run, expect FAIL** — `npx vitest run src/lib/lineGroups.test.js`.

- [ ] **Step 3: Implement `line-groups.ts`**

```ts
// Pure rules for linking / unlinking LINE groups (spec 2026-10-12). No I/O.
export type ClaimDecision =
  | { action: 'insert'; isNotify: boolean }
  | { action: 'already-linked' }
  | { action: 'refuse-other-tenant' }
  | { action: 'refuse-cap' }

export function decideGroupClaim(i: {
  alreadyLinkedTenantId: string | null; claimingTenantId: string; canAdd: boolean; existingCount: number
}): ClaimDecision {
  if (i.alreadyLinkedTenantId) {
    return i.alreadyLinkedTenantId === i.claimingTenantId ? { action: 'already-linked' } : { action: 'refuse-other-tenant' }
  }
  if (!i.canAdd) return { action: 'refuse-cap' }
  return { action: 'insert', isNotify: i.existingCount === 0 }
}

export function planGroupRemoval(
  groups: { id: string; is_notify: boolean }[], removeId: string, newNotifyId?: string,
): { ok: true; setNotifyId: string | null } | { ok: false; reason: 'must-pick-notify' } {
  const target = groups.find(g => g.id === removeId)
  const others = groups.filter(g => g.id !== removeId)
  if (!target?.is_notify || others.length === 0) return { ok: true, setNotifyId: null }
  if (newNotifyId && others.some(g => g.id === newNotifyId)) return { ok: true, setNotifyId: newNotifyId }
  return { ok: false, reason: 'must-pick-notify' }
}
```

- [ ] **Step 4: Run, expect PASS** (9 tests).

- [ ] **Step 5: Wire the webhook**

In `line-webhook/index.ts`:
- Import `decideGroupClaim` from `../_shared/line-groups.ts`.
- ~1251: replace the `line_settings` lookup with
  `admin.from('line_groups').select('tenant_id').eq('group_id', sourceGroupId).maybeSingle()`; keep the same error handling.
- ~1271-1285 (claim): keep the `group_link_code` lookup in `line_settings` and the `line_bot` module check. Then:

```ts
const { data: existingRow } = await admin.from('line_groups').select('tenant_id').eq('group_id', sourceGroupId).maybeSingle()
const { count } = await admin.from('line_groups').select('id', { count: 'exact', head: true }).eq('tenant_id', claimant.tenant_id)
const { data: canAdd } = await admin.rpc('can_add_line_group', { p_tenant: claimant.tenant_id })
const decision = decideGroupClaim({
  alreadyLinkedTenantId: (existingRow?.tenant_id as string | undefined) ?? null,
  claimingTenantId: claimant.tenant_id as string, canAdd: canAdd === true, existingCount: count ?? 0,
})
```
  then per `decision.action`: `insert` → `admin.from('line_groups').insert({ tenant_id, group_id: sourceGroupId, is_notify: decision.isNotify })` then clear `group_link_code` (update `line_settings` set `group_link_code: null`), reply `'✅ ตั้งกลุ่มนี้เป็นกลุ่มทีมงานเรียบร้อยแล้ว'`; `already-linked` → clear code, reply same success text; `refuse-cap` → reply `'⚠️ แพ็กเกจของคุณผูกกลุ่ม LINE ได้ครบจำนวนแล้ว หากต้องการเพิ่มกรุณาอัปเกรดแพ็กเกจ'` and keep the code; `refuse-other-tenant` → say nothing (do not reveal that another tenant holds it, same silent-ignore rule as the existing no-match branch).
- ~1528 comment: update to say the group matched a `line_groups` row of that tenant.
- Add a `logSafeError` on insert failure like the neighbouring blocks.

- [ ] **Step 6: Typecheck the function**

Run: `deno check supabase/functions/line-webhook/index.ts` (skip with a note if `deno` is not installed; then run `npm test` and `npm run build` to catch import errors).
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/_shared/line-groups.ts src/lib/lineGroups.test.js supabase/functions/line-webhook/index.ts
git commit -m "feat(line): webhook links groups via line_groups with tier cap; pure claim/removal rules"
```

---

### Task 7: Daily push goes to the notify group

**Files:**
- Modify: `supabase/functions/line-push-daily-assignments/index.ts:103-107,156`

Note: this job is currently **unscheduled** (migration `2026-10-01-02`, LINE bills a group push once per member). The change keeps it correct if the owner re-enables it; it does not re-schedule it.

- [ ] **Step 1: Change the query and the push target**

Replace the `line_settings` select with:

```ts
const { data: settingsRows, error: settingsError } = await admin
  .from('line_groups')
  .select('tenant_id, group_id')
  .eq('is_notify', true)
```

and at the push call use `settings.group_id as string` instead of `settings.crew_group_id as string`. Leave the rest (module check, budget) unchanged.

- [ ] **Step 2: Verify no stale reference remains**

Run: `grep -n "crew_group_id" supabase/functions/line-push-daily-assignments/index.ts`
Expected: no output.

- [ ] **Step 3: Commit**

```bash
git add supabase/functions/line-push-daily-assignments/index.ts
git commit -m "feat(line): daily assignment push targets the notify group"
```

---

### Task 8: Communication Center group list + guide fact

**Files:**
- Create: `src/hooks/useLineGroups.js`
- Modify: `src/pages/CommunicationCenter.jsx` (state ~88-120, UI ~510-545)
- Modify: `src/hooks/useGuideFacts.js:12-20`

**Interfaces:**
- Consumes: `planGroupRemoval` (import from `../../supabase/functions/_shared/line-groups.ts` the same way tests do, or copy it to `src/lib/lineGroups.js` if Vite rejects the `.ts` path — decide at Step 1).
- Produces: `useLineGroups() => { groups, limit, loading, refetch }`, `groups: {id, group_id, label, is_notify}[]`, `limit: number|null`.

- [ ] **Step 1: Confirm the shared `.ts` can be imported from `src`**

Run: `grep -rn "supabase/functions/_shared" src --include=*.js --include=*.jsx | grep -v test | head`
If a non-test file already imports from there, import directly; otherwise add `src/lib/lineGroups.js` re-exporting `planGroupRemoval` as plain JS (duplicate the 8-line function and keep the same test covering both via the `.ts`). 

- [ ] **Step 2: Write `useLineGroups.js`** (reads `line_groups` ordered by `created_at`; reads the tier cap from `packages` through the tenant's `package_id`, or via `my_line_group_limit()` if Task 5 Step 2 found tenants cannot read `packages`).

- [ ] **Step 3: Replace the single "กลุ่มทีมงาน" block** (CommunicationCenter.jsx ~528-545) with:
  - header line "ใช้ไปแล้ว {groups.length} จาก {limit ?? 'ไม่จำกัด'} กลุ่ม";
  - one row per group: `label || 'กลุ่ม LINE'`, a "กลุ่มแจ้งงาน" badge on `is_notify`, buttons "ตั้งเป็นกลุ่มแจ้งงาน" (owner; sets this `is_notify = true` after clearing the old one — do it clear-then-set in that order because of the partial unique index), "ยกเลิกการเชื่อม" (owner; uses `planGroupRemoval`; when `must-pick-notify`, show a select of the other groups and require a choice before deleting);
  - keep "➕ เพิ่มกลุ่ม" calling the existing `handleGenerateGroupCode`; disable it with text "ครบจำนวนแล้ว" when `limit !== null && groups.length >= limit`;
  - connection badge (line ~514): `statusBadge(groups.length > 0, ...)`.
- [ ] **Step 4: `useGuideFacts.js`** — `lineConnected()` select from `line_groups` (`select('id').limit(1)`) instead of `line_settings.crew_group_id`.
- [ ] **Step 5: Run `npm test && npm run build`** — expected PASS. Check `src/lib/guideProgress.test.js` still passes (it should not depend on the table name).
- [ ] **Step 6: Commit**

```bash
git add src/hooks/useLineGroups.js src/pages/CommunicationCenter.jsx src/hooks/useGuideFacts.js
git commit -m "feat(line): Communication Center lists multiple groups with tier usage and notify-group control"
```

---

### Task 9: Apply, deploy, verify (OWNER GATE)

**STOP and ask the owner before any step here.** Nothing above touched the live DB.

- [ ] **Step 1: Ask the owner** for approval to (a) apply both migrations to CHANG, (b) deploy `line-webhook` and `line-push-daily-assignments`, (c) deploy the web app. Show the two migration files.
- [ ] **Step 2: Dry-run first** on a Supabase branch (`create_branch`) or a copy; apply both migrations; run the checks below; delete the branch.
- [ ] **Step 3: On approval, order matters:** apply migration 01, apply migration 02 (backfill makes old tenants work), deploy the two edge functions, then deploy the web app (`chang-ship` skill: build + `wrangler deploy`, confirm the bundle points to CHANG).
- [ ] **Step 4: Verification queries** (read-only, after apply):
  - `SELECT count(*) FROM line_groups` equals `SELECT count(*) FROM line_settings WHERE crew_group_id IS NOT NULL`.
  - Every tenant with groups has exactly one `is_notify`: `SELECT tenant_id FROM line_groups GROUP BY 1 HAVING count(*) FILTER (WHERE is_notify) <> 1` returns no rows.
  - **ACL diff:** `SELECT has_function_privilege('anon','can_add_line_group(uuid)','EXECUTE')` is `false`; `has_function_privilege('authenticated', ...)` is `false`; no new table grants to `anon`.
  - `get_advisors` (security) shows no new warnings for the new tables.
- [ ] **Step 5: Test-tenant run:** owner creates 2 teams, assigns a team through the wizard (including one worker with an existing shift to see the overwrite-confirm), links a second group by code and sees the group in the list; on a 1-group tier the second link attempt gets the cap reply; photo sent from the second group files to the tenant; "งานวันพรุ่งนี้" typed in either group answers.
- [ ] **Step 6:** Report what was verified vs not; then follow `superpowers:finishing-a-development-branch` only after the owner OKs the whole arc (do not merge earlier).

---

## Self-Review (done)

- **Spec coverage:** §3 data → Tasks 1, 5; §4 assignment → Tasks 2, 4; §5 team page (owner-only) → Task 3 (placed as a modal on the Assign page, see note below); §6 LINE → Tasks 6, 7, 8; §7 rollout + §8 tests + ACL → Task 9 and per-task tests; tier caps → Task 5.
- **Deviations from the spec, found by reading the code, to confirm with the owner:**
  1. Spec §4 said a clash with an existing shift is *blocked* with a red "remove" button. The Assign page already has a working "พบ N กะที่มีงานอยู่แล้ว ... ยืนยันจะเขียนทับ" confirm dialog (`Assign.jsx handleWizardSubmit`), and `worker_assignments` already has `UNIQUE(worker_id, date, shift)`. The plan **reuses that dialog** rather than inventing a second mechanism.
  2. Team management lives as an owner-only button + modal on the Assign page instead of a new Settings page (no new route/nav entry).
  3. `line-push-daily-assignments` is unscheduled today (LINE bills a group push once per member). The notify group therefore only matters if the owner re-enables that push; on-demand "งานวันพรุ่งนี้" replies already work in every linked group at no cost.
- **Placeholders:** none; Task 3 Step 3 and Task 8 Steps 2-3 describe UI behavior in prose because the exact JSX depends on neighbouring component code the implementer must read first (named files given).
- **Types:** `expandTeamSelection`, `moveWorkerPlan`, `applyTeamToSelection`, `decideGroupClaim`, `planGroupRemoval`, `can_add_line_group` names are used identically in every task.
