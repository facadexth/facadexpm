# Tax invoice page harness

Headless-Chromium check of `src/pages/SupplierTaxInvoices.jsx` with mocked hooks and supabase, the REAL `src/index.css`,
and all network blocked. No live database is touched. It covers notReady, empty/mixed lists, draft edit, preview
(blocking / warnings), stale-preview guard, confirm overlay, post success/failure, view, void, delete, the layout
(post button and preview reachable at 1280x800 with 1 and 8 lines and at 375x740) and the back-button/history behaviour.

Run from the repo root (uses the repo's existing `esbuild` and `playwright`; add no dependencies):

    node scripts/tax-invoice-harness/build.mjs   # bundles into <tmpdir>/tax-invoice-harness-out.js
    node scripts/tax-invoice-harness/run.mjs     # prints PASS/FAIL lines, ends with ALL PASS, exit code 1 on failure

Run it alone: parallel runs make the Playwright waits slow. Mocks: `mockHooks.js` (hooks + RPC wrappers, `window.__rpc`,
`window.__rpcDelay`), `mockSupabaseLib.js`, `useRoleMock.js` (`window.__role`), `MockQuickAdd.jsx`.

## PO page scenarios

`buildPo.mjs` / `runPo.mjs` (same rules, run alone) check `src/pages/PurchaseOrders.jsx` with `mockPoHooks.js` (links `null` = migrations not applied,
or a Map), `mockPoSupabaseLib.js` (logs writes/rpc in `window.__log`, `window.__rpcError` injects a record_stock_movement error) and `mockTenant.js`:

    node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs

Section 7: row layout (📄 + ⋯), popup ledger, document actions, money locks; mocks `__money` (`receivedItemIds`, `receiptIds`, `depositId`), `__ledger`. 7b: old receive stays reachable, multi-bill swap lock, discount-line notice, `refreshPoData`, phone width (menu not clipped, popup scrolls).
Sections 3-5 and 9/9b drive the new receive dialog (`ReceivePoLinesModal`, wrapper `receive_po_lines` logged with its args,
`__wrapperError` / `__wrapperDelay`): all / some lines, received date, deposit deduction and bill preview, receive-the-rest,
errors kept inside the open dialog, double click = one call, 375 px. `__moneySchema = false` simulates the pre-migration
index (empty, `schemaReady` false) that routes ordered POs to the old receive.

## Expenses page scenarios

`buildExp.mjs` / `runExp.mjs` (same rules, run alone) check `src/pages/Expenses.jsx` with `mockExpHooks.js` (+ the PO harness's supabase lib and tenant/role mocks):

    node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs

Mocks: `__exp` (expense rows, `expenses_view` shape; the mocked `splitPayment` updates it so the refetch shows the result), `__cnIds` (credit-note expense ids),
`__depMap` (`[[expenseId, depositInfo]]`), `__splitReady = false` (pre-migration: จ่ายบางส่วน hidden), `__wrapperError` / `__wrapperDelay` (RPC wrapper
failure / latency; calls logged in `__log`). Scenarios: which bills offer / disable the action, dialog maths and guards, double click = one call,
refetch after success, Thai error keeps the dialog open, pre-migration hide, 375 px.
