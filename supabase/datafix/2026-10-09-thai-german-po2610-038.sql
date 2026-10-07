-- ============================================================
-- ONE-OFF DATA FIX — ไทย-เยอรมัน PO2610-038 (owner-approved separately; NOT part of the code release).
-- What: link the already-registered deposit (supplier_deposits 4b3ff8bc-e8a6-44bf-9b4c-001a6fa2436c, expense a9811a5e-...,
--       invoice 2602543, 110,600.55 = 103,365.00 + 7,235.55) to PO2610-038: set po_id = de73ede3-... and pct_of_po = 50.
--       The deposit row, its application and the bill 2603202 amounts were already corrected live on 2026-10-07; this file
--       touches NOTHING else (no inserts, no expense amounts).
-- When: AFTER migration 2026-10-09-01 is applied. That is the ONLY hard dependency (supplier_deposits.po_id / pct_of_po
--       and sd_validate_po_trg); 2026-10-09-02 may be applied before or after.
-- How:  run the whole file as ONE transaction and stop on the first error, e.g.
--       psql "$DB" -v ON_ERROR_STOP=1 --single-transaction -f 2026-10-09-thai-german-po2610-038.sql
--       (the file has its own BEGIN/COMMIT; ON_ERROR_STOP keeps a failed DO block from being followed by COMMIT).
-- Why the trigger is bypassed: sd_validate_po_trg (migration 01) raises 'deposit_in_use' on any change of po_id/pct_of_po
--       once the deposit has a po_deposit_applications row, and this deposit already has one. The trigger is therefore
--       DISABLED for the single UPDATE and RE-ENABLED in the same transaction; the script asserts tgenabled = 'O'
--       afterwards. Everything sd_validate_po would check (same tenant, same supplier, PO exists) is checked explicitly
--       BEFORE the trigger is disabled. If anything fails or the transaction is rolled back, the trigger is restored
--       automatically (DDL is transactional).
-- Safety: every precondition is checked; any surprise -> RAISE EXCEPTION 'ABORT ...' and nothing changes.
--         Idempotent: if the link is already in place it only reports a NOTICE.
-- Dry run first (ROLLBACK instead of COMMIT), then for real.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
DO $$
DECLARE
  c_tenant CONSTANT UUID := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  c_po     CONSTANT UUID := 'de73ede3-4a2f-48a4-a5e1-3c0f31c39854';
  c_sup    CONSTANT UUID := '3dcc6336-47b3-4fad-8be3-c3a2126ed773';
  c_dep    CONSTANT UUID := '4b3ff8bc-e8a6-44bf-9b4c-001a6fa2436c';
  c_dep_e  CONSTANT UUID := 'a9811a5e-83a3-4c06-aef5-129d85779b08';
  po RECORD; de RECORD; sd RECORD; app RECORD; v_en "char"; v_rows BIGINT;
BEGIN
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'supplier_deposits' AND column_name = 'pct_of_po')
     OR NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.supplier_deposits'::regclass AND tgname = 'sd_validate_po_trg') THEN
    RAISE EXCEPTION 'ABORT: apply migration 2026-10-09-01 first';
  END IF;

  SELECT * INTO sd FROM supplier_deposits WHERE id = c_dep FOR UPDATE;
  IF NOT FOUND THEN RAISE EXCEPTION 'ABORT: deposit row % does not exist', c_dep; END IF;
  IF sd.expense_id IS DISTINCT FROM c_dep_e THEN RAISE EXCEPTION 'ABORT: deposit expense_id unexpected %', row_to_json(sd); END IF;
  IF sd.tenant_id IS DISTINCT FROM c_tenant THEN RAISE EXCEPTION 'ABORT: deposit tenant unexpected %', row_to_json(sd); END IF;
  IF sd.po_id IS NOT NULL AND sd.po_id IS DISTINCT FROM c_po THEN RAISE EXCEPTION 'ABORT: deposit already linked to a DIFFERENT po_id %', sd.po_id; END IF;

  SELECT * INTO po FROM purchase_orders WHERE id = c_po;
  IF NOT FOUND OR po.po_number IS DISTINCT FROM 'PO2610-038' OR po.tenant_id IS DISTINCT FROM c_tenant OR po.supplier_id IS DISTINCT FROM c_sup THEN
    RAISE EXCEPTION 'ABORT: PO is not PO2610-038 of the expected tenant/supplier %', row_to_json(po);
  END IF;

  SELECT * INTO de FROM expenses WHERE id = c_dep_e;
  IF NOT FOUND OR de.tenant_id IS DISTINCT FROM c_tenant OR de.supplier_id IS DISTINCT FROM po.supplier_id OR de.invoice_no IS DISTINCT FROM '2602543' THEN
    RAISE EXCEPTION 'ABORT: deposit expense unexpected (tenant/supplier/invoice) %', row_to_json(de);
  END IF;
  IF (de.amount_no_vat + de.vat) IS DISTINCT FROM 110600.55 THEN RAISE EXCEPTION 'ABORT: deposit gross is not 110600.55 %', row_to_json(de); END IF;

  SELECT count(*) AS c, sum(amount_no_vat) AS n, sum(vat) AS v INTO app FROM po_deposit_applications WHERE deposit_id = c_dep AND po_id = c_po;
  IF app.c IS NOT DISTINCT FROM 0 OR app.n IS DISTINCT FROM 103365.00 OR app.v IS DISTINCT FROM 7235.55 THEN
    RAISE EXCEPTION 'ABORT: applications of this deposit to the PO do not sum to 103365.00 + 7235.55 (count %, net %, vat %)', app.c, app.n, app.v;
  END IF;
  IF EXISTS (SELECT 1 FROM po_deposit_applications WHERE deposit_id = c_dep AND po_id IS DISTINCT FROM c_po) THEN
    RAISE EXCEPTION 'ABORT: deposit has applications to another PO';
  END IF;
  IF EXISTS (SELECT 1 FROM supplier_deposits WHERE po_id = c_po AND id IS DISTINCT FROM c_dep) THEN
    RAISE EXCEPTION 'ABORT: another deposit already linked to this PO';
  END IF;

  -- already done?
  IF sd.po_id IS NOT DISTINCT FROM c_po AND sd.pct_of_po IS NOT DISTINCT FROM 50 THEN
    RAISE NOTICE 'ALREADY APPLIED — nothing changed';
    RETURN;
  END IF;

  -- all guards passed: bypass sd_validate_po_trg for this single UPDATE only
  ALTER TABLE supplier_deposits DISABLE TRIGGER sd_validate_po_trg;
  UPDATE supplier_deposits SET po_id = c_po, pct_of_po = 50 WHERE id = c_dep;
  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows IS DISTINCT FROM 1 THEN RAISE EXCEPTION 'ABORT: UPDATE touched % rows, expected 1', v_rows; END IF;
  ALTER TABLE supplier_deposits ENABLE TRIGGER sd_validate_po_trg;

  SELECT tgenabled INTO v_en FROM pg_trigger WHERE tgrelid = 'public.supplier_deposits'::regclass AND tgname = 'sd_validate_po_trg';
  IF v_en IS DISTINCT FROM 'O' THEN RAISE EXCEPTION 'ABORT: sd_validate_po_trg is not re-enabled (tgenabled=%)', v_en; END IF;
  SELECT * INTO sd FROM supplier_deposits WHERE id = c_dep;
  IF sd.po_id IS DISTINCT FROM c_po OR sd.pct_of_po IS DISTINCT FROM 50 THEN RAISE EXCEPTION 'ABORT: row not as expected after update %', row_to_json(sd); END IF;
  RAISE NOTICE 'APPLIED: deposit % linked to PO2610-038, pct_of_po = 50; trigger re-enabled', c_dep;
END $$;

SELECT sd.id, sd.expense_id, sd.deposit_invoice_no, sd.po_id, sd.pct_of_po,
       (SELECT tgenabled FROM pg_trigger WHERE tgrelid = 'public.supplier_deposits'::regclass AND tgname = 'sd_validate_po_trg') AS trigger_enabled
  FROM supplier_deposits sd WHERE sd.id = '4b3ff8bc-e8a6-44bf-9b4c-001a6fa2436c';
COMMIT;
