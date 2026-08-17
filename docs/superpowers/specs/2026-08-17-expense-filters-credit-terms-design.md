# Expense Filters, Billing-Date Credit Terms & Supplier-Gated Payment Methods — Design

## Problem

The Expenses page (`src/pages/Expenses.jsx`) can only be filtered by site,
category, status, and a date range that's hardcoded to the order date
(`expenses.date`). There's no way to filter by supplier or by when a
cheque/credit payment is actually due, even though the underlying data
supports it. A `supplierId` filter was already wired into `useExpenses`
but never got a UI control.

Separately, two real bugs/gaps surfaced while designing the filter:

1. **Credit-term lookup bug.** `ExpenseForm` computes the days used to
   auto-calculate a due date from `selectedSupplier?.payment_terms` — a
   legacy free-text field the schema comment explicitly marks as "not
   used for propagation." The actual source of truth is
   `suppliers.credit_days` (nullable int; `null` = cash/immediate). This
   means the auto-calc has silently never worked for any supplier.
2. **No connection between a supplier's configured payment terms and
   what the expense form lets you pick.** Today every expense's payment
   method dropdown always shows all four options (`transfer`/`check`/
   `cash`/`credit`) regardless of whether the selected supplier actually
   has credit terms — so a cash-only supplier can still be entered with
   a cheque, which doesn't correspond to any real agreement with that
   supplier.
3. **`billing_date` (วันวางบิล) is only usable for `payment_method =
   'credit'`.** In practice, cheque payments are just as often on credit
   terms as the generic "credit" method — a cheque's due date should
   also be computable from `billing_date + credit_days`, but the form
   never shows `billing_date` for `check`.

## Goal

- Add Supplier, Status, and date-type-aware date-range filters to the
  Expenses list.
- Fix the credit-term lookup to read `credit_days`.
- Gate the payment-method dropdown by the selected supplier's configured
  terms.
- Extend the billing-date → due-date auto-calc to cheque payments.
- Add a new status, `awaiting_billing`, for expenses on credit/cheque
  terms that haven't been billed yet.

## Background / decisions already made

- **"วันโอน" (transfer date) is not a new column.** For cash/transfer
  expenses, payment happens same-day as `date`, so filtering by "transfer
  date" is the same as filtering by `date`. For credit/cheque expenses,
  the practical payment date *is* the due date (`due_date` or
  `check_date`). So "filter by transfer date" and "filter by due date"
  collapse into the same filter option — no new date column needed.
- **Payment-method gating rule:** when a supplier is selected and its
  `credit_days` is `null` (cash-like), hide both `check` and `credit`
  from the payment-method dropdown — neither corresponds to an agreement
  that supplier actually has. When no supplier is selected yet, show all
  four options unrestricted (nothing to gate against). When the selected
  supplier does have `credit_days` set, show all four.
- **`awaiting_billing` is manual, not automated.** It's a status the user
  sets themselves for a credit/cheque expense before the supplier has
  sent a bill (so there's no `billing_date`/due date yet). Filling in
  `billing_date` does not auto-transition the status — the user changes
  it to `pending`/`check_issued` themselves, same as any other status
  change today (via the existing toggle-status dialog).
- **`check_date` and `due_date` keep their existing separate meanings.**
  Rather than merging them into one column, the billing-date auto-calc
  is generalized to target whichever field matches the payment method
  (`check_date` for `check`, `due_date` for `credit`). This avoids a
  schema change and keeps `check_date`'s existing display column
  (already shown in the Expenses table) working unmodified.

## Data Model

**Migration 1 — widen `expenses.status` CHECK constraint:**

```sql
ALTER TABLE expenses DROP CONSTRAINT expenses_status_check;
ALTER TABLE expenses ADD CONSTRAINT expenses_status_check
  CHECK (status IN ('awaiting_billing','paid','pending','check_issued','check_cleared'));
```

No default-value change — `EMPTY_FORM.status` stays `'pending'`; the user
picks `awaiting_billing` explicitly when it applies.

No other schema changes. `suppliers.credit_days` and
`expenses.billing_date`/`check_date`/`due_date` already exist.

## Form Changes (`ExpenseForm` in `Expenses.jsx`)

**Credit-term lookup fix:**

```js
const creditTermDays = selectedSupplier?.credit_days ?? null
```

replacing the current `parseInt(selectedSupplier?.payment_terms, 10)`
logic.

**Payment-method options, gated by supplier:**

```js
const supplierHasCredit = !selectedSupplier || selectedSupplier.credit_days != null
const methodOptions = supplierHasCredit
  ? ['transfer', 'check', 'cash', 'credit']
  : ['transfer', 'cash']
```

The `<select>` renders only `methodOptions`. If `form.payment_method` is
no longer in `methodOptions` after a supplier change (e.g. switching from
a credit supplier to a cash-only one while `check` was selected), reset
it to `'transfer'` in the same `onChange` that updates `supplier_id`.

**`billing_date` shown for both `check` and `credit`:**

```js
{(form.payment_method === 'check' || form.payment_method === 'credit') && (
  // existing billing_date + due_date block
)}
```

**Generalized auto-calc target field:**

```js
const setBillingDate = (val) => {
  setForm(f => {
    const next = { ...f, billing_date: val }
    const targetField = f.payment_method === 'check' ? 'check_date' : 'due_date'
    if (!f[targetField] && val && creditTermDays != null) {
      const d = new Date(val)
      d.setDate(d.getDate() + creditTermDays)
      next[targetField] = d.toISOString().slice(0, 10)
    }
    return next
  })
}
```

For `check`, the existing separate "วันที่เช็ค / Due date" input becomes
the auto-calc target (still user-editable, same as `due_date` is today
for `credit`) instead of being manually entered from scratch.

**Status list:**

```js
const STATUSES = ['awaiting_billing', 'pending', 'check_issued', 'check_cleared', 'paid']
const STATUS_LABELS = {
  awaiting_billing: '🧾 รอวางบิล',
  pending: '⏳ ค้างจ่าย',
  check_issued: '📄 ออกเช็ค',
  check_cleared: '🏦 เช็คผ่าน',
  paid: '✅ จ่ายแล้ว',
}
```

New CSS rule (both places `.badge-pending` etc. are defined in
`src/index.css`):

```css
.badge-awaiting_billing { background: rgba(255,209,102,0.1); color: var(--yellow); }
```

## Filter Row (`Expenses.jsx`)

Add, alongside the existing site/category/status dropdowns:

- **Supplier filter** — `SearchableSelect` using the existing
  `supplierOpts(suppliers)` helper, bound to the `supplierId` state
  already declared and already passed into `filters`. This is purely a
  UI addition; the data-layer wiring is already in place (uncommitted).
- **Date-type selector** — a small `<select>` next to the existing
  From/To date inputs:

  ```js
  const DATE_FIELDS = [
    { key: 'date',         label: 'วันที่สั่งซื้อ' },
    { key: 'billing_date', label: 'วันวางบิล' },
    { key: 'due',          label: 'วันครบกำหนด / วันโอน' },
  ]
  ```

  `due` is a virtual key, not a literal column — see below.

- **Status filter** picks up `awaiting_billing` automatically since it
  renders off the shared `STATUSES` array; no separate change needed.

## Data Layer (`useExpenses` in `useSupabase.js`)

Replace the hardcoded `filters.from`/`filters.to` → `date` column
mapping with a `dateField` parameter:

```js
export function useExpenses(filters = {}) {
  return useQuery(async () => {
    let q = supabase.from('expenses_view').select('*').order('date', { ascending: false })

    if (filters.siteId)     q = q.eq('site_id', filters.siteId)
    if (filters.categoryId) q = q.eq('category_id', filters.categoryId)
    if (filters.supplierId) q = q.eq('supplier_id', filters.supplierId)
    if (filters.status)     q = q.eq('status', filters.status)
    if (filters.search)     q = q.ilike('description', `%${filters.search}%`)

    const field = filters.dateField || 'date'
    if (field === 'due') {
      // due_date OR check_date, whichever the row has populated
      if (filters.from) q = q.or(`due_date.gte.${filters.from},check_date.gte.${filters.from}`)
      if (filters.to)   q = q.or(`due_date.lte.${filters.to},check_date.lte.${filters.to}`)
    } else {
      if (filters.from) q = q.gte(field, filters.from)
      if (filters.to)   q = q.lte(field, filters.to)
    }

    const { data, error } = await q
    if (error) throw error
    return data
  }, [JSON.stringify(filters)])
}
```

Note: chaining two `.or()` calls for the `due` case combines them with
AND (Supabase/PostgREST ANDs separate filter calls), giving "due date in
range OR check date in range, both bounded" — acceptable since a row only
ever has one of the two populated in practice (`check_date` for `check`,
`due_date` for `credit`).

`Expenses.jsx` passes `dateField` (from the new selector's state) into
`filters` alongside the existing keys.

## Out of Scope

- A distinct "transfer date" column — folded into the due-date filter
  per the decision above.
- Auto-transitioning `awaiting_billing` → `pending` when `billing_date`
  is filled in — stays manual.
- Retroactively fixing historical rows that have `payment_method =
  'check'` with no `billing_date` — existing data is left as-is; the
  billing-date field is simply now available going forward.
- Changing `suppliers.default_payment_method`/`credit_days` UI — that
  form (`Suppliers.jsx`) already models this correctly and needs no
  changes.

## Testing

No automated test suite for the frontend in this project; verification
plan:

1. `execute_sql`: confirm the widened `status` CHECK constraint accepts
   `'awaiting_billing'` and still rejects invalid values.
2. Manual click-through in the dev server:
   - Add an expense with a cash-only supplier selected → confirm `check`
     and `credit` are absent from the payment-method dropdown.
   - Add an expense with a credit-terms supplier, `payment_method =
     check`, fill `billing_date` → confirm `check_date` auto-fills using
     that supplier's `credit_days`.
   - Switch the same form's supplier to a cash-only one → confirm
     `payment_method` resets off `check`.
   - Set an expense's status to `awaiting_billing` via the toggle-status
     dialog → confirm it displays with the new badge and label.
   - Filter the list by Supplier → confirm only that supplier's expenses
     show.
   - Filter by date range with "วันครบกำหนด / วันโอน" selected → confirm
     it matches on `due_date` for credit rows and `check_date` for
     cheque rows.
