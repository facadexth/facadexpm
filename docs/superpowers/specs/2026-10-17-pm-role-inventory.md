# PM role inventory (2026-10-17)

Read-only survey of every role check, made before adding the `PM` role. It
backs §13 of `2026-10-17-gantt-weighted-progress-design.md`. Line numbers are
from main 47ea5c05. Re-check them before editing.

Abbreviations used below:
- IAO = `is_admin_or_owner()`
- IO = `is_owner()`
- CT = `tenant_id = current_tenant_id()`
- HMA(x) = `has_module_access(x)`

## 1. Database

### 1.1 Role helpers and the role CHECK

**Helpers.** `current_user_role()`, `is_admin_or_owner()` and `is_owner()` are
SECURITY DEFINER. They were last defined in `2026-08-15-01-enable-rls.sql:39-58`.
Their grants are in `2026-08-16-05:50-55` and `2026-10-03-07:34-40`.

**The role CHECK.** `CHECK (role IN ('OWNER','ADMIN','WORKER'))` lives only in
`schema.sql:2232`. It is inline and unnamed; the expected name is
`user_roles_role_check`, but verify that in pg_constraint before changing it.

**Policies.** The effective policy expressions are in
`2026-10-17-02-rls-initplan-wrap.sql`. That file uses ALTER POLICY, so each
policy's name and command come from its earlier CREATE POLICY.

**Seats.**
- `tenant_under_seat_limit('admins')` (`2026-09-05-05:87-88`) counts OWNER and ADMIN.
- `tenant_seat_status` (`2026-08-29-16:22`) counts the same.
- The user_roles `owner_inserts` / `owner_updates` policies (initplan file :747-757) check `role <> ALL('OWNER','ADMIN') OR tenant_under_seat_limit('admins')`.

**Signup.** `handle_new_user` (`2026-10-01-06:96-99`) gives an uninvited user
OWNER and an invited user WORKER.

### 1.2 Tables by what PM needs

**SITE-OPS (read and write):**
- sites
- site_phases
- phase_subtasks
- phase_tasks (worker_* policies stay)
- phase_task_workers
- worker_assignments and worker_ot (IAO AND HMA('payroll'))
- worker_teams and worker_team_members (owner_writes is IO; tenant_reads has no role check)
- site_attachments
- line_site_photos
- line_issue_reports
- leave_requests (PM approves leave)
- storage `site_attachments_tenant_access` (`2026-08-19-01:27`)
- storage `line_site_photos_tenant_access` (`2026-09-19-09:54`)
- storage `line_site_photos_uploads` / `_deletes` (`2026-09-30-02:18/:26`)

**PM-READ:**
- workers (money columns: monthly_salary, monthly_contribution)
- worker_checkins
- line_checkins
- company_holidays (staff_reads has no role check)
- clients
- units
- suppliers
- checkin_locations (tenant_read_access has no role check)

**PM-READ through price-free views:**
- purchase_orders, purchase_order_items, purchase_order_attachments: admin_full_access FOR ALL, IAO AND HMA('purchase_orders')
- inventory_items, inventory_item_unit_factors, inventory_stock_balances (weighted_average_cost), stock_movements (unit_cost)
- storage po_attachments (`2026-08-17-06:28`)

**MONEY / ADMIN (keep IAO or IO):**
- Income: incomes, invoices*, receipts
- Quotations: quotations*, catalog_items
- Payments: expenses*, cheques, bank_accounts, document_receipts*
- Payroll: salary_records
- Labor: labor_*
- Supplier finance: supplier_credit_note*, supplier_deposits, supplier_tax_invoice_* (7 tables), po_deposit_applications
- Receiving: po_receipts*
- Supplier documents and estimates: supplier_document_examples, scan_result_cache, document_scan_usage, site_cost_estimates
- Settings and audit: app_settings, audit_logs, calendar_sync
- Billing: payment_intents
- Estimation: alu_*, aluminum_*, bom_template_*, estimation_*, door_window_types, infill_types
- LINE: line_settings, line_command_settings, line_groups, line_pending_actions, line_deep_link_tokens, line_unlinked_senders, line_unrecognized_groups
- Tenant and users: tenants (owner update), user_roles (writes)
- Platform tables
- Storage buckets: invoice_photos, document_receipts, supplier_doc_examples, tenant_logos, tenant_doc_images

Note: some pages PM uses read `app_settings` keys such as the travel rate and the checkin toggle (`useSupabase.js:1014`, `HR.jsx:537`). Those come back null for PM. That is fine because the money sections that use them are hidden.

### 1.3 RPCs and functions

**Wrongly block PM:**
- `perform_location_checkin` / `perform_location_checkout` (`2026-10-02-03:54/:121`, ADMIN/OWNER only)
- `register_push_subscription` (`2026-10-04-01:45`, IAO)

**Correctly block PM** (money RPCs, IAO AND HMA('purchase_orders')):
- receive_po_lines
- receive_po_with_deposits
- create_po_deposit
- split_payment
- the supplier tax invoice and credit note RPCs
- record_stock_movement
- tenant downgrade RPCs

### 1.4 Money columns and views PM must not get

- **sites:**
  - contract_value, contract_value_no_vat, has_vat, plan_type
  - default_vat_pct, default_tax_withheld_pct, default_retention_pct, default_retention_period_days, default_deposit_pct
  - retention_released, retention_released_date
  - cost_aluminum, cost_glass, cost_equipment, cost_rubber, cost_labor, cost_other
- **workers:** monthly_salary, monthly_contribution, has_social_security
- **workers_with_rate** (view): daily_rate, social_security_amount
- **purchase_order_items:** unit_price, line_total, discount_pct
- **purchase_orders:** deposit_hint, expense_id
- **Inventory:** inventory_stock_balances.weighted_average_cost, stock_movements.unit_cost

**Views with money:**
- **site_financial_summary** (latest `2026-10-17-03:10`, security_invoker):
  - read by `useSites()` (`useSupabase.js:46`), which feeds Sites, Assign, PhaseKanbanBoard, PurchaseOrders, Inventory and Dashboard
  - read by `useSiteOverview` (:126)
- sites_progress (billing_pct)
- site_deposit_summary, site_retention_summary (both fetched with `.single()`)
- labor_cost_by_site, site_travel_cost, ot_cost_by_site

## 2. Frontend

### 2.1 Core

**`useUserRole.js`**
- `useUserRole.js:9` sets `HIERARCHY = {OWNER:3, ADMIN:2, WORKER:1}`, and :125-127 is `isAtLeast`.
- PM is missing from the hierarchy, so it ranks 0 and is blocked everywhere.
- Ranking PM at 2 would let PM into every ADMIN page. A sibling role needs capability flags instead.
- :95 treats a missing role row as WORKER.

**`permissions.js`**
- `PAGE_LABELS` (:14-35) and `DEFAULT_PERMISSIONS` (:37-125) only know three roles.
- `getPageLevel` (:166-170) falls back to `'edit'` for an unknown role or page.
- These pages are not registered: deposits, retention, estimation, bom_templates, starting_guide.
- supplier_credit_notes and supplier_tax_invoices reuse the permKey `purchase_orders`.

**`App.jsx`**
- TABS `minRole` is set at :64-108, and site_detail at :128.
- The gate is at :314-318.
- The fallback redirect is at :396.
- purchase_orders sits inside the "💸 รายจ่าย" group.

**`ProtectedPage.jsx`** checks the role at :37 and :53-54.

### 2.2 Pages

- **Sites:**
  - `Sites.jsx:512-513` canEdit
  - money fields at :48-52, :59, :74, :91
- **SiteDetail:**
  - `SiteDetail.jsx:28-29` canEdit
  - :31 useSiteOverview
  - :92/:98 SCurveChart
  - `SCurveChart.jsx:23-24`, :75
- **Site overview:** `SiteOverviewContent.jsx:25-35,48` and `SiteOverviewModal.jsx:15-19`
- **Dashboard:**
  - `Dashboard.jsx:178-179` canSeeFinancials
  - billing % at :163-166
  - KPIs at :350-359, :482-484
- **Assign:**
  - `Assign.jsx:30-31` canEdit
  - :370 team manager is OWNER-only
  - :406-430 cost section
- **Assign subviews:** `GridView.jsx:56` daily rate and `DayView.jsx:14,91,105-107` costs
- **Assignment hooks:** useAssignments / useAssignmentsRange (`useSupabase.js:~760-790`) join workers' salary
- **HR:**
  - `HR.jsx:375-377` canEdit
  - :824-838 self-filter
  - :915-923 payroll tab
  - salary fields at :41, :50, :108, :564
  - :384 workers_with_rate
- **PurchaseOrders:** `PurchaseOrders.jsx:842-843`
- **Inventory:** `Inventory.jsx:1089-1090`
- **Settings:**
  - `Settings.jsx:506` isAdminPlus (web push :542/:671, signature :545/:764)
  - :985 permission editor hard-codes three roles
- **useSupabase.js:** :513 office check-in fallback checks ADMIN/OWNER
- **UserManagement:**
  - `UserManagement.jsx:13` ROLES, :17 CREATE_ROLES, :18/:158 default role
  - :171 seat warning
  - :238-246 badges
  - :356 checkin location
  - :383-395 descriptions
- **Pages that stay correct while PM cannot open them** (they use `canEdit = isAtLeast('ADMIN') && …`): Income, Expenses, Invoices, Quotations, LaborContractors, Clients, Suppliers, CatalogItems, Estimation, AluminumProfiles, BomTemplates

## 3. Edge functions

**Wrongly block PM:**
- `route-distance/index.ts:28-29`
- `extract-map-coordinates/index.ts:74`
- `web-push-test/index.ts:26-27`
- `leave-notify/index.ts:83` (PM approves leave)

**Correctly block PM:**
- `extract-po-document:182`
- `lookup-company:129`
- `create-user:43` (OWNER)
- `line-test-group:50`

**Who gets notified:**
- `_shared/web-push.ts:72-74` `sendWebPushToTenantAdmins` sends to OWNER and ADMIN. Its callers fall into two groups:
  - Operational events, which PM should get:
    - issue report: `line-webhook:1107-1109`
    - material request: `field-form:275`
    - leave request: `field-form:301`
    - worker offboarded: `line-webhook:207-208`, `line-worker-offboarded:74-75`
  - Money events, which PM must not get:
    - `line-push-cheque-reminders:152`
    - `line-push-quotation-followups:120`
- `field-form:112-116` `notifyAdmins` sends LINE messages to OWNER and ADMIN.
- `_shared/line-admin-chat.ts:79` allows OWNER and ADMIN only.
