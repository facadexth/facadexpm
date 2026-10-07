# PO deposit deduction (หักมัดจำ) — owner handoff (2026-10-07)

Branch `feat/po-deposit-deduction`, built on top of the credit-note work. The credit-note migrations (2026-10-06-01/-02/-03) are already in main and live, so nothing from that branch needs applying first. Nothing from THIS branch is merged, pushed, applied or deployed. Final checks: `npx vitest run` 713/713, `npm run build` OK.

## What shipped (สิ่งที่ทำเสร็จ)
- **Register a deposit:** on the Expenses page a supplier expense with a VAT split can be registered as a deposit (มัดจำ) with its own deposit invoice number. Registered deposits show a badge (used / remaining) and are locked once applied to a PO.
- **Deduct on receive:** when you receive a PO, the dialog lists that supplier's open deposits. Tick a deposit, give the ex-VAT amount, see the preview "รายจ่ายใหม่: ก่อน VAT X · VAT Y" or "ไม่สร้างรายจ่าย (หักครบ)". Confirm calls the new RPC `receive_po_with_deposits`, which atomically creates the remainder expense (none if the deposits cover everything), records the applications and marks the PO received. Stock posting and audit log rows stay on the client, after the RPC.
- **PO detail** lists the deposits applied ("หักมัดจำ {no}: ก่อน VAT X · VAT Y").
- **Document scan** reads a printed deposit deduction line (e.g. "Deduct Down Payment AI6901007 41,004.00") into `deposit_deductions`; it is saved as `purchase_orders.deposit_hint` and pre-ticks the matching registered deposit in the receive dialog. Only when the line is explicitly printed; never inferred.
- Server-side VAT is the authority: the preview can differ by one satang on exact .5 ties.

## REQUIRED ORDER of release (ลำดับที่ต้องทำ)
Migrations go live the moment they are applied. **The web app must NOT be deployed before the migrations: every PO receive now calls `receive_po_with_deposits`, so receiving any PO would fail until both migrations exist.**
0. Dry run in ONE transaction (migration 01 + migration 02 + `supabase/tests/po_deposit_test.sql`, nothing is kept). Continue only when it returns the single row "ALL PO DEPOSIT TESTS PASSED" and no error. Commands below.
1. Apply `supabase/migrations/2026-10-07-01-supplier-deposits.sql` (wrapped in BEGIN/COMMIT).
2. Apply `supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql` (wrapped in BEGIN/COMMIT), then `NOTIFY pgrst, 'reload schema';`.
3. Deploy the edge function: `npx supabase functions deploy extract-po-document --project-ref kntspldhvcjeaubtqtkn --use-api` (shared files `scan-logic.ts` and `po-extract-prompt.ts` changed; prompt version `2026-10-07-v4`, so cached scans are not reused).
4. Deploy the web app: `npm run deploy`.

### Dry run: ONE transaction, then the real apply
Run everything from the MAIN checkout `/Users/plfx/code/FacadeXPM/facadex-app` (it is the one linked to the Supabase project; the worktree is not), with absolute paths to the files. Run at a quiet time: the migrations briefly lock `purchase_orders` and `expenses`; `lock_timeout` makes them fail fast instead of queueing behind other traffic. File 01 is NOT re-runnable (plain CREATE TABLE / CREATE POLICY), so never "just run it again".

Set once: `W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/po-deposit-deduction` and `cd /Users/plfx/code/FacadeXPM/facadex-app`.

Build the combined dry-run file with a plain redirect and check it is not empty (a failed `cat` must not be hidden):
```
(printf 'BEGIN;\nSET LOCAL lock_timeout = '"'"'5s'"'"';\n'; cat "$W/supabase/migrations/2026-10-07-01-supplier-deposits.sql" "$W/supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql" "$W/supabase/tests/po_deposit_test.sql") > /tmp/dry.sql
test -s /tmp/dry.sql || { echo "dry-run file is empty"; exit 1; }
npx supabase db query --linked -f /tmp/dry.sql
```
The test file begins with its own BEGIN (a harmless "already a transaction" warning) and ends with ROLLBACK, so nothing is kept; its last statement is `SELECT 'ALL PO DEPOSIT TESTS PASSED' AS result;`. **Success = exactly that one result row and no error.** (`db query` does not show NOTICE lines and stops at the first error.) A failure comes back as an HTTP 400 containing `Test N FAIL ...`. The test file has never run: if a fixture insert fails, fix the test, not the migration, and re-run the whole dry run.

Only after that, apply for real, each migration in its own explicit transaction (build each file first and check it, then run it):
```
(printf 'BEGIN;\nSET LOCAL lock_timeout = '"'"'5s'"'"';\n'; cat "$W/supabase/migrations/2026-10-07-01-supplier-deposits.sql"; printf '\nCOMMIT;\n') > /tmp/m01.sql
test -s /tmp/m01.sql && npx supabase db query --linked -f /tmp/m01.sql
(printf 'BEGIN;\nSET LOCAL lock_timeout = '"'"'5s'"'"';\n'; cat "$W/supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql"; printf '\nCOMMIT;\n') > /tmp/m02.sql
test -s /tmp/m02.sql && npx supabase db query --linked -f /tmp/m02.sql
```
Right after applying, refresh the API schema cache so the new tables are visible to the web app:
```
npx supabase db query --linked "NOTIFY pgrst, 'reload schema';"
```
The SQL test runs inside the dry run (step 0); after the real apply there is nothing more to run.

### Do NOT use the Expenses "un-receive" path on a PO that deducted a deposit
Deleting the remainder expense of a received PO normally offers "กลับไปเป็นยังไม่รับของ" / cancel. For a PO that deducted deposits that would leave the deposit applications behind. The server now refuses it (`po_has_deposit_applications`, trigger on `purchase_orders`) and the Expenses page shows "ใบสั่งซื้อนี้หักมัดจำแล้ว ย้อนไม่ได้จากหน้านี้ — แจ้งผู้ดูแลระบบ" instead of the options. If a deposit PO really must be reversed, a database administrator has to remove the applications by hand first.

## Register the CAC deposit AI6901007 by hand
The deposit's invoice number (`AI6901007`) differs from its expense's `invoice_no` (`IV68071902`). The register dialog now starts EMPTY on purpose, so type the deposit number yourself:
1. Expenses page, find the CAC deposit expense (supplier CAC, invoice IV68071902). It must have a supplier and a before-VAT / VAT split.
2. Click "🏷️ ลงทะเบียนเป็นมัดจำ", enter `AI6901007`, save.
3. Check in the browser: the row shows the badge "มัดจำ AI6901007 · ใช้แล้ว 0 · เหลือ …"; the expense can no longer be deleted; create or open a CAC PO in status ordered, press receive, confirm the deposit is listed with the right remaining amount, tick it, check the preview (new expense, or "ไม่สร้างรายจ่าย" when fully covered), confirm, then check: PO shows received, the remainder expense (if any) has the right before-VAT / VAT, the PO detail lists the applied deposit, the Expenses badge now shows it used, and stock movements were posted. Also receive one PO WITHOUT any deposit and check it behaves as before.
4. Scan test: scan the two CAC documents (IV6903014 -> AI6901007 41,004.00; IV6903055 -> AI6901007 2,935.80) after the edge function is deployed (step 3); the form should show "อ่านพบการหักมัดจำ …" and the receive dialog should pre-tick the deposit.

## Verified vs never run
**Verified by tests/build:** deposit math (remaining, VAT split, receive plan, validation, ref matching), receive-dialog selection logic and error-code mapping, scan validation and prompt text, eval comparison, production build.
**Verified by reading code only:** the SQL of both migrations and the RPC (several review rounds), the RPC mirroring `depositMath.js`, grants/triggers, all React wiring (dialog gating while deposits load, post-RPC error handling, PO detail, Expenses badge, register modal).
**Never run:** applying either migration; `po_deposit_test.sql` (23 tests; fixture INSERT columns were re-checked against the live schema read-only, but the script has never executed, so a first-run tweak is possible); the RPC under the real `authenticated` role; every UI flow in a browser; the real-model scan on the two CAC documents (needs the extraction API key; fixtures in `scripts/eval-fixtures/cac-deposit/` have empty `line_items` and need the scan pages split out locally); the edge function with the new field.

## Deferred minor findings (from the review ledger)
- `round2(NaN)` returns 0; no explicit -0 regression test.
- A NULL `expenses.amount` lets the deposit split check pass silently (amount default is 0 in the live schema).
- The RPC's VAT fold does not cap against the last deposit's remaining VAT (used VAT may exceed stored by up to 0.01 x n); the client mirror does not model the last-application VAT>=0 guard. The UI treats remaining net <= 0.005 as fully used and never splits when remaining VAT < 0.
- A re-scan on PO edit overwrites `deposit_hint` (accepted).
- Eval `lineCountMatches` display is odd for fixtures with empty `line_items`.
- Follow-up outside this plan: the credit-note RPCs (confirm/void/settle) also lack `tenant_can_write()`; needs a new migration on the credit-note branch.

## Known limits
- Stock posting is not atomic with the RPC: if a stock movement fails after the RPC committed, the PO is already received and the user is told to check the ledger and not receive again.
- PEAK exports the deposit and the remainder as ordinary expenses (no deposit-aware journal).
- Deposit invoice numbers are unique per tenant (case/whitespace-insensitive); one expense registers at most once.
- Deleting the remainder expense of a deposit PO is still possible (the Expenses page only explains instead of offering un-receive): it leaves the PO received with no payable. Do not do it; re-create the expense by hand if it happens.
- Swap-tax-invoice mismatch on deposit POs (finding M1): the "สลับใบกำกับภาษี" flow works on the PO's remainder expense. For a PO fully covered by deposits there is no expense, so the real tax invoice number of that PO is recorded nowhere. Note it by hand (PO notes) until a follow-up handles it.
- `created_by` on deposits and applications is filled from the client / `auth.email()` and can be spoofed by a client for `supplier_deposits`; do not treat it as an audit trail (the audit log is).
- The preview and the server can differ by one satang in display (rounding ties, VAT folded into the last application); the server value is the one stored.
- Decide merge order against the PO-extract upgrade branch (shared files: `PurchaseOrders.jsx`, `poDocumentExtraction.js`, `scan-logic.ts`, `po-extract-prompt.ts`).
