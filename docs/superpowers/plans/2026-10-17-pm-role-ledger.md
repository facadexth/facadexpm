# SDD ledger — plan: docs/superpowers/plans/2026-10-17-pm-role.md
Spec: docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §13 (+ 2026-10-17-pm-role-inventory.md)
Branch feat/gantt-weighted-progress, plan base 6e375d52.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T2 | is_pm/is_site_staff/can_manage_teams → used by T2 RPCs & team policy | consistent |
| T1 test ↔ T2 test | T2 test inlines T1+T2 bodies | consistent |
| T2→T4 | pm_* RPC names/columns → hooks | consistent; T4 must match RETURNS TABLE columns |
| T3→T4..T8 | roles.js exports, setCurrentRole/getCurrentRole | consistent |
| T3 HIERARCHY | roles.js has HIERARCHY w/o PM; useUserRole HIERARCHY gets PM:1.5 | two tables; acceptable (different purposes) |
| T4→T5/T6/T7 | hooks return PM-shaped rows w/o money | consistent |
| T6 | leave names via pm_workers inside HR (no T4 hook) | consistent (T6 owns it) |
| T9 | roleAudience.ts imported by vitest | matches repo pattern (_shared imported in tests) |
| T1 self | test uses `\i` | db query likely lacks \i → inline body (plan already allows) |
| T1 self | test reads only; triggers on site tables could fail under PM RLS | gap |
| T10 self | changelog path found by grep | ok |

Ruling: T1 test inlines the migration body (duplicated text in a dry-run script is acceptable) — why: `supabase db query` has no \i — cost if wrong: none, test-only.
Ruling: T1 test must ALSO do PM writes inside the rolled-back txn (insert+update a site_phases row, insert+status-update a phase_tasks row, insert a worker_assignments row, update a leave_requests status if one exists) — why: triggers/invoker views on those tables may read sites/workers under PM's RLS and fail; read-only counts would miss it — cost if wrong: one more failing dry-run to diagnose.
Task 1: dispatched (base 6e375d52, implementer ab1772d12311e9e7f, opus)
Task 1: implementer DONE_WITH_CONCERNS (7c7beb81). Concern: LIVE bug — sites.admin_updates and user_roles.owner_updates self-reference their table → 42P17 infinite recursion for every authenticated UPDATE on sites/user_roles. Controller re-verified as demo OWNER, with both current and pre-initplan (2026-09-05-05) policy text → long-standing since 2026-08-30-01, not caused by initplan. Surfaced to owner as a separate hotfix job. Reviewer dispatched a50ed630f18a87aa4.
Ruling: site_phases/phase_subtasks.billing_weight_pct readable by PM is intended — they are Gantt phase weights (%), not baht; Part B's weighted progress needs them; spec "billing %" means the income-based billing_pct — cost if wrong: one column to hide later.
Task 1: minor (deferred): w_sites_update_rows_MUST0 check is masked by the live 42P17 recursion bug; rerun after the hotfix.
Task 1: minor (deferred): test has no PM writes on phase_subtasks / phase_task_workers / worker_ot / storage (text-compared only).
Task 1: minor (deferred): inlined migration copy in test can drift; add a diff step.
Task 1: complete (commits 6e375d52..7c7beb81, review clean)
Task 2: dispatched (base 7c7beb81, implementer a7cb6993c59fe86a5, opus)
Task 2: implementer DONE (dc965667); types adjusted to live (travel_minutes, annual_*_leave_days integer). minor: pm_workers returns all statuses (UI filters). Reviewer ab0c5f186d02e45ac.
Task 2: minor (deferred): pm_update_site seat pre-check subquery lacks tenant filter → 1-bit cross-tenant status oracle (add AND tenant_id = current_tenant_id()). FINAL REVIEW: fix before merge.
Task 2: minor (deferred): no cross-tenant test (foreign po/site → 0 rows / P0002).
Task 2: minor (deferred): test deletes a real membership row (rolled back); add a comment that the closing RAISE is load-bearing.
Task 2: complete (commits 7c7beb81..dc965667, review clean)
Task 3: dispatched (base dc965667, implementer ac630aef6a013bf95, sonnet)
Task 3: implementer DONE_WITH_CONCERNS (03a37114): no RED run recorded; ProtectedPage usage comment stale; isAtLeast left in App deps.
Task 3: minor (deferred): applyCachedFallback leaves previous user's role in state+store after a failed fetch on user switch (DB still enforces).
Task 3: minor (deferred): ProtectedPage usage comment lacks tabId; no hook-level test of store reset; TDD order slip.
Task 3: complete (commits dc965667..03a37114, review clean)
Ruling: hotfix fix/rls-self-recursion (worktree rls-recursion, migration 2026-10-17-04-rls-self-recursion-fix.sql) takes number 04; this branch's PM migrations must be renumbered 05 (pm-role) and 06 (pm-ops-rpcs) and pm-role's owner_updates must use user_role_held_admin_seat() with PM added (the helper's role list gains 'PM') once the hotfix is on main — do this in Task 10 / final fix wave — cost if wrong: migration 04 conflict / reintroducing the recursion.
Task 4: dispatched (base 03a37114, implementer ad5cc734c9a86b755, sonnet)
Task 4: implementer DONE_WITH_CONCERNS (37b6109a): no RED run; PM PO adds suppliers:{name}; pm_workers/pm_sites refetched per hook call.
Task 4: review — Important: PM RPC reads not paginated (1000-row cap). ⚠️ worker_assignments/worker_ot money columns: controller checked live — none.
Task 4: minor (deferred): PM PO rows lack sites/expense_categories/purchase_order_items (Task 7 must guard); redundant ?? null; localeCompare sort; no PM tests for several hooks.
Task 4: fix round 1 dispatched (FIX_BASE 37b6109a)
Task 4: fix round 1/5 (1 addressed, 0 open; commits 37b6109a..34b7e6d3)
Task 4: minor (deferred): pm_sites ORDER BY created_at has no tie-breaker for paging.
Task 4: complete (commits 03a37114..34b7e6d3, review clean)
Task 5: dispatched (base 34b7e6d3, implementer a9eb252d74b6f5edb, opus)
Task 5: implementer DONE_WITH_CONCERNS (65ea0db2): hid extra money columns/chips, Import Excel, row ⋯ menu, client picker for PM; Gantt/Kanban/DailyReport not checked for money.
Ruling: PM must not set status 'Completed' through the edit form (the finish-site path also fills end_date and moves leftover stock to the central site, which pm_update_site does not do) — UI hides 'Completed' from the PM status choices; OWNER/ADMIN finish sites — cost if wrong: PM has to ask an admin to close a site.
Task 5: review — spec ❌ Important: PM can still choose 'Completed' (STATUS_OPTS unfiltered; RPC accepts it). Fix round 1 dispatched (FIX_BASE 65ea0db2) incl. RPC defence in depth.
Task 5: minor (deferred): GanttView.jsx:189-196 site-date sync effect runs for PM (silent RLS no-op today) — gate on canSeeMoney/canSyncSiteDates.
Task 5: minor (deferred): Dashboard ternary not re-indented; Gantt/Kanban/DailyReport smoke only on empty data.
Ruling: DailyReport/PhaseKanbanBoard workers(name,nickname) embeds are null for PM → names missing; carry into Task 6 (attach names from pm_workers like HR leave rows) — why: same pattern Task 6 already owns — cost if wrong: PM sees "ไม่ทราบชื่อ" until fixed.
Task 5: fix round 1/5 (1 addressed, 0 open; commits 65ea0db2..3e3c0d6b)
Task 5: complete (commits 34b7e6d3..3e3c0d6b, review clean)
Task 6: dispatched (base 3e3c0d6b, implementer a2c6359cc5e47dc6e, opus) incl. Kanban/DailyReport PM worker names ruling
Task 6: implementer DONE_WITH_CONCERNS (82bb6061): showSalary keeps WORKER own pay; canViewAllWorkers/canReviewLeave = (canEdit || isPm). Concerns: Assign still fetches labor_cost_by_site/site_travel_cost/ot_cost_by_site, HR still fetches salary_records for PM (not rendered).
Controller check: all 14 public views are security_invoker=true (so base-table RLS applies to PM).
Ruling: Task 10's PM SQL verification must also count rows/values PM gets from labor_cost_by_site, ot_cost_by_site, site_travel_cost, workers_with_rate, sites_progress, salary_records (expect 0 rows or all-null money) — why: hooks still fire for PM — cost if wrong: money values reach the browser network tab.
Task 6: ⚠️ resolved: (1) money hooks for PM → Task 10 SQL ruling (views are invoker); (2) PM leave/assignment writes proven in Task 1 dry-run; (3) leave-notify PM allowance is Task 9.
Task 6: minor (deferred): HR empty-state colSpan 11; DailyReport 3 parallel pm_workers calls; money hooks still fire for PM (skip when !showMoney); SALARY regex includes ค่าแรง.
Task 6: complete (commits 3e3c0d6b..82bb6061, review clean)
Task 7: dispatched (base 82bb6061, implementer a804e3baf81c4467e, opus)
Task 7: implementer DONE_WITH_CONCERNS (ed122ba1): PmPODetailModal, PmInventory wrapper; other PO hooks still fire for PM (empty).
Task 7: review — Important: PM guard on PO add-form auto-reopen uses role that is null at mount (per-instance useUserRole) → PM can land in priced PO form.
Ruling: fix root cause in useUserRole — seed role/loading from getCurrentRole() so later instances start resolved — why: same null-first-render pattern affects every PM page (money headings flash, wrong component mounts) — cost if wrong: if store is stale, first paint uses stale role until fetch (DB still enforces).
Task 7: minor (deferred): PM PO detail prints quantity raw (use fmt); ~10 money/stock hooks still fire for PM on PurchaseOrders.
Task 7: fix round 1 dispatched (FIX_BASE ed122ba1)
Task 7: fix round 1/5 (1 addressed, 0 open; commits ed122ba1..329b59de)
Task 7: minor (deferred): seeded useUserRole instance has user=null on first render.
Task 7: complete (commits 82bb6061..329b59de, review clean)
Task 8: dispatched (base 329b59de, implementer a0f3a93c10b1b9511, sonnet)
Task 8: implementer DONE_WITH_CONCERNS (add1e0bc): kept OWNER card in permission editor (brief said filter OWNER out) — non-PM UI must not change.
Ruling: permission editor keeps its OWNER card and adds PM — why: global constraint "OWNER behaviour unchanged" outranks the plan's filter line — cost if wrong: one extra card.
Task 8: ⚠️ DB side covered by Tasks 1/2 (CHECK, seats, check-in RPCs).
Task 8: minor (deferred): no seat-warning test for PM; table badge shows raw "PM".
Task 8: complete (commits 329b59de..add1e0bc, review clean)
Task 9: dispatched (base add1e0bc, implementer af793d39f158e5c22, sonnet)
Task 9: implementer DONE_WITH_CONCERNS (ce4ff503): no deno check (not installed); no RED run.
Ruling: release order = apply migrations (hotfix 04 → pm 05 → rpcs 06) BEFORE deploying edge functions/web — why: extract-map-coordinates & leave-notify call rpc('is_site_staff') which only exists after apply; deploying first breaks them for OWNER/ADMIN — cost if wrong: site map lookup / leave notify down until apply.
Task 9: ⚠️ resolved: leave_requests has pm_full_access (Task 1); deploy order covered by release-order ruling.
Task 9: minor (deferred): offboarded LINE alert still OWNER-only while its web push goes to ops (PM) — mention to owner.
Task 9: complete (commits add1e0bc..ce4ff503, review clean)
Task 10: dispatched (base ce4ff503, implementer a7920b656316c6362, opus) incl. renumber 05/06, owner_updates via user_role_held_admin_seat (+PM), seat-precheck tenant filter, extended PM view checks, cross-tenant checks, 1.21.0
Task 10: implementer DONE_WITH_CONCERNS (930fb795): seat-limit-reached path untested; Completed-check subquery lacks tenant filter (22023 vs P0002 oracle); no changelog bullet for hotfix.
Task 10: ⚠️ resolved: edge function list matches ce4ff503 (9 functions); extract-map-coordinates/leave-notify call is_site_staff.
Task 10: minor (deferred): Completed-guard subquery in pm_update_site lacks tenant filter (22023 vs P0002 oracle). FINAL: fix.
Task 10: minor (deferred): seat-limit branch of owner_updates untested (both halves).
Task 10: minor (deferred): verification doc must say "never apply/re-apply 04 after 05" (04 would reset user_role_held_admin_seat to OWNER/ADMIN). FINAL: fix.
Task 10: minor (deferred): stale header comment in 05; stale "04 and 05" text in plan Task 10.
Task 10: complete (commits ce4ff503..930fb795, review clean)
FINAL review (aba5c2b0b17e76b0d): Ready with fixes. Important: (1) leave-notify workers embed null for PM → no LINE to worker; (2) pm_* RPC ORDER BY ties → unstable paging (live dupes); (3) PM cannot confirm shifts (app_settings unreadable).
Ruling: PM CAN confirm worker shifts — add narrow pm_reads on app_settings for keys require_checkin_confirmation, regular_shift_end_time, checkin_radius_m — why: PM runs assignments and confirmation is a field fact; values are non-money — cost if wrong: owner may want payroll gating kept to OWNER/ADMIN → drop one policy.
Ruling: fix wave also takes minors 1a/1b/1c, GanttView sync gate, 05 release guard (require 04), PM nav label for PO group, PM dead site-name clicks, hide PM "last activity" column — why: cheap, user-visible — cost if wrong: small UI churn.
FINAL: fix wave dispatched (FIX_BASE 930fb795)
FINAL: fix wave done (e5a2750c, 3c22bdda): + early P0002 for unknown/foreign site in pm_update_site. vitest 1344, build ok, dry-runs 0 failures.
FINAL: re-review clean (all 11 addressed). Part A complete at 3c22bdda.
