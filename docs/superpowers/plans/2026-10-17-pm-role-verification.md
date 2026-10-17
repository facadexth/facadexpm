# PM role — release verification (2026-10-17)

Branch `feat/gantt-weighted-progress`, release 1.21.0. **Nothing is applied or deployed.**
Every SQL check below ran on CHANG (`kntspldhvcjeaubtqtkn`) inside one `BEGIN … ROLLBACK`
whose DO block ends in `RAISE EXCEPTION 'RESULT …'`. A follow-up read confirmed nothing
persisted: 0 `pm-test%` rows in `user_roles`, 0 test teams, and none of the new functions
(`is_pm`, `pm_sites`, `user_role_held_admin_seat`, `site_was_ongoing`) exist live.

## Migrations and apply order

| # | File | Owner |
|---|------|-------|
| 04 | `2026-10-17-04-rls-self-recursion-fix.sql` | hotfix branch `fix/rls-self-recursion`. It fixes the 42P17 recursion in `sites.admin_updates` / `user_roles.owner_updates`. |
| 05 | `supabase/migrations/2026-10-17-05-pm-role.sql` | this branch |
| 06 | `supabase/migrations/2026-10-17-06-pm-ops-rpcs.sql` | this branch |

Changes in 05 that depend on 04: `user_role_held_admin_seat(uuid)` is replaced so it also
counts `'PM'` as an admin seat. `owner_updates` WITH CHECK calls that function and no longer
reads `user_roles` itself. In 06, the Ongoing seat pre-check in `pm_update_site` also filters
`tenant_id = current_tenant_id()`.

The test scripts inline the migrations in apply order (04 → 05 for the pm-role test; 04 → 05 → 06
for the rpcs test). Each inlined body is byte-identical to the text between `BEGIN;` and `COMMIT;`
in its file. A script checked this when the tests were generated.

## Verified

- **SQL as PM** (demo tenant `8b61c890-…`, rolled back):
  - Site-ops tables return the tenant's real counts.
  - Every money table returns 0 rows.
  - The money views return 0 rows: `labor_cost_by_site`, `ot_cost_by_site`, `site_travel_cost`, `workers_with_rate`, `sites_progress`, `salary_records`, `site_financial_summary`.
  - PM writes to phases, tasks, assignments and leave work.
  - `UPDATE sites` affects 0 rows. It is a clean 0 now, no longer the 42P17 error.
  - PM cannot insert `user_roles`.
  - The `pm_*` RPCs return the real counts and no money keys.
  - `pm_update_site`:
    - rejects `contract_value` and `Completed` with 22023;
    - keeps an already-Completed site;
    - returns P0002 for an unknown site.
  - PM can manage teams.
- **Cross-tenant as the demo PM:**
  - `pm_purchase_order_items(<other tenant's PO with 44 items>)` returns 0 rows.
  - `pm_inventory_on_hand(<other tenant's site with 2501 balances>)` returns 0 rows.
  - `pm_update_site(<other tenant's site>, '{"notes":"x"}')` raises P0002.
- **SQL as OWNER:**
  - `UPDATE sites` affects 1 row.
  - `UPDATE user_roles` on the PM row affects 1 row.
  - `user_role_held_admin_seat(<PM row>)` is true.
  - Note: the demo tenant was under its admin seat limit, so the seat-limit branch was not the deciding term.
- **SQL as ADMIN:** the `pm_*` read RPCs return the real counts. ADMIN cannot create teams (42501).
- **SQL as WORKER:** every `pm_*` RPC returns 0 rows. `pm_update_site` raises 42501.
- **anon:** has no EXECUTE on any `pm_*` function.
- **Unit and smoke tests:** `npx vitest run` → 117 files, 1340 tests passed. They cover the PM page gates and the jsdom smoke loads of the PM pages from Tasks 3–8.
- **Build:** `npm run build` succeeded (build only, not deployed).

## Not verified yet

- A real PM login on the live site (needs apply + deploy first).
- Push and LINE notification delivery to a PM. All LINE pushes are switched off live (`LINE_PUSH_ENABLED=false`).
- Edge function changes: they are not deployed, and no `deno check` was run locally.
- The owner seat-limit path when a tenant is at its admin limit (the demo tenant was under it).

## Release order (only after the owner says "apply" / "deploy")

1. Apply hotfix **04** (`fix/rls-self-recursion`), then **05**, then **06**: `npx supabase db query --linked -f <file>`.
2. Deploy these edge functions: `route-distance`, `extract-map-coordinates`, `web-push-test`, `leave-notify`, `line-webhook`, `field-form`, `line-worker-offboarded`, `line-push-cheque-reminders`, `line-push-quotation-followups`.
   - They must come after the migrations: `extract-map-coordinates` and `leave-notify` call `rpc('is_site_staff')`, which exists only after 05.
3. Deploy the web app: `npm run deploy` (1.21.0).
4. Create a PM test user in the demo tenant (บจก. สร้างดี คอนสตรัคชั่น) and click through every page as PM.

## RESULT — `supabase/tests/2026-10-17-05-pm-role.test.sql`

```json
{
 "app_settings_MUST0": 0,
 "balances_MUST0": 0,
 "can_manage_teams": true,
 "cheques_MUST0": 0,
 "clients": 8,
 "current_tenant_ok": true,
 "expenses_MUST0": 0,
 "have_leave": true,
 "have_site": true,
 "have_worker": true,
 "incomes_MUST0": 0,
 "invoices_MUST0": 0,
 "is_admin_or_owner_MUSTfalse": false,
 "is_pm": true,
 "is_site_staff": true,
 "labor_payments_MUST0": 0,
 "leave_requests": 6,
 "line_site_photos": 35,
 "owner_admin_seats_under_limit": true,
 "owner_current_tenant_ok": true,
 "owner_is_owner_MUSTtrue": true,
 "owner_pm_row_held_admin_seat_MUSTtrue": true,
 "phase_subtasks": 0,
 "phase_tasks": 120,
 "po_items_MUST0": 0,
 "quotation_items_MUST0": 0,
 "quotations_MUST0": 0,
 "salary_MUST0": 0,
 "sfs_MUST0": 0,
 "site_attachments": 0,
 "site_phases": 40,
 "sites_MUST0": 0,
 "suppliers": 8,
 "tenant": "8b61c890-0a90-4223-91d3-b5f8f4e89908",
 "units": 10,
 "v_labor_cost_by_site_money_MUSTfalse": false,
 "v_labor_cost_by_site_rows": 0,
 "v_ot_cost_by_site_money_MUSTfalse": false,
 "v_ot_cost_by_site_rows": 0,
 "v_salary_records_money_MUSTfalse": false,
 "v_salary_records_rows": 0,
 "v_site_financial_summary_money_MUSTfalse": false,
 "v_site_financial_summary_rows": 0,
 "v_site_travel_cost_money_MUSTfalse": false,
 "v_site_travel_cost_rows": 0,
 "v_sites_progress_money_MUSTfalse": false,
 "v_sites_progress_rows": 0,
 "v_workers_with_rate_money_MUSTfalse": false,
 "v_workers_with_rate_rows": 0,
 "w_leave_requests_status_rows": 1,
 "w_owner_sites_update_rows_MUST1": 1,
 "w_owner_user_roles_update_pm_rows_MUST1": 1,
 "w_phase_tasks_insert": "ok",
 "w_phase_tasks_status_rows": 1,
 "w_site_phases_insert": "ok",
 "w_site_phases_update_rows": 1,
 "w_sites_update_rows_MUST0": 0,
 "w_user_roles_insert_MUSTfail": "42501 new row violates row-level security policy for table \"user_roles\"",
 "w_worker_assignments_insert": "ok",
 "worker_assignments": 1680,
 "worker_checkins": 120,
 "worker_ot": 14,
 "workers_MUST0": 0
}
```

## RESULT — `supabase/tests/2026-10-17-06-pm-ops-rpcs.test.sql`

```json
{
 "admin_pm_sites_eq_real": true,
 "admin_pm_workers_eq_real": true,
 "anon_execute_any_MUSTfalse": false,
 "app_settings_MUST0": 0,
 "balances_MUST0": 0,
 "cheques_MUST0": 0,
 "expenses_MUST0": 0,
 "incomes_MUST0": 0,
 "invoices_MUST0": 0,
 "labor_payments_MUST0": 0,
 "other_po_found": true,
 "other_site_found": true,
 "pm_complete_rejected_status_kept_MUSTtrue": true,
 "pm_current_tenant_ok": true,
 "pm_has_module_purchase_orders": true,
 "pm_on_hand": 16,
 "pm_on_hand_default_site_eq_real": true,
 "pm_on_hand_eq_real": true,
 "pm_on_hand_money_keys_MUSTfalse": false,
 "pm_other_tenant_on_hand_MUST0": 0,
 "pm_other_tenant_po_items_MUST0": 0,
 "pm_po_items": 3,
 "pm_po_items_eq_real": true,
 "pm_po_items_money_keys_MUSTfalse": false,
 "pm_pos": 12,
 "pm_pos_eq_real": true,
 "pm_pos_money_keys_MUSTfalse": false,
 "pm_sites": 11,
 "pm_sites_eq_real": true,
 "pm_sites_money_keys_MUSTfalse": false,
 "pm_update_site_applied_MUSTtrue": true,
 "pm_update_site_complete_22023_MUSTtrue": true,
 "pm_update_site_contract_value_22023_MUSTtrue": true,
 "pm_update_site_other_tenant_P0002_MUSTtrue": true,
 "pm_update_site_unknown_P0002_MUSTtrue": true,
 "pm_workers": 12,
 "pm_workers_eq_real": true,
 "pm_workers_money_keys_MUSTfalse": false,
 "pm_workers_salary_key_MUSTfalse": false,
 "po_items_MUST0": 0,
 "quotation_items_MUST0": 0,
 "quotations_MUST0": 0,
 "real_bal": 16,
 "real_bal_default_site": 12,
 "real_other_po_items": 44,
 "real_other_site_bal": 2501,
 "real_po_items": 3,
 "real_pos": 12,
 "real_sites": 11,
 "real_workers": 12,
 "salary_MUST0": 0,
 "sfs_MUST0": 0,
 "sites_MUST0": 0,
 "tenant": "8b61c890-0a90-4223-91d3-b5f8f4e89908",
 "w_admin_worker_teams_insert_MUSTfail": "42501 new row violates row-level security policy for table \"worker_teams\"",
 "w_pm_member_foreign_worker_MUSTfail": "42501 new row violates row-level security policy for table \"worker_team_members\"",
 "w_pm_update_site": "ok",
 "w_pm_update_site_keep_completed": "ok",
 "w_pm_worker_team_members_insert": "ok",
 "w_pm_worker_teams_insert": "ok",
 "worker_current_tenant_ok": true,
 "worker_pm_on_hand_MUST0": 0,
 "worker_pm_po_items_MUST0": 0,
 "worker_pm_pos_MUST0": 0,
 "worker_pm_sites_MUST0": 0,
 "worker_pm_update_site_42501_MUSTtrue": true,
 "worker_pm_workers_MUST0": 0,
 "workers_MUST0": 0
}
```
