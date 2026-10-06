# Handoff: ใบกำกับภาษีผู้ขาย (Supplier tax invoice matching), 2026-10-08

Branch: `feat/tax-invoice-matching`, stacked on `feat/po-deposit-deduction`. Nothing here is merged, pushed, deployed or applied.
Live DB: CHANG `kntspldhvcjeaubtqtkn`. Run every command below from the MAIN checkout `/Users/plfx/code/FacadeXPM/facadex-app`
(the worktree has no `supabase/.temp` link), with the file paths given as absolute worktree paths.

Worktree: `/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/po-deposit-deduction`

## 1. สิ่งที่สร้างเสร็จ (what shipped, all in code, none live)

- Migration `2026-10-08-01-supplier-tax-invoices.sql`: `purchase_orders.stock_from_invoice`, 5 new tables (invoices, items, PO links, reversals, snapshots),
  new movement type `receipt_reversal`, private helpers, 3 lock triggers (PO, PO items, late stock movement on a tax-invoiced PO).
- Migration `2026-10-08-02-supplier-tax-invoice-rpcs.sql`: 5 public RPCs (`save_supplier_tax_invoice_draft`, `delete_supplier_tax_invoice_draft`,
  `preview_supplier_tax_invoice`, `post_supplier_tax_invoice`, `void_supplier_tax_invoice`) and their private helpers.
- SQL test `supabase/tests/supplier_tax_invoice_test.sql` (T2-T34: cross-tenant, void exactness, FIFO/LIFO, non-finite data, stale preview, brand-new balance keys, void by stored movement ids, re-link after void, duplicate numbers, credit-note / outside-month / wrong-supplier / invalid-stock-line checks).
- App: new page "ใบกำกับภาษีผู้ขาย" (list, form with scan + month PO picker + line mapping, preview, confirm-to-post, view, void, delete draft),
  stock ledger understands `receipt_reversal`, PO page has the "สต็อกเข้าตอนบันทึกใบกำกับภาษี" flag, badges, locked edit of linked POs, receive skips stock for flagged POs.
- Model: a PO flagged `stock_from_invoice` posts NO stock when received. When the supplier's (monthly) invoice is posted, its lines become `purchase_in`
  and the receipt movements of the linked POs are reversed (`receipt_reversal`), so stock = what the invoice says. Void undoes it.
  Expenses keep their amounts; only the invoice number is stamped (old number kept in the link row).

## 2. ลำดับการปล่อย (REQUIRED ORDER)

State as of 2026-10-06 night: deposit migrations `2026-10-07-01` and `-02` are ALREADY applied live. The deposit WEB client is NOT deployed yet.
This branch is stacked on the deposit branch, so deploying this branch's web app also ships the deposit client. Do not deploy the web app before step 4.

### Step 1: dry run (rolled back, nothing persists)

Run this at a QUIET time: the file creates triggers on `purchase_orders`, `purchase_order_items` and `stock_movements`, so it holds locks on them until the rollback, and the test takes about a minute.
`lock_timeout` makes it give up (error, nothing changed) instead of freezing the app if someone is using purchase orders or stock at that moment; if you see a lock timeout, retry later.

Build ONE file: `BEGIN;` + `SET LOCAL lock_timeout='5s';` + migration 01 + migration 02 + the SQL test body (its own `BEGIN;`/`ROLLBACK;` stripped) + `ROLLBACK;`:

```bash
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/po-deposit-deduction
( echo "BEGIN;"
  echo "SET LOCAL lock_timeout='5s';"
  cat $W/supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql
  cat $W/supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql
  grep -v -x -e "BEGIN;" -e "ROLLBACK;" $W/supabase/tests/supplier_tax_invoice_test.sql
  echo "ROLLBACK;" ) > /tmp/sti_dry.sql
cd /Users/plfx/code/FacadeXPM/facadex-app
npx supabase db query --linked -f /tmp/sti_dry.sql
```

How to read the result: the test body ends with `RAISE EXCEPTION 'RESULT: supplier_tax_invoice_test ALL PASSED'`. That RAISE is deliberate:
it aborts the transaction so nothing can persist. So SUCCESS LOOKS LIKE AN ERROR (HTTP 400 from the API / `ERROR:` in the output) whose text contains
`RESULT: supplier_tax_invoice_test ALL PASSED`. Any OTHER error text (for example `T12 FAIL: ...`, a syntax error, a missing column) = failure: copy the message and stop.
Then confirm nothing persisted (all three must return null):

```sql
SELECT to_regclass('public.supplier_tax_invoices') AS t, to_regprocedure('post_supplier_tax_invoice(uuid,integer)') AS f,
       (SELECT 1 FROM information_schema.columns WHERE table_name='purchase_orders' AND column_name='stock_from_invoice') AS c;
```

The dry run does not exercise real concurrency (lock order). The test header says "dry-run only": the file was run this way against CHANG on 2026-10-07 (rolled back, ALL PASSED, nothing persisted), but run it again yourself before applying.

### Step 2: apply (quiet time), one file per transaction

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app
W=/Users/plfx/code/FacadeXPM/facadex-app/.claude/worktrees/po-deposit-deduction
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"; cat $W/supabase/migrations/2026-10-08-01-supplier-tax-invoices.sql; echo "COMMIT;" ) > /tmp/sti_apply_01.sql
( echo "BEGIN;"; echo "SET LOCAL lock_timeout='5s';"; cat $W/supabase/migrations/2026-10-08-02-supplier-tax-invoice-rpcs.sql; echo "COMMIT;" ) > /tmp/sti_apply_02.sql
npx supabase db query --linked -f /tmp/sti_apply_01.sql     # first; must succeed before 02
npx supabase db query --linked -f /tmp/sti_apply_02.sql
```

`lock_timeout` makes the apply give up (error, nothing changed) instead of freezing the app if someone is using purchase orders / stock at that moment. If it errors with a lock timeout, retry later.
The migration 01 touches `purchase_orders`, `purchase_order_items`, `stock_movements` (new triggers + widened CHECK). Migrations are live the moment they commit.

### Step 3: reload PostgREST

```sql
NOTIFY pgrst, 'reload schema';
```

### Step 4: ACL / structure checks (read-only; every result must match the expectation)

```sql
-- (a) 5 new tables: authenticated has SELECT only; anon nothing. Expect 5 rows: authenticated | SELECT, and no anon rows.
SELECT table_name, grantee, string_agg(privilege_type, ',' ORDER BY privilege_type) AS privs
FROM information_schema.role_table_grants
WHERE table_schema='public' AND table_name IN ('supplier_tax_invoices','supplier_tax_invoice_items','supplier_tax_invoice_pos','supplier_tax_invoice_reversals','supplier_tax_invoice_snapshots')
  AND grantee IN ('anon','authenticated')
GROUP BY 1,2 ORDER BY 1,2;

-- (b) RLS on for all 5. Expect 5 rows, all true.
SELECT relname, relrowsecurity FROM pg_class WHERE relname LIKE 'supplier_tax_invoice%' AND relkind='r' ORDER BY 1;

-- (c) functions: for each name, does anon / authenticated / PUBLIC have EXECUTE?
SELECT p.proname,
       has_function_privilege('anon', p.oid, 'EXECUTE')          AS anon_exec,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') AS auth_exec,
       p.prosecdef AS security_definer
FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace AND n.nspname='public'
WHERE p.proname LIKE '%supplier_tax_invoice%' OR p.proname LIKE '\_sti\_%'
   OR p.proname IN ('_stock_receipt_reversal','_po_goods_subtotal','_po_tax_invoiced','po_block_when_tax_invoiced','poi_block_when_tax_invoiced','stock_movement_block_when_tax_invoiced')
ORDER BY 1;
-- Expect: anon_exec = false on EVERY row.
-- auth_exec = true ONLY for the 5 RPCs: save_/delete_/preview_/post_/void_supplier_tax_invoice(_draft).
-- Everything starting with _ and the 3 *_block_when_tax_invoiced trigger functions: auth_exec = false.
-- (_sti_finite, _sti_tolerance, _sti_wac_after_* are not SECURITY DEFINER but are also revoked.)

-- (d) triggers exist. Expect 3 rows.
SELECT tgname, tgrelid::regclass FROM pg_trigger
WHERE tgname IN ('po_block_when_tax_invoiced_trg','poi_block_when_tax_invoiced_trg','stock_movement_block_when_tax_invoiced_trg') AND NOT tgisinternal;

-- (e) the widened movement type CHECK. Expect the definition to list receipt_reversal.
SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname='stock_movements_movement_type_check';
```

If any `anon_exec` or helper `auth_exec` is true: stop, do not deploy, send me the output (Supabase default privileges can re-grant; the fix is a `REVOKE ALL ON FUNCTION ... FROM PUBLIC, anon, authenticated;`).
A restore or move of the database loses function grants (seen before), so repeat check (c) after any restore.

### Step 5: deploy the web app (only AFTER steps 2-4)

STOP: do not run `npm run deploy` from the main checkout. As of 2026-10-07 `/Users/plfx/code/FacadeXPM/facadex-app` is on branch `claude/task-i56nn7`.
That branch has NEITHER this feature NOR the deposit client, and it does not contain the live build `68ab4fe` (credit note / PEAK export), so deploying from it would REMOVE live features.
(Checked with `git merge-base --is-ancestor 68ab4fe <branch>`: `feat/po-deposit-deduction`, `feat/tax-invoice-matching` and `origin/main` contain it; `claude/task-i56nn7` does not. The LOCAL `main` branch is behind `origin/main`, which is why the procedure below branches from `origin/main`.) The worktree under `.claude/worktrees/` has no `.env`, so it cannot build for CHANG either.
**This deploy ALSO ships the PO deposit web client** (the deposit migrations are already live; the client is not).

Procedure (merge in order on top of `origin/main` in a clean checkout, then deploy from that checkout). Nothing below was run by me.

```bash
cd /Users/plfx/code/FacadeXPM/facadex-app
git status --short                                   # note anything uncommitted in the main checkout; do not touch it
git fetch origin
git worktree add -b release/deposit-tax-invoice ../facadex-release origin/main   # clean checkout of origin/main (NOT the local main) in a NEW folder
cd ../facadex-release
git merge --no-ff feat/po-deposit-deduction          # 1st: the deposit feature
git merge --no-ff feat/tax-invoice-matching          # 2nd: this feature (it is stacked on the deposit branch)
# a merge conflict = STOP and send me the file names; do not resolve guesses
git merge-base --is-ancestor 68ab4fe HEAD && echo "OK: live build 68ab4fe is included" || echo "STOP: 68ab4fe missing"
git merge-base --is-ancestor origin/main HEAD && echo "OK: everything on origin/main is included" || echo "STOP: origin/main is not included"
```

Only continue if BOTH lines printed `OK`. If you prefer NOT to merge yet, deploy straight from this branch in a clean checkout instead (it already contains `68ab4fe` and the deposit client):
`git worktree add --detach ../facadex-release feat/tax-invoice-matching`, then run the rest of this procedure from `../facadex-release`.

```bash
cd /Users/plfx/code/FacadeXPM/facadex-release
cp /Users/plfx/code/FacadeXPM/facadex-app/.env .env    # the CHANG values (or build .env from .env.cutover.example)
grep -c kntspldhvcjeaubtqtkn .env                      # must be 1 or more (CHANG)
grep -c yyzbgd .env                                    # must be 0 (old Tokyo project)
npm ci
npx vitest run
npm run deploy      # = build + verify:bundle + smoke:boot + wrangler deploy
```

`npm run deploy` stops by itself if `verify:bundle` does not print `verify-bundle: OK (points at CHANG, no retired project)`; do not work around that.
Afterwards push `release/deposit-tax-invoice` / merge it into `main` the way you normally do, so `main` matches what is live.

Why migrations first: the ledger must understand `receipt_reversal` before the first invoice is posted. The app is otherwise safe before or after the migration:
with no migration the links hook reports "not ready", the PO page shows no badges and hides the flag checkbox, and the new page shows a calm "not live yet" state.

### Step 6: live verification with ONE real invoice (ช.เจริญกลาส)

1. In the app open "ใบกำกับภาษีผู้ขาย", press "+ เพิ่ม", pick the supplier, scan or type the invoice, tick that month's POs, map each line to its stock item and site.
   IMPORTANT (stock can be counted twice): the post reverses the PO's *real receipt movements*. Those only exist for POs received from about 2026-08-18 on (the app records them when you press receive).
   POs of Jan-Aug 2026 were entered by the stock BACKFILL (purchase_in rows with a `<month>26_backfill` reference and no PO link), so such a PO has no receipt movement to reverse:
   posting its invoice would ADD the invoice's stock on top of stock that is already there. The preview shows `ใบสั่งซื้อไม่มีรายการรับเข้าสต็อกให้กลับรายการ — สต็อกจะถูกเพิ่มจากใบกำกับทั้งหมด หากเดือนนี้ลงสต็อกย้อนหลังไว้แล้ว จะนับซ้ำ`,
   and the confirm dialog repeats it in a red box with each affected PO number and will not enable the confirm button until you tick the acknowledgement.
   Owner guidance: do NOT post invoices for POs of months that were already backfilled (up to Aug 2026) unless that PO's stock was NOT backfilled. For new POs received from now on, tick the flag when creating the PO (no receipt movement is made, the invoice is the stock source).
2. Before posting: write down, for every item in the invoice, the Inventory balance (quantity and average cost) per site. Press "ตรวจสอบก่อนบันทึก" and compare the preview rows
   (คงเหลือก่อน = what you wrote down; คงเหลือหลัง and ต้นทุนเฉลี่ยหลัง = what you expect). Read every warning. Negative stock is allowed but flagged.
3. Post. Then check: the stock card shows `ใบกำกับ ...` in-lines and `กลับรายการรับเข้า ...` out-lines dated the invoice date; the expenses of the POs show the invoice number
   with UNCHANGED amounts; the balances equal the preview's "after".
4. Optional: void once (step 7) and confirm balances return to the numbers you wrote down, then post again.
5. Hooks check (the hooks have never run live): open the PO list, the Expenses page, the Inventory stock card and the new page; a PostgREST error saying
   "more than one relationship" (PGRST201) or "Could not find a relationship" means an embed needs the explicit constraint name; `NOTIFY pgrst, 'reload schema'` (step 3) if new tables are not found. Send me the exact error text.

### Step 7: void and `void_inexact`

Open the posted invoice, "ยกเลิกใบกำกับ", type a reason. Void re-posts the reversed PO receipts and removes the invoice lines, restores the stamped invoice numbers (only when the expense still shows the stamped number; otherwise warning `expense_changed`), and frees the POs.
If nothing else touched those stock balances since the post, void restores them EXACTLY from the snapshot taken at post time.
If stock moved in between (another receipt, sale, transfer), void cannot restore exactly: it falls back to the formulas and returns the warning `void_inexact`
(quantities are right, the average cost may differ slightly). Check the balances afterwards when you see it.

## 3. ที่ตรวจแล้ว / ยังไม่ได้ตรวจ

Verified in this branch (task 9, 2026-10-08): `npx vitest run` and `npm run build` pass; the two headless harnesses pass; static checks below.
Static: 16 `SECURITY DEFINER` functions in the two migrations (the plan said 15 before the snapshot and negatives helpers were added): 6 in migration 01 and 10 in 02;
each has its REVOKE (private helpers and triggers FROM PUBLIC, anon, authenticated; the 5 RPCs FROM PUBLIC, anon with an explicit GRANT to authenticated); tables REVOKE ALL then GRANT SELECT only.
Dry run: migrations 01+02+test (T2-T34) ran in one rolled-back transaction against CHANG on 2026-10-07 after the final fixes: ALL PASSED, and a read-only check afterwards showed nothing persisted
(tables, columns, functions, triggers and the movement-type CHECK unchanged). Run step 1 yourself before applying.

NOT verified: any UI flow against the live database; real concurrency / lock order; the Android Chrome history re-push when a modal refuses to close on the back button;
the extra back-press on old Safari; the real Postgres error texts (the Thai error mapper is tested against strings from the migrations, not live errors).

## 4. ข้อจำกัดที่รู้แล้ว (known limits)

- Receipt movements are still posted by the browser after `receive_po_with_deposits` (not atomic). Unchanged by this feature.
- WAC after reversals (A2): when a balance goes to 0 or below, the average cost is kept, not mathematically restored. After a PARTIAL reversal with a small remainder the average cost is sensitive. Post then void is exact only if nothing else touched the balance in between (snapshot); otherwise `void_inexact`.
- Deadlock: the browser receive loop locks balance then PO (through the late-receipt trigger); post/void lock PO then balance. A rare deadlock is possible; Postgres aborts one side with error 40P01, data stays correct, the app says to retry.
  The credit-note confirm locks balances one item at a time, so it can also deadlock with post (same clean abort, retry).
- `stock_movements` stays writable by tenant admins under its existing RLS policy for all movement types (pre-existing, out of scope). A hand-made movement is possible; the late-receipt trigger only blocks receipts on tax-invoiced POs.
- Editing a PO is not atomic in the app (header update, then items delete and insert). So the UI locks editing and cancelling of a PO linked to an active (draft or posted) invoice; the DB trigger blocks a posted-invoice PO only. Void or delete the draft first.
- Old invoice links make a PO undeletable (FK RESTRICT); relevant for a tenant purge.
- `useInventoryItemUnitFactors` is not paginated (pre-existing).
- Backfilled months: POs without receipt movements (Jan-Aug 2026 backfill) get the invoice stock ADDED with nothing reversed, which double counts if that month's stock was already entered. The warning and the acknowledgement checkbox exist; the owner guidance is in step 6 and the decision is in section 5.
- Movement dating (A4): post dates its movements at the invoice date, void writes `now()`. Voiding does not rewrite the invoice month's ledger; the confirm dialog says so.
- Credit notes confirmed AFTER an invoice was posted get no warning. If the supplier's invoice already nets out returned goods, stock will be low by the returned quantity (check the PO's credit notes before posting; `po_has_credit_note` warns only at preview time).
- Old browser tabs show `receipt_reversal` movements as "in" until they are reloaded (the ledger fix is in the new bundle).
- The new foreign keys are `ON DELETE RESTRICT`: a supplier, site, inventory item, PO or stock movement that is referenced by a tax invoice cannot be hard-deleted; the app shows the raw database foreign-key error instead of a Thai message.
- `void_supplier_credit_note` (existing) locks balances without a fixed order, so it can deadlock with post/void (40P01, one side aborts cleanly, retry). Two posts racing on a brand-new (item, site) key are handled: post first creates the missing balance rows in (item, site) order.
- Stale preview is also enforced server-side: every draft save bumps `revision`, preview returns it, post must pass it (`stale_preview` otherwise), and saving after a preview drops the preview in the page.

## 5. การตัดสินใจของเจ้าของ (OWNER DECISIONS pending)

- A4 backdating: `invoice_date` may not be in the future but has NO lower bound. Posting writes movements dated the invoice date at 12:00 Bangkok, so an invoice dated months ago changes stock reports for months that may already be reported or closed.
  Decide whether to add a lower bound (for example: not before the start of the previous month) or a typed-reason requirement. Left as is.
- Backfilled months: should invoices for POs dated in already-backfilled months (up to Aug 2026) be BLOCKED (for example POs dated before a cutoff such as 2026-09-01), or stay allowed with the red acknowledgement box? Today they are allowed with the box; a hard cutoff is a small change if you want it.
- Whether the tolerance rule R1 (smaller of 1% and 5 baht) is what you want for monthly invoices with many lines (a bigger difference needs a typed reason).

## 6. Rulings

Owner rulings R1-R4 and the plan's rulings A1-A15 (so you can object to any):

- R1 Tolerance: an invoice-vs-PO difference passes when `|diff| ≤ min(1% × base, 5 baht)`. The base is Σ PO goods value (ex-VAT). JS: `Math.min(Math.abs(base) * 0.01, 5)`. SQL: `LEAST(abs(base) * 0.01, 5)`. Add a satang slack of `0.005` to the comparison. Note this is the *smaller* of the two, unlike the old swap's `max`. A bigger difference is allowed only with a typed reason (`match_note`), per the spec's default.
- R2 Negative stock after a reversal: **allow, but warn.** It is never an exception. It is reported in the preview, in the post result and in the confirm dialog. This also applies to void.
- R3 "Stock from invoice" is decided **at PO creation** (`purchase_orders.stock_from_invoice`). A flagged PO posts no stock when it is received.
- R4 Sequencing: this feature builds **after** the PO deposit deduction feature (`feat/po-deposit-deduction`, plan `docs/superpowers/plans/2026-10-06-po-deposit-deduction-plan.md`). Execute in a worktree branched from that feature's final tip (after its Task 7 handoff), or from `main` after it is merged. Do not start Task 8 of this plan while anyone is still editing `src/pages/PurchaseOrders.jsx` for the deposit feature.
- A1 The reversal source is the PO's **actual** receipt movements (`stock_movements` with `movement_type='purchase_in'`, `reference_type='purchase_order'`, `reference_id=<po id>`), not the PO's items and not the flag. A partly posted receipt, a non-stock PO, or a flagged PO received by a stale client all reverse exactly what is really there.
- A2 WAC inverse: if `q − r > 0`, the new WAC is `max((q·w − r·c)/(q − r), 0)`. If `q − r ≤ 0`, the WAC is unchanged (the spec's "balance reaches 0" rule, extended to negative balances). WAC is never negative.
- A3 Void order is the reverse of post: first re-post the reversed PO receipts as `purchase_in` (at their original cost), then remove the invoice lines with `receipt_reversal`. This keeps stock higher during the void.
- A4 Movement dating: movements written by **post** (invoice lines and receipt reversals) get `created_at = invoice_date 12:00 Asia/Bangkok`, so the stock reports put them in the invoice month. Movements written by **void** use `now()`.
- A5 "A PO belongs to at most one non-void invoice" is enforced by an `active` flag on the link plus a partial unique index `(po_id) WHERE active`. Drafts also hold their POs. Void clears `active`. The spec's literal `po_id UNIQUE` would stop a voided PO from being linked again.
- A6 Expense stamping keeps the previous `invoice_no` on the link row. Void restores it **only** if the expense still shows the stamped number; otherwise it warns `expense_changed`. Notes are appended and never stripped: post adds `ใบกำกับภาษี <no> (เลขเดิม: <old|->)`, and void adds `ยกเลิกใบกำกับภาษี <no>`.
- A7 All client writes go through RPCs, including the draft save, which is atomic: header, lines and links in one call. This is stricter than the spec's "client may only create drafts".
- A8 Invoice lines are ex-VAT. The server computes `amount = round(qty × unit_price × (1 − discount_pct/100), 2)` and `base_unit_cost = amount / base_qty`. The client sends `base_qty` only. There is no VAT-inclusive mode.
- A9 A second blocking check: Σ line amounts must equal `net_before_vat` within the same tolerance (base = net). Otherwise `lines_total_mismatch`, with no override.
- A10 The PO proposal uses the PO `date` month (the order month), not `received_date`.
- A11 Warnings that never block: a PO with a confirmed credit note (`po_has_credit_note`), a PO outside the invoice month, a PO with deposit applications, a PO with no expense, and a flagged PO whose stock was nevertheless received.
- A12 `invoice_date` cannot be in the future (Bangkok date).
- A13 Invoice numbers are unique per `(tenant, supplier, lower(btrim(invoice_no)))` among non-void invoices.
- A14 Once a PO is linked to a **posted** invoice, it is locked by trigger: no change to `status`, `supplier_id`, `site_id`, `has_vat`, `price_includes_vat`, `stock_from_invoice`, and no change to its items (`po_tax_invoiced`). `stock_from_invoice` cannot change once a PO is `received` (`po_stock_flag_locked`).
- A15 A line's base quantity is pre-filled with the PO conversion (`computePoItemBaseQty`). When the line's unit differs from the item's base unit and no unit factor exists, or an aluminium/glass item has no dimensions, the line is marked "unconverted" and the user must type the base quantity.
