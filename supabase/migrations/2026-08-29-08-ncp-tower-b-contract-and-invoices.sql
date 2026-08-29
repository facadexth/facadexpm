-- supabase/migrations/2026-08-29-08-ncp-tower-b-contract-and-invoices.sql
-- NCP TOWER B (d974da1d-e597-4f3f-8b42-1eee712caa5b) was excluded from
-- 2026-08-29-07 because it had received more money (5,275,792 pre-VAT)
-- than its recorded contract (3,341,900) allowed. Per explicit
-- instruction, raise the contract value to match money actually
-- received, then run the same per-income-row retroactive invoice
-- backfill 2026-08-29-07 used for the other 24 sites.

-- 1. Raise the contract value (both the site record and its existing
-- quotation_items row) to match total income received.
UPDATE sites
SET contract_value_no_vat = 5275792.00,
    contract_value = 5645097.44 -- 5,275,792 * 1.07 (has_vat = true)
WHERE id = 'd974da1d-e597-4f3f-8b42-1eee712caa5b';

UPDATE quotation_items
SET unit_price = 5275792.00, line_total = 5275792.00
WHERE id = '2813bbe5-7a6d-4258-a22a-cb73652cee9f';

-- 2. Same per-income-row backfill as 2026-08-29-07 Part 2, scoped to this
-- one site.
DO $$
DECLARE
  site_rec RECORD;
  q_rec RECORD;
  unit_id UUID;
  cum_pct NUMERIC;
  income_rec RECORD;
  target_pct NUMERIC;
  new_invoice_id UUID;
  new_invoice_item_id UUID;
  invoice_total NUMERIC;
BEGIN
  FOR site_rec IN
    SELECT id, tenant_id FROM sites WHERE id = 'd974da1d-e597-4f3f-8b42-1eee712caa5b'
  LOOP
    SELECT q.id AS quotation_id, qi.id AS quotation_item_id, qi.unit_price, qi.unit, qi.description, q.has_vat
    INTO q_rec
    FROM quotations q JOIN quotation_items qi ON qi.quotation_id = q.id
    WHERE q.site_id = site_rec.id AND q.status = 'accepted'
    ORDER BY q.created_at LIMIT 1;

    INSERT INTO quotation_item_units (quotation_item_id, unit_index, unit_qty, cumulative_pct, tenant_id)
    VALUES (q_rec.quotation_item_id, 0, 1, 0, site_rec.tenant_id)
    ON CONFLICT (quotation_item_id, unit_index) DO NOTHING
    RETURNING id INTO unit_id;
    IF unit_id IS NULL THEN
      SELECT id INTO unit_id FROM quotation_item_units WHERE quotation_item_id = q_rec.quotation_item_id AND unit_index = 0;
    END IF;

    SELECT cumulative_pct INTO cum_pct FROM quotation_item_units WHERE id = unit_id;

    FOR income_rec IN
      SELECT id, amount_no_vat, vat, date FROM incomes
      WHERE site_id = site_rec.id AND source_invoice_id IS NULL
      ORDER BY date, created_at
    LOOP
      target_pct := LEAST(100, cum_pct + (income_rec.amount_no_vat / q_rec.unit_price * 100));
      invoice_total := round(income_rec.amount_no_vat + COALESCE(income_rec.vat, 0), 2);

      INSERT INTO invoices (quotation_id, site_id, date, status, has_vat, price_includes_vat,
                             subtotal, vat, total, paid_date, tenant_id)
      VALUES (q_rec.quotation_id, site_rec.id, income_rec.date, 'paid', q_rec.has_vat, false,
              round(income_rec.amount_no_vat, 2), round(COALESCE(income_rec.vat, 0), 2), invoice_total,
              income_rec.date, site_rec.tenant_id)
      RETURNING id INTO new_invoice_id;

      INSERT INTO invoice_items (invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, tenant_id)
      VALUES (new_invoice_id, q_rec.quotation_item_id, q_rec.description, q_rec.unit, q_rec.unit_price,
              (target_pct - cum_pct) / 100, round(income_rec.amount_no_vat, 2), 0, site_rec.tenant_id)
      RETURNING id INTO new_invoice_item_id;

      INSERT INTO invoice_item_draws (invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount, tenant_id)
      VALUES (new_invoice_item_id, unit_id, cum_pct, target_pct, round(income_rec.amount_no_vat, 2), site_rec.tenant_id);

      UPDATE quotation_item_units SET cumulative_pct = target_pct, updated_at = now() WHERE id = unit_id;

      INSERT INTO receipts (invoice_id, date, amount, tenant_id)
      VALUES (new_invoice_id, income_rec.date, invoice_total, site_rec.tenant_id);

      UPDATE invoices SET income_id = income_rec.id WHERE id = new_invoice_id;
      UPDATE incomes SET source_invoice_id = new_invoice_id WHERE id = income_rec.id;

      cum_pct := target_pct;
    END LOOP;
  END LOOP;
END $$;
