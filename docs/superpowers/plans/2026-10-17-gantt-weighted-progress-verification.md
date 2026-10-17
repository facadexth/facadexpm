# Gantt weighted progress: release verification (1.22.0)

Date: 2026-10-17, refreshed 2026-10-18 after the card-kinds rework (BOQ cards vs general cards).
Branch `feat/gantt-weighted-progress`. Nothing is applied or deployed yet.

## Base

- Live at prep time: `https://changpm.app/build-info.json` = commit `809be98b` (branch
  `fix/fast-invoice-stock-deduction`, v1.21.2). That commit already contains Part A (PM role,
  migrations 04/05/06).
- `809be98b` merged into this branch with no conflicts (merge commit `84f64b6b`).
- Migrations the merge brought in (already live from that branch, nothing to apply for them):
  `2026-10-17-04-stock-movements-batch`, `2026-10-17-05-stock-documents`,
  `2026-10-17-10-stock-as-of-invoice-date`, `2026-10-17-11-deduction-guard-relative`,
  `2026-10-19-01..04` (payroll). None of them is numbered 07, 08 or 09, so they don't collide with ours.
  Note: 04 and 05 now have two files each (stock and Part A). All four are already applied.
- Version 1.22.0 (live is 1.21.2): `package.json`, `package-lock.json` (both entries), `src/changelog.json`.
- Re-checked 2026-10-18: live `build-info.json` is still `809be98b` (v1.21.2), which is already in this
  branch, so nothing new to merge and the version stays 1.22.0.

## Card kinds (2026-10-18 rework)

The owner's rule replaced hand-entered points:

- **BOQ card** (`progress_mode = 'quantity'`): linked to one BOQ line with a qty. Only these count toward
  a node's %. Their points are split automatically by value (each card's share of the node's BOQ value,
  from the BOQ lines' quotation prices). PM sees points and % shares only, never a price.
- **General card** (`progress_mode = 'status'`): for assigning and paying work. Always 0 points and never
  counts toward %. Only general cards can be split (any status); a split parent's status comes from its
  children.
- **Node with no BOQ card**: counts by status, done/not done (100 only when all its top-level non-issue
  cards are done, else 0; with no cards, the phase status).
- Issue phases and issue cards never count.

UI (Kanban, BOQ tab):

- The card form asks "ชนิดงาน": งาน BOQ (นับ %) / งานทั่วไป (ไม่นับ %). There is no points field.
- A new card defaults to BOQ when the site has at least one BOQ line, else general.
- In an issue phase a new card offers only the general kind.
- The board header shows "ความคืบหน้า n%" and a caption:
  - "คิดจากการ์ด BOQ n ใบ · แต้มแบ่งตามมูลค่า" when the node has top-level non-issue BOQ cards;
  - "คิดจากสถานะเฟส" otherwise.
  - The caption appears only once the schema probe is ready.
- BOQ cards show "BOQ · N แต้ม". General cards are dashed and show "งานทั่วไป · ไม่นับ %".
- The BOQ tab has a "สัดส่วนงาน" column (%) from `boq_value_shares`. It calls that RPC only once the
  schema probe is ready.

Data migration 09 leaves every existing card a general card with 0 points (`b_cards_not_general_zero` 0)
and writes no card or phase row (`b_cards_changed` 0, `b_phases_changed` 0). So a phase with cards and no
BOQ card now shows 100 only when all its cards are done. That changes today's % on 7 phases (table below).

### Per-site "% change" report (from the 09 dry run, RESULT `pct_change_report`, 2026-10-18)

49 phases with cards compared on 18 sites (143 cards); 7 change (`phases_changed` 7, report rows = 7).
Old = the app today: round(100 × done ÷ top-level non-issue cards); new = the card-kinds rule.

| Site | Phase | Old % | New % |
|---|---|---|---|
| FX-2026-001 | ผลิต | 14 | 0 |
| FX-2026-094 | เก็บงานรอบสุดท้าย | 25 | 0 |
| SD-2026-001 (demo) | งานตกแต่งและส่งมอบ | 33 | 0 |
| SD-2026-002 (demo) | งานสถาปัตย์และระบบ | 67 | 0 |
| SD-2026-003 (demo) | งานโครงสร้าง | 67 | 0 |
| SD-2026-005 (demo) | งานเตรียมการและฐานราก | 33 | 0 |
| SD-2026-009 (demo) | งานเตรียมการและฐานราก | 67 | 0 |

Only 2 real-customer phases change (both partly done, no BOQ card yet). The other 5 are demo tenant
(สร้างดี) phases. Once the PM turns the right cards into BOQ cards, those phases count by value again.

## Verified

| Check | Result |
|---|---|
| `npx vitest run` after the merge and version bump | 135 files, 1519 tests passed |
| `npx vitest run` after the final-review fixes | 135 files, 1536 tests passed |
| `npm run build` | OK (after the final-review fixes, build info commit fff3c130) |
| `npx vitest run` after the card-kinds rework + UI polish (2026-10-18) | 135 files, 1562 passed, 2 failed: the known `src/pages/pmPages.test.jsx` "Assign shows the crew…" UTC-today bug |
| `TZ=UTC npx vitest run src/pages/pmPages.test.jsx` | 31/31 passed |
| `npm run build` (2026-10-18) | OK, build info commit 71d29729 |
| Inlined migration bodies in the tests (text between `BEGIN;` and `COMMIT;`) are byte-identical to the migration files | 07 in tests 07/08/09, 08 in tests 08/09, 09 in test 09: all identical, each found exactly once |
| 07 rolled-back test on CHANG (2026-10-18, card kinds) | 62 keys, 55/55 MUST keys as expected |
| 08 rolled-back test on CHANG (2026-10-18, card kinds) | 147 keys, 146/146 MUST keys as expected |
| 09 rolled-back test on CHANG (2026-10-18, card kinds) | 149 keys, 140/140 MUST keys as expected |
| SQL as PM / ADMIN / OWNER / WORKER (RLS, grants, VO value privacy) | covered by the 07/08/09 assertions above |
| 09 writes no card or phase row; every card stays general with 0 points | 09: `b_cards_changed_MUST0` 0, `b_phases_changed_MUST0` 0, `b_cards_not_general_zero_MUST0` 0 |
| % changes are listed for the owner | 09: `phases_changed` 7, `b_report_rows_equal_phases_changed_MUSTtrue` true (table above) |
| Fixture parity between JS and SQL progress maths | 09: `a_fixture_mismatches_MUST0` = 0 |

Each test ends with `RAISE EXCEPTION 'RESULT …'`, so all its work is rolled back (exit code 1 is expected).

### Final-review fixes (all in 08/09, covered by the 08/09 tests)

- **PLAN gate on INSERT too.** `require_site_plan` now also runs `BEFORE INSERT` on `phase_tasks`,
  `site_phases` and `phase_subtasks` when the new row is already `in_progress`/`done` (issue phases
  and issue cards stay exempt). It was UPDATE-only before, and the Kanban/Gantt forms could insert a
  done row on a site with no PLAN. Derived writes (`app.derived_status = '1'`) pass; `demo_seed_core`
  sets that flag around its site loop and restores it before the PLAN snapshot step.
  The UI now saves new cards/phases/subtasks as `not_started` on a site with no PLAN.
- Once a card has recorded quantity, only OWNER/PM may change `planned_qty` or `progress_mode`.
- A card with progress reports (cancelled or not) can't be deleted while its site exists; deleting
  the site still cascades.
- Locks on parent rows use `FOR NO KEY UPDATE` (no deadlock with the child FK's KEY SHARE).
- `weight_pts` / `parent_task_id` / `boq_item_id` changes are staff only (a sent `weight_pts` is
  ignored and recomputed); split only for general cards (card kinds replaced the old not_started-only rule);
  `cancelled_by` is always the caller; quotation → BOQ fires only when status or
  site changes.
- Datafixes run as the table owner that change `weight_pts`, `planned_qty`, `progress_mode`,
  `parent_task_id` or `boq_item_id` on cards must set `app.derived_status = '1'` (is_local) first.

### RESULT summaries (keys that are not MUST checks)

- **07**: `policy_count` 7. Warning probes `w_pm_boq_insert`, `w_pm_report_cancel`,
  `w_pm_report_insert`, `w_admin_vo_value_insert` all `ok`. `columns` lists the expected new columns
  and defaults (`phase_tasks.weight_pts 0 NOT NULL`, `progress_mode 'status'`, `site_phases.is_vo false`,
  `phase_vo_values.tenant_id current_tenant_id()`, …).
- **08**: `h_boq_rows_detail` = `2|ติดตั้งกระจก|ตร.ม.|50|true;3|อลูมิเนียม|ม.|12.5|true`.
  Every error check returns the expected SQLSTATE and Thai message, e.g.
  `a_card_done_no_plan` → `22023 บันทึก PLAN v1 ของไซท์นี้ก่อนเริ่มบันทึกความคืบหน้า`,
  `f_direct_status` → `22023 งานนี้นับเป็นจำนวน ให้ PM บันทึกยอดในแอป`,
  `e_parent_direct_status` → `22023 สถานะงานหลักคิดจากงานย่อย`.
  Final-review keys: `a_insert_done_card_no_plan` / `a_insert_in_progress_card_no_plan` /
  `a_insert_done_phase_no_plan` / `a_insert_in_progress_subtask_no_plan` → `22023 บันทึก PLAN v1 …`;
  `a_insert_not_started_card_then_delete` 1; issue card and manual card in the issue phase inserted
  done → `ok`; `i2_admin_lowers_planned_with_done` → `22023 เฉพาะ OWNER/PM แก้จำนวนการ์ดที่มียอดแล้ว`,
  `i2_pm_lowers_planned_with_done` → `110 in_progress`; `i3_delete_card_with_reports` →
  `22023 ยกเลิกยอดให้หมดก่อนลบการ์ด`, `i3_site_delete_cascades_card` 0; `i4_no_key_update_locks` true;
  `a2_worker_weight/boq_item/parent` → `22023 แก้แต้ม/งานหลัก/รายการ BOQ …`;
  `d_cancelled_by_is_caller` true; `f2_quotation_touch_no_repull` 0.
  Card-kinds keys (2026-10-18): `v_three_cards_by_value` → `CA:70 CB:15 CC:15 CG general:0`;
  `v_pm_value_shares` → `VA:40.39 VB:8.65 VC:25.96 VM:25`, sum 100, keys only (no price), worker 42501;
  `v_pm_sends_points_ignored` 52.5; `v_split_boq_card` / `v_boq_card_as_child` / `v_child_of_boq_card` →
  `22023 แตกงานได้เฉพาะงานทั่วไป`; `v_delete_boq_line_with_cards` →
  `22023 รายการ BOQ นี้มีการ์ดผูกอยู่ ย้ายหรือลบการ์ดก่อน`; `v_flip_to_general_clears_line_and_qty` true;
  `e_split_done_children` 3 (a done general card can be split); `k_unpriced_equal_shares` →
  `Q:33.34 F:33.33 Q3:33.33`.
- **09** (live data dry run, 2026-10-18, card kinds): 18 sites with cards, 49 phases and 143 cards
  compared; 7 phases change % (table above), 0 card or phase rows written. PLAN v1 rows 147 (147 sites
  with a phase), BOQ rows 168, today's snapshot rows 147, `f_cron_job` = 1, `a_fixture_mismatches` 0
  (JS/SQL parity on fx1–fx18). Demo seed: `demo_seed_core` ok, 10 demo sites with PLAN v1, 40 demo
  phases follow the all-done rule (`demo_phase_pct_all_done_rule_mismatches` 0), flag restored.
  `k_boq_node_points_sum` 100, `k_general_card_in_boq_node_pts` 0.

## NOT verified

- Clicks in the live UI (Gantt PLAN layer, S-curve งานจริง %, BOQ tab and สัดส่วนงาน, VO phase form,
  card kinds form, board header caption, BOQ cards).
  The migrations aren't applied, so the live app can't show any of it yet.
- LINE replies ("งานเสร็จ" blocked-card messages). `line-webhook` isn't deployed. The message
  mapping is covered only by vitest (`src/lib/lineTaskRules.test.js`).
- `deno check` on `supabase/functions/line-webhook` wasn't run.
- The pg_cron run at 23:55 Asia/Bangkok (`'55 16 * * *'` UTC, job `site-progress-snapshot`). Inside the
  test only the job row and one manual snapshot were checked.

## Release order (only after the owner says go)

1. **Owner pre-deploy checklist again at release time.** Check
   `curl -s "https://changpm.app/build-info.json?x=$(date +%s)"`. If live has moved past `809be98b`,
   merge the live commit into this branch, re-run `npx vitest run` and the 07/08/09 tests, and confirm
   no new 2026-10-17-07/08/09 migration came in. The version must still be higher than live.
2. **Apply migrations in order:** `2026-10-17-07-gantt-progress-schema.sql` →
   `2026-10-17-08-gantt-progress-logic.sql` → `2026-10-17-09-gantt-progress-data.sql`.
3. **Deploy the edge function:** `npx supabase functions deploy line-webhook --project-ref kntspldhvcjeaubtqtkn --use-api --no-verify-jwt`.
   (`field-form` hasn't changed on this branch, so it doesn't need a deploy.) LINE pushes are still
   off (`LINE_PUSH_ENABLED=false`). Replies are not pushes.
4. **Web:** `npm run deploy`. Then confirm `build-info.json` shows the new commit and version 1.22.0.
5. **Next morning:** check that `site_progress_daily` (and `site_progress_daily_money`) have rows for
   the night run. The rows written while migration 09 ran are dated the apply day, so the 23:55 run
   should add rows for the next day, or refresh the apply day if 09 ran the same evening. Also check
   `cron.job_run_details` for `site-progress-snapshot`.
