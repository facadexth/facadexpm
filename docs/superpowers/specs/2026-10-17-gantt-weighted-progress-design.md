# Gantt weighted progress (ความคืบหน้าจริงของ Gantt) — design spec

Date: 2026-10-17. Design discussion artifact (owner-facing, Thai):
https://claude.ai/artifact/Monre7tEEiJCCxKzZtL2Mr (v2). UI mockup: see §12.

## 1. Problem

Inside a phase, progress is `done cards ÷ all cards`
(`computePhaseTaskStats`, src/pages/sites/phaseTasksCalc.js:15). Adding a card
grows the denominator, so % drops although nothing on site went backwards.
The site KPI "ความคืบหน้ารวม" (GanttView.jsx:424) counts finished phases and
ignores the phase weights. Installation work (120 windows) can only be
"not started / in progress / done". There is no frozen plan to compare against:
when the PM moves Gantt dates the plan moves with them.

## 2. Owner decisions (binding)

1. A status card that is "กำลังทำ" counts **0%** until it is done. No manual %
   mode.
2. **BOQ is created automatically** from accepted quotations on the site.
3. Baseline = **PLAN version** (PLAN v1, v2 …). Once saved it can never be
   edited or deleted by anyone. Comparison = switch on a **PLAN layer** on the
   Gantt (and the S-curve plan line follows the chosen version).
4. Who can save a PLAN version and record installed quantities: **OWNER and
   PM only** (not ADMIN). The app has no PM role today, so this arc adds one
   (§13). Owner decisions 2026-10-17: PM = field/site manager, sees **all
   sites**, **no money pages**.
5. A **PLAN v1 is required** before any progress can be recorded on a site.
6. VO is shown as **two numbers**: % ตามสัญญา and % รวม VO.
7. **Installed quantities reported in LINE are NOT counted** (for now). The PM
   enters quantities in the app. No approval queue. LINE text/photos keep
   working as today for viewing.

## 3. Progress model

**Node** = a phase, or a leaf `phase_subtasks` row (the subtask tree exists in
code; 0 rows live). Every node owns **100 points** for the cards directly in it.

- `phase_tasks.weight_pts numeric(6,2)` ≥ 0. Sum of top-level cards in a node
  ≤ 100. Points not given to any card = **unallocated**, counted as 0 progress
  (the UI shows "ยังไม่แจก x แต้ม").
- `phase_tasks.progress_mode` ∈ `status` (default) | `quantity`.
- Card progress (0–1):
  - status card: `done` → 1, otherwise 0.
  - quantity card: `min(done_qty / planned_qty, 1)`.
  - parent card (has children, see split): weighted mean of its children.
- Node progress:
  - node with cards: `Σ(weight_pts × card progress) / 100`.
  - node without cards: phase/subtask `status = done` → 1, else 0 (today's
    behaviour for the ~950 phases that have no cards).
  - node with child subtasks: `Σ(child billing_weight_pct × child progress) /
    Σ(child billing_weight_pct)` (replaces the count-based rollup in
    `computeNodeStats`, subtaskCalc.js:51).
- **Site % ตามสัญญา** = `Σ(w × p) / Σ w` over non-VO, non-issue phases, where
  `w = billing_weight_pct` (already sums to 100 per site).
- **Site % รวม VO** = `(contract_value × contract% + Σ vo_value × vo_phase%) /
  (contract_value + Σ vo_value)`. If `contract_value` is 0/null (103 of 147
  sites today) only % ตามสัญญา is shown, with "VO n รายการ".
- Issue phases/cards (`is_issue_phase`, `issue_report_id`) have weight 0 and are
  excluded everywhere, as today.

% can only go down through deliberate actions: reopening a done card,
cancelling a quantity entry, or changing weights. Each of those is written to
`audit_logs` via `auditLog()` (src/lib/audit.js).

## 4. Split vs new card vs VO

- **New card** in a node: its points come from the unallocated pool. The form
  pre-fills the remaining points; if 0 remain the user must split a card or
  lower another card's points.
- **Split (แตกงาน)**: a card becomes a parent; children get
  `parent_task_id` and divide the parent's points (default equal, editable,
  must sum to the parent's points). One level only (a child cannot be split).
  The parent's own status becomes derived from its children and is not
  draggable.
- **VO**: a new phase with `site_phases.is_vo = true`, VO value in admin-only `phase_vo_values.vo_value numeric`
  (money, optional), `vo_ref text` (VO number). VO phases have
  `billing_weight_pct = 0`, so the money S-curve and the 100% contract-weight
  check are unchanged.

## 5. BOQ and quantity cards

- Table `boq_items(id, tenant_id, site_id, quotation_item_id NULL ON DELETE SET
  NULL, code text, description text, unit text, planned_qty numeric > 0,
  sort_order, created_at)`.
- Auto-create: trigger on `quotations` when `status` becomes `accepted` with a
  `site_id` → one row per `quotation_items` row with `item_type = 'item'` and
  `quantity > 0`, skipping rows already linked. `code` = running number within
  the site ("1", "2", …), editable. Backfill once for the 61 accepted
  quotations with a site. Lump-sum lines ("งานตามสัญญา", unit งาน) are imported
  too; the PM can delete them. Un-accepting a quotation leaves BOQ rows as-is.
- A quantity card links `boq_item_id` and has its own `planned_qty` (a BOQ
  line can be split over several cards, e.g. by floor). Sum of cards'
  `planned_qty` per BOQ line ≤ BOQ `planned_qty` (trigger check).
- Table `progress_reports(id, tenant_id, site_id, task_id, qty numeric <> 0,
  work_date date default today, note, source text default 'web' CHECK in
  ('web'), cancelled_at, cancelled_by, created_by default auth.email(),
  created_at)`. Insert/cancel: OWNER or PM only (`can_manage_plan()`). Rows are never deleted; a
  wrong entry is cancelled.
- Trigger `sync_task_qty`: recomputes `done_qty` = Σ qty of non-cancelled
  reports and sets the card status (`0` → not_started, `< planned` →
  in_progress, `≥ planned` → done). Insert is rejected when it would exceed
  `planned_qty`.
- Direct status changes on quantity cards (drag, MySchedule, LINE "งานเสร็จ")
  are rejected by a trigger. The LINE webhook replies
  "งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป".

## 6. PLAN versions

- `site_plans(id, tenant_id, site_id, version int, note text NOT NULL,
  is_auto bool, created_by, created_at, UNIQUE(site_id, version))`.
- `site_plan_items(plan_id, level ('phase'|'subtask'|'task'), ref_id,
  parent_ref_id, name, start_date, end_date, weight, planned_qty, is_vo,
  PRIMARY KEY(plan_id, level, ref_id))` — a copy of the plan at save time.
- Created only via RPC `save_site_plan(p_site_id uuid, p_note text)`
  (SECURITY DEFINER, checks `can_manage_plan()` (OWNER or PM) and tenant, REVOKE from
  PUBLIC/anon, GRANT to authenticated). No UPDATE/DELETE RLS policy and UPDATE/
  DELETE revoked → immutable. Site deletion still cascades (FK).
- Saving needs: at least one phase, every non-VO phase has both dates, contract
  weights sum to 100.
- **Requirement gate**: trigger `require_site_plan` rejects, on sites without
  any `site_plans` row: card status change to in_progress/done, phase/subtask
  status change, and `progress_reports` insert. Issue phases/cards are exempt
  (they are driven by LINE issue reports). Message: "บันทึก PLAN v1 ของไซท์นี้
  ก่อนเริ่มบันทึกความคืบหน้า". The LINE webhook relays it to the worker.
- **Migration creates PLAN v1 automatically** for every site that already has
  phases (`is_auto = true`, note "สร้างอัตโนมัติตอนเปิดใช้ระบบ 2026-10-xx"),
  so no running site is blocked. Sites without full dates still get it; their
  undated phases are simply not drawn in the layer.

## 7. Where numbers appear (UI)

- **Gantt** (GanttView.jsx): bar labels and node % use §3; site KPI
  "ความคืบหน้ารวม" becomes weighted (+ "รวม VO" when there is VO);
  **PLAN layer switch** `PLAN: ปิด | v1 | v2 …` draws a thin grey bar under each
  phase/subtask for the chosen version and a "ช้า n วัน / เร็ว n วัน" tag from
  end-date difference. Phases added after that version show "ไม่มีใน PLAN".
  Banner when the site has no PLAN with a "บันทึก PLAN v1" button
  (OWNER/PM). "บันทึกเป็น PLAN ใหม่" opens a dialog that requires a reason
  and lists the versions (version, date, who, reason).
- **Kanban** (PhaseKanbanBoard.jsx): card shows points and, for quantity cards,
  `45/120 ชุด` with a progress bar and "+ บันทึกยอด" (OWNER/PM); quantity
  cards are not draggable. Column header shows node % and unallocated points.
  Card form: points, mode, BOQ line + planned qty. "แตกงาน" action.
- **BOQ tab** in site detail: lines with planned / assigned to cards /
  installed; edit code/description; delete; "ดึงจากใบเสนอราคาอีกครั้ง".
- **S-curve** (SCurveChart.jsx): new toggle `งานจริง % | เงิน`. งานจริง: plan
  line = chosen PLAN version's phase weights ramped linearly over their dates
  (same shape as `buildPlanSeries`), actual line = daily snapshots + today's
  live value. เงิน = unchanged.
- Sites list, Dashboard, LINE billing text keep the money `billing_pct`
  (out of scope).
- Phone (≤900px) gets all of the above inside the existing phone layout;
  laptop and landscape iPad layouts change only by the new controls.

## 8. Daily snapshots

`site_progress_daily(site_id, day, contract_pct, PRIMARY KEY` (+ admin-only `site_progress_daily_money(site_id, day, total_pct)`), PRIMARY KEY
(site_id, day))`, filled by SQL function `snapshot_site_progress()` from the
`site_progress` view, scheduled with pg_cron at 23:55 Asia/Bangkok (pg_cron is
installed; 4 jobs exist). History starts on the migration day.

## 9. Calculation code

- SQL views `task_progress`, `node_progress`, `site_progress`
  (`security_invoker = true`) — used by snapshots and RPCs.
- JS mirror `src/pages/sites/progressCalc.js` used by the UI for instant
  updates. Both are tested against the same fixture table
  (`progressCalc.fixtures.json`): vitest for JS, a rolled-back SQL test for
  the view.
- `computePhaseTaskStats` keeps `total/done` counts for labels but its `pct`
  becomes weighted.

## 10. Migration of existing data

- 144 cards in 18 sites: `weight_pts` = 100 ÷ n per node, rounded to 2 dp with
  the remainder on the first card so the node sums to exactly 100 → every
  phase shows the same % as today.
- `progress_mode = 'status'` for all.
- Issue cards: weight 0.
- BOQ backfill (§5) and PLAN v1 auto (§6).
- Dry-run the whole migration in a rolled-back transaction first and compare
  per-phase % before/after (must be identical).

## 11. Out of scope

LINE quantity reporting; approval queue; manual % mode; physical % on Sites
list/Dashboard; actual start/end dates per phase; editing a saved PLAN.

## 12. Build order (each step mergeable)

0. PM role (§13).
1. DB: columns, tables, triggers, RPC, views, cron, data migration (+ fixtures).
2. Weighted calc in UI (progressCalc + Gantt/Kanban labels + KPI). PLAN save
   dialog + gate banner.
3. Card points/split/quantity + BOQ tab + progress entry.
4. PLAN layer on Gantt + S-curve งานจริง mode.
5. LINE webhook messages (quantity card, no-PLAN) — edge function deploy.

UI mockup artifact must be approved by the owner before step 2.

## 13. New role: PM

Owner decisions 2026-10-17 (binding):
- PM = field/site manager, a **sibling** of ADMIN (ADMIN = office/accounting).
  Sees **all sites**. **No money anywhere.**
- PM saves PLAN versions and records quantities; ADMIN does not.
- PM sees purchase orders and inventory **without prices/costs** (items,
  quantities, receiving status, stock on hand).
- PM **counts as an admin seat** in the package limit.
- PM gets **site notifications** (issue reports, material requests, leave
  requests, worker offboarded) and **can approve leave**. PM never gets money
  notifications (cheque reminders, quotation follow-ups).
- PM **can manage worker teams**.

Access, enforced in the database (RLS / views), not only in the UI:

| Area | PM |
|---|---|
| sites (ops columns), site_phases, phase_subtasks, phase_tasks, phase_task_workers, boq_items, progress_reports, site_plans (via RPC), site_attachments, line_site_photos, line_issue_reports, worker_assignments, worker_ot, worker_teams, worker_team_members, leave_requests, storage buckets site-attachments + line-site-photos | read + write |
| workers (no salary columns), worker_checkins, line_checkins, company_holidays, clients (name/contact), units, suppliers (name) | read |
| purchase orders, PO items, PO attachments, inventory items/balances/movements | read through price-free views only |
| incomes, expenses, invoices, receipts, quotations (+items), cheques, deposits, retention, salary_records, labor_*, supplier tax invoices / credit notes / deposits, po_receipts, bank_accounts, app_settings, estimation/alu/bom, LINE settings, user_roles writes, audit_logs | none |

Mechanics:
- CHECK on `user_roles.role` gains `'PM'` (constraint name verified in
  pg_constraint first).
- New helpers (SECURITY DEFINER, STABLE, wrapped as `(SELECT fn())` in
  policies): `is_pm()`, `is_site_staff()` = OWNER/ADMIN/PM,
  `can_manage_plan()` = OWNER/PM. `is_admin_or_owner()` is **unchanged**, so
  all ~140 money policies keep denying PM.
- Site-ops policies switch from `is_admin_or_owner()` to `is_site_staff()`.
  FOR ALL policies on PM-read tables get a separate `pm_reads` SELECT policy.
- RLS cannot hide columns, so PM reads money-bearing tables through
  **price-free views** that filter tenant and role themselves
  (security_invoker = false, `WHERE tenant_id = current_tenant_id() AND
  is_pm()`): `sites_ops`, `workers_ops`, `purchase_orders_ops`,
  `purchase_order_items_ops`, `inventory_ops`. PM has **no** direct SELECT on
  `sites`, `workers`, `purchase_order*`, `inventory_*` money columns: PM's
  base-table policies on `sites` and `workers` allow UPDATE/INSERT of ops
  columns only through column-level GRANTs or narrow RPCs (decided in the
  plan after a dry-run).
- Seat limit: `tenant_under_seat_limit('admins')`, `tenant_seat_status`, and
  the user_roles policies count `OWNER, ADMIN, PM`.
- RPCs that must also allow PM: `perform_location_checkin/checkout`,
  `register_push_subscription`. Edge functions: `route-distance`,
  `extract-map-coordinates`, `web-push-test`, `leave-notify` (approve).
- Notifications: `sendWebPushToTenantAdmins` and `field-form notifyAdmins` get
  an audience parameter: `ops` (OWNER, ADMIN, PM) for issue/material/leave/
  offboarding, `money` (OWNER, ADMIN) for cheques/quotations.
- Frontend: `useUserRole` exposes capability flags (`canManageSites`,
  `canSeeMoney`, `canManagePlan`, `canManageTeams`, `canApproveLeave`) and
  pages stop using the linear `isAtLeast('ADMIN')` where PM matters;
  `DEFAULT_PERMISSIONS.PM`; `getPageLevel` defaults unknown role/page to
  `'none'` for PM; nav regroups so PO/inventory are not under the money group
  for PM; UserManagement + Settings permission editor list PM; money sections
  (Assign labor cost, GridView daily rate, DayView costs, HR payroll tab and
  salary fields, Sites cost/contract fields, SiteOverview financials, money
  S-curve, Dashboard financial KPIs and billing %) are hidden for PM.
- Role inventory with file:line for every check:
  `docs/superpowers/specs/2026-10-17-pm-role-inventory.md`.
- Laptop/iPad layouts unchanged for existing roles.
