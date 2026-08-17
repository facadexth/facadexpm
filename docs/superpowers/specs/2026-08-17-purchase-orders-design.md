# Purchase Orders (Phase 1) — Design

## Problem

Ordering materials happens entirely outside the app today: conversations over LINE and phone calls with suppliers, with no structured record of what was ordered, from whom, for how much, or when it's due to arrive. The only trace appears after the fact, when someone manually retypes the order into Excel (or directly into the Expenses page) once goods have already been received — a step that introduces errors at every retyping, and leaves no way to see "what's on order but hasn't arrived yet."

The company explicitly does not want a full enterprise procurement stack (formal purchase requests, multi-stage approvals, RFQ workflows) — negotiation and price agreement will keep happening over LINE. What's needed is a lightweight, trackable record of the order itself: created once price is already agreed, generating a document to send to the supplier, and closing the loop by turning "goods received" directly into an expense record — eliminating the manual Excel re-entry step that was the original complaint.

## Goal

A Purchase Order (ใบสั่งซื้อ) entity that: captures what's being ordered (itemized) from which supplier for which site; generates a printable/shareable document; tracks status until goods arrive; and automatically creates the corresponding expense record on receipt.

## Background / decisions already made

- **Negotiation stays on LINE.** The PO is created only after price is already agreed via LINE/phone. This app is not being used to negotiate or send the initial ask — only to record the agreed order and generate its document.
- **No draft/approval stage.** Creating a PO *is* issuing it — there's no separate "draft" state to save and come back to, and no approval step before an order counts as placed. This matches the explicit ask for something lighter than a formal enterprise flow.
- **Multi-line-item POs.** A single PO can contain several line items (e.g. glass + silicone in one order to one supplier), each with its own description/quantity/unit/unit price — not a single lump-sum field.
- **Receipt collapses to one lump-sum expense.** When a PO is marked received, exactly one expense row is created with `amount = SUM(line_total)` across its items. The itemized breakdown is not duplicated onto the expense — it stays on the PO, which the expense links back to for reference. This matches how `expenses` already works today (single `amount` field, no line items) and avoids a schema change to that table.
- **Phase 2 (out of scope here):** requesting quotes from multiple suppliers to compare before choosing, including a public (no-login) link suppliers fill in themselves. That's a materially different, larger shape (one request fanning out to several supplier responses, plus a new kind of unauthenticated-write surface this app doesn't have today) and will get its own design once this phase is built and in use. Nothing in this design should make Phase 2 harder to add later, but nothing here builds toward it either — no speculative columns or tables.

## Data Model

Two new tables, following this project's existing conventions: auto-numbering like `sites`/`clients`/`suppliers`, and tenant-scoped RLS on every table (including child tables — see `site_phases` for the established pattern of child tables carrying their own `tenant_id` rather than relying solely on a parent join).

```sql
CREATE TABLE purchase_orders (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_number       TEXT NOT NULL UNIQUE DEFAULT '',   -- AUTO: PO-2026-001
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE RESTRICT,
  supplier_id     UUID NOT NULL REFERENCES suppliers(id) ON DELETE RESTRICT,
  category_id     UUID NOT NULL REFERENCES expense_categories(id) ON DELETE RESTRICT,
  date            DATE NOT NULL,
  status          TEXT NOT NULL DEFAULT 'ordered'
                  CHECK (status IN ('ordered','received','cancelled')),
  notes           TEXT,
  received_date   DATE,
  expense_id      UUID REFERENCES expenses(id) ON DELETE SET NULL,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE TABLE purchase_order_items (
  id              UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  po_id           UUID NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
  description     TEXT NOT NULL,
  quantity        NUMERIC NOT NULL DEFAULT 1,
  unit            TEXT,                              -- free text: แผ่น/หลอด/ชิ้น/ถุง
  unit_price      NUMERIC NOT NULL DEFAULT 0,
  line_total      NUMERIC NOT NULL DEFAULT 0,         -- quantity * unit_price, computed client-side on save
  sort_order      INT NOT NULL DEFAULT 0,
  tenant_id       UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_purchase_orders_site_id ON purchase_orders(site_id);
CREATE INDEX idx_purchase_orders_supplier_id ON purchase_orders(supplier_id);
CREATE INDEX idx_purchase_orders_status ON purchase_orders(status);
CREATE INDEX idx_purchase_orders_tenant_id ON purchase_orders(tenant_id);
CREATE INDEX idx_purchase_order_items_po_id ON purchase_order_items(po_id);
CREATE INDEX idx_purchase_order_items_tenant_id ON purchase_order_items(tenant_id);
```

Design decisions:

- **`site_id`/`supplier_id`/`category_id` are all required** (unlike `expenses`, where `supplier_id` is optional). A purchase order without a known site, supplier, or expense category doesn't correspond to anything real in this workflow — you already know all three by the time you're recording an agreed order.
- **`ON DELETE RESTRICT` for site/supplier/category FKs**, not `SET NULL` — a PO must always be traceable to a real site/supplier/category. If one of those needs to be removed, the PO must be reassigned or cancelled first (existing `expenses` uses `SET NULL`, but that table treats those fields as optional-ish historical detail; a PO is an active instruction to buy something specific, so a dangling reference is a bigger problem here).
- **`expense_id` is nullable and only set on receipt.** It's the audit trail back from a PO to the expense it generated — not set at creation time, since no expense exists yet.
- **`line_total` is stored, not computed on read**, matching this codebase's existing pattern (e.g. `worker_ot.ot_hours` is stored pre-rounded rather than derived at query time) — the form computes and saves it, so downstream aggregation (`SUM(line_total)` for the auto-expense, and for display totals) is a plain sum, no recomputation logic duplicated across the app.
- **`purchase_order_items` has its own `tenant_id`**, following the `site_phases` precedent, rather than relying only on a join through `po_id` for RLS scoping.

## Status Lifecycle

Three states only:

- **`ordered`** (default on creation) — the order has been placed (agreed via LINE, recorded here, document generated and sent).
- **`received`** — goods have arrived. Setting this status is the trigger that creates the linked expense (see below). Settable only from `ordered`.
- **`cancelled`** — the order fell through and nothing will be delivered. Settable only from `ordered` (a `received` PO that already generated an expense should not be cancelled — if the underlying expense needs reversing, that's handled on the Expenses page like any other expense correction, not by mutating the PO after the fact).

No `issued` state distinct from `ordered`: creating the PO and generating its document happen together, in the same user action.

## UI

**New tab: "🧾 ใบสั่งซื้อ"**, positioned between รายจ่าย and รายรับ in `App.jsx`'s `TABS` array, `minRole: 'ADMIN'`, `module: null` (core feature, same tier as Expenses/Income — not gated behind a paid module for Phase 1).

**List page**, following the exact structure `Expenses.jsx`/`Sites.jsx` already use: toolbar with "+ เพิ่มใบสั่งซื้อ" and date-range filter, a sub-filter row (site / supplier / status), a table (PO number, date, site, supplier, item count, total, status badge, actions), and status-change/delete affordances matching the existing badge-click-to-change-status pattern used for expense status.

**Add/Edit modal**, mirroring `ExpenseForm`'s header-fields layout (site/supplier/category `SearchableSelect`s, date picker) plus a line-item editor below: an addable/removable list of rows (description input, quantity, unit, unit price), each row's `line_total` computed live as `quantity * unit_price`, with a running grand total shown beneath the list. Saving computes and persists each item's `line_total` and inserts/updates `purchase_order_items` alongside the `purchase_orders` row in one form submission (delete-and-reinsert items on edit, the simplest correct approach for a small number of rows per PO — matching how `ExcelUpload`-driven imports already replace rather than diff rows elsewhere in this app).

**Document view**: a "📄 พิมพ์ใบสั่งซื้อ" button opens a `Modal` containing a clean, print-oriented HTML layout (company header, PO number, site, supplier, date, itemized table, grand total) with a fixed element id, and a "ดาวน์โหลด PDF" button that calls the existing `downloadPDF(elementId, filename)` helper from `src/lib/pdf.js` — the same function `HR.jsx`/`LaborContractors.jsx` already use to export payslips/contracts. The resulting PDF is downloaded locally; sending it to the supplier over LINE is a manual step the user does themselves (attach the downloaded file in their LINE chat) — no LINE API integration in Phase 1.

**Receive flow**: on a PO with `status = 'ordered'`, a "✅ รับของแล้ว" button opens a `ConfirmDialog`. On confirm:
1. Insert one row into `expenses`: `date = today`, `site_id`, `category_id`, `supplier_id`, `supplier = <supplier name>` (matching the existing dual `supplier_id`+`supplier` text pattern already used elsewhere in `Expenses.jsx`), `amount = SUM(purchase_order_items.line_total) for this po_id`, `payment_method = 'transfer'`, `status = 'pending'`, `notes = 'จาก ใบสั่งซื้อ <po_number>'`.
2. Update the PO: `status = 'received'`, `received_date = today`, `expense_id = <new expense id>`.

Both writes happen from the client in sequence (insert expense, then update PO with the returned id) — no database trigger or stored procedure, consistent with how this app already does all its writes (plain `supabase.from(...).insert()/.update()` calls in page components, no PL/pgSQL business logic beyond auto-numbering and RLS helpers).

**Linking back**: the Expenses table gains a small visual indicator (e.g. a badge or icon next to the description) on rows that have a non-null `po_id`, linking back to view the originating PO's itemized detail — read-only reference, not an edit path.

Note: this requires adding `po_id UUID REFERENCES purchase_orders(id) ON DELETE SET NULL` to the `expenses` table (nullable, only ever set by the receive-flow insert above — manually created expenses never set it).

## Auto-numbering

`po_number` follows the exact pattern already used for `sites`/`clients`/`suppliers` (`FX-YYYY-NNN`/`CL-YYYY-NNN`/`SP-YYYY-NNN`): format `PO-YYYY-NNN`, generated the same way those are (check the current auto-numbering trigger/function used for those tables and reuse the identical mechanism for `purchase_orders`, rather than inventing a new numbering approach).

## Permissions

Same as Expenses/Sites: `minRole: 'ADMIN'` to view/create/edit/receive/cancel POs. WORKER role has no access (consistent with the existing `TABS` gating in `App.jsx`, where financial-record tabs are all ADMIN+).

## Out of Scope

- Multi-supplier quote requests, comparison, and the public no-login supplier link (Phase 2 — separate design, separate spec, once Phase 1 is built and in use).
- LINE API integration (sending the document directly via LINE from the app) — the user downloads the PDF and sends it manually.
- Editing a PO's items after it's been marked `received` (the expense has already been generated by that point; changes belong on the Expenses page instead).
- Un-cancelling a cancelled PO, or reversing a `received` PO back to `ordered`.
- Partial receipt (receiving some line items now and the rest later) — a PO is received all at once.
- Any change to the existing `expenses` table's required fields, filters, or UI beyond the new `po_id` column and its read-only reference indicator.

## Testing

No automated test suite exists for this frontend; verification plan matches the pattern already used in this codebase's other feature designs (e.g. `docs/superpowers/specs/2026-08-14-ot-decouple-design.md`):

1. `execute_sql`: confirm the new tables, constraints, indexes, and RLS policies via schema inspection (`pg_get_constraintdef`, `information_schema.columns`), and confirm `po_number` auto-numbering produces sequential, correctly-formatted values.
2. Manual click-through in the dev server: create a PO with 2+ line items, confirm the running total updates live, save, confirm it appears correctly in the list; generate and download the PDF document, confirm it renders all items and the correct grand total; mark it received, confirm exactly one expense is created with the correct summed amount and that it appears correctly filtered/linked on the Expenses page; confirm a `cancelled` PO can no longer be marked received; confirm RLS blocks cross-tenant access to another tenant's POs (matching the pattern in `supabase/tests/tenant_scoping_test.sql`).
