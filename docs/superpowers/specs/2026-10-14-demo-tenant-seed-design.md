# Demo tenant: seeded data and one-click reset

Date: 2026-10-14. Status: draft for owner review.

## Goal

The owner demos CHANG to prospective customers on their own device. The demo
must show every customer-facing module with realistic, Thai, general-contractor
data that looks alive (eight months of history, open items on the bell, charts
with shape), and it must be returnable to the same starting state after the
owner has clicked around in it.

Decisions taken with the owner on 2026-10-14:

- Demo audience: customers. Owner drives it alone; customers do not log in.
- Fictional company: a general construction contractor, not an aluminium shop.
- Owner/admin view is the demo; one worker login exists to switch to.
- LINE is not connected. Nothing in the demo depends on a LINE push.

## Already in place (verified live 2026-10-14)

- Tenant `8b61c890-0a90-4223-91d3-b5f8f4e89908`, company
  "บจก. สร้างดี คอนสตรัคชั่น", package Enterprise, `plan='active'`,
  `plan_expires_at='2099-12-31'`, `tenant_modules` on for quotations, invoices,
  cheque_tracking, client_deposits, purchase_orders, payroll,
  labor_subcontractors, line_bot. `estimation` stays off (FacadeX-only) and
  `offline_mode` stays off.
- Logins (auth.users + auth.identities, password login verified through the
  auth API): `demo-owner@facadex.co.th` OWNER "คุณสร้างดี (เจ้าของ)",
  `demo-admin@facadex.co.th` ADMIN "สมหญิง (แอดมิน)",
  `demo-worker@facadex.co.th` WORKER "สมชาย (ช่าง)".
- The signup trigger already created the default site "ส่วนกลาง"
  (`is_default=true`), two `app_settings` rows (`travel_rate_per_km`,
  `holiday_pay_multiplier`) and four aluminium-flavoured expense categories.
  The seed replaces those categories with contractor ones.

## Facts that shape the design (from the code, 2026-10-14)

1. Every document number is assigned by a BEFORE INSERT trigger that takes
   `MAX(number)+1` under the caller's RLS, not filtered by `tenant_id`
   (`migrations/2026-09-01-05-scope-document-numbers-per-tenant.sql`). Run as
   postgres, MAX spans every tenant. Quotation and PO numbers take their month
   from `NOW()`, so backdated rows would all get this month's prefix. The
   triggers skip when the column is already set.
   Consequence: the seed sets every number column explicitly, in the real
   format (`QTYYMM-NNN`, `POYYMM-NNN`, `INYYMM-NNN`, `REYYMM-NNN`,
   `FX-YYYY-NNN` sites, `CL-YYYY-NNN` clients, `SP-YYYY-NNN` suppliers,
   `LC-YYYY-NNN` subcontractors, `PYYYMM-NNN` labor payments,
   `IVYYMM-NNN` incomes, `{code_prefix}-NNNN` inventory items).
2. Invoices, receipts, incomes, deposits and retention are client-side logic
   (`src/pages/Invoices.jsx` 407-489, 1755-1884). There is no DB function to
   call. The seed reproduces the same rows: `invoices` + `invoice_items` +
   `invoice_item_draws` + `quotation_item_units.cumulative_pct`, and for paid
   invoices `receipts` (one per invoice) + `incomes` (`source_invoice_id`,
   `income_type` 'ปกติ' or 'มัดจำ', `tax_withheld`, `retention`,
   `received_amount`) + `invoices.status='paid'`, `paid_date`, `income_id`.
   Retention and deposits are views over `incomes` and `sites` columns
   (`default_retention_pct`, `default_deposit_pct`, `retention_released`).
3. Stock has one RPC, `record_stock_movement`, which requires a JWT of the
   target tenant. The seed writes `stock_movements` (ledger) and
   `inventory_stock_balances` itself and asserts at the end that every balance
   equals the ledger sum (lesson from the 2026-10 backfill). Cost basis for
   `purchase_in` is the PO line net of discount, ex-VAT, as the app does.
4. Seat-limit triggers on `sites`, `workers`, `user_roles` read
   `current_tenant_id()` of the caller. Enterprise has no limits, so they pass
   either way.
5. Deleting a `user_roles` row deletes the auth user (trigger). Reset must
   never touch `user_roles`.
6. FKs from tenant-scoped tables to `tenants` are NO ACTION except seven
   small ones. 130+ tables carry `tenant_id`. Reset must delete per table in
   FK order.
7. `has_module_access()` honours `tenant_modules` once the trial has ended;
   `tenant_can_write()` needs `plan='active'`. Both already satisfied.
8. Dashboard default period is year-to-date (`Dashboard.jsx` 64-74, 179);
   monthly chart uses `expenses.date/amount` vs `incomes.date/received_amount`.
   Bell counts (`pending_counts()`): pending leave, draft POs, open issue
   reports, cheques due within `cheque_reminder_days`, sent quotations by
   expiry.
9. Worker login links to a `workers` row by `workers.email`.
10. The central stock site is found by name `'ส่วนกลาง'` (`Inventory.jsx`).

## Design

### 1. Marker and safety

- `app_settings` row `key='is_demo_tenant', value='true'` on the demo tenant.
  Both functions below `RAISE EXCEPTION` unless this row exists for the given
  tenant. This is the only guard between "reset the demo" and "wipe a paying
  customer", so it is checked first, inside the function, not in the UI.
- `platform_list_tenants()` gains `is_demo boolean` so the UI can show the
  button only on demo tenants.

### 2. `seed_demo_tenant(p_tenant_id uuid) returns jsonb`

SECURITY DEFINER, `SET search_path = public`, REVOKE ALL FROM PUBLIC, anon;
GRANT EXECUTE TO authenticated; first statement checks
`EXISTS (SELECT 1 FROM platform_admins WHERE user_email = auth.email())` and
the demo marker.

Impersonation: the body does
`PERFORM set_config('request.jwt.claims', json_build_object('email', v_owner_email, 'role', 'authenticated', 'sub', v_owner_uid)::text, true)`
and `SET LOCAL ROLE authenticated` before inserting, so RLS policies, the
numbering triggers (where still used) and `current_tenant_id()` behave exactly
as for the demo owner. Numbers are still set explicitly for backdated rows.
Role is restored before returning. The function must be called from the UI
with the platform admin's JWT; it then switches identity internally.

All dates are relative to `current_date` at seed time ("D"). Month offsets
below are calendar months before D. Anything described as "due in N days" is
`D + N`.

Returns a jsonb summary `{table: rowcount, ...}` for the UI toast and the
test.

### 3. Data content

Company: "บจก. สร้างดี คอนสตรัคชั่น", address in Nonthaburi, tax id
`0125599000001` (fictional), phone, email, bank account 1 (ธนาคารกสิกรไทย,
fictional number), `document_template_key` set to the best published pack,
`default_payment_terms` and `default_notes` filled.

Expense categories (replace the 4 defaults): งานโครงสร้าง (ปูน/เหล็ก),
งานสถาปัตย์, ไฟฟ้า/ประปา, วัสดุสิ้นเปลือง, ค่าแรง, ค่าเดินทาง, เครื่องมือ,
เบ็ดเตล็ด. The first four get `use_for_cost_deduction=true` and a
`code_prefix` for inventory codes.

| Area | Rows | Notes |
|---|---|---|
| clients | 8 | 3 บ้านพักอาศัย, 2 หมู่บ้านจัดสรร, 3 บริษัท; tax ids on companies |
| suppliers | 8 | วัสดุก่อสร้าง 2, เหล็ก, ปูน, ไฟฟ้า, สุขภัณฑ์, สี, เครื่องมือ; 3 with credit days |
| catalog_items | 15 | งานฐานราก, งานโครงสร้าง ค.ส.ล., งานก่ออิฐฉาบปูน, งานหลังคา, งานไฟฟ้า, งานประปา, งานทาสี, งานปูกระเบื้อง, งานฝ้า, งานประตูหน้าต่าง, ค่าดำเนินการ ... with units งาน/ตร.ม./จุด |
| sites | 10 + ส่วนกลาง | 5 Ongoing (progress 15, 30, 45, 70, 85 %), 3 Completed (2 retention pending, 1 released), 1 On Hold, 1 Cancelled. Each has client, address, lat/lng in Nonthaburi/Bangkok, start/end dates, `contract_value`, `default_retention_pct=5`, `default_tax_withheld_pct=3`, `default_deposit_pct=30` on 3 sites |
| site_phases / phase_tasks / phase_subtasks | 4 phases per site, 2-4 tasks per phase | dates spread over the site duration, statuses by progress, so Gantt and S-curve render |
| quotations + items | 18 | draft 3, sent 4 (one `valid_until = D+5` for the follow-up bell, one `on_hold`), accepted 9 (one per Ongoing/Completed/On Hold site), rejected 2. Items include `item_description` and `note` rows. Two quotations have 1 `quotation_revisions` snapshot each (with `item_type`). Numbers `QTYYMM-NNN` by quotation month |
| invoices + items + draws + quotation_item_units | ~25 | per accepted site: deposit invoice (`is_deposit`, 30 %) where the site has a deposit pct, then progress draws by cumulative %; 18 paid, 4 unpaid (2 with `due_date < D`), 1 void. VAT on all; `wht_pct=3` |
| receipts + incomes | 18 | one per paid invoice, `tax_withheld` 3 %, `retention` 5 % of subtotal, deposit deduction on the final draw of deposit sites |
| expenses | ~150 | spread over months -8..0, weighted toward Ongoing sites; categories mixed; statuses: paid 70 %, pending 15 % (due dates D..D+30 for the forecast), check_issued/check_cleared via cheques, awaiting_billing on 3 PO expenses; payment_method mixed |
| cheques | 6 | 3 cashed, 3 issued (one `check_date = D+2` for the bell); linked expenses carry `cheque_id` so the trigger syncs status |
| purchase_orders + items | 12 | draft 1 (bell), ordered 3, received 7 (with `received_date`, `expense_id`, status received), cancelled 1. Numbers `POYYMM-NNN` |
| inventory_items + unit factors | 12 | ปูนซีเมนต์, เหล็กเส้น 3 ขนาด, อิฐมอญ, ทราย, หิน, ไม้แบบ, ตะปู, ลวดผูกเหล็ก, สายไฟ, ท่อ PVC; codes from category prefix |
| stock_movements + balances | ~40 | `purchase_in` to ส่วนกลาง from the 7 received POs, `transfer_out`/`transfer_in` to 2 Ongoing sites, 1 `adjustment`; balances written to equal ledger sums; weighted average cost computed in the function the same way as `record_stock_movement` |
| workers | 12 | โฟร์แมน 2, ช่างปูน 3, ช่างเหล็ก 2, ช่างไฟ 2, ช่างประปา 1, กรรมกร 2; salaries 12,000-28,000; `demo-worker@facadex.co.th` on "สมชาย"; all `active` |
| worker_teams + members | 2 teams | ทีม A (โฟร์แมน 1 + 5), ทีม B (โฟร์แมน 1 + 5) |
| worker_assignments | ~10 weeks × 12 workers × 2 shifts | Mon-Sat; `site` on Ongoing sites, some `factory`, `office`, Sundays `holiday`, a few `leave_sick`/`leave_personal`; `confirmed_at` set on the last two weeks' site shifts |
| worker_checkins | last 14 days | lat/lng within 50 m of the site, `confirmed_by='checkin'` on the matching assignment |
| worker_ot | ~15 | 1-3 hours, on Ongoing sites |
| leave_requests | 6 | 2 pending (bell), 3 approved, 1 rejected |
| company_holidays | 3 | upcoming Thai public holidays |
| checkin_locations | 1 | สำนักงาน |
| salary_records | 24 | last 2 months × 12 workers, computed with the Payroll.jsx formulas |
| labor_subcontractors / contracts / payments | 3 / 4 / 6 | 5 payments paid (each with its `expenses` row `is_subcontract=true`, category ค่าแรง), 1 pending, 1 retention release; 3 % WHT so the 50 ทวิ form has data |
| line_groups | 1 | "กลุ่มช่าง สร้างดี" name only |
| line_issue_reports | 2 | open, on Ongoing sites, with photos omitted |
| app_settings | defaults + `is_demo_tenant`, `sign_physical_enabled=true`, `checkin_radius_m=200`, `cheque_reminder_days=3`, `require_checkin_confirmation=false` |

Out of scope for v1: supplier tax invoices, supplier credit notes, document
scans, subscription receipts, LINE settings beyond the group name, estimation.

Totals must be internally consistent: `invoices.total = Σ invoice_items`,
`incomes.received_amount = total - tax_withheld - retention - deposit_deduction`,
site `contract_value = accepted quotation total`, dashboard profit per site is
positive on Completed sites and plausible on Ongoing ones.

### 4. `reset_demo_tenant(p_tenant_id uuid) returns jsonb`

Same security wrapper and marker check. In one transaction:

1. Build the delete order at run time: every table in `public` with a
   `tenant_id` column, excluding `tenants`, `user_roles`, `tenant_modules`,
   `platform_*`, `packages*`, `contractor_type*`, topologically sorted by the
   FK graph among those tables (children first). Tables with no `tenant_id`
   but a FK to a deleted table (`phase_task_workers`) are included through
   their parent's cascade or deleted explicitly first. A cycle or an unknown
   non-cascading child aborts with a clear error instead of a partial wipe.
2. `DELETE FROM <table> WHERE tenant_id = p_tenant_id` in that order.
3. Re-insert the `is_demo_tenant` marker and call `seed_demo_tenant`.
4. Return the seed summary plus `deleted: {table: n}`.

Everything runs in the caller's transaction; any error rolls back the whole
reset, so the demo is never left half-empty.

### 5. UI

`src/pages/TenantManagement.jsx`: in the row actions of a tenant with
`is_demo`, a button "🔄 รีเซ็ตเดโม่". Click opens a confirm modal naming the
company; confirm calls `supabase.rpc('reset_demo_tenant', {p_tenant_id})` via a
new hook `useResetDemoTenant`, shows a spinner, then a toast with the row
counts. Errors surface as a toast with the DB message. No other UI changes.

First-time provisioning (marker + seed) is done once by SQL during rollout; the
button is for later resets.

## Testing

`supabase/tests/demo_tenant_seed_test.sql`, run with
`npx supabase db query --linked -f`, wrapped in `BEGIN ... RAISE EXCEPTION
'RESULT ...'` so nothing persists. It creates a throwaway tenant + owner role
(no auth user), sets the marker, impersonates a platform admin, then asserts:

- row counts per table match the spec table above (exact where fixed, `>=`
  where approximate);
- every number column is unique within the tenant and none collides with a
  number used by any other tenant in the same prefix+period;
- `Σ invoice_items.line_total = invoices.total` for every invoice; every paid
  invoice has exactly one receipt and one income; `received_amount` formula
  holds;
- `inventory_stock_balances.quantity_on_hand = Σ stock_movements` per item and
  site, and weighted average cost ≥ 0;
- `pending_counts()` for the owner returns leave_pending=2, po_draft=1,
  issues_open=2, cheques_due≥1, quotations_followup≥1;
- `reset_demo_tenant` leaves every tenant-scoped table (except the kept ones)
  with zero rows for that tenant before re-seeding, and the second seed returns
  the same counts as the first;
- both functions raise on a tenant without the marker, and raise for a
  non-platform-admin caller.

A vitest for the new hook/modal is not required; the page is platform-admin
only and the RPC is covered by the SQL test.

Rollout: dry-run the migration and the test on CHANG inside a transaction,
apply the migration, run `seed_demo_tenant` once for the demo tenant, deploy
the web app, then the owner logs in as demo-owner in Chrome and the walkthrough
below is done live and reported with "seen live" vs "DB only":
dashboard, sites + Gantt + S-curve, quotations (print one), invoices (print one
+ receipt), expenses + forecast, cheques, inventory, HR + payroll, labor
subcontractors + 50 ทวิ, settings, user management, worker login view.
