-- PO2610-039 (cancelled, replaced by the new per-delivery flow): remove its +20 GL-0453 stock.
-- Adds an offsetting receipt_reversal movement (history kept) and brings the balance 20 -> 0.
-- Guarded: aborts unless the PO is cancelled, the movement is the only one and the balance is exactly 20.
DO $$
DECLARE
  v_po uuid; v_mv stock_movements%ROWTYPE; v_bal inventory_stock_balances%ROWTYPE;
BEGIN
  SELECT id INTO v_po FROM purchase_orders WHERE po_number = 'PO2610-039' AND status = 'cancelled';
  IF v_po IS NULL THEN RAISE EXCEPTION 'PO2610-039 not found or not cancelled'; END IF;
  SELECT * INTO v_mv FROM stock_movements WHERE reference_type = 'purchase_order' AND reference_id = v_po;
  IF NOT FOUND OR v_mv.quantity <> 20 THEN RAISE EXCEPTION 'expected exactly one +20 movement'; END IF;
  IF EXISTS (SELECT 1 FROM stock_movements WHERE reference_id = v_po AND movement_type = 'receipt_reversal') THEN
    RAISE EXCEPTION 'already reversed';
  END IF;
  SELECT * INTO v_bal FROM inventory_stock_balances
   WHERE inventory_item_id = v_mv.inventory_item_id AND site_id = v_mv.site_id FOR UPDATE;
  IF v_bal.quantity_on_hand <> 20 THEN RAISE EXCEPTION 'balance is % not 20', v_bal.quantity_on_hand; END IF;

  INSERT INTO stock_movements (tenant_id, inventory_item_id, site_id, movement_type, quantity, unit_cost,
                               reference_type, reference_id, notes)
  VALUES (v_mv.tenant_id, v_mv.inventory_item_id, v_mv.site_id, 'receipt_reversal', -20, v_mv.unit_cost,
          'purchase_order', v_po, 'PO2610-039 ยกเลิก (ใบซ้ำ ใช้วิธีใบกำกับต่อการส่งของแทน) - ล้างสต็อกตามเจ้าของ 2026-10-09');
  UPDATE inventory_stock_balances SET quantity_on_hand = 0, updated_at = now() WHERE id = v_bal.id;
END $$;
