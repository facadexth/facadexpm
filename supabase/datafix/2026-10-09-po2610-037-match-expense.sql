-- PO2610-037 (ชาญสินทวี, ref 10091410) was cancelled one minute after receiving because the same purchase already existed as
-- expense 8d1547f2 (2026-09-14, 8,234.40, cheque cleared). Verified: sum of PO lines 7,695.70 x 1.07 = 8,234.40.
-- The stock it posted (V-39 5, FC-34 2, FL-50 2, AT-140 2) is real, so keep it and match PO <-> expense instead of reversing:
-- the PO goes back to 'received' and points at the existing expense. Nothing else (stock, balances, cheque) is touched.
-- Guarded: aborts unless every precondition below still holds.
DO $$
DECLARE
  v_po uuid; v_status text; v_exp uuid := '8d1547f2-18c4-4bf0-94a4-ee06a9dcf892'; n int;
BEGIN
  SELECT id, status INTO v_po, v_status FROM purchase_orders WHERE po_number = 'PO2610-037';
  IF v_po IS NULL OR v_status <> 'cancelled' THEN RAISE EXCEPTION 'PO2610-037 missing or not cancelled'; END IF;
  IF EXISTS (SELECT 1 FROM po_receipts WHERE po_id = v_po) THEN RAISE EXCEPTION 'PO has receipts'; END IF;
  SELECT count(*) INTO n FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id = v_po AND movement_type = 'purchase_in';
  IF n <> 4 THEN RAISE EXCEPTION 'expected 4 purchase_in movements, got %', n; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = v_po AND movement_type = 'receipt_reversal') THEN RAISE EXCEPTION 'already reversed'; END IF;
  IF NOT EXISTS (SELECT 1 FROM expenses WHERE id = v_exp AND po_id IS NULL AND amount = 8234.40 AND supplier_id = (SELECT supplier_id FROM purchase_orders WHERE id = v_po)) THEN
    RAISE EXCEPTION 'expense 8d1547f2 not found, already linked, or amount/supplier differs';
  END IF;
  IF EXISTS (SELECT 1 FROM purchase_orders WHERE expense_id = v_exp) THEN RAISE EXCEPTION 'expense already used by another PO'; END IF;

  UPDATE expenses SET po_id = v_po WHERE id = v_exp;
  UPDATE purchase_orders SET status = 'received', received_date = DATE '2026-10-06', expense_id = v_exp WHERE id = v_po;
END $$;
