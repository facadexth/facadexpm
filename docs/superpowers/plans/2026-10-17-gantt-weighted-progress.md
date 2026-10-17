# Gantt Weighted Progress (Part B) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Gantt progress stops dropping when cards are added. Each phase holds 100 points shared by its cards. Installation cards progress by installed quantity against a BOQ built from accepted quotations. VO lives in separate phases. Immutable PLAN versions are compared as a layer on the Gantt and the S-curve.

**Architecture:**
- **Database (source of truth):** new columns on `phase_tasks` and `site_phases`, plus four new tables: `boq_items`, `progress_reports`, `site_plans`, `site_plan_items`.
- **Integrity triggers:**
  - card points per node never exceed 100;
  - quantity totals stay within the BOQ;
  - the installed quantity drives the card status;
  - a site needs a saved PLAN before progress can be recorded;
  - a quotation accepted onto a site creates its BOQ lines.
- **Progress maths:** the SQL function `site_progress_pct()` feeds a nightly snapshot table, which becomes the S-curve's actual line. The pure JS mirror `progressCalc.js` drives the UI. Both are tested on the same fixture cases.
- **UI:** extends the existing Gantt, Kanban, SiteDetail and SCurveChart. It follows the approved mockup https://claude.ai/artifact/Svk4UJWQWNRM6xnpfY5ZgA.

**Tech Stack:** React 18 + Vite, Supabase Postgres (RLS, plpgsql, pg_cron), Deno edge functions, vitest + jsdom.

**Spec:** `docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md` §1–§12. Part A (PM role, §13) is **live** in 1.21.0.

## Global Constraints

- **Amended after Task 3 review (binding):** `site_phases.vo_value` does not exist — VO values are in `phase_vo_values` (OWNER/ADMIN only). `site_progress_daily` holds `contract_pct` only; `total_pct` is in `site_progress_daily_money` (OWNER/ADMIN only). `site_progress_pct()` returns 0 rows for PM (PM cannot read `sites`), so the UI must compute PM's live % with `progressCalc.js`.

**Roles**
- Roles: `is_site_staff()` = OWNER/ADMIN/PM; `is_pm()`; `can_manage_teams()`. All three already exist live.
- New helper `can_manage_plan()` = role IN ('OWNER','PM'). **ADMIN cannot** save a PLAN or record or cancel quantities.

**Progress rules**
- A status card is worth `done` → 1, otherwise 0. A card that is "กำลังทำ" counts 0%. There is no manual % mode.
- Every node (a phase, or a leaf `phase_subtasks` row) owns 100 points.
  - Top-level cards in one node sum to ≤ 100.
  - Children of a split card sum to ≤ the parent's points.
  - Split goes one level only.
- Issue phases and cards (`is_issue_phase`, `issue_report_id IS NOT NULL`) have weight 0, are excluded from all progress, and are exempt from the PLAN gate.
- VO phases: `site_phases.is_vo = true`, `billing_weight_pct = 0`, optional `vo_ref`; the VO baht value lives in the admin-only table `phase_vo_values(phase_id, vo_value)` (PM can never read it).
- Site % ตามสัญญา = Σ(w × p) / Σ w over phases that are neither VO nor issue, where w = `billing_weight_pct`.
- Site % รวม VO = (contract_value × contract% + Σ vo_value × vo%) / (contract_value + Σ vo_value).
  - Show it only when `contract_value > 0` AND at least one VO phase exists.
  - It needs `contract_value`, so it is shown only to roles that `canSeeMoney`. PM sees % ตามสัญญา only.

**PLAN and quantities**
- A PLAN version is immutable: there is no UPDATE or DELETE policy, and UPDATE and DELETE are revoked from `authenticated`.
- A PLAN v1 is required before any progress is recorded.
- The migration auto-creates PLAN v1 for every site that has a phase that is not an issue phase.
- LINE-reported quantities are never counted. Progress reports have `source = 'web'` only. A wrong entry is cancelled, never deleted.

**Database process**
- Every new SECURITY DEFINER function: `SET search_path = public`, `REVOKE ALL … FROM PUBLIC, anon`, and an explicit GRANT.
- Policies wrap row-independent helpers as `( SELECT fn() )`.
- No policy may reference its own table: that raises 42P17 infinite recursion. Use SECURITY DEFINER helpers instead.
- Migrations are numbered `2026-10-17-07…`, `-08…`, `-09…`.
- **Never apply.** Dry-run only, inside rolled-back test scripts that inline the migration bodies. Live DB is CHANG; never touch Tokyo `yyzbgdmgyvvypfcjuhtr`.
- The `site_phases` table's own column list is unaffected by the views below. Views that use `x.*` freeze their columns, so re-create any view that must show new columns.

**UI and process**
- Laptop and landscape iPad (>900px) layouts change only by the new controls. Phone CSS lives only in the single `@media (max-width:900px)` block of `src/mobile.css`.
- Commit with `git commit -F <file>`, ending with the Co-Authored-By and Claude-Session lines. Never use bare `git stash`.
- `npx vitest run` must stay green (1344+ tests).

## Review Focus

1. **Existing sites keep today's phase %.** After the data migration, every phase's weighted % equals its old count-based % (`done/total`, rounded). Pinned by Task 3's SQL comparison of the old and new % per phase over the live 144 cards.
2. **Quantity card driven by status, not quantity.** A drag in Kanban, MySchedule "เสร็จ", or LINE "งานเสร็จ" on a quantity card must be rejected. Recording quantity must be the only way it moves. Pinned in Task 2's test and Task 9.
3. **PLAN immutability and gate bypasses.** UPDATE or DELETE on `site_plans` / `site_plan_items` as OWNER must fail. A status change on a site with no PLAN must fail for every role, but not for issue cards. Pinned in Task 2's test.
4. **Rounding at 100.** Three cards at 33.33 + 33.33 + 33.34 = 100 must pass the ≤ 100 check. Floating sums like 33.333… must not falsely exceed 100. The check uses `numeric(6,2)` with a 0.005 tolerance. Pinned in Task 2's test and the progressCalc fixtures.
5. **Concurrent split and new card.** Two PMs splitting or adding cards on the same node at once must not push the node over 100. The per-row trigger re-sums under a `FOR UPDATE` lock on the node's phase row. Pinned in Task 2's test with two inserts in one transaction that together exceed 100.

---

### Task 1: DB schema, helpers and RLS (migration 07)

**Files:**
- Create: `supabase/migrations/2026-10-17-07-gantt-progress-schema.sql`
- Create: `supabase/tests/2026-10-17-07-gantt-progress-schema.test.sql`

**Interfaces:**
- Produces:
  - Columns: `phase_tasks.weight_pts numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_pts >= 0)`, `progress_mode text NOT NULL DEFAULT 'status' CHECK (progress_mode IN ('status','quantity'))`, `parent_task_id uuid NULL REFERENCES phase_tasks(id) ON DELETE CASCADE`, `boq_item_id uuid NULL REFERENCES boq_items(id) ON DELETE SET NULL`, `planned_qty numeric NULL CHECK (planned_qty IS NULL OR planned_qty > 0)`, `done_qty numeric NOT NULL DEFAULT 0`.
  - Columns: `site_phases.is_vo boolean NOT NULL DEFAULT false`, `vo_value numeric NULL CHECK (vo_value IS NULL OR vo_value >= 0)`, `vo_ref text NULL`.
  - Tables: `boq_items`, `progress_reports`, `site_plans`, `site_plan_items`, each with columns exactly as spec §5/§6, plus `tenant_id uuid NOT NULL DEFAULT current_tenant_id()`.
  - Helper: `can_manage_plan() boolean`.

- [ ] **Step 1: Write the migration.** Required content:

```sql
-- Gantt weighted progress: schema. Spec docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §3-§6
BEGIN;

CREATE OR REPLACE FUNCTION public.can_manage_plan() RETURNS boolean
  LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public
AS $$ SELECT COALESCE(current_user_role() IN ('OWNER','PM'), false) $$;
REVOKE ALL ON FUNCTION public.can_manage_plan() FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.can_manage_plan() TO authenticated;

CREATE TABLE public.boq_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  quotation_item_id uuid NULL REFERENCES quotation_items(id) ON DELETE SET NULL,
  code text NOT NULL,
  description text NOT NULL,
  unit text,
  planned_qty numeric NOT NULL CHECK (planned_qty > 0),
  sort_order int NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, quotation_item_id)
);
CREATE INDEX boq_items_site_idx ON boq_items(site_id);

ALTER TABLE phase_tasks
  ADD COLUMN weight_pts numeric(6,2) NOT NULL DEFAULT 0 CHECK (weight_pts >= 0),
  ADD COLUMN progress_mode text NOT NULL DEFAULT 'status' CHECK (progress_mode IN ('status','quantity')),
  ADD COLUMN parent_task_id uuid NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  ADD COLUMN boq_item_id uuid NULL REFERENCES boq_items(id) ON DELETE SET NULL,
  ADD COLUMN planned_qty numeric NULL CHECK (planned_qty IS NULL OR planned_qty > 0),
  ADD COLUMN done_qty numeric NOT NULL DEFAULT 0,
  ADD CONSTRAINT phase_tasks_quantity_needs_plan CHECK (progress_mode = 'status' OR planned_qty IS NOT NULL);
CREATE INDEX phase_tasks_parent_idx ON phase_tasks(parent_task_id) WHERE parent_task_id IS NOT NULL;

ALTER TABLE site_phases
  ADD COLUMN is_vo boolean NOT NULL DEFAULT false,
  ADD COLUMN vo_value numeric NULL CHECK (vo_value IS NULL OR vo_value >= 0),
  ADD COLUMN vo_ref text NULL;

CREATE TABLE public.progress_reports (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  task_id uuid NOT NULL REFERENCES phase_tasks(id) ON DELETE CASCADE,
  qty numeric NOT NULL CHECK (qty > 0),
  work_date date NOT NULL DEFAULT current_date,
  note text,
  source text NOT NULL DEFAULT 'web' CHECK (source IN ('web')),
  cancelled_at timestamptz,
  cancelled_by text,
  created_by text DEFAULT auth.email(),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX progress_reports_task_idx ON progress_reports(task_id);

CREATE TABLE public.site_plans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL DEFAULT current_tenant_id(),
  site_id uuid NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  version int NOT NULL,
  note text NOT NULL,
  is_auto boolean NOT NULL DEFAULT false,
  created_by text,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (site_id, version)
);
CREATE TABLE public.site_plan_items (
  plan_id uuid NOT NULL REFERENCES site_plans(id) ON DELETE CASCADE,
  level text NOT NULL CHECK (level IN ('phase','subtask','task')),
  ref_id uuid NOT NULL,
  parent_ref_id uuid,
  name text NOT NULL,
  start_date date,
  end_date date,
  weight numeric,
  planned_qty numeric,
  is_vo boolean NOT NULL DEFAULT false,
  PRIMARY KEY (plan_id, level, ref_id)
);
```

The `qty > 0` check is a deliberate narrowing of spec §5's `qty <> 0`. Corrections are made by cancelling an entry, never by a negative row. Record this in the commit message.

RLS (`ALTER TABLE … ENABLE ROW LEVEL SECURITY` on all four tables):

```sql
-- boq_items: site staff read/write within tenant
CREATE POLICY site_staff_all ON boq_items FOR ALL
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ))
  WITH CHECK (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
-- progress_reports: site staff read; OWNER/PM insert and cancel (update), never delete
CREATE POLICY site_staff_reads ON progress_reports FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
CREATE POLICY plan_managers_insert ON progress_reports FOR INSERT
  WITH CHECK (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND ( SELECT tenant_can_write() ));
CREATE POLICY plan_managers_cancel ON progress_reports FOR UPDATE
  USING (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND cancelled_at IS NULL)
  WITH CHECK (( SELECT can_manage_plan() ) AND tenant_id = ( SELECT current_tenant_id() ) AND cancelled_at IS NOT NULL);
-- site_plans / items: read only; rows are created by SECURITY DEFINER RPC (Task 2)
CREATE POLICY site_staff_reads ON site_plans FOR SELECT
  USING (( SELECT is_site_staff() ) AND tenant_id = ( SELECT current_tenant_id() ));
CREATE POLICY site_staff_reads ON site_plan_items FOR SELECT
  USING (EXISTS (SELECT 1 FROM site_plans p WHERE p.id = site_plan_items.plan_id
                 AND p.tenant_id = ( SELECT current_tenant_id() )) AND ( SELECT is_site_staff() ));
REVOKE INSERT, UPDATE, DELETE ON site_plans, site_plan_items FROM authenticated, anon;
REVOKE DELETE ON progress_reports FROM authenticated, anon;
COMMIT;
```

The `site_plan_items` policy reads `site_plans`, a different table, so it does not recurse.

Columns allowed in a cancel UPDATE: only `cancelled_at` and `cancelled_by` may change. Enforce this in Task 2's trigger.

- [ ] **Step 2: Rolled-back test.** Use `supabase/tests/2026-10-17-06-pm-ops-rpcs.test.sql` as the template: inline the body, impersonate users in the demo tenant `ILIKE '%สร้างดี%'`, catch errors in nested blocks, and end with `RAISE EXCEPTION 'RESULT %'`. Assert:
  - The new columns exist with their defaults.
  - A PM can insert and select `boq_items`.
  - An ADMIN can read but not insert `progress_reports` (42501).
  - A PM can insert `progress_reports`.
  - A WORKER sees 0 rows of every new table.
  - An OWNER cannot INSERT or UPDATE `site_plans` directly (42501).
  - No new policy text contains `FROM <its own table>`. Query `pg_policy`.
- [ ] **Step 3: Dry-run** with `npx supabase db query --linked -f supabase/tests/2026-10-17-07-gantt-progress-schema.test.sql`. Expected: `RESULT` with every `*_MUST*` key as named.
- [ ] **Step 4: Commit** (not applied).

---

### Task 2: DB integrity triggers and RPCs (migration 08)

**Files:**
- Create: `supabase/migrations/2026-10-17-08-gantt-progress-logic.sql`
- Create: `supabase/tests/2026-10-17-08-gantt-progress-logic.test.sql` (inlines 07 and 08)

**Interfaces:**
- Consumes: the Task 1 schema and `can_manage_plan()`.
- Produces:
  - `save_site_plan(p_site_id uuid, p_note text) RETURNS int`: the new version number.
  - `split_task(p_task_id uuid, p_children jsonb) RETURNS void`. `p_children` is `[{"name":text,"weight_pts":numeric}]` and needs at least 2 items.
  - `record_progress(p_task_id uuid, p_qty numeric, p_work_date date, p_note text) RETURNS uuid`.
  - `cancel_progress(p_report_id uuid) RETURNS void`.
  - Internal `snapshot_site_plan(p_site_id uuid, p_note text, p_is_auto boolean, p_by text) RETURNS int`: SECURITY DEFINER, granted to **no one**.

Requirements (write each one as a plpgsql trigger or function):

1. **`snapshot_site_plan`** inserts `site_plans` with version = `COALESCE(max(version), 0) + 1` for the site. Take `pg_advisory_xact_lock(hashtext(p_site_id::text))` first. It then copies:
   - every phase that is not an issue phase (level `'phase'`, `weight = billing_weight_pct`, the dates, `is_vo`);
   - every `phase_subtasks` row (level `'subtask'`, `parent_ref_id = coalesce(parent_subtask_id, phase_id)`);
   - every card that is not an issue card (level `'task'`, `parent_ref_id = coalesce(parent_task_id, subtask_id, phase_id)`, `weight = weight_pts`, `planned_qty`, `start_date = NULL`, `end_date = due_date`).
2. **`save_site_plan`** is SECURITY DEFINER, `SET search_path = public`, granted to `authenticated`.
   - It requires `can_manage_plan()` and `tenant_can_write()`, and the site in `current_tenant_id()`. Otherwise it raises 42501 or P0002.
   - It validates, raising 22023 with these Thai messages:
     - no phase that is neither VO nor issue: "ยังไม่มีเฟส";
     - such a phase missing a start or end date: "เฟส <name> ยังไม่มีวันเริ่ม/วันจบ";
     - |Σ billing_weight_pct of those phases − 100| > 0.01: "น้ำหนักเฟสรวม <x>% ต้องเท่ากับ 100%";
     - `p_note` empty: "ต้องใส่เหตุผล".
   - It then calls `snapshot_site_plan(p_site_id, p_note, false, auth.email())`.
3. **`require_site_plan` gate** (BEFORE UPDATE OF status on `phase_tasks`, `site_phases`, `phase_subtasks`; BEFORE INSERT on `progress_reports`):
   - Raise 22023 "บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า" when the site has no `site_plans` row and the change is a progress change:
     - task status moving to `in_progress` or `done`;
     - phase or subtask status changing at all;
     - any `progress_reports` insert.
   - Exempt rows: `phase_tasks.issue_report_id IS NOT NULL`, `site_phases.is_issue_phase`, and any task whose phase is an issue phase.
   - Use a SECURITY DEFINER helper `site_has_plan(uuid)`, because PM and WORKER callers must see plans regardless of RLS.
4. **`check_node_weights`** (AFTER INSERT OR UPDATE OF weight_pts, parent_task_id, phase_id, subtask_id ON `phase_tasks`):
   - Lock with `PERFORM 1 FROM site_phases WHERE id = NEW.phase_id FOR UPDATE`.
   - Top-level, non-issue cards of the node `coalesce(subtask_id, phase_id)` must sum ≤ 100.005.
   - Children of `NEW.parent_task_id` must sum ≤ the parent's `weight_pts` + 0.005.
   - A child must not itself have children: if `NEW.parent_task_id` is set and the parent already has a `parent_task_id`, raise "แตกงานได้ชั้นเดียว".
   - Messages: "แต้มในเฟสนี้รวมเกิน 100" and "แต้มงานย่อยรวมเกินแต้มงานหลัก".
5. **`check_boq_qty`** (AFTER INSERT OR UPDATE OF planned_qty, boq_item_id ON `phase_tasks`): Σ `planned_qty` of cards linked to a BOQ line must be ≤ that line's `planned_qty`. Message: "จำนวนในการ์ดรวมเกิน BOQ".
6. **`sync_task_qty`** (AFTER INSERT OR UPDATE OF cancelled_at ON `progress_reports`):
   - Recompute `done_qty` = Σ qty of rows where `cancelled_at IS NULL`.
   - Set the status: 0 → `not_started`, below plan → `in_progress`, at or above plan → `done`.
   - Before updating, run `PERFORM set_config('app.derived_status','1',true)`; reset it afterwards.
7. **`record_progress`** is SECURITY INVOKER.
   - It checks the task is `progress_mode = 'quantity'` (else 22023 "การ์ดนี้ไม่ได้นับจำนวน").
   - It checks `p_qty > 0` and `done_qty + p_qty <= planned_qty` (else 22023 "เกินจำนวนที่เหลือ <remaining>").
   - It inserts the report with `site_id` taken from the task.
   - **`cancel_progress`** is SECURITY INVOKER and updates `cancelled_at = now()`, `cancelled_by = auth.email()`.
   - A BEFORE UPDATE trigger on `progress_reports` rejects a change to any column other than `cancelled_at` / `cancelled_by`, and rejects un-cancelling.
8. **`guard_derived_status`** (BEFORE UPDATE OF status ON `phase_tasks`): when `current_setting('app.derived_status', true) IS DISTINCT FROM '1'`, raise 22023:
   - on a quantity card: "งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป";
   - on a parent card (one with children): "สถานะงานหลักคิดจากงานย่อย".
9. **`sync_parent_status`** (AFTER UPDATE OF status, weight_pts OR INSERT OR DELETE ON `phase_tasks` where the row has a parent):
   - The parent becomes `done` if every child is done, `in_progress` if any child is not `not_started`, and `not_started` otherwise.
   - Set `app.derived_status` the same way as in item 6.
10. **`split_task`** is SECURITY INVOKER (RLS applies).
    - Rejects: a parent card (one with children), a child card, a quantity card, and fewer than 2 children.
    - The children's weights must sum to the parent's `weight_pts` within ±0.01.
    - Inserts the children with the same `phase_id`, `subtask_id`, `site_id`, `tenant_id` and `zone`, status `not_started`, and the parent's `sort_order` plus an index.
    - Then sets the parent's status from its children with the derived flag set.
11. **`boq_insert_for_quotation(p_quotation_id uuid) RETURNS int`** (SECURITY DEFINER, granted to no one) does the insert described here and returns rows added; trigger **`boq_from_quotation`** (AFTER UPDATE OF status, site_id ON `quotations` when `NEW.status = 'accepted' AND NEW.site_id IS NOT NULL`):
    - Insert `boq_items` from `quotation_items` with `item_type = 'item' AND quantity > 0`, using `ON CONFLICT (site_id, quotation_item_id) DO NOTHING`.
    - `code` = the running number for the site, as text (max numeric code + row_number).
    - `description` = the first line of the item description, capped at 200 characters.
    - Copy `unit`, `planned_qty = quantity`, and `sort_order`.
    - The function is SECURITY DEFINER, sets `tenant_id = NEW.tenant_id`, and is granted to no one.

Every SECURITY DEFINER function: `REVOKE ALL FROM PUBLIC, anon`. The public RPCs are granted to `authenticated`.

- [ ] **Step 1: Write the migration** with all 11 items.
- [ ] **Step 2: Rolled-back test.** Inline 07 and 08. In the demo tenant, as PM, using a fresh site created in the transaction, assert each case below and record SQLSTATE plus message:
  - (a) Moving a card to `done` before any PLAN raises 22023 with the gate message. Doing the same on an issue card succeeds.
  - (b) `save_site_plan` with no note raises 22023. With phase weights that don't sum to 100 it raises 22023. In a valid state it returns 1, and the second call returns 2. The items are copied, and the counts match the phases and cards.
  - (c) As OWNER, a direct UPDATE or DELETE on `site_plans` fails with 42501.
  - (d) Cards weighted 33.33 + 33.33 + 33.34 insert fine. A fourth card at 0.01 raises "แต้มในเฟสนี้รวมเกิน 100". Two inserts in one statement totalling 101 also fail.
  - (e) `split_task` with children 10 + 10 on a 20-point card works and the parent status becomes derived. Splitting a child raises 22023. Children summing 19 raise 22023.
  - (f) A quantity card with `planned_qty` 120 linked to a BOQ line of 120:
    - `record_progress(45)` gives done_qty 45 and status `in_progress`;
    - `record_progress(80)` raises "เกินจำนวนที่เหลือ 75";
    - `record_progress(75)` gives status `done`;
    - `cancel_progress` on the 75 entry gives done_qty 45 and status `in_progress`;
    - a direct status UPDATE raises the quantity-card message;
    - a second card with `planned_qty` 1 on the same BOQ line raises "จำนวนในการ์ดรวมเกิน BOQ".
  - (g) As ADMIN, `record_progress` raises 42501 and `save_site_plan` raises 42501.
  - (h) Accepting a quotation whose 3 item lines include 1 note line, with the site set, creates 2 `boq_items`. Re-accepting creates no duplicates.
  - (i) A WORKER moving an assigned status card on a site with a PLAN still works. That is today's MySchedule path.
- [ ] **Step 3: Dry-run.** Expected: every assertion as named.
- [ ] **Step 4: Commit.**

---

### Task 3: Progress SQL, snapshots, cron and data migration (migration 09)

**Files:**
- Create: `supabase/migrations/2026-10-17-09-gantt-progress-data.sql`
- Create: `supabase/tests/2026-10-17-09-gantt-progress-data.test.sql` (inlines 07, 08 and 09)
- Create: `src/pages/sites/progressCalc.fixtures.json` (shared with Task 4)

**Interfaces:**
- Produces:
  - `task_progress(p_task_id uuid) RETURNS numeric` (0–1).
  - `node_progress(p_node_id uuid) RETURNS numeric` (0–1). Recursive; a node is a phase or subtask id.
  - `site_progress_pct(p_site_id uuid) RETURNS TABLE(contract_pct numeric, total_pct numeric)`, both 0–100 rounded to 2 dp. `total_pct` is NULL when `contract_value` ≤ 0 or there is no VO.
  - All three are SECURITY INVOKER, STABLE, granted to `authenticated`.
  - Table `site_progress_daily(site_id uuid REFERENCES sites ON DELETE CASCADE, tenant_id uuid NOT NULL, day date, contract_pct numeric, total_pct numeric, PRIMARY KEY(site_id, day))`. RLS: site staff read.
  - `snapshot_site_progress() RETURNS int`: SECURITY DEFINER, granted to no one. It upserts today's row (Asia/Bangkok date) for every site with at least one phase that is not an issue phase.
  - pg_cron job `site-progress-snapshot` at `55 16 * * *` (23:55 Bangkok).

Formulas (spec §3):
- **Task:**
  - quantity card: `least(done_qty / planned_qty, 1)`;
  - parent card: `Σ(child.weight_pts × task_progress(child)) / parent.weight_pts`, or the mean of the children when the parent weight is 0;
  - status card: 1 if `done`, else 0.
- **Node:**
  - with child subtasks: Σ(child billing_weight_pct × node_progress(child)) / Σ billing_weight_pct, or the plain mean when Σ is 0;
  - else with top-level cards that are not issue cards: Σ(weight_pts × task_progress) / 100;
  - else: 1 if the node status is `done`, else 0.
- **Site:** as in Global Constraints.

Data migration in the same file, after the functions:
1. For every node, give the top-level, non-issue cards `weight_pts = round(100.0/n, 2)`. The first card by (sort_order, created_at) gets the remainder so the node sums to exactly 100. Issue cards get 0.
2. BOQ backfill: for each accepted quotation with a site, call `boq_insert_for_quotation(quotation_id)` (defined in migration 08, Task 2 item 11).
3. PLAN v1: for every site with a phase that is not an issue phase and no PLAN yet, call `snapshot_site_plan(site_id, 'สร้างอัตโนมัติตอนเปิดใช้ระบบ ' || to_char(current_date,'YYYY-MM-DD'), true, 'system')`.
4. Take the first snapshot: `SELECT snapshot_site_progress()`.

- [ ] **Step 1: Fixtures.** Write `progressCalc.fixtures.json`: an array of cases `{name, phases:[…], subtasks:[…], tasks:[…], contract_value, expect:{phases:{<id>:pct0to100}, contract_pct, total_pct}}`. Use these exact cases:
  - **"equal cards like today":** one phase, w 100. Cards 33.34 done, 33.33 in_progress, 33.33 not_started. Phase 33.34; contract 33.34.
  - **"new card from unallocated":** one phase, w 100. Cards 50 done, 30 not_started; 20 unallocated. Phase 50.
  - **"quantity card":** one phase, w 100. Card 40 quantity 45/120, card 60 done. Phase 75.
  - **"split parent":** one phase, w 100. Parent 20 with children 10 done and 10 not_started, plus card 80 not_started. Phase 10.
  - **"no cards uses status":** phases A (w 30, done, no cards) and B (w 70, in_progress, no cards). Contract 30.
  - **"vo two numbers":** phase A (w 100, card 100 done), VO phase B (vo_value 100000, card 100 not_started), contract_value 900000. Contract 100; total 90.
  - **"vo without contract value":** the same but contract_value 0. total_pct null.
  - **"issue excluded":** phase A (w 100, card 100 done) plus an issue phase with a not_started card. Contract 100.
  - **"subtasks weighted":** phase w 100 with subtasks S1 (w 25, done, no cards) and S2 (w 75, card 100 not_started). Phase 25.
- [ ] **Step 2: Write the migration** (functions, table, cron, data steps).
- [ ] **Step 3: Rolled-back test.**
  - (a) For each fixture case, insert the rows into a fresh site and assert the `node_progress` / `site_progress_pct` values. Generate the INSERTs from the JSON with a small `node` script, `scripts/gen-progress-fixture-sql.mjs`, committed with this task, and paste its output into the test.
  - (b) **Today's % unchanged.** Before the data steps, capture the old % per phase over the live cards: `round(100*done/total)` for top-level, non-issue cards. After the data steps, compare it with `round(node_progress(phase)*100)`. Expect 0 mismatches.
  - (c) The PLAN v1 count equals the number of sites with a phase that is not an issue phase.
  - (d) The BOQ backfill created at least 1 row. Re-running `boq_insert_for_quotation` adds 0 rows.
  - (e) `site_progress_daily` has today's rows.
  - (f) The cron job exists in the transaction. pg_cron `cron.schedule` inside a rolled-back transaction rolls back, so assert via `SELECT count(*) FROM cron.job WHERE jobname='site-progress-snapshot'`.
- [ ] **Step 4: Dry-run.** **Step 5: Commit.**

---

### Task 4: progressCalc.js and weighted numbers in Gantt and Kanban

**Files:**
- Create: `src/pages/sites/progressCalc.js`
- Create: `src/pages/sites/progressCalc.test.js`
- Modify: `src/pages/sites/phaseTasksCalc.js:16-24`. `computePhaseTaskStats(tasks)` keeps `total` and `done` counts, but `pct` becomes the weighted node % and is computed with `progressCalc`.
- Modify: `src/pages/sites/subtaskCalc.js:50-71`. The `computeNodeStats` pct for a node with subtasks becomes the weighted mean by `billing_weight_pct`.
- Modify: `src/pages/sites/GanttView.jsx:424-455`. The site KPI shows % ตามสัญญา, plus % รวม VO when `canSeeMoney(role)` and VO exists.
- Modify: `src/pages/sites/PhaseKanbanBoard.jsx`. Column header: node % plus "ยังไม่แจก x แต้ม" when unallocated > 0.

**Interfaces:**
- Produces, from `progressCalc.js`:
  - `taskProgress(task, childrenOf)` → number 0–1. `childrenOf(taskId)` returns the child task rows.
  - `nodeProgress(nodeId, { tasksByNode, subtasksByParent, nodeById })` → 0–1.
  - `unallocatedPoints(tasksInNode)` → number.
  - `siteProgress({ phases, subtasks, tasks, contractValue })` → `{ contractPct, totalPct|null, phasePct: {id: 0-100} }`.
- The rules are exactly the SQL formulas in Task 3. Rounding happens only at display (2 dp internally).

- [ ] **Step 1: Failing test** `progressCalc.test.js`. It loads `progressCalc.fixtures.json` and asserts every case's `expect` with `toBeCloseTo(…, 2)`. It also asserts `unallocatedPoints` of 50 + 30 is 20, and that issue cards are ignored.
- [ ] **Step 2: Run** `npx vitest run src/pages/sites/progressCalc.test.js`. Expected: FAIL because the module is missing.
- [ ] **Step 3: Implement** `progressCalc.js`, then switch `computePhaseTaskStats`, `computeNodeStats`, the Gantt KPI and the Kanban header to it.
  - Update existing tests whose expectations assumed count-based %. The old tests had equal-weight cards built without `weight_pts`. Treat cards with `weight_pts` undefined as an equal share of 100. That is the same rule as the migration, so old test data keeps its %. Document this in a code comment.
- [ ] **Step 4: Full suite green. Step 5: Commit.**

---

### Task 5: PLAN save dialog, versions list, no-PLAN banner

**Files:**
- Create: `src/pages/sites/PlanVersionsDialog.jsx`
- Modify: `src/hooks/useSupabase.js` (add `useSitePlans(siteId)` returning `{ plans: [{id, version, note, is_auto, created_by, created_at}], items: {planId: [...]}, reload }`)
- Modify: `src/pages/sites/GanttView.jsx` (banner and button; single-site view only)
- Test: `src/pages/sites/PlanVersionsDialog.test.jsx`

Rules (mockup screen 2):
- **No-PLAN banner** when the site has no plans. The text: "ยังไม่มี PLAN ต้องบันทึก PLAN v1 ก่อน จึงจะย้ายการ์ดไป "กำลังทำ/เสร็จ" หรือบันทึกยอดติดตั้งได้ ระหว่างนี้วางเฟสและการ์ดได้ตามปกติ". The "บันทึก PLAN v1" button shows only when `canManagePlan(role)`.
- Add `canManagePlan = role => role === 'OWNER' || role === 'PM'` to `src/lib/roles.js`, with a test.
- **"บันทึกเป็น PLAN ใหม่"** button (OWNER/PM) opens the dialog:
  - a required reason input;
  - the pre-checks shown live from the current phases: dates present, weights sum 100;
  - a save button that calls `rpc('save_site_plan', {p_site_id, p_note})`, which shows the returned DB error message on failure;
  - the history table: version, date, who, reason, and auto badge.
- Any error from the gate trigger anywhere in the app (drag, status select) already surfaces as an alert with the DB message. Leave those paths alone.
- Test: the dialog disables save when the reason is empty, calls the RPC with the trimmed note, and lists versions. The banner is hidden when plans exist. The button is hidden for ADMIN.

Steps: failing test → implement → suite green → commit.

---

### Task 6: Kanban cards — points, quantity, record dialog, split, VO phase fields

**Files:**
- Modify: `src/pages/sites/PhaseKanbanBoard.jsx` (card render about :857, drag about :823/:856, card form insert about :434 and edit about :444)
- Create: `src/pages/sites/RecordProgressDialog.jsx`
- Create: `src/pages/sites/SplitTaskDialog.jsx`
- Modify: `src/pages/sites/PhaseManageModal.jsx` (VO toggle plus `vo_ref`; the VO value field is shown only when `canSeeMoney(role)` and is saved to `phase_vo_values` (upsert on phase_id), never to `site_phases`)
- Modify: `src/hooks/useSupabase.js` (add `useBoqItems(siteId)` and `useProgressReports(taskId)`)
- Test: `src/pages/sites/kanbanProgress.test.jsx`

Rules (mockup screens 3–4):
- **Card display:**
  - a points pill "N แต้ม";
  - a quantity card shows a meter plus "45/120 <unit> · 37.5%" and a "+ บันทึกยอด" button (OWNER/PM);
  - a parent card lists its children with points and status.
- **Not draggable:** quantity cards and parent cards are not draggable (`draggable={canEdit && isStatusLeaf}`), and the drop handler ignores them.
- **Card form:**
  - "วิธีนับ" (status or quantity);
  - "แต้ม", pre-filled with the unallocated points;
  - for quantity: a BOQ line select showing remaining = BOQ qty − Σ other cards' `planned_qty`, plus "จำนวนในการ์ดนี้".
  - Saving writes `weight_pts`, `progress_mode`, `boq_item_id` and `planned_qty`. DB trigger errors are shown verbatim.
- **RecordProgressDialog:**
  - qty, work date (default today) and note;
  - the hint "ติดแล้ว X จาก Y · เหลือ Z · ใส่เกิน Z ไม่ได้";
  - save calls `rpc('record_progress', …)`;
  - the history list comes from `useProgressReports`, each row with a "ยกเลิกรายการ" button that calls `rpc('cancel_progress', …)` (OWNER/PM). Cancelled rows show struck through.
- **SplitTaskDialog:**
  - rows of name and points, defaulting to 2 rows splitting the parent's points equally (2 dp, remainder on the first row);
  - "+ เพิ่มแถว";
  - the live total "รวม a / b แต้ม ✓";
  - save calls `rpc('split_task', …)`.
  - The "แตกงาน" action sits in the card's menu for status leaf cards when `canEdit`.
- **Audit:** after weight edits and cancels, call `auditLog('phase_tasks', id, 'update', old, new)` or `auditLog('progress_reports', id, 'cancel', …)` (`src/lib/audit.js`).
- **Phone (≤900px):** the dialogs use the existing phone modal pattern. No new CSS outside `src/mobile.css`'s block.
- **Test:**
  - the points pill renders;
  - a quantity card is not draggable and shows its meter;
  - RecordProgressDialog blocks qty over the remaining amount client-side and calls the RPC;
  - SplitTaskDialog blocks a save when the total ≠ the parent's points;
  - an ADMIN sees no "+ บันทึกยอด";
  - a PM sees it.

Steps: failing test → implement → suite green → commit.

---

### Task 7: BOQ tab in site detail

**Files:**
- Create: `src/pages/sites/BoqTab.jsx`
- Modify: `src/pages/SiteDetail.jsx:23` (add tab `'boq'` with label "BOQ" between Kanban and รายงานประจำวัน, for site staff) and the phone tab list
- Test: `src/pages/sites/BoqTab.test.jsx`

Rules (mockup screen 5):
- Table columns: รหัส, รายการ, ตามสัญญา (qty + unit), อยู่ในการ์ด (Σ cards' `planned_qty`), ติดแล้ว (Σ `done_qty` of the linked cards).
- "อยู่ในการ์ด" = 0 is highlighted amber.
- Edit `code` / `description` inline. Delete a row; the confirm is built into the page, not `confirm()`.
- "+ เพิ่มบรรทัด" adds a manual row.
- "ดึงจากใบเสนอราคาอีกครั้ง" calls `rpc('boq_refresh_from_quotations', {p_site_id})`. Add this RPC to migration 08:
  - SECURITY DEFINER, `is_site_staff()` plus tenant check;
  - it runs `boq_insert_for_quotation` for every accepted quotation of the site.
  - `boq_insert_for_quotation` is defined in 08 (Task 2 item 11); this RPC also belongs in 08 — add it when implementing this task and keep the 08 test's inlined body in sync.
- No prices are shown, ever. BOQ rows carry none.
- Test: renders rows with sums from mocked cards, the amber state, and the refresh RPC call.

Steps: failing test → implement → suite green → commit.

---

### Task 8: PLAN layer on the Gantt and the S-curve "งานจริง %" mode

**Files:**
- Modify: `src/pages/sites/GanttView.jsx` (layer selector plus ghost bars plus delay tags; single-site view)
- Modify: `src/pages/sites/SCurveChart.jsx` (toggle `งานจริง % | เงิน`; the default for PM is งานจริง, and PM sees only งานจริง)
- Modify: `src/pages/SiteDetail.jsx` (PM now gets the S-curve again, in งานจริง mode only)
- Modify: `src/hooks/useSupabase.js` (add `useSiteProgressDaily(siteId)`)
- Test: `src/pages/sites/planLayer.test.jsx`

Rules (mockup screens 1 and 6):
- **Layer selector** `PLAN: ปิด | v1 | v2 …`. It defaults to the latest version, or ปิด when there is none.
- **Ghost bars:** for the chosen version, draw a thin grey bar (`--ghost`-like token from the existing palette; no new colours outside tokens) under each phase or subtask row, using that plan item's dates.
- **Delay tag:** end date (current) minus end date (plan), in days.
  - > 0: "ช้า n วัน", red.
  - < 0: "เร็ว n วัน", green.
  - 0: "ตรงแผน".
  - Rows missing from the plan show "ไม่มีใน PLAN".
- **KPI:** "ตาม PLAN vN วันนี้ควรได้ X%" with the gap "ช้ากว่าแผน/เร็วกว่าแผน Y%". X = the plan series value at today.
- **S-curve งานจริง mode:**
  - The plan line is `buildPlanSeries(planPhaseLeavesAsRows, 100)`. Reuse the existing function with contractValue = 100, which yields a % series from the version's phase items: `weight = billing_weight_pct`, with their dates.
  - The actual line is `site_progress_daily` (day → contract_pct) plus today's live `siteProgress().contractPct`.
  - The y-axis is in %.
  - The เงิน mode is unchanged and is shown only when `canSeeMoney(role)`.
- **Phone (≤900px):** the ghost bar sits under each phase card's track (mockup screen 7). It works inside the existing LandscapeView.
- **Test:**
  - ghost bars render for the chosen version;
  - the delay tag maths: plan end 2026-11-20, current end 2026-11-26 gives "ช้า 6 วัน";
  - "ไม่มีใน PLAN";
  - for PM the S-curve shows only งานจริง;
  - the plan series at 100 equals the weights.

Steps: failing test → implement → suite green → commit.

---

### Task 9: LINE and worker paths for the new rules

**Files:**
- Modify: `supabase/functions/line-webhook/index.ts`. The "งานเสร็จ" command is at about :1065-1072, and `resolveOpenTasksForWorker` / `resolveOpenTasksForSite` at about :509/:526.
- Modify: `supabase/functions/field-form/index.ts:98-105` (open-cards list)
- Modify: `src/pages/assign/MySchedule.jsx:98` (worker status change)
- Test: `src/lib/lineTaskRules.test.js` plus a new `supabase/functions/_shared/lineTaskRules.ts`

Rules:
- New pure helper `_shared/lineTaskRules.ts` exporting:
  - `isWorkerDoneable(task)`: true only for `progress_mode === 'status'` cards with no children;
  - `doneBlockedMessage(task)`: "งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป" for quantity cards, "งานนี้มีงานย่อย ให้กดเสร็จที่งานย่อย" for parent cards.
- The open-card lists in line-webhook and field-form exclude cards that are not doneable from the "งานเสร็จ" pick. Quantity cards stay visible for photo linking.
- **"งานเสร็จ":**
  - If the DB update returns the gate error (message contains "บันทึก PLAN v1"), reply "ไซท์นี้ยังไม่มี PLAN แจ้ง PM ให้บันทึก PLAN v1 ก่อน".
  - If it returns the quantity or parent message, reply that message.
  - Use the reply token; never push.
- **MySchedule:** the same messages show in the existing error alert. The status select is hidden for cards that are not doneable.
- Test: `isWorkerDoneable` and `doneBlockedMessage` for a status card, a quantity card, a parent card and a child card.
- **Do not deploy functions.**

Steps: failing test → implement → suite green → commit.

---

### Task 10: Release prep and full dry-run

**Files:**
- Modify: version and changelog. These are the same 3 files as release 1.21.0 (`git show --stat 930fb795`): `package.json`, `package-lock.json`, `src/changelog.json`. Bump to `1.22.0`, with a Thai entry in plain words.
- Create: `docs/superpowers/plans/2026-10-17-gantt-weighted-progress-verification.md`

- [ ] **Step 1:** Run `npx vitest run` (all green) and `npm run build`.
- [ ] **Step 2:** Re-run the 07, 08 and 09 rolled-back tests and paste the RESULT JSONs.
- [ ] **Step 3:** Write the verification doc.
  - Verified: SQL as PM / ADMIN / OWNER / WORKER, today's % unchanged, the fixture parity between JS and SQL.
  - Not verified: live UI clicks, LINE replies (functions not deployed), the cron run at 23:55.
  - Release order:
    1. apply 07 → 08 → 09;
    2. deploy `line-webhook` and `field-form` (`--no-verify-jwt`);
    3. `npm run deploy`;
    4. after 23:55, check the first cron snapshot row.
- [ ] **Step 4:** Commit. **Stop.** Apply and deploy happen only after the owner says so.
