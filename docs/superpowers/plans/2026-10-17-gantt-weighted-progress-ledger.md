# SDD ledger — plan: docs/superpowers/plans/2026-10-17-gantt-weighted-progress.md
Spec: docs/superpowers/specs/2026-10-17-gantt-weighted-progress-design.md §1-§12. Part A live 1.21.0. Base 6796a9e3.

## Pre-flight scan
| Pair / task | Produces vs consumes | Finding |
|---|---|---|
| T1→T2 | schema + can_manage_plan → triggers/RPCs | consistent |
| T2→T3 | snapshot_site_plan, boq_insert_for_quotation (08) → data migration (09) | consistent after plan fix 6796a9e3 |
| T2↔T7 | boq_refresh_from_quotations RPC listed in T7 but belongs in 08 | T7 must edit 08 + its test inline (noted in plan) |
| T3→T4 | fixtures json shared; SQL formulas = JS rules | consistent |
| T4→T5/6/8 | progressCalc exports | consistent |
| T5→T8 | useSitePlans items → layer | consistent |
| T6 | record_progress/cancel_progress/split_task RPC names from T2 | consistent |
| T8 | PM S-curve งานจริง only; SiteDetail currently hides S-curve for PM (Part A) | T8 re-enables for PM in work mode — consistent with spec |
| T9 | gate/qty messages from T2 text | messages must match T2 exactly |
| T1 self | spec qty<>0 vs plan qty>0 | plan narrows deliberately (cancel instead of negatives) — documented |
| T2 self | sync_task_qty sets status → guard_derived_status must allow via app.derived_status | consistent |
| T2 self | require_site_plan on phase_tasks status: sync from progress_reports already gated at insert | consistent |
| T3 self | today's % check excludes sites w/o cards | ok |
Ruling: spec §5 qty<>0 narrowed to qty>0 — corrections are cancellations — cost if wrong: none (cancel covers it).
Ruling: guard_derived_status/sync must also apply to Task 3's data migration (it sets weights only, not status) — no conflict.
Task 1: dispatched (base 6796a9e3, implementer a30ab4d7b303d9750, opus)
Task 1: implementer DONE_WITH_CONCERNS (bcd3e579): cancel UPDATE can change other cols (Task 2 trigger); boq_items/progress_reports don't check referenced site/task tenant.
Ruling: Task 2 must add BEFORE INSERT/UPDATE triggers on boq_items (site in NEW.tenant_id), progress_reports (task in NEW.tenant_id and task.site_id = NEW.site_id) and phase_tasks.boq_item_id (boq row same tenant+site) — why: sync_task_qty runs as definer/owner and would otherwise write another tenant's card via a forged task_id — cost if wrong: cross-tenant write.
Task 1: ⚠️ site_plan_items has no tenant_id (spec+SQL agree; scoped via site_plans) — Task 2 RPC writes plan row tenant correctly.
Task 1: minor (deferred): TRUNCATE not revoked on site_plans/items/progress_reports (FINAL: add); missing FK/tenant indexes; cancel UPDATE column lock → Task 2.
Task 1: complete (commits 6796a9e3..bcd3e579, review clean)
Task 2: dispatched (base bcd3e579, implementer a5203466552a46223, opus) incl. cross-tenant, update-lock, truncate rulings
Task 2: implementer DONE_WITH_CONCERNS (a87b16cf): demo_seed_core makes no PLAN; gate is UPDATE-only (insert as done passes); lowering BOQ planned_qty below cards unchecked; extra Thai messages for split/update-lock; split children no due_date.
Ruling: Task 3 migration 09 also (a) redefines demo seed so seeded sites get an auto PLAN v1 (call snapshot_site_plan at the end), (b) adds a boq_items BEFORE UPDATE OF planned_qty check (≥ Σ linked cards' planned_qty) — why: demo reset otherwise blocks every demo site; BOQ edit could invalidate cards — cost if wrong: small extra SQL.
Ruling: gate stays UPDATE-only (insert-as-done allowed) — why: seed + create_issue_card insert directly; UI never inserts done cards — cost if wrong: a crafted API insert could record "done" without PLAN.
Task 2: review — Important: quantity guard bypass via progress_mode flip / direct done_qty / planned_qty. ⚠️ line-webhook done on qty card now errors → Task 9.
Ruling: done_qty only under derived flag; progress_mode change only by site staff on cards with no live reports/children; planned_qty change re-derives and can't go below done_qty — cost if wrong: card-form edits of mode blocked after reports exist (intended).
Task 2: minor (deferred): FOR UPDATE vs FK KEY SHARE deadlock → use FOR NO KEY UPDATE (FINAL); definer lookups by phase_id without tenant filter / no phase_id tenant check (FINAL); boq_from_quotation re-runs on unchanged status (FINAL: add OLD IS DISTINCT); cancelled_by forgeable (force auth.email()); moving parent/phase doesn't re-derive old parent.
Task 2: fix round 1 dispatched (FIX_BASE a87b16cf)
Task 2: fix round 1 implementer done (72148db3; also planned_qty limited to staff). Re-review a005565836d6224e1.
Task 2: fix round 1/5 (1 addressed, 0 open; commits a87b16cf..72148db3)
Ruling (FINAL wave): planned_qty/progress_mode edits on a quantity card that already has done_qty > 0 only by can_manage_plan() (OWNER/PM) — why: owner decision "ADMIN does not record quantities"; lowering planned to done would mark done — cost if wrong: ADMIN can't fix a plan qty after installs start.
Task 2: minor (deferred): datafix/service-role UPDATEs of mode/planned_qty need app.derived_status='1'; card form must send mode change without status change.
Task 2: complete (commits bcd3e579..72148db3, review clean)
Task 3: dispatched (base 72148db3, implementer aa7145080b3879aa2, opus) incl. demo seed PLAN, BOQ-lowering check, derived flag for backfill
Task 3: implementer DONE_WITH_CONCERNS (e77c4c60): gate 0 mismatches / 49 phases / 143 cards / 18 sites; PLAN v1 147; BOQ 168; snapshots 147. Concerns: LIVE demo reset already broken (pay_items system rows delete trigger) — separate bug, tell owner; set_equal_card_weights only nodes all-zero; chosen site rules (zero-weight contract → mean; no contract phase → 0; VO without vo_value → 0) → Task 4 must mirror; demo sites get no BOQ; progress fns follow RLS (PM can't read sites → site_progress_pct no row for PM; UI uses JS).
Task 3: review — Important: PM can derive contract_value from site_progress_daily.total_pct + site_phases.vo_value.
Ruling: vo_value moves to admin-only table phase_vo_values (edit 07); total_pct moves to admin-only site_progress_daily_money — why: RLS can't hide columns and PM must never read money — cost if wrong: one extra join in admin UI.
Ruling: add 3 fixture cases (zero-weight contract mean, issue-only site → 0, VO null value → 0) in this fix — why: Task 4's JS mirror is checked only against fixtures — cost: none.
Task 3: minor (deferred): snapshot writes rows for inactive sites forever; site_progress_daily tenant_id no FK.
Task 3: fix round 1 dispatched (FIX_BASE e77c4c60)
Task 3: fix round 1 implementer done (50af0624; + check_phase_vo_refs cross-tenant trigger in 08).
Ruling: later tasks read VO values from phase_vo_values (OWNER/ADMIN only) and VO history from site_progress_daily_money; Task 6 (PhaseManageModal VO fields) writes vo_value to phase_vo_values, visible only to canSeeMoney — carry into Task 4/6/8 dispatches.
Task 3: fix round 1/5 (1 addressed, 0 open; commits e77c4c60..50af0624)
Task 3: minor (deferred): equal-share guard comment says n=202, first failing n is 155 (code correct); add n=155 test.
Task 3: complete (commits 72148db3..50af0624, review clean). Plan/spec amended for phase_vo_values / site_progress_daily_money.
Task 4: dispatched (base d0ce2aff, implementer a6ebcdaf99913f14e, opus)
Task 4: implementer DONE_WITH_CONCERNS (9b3ef17e): issue-only node label differs from SQL (computePhaseTaskStats); 'VO n รายการ' visible to PM (count only); no browser check.
Task 4: minor (deferred): issue-only leaf child pct differs from SQL in parent computeNodeStats (FINAL: fix); Kanban unallocated pill on non-leaf phase (FINAL: 0 for non-leaf); VO label flash for money roles; ✓ vs % disagreement with unallocated points (tooltip later); test gaps (subtasks+cards, qty planned null/0, issue card in normal phase, issue-only leaf).
Task 4: complete (commits d0ce2aff..9b3ef17e, review clean)
Task 5: dispatched (base 9b3ef17e, implementer ac4ed0346b801f46b, sonnet)
Task 5: implementer DONE_WITH_CONCERNS (494fd64d): ADMIN gets read-only history button; no banner on zero-phase sites; tests not red-first.
Task 5: ⚠️ resolved: site_plans/items SELECT = is_site_staff (07).
Task 5: minor (deferred): PlanBar disappears on every refetch (keep data while reloading); Check component inside render; mid-file import; no ADMIN read-only dialog test.
Task 5: complete (commits 9b3ef17e..494fd64d, review clean)
Task 6: dispatched (base 494fd64d, implementer ac1087a26657cffe0, opus) incl. VO→phase_vo_values ruling
Task 6: implementer DONE_WITH_CONCERNS (d5473803): PhaseManageModal not mounted (VO fields unreachable; live editor is GanttView inline form); split children draggable as own cards; split in edit panel; ADMIN can't open record dialog/history; progressReady = any card has progress_mode.
Task 6: review — Important: (1) VO fields unreachable (PhaseManageModal unmounted; plan named wrong file); (2) progressReady data-based → first card 0 pts after migration.
Ruling: VO fields go into GanttView inline phase form with shared save helper; readiness = schema probe — why: plan defect / fragile check — cost if wrong: small extra request on Kanban load.
Task 6: minor (deferred): new manual cards in issue phases show points (send 0); ADMIN read-only history path dead; split children shown twice (confirm vs mockup); no client planned≥done check; no drop-of-qty-card test; qty card without BOQ line shows no unit.
Task 6: fix round 1 dispatched (FIX_BASE d5473803)
Task 6: fix round 1/5 (2 addressed, 0 open; commits d5473803..554ff9ab)
Task 6: minor (deferred): failed schema probe cached for page life (retry on network error); fixed VO edit heights unverified in browser; PhaseManageModal still unmounted (delete or mount later).
Task 6: complete (commits 494fd64d..554ff9ab, review clean)
Task 7: dispatched (base 554ff9ab, implementer ab09f0b7bc3ef271c, sonnet)
Task 7: implementer DONE (11d5cc7c): qty/unit also editable; manual row defaults.
Task 7: minor (deferred): delete BOQ row with cards gives no warning (FINAL: warn/disable); EditCell stale after rejected save (FINAL); usePhaseTasks tenant-wide in BoqTab.
Task 7: complete (commits 554ff9ab..11d5cc7c, review clean)
Task 8: dispatched (base 11d5cc7c, implementer aa7bef84a366895a2, opus)
Ruling: Task 10 must, before release prep: curl build-info.json, git merge the live commit (now 809be98b, fix/fast-invoice-stock-deduction v1.21.2, already contains part A), bump version above live (≥1.22.0 > 1.21.2), changelog entry — owner's checklist. Merge waits until Task 8/9 finish to avoid disturbing running implementers.
Task 8: implementer DONE_WITH_CONCERNS (7833487a): new planLayer.js; S-curve always latest PLAN (not selected version); delay for parent rows uses derived spans; selector hidden when no PLAN; PM S-curve test updated.
Task 8: review — spec ❌ Important: S-curve uses latest PLAN, not the Gantt-selected version (spec §2.3).
Ruling: chosen version lifted to SiteDetail; Gantt "ปิด" → S-curve shows no plan line — why: layer off = no plan comparison anywhere, consistent — cost if wrong: owner may want latest plan line always.
Ruling: fold Minor #1 (dot on single actual point) into this fix — visible on day one for every site.
Task 8: minor (deferred): PM still calls incomes/expenses hooks with NIL id (add enabled flag); KPI test doesn't pin X%/gap; no tag when plan item lacks dates; TODAY_ISO is UTC (Bangkok helper later); tag may collide with edit buttons.
Task 8: fix round 1 dispatched (FIX_BASE 7833487a)
Task 8: fix round 1/5 (1 addressed, 0 open; commits 7833487a..588b5b16)
Task 8: minor (deferred): empty <g> per non-last dot; no late-load plan test.
Task 8: complete (commits 11d5cc7c..588b5b16, review clean)
Task 9: dispatched (base 588b5b16, implementer af8428bc26a1aacde, sonnet)
Task 9: implementer DONE_WITH_CONCERNS (e440d763 + stray 84731749 committing the report file): field-form and today lists unfiltered (display-only); MySchedule parent detection RLS-limited.
Task 9: stray commit 84731749 dropped by controller (soft reset; report file kept on disk).
Ruling: field-form + today summary lists stay unfiltered (display-only; quantity cards must stay visible for photos; DB trigger is the gate) — deliberate deviation from brief's file list — cost if wrong: worker sees qty cards in field-form list.
Task 9: minor (deferred): findParentIds .in() can exceed URL length on huge sites (chunk); LINE "no open tasks" when only qty/parent cards (use doneBlockedMessage); narrow select('*') after apply; MySchedule parent detection RLS-limited.
Task 9: complete (commits 588b5b16..e440d763, review clean)
Task 10: dispatched (base e440d763, implementer afa8bf302b124e2da, opus) incl. merge live 809be98b, version 1.22.0
Task 10: implementer DONE_WITH_CONCERNS (84f64b6b merge 809be98b; 238bd43e 1.22.0). Merged-in migrations don't redefine any 07-09 function (controller grep; payroll backfill only calls demo_seed_core). field-form unchanged → deploy only line-webhook. % shows extra decimal on some sites (33 → 33.34) — mention to owner.
Task 10: complete (commits e440d763..238bd43e)
FINAL review (a1911f1c199a96457): not ready — I1 inserts bypass PLAN gate (UI inserts done cards/phases); I2 ADMIN can finish qty card via planned_qty (ruling never built); I3 deleting qty card cascades reports; I4 FOR UPDATE vs KEY SHARE deadlock. Recommended: worker can edit weight/parent/boq on own cards; split of done/in-progress card drops to 0; BoqTab EditCell stale; cancelled_by forgeable.
Ruling: gate also BEFORE INSERT for in_progress/done (derived flag bypass; demo seed sets flag) — reverses earlier "UPDATE-only" ruling because the UI does insert done rows — cost if wrong: none.
Ruling: split allowed only for not_started cards — why: avoids silent % drop; cost: user must reopen a card to split.
FINAL: fix wave dispatched (FIX_BASE 238bd43e)
FINAL: fix wave done (fff3c130, beb2f25d, 83d92e0b). vitest 1536, dry-runs 48/112/104. Concerns: I3 message wording misleading; owner datafixes need derived flag (incl. BOQ delete as owner); no-PLAN silent not_started.
FINAL re-review (ad5a21b29c2d632b3): I1–I4 and (a)–(g) ADDRESSED; inlines byte-identical; PM BOQ delete with linked cards OK.
FINAL: parked — keep_progress_history makes reset_demo_tenant abort (22023) when demo has progress reports — Ruling: fix together with the already-broken demo reset job (owner: "ทีหลัง"); that job must delete progress_reports before phase_tasks or set a bypass flag — cost if wrong: demo reset stays broken (it already is).
FINAL: parked — I3 message wording misleading (cancelled reports also block delete) — Ruling: change text to "การ์ดนี้มีประวัติยอดติดตั้ง ลบไม่ได้ (ลบได้เมื่อลบทั้งไซท์)" in a follow-up before or right after apply — cost: confusing message only.
FINAL: parked — PhaseManageModal new-row status on no-PLAN site (modal is not mounted anywhere) — Ruling: unreachable; delete or fix the modal later.
FINAL: parked — service-role/no-claims writes to weight_pts/parent_task_id/boq_item_id need app.derived_status='1' — Ruling: documented in verification doc; datafixes must set the flag.
