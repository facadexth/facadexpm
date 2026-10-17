-- Three central-stock cards whose average cost (not quantity) differs from
-- their own ledger (found 2026-10-17 by a full replay, total ~12 baht):
--   AL-0282, SL-0028  IN2601-001's re-cut was back-dated to 6 Jan, before
--                     later purchases, but the running maths used today's
--                     state (fixed for new cuts by migration 2026-10-17-10)
--   GL-0453           the 2026-10-09 PO2610-039 clean-up returned the qty
--                     but left the average cost of the cancelled receipt
-- Sets each card's WAC to its ledger replay. Needs migration 2026-10-17-10.
DO $$
DECLARE
  v_tenant uuid := '1b9affc4-2136-4ed1-b168-a36e6624e743';
  v_bad int; v_codes text; v_n int;
BEGIN
  CREATE TEMP TABLE fix_wac ON COMMIT DROP AS
  SELECT b.inventory_item_id, b.site_id, ii.code, b.quantity_on_hand, b.weighted_average_cost, r.qty, r.wac
  FROM inventory_stock_balances b
  JOIN inventory_items ii ON ii.id = b.inventory_item_id
  CROSS JOIN LATERAL _replay_stock_balance(b.inventory_item_id, b.site_id) r
  WHERE b.tenant_id = v_tenant
    AND (abs(r.qty - b.quantity_on_hand) > 0.0001 OR abs(r.wac - b.weighted_average_cost) > 0.0001);

  SELECT count(*) FILTER (WHERE abs(qty - quantity_on_hand) > 0.0001), string_agg(code, ',' ORDER BY code) INTO v_bad, v_codes FROM fix_wac;
  IF v_bad > 0 THEN RAISE EXCEPTION 'ABORT: % cards differ in quantity, not just cost', v_bad; END IF;
  IF v_codes IS DISTINCT FROM 'AL-0282,GL-0453,SL-0028' THEN RAISE EXCEPTION 'ABORT: expected AL-0282,GL-0453,SL-0028, found %', v_codes; END IF;

  UPDATE inventory_stock_balances b SET weighted_average_cost = f.wac, updated_at = now()
    FROM fix_wac f WHERE b.inventory_item_id = f.inventory_item_id AND b.site_id = f.site_id;
  GET DIAGNOSTICS v_n = ROW_COUNT;
  RAISE NOTICE 'FIXED % cards: %', v_n, v_codes;
END $$;
