-- supabase/migrations/2026-08-29-09-remove-duplicate-incomes.sql
-- Two sites had genuinely duplicated income entries (confirmed with the
-- user before deleting anything):
--
--   1. ส่วนกลาง (ca371c71-4869-44be-926c-2d81a188d935): the same car sale
--      ("ขายรถยนต์ ทะเบียน 1ขฎ4525", 450,000 no-vat) entered twice, one
--      day apart, identical in every field. Kept the earlier row.
--
--   2. โครงการศูนย์เวชศาสตร์นิวเคลียร์และศูนย์รังษีรักษา
--      (a1e320c2-80a2-4794-8af4-53cfb9bc08d9): each of its 2 real
--      milestone payments was entered TWICE under different labels
--      ("ค่าสินค้าและบริการ งวดที่ N" and "ส่งงานครั้งที่ N", ~2 weeks
--      apart, identical amounts) -- 4 rows for what were really 2
--      payments. Kept the earlier-dated row of each pair.
--
-- This site had already been backfilled by 2026-08-29-07 using all 4
-- rows, so its retroactive invoices/receipts/ledger were rebuilt from
-- scratch using only the 2 surviving real income rows -- not a surgical
-- patch, since cumulative_pct is sequential and a partial removal from
-- the middle of the chain can't be done safely otherwise.
DELETE FROM incomes WHERE id = 'fd2b1fd8-04af-4051-a63d-c025ff6dae2b';

UPDATE incomes SET source_invoice_id = NULL WHERE site_id = 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9';
DELETE FROM incomes WHERE id IN ('fb1ed946-a11e-4308-bd18-4bd71a3a87e9', 'a7598d60-7f4b-4e9a-a3fc-98fe6d69b1b2');
DELETE FROM receipts WHERE invoice_id IN (SELECT id FROM invoices WHERE site_id = 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9');
DELETE FROM invoices WHERE site_id = 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9';

UPDATE quotation_item_units SET cumulative_pct = 0, updated_at = now() WHERE id = '7d706559-6980-440c-bcbf-731589b2bace';

DO $$
DECLARE
  q_rec RECORD;
  unit_id UUID := '7d706559-6980-440c-bcbf-731589b2bace';
  cum_pct NUMERIC := 0;
  income_rec RECORD;
  target_pct NUMERIC;
  new_invoice_id UUID;
  new_invoice_item_id UUID;
  invoice_total NUMERIC;
BEGIN
  SELECT q.id AS quotation_id, qi.id AS quotation_item_id, qi.unit_price, qi.unit, qi.description, q.has_vat, s.tenant_id
  INTO q_rec
  FROM quotations q
  JOIN quotation_items qi ON qi.quotation_id = q.id
  JOIN sites s ON s.id = q.site_id
  WHERE q.site_id = 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9' AND q.status = 'accepted';

  FOR income_rec IN
    SELECT id, amount_no_vat, vat, date FROM incomes
    WHERE site_id = 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9'
    ORDER BY date, created_at
  LOOP
    target_pct := LEAST(100, cum_pct + (income_rec.amount_no_vat / q_rec.unit_price * 100));
    invoice_total := round(income_rec.amount_no_vat + COALESCE(income_rec.vat, 0), 2);

    INSERT INTO invoices (quotation_id, site_id, date, status, has_vat, price_includes_vat,
                           subtotal, vat, total, paid_date, tenant_id)
    VALUES (q_rec.quotation_id, 'a1e320c2-80a2-4794-8af4-53cfb9bc08d9', income_rec.date, 'paid', q_rec.has_vat, false,
            round(income_rec.amount_no_vat, 2), round(COALESCE(income_rec.vat, 0), 2), invoice_total,
            income_rec.date, q_rec.tenant_id)
    RETURNING id INTO new_invoice_id;

    INSERT INTO invoice_items (invoice_id, quotation_item_id, description, unit, unit_price, draw_qty, line_total, sort_order, tenant_id)
    VALUES (new_invoice_id, q_rec.quotation_item_id, q_rec.description, q_rec.unit, q_rec.unit_price,
            (target_pct - cum_pct) / 100, round(income_rec.amount_no_vat, 2), 0, q_rec.tenant_id)
    RETURNING id INTO new_invoice_item_id;

    INSERT INTO invoice_item_draws (invoice_item_id, quotation_item_unit_id, prior_pct, target_pct, amount, tenant_id)
    VALUES (new_invoice_item_id, unit_id, cum_pct, target_pct, round(income_rec.amount_no_vat, 2), q_rec.tenant_id);

    UPDATE quotation_item_units SET cumulative_pct = target_pct, updated_at = now() WHERE id = unit_id;

    INSERT INTO receipts (invoice_id, date, amount, tenant_id)
    VALUES (new_invoice_id, income_rec.date, invoice_total, q_rec.tenant_id);

    UPDATE invoices SET income_id = income_rec.id WHERE id = new_invoice_id;
    UPDATE incomes SET source_invoice_id = new_invoice_id WHERE id = income_rec.id;

    cum_pct := target_pct;
  END LOOP;
END $$;
