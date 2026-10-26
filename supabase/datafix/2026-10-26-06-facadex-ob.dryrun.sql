-- DRY RUN copy: identical body, ends in ROLLBACK (nothing is kept).
-- FacadeX adoption opening document OB2601-001 (FIFO + MO/OB stock documents, task 12).
-- Run AFTER migration 2026-10-26-01 (OB doc type + attachment_path) and the task-11
-- switch-over. Run the .dryrun.sql copy first: same body inside BEGIN .. ROLLBACK.
--
-- BEFORE THE REAL RUN (controller):
--   * run scripts/verify-opening-vs-source.mjs against ยอดยกมาต้นปี_2569.xlsx and a CSV
--     of the opening movements -> zero mismatches (or every one explained);
--   * upload the source PDF (main checkout: DOC/สต๊อก  31-12-2025 ล่าสุด(1).pdf) to the
--     storage bucket at  stock-documents/facadex/OB2601-001-stock-20251231.pdf
--     (the attachment_path set below; this file does not upload anything).
--
-- What it does, FacadeX tenant only (1b9affc4-2136-4ed1-b168-a36e6624e743):
--   1. Guards: the tenant has exactly 725 opening movements (reference_type
--      'opening_balance'), all movement_type 'adjustment', and none of them is linked to
--      some OTHER stock document already. Any surprise RAISEs and aborts everything.
--   2. Issues the OB document through _issue_stock_document(tenant, NULL, 'OB',
--      2026-01-01, 'datafix 2026-10-26') -- the function numbers it (OB + YYMM of the
--      doc date + running number). No OB exists yet, so it must come back as
--      OB2601-001; anything else RAISEs. On a re-run the function returns the
--      existing OB (one invoice-less OB per tenant), so nothing new is created.
--   3. Sets attachment_path (only while it is still NULL).
--   4. Links every opening movement to the OB: stock_document_id = OB id, only where
--      stock_document_id IS NULL (re-runnable). Quantities, costs, dates untouched.
--      Real purchases ('jan26_backfill' / 'feb26_backfill' ...) are never touched.
--   5. Verification result set (read it before COMMIT goes through):
--        ob_row               the OB as stored
--        linked_opening       opening movements linked to the OB      (expect 725)
--        unlinked_opening     opening movements with no document      (expect 0)
--        non_opening_linked   NON-opening movements linked to the OB  (expect 0)
--      plus a RAISE inside the DO block if the linked count is not 725 or a
--      non-opening row points at the OB, so a bad state can never commit.
--
-- Wrapped in an explicit BEGIN; .. COMMIT; so it stays atomic through a runner that
-- splits statements.

BEGIN;

DO $$
DECLARE
  c_tenant   constant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  c_path     constant text := 'stock-documents/facadex/OB2601-001-stock-20251231.pdf';
  v_ob       uuid;
  v_number   text;
  v_existed  boolean;
  v_count    int;
  v_bad      int;
BEGIN
  -- ---- 1. guards -----------------------------------------------------------
  SELECT count(*) INTO v_count
  FROM stock_movements
  WHERE tenant_id = c_tenant AND reference_type = 'opening_balance';
  IF v_count <> 725 THEN
    RAISE EXCEPTION 'expected 725 opening_balance movements for FacadeX, found %', v_count;
  END IF;

  SELECT count(*) INTO v_bad
  FROM stock_movements
  WHERE tenant_id = c_tenant AND reference_type = 'opening_balance'
    AND movement_type <> 'adjustment';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% opening_balance movements are not adjustments', v_bad;
  END IF;

  -- an opening row already pointing at a document that is not an OB of this tenant
  SELECT count(*) INTO v_bad
  FROM stock_movements m
  LEFT JOIN stock_documents d ON d.id = m.stock_document_id
  WHERE m.tenant_id = c_tenant AND m.reference_type = 'opening_balance'
    AND m.stock_document_id IS NOT NULL
    AND (d.id IS NULL OR d.doc_type <> 'OB' OR d.tenant_id <> c_tenant OR d.invoice_id IS NOT NULL);
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% opening_balance movements are already linked to another document', v_bad;
  END IF;

  -- ---- 2. issue (or find) the OB -------------------------------------------
  v_existed := EXISTS (
    SELECT 1 FROM stock_documents
    WHERE tenant_id = c_tenant AND doc_type = 'OB' AND invoice_id IS NULL);

  v_ob := _issue_stock_document(c_tenant, NULL, 'OB', DATE '2026-01-01', 'datafix 2026-10-26');

  SELECT doc_number INTO v_number FROM stock_documents WHERE id = v_ob;
  IF v_number IS DISTINCT FROM 'OB2601-001' THEN
    RAISE EXCEPTION 'OB document came back as % (existed before: %), expected OB2601-001',
      v_number, v_existed;
  END IF;

  -- ---- 3. attachment -------------------------------------------------------
  UPDATE stock_documents
  SET attachment_path = c_path
  WHERE id = v_ob AND attachment_path IS NULL;

  -- ---- 4. link the opening movements ---------------------------------------
  UPDATE stock_movements
  SET stock_document_id = v_ob
  WHERE tenant_id = c_tenant
    AND reference_type = 'opening_balance'
    AND stock_document_id IS NULL;

  -- ---- post-checks ---------------------------------------------------------
  SELECT count(*) INTO v_count
  FROM stock_movements
  WHERE stock_document_id = v_ob AND reference_type = 'opening_balance';
  IF v_count <> 725 THEN
    RAISE EXCEPTION 'expected 725 opening movements linked to OB2601-001, got %', v_count;
  END IF;

  SELECT count(*) INTO v_bad
  FROM stock_movements
  WHERE stock_document_id = v_ob
    AND reference_type IS DISTINCT FROM 'opening_balance';
  IF v_bad > 0 THEN
    RAISE EXCEPTION '% NON-opening movements are linked to OB2601-001', v_bad;
  END IF;

  RAISE NOTICE 'OB2601-001 id % (existed before: %), % opening movements linked',
    v_ob, v_existed, v_count;
END
$$;

-- ===== VERIFICATION ==========================================================
WITH ob AS (
  SELECT * FROM stock_documents
  WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'
    AND doc_type = 'OB' AND invoice_id IS NULL
)
SELECT 'ob_row' AS check_name,
       NULL::bigint AS n,
       NULL::bigint AS expected,
       format('id=%s number=%s date=%s invoice_id=%s created_by=%s attachment_path=%s',
              ob.id, ob.doc_number, ob.doc_date, coalesce(ob.invoice_id::text, 'NULL'),
              ob.created_by, ob.attachment_path) AS detail
FROM ob
UNION ALL
SELECT 'linked_opening',
       (SELECT count(*) FROM stock_movements m, ob
        WHERE m.stock_document_id = ob.id AND m.reference_type = 'opening_balance'),
       725, NULL
UNION ALL
SELECT 'unlinked_opening',
       (SELECT count(*) FROM stock_movements
        WHERE tenant_id = '1b9affc4-2136-4ed1-b168-a36e6624e743'
          AND reference_type = 'opening_balance' AND stock_document_id IS NULL),
       0, NULL
UNION ALL
SELECT 'non_opening_linked',
       (SELECT count(*) FROM stock_movements m, ob
        WHERE m.stock_document_id = ob.id
          AND m.reference_type IS DISTINCT FROM 'opening_balance'),
       0, NULL;

ROLLBACK;
