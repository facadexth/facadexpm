# Accounting data migration (in from PEAK / FlowAccount, out to the accountant's PEAK) — design

Date: 2026-10-07 · Status: draft for owner review. Sections 1–4 (inbound) were approved by the owner in chat; section 5 (outbound push to PEAK) was added on the owner's "ตกลง เพิ่มเข้าสเปกเลย" the same day.

## 1. Goal
1. **Inbound (onboarding):** a new tenant moves from PEAK or FlowAccount into CHANG with "1 click": drop the export files, review, confirm.
2. **Outbound:** a tenant whose accounting firm closes the books in PEAK can send what was done in CHANG to that PEAK account, so nothing is retyped.

## 2. Inbound approach (approved)
- **B (all tenants):** drag-drop several export files at once; the app detects the source system from the headers, applies a column-mapping preset, shows a preview with counts and problems, then imports as one batch that can be rolled back as a whole.
- **A (PRO Plus and above, later):** PEAK Open API connector to pull data directly. Credentials live in the browser session memory only; never stored, never sent to the app's server logs, never typed into chat.
- Historical documents are imported as **archive records** that never trigger stock, expense or payroll side effects.

## 3. Inbound phases
1. Contacts and products from files (PEAK contacts export, PEAK product report; FlowAccount equivalents).
2. PEAK Open API pull + open AR/AP (aging reports: document no., reference, issue date, due date, total, paid, credit, outstanding).
3. Historical documents as archive records.

Real file shapes seen (PEAK, kept local, never in git): contacts = two header rows, ~40 columns, contact type mostly "ไม่ระบุ" (customer vs supplier is not in the file); AR/AP aging = two header rows, formula summary rows, report-info block to the right, dates as dd/mm/yyyy Gregorian text; product report = 9 header rows then the table (1,029 rows, mostly zero price, negative balances). The parser must skip summary rows and tolerate these shapes.

## 4. Inbound safety
- Preview before write; batch id on every created row; rollback by batch id.
- Dedupe against existing rows (tax ID + branch for contacts; code for products).
- Nothing is written outside the importing tenant; role gate owner/admin; `tenant_can_write()`.
- Personal data in sample files stays out of the repo (git-excluded).

## 5. Outbound: sending CHANG data to the accountant's PEAK

### 5.1 What was verified (official PEAK docs, read 2026-10-07)
- The PEAK Open API (REST JSON, Client Token + User Token, timestamp + HMAC signature) can **create** expenses (also from a purchase order, with received tax invoice, payments, attachments), purchase orders, invoices, receipts, credit notes (including without a reference document), daily journals, contacts and products. Documents exist as draft and approved; there are edit, approve and void calls.
- Helper calls: suggested expense account code per contact, list of account codes, file upload (file vault) and per-document attach calls; read-only trial balance and general ledger.
- Creating documents is a **billable transaction**; the price and the rate limit were not found in the docs.
- An official PEAK MCP server exists (mcp.peakaccount.com/mcp, token from PEAK settings, one merchant+user per token, Claude only). It is for a person chatting with Claude Desktop, not for server-to-server sync.
- API access needs a PEAK package that includes it (earlier check: PRO Plus, about ฿12,000/year; sandbox free for 3 months). Not verified for MCP.

### 5.2 Decisions
- **Use the REST API, not MCP,** from a Supabase edge function. MCP is out of scope.
- **Excel export in PEAK import-template format stays the baseline** (spec `2026-10-06-supplier-credit-note-peak-export-design.md`); the API push is an optional upgrade for tenants whose PEAK account has API access.
- **Push as drafts only.** The accountant reviews and approves inside PEAK. CHANG never approves or voids in PEAK in v1.
- **Credentials belong to the accounting firm or the PEAK account owner,** who enters them in CHANG settings themselves. They are stored encrypted server-side (a secret per tenant, never returned to the browser, never logged); the assistant that builds this never asks for or sees real credentials; development uses PEAK's sandbox with a sandbox account the owner creates.
- **No duplicate pushes:** every pushed document stores the PEAK document id returned (`accounting_sync` table: tenant, entity type, entity id, system 'peak', external id, status, last error, pushed at, payload hash). A document with an external id is never created again; a changed document is shown as "changed after push" and left for a human decision (v1 does not edit PEAK documents).
- **Account codes:** reuse the `peak_account_code` mapping on categories from the credit-note spec; unmapped categories fall back to PEAK's suggested code for the contact, else the push is skipped and listed. Contacts need `peak_contact_no` or tax ID + branch (same rule as the export).
- **Scope of v1 push:** expenses (purchase side) and supplier credit notes first, then income/invoices; deposits, split payments and tax-invoice-matched purchases map as: deposit = its own expense, deduction shown as a line on the final bill (mirrors CHANG), partial payments = one payment record per paid part.
- **Reconciliation:** after a push batch, read the PEAK trial balance for the period and show our totals next to it (informational only).
- **Failure handling:** per-document status; a failed document does not block the others; retry is manual per row; rate-limit and billing-cost responses stop the batch with a clear Thai message. A cost estimate (documents × price) is shown before the push once the price is known.

### 5.3 Phases
- O1: settings (credentials, mapping check), dry preview of what would be pushed with warnings, against PEAK sandbox only.
- O2: push expenses + credit notes as drafts, sync table, retry.
- O3: income/invoices, reconciliation view.

### 5.4 Open items
1. PEAK price per API-created document and rate limits (ask PEAK or read the pricing page).
2. Which PEAK package the target accounting firms actually hold.
3. Exact field-level request schemas per endpoint (read from the API reference when O1 is planned).
4. Whether the firm prefers drafts via API or the Excel import it already knows.

## 6. Testing
Pure parsers and builders unit-tested with vitest fixtures (synthetic data only). Inbound import: rolled-back SQL transaction tests for batch write/rollback and tenant isolation. Outbound: request builders and the sync-table logic unit-tested; the first real calls only against the PEAK sandbox by the owner's sandbox account.

## 7. Not in this spec
FlowAccount API (availability not verified), LINE bot, chart-of-accounts/ledger inside CHANG, approving or voiding documents in PEAK.
