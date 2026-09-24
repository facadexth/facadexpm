# Finished-Goods Tracking + Statutory Tax Stock Reports Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add finished-goods stock tracking (one SKU per quotation line, deducted fractionally as invoices bill against it) alongside the existing raw-material deduction, plus three tax-filing stock reports matching Thailand's statutory รายงานสินค้าและวัตถุดิบ (มาตรา 87(3)).

**Architecture:** One additive schema change (`inventory_items.item_kind`/`quotation_item_id`), one new pure function computing the finished-goods movement plan (mirrors the existing `computeInvoiceDeductionPlan` pattern), wired into the existing `InvoiceDeductionRow.confirm()` click so both raw-material and finished-goods deductions post together. Reporting is a second pure function (`computeStockLedgerReport`) consumed by three thin UI views under a new tab, fed by data already fetched via existing hooks — no new hooks, no new RPC.

**Tech Stack:** React 18 + Vite, Supabase (Postgres + PostgREST + RPC), Vitest.

**Spec:** docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md

## Global Constraints

- Finished-goods cost basis = `quotation_item.line_total × (materialPct / 100)` — the SAME `%ต้นทุนวัสดุ` already reviewed per invoice in `InvoiceDeductionRow`, never the full sale price.
- Finished-goods movements post at the SAME `InvoiceDeductionRow.confirm()` click as the existing raw-material deduction — never at invoice-creation time, never as a separate confirm step.
- `record_stock_movement` (the existing RPC) is reused verbatim for both raw-material and finished-goods movements — no new SQL function.
- Existing raw-material deduction logic (`computeInvoiceDeductionPlan`, its `plan.steps` loop) is untouched.
- Line-level granularity only (1 quotation line = 1 finished-goods SKU = 1.0 ชุด) — not `quotation_item_units`/`invoice_item_draws` unit-level.
- Supabase project id for all MCP tool calls: `yyzbgdmgyvvypfcjuhtr`.

---

### Task 1: Schema — finished-goods item kind

**Files:**
- Create: `supabase/migrations/2026-09-24-01-finished-goods-item-kind.sql`

**Interfaces:**
- Produces: `inventory_items.item_kind` (text, `'raw_material'` default or `'finished_goods'`), `inventory_items.quotation_item_id` (uuid, nullable FK to `quotation_items.id`), unique index `inventory_items_finished_goods_unique` on `(tenant_id, quotation_item_id)` where `item_kind = 'finished_goods'` (guarantees at most one finished-goods SKU per quotation line per tenant — later tasks rely on this to safely find-or-create).

- [ ] **Step 1: Write the migration**

```sql
-- Adds a "finished goods" concept to inventory_items, additive to the
-- existing raw-material-only model. A finished-goods row represents one
-- quotation line (quotation_item_id), tracked in "ชุด" (sets), deducted
-- fractionally as invoices bill against that line -- see
-- docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md.
alter table inventory_items add column item_kind text not null default 'raw_material'
  check (item_kind in ('raw_material', 'finished_goods'));
alter table inventory_items add column quotation_item_id uuid references quotation_items(id) on delete set null;

-- At most one finished-goods SKU per quotation line per tenant -- the
-- confirm-flow find-or-create logic (Task 3) relies on this being
-- enforced by the database, not just application logic.
create unique index inventory_items_finished_goods_unique
  on inventory_items (tenant_id, quotation_item_id)
  where item_kind = 'finished_goods';
```

- [ ] **Step 2: Apply the migration**

Use the `mcp__plugin_supabase_supabase__apply_migration` tool with `project_id: "yyzbgdmgyvvypfcjuhtr"`, `name: "finished_goods_item_kind"`, and the SQL from Step 1 as `query`.

- [ ] **Step 3: Verify the columns and constraint**

Run via `mcp__plugin_supabase_supabase__execute_sql` (`project_id: "yyzbgdmgyvvypfcjuhtr"`):

```sql
select column_name, data_type, column_default from information_schema.columns
where table_name = 'inventory_items' and column_name in ('item_kind', 'quotation_item_id')
order by column_name;
```

Expected: two rows — `item_kind` (`text`, default `'raw_material'::text`) and `quotation_item_id` (`uuid`, no default).

```sql
select conname, pg_get_constraintdef(oid) from pg_constraint
where conrelid = 'inventory_items'::regclass and conname like '%item_kind%';
```

Expected: one row whose def is `CHECK ((item_kind = ANY (ARRAY['raw_material'::text, 'finished_goods'::text])))`.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-24-01-finished-goods-item-kind.sql
git commit -m "feat: add finished-goods item_kind + quotation_item_id to inventory_items"
```

---

### Task 2: Finished-goods deduction math (pure function)

**Files:**
- Modify: `src/lib/inventoryCost.js` (add new exported function; do not touch existing functions)
- Modify: `src/lib/inventoryCost.test.js` (add new `describe` block)

**Interfaces:**
- Consumes: nothing from other tasks (pure function, no DB access).
- Produces: `computeFinishedGoodsDeductionPlan({ billedLines, materialPct, existingFinishedGoodsQuotationItemIds })` returning `{ steps: Array<{ type: 'adjustment'|'sale_out', quotationItemId: string, code: string, name: string, quantity: number, unitCost: number }> }`. Task 3 calls this directly and consumes `steps`.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/inventoryCost.test.js` (new `describe` block, anywhere after the existing `computeInvoiceDeductionPlan` block; also add `computeFinishedGoodsDeductionPlan` to the existing top-of-file import list):

```js
describe('computeFinishedGoodsDeductionPlan', () => {
  const line = (over = {}) => ({
    quotationItemId: 'qi-1', quotationNumber: 'QT2609-040', sortOrder: 1,
    description: 'ประตูหน้าต่างอลูมิเนียม', quotationItemLineTotal: 100000, invoiceItemLineTotal: 10000,
    ...over,
  })

  it('new finished-goods line: emits an opening adjustment plus the sale_out fraction', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [line()], materialPct: 70, existingFinishedGoodsQuotationItemIds: new Set(),
    })
    expect(plan.steps).toEqual([
      { type: 'adjustment', quotationItemId: 'qi-1', code: 'QT2609-040-1', name: 'ประตูหน้าต่างอลูมิเนียม', quantity: 1, unitCost: 70000 },
      { type: 'sale_out', quotationItemId: 'qi-1', code: 'QT2609-040-1', name: 'ประตูหน้าต่างอลูมิเนียม', quantity: 0.1, unitCost: 70000 },
    ])
  })

  it('already-existing finished-goods line: skips the adjustment, only sale_out', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [line()], materialPct: 70, existingFinishedGoodsQuotationItemIds: new Set(['qi-1']),
    })
    expect(plan.steps).toEqual([
      { type: 'sale_out', quotationItemId: 'qi-1', code: 'QT2609-040-1', name: 'ประตูหน้าต่างอลูมิเนียม', quantity: 0.1, unitCost: 70000 },
    ])
  })

  it('materialPct scales unit cost, never the full sale value', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [line({ quotationItemLineTotal: 50000, invoiceItemLineTotal: 50000 })],
      materialPct: 40, existingFinishedGoodsQuotationItemIds: new Set(['qi-1']),
    })
    expect(plan.steps[0].unitCost).toBe(20000)
    expect(plan.steps[0].quantity).toBe(1)
  })

  it('multiple billed lines each get their own steps', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [
        line({ quotationItemId: 'qi-1', sortOrder: 1 }),
        line({ quotationItemId: 'qi-2', sortOrder: 2, description: 'ประตูบานเลื่อน', quotationItemLineTotal: 60000, invoiceItemLineTotal: 6000 }),
      ],
      materialPct: 70, existingFinishedGoodsQuotationItemIds: new Set(),
    })
    expect(plan.steps.map(s => s.quotationItemId)).toEqual(['qi-1', 'qi-1', 'qi-2', 'qi-2'])
    expect(plan.steps[3]).toEqual({ type: 'sale_out', quotationItemId: 'qi-2', code: 'QT2609-040-2', name: 'ประตูบานเลื่อน', quantity: 0.1, unitCost: 42000 })
  })

  it('skips a line with no quotationItemId (not tied to a quotation)', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [line({ quotationItemId: null })], materialPct: 70, existingFinishedGoodsQuotationItemIds: new Set(),
    })
    expect(plan.steps).toEqual([])
  })

  it('skips a line whose quotation-item total is zero (division guard)', () => {
    const plan = computeFinishedGoodsDeductionPlan({
      billedLines: [line({ quotationItemLineTotal: 0 })], materialPct: 70, existingFinishedGoodsQuotationItemIds: new Set(),
    })
    expect(plan.steps).toEqual([])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: FAIL — `computeFinishedGoodsDeductionPlan is not a function` (or import error).

- [ ] **Step 3: Implement**

Add to `src/lib/inventoryCost.js`, after `computeInvoiceDeductionPlan`'s closing `}`:

```js
/**
 * Computes the finished-goods movements needed when confirming ตัดสต็อก
 * for one invoice, alongside (not instead of) the raw-material deduction
 * -- see docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md.
 * One quotation line = one finished-goods SKU = 1.0 ชุด total. A line
 * seen for the first time gets an 'adjustment' step (รับเข้า 1 ชุด,
 * valued at materialPct of its full contract value) ahead of its
 * 'sale_out' step (the fraction billed on THIS invoice).
 *
 * @param {object} params
 * @param {Array<{quotationItemId: string|null, quotationNumber: string, sortOrder: number, description: string, quotationItemLineTotal: number, invoiceItemLineTotal: number}>} params.billedLines
 * @param {number} params.materialPct - 0-100, the SAME %ต้นทุนวัสดุ the raw-material deduction step already uses for this invoice
 * @param {Set<string>} params.existingFinishedGoodsQuotationItemIds - quotation_item_id values that already have an inventory_items row with item_kind='finished_goods'
 * @returns {{ steps: Array<{ type: 'adjustment'|'sale_out', quotationItemId: string, code: string, name: string, quantity: number, unitCost: number }> }}
 */
export function computeFinishedGoodsDeductionPlan({ billedLines, materialPct, existingFinishedGoodsQuotationItemIds }) {
  const steps = []
  for (const line of billedLines || []) {
    if (!line.quotationItemId) continue
    if (!(line.quotationItemLineTotal > 0)) continue
    const code = `${line.quotationNumber}-${line.sortOrder}`
    const unitCost = line.quotationItemLineTotal * (materialPct / 100)
    if (!existingFinishedGoodsQuotationItemIds.has(line.quotationItemId)) {
      steps.push({ type: 'adjustment', quotationItemId: line.quotationItemId, code, name: line.description, quantity: 1, unitCost })
    }
    const saleQty = line.invoiceItemLineTotal / line.quotationItemLineTotal
    steps.push({ type: 'sale_out', quotationItemId: line.quotationItemId, code, name: line.description, quantity: saleQty, unitCost })
  }
  return { steps }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: PASS, all tests in the file including the new `describe` block.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js
git commit -m "feat: add computeFinishedGoodsDeductionPlan for the finished-goods stock ledger"
```

---

### Task 3: Wire finished-goods posting into InvoiceDeductionRow.confirm()

**Files:**
- Modify: `src/pages/Inventory.jsx:1` (add `computeFinishedGoodsDeductionPlan` to the existing import from `../lib/inventoryCost.js`)
- Modify: `src/pages/Inventory.jsx:366-390` (`InvoiceDeductionRow`'s `confirm` function)

**Interfaces:**
- Consumes: `computeFinishedGoodsDeductionPlan` from Task 2 (exact signature above).
- Produces: nothing new for later tasks — this task's output is DB rows (`inventory_items` with `item_kind='finished_goods'`, `stock_movements`) that Task 5's reports read live from Supabase, not through any JS interface.

- [ ] **Step 1: Add the import**

Find the top-of-file import from `../lib/inventoryCost.js` in `src/pages/Inventory.jsx` (it currently imports `computeInvoiceDeductionPlan` among others) and add `computeFinishedGoodsDeductionPlan` to that same import statement's named list.

- [ ] **Step 2: Extend `confirm()`**

In `src/pages/Inventory.jsx`, inside `InvoiceDeductionRow`'s `confirm` function, insert the following block immediately after the existing raw-material loop (`for (const step of plan.steps) { ... }`, ending at line 383) and before the `if (plan.totalShortfall > 0.01) { ... }` check (line 384) — i.e. it runs after raw-material steps succeed, still inside the same `try` block so the existing `catch` at line 388 covers it:

```js
      // Finished-goods deduction (additive to the raw-material steps
      // above, posted at this SAME confirm click -- see
      // docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md).
      const { data: quotation, error: qErr } = await supabase
        .from('quotations').select('quotation_number').eq('id', invoice.quotation_id).maybeSingle()
      if (qErr) throw qErr

      const { data: invItems, error: invItemsErr } = await supabase
        .from('invoice_items')
        .select('quotation_item_id, line_total, quotation_items!inner(id, description, line_total, sort_order, item_type)')
        .eq('invoice_id', invoice.id)
        .eq('quotation_items.item_type', 'item')
      if (invItemsErr) throw invItemsErr

      const billedLines = (invItems || [])
        .filter(li => li.quotation_item_id)
        .map(li => ({
          quotationItemId: li.quotation_item_id,
          quotationNumber: quotation?.quotation_number || '',
          sortOrder: li.quotation_items.sort_order,
          description: li.quotation_items.description,
          quotationItemLineTotal: li.quotation_items.line_total,
          invoiceItemLineTotal: li.line_total,
        }))

      if (billedLines.length) {
        const quotationItemIds = billedLines.map(l => l.quotationItemId)
        const { data: existingFg, error: fgErr } = await supabase
          .from('inventory_items').select('id, quotation_item_id')
          .eq('item_kind', 'finished_goods').in('quotation_item_id', quotationItemIds)
        if (fgErr) throw fgErr
        const existingByQuotationItemId = new Map((existingFg || []).map(r => [r.quotation_item_id, r.id]))

        const fgPlan = computeFinishedGoodsDeductionPlan({
          billedLines, materialPct: parseFloat(materialPct) || 0,
          existingFinishedGoodsQuotationItemIds: new Set(existingByQuotationItemId.keys()),
        })

        for (const step of fgPlan.steps) {
          let itemId = existingByQuotationItemId.get(step.quotationItemId)
          if (step.type === 'adjustment' && !itemId) {
            const { data: created, error: createErr } = await supabase
              .from('inventory_items').insert({
                name: step.name, code: step.code, base_unit: 'ชุด', active: true,
                unit_conversion_mode: 'plain', item_kind: 'finished_goods', quotation_item_id: step.quotationItemId,
              }).select('id').single()
            if (createErr) throw createErr
            itemId = created.id
            existingByQuotationItemId.set(step.quotationItemId, itemId)
          }
          const { error: rpcErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: itemId, p_site_id: invoice.site_id, p_movement_type: step.type,
            p_quantity: step.quantity, p_unit_cost: step.unitCost,
            p_reference_type: step.type === 'adjustment' ? 'quotation' : 'invoice',
            p_reference_id: step.type === 'adjustment' ? invoice.quotation_id : invoice.id,
            p_notes: step.type === 'adjustment' ? (quotation?.quotation_number || null) : invoice.invoice_number,
          })
          if (rpcErr) throw rpcErr
        }
      }
```

- [ ] **Step 3: Verify with disposable test data (no automated test harness covers this component — verify live against the real DB, then clean up)**

Using the `mcp__plugin_supabase_supabase__execute_sql` tool (`project_id: "yyzbgdmgyvvypfcjuhtr"`), create a disposable client, site, quotation with one `quotation_item` (`line_total = 100000`), and an invoice with one `invoice_item` referencing that quotation item (`line_total = 10000`, i.e. 10%) — reuse existing `tenant_id` `1b9affc4-2136-4ed1-b168-a36e6624e743`. Then run the app locally (`npm run dev`), log in, open คลังสินค้า → ตัดสต็อกจากใบแจ้งหนี้, find the disposable invoice, set `% ต้นทุนวัสดุ` to 70, and click ยืนยันตัดสต็อก.

Verify via SQL:

```sql
select ii.code, ii.name, ii.item_kind, sm.movement_type, sm.quantity, sm.unit_cost, sm.notes
from stock_movements sm join inventory_items ii on ii.id = sm.inventory_item_id
where ii.item_kind = 'finished_goods' and ii.quotation_item_id = '<the disposable quotation_item id>'
order by sm.created_at;
```

Expected: two rows — `('adjustment', 1, 70000, '<quotation_number>')` then `('sale_out', 0.1, 70000, '<invoice_number>')`.

**Idempotency check**: still in the UI, collapse and re-expand that same invoice row and click ยืนยันตัดสต็อก again. Expected: the existing "already deducted" alert fires (the pre-existing `existing?.length` guard at `Inventory.jsx:371-374`) and no additional rows appear when the SQL query above is re-run.

**Reuse check**: create a second disposable invoice billing a further 20% against the SAME quotation item (`invoice_items.line_total = 20000`), confirm ตัดสต็อก on it too, then re-run the SQL query above. Expected: still only ONE `inventory_items` row for that `quotation_item_id` (the unique index from Task 1 backs this), a THIRD `stock_movements` row `('sale_out', 0.2, 70000, '<second invoice_number>')`, and `inventory_stock_balances.quantity_on_hand` for that item now `1 - 0.1 - 0.2 = 0.7`.

Then delete all disposable rows created across both invoices — `stock_movements`, `inventory_stock_balances`, `inventory_items` (finished-goods row), `invoice_items`, `invoices`, `quotation_items`, `quotations`, `sites`, `clients` — in that FK-safe order.

- [ ] **Step 4: Commit**

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: post finished-goods stock movements alongside raw-material deduction"
```

---

### Task 4: Stock-ledger report math (pure function)

**Files:**
- Modify: `src/lib/inventoryCost.js` (add new exported function)
- Modify: `src/lib/inventoryCost.test.js` (add new `describe` block)

**Interfaces:**
- Consumes: nothing from other tasks (pure function).
- Produces: `computeStockLedgerReport({ movements, items, dateFrom, dateTo, itemKindFilter, categoryId })` returning `Array<{ itemId, code, name, unit, openingQty, openingValue, inQty, inValue, outQty, outValue, closingQty, closingValue, movements: Array<{date, type, reference, qty, unitCost, value, direction}> }>`. Task 5 calls this directly and renders its return value.

- [ ] **Step 1: Write the failing tests**

Add to `src/lib/inventoryCost.test.js` (add `computeStockLedgerReport` to the top-of-file import list):

```js
describe('computeStockLedgerReport', () => {
  const items = [
    { id: 'item-fg', code: 'QT2609-040-1', name: 'ประตูหน้าต่าง', base_unit: 'ชุด', item_kind: 'finished_goods', category_id: null },
    { id: 'item-rm', code: 'GL-0001', name: 'กระจกใส 6mm', base_unit: 'แผ่น', item_kind: 'raw_material', category_id: 'cat-glass' },
  ]
  const m = (over = {}) => ({ inventory_item_id: 'item-rm', movement_type: 'purchase_in', quantity: 10, unit_cost: 100, created_at: '2026-09-15T10:00:00Z', notes: null, ...over })

  it('movements before dateFrom become the opening balance, not in/out', () => {
    const rows = computeStockLedgerReport({
      movements: [m({ created_at: '2026-08-01T10:00:00Z', quantity: 50 })],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ openingQty: 50, openingValue: 5000, inQty: 0, outQty: 0, closingQty: 50, closingValue: 5000 })
  })

  it('purchase_in within range counts as in; sale_out counts as out', () => {
    const rows = computeStockLedgerReport({
      movements: [
        m({ movement_type: 'purchase_in', quantity: 100, unit_cost: 250, created_at: '2026-09-05T10:00:00Z' }),
        m({ movement_type: 'sale_out', quantity: 15, unit_cost: 250, created_at: '2026-09-10T10:00:00Z' }),
      ],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(rows[0]).toMatchObject({ openingQty: 0, inQty: 100, inValue: 25000, outQty: 15, outValue: 3750, closingQty: 85, closingValue: 21250 })
  })

  it('adjustment with a positive stored delta counts as in', () => {
    const rows = computeStockLedgerReport({
      movements: [m({ movement_type: 'adjustment', quantity: 1, unit_cost: 70000, created_at: '2026-09-05T10:00:00Z', inventory_item_id: 'item-fg' })],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'finished_goods', categoryId: null,
    })
    expect(rows[0]).toMatchObject({ inQty: 1, inValue: 70000, outQty: 0, closingQty: 1 })
  })

  it('adjustment with a negative stored delta counts as out', () => {
    const rows = computeStockLedgerReport({
      movements: [
        m({ movement_type: 'adjustment', quantity: 10, unit_cost: 100, created_at: '2026-08-01T10:00:00Z' }),
        m({ movement_type: 'adjustment', quantity: -3, unit_cost: 100, created_at: '2026-09-05T10:00:00Z' }),
      ],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(rows[0]).toMatchObject({ openingQty: 10, inQty: 0, outQty: 3, outValue: 300, closingQty: 7 })
  })

  it('itemKindFilter narrows to just finished_goods or just raw_material', () => {
    const movements = [
      m({ inventory_item_id: 'item-fg', movement_type: 'adjustment', quantity: 1, unit_cost: 70000, created_at: '2026-09-05T10:00:00Z' }),
      m({ inventory_item_id: 'item-rm', movement_type: 'purchase_in', quantity: 10, unit_cost: 100, created_at: '2026-09-05T10:00:00Z' }),
    ]
    const fgOnly = computeStockLedgerReport({ movements, items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'finished_goods', categoryId: null })
    expect(fgOnly.map(r => r.itemId)).toEqual(['item-fg'])
    const rmOnly = computeStockLedgerReport({ movements, items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'raw_material', categoryId: null })
    expect(rmOnly.map(r => r.itemId)).toEqual(['item-rm'])
  })

  it('categoryId narrows raw-material rows to one category', () => {
    const movements = [m({ inventory_item_id: 'item-rm', created_at: '2026-09-05T10:00:00Z' })]
    const matching = computeStockLedgerReport({ movements, items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: 'cat-glass' })
    expect(matching).toHaveLength(1)
    const nonMatching = computeStockLedgerReport({ movements, items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: 'cat-other' })
    expect(nonMatching).toHaveLength(0)
  })

  it('a movement after dateTo is excluded entirely (not opening, not in-range)', () => {
    const rows = computeStockLedgerReport({
      movements: [m({ created_at: '2026-10-05T10:00:00Z' })],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(rows).toHaveLength(0)
  })

  it('the movements list on each row carries reference (from notes) and direction', () => {
    const rows = computeStockLedgerReport({
      movements: [m({ movement_type: 'sale_out', quantity: 5, unit_cost: 100, created_at: '2026-09-05T10:00:00Z', notes: 'IN2609-001' })],
      items, dateFrom: '2026-09-01', dateTo: '2026-09-30', itemKindFilter: 'all', categoryId: null,
    })
    expect(rows[0].movements).toEqual([{ date: '2026-09-05T10:00:00Z', type: 'sale_out', reference: 'IN2609-001', qty: 5, unitCost: 100, value: 500, direction: 'out' }])
  })
})
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: FAIL — `computeStockLedgerReport is not a function` (or import error), rest of file still passing.

- [ ] **Step 3: Implement**

Add to `src/lib/inventoryCost.js`, after `computeFinishedGoodsDeductionPlan`'s closing `}`:

```js
/**
 * Builds one stock-card row per matching inventory item for the
 * statutory รายงานสินค้าและวัตถุดิบ (and its finished-goods-only /
 * raw-material-only variants) -- opening balance as of just before
 * dateFrom, qty/value in and out within [dateFrom, dateTo], and the
 * resulting closing balance. See
 * docs/superpowers/specs/2026-09-24-finished-goods-tax-stock-reports-design.md's
 * Report 1/2/3.
 *
 * Movement direction: purchase_in/transfer_in/sale_reversal are always
 * "in" (quantity stored positive); transfer_out/sale_out are always
 * "out" (quantity stored positive). 'adjustment' stores a SIGNED delta
 * (record_stock_movement computes p_quantity - old_qty) -- a positive
 * adjustment.quantity is "in", a negative one is "out".
 *
 * @param {object} params
 * @param {Array<{inventory_item_id: string, movement_type: string, quantity: number, unit_cost: number|null, created_at: string, notes: string|null}>} params.movements
 * @param {Array<{id: string, code: string|null, name: string, base_unit: string, item_kind: string, category_id: string|null}>} params.items
 * @param {string} params.dateFrom - 'YYYY-MM-DD', inclusive
 * @param {string} params.dateTo - 'YYYY-MM-DD', inclusive
 * @param {'all'|'finished_goods'|'raw_material'} params.itemKindFilter
 * @param {string|null} params.categoryId - filter to one category, or null for all
 * @returns {Array<{itemId: string, code: string, name: string, unit: string, openingQty: number, openingValue: number, inQty: number, inValue: number, outQty: number, outValue: number, closingQty: number, closingValue: number, movements: Array<{date: string, type: string, reference: string, qty: number, unitCost: number, value: number, direction: 'in'|'out'}>}>}
 */
export function computeStockLedgerReport({ movements, items, dateFrom, dateTo, itemKindFilter, categoryId }) {
  const dateFromMs = new Date(`${dateFrom}T00:00:00`).getTime()
  const dateToMs = new Date(`${dateTo}T23:59:59`).getTime()
  const itemsById = new Map((items || []).map(it => [it.id, it]))

  const matchesFilter = (item) => {
    if (!item) return false
    if (itemKindFilter !== 'all' && item.item_kind !== itemKindFilter) return false
    if (categoryId && item.category_id !== categoryId) return false
    return true
  }
  const direction = (m) => {
    if (m.movement_type === 'purchase_in' || m.movement_type === 'transfer_in' || m.movement_type === 'sale_reversal') return 'in'
    if (m.movement_type === 'transfer_out' || m.movement_type === 'sale_out') return 'out'
    return m.quantity >= 0 ? 'in' : 'out' // adjustment: signed delta
  }

  const rowsByItem = new Map()
  const getRow = (itemId) => {
    if (!rowsByItem.has(itemId)) {
      const item = itemsById.get(itemId)
      rowsByItem.set(itemId, {
        itemId, code: item?.code || '', name: item?.name || '', unit: item?.base_unit || '',
        openingQty: 0, openingValue: 0, inQty: 0, inValue: 0, outQty: 0, outValue: 0,
        closingQty: 0, closingValue: 0, movements: [],
      })
    }
    return rowsByItem.get(itemId)
  }

  for (const mv of movements || []) {
    const item = itemsById.get(mv.inventory_item_id)
    if (!matchesFilter(item)) continue
    const ts = new Date(mv.created_at).getTime()
    if (ts > dateToMs) continue

    const d = direction(mv)
    const magnitude = Math.abs(mv.quantity)
    const signedQty = d === 'in' ? magnitude : -magnitude
    const value = signedQty * (mv.unit_cost || 0)
    const row = getRow(mv.inventory_item_id)

    if (ts < dateFromMs) {
      row.openingQty += signedQty
      row.openingValue += value
    } else {
      if (d === 'in') { row.inQty += magnitude; row.inValue += magnitude * (mv.unit_cost || 0) }
      else { row.outQty += magnitude; row.outValue += magnitude * (mv.unit_cost || 0) }
      row.movements.push({ date: mv.created_at, type: mv.movement_type, reference: mv.notes || '', qty: magnitude, unitCost: mv.unit_cost || 0, value: magnitude * (mv.unit_cost || 0), direction: d })
    }
  }

  for (const row of rowsByItem.values()) {
    row.closingQty = row.openingQty + row.inQty - row.outQty
    row.closingValue = row.openingValue + row.inValue - row.outValue
  }

  return Array.from(rowsByItem.values()).sort((a, b) => a.code.localeCompare(b.code) || a.name.localeCompare(b.name))
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/inventoryCost.test.js`
Expected: PASS, entire file.

- [ ] **Step 5: Commit**

```bash
git add src/lib/inventoryCost.js src/lib/inventoryCost.test.js
git commit -m "feat: add computeStockLedgerReport for the statutory tax stock reports"
```

---

### Task 5: Tax stock reports UI

**Files:**
- Modify: `src/pages/Inventory.jsx` (add `computeStockLedgerReport` to the existing `../lib/inventoryCost.js` import; add a `tax_reports` entry to the `view` state's tab bar; add a new `TaxReportsView` component; render it when `view === 'tax_reports'`)

**Interfaces:**
- Consumes: `computeStockLedgerReport` from Task 4 (exact signature above); existing hooks `useStockMovements({ dateTo })`, `useAllInventoryItems()`, `useCategories()` (all already exist and need no changes — `useAllInventoryItems()`'s `select('*', ...)` already returns the new `item_kind`/`quotation_item_id` columns from Task 1); existing `SearchableSelect` component (`src/components/SearchableSelect.jsx`, already imported in this file) for the category filter, matching the pattern at `Inventory.jsx:768-769`.
- Produces: nothing consumed by later tasks (this is the last task).

- [ ] **Step 1: Add the tab button**

In `src/pages/Inventory.jsx`, find the tab-bar block that currently renders (around where `view === 'items'`/`'invoice_deduction'`/`'profiles'`/`'movements'` buttons live — the block containing `📦 รายการสินค้าคงคลัง`, `🧾 ตัดสต็อกจากใบแจ้งหนี้`, `📐 หน้าตัดอลูมิเนียม`, `📜 ประวัติการเคลื่อนไหว`). Add one more button in the same style:

```jsx
<button className={`btn btn-sm ${view === 'tax_reports' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('tax_reports')}>🧾 รายงานภาษี</button>
```

- [ ] **Step 2: Add the import**

Add `computeStockLedgerReport` to the existing named import from `../lib/inventoryCost.js` at the top of the file (same import statement Task 3 already extended with `computeFinishedGoodsDeductionPlan`).

- [ ] **Step 3: Add the `TaxReportsView` component**

Add this component in `src/pages/Inventory.jsx`, anywhere above the default-exported `Inventory` function (e.g. directly after `InvoiceDeductionRow`'s closing `}`):

```jsx
const TAX_REPORT_KINDS = [
  { key: 'finished_goods', label: '1. รายงานการตัดสินค้าสำเร็จรูป' },
  { key: 'raw_material', label: '2. รายงานตัดวัตถุดิบ' },
  { key: 'all', label: '3. รายงานสินค้าและวัตถุดิบ (รวม)' },
]

function fmtQty(n) { return (Math.round(n * 100) / 100).toLocaleString('th-TH') }

function TaxReportsView({ categories }) {
  const today = new Date().toISOString().slice(0, 10)
  const monthStart = today.slice(0, 8) + '01'
  const [reportKind, setReportKind] = useState('all')
  const [dateFrom, setDateFrom] = useState(monthStart)
  const [dateTo, setDateTo] = useState(today)
  const [categoryFilter, setCategoryFilter] = useState('')

  const { data: movements } = useStockMovements({ dateTo })
  const { data: allItems } = useAllInventoryItems()

  const rows = computeStockLedgerReport({
    movements: movements || [], items: allItems || [], dateFrom, dateTo,
    itemKindFilter: reportKind, categoryId: categoryFilter || null,
  })

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 14, flexWrap: 'wrap' }}>
        {TAX_REPORT_KINDS.map(k => (
          <button key={k.key} className={`btn btn-sm ${reportKind === k.key ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setReportKind(k.key)}>{k.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <label className="label">จาก <input className="input input-sm" type="date" value={dateFrom} onChange={e => setDateFrom(e.target.value)} /></label>
        <label className="label">ถึง <input className="input input-sm" type="date" value={dateTo} onChange={e => setDateTo(e.target.value)} /></label>
        {reportKind !== 'finished_goods' && (
          <div style={{ minWidth: 220, maxWidth: 260 }}>
            <SearchableSelect value={categoryFilter} onChange={setCategoryFilter} placeholder="ทุกหมวดหมู่"
              options={(categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))} />
          </div>
        )}
      </div>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>รหัส</th><th>รายการ</th><th>หน่วย</th>
              <th>ยกมา (จำนวน)</th><th>ยกมา (มูลค่า)</th>
              <th>รับเข้า (จำนวน)</th><th>รับเข้า (มูลค่า)</th>
              <th>จำหน่ายออก (จำนวน)</th><th>จำหน่ายออก (มูลค่า)</th>
              <th>คงเหลือ (จำนวน)</th><th>คงเหลือ (มูลค่า)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.itemId}>
                <td>{r.code}</td><td>{r.name}</td><td>{r.unit}</td>
                <td className="font-mono">{fmtQty(r.openingQty)}</td><td className="font-mono">{fmt(r.openingValue)}</td>
                <td className="font-mono">{fmtQty(r.inQty)}</td><td className="font-mono">{fmt(r.inValue)}</td>
                <td className="font-mono">{fmtQty(r.outQty)}</td><td className="font-mono">{fmt(r.outValue)}</td>
                <td className="font-mono">{fmtQty(r.closingQty)}</td><td className="font-mono">{fmt(r.closingValue)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ไม่มีข้อมูลในช่วงเวลาที่เลือก</td></tr>}
          </tbody>
        </table>
      </div>
    </div>
  )
}
```

(`fmt` is the existing baht-formatting helper already in scope throughout `Inventory.jsx` — do not redefine it.)

- [ ] **Step 4: Render it**

Find the default-exported `Inventory` function's `{view === 'movements' && ( ... )}` block and add, immediately after its closing `)}`:

```jsx
{view === 'tax_reports' && <TaxReportsView categories={categories} />}
```

(`categories` is already available in that scope from the existing `useCategories()` call `Inventory.jsx` already makes for the other views — reuse it, do not add a second `useCategories()` call.)

- [ ] **Step 5: Run the full test suite**

Run: `npx vitest run`
Expected: PASS, all existing + new tests (213+ tests from before this plan, plus the ones added in Tasks 2 and 4).

- [ ] **Step 6: Manual verification**

Run `npm run dev`, log in, open คลังสินค้า → 🧾 รายงานภาษี. Confirm: three report-kind buttons switch the table; date filters narrow rows; category filter (hidden for report 1, shown for 2/3) narrows raw-material rows; if Task 3's disposable test data is still present at verification time use it, otherwise use any real historical movement to sanity-check the opening/closing arithmetic reconciles (`closingQty === openingQty + inQty - outQty` for at least one row, spot-checked by hand against the table).

- [ ] **Step 7: Commit**

```bash
git add src/pages/Inventory.jsx
git commit -m "feat: add รายงานภาษี stock reports (finished-goods, raw-material, combined)"
```
