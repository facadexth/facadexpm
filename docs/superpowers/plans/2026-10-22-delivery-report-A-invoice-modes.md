# Delivery Report — Plan A: Invoice Modes + Line Checks

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add the "ตามความคืบหน้า" invoice mode (bills card progress × BOQ phase weight), make easy mode quantity-only with whole numbers for count units, lock one mode per invoice, and flag mismatched lines against BOQ + cards.

**Architecture:** A pure library (`src/lib/progressBilling.js`) holds every rule (unit kind, phase weights, delivered-before, line checks). A hook loads BOQ items, phase splits, card progress and earlier phase draws for one site + quotation. `Invoices.jsx` gains a `ProgressBillingEditor` and saves progress lines as one `invoice_items` row per (quotation item × phase group) plus `invoice_item_phases` rows; it still advances `quotation_item_units` through the existing waterfall so mixed-mode quotations stay consistent in value.

**Tech Stack:** React 18, Supabase (Postgres + RLS), vitest.

**Spec:** `docs/superpowers/specs/2026-10-22-delivery-report-design.md` (Plan B = the DR report, card picker, plan markup, signing — separate plan, written after A ships).

## Global Constraints

- Weight is always a % of price: line value = qty × unit price × Σ weight of the phases delivered.
- Easy mode has no % input. Count units (`ชุด`, `งาน`, `ชิ้น`, `ตัว`, `บาน`, `จุด`, `เครื่อง`, `อัน`, `แผ่น`, `ต้น`) accept whole numbers only; every other unit, and a missing unit, accepts decimals. Unit = BOQ item unit, falling back to the quotation item unit.
- One invoice = one mode: `invoices.billing_mode` ∈ `'easy' | 'advanced' | 'progress'`, set at insert, never updated. Existing rows stay NULL (legacy).
- A unit price equal to `round2(boqPrice × discountMultiplier(quotation))` counts as matching (quotation discount, e.g. IN2610-003 at 0.9114).
- Rule "qty = BOQ qty × %": warn **always**, even when the amount is the same.
- Progress mode blocks save while any selected line's card has no quantity (`progress_mode = 'status'` or `planned_qty` null) — show "กรอกในการ์ด →".
- Cards without BOQ are weight 0 and never produce invoice lines.
- Migrations: write to `supabase/migrations/2026-10-22-02-invoice-progress-mode.sql`; implementers never run SQL against the database — the controller dry-runs it (BEGIN…ROLLBACK) and applies it.
- Thai UI copy; dates dd/mm/yyyy พ.ศ. via existing helpers; money via `fmt`.
- Bump `package.json` + `src/changelog.json` to `1.31.0`; update `public/manual/index.html` invoice section.

## Review Focus

1. A quotation with a discount: progress-mode unit price must use the discounted price, and the check must call it a match (not ⚠️).
2. A BOQ item whose splits don't total 100 (or have no splits): treat Σweight from what exists; never divide by zero; line shows ⚠️ "ยังไม่ได้ตั้ง weight".
3. Second progress invoice for the same phase: delivered-before must subtract earlier `invoice_item_phases.qty`, and a qty above what the cards show as done must be refused.
4. A quotation billed partly in easy mode then in progress mode: remaining value (`openQty × price`) must never go negative; progress amount is capped at the item's remaining value.
5. Void invoice: its `invoice_item_phases` rows must not count as delivered-before.

---

### Task 1: Migration — billing mode + phase draws

**Files:**
- Create: `supabase/migrations/2026-10-22-02-invoice-progress-mode.sql`

**Interfaces:**
- Produces: `invoices.billing_mode text NULL CHECK (billing_mode IN ('easy','advanced','progress'))`; table `invoice_item_phases(id uuid pk default gen_random_uuid(), tenant_id uuid not null default current_tenant_id() references tenants on delete cascade, invoice_item_id uuid not null references invoice_items on delete cascade, boq_item_id uuid not null references boq_items, phase_id uuid not null references site_phases, qty numeric not null check (qty > 0), weight_pct numeric not null check (weight_pct >= 0 and weight_pct <= 100), amount numeric not null, created_at timestamptz default now())`, index on `(boq_item_id, phase_id)`.

- [ ] **Step 1:** Write the migration. RLS: enable, one policy `admin_full_access` FOR ALL copying `invoice_items`' expression exactly: `(SELECT is_admin_or_owner()) AND tenant_id = (SELECT current_tenant_id()) AND (SELECT has_module_access('invoices'))` for both USING and WITH CHECK. Revoke from anon. Header comment states purpose and that existing invoices keep NULL mode.
- [ ] **Step 2:** Add a commented dry-run block at the end of the file (BEGIN; insert one invoice_item_phases row against a real SOAP OPERA invoice_item + boq_item + phase via subselects; SELECT it back; ROLLBACK) for the controller to run.
- [ ] **Step 3: Commit** `git commit -m "feat(db): invoice billing mode + invoice_item_phases"`

### Task 2: Pure rules library

**Files:**
- Create: `src/lib/progressBilling.js`
- Test: `src/lib/progressBilling.test.js`

**Interfaces:**
- Produces:
  - `isCountUnit(unit: string|null) -> boolean`
  - `phaseWeight(splits: {phase_id, pct}[], phaseIds: string[]) -> number` (Σ pct of the chosen phases, 0 when none)
  - `deliveredBefore(phaseDraws: {boq_item_id, phase_id, qty, invoice_status}[], boqItemId, phaseId) -> number` (ignores `invoice_status === 'void'`)
  - `doneQty(cards: {boq_item_id, phase_id, done_qty, progress_mode, planned_qty}[], boqItemId, phaseId) -> number | null` (null when any matching card has `progress_mode !== 'quantity'` or null `planned_qty`)
  - `progressLineAmount({ qty, unitPrice, weightPct }) -> number` (`round2(qty * unitPrice * weightPct / 100)`)
  - `checkLine({ unit, qty, unitPrice, boqQty, boqUnitPrice, priceMultiplier, billedPct, phaseWeightPct, cardDoneQty }) -> { level: 'ok'|'warn'|'block', reasons: string[] }`

- [ ] **Step 1: Write failing tests** with these exact cases:

```js
expect(isCountUnit('ชุด')).toBe(true); expect(isCountUnit('ตร.ม.')).toBe(false); expect(isCountUnit(null)).toBe(false)
expect(phaseWeight([{phase_id:'p',pct:20},{phase_id:'i',pct:60}], ['p','i'])).toBe(80)
expect(progressLineAmount({ qty: 20, unitPrice: 3554.46, weightPct: 20 })).toBe(14217.84)
// composite billed as % of quantity (real IN2610-003)
expect(checkLine({ unit:'ตร.ม.', qty:20.8, unitPrice:3554.46, boqQty:26, boqUnitPrice:3900, priceMultiplier:0.91140, billedPct:100, phaseWeightPct:80, cardDoneQty:26 }))
  .toEqual({ level:'warn', reasons:['qty_is_pct_of_boq'] })
// discount counts as match
expect(checkLine({ unit:'ชุด', qty:1, unitPrice:21509.04, boqQty:1, boqUnitPrice:23600, priceMultiplier:0.91140, billedPct:80, phaseWeightPct:80, cardDoneQty:1 }).level).toBe('ok')
// รื้อถอน billed 80% but weight 100
expect(checkLine({ unit:'งาน', qty:1, unitPrice:16000, boqQty:1, boqUnitPrice:16000, priceMultiplier:1, billedPct:80, phaseWeightPct:100, cardDoneQty:1 }).reasons).toContain('weight_mismatch')
// fractional set
expect(checkLine({ unit:'ชุด', qty:0.8, unitPrice:41000, boqQty:1, boqUnitPrice:41000, priceMultiplier:1, billedPct:100, phaseWeightPct:80, cardDoneQty:1 }).level).toBe('block')
// card without quantity
expect(checkLine({ unit:'ชุด', qty:1, unitPrice:16405.2, boqQty:1, boqUnitPrice:18000, priceMultiplier:0.9114, billedPct:80, phaseWeightPct:80, cardDoneQty:null }).reasons).toEqual(['card_no_qty'])
expect(deliveredBefore([{boq_item_id:'b',phase_id:'p',qty:8,invoice_status:'paid'},{boq_item_id:'b',phase_id:'p',qty:5,invoice_status:'void'}],'b','p')).toBe(8)
```

Reason codes (exact): `qty_is_pct_of_boq`, `weight_mismatch`, `price_mismatch`, `qty_not_card`, `fraction_count_unit` (block), `card_no_qty` (block), `no_weight` (warn when phaseWeightPct is 0 for a BOQ line). Price matches when `|unitPrice − round2(boqUnitPrice × priceMultiplier)| ≤ 0.01`. `qty_is_pct_of_boq` when `qty ≠ cardDoneQty` and `|qty − boqQty × phaseWeightPct/100| ≤ 0.001`; it replaces `qty_not_card` for that line.

- [ ] **Step 2:** `npx vitest run src/lib/progressBilling.test.js` → FAIL (module missing).
- [ ] **Step 3:** Implement the six exports in `src/lib/progressBilling.js` (import `round2` from `./depositCalc.js`).
- [ ] **Step 4:** Run the test again → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(invoices): progress billing rules library"`

### Task 3: Data hook

**Files:**
- Create: `src/hooks/useProgressBillingData.js`
- Test: `src/hooks/useProgressBillingData.test.js` (mock supabase the way `src/pages/sites/BoqPhaseSplitSection.test.jsx` does)

**Interfaces:**
- Consumes: `fetchBoqPhaseSplits(boqItemIds)` from `src/pages/sites/useBoqPhaseSplits.js`.
- Produces: `useProgressBillingData(siteId, quotationId) -> { data: { boqByQuotationItem: Record<qiId, {id, unit, planned_qty, code}>, splitsByBoq: Record<boqId, {phase_id, pct}[]>, phases: {id, name, sort_order}[], cards: {boq_item_id, phase_id, done_qty, planned_qty, progress_mode, name}[], phaseDraws: {boq_item_id, phase_id, qty, invoice_status}[] } | null, loading, error }`. Phases exclude `is_issue_phase`. `phaseDraws` joins `invoice_item_phases → invoice_items → invoices(status)`.

- [ ] **Step 1:** Test: given mocked rows for 1 BOQ item, 2 phases, 1 card, 1 void + 1 paid draw, the hook returns the shape above with both draws carrying `invoice_status`.
- [ ] **Step 2:** Run → FAIL. **Step 3:** Implement with the project's `useQuery` helper. **Step 4:** Run → PASS.
- [ ] **Step 5: Commit** `git commit -m "feat(invoices): load BOQ, splits, cards and phase draws for progress billing"`

### Task 4: Easy mode — quantity only, whole numbers for count units, warnings

**Files:**
- Modify: `src/pages/Invoices.jsx` (`InvoiceItemsEditor`, ~lines 89–300; `CreateInvoiceModal`, ~303–580)
- Test: `src/pages/Invoices.easyMode.test.jsx`

**Interfaces:**
- Consumes: `isCountUnit`, `checkLine` (Task 2); `useProgressBillingData` (Task 3) only to read the BOQ unit/price and show icons.

- [ ] **Step 1: Failing tests:** in easy mode (a) the per-line amount `<input>` is gone and the amount renders as text; (b) typing `0.8` into a `ชุด` line shows "งานชุดต้องเป็นจำนวนเต็ม" and the save button is disabled; (c) `12.5` on a `ตร.ม.` line is accepted; (d) a `ตร.ม.` line with qty 20.8 of 26 and a site BOQ shows the ⚠️ icon with title "ปริมาณเท่ากับ 26 × 80% อาจใช้ % ของปริมาณ".
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. "กรอกยอดที่ต้องการเรียกเก็บ" (`applyTargetFill`) now switches to `'advanced'` instead of `'easy'` (it produces fractional draws). The ✅/⚠️/⛔ icon is a small `<span title=…>` at the end of each line, only when the site has BOQ rows.
- [ ] **Step 4:** Run → PASS; run `npx vitest run src/pages` → no regressions.
- [ ] **Step 5: Commit** `git commit -m "feat(invoices): easy mode bills whole units for sets, no %"`

### Task 5: Progress mode editor + save + mode lock

**Files:**
- Create: `src/pages/invoices/ProgressBillingEditor.jsx`
- Modify: `src/pages/Invoices.jsx` (mode buttons, `handleSave`, invoice detail header)
- Test: `src/pages/invoices/ProgressBillingEditor.test.jsx`

**Interfaces:**
- Consumes: Tasks 2–3; existing `waterfall`, `openQty`, `discountMultiplier`, `round2`.
- Produces: `<ProgressBillingEditor lines data priceMultiplier value onChange />` where `value = { phaseIds: string[], rows: Record<qiId, { phaseIds: string[], qty: number }> }` and an exported pure `buildProgressInvoiceRows(lines, data, value, priceMultiplier) -> { items: {quotationItemId, description, unit, unitPrice, drawQty, lineTotal, phases: {boq_item_id, phase_id, qty, weight_pct, amount}[]}[], blocked: boolean }`.

- [ ] **Step 1: Failing tests** for `buildProgressInvoiceRows` with SOAP OPERA numbers: AD1 (price 41000, ผลิต 40 + ติดตั้ง 40, done 1) → `lineTotal 32800`, `unitPrice 32800` (price × 80%), description `"AD1 (ผลิต + ติดตั้ง 80%)"`, `drawQty 1`; composite ผลิต only qty 20 → `lineTotal 14217.84`; a line whose card has no qty → `blocked: true`; amount capped at `openQty(units) × unitPrice`. Editor test: header phase chips set every row; a row's chips override; the ⛔ row shows a "กรอกในการ์ด →" button.
- [ ] **Step 2:** Run → FAIL.
- [ ] **Step 3:** Implement. Third mode button "ตามความคืบหน้า" shows only when the site has BOQ rows. Mode buttons are hidden once the modal has a saved invoice (the modal only creates). `handleSave` in progress mode: insert `invoices` with `billing_mode: 'progress'`; per item insert `invoice_items` (unit_price = price × Σweight/100, draw_qty = qty, line_total), then `invoice_item_phases` rows, then advance `quotation_item_units` via `waterfall(l.units, lineTotal / l.unitPrice)` and the existing `invoice_item_draws` loop. Easy/advanced inserts now also send `billing_mode`. Invoice detail shows a small badge "โหมด: ง่าย / ละเอียด / ตามความคืบหน้า" (nothing for NULL).
- [ ] **Step 4:** Run → PASS; `npx vitest run` whole suite → all green.
- [ ] **Step 5: Commit** `git commit -m "feat(invoices): progress-mode billing from Kanban cards"`

### Task 6: Release notes, manual, version

**Files:**
- Modify: `package.json`, `src/changelog.json`, `public/manual/index.html`

- [ ] **Step 1:** `package.json` → `1.31.0`; changelog entry dated 2026-10-22 with three Thai notes (progress mode; easy mode whole units, no %; warning icons + one mode per invoice).
- [ ] **Step 2:** Manual invoice section: describe the three modes, the formula ปริมาณ × ราคา × weight, whole-number rule, icons ✅ ⚠️ ⛔, and "1 ใบ 1 โหมด". Bump the manual version label to 1.31.0.
- [ ] **Step 3:** `npx vitest run` → green; `npm run build` → succeeds.
- [ ] **Step 4: Commit** `git commit -m "docs: 1.31.0 invoice modes"`
