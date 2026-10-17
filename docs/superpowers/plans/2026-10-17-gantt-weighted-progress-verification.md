# Gantt weighted progress: release verification (1.22.0)

Date: 2026-10-17. Branch `feat/gantt-weighted-progress`. Nothing is applied or deployed yet.

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

## Verified

| Check | Result |
|---|---|
| `npx vitest run` after the merge and version bump | 135 files, 1519 tests passed |
| `npx vitest run` after the final-review fixes | 135 files, 1536 tests passed |
| `npm run build` | OK (after the final-review fixes, build info commit fff3c130) |
| Inlined migration bodies in the tests (text between `BEGIN;` and `COMMIT;`) are byte-identical to the migration files | 07 in tests 07/08/09, 08 in tests 08/09, 09 in test 09: all identical, each found exactly once |
| 07 rolled-back test on CHANG | 55 keys, 48/48 MUST keys as expected |
| 08 rolled-back test on CHANG (after the final-review fixes) | 113 keys, 112/112 MUST keys as expected |
| 09 rolled-back test on CHANG (after the final-review fixes) | 113 keys, 104/104 MUST keys as expected |
| SQL as PM / ADMIN / OWNER / WORKER (RLS, grants, VO value privacy) | covered by the 07/08/09 assertions above |
| Today's % unchanged by the weight data migration | 09: `b_phases_changed_MUST0` = 0, `b_phase_pct_mismatches_MUST0` = 0 |
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
- `weight_pts` / `parent_task_id` / `boq_item_id` changes are staff only; split only for
  `not_started` cards; `cancelled_by` is always the caller; quotation → BOQ fires only when status or
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
  `e_split_started_card` → `22023 แตกงานได้เฉพาะงานที่ยังไม่เริ่ม`; `d_cancelled_by_is_caller` true;
  `f2_quotation_touch_no_repull` 0.
- **09** (live data dry run): 18 sites with cards, 49 phases and 143 cards compared, 0 mismatches.
  Weight patterns `1:100 3:33.34+33.33+33.33 4:25×4 6:16.65+16.67×5 7:14.26+14.29×6`.
  Per-site rounding examples: 33→33.34, 67→66.67, 14→14.26 (these are display rounding of the same
  fraction, not a real change; `b_phase_pct_mismatches` = 0). PLAN v1 rows 147 (147 sites with a phase),
  BOQ rows 168, today's snapshot rows 147, `f_cron_job` = 1. Same numbers after the final-review fixes.
  Demo seed with the INSERT gate: `demo_seed_core` ok, every seeded site gets PLAN v1, flag restored
  (`demo_flag_restored` true); equal shares at n = 155 sum to 100 with every share > 0.

## NOT verified

- Clicks in the live UI (Gantt PLAN layer, S-curve งานจริง %, BOQ tab, VO phase form, quantity cards).
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
