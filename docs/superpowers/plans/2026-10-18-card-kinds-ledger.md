# SDD ledger — plan: docs/superpowers/plans/2026-10-18-card-kinds.md
Base 62f60b1c. Pre-flight: T1 (DB) → T2 (UI consumes boq_value_shares, new node rules, split general-only) → T3 release. Consistent; T2 must mirror T1 fixtures.
Task 1: dispatched (base 62f60b1c, implementer a4bd1ab1b4e4ef291, opus)
Task 1: implementer DONE_WITH_CONCERNS (c6a83712): edited progressCalc nodeCardsProgress + 3 tests; client weights silently ignored; split children inherit parent status; 0-value line = unpriced; BOQ→general keeps boq_item_id; 7/49 phases drop to 0. vitest 2 failures pre-existing UTC/Bangkok test bug in pmPages.
Task 1: review — Important: general card can keep boq_item_id/planned_qty (eats BOQ qty, blocks BOQ delete). 7-phase report confirmed independently (5 demo, 2 real: FX-2026-001 ผลิต 14→0, FX-2026-094 เก็บงาน 25→0). pmPages 2 failures = pre-existing UTC/Bangkok test bug (TZ=UTC 31/31).
Ruling: trigger nulls boq_item_id/planned_qty on general cards + reverse CHECK backstop — cost: none.
Ruling: 0-value BOQ line = priced at 0 → 0 points (spec literal); NULL/negative = unpriced → average — cost if wrong: free items weigh nothing (intended).
Ruling: fold minors issue_report_id recompute, drop boq planned_qty trigger, sorted lock order into this round.
Ruling: split_task derived-flag inserts bypass the PLAN INSERT gate intentionally (children copy a parent status that already passed the gate).
Task 1: minor (deferred): fix pmPages TODAY UTC test bug (later, test-only).
Task 1: fix round 1 dispatched (FIX_BASE c6a83712)
Task 1: fix round 1/5 (1+4 addressed, 0 open; commits c6a83712..8b108972)
Task 1: complete (commits 62f60b1c..8b108972, review clean)
Task 2: dispatched (base 8b108972, implementer a39f54101685d2adb, opus)
Task 2: implementer DONE_WITH_CONCERNS (d3f42300): form defaults to งานทั่วไป; issue-phase cards may be BOQ; no phase-header caption; JS parent = plain mean.
Task 2: minor (deferred → FINAL wave): default kind = BOQ when the site has BOQ lines else general (Ruling: middle ground between mockup and usability); hide BOQ choice for new cards in issue phases; add phase-header caption "คิดจากการ์ด BOQ n ใบ · แต้มแบ่งตามมูลค่า" / "คิดจากสถานะเฟส"; border shorthand vs borderStyle warning; gate boq_value_shares call on schema probe.
Task 2: complete (commits 8b108972..d3f42300, review clean)
Task 3: dispatched (base d3f42300, implementer a13003a59bc5e42ea, opus) incl. UI polish rulings 1-5
Task 3: implementer DONE (71d29729 polish, ff7c414f release docs). Live still 809be98b; dry-runs 55/146/140; vitest 1562 (+2 known UTC).
Task 3: ⚠️ caption on a parent phase with sub-phases would say "คิดจากสถานะเฟส" though % comes from subtasks — live has 0 phase_subtasks rows → FINAL: show "คิดจากงานย่อย" for nodes with child subtasks.
Task 3: minor (deferred): changelog date 2026-10-17 → set at deploy; add changelog line that phases counting cards today show 0% until cards are marked BOQ; existing issue-phase card edit still shows BOQ radio.
Task 3: complete (commits d3f42300..ff7c414f, review clean)
FINAL review (a25320996ea9482a1): ready after I1 (BOQ card move into a phase with BOQ cards fails — weight kept before recompute) and I2 (block_boq_delete raises 22023 → demo reset aborts). Minors before release: M1 caption for phases with sub-phases ("คิดจากขั้นตอนย่อย"), M2 existing issue-phase card offers BOQ, M3 sub-phases inside issue phase show %, changelog line on phases dropping to 0.
Ruling: also switch keep_progress_history to ERRCODE 23503 so reset_demo_tenant retries phase_tasks after progress_reports — fixes the parked Part B demo-reset item too (reset itself is still broken by pay_items; separate later job).
FINAL: fix wave dispatched (FIX_BASE ff7c414f)
FINAL: fix wave done (e5a7fc39); node_of inlined (revoked from authenticated). dry-runs 55/148/140; vitest 1566 (+2 known UTC).
FINAL re-review (a01cdc9fcc45fc8c1): all addressed, no new breakage. Card-kinds complete at e5a7fc39.
