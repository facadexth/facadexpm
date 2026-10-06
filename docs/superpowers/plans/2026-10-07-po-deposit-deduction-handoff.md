# PO deposit deduction (หักมัดจำ) — owner handoff (2026-10-07)

Branch `feat/po-deposit-deduction` (stacked on `worktree-supplier-credit-note-peak-export`, commits after `695058c`). Nothing is merged, pushed, applied or deployed. Final checks: `npx vitest run` 706/706, `npm run build` OK.

## What shipped (สิ่งที่ทำเสร็จ)
- **Register a deposit:** on the Expenses page a supplier expense with a VAT split can be registered as a deposit (มัดจำ) with its own deposit invoice number. Registered deposits show a badge (used / remaining) and are locked once applied to a PO.
- **Deduct on receive:** when you receive a PO, the dialog lists that supplier's open deposits. Tick a deposit, give the ex-VAT amount, see the preview "รายจ่ายใหม่: ก่อน VAT X · VAT Y" or "ไม่สร้างรายจ่าย (หักครบ)". Confirm calls the new RPC `receive_po_with_deposits`, which atomically creates the remainder expense (none if the deposits cover everything), records the applications and marks the PO received. Stock posting and audit log rows stay on the client, after the RPC.
- **PO detail** lists the deposits applied ("หักมัดจำ {no}: ก่อน VAT X · VAT Y").
- **Document scan** reads a printed deposit deduction line (e.g. "Deduct Down Payment AI6901007 41,004.00") into `deposit_deductions`; it is saved as `purchase_orders.deposit_hint` and pre-ticks the matching registered deposit in the receive dialog. Only when the line is explicitly printed; never inferred.
- Server-side VAT is the authority: the preview can differ by one satang on exact .5 ties.

## REQUIRED ORDER of release (ลำดับที่ต้องทำ)
Migrations go live the moment they are applied. **The web app must NOT be deployed before the migrations: every PO receive now calls `receive_po_with_deposits`, so receiving any PO would fail until both migrations exist.**
1. Apply `supabase/migrations/2026-10-07-01-supplier-deposits.sql`
2. Apply `supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql`
3. Run `supabase/tests/po_deposit_test.sql` and read its RESULT output (BEGIN … ROLLBACK script). Fix any failure before continuing.
4. Deploy the edge function: `npx supabase functions deploy extract-po-document --project-ref kntspldhvcjeaubtqtkn --use-api` (shared files `scan-logic.ts` and `po-extract-prompt.ts` changed; prompt version `2026-10-07-v3`, so cached scans are not reused).
5. Deploy the web app: `npm run deploy`.

Dry run each migration first (no change is kept); file 02 depends on 01, so put both between BEGIN and ROLLBACK:
```
printf 'BEGIN;\n' > /tmp/dry.sql; cat supabase/migrations/2026-10-07-01-supplier-deposits.sql supabase/migrations/2026-10-07-02-receive-po-with-deposits.sql >> /tmp/dry.sql; printf '\nROLLBACK;\n' >> /tmp/dry.sql
npx supabase db query --linked -f /tmp/dry.sql
```
Real apply: `npx supabase db query --linked -f <file>`. Note that this branch is stacked on the credit-note branch; its two migrations (`2026-10-06-01`, `-02`, `-03`) must be applied first if they are not live yet.

## Register the CAC deposit AI6901007 by hand
The deposit's invoice number (`AI6901007`) differs from its expense's `invoice_no` (`IV68071902`). The register dialog now starts EMPTY on purpose, so type the deposit number yourself:
1. Expenses page, find the CAC deposit expense (supplier CAC, invoice IV68071902). It must have a supplier and a before-VAT / VAT split.
2. Click "🏷️ ลงทะเบียนเป็นมัดจำ", enter `AI6901007`, save.
3. Check in the browser: the row shows the badge "มัดจำ AI6901007 · ใช้แล้ว 0 · เหลือ …"; the expense can no longer be deleted; create or open a CAC PO in status ordered, press receive, confirm the deposit is listed with the right remaining amount, tick it, check the preview (new expense, or "ไม่สร้างรายจ่าย" when fully covered), confirm, then check: PO shows received, the remainder expense (if any) has the right before-VAT / VAT, the PO detail lists the applied deposit, the Expenses badge now shows it used, and stock movements were posted. Also receive one PO WITHOUT any deposit and check it behaves as before.
4. Scan test: scan the two CAC documents (IV6903014 -> AI6901007 41,004.00; IV6903055 -> AI6901007 2,935.80) after step 4 of the release; the form should show "อ่านพบการหักมัดจำ …" and the receive dialog should pre-tick the deposit.

## Verified vs never run
**Verified by tests/build:** deposit math (remaining, VAT split, receive plan, validation, ref matching), receive-dialog selection logic and error-code mapping, scan validation and prompt text, eval comparison, production build.
**Verified by reading code only:** the SQL of both migrations and the RPC (several review rounds), the RPC mirroring `depositMath.js`, grants/triggers, all React wiring (dialog gating while deposits load, post-RPC error handling, PO detail, Expenses badge, register modal).
**Never run:** applying either migration; `po_deposit_test.sql` (its fixture column lists are best guesses and may need a tweak on first run); the RPC under the real `authenticated` role; every UI flow in a browser; the real-model scan on the two CAC documents (needs the extraction API key; fixtures in `scripts/eval-fixtures/cac-deposit/` have empty `line_items` and need the scan pages split out locally); the edge function with the new field.

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
- Decide merge order against the PO-extract upgrade branch (shared files: `PurchaseOrders.jsx`, `poDocumentExtraction.js`, `scan-logic.ts`, `po-extract-prompt.ts`).
