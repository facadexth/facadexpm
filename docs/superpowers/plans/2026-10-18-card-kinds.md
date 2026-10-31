# Card Kinds (BOQ vs General) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Rework Part B (unreleased) so that only BOQ cards count toward progress, with points set automatically from each BOQ line's share of quotation value. General task cards have 0 points and exist only to assign work.

**Architecture:**
- The card kind is derived from `progress_mode`:
  - `quantity` is a **BOQ card**. It must have a `boq_item_id` and a `planned_qty`, and it counts toward progress.
  - `status` is a **general card**. Its `weight_pts` is always 0 and it never counts.
- A SECURITY DEFINER function recomputes the BOQ cards' `weight_pts` per node from their value share. PM never sees prices.
- Node progress:
  - If the node has BOQ cards: Σ(w·p)/100.
  - Otherwise it uses the node's status. When the node has general cards, its status comes from those cards (all done → done → 1, else 0). Otherwise it is the node's own status column.
- Migrations 07/08/09 are **unapplied**, so they are edited in place, and their tests keep byte-identical inlined bodies.

**Spec:** Owner decisions 2026-10-18, as approved in mockup https://claude.ai/artifact/3aDFZHB7N4XqD9t27kDsZt. They amend `docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md` §3–§5:
1. Two card kinds: BOQ cards count, general cards don't.
2. A phase with no BOQ cards takes its % from the phase status, derived from its general cards as today.
3. BOQ card points are split by quotation value share. PM sees points only, never prices.
4. All existing cards become general cards. Some phase % values will drop; the owner accepted this.

Unchanged: PLAN versions, the PLAN gate, VO, quantity recording/cancel, the BOQ tab, the PM no-money rule, and every Part B fix and ruling (`docs/superpowers/plans/2026-10-17-gantt-weighted-progress-ledger.md`).

## Global Constraints

**Card rules**
- A general card (`progress_mode = 'status'`) always has `weight_pts = 0`. A trigger forces this; any client-sent weight is ignored.
- A BOQ card (`progress_mode = 'quantity'`) requires `boq_item_id IS NOT NULL` and `planned_qty IS NOT NULL`. Add this as a CHECK in 07, replacing `phase_tasks_quantity_needs_plan`.
- Users never set BOQ card points. `weight_pts` is written only by `recompute_node_weights(node uuid)` under `app.derived_status = '1'`. The guard still rejects user changes to `weight_pts`.

**Point calculation**
- Card value = `planned_qty × unit_value` of its BOQ line.
  - `unit_value` = `quotation_items.line_total / quotation_items.quantity` when the line comes from a quotation and quantity > 0.
  - Otherwise (manual line, or no price) the card value is NULL.
- A card with a NULL value gets the average value of the priced BOQ cards in the same node. If no card in the node is priced, every BOQ card in the node gets an equal share.
- Points per node = 100 × value / Σ value, rounded to 2 dp. Any remainder goes on the first card by (sort_order, created_at), so the node's BOQ cards sum to exactly 100.

**When points are recomputed**
- Recompute for the affected node(s) after:
  - INSERT, DELETE or UPDATE of `phase_tasks` columns `progress_mode`, `planned_qty`, `boq_item_id`, `phase_id`, `subtask_id`, `parent_task_id`;
  - UPDATE of `boq_items.planned_qty`;
  - UPDATE of `quotation_items` `line_total` / `quantity` for lines linked to a BOQ.
- The recompute recalculates the node's BOQ cards only.

**Split and money**
- Split applies to **general cards only**, at any status. Children get weight 0. The parent's status is derived from its children (existing trigger). The earlier rule "split only not_started" is removed.
- Prices never reach PM. `boq_value_shares(p_site_id uuid) RETURNS TABLE(boq_item_id uuid, share_pct numeric)` is SECURITY DEFINER and returns only percentages (0–100, 2 dp, summing to 100 per site over lines with planned_qty), checks `is_site_staff()` and the tenant, and is granted to `authenticated`.

**Process**
- Every new SECURITY DEFINER function: `SET search_path = public`, REVOKE from PUBLIC and anon, explicit GRANT (or none for internal functions).
- Never apply, never deploy. Dry-run only.
- `npx vitest run` must stay green.
- Commit with `-F`, ending with the Co-Authored-By and Claude-Session lines.

## Review Focus
1. Money leak: a PM must not be able to work out prices from points. Points are per node and shares are per site. Accepted: a share reveals relative value only, which the owner chose in mockup screen 4.
2. Recompute storms or loops. The recompute runs under the derived flag, and the trigger must not re-fire itself.
3. A phase with both BOQ and general cards. Only the BOQ cards count, and the general cards never change the %.
4. Data migration: existing cards get weight 0. The per-site report of phases whose % changes (old count-based % vs new) is produced for the owner before apply.
5. A quantity card whose BOQ line is deleted (FK SET NULL) would violate the new CHECK. Handle it: block deleting a BOQ line that has cards. The error message is "รายการ BOQ นี้มีการ์ดผูกอยู่ ย้ายหรือลบการ์ดก่อน".

---

### Task 1: DB — card kinds, value-share points, progress, data (edit 07/08/09 in place)

**Files:** `supabase/migrations/2026-10-17-07-…`, `-08-…`, `-09-…`, and their three tests. Also `src/pages/sites/progressCalc.fixtures.json` and `scripts/gen-progress-fixture-sql.mjs` (regenerate).

Requirements:
- **07: card constraints.**
  - Replace the quantity CHECK with `CHECK (progress_mode = 'status' OR (boq_item_id IS NOT NULL AND planned_qty IS NOT NULL))`.
  - Change `phase_tasks.boq_item_id` to `ON DELETE RESTRICT`, so a BOQ line with cards cannot be deleted.
  - Add a BEFORE DELETE trigger on `boq_items` that raises the Thai message from Review Focus #5 when cards are linked.
- **08: point maintenance.**
  - Add the internal SECURITY DEFINER `recompute_node_weights(p_node uuid)` and `node_of(task)`.
  - Add triggers that force weight 0 on general cards and call the recompute (under the flag) on the events listed in Global Constraints.
  - Update `check_node_weights`: general cards always 0; the BOQ sum is 100 by construction.
  - Change `split_task`: general cards only (raise 22023 'แตกงานได้เฉพาะงานทั่วไป' for a BOQ card), any status, children weight 0.
  - Add `boq_value_shares`.
  - Keep every earlier rule: PLAN gate (UPDATE and INSERT), cross-tenant checks, history keeping, qty guards, FOR NO KEY UPDATE.
- **09: progress maths.**
  - `task_progress`: unchanged.
  - `node_progress`:
    - child subtasks: weighted as before;
    - else node has BOQ cards (quantity, non-issue, top-level): Σ w·p / 100;
    - else node has non-issue top-level general cards: 1 if all are done, else 0;
    - else node status `done` → 1, else 0.
  - `site_progress_pct`: unchanged in shape.
  - Data step: remove the equal-weights step (all existing cards stay general with weight 0). Keep PLAN v1 auto, the BOQ backfill and the first snapshot.
  - Demo seed: drop `set_equal_card_weights`; keep the flag and PLAN step.
  - Replace the "today's % unchanged" gate with a **report** in the test RESULT: count of phases whose % changes, plus the per-site list (site_number, phase name, old %, new %).
- **Fixtures.** Rewrite the cases to the new model, regenerate the SQL with the generator, and keep the JS and SQL in parity. At minimum:
  - only general cards with partial done → 0; all done → 100;
  - BOQ cards with value shares 70/15/15 → weighted;
  - a priced card plus an unpriced card → the unpriced one uses the average;
  - no priced cards → equal;
  - BOQ plus general cards in the same node → general ignored;
  - VO / issue / subtask cases kept.
- **Tests.**
  - General card weight is forced to 0 even when 50 is sent.
  - Adding a BOQ card recomputes points to sum 100, with shares matching value.
  - A BOQ `planned_qty` change recomputes.
  - Deleting a BOQ line with cards → 22023/23503 with the Thai message.
  - Splitting a BOQ card → 22023; splitting a done general card → ok, and node % unchanged.
  - As PM: `boq_value_shares` returns percentages only, with no price key.
  - As WORKER: 42501 / 0 rows.
  - The per-site change report is present.

### Task 2: UI — card form kinds, auto points, general card style, BOQ share column

**Files:**
- `src/pages/sites/progressCalc.js` (+ test): mirror the new `node_progress` rules exactly, and drop `unallocatedPoints` use in the UI.
- `src/pages/sites/PhaseKanbanBoard.jsx`:
  - the new-card form asks first: "งาน BOQ (นับ %)" / "งานทั่วไป (ไม่นับ %)";
  - BOQ needs a line + qty and shows "แต้มคิดให้อัตโนมัติจากมูลค่า"; there is no points field anywhere;
  - general cards render dashed with the tag "งานทั่วไป · ไม่นับ %";
  - BOQ cards show "BOQ · N แต้ม";
  - remove the "ยังไม่แจก x แต้ม" pill;
  - "แตกงาน" is offered only on general cards (any status).
- `src/pages/sites/BoqTab.jsx`: add a "สัดส่วนงาน" column from `rpc('boq_value_shares')` (fail soft). Deleting a line with cards shows the DB message verbatim.
- `src/pages/sites/SplitTaskDialog.jsx`: no points rows. Children are names only, for general cards.
- Update the affected tests.

Mockup screens 1, 3 and 4 are the reference. Before the migration, the probe-gated behaviour stays as it is today.

### Task 3: Release prep refresh

- Pre-deploy checklist: check `build-info.json`; merge the live commit if it is new; set the version above the live version (keep 1.22.0 if live is still ≤ 1.21.x).
- Update the changelog wording to describe the two card kinds.
- Re-run all three dry-runs, vitest and build.
- Update the verification doc, including the per-site "% change" report table the owner asked to see before apply. Stop there.
