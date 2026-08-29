-- supabase/migrations/2026-08-29-07-backfill-invoices-from-existing-income.sql
-- Sites that already have real money recorded in `incomes` (entered
-- directly via the รายรับ page, before the Invoice module existed) had no
-- matching `invoices`/`receipts` row and couldn't show a proper document
-- trail. This creates one retroactive invoice PER EXISTING INCOME ROW
-- (not one per site) -- matching the schema's own 1:1:1
-- invoice<->receipt<->income design already in place for the live
-- mark-paid flow, applied in chronological order per site so the
-- quotation_item_units ledger accumulates correctly.
--
-- Excluded from this run (left for manual handling):
--   - NCP TOWER B INTERIOR & EXTERIOR (d974da1d-e597-4f3f-8b42-1eee712caa5b):
--     received 5.16M against a recorded contract of only 3.34M -- more
--     than the ledger's 100% cap allows, needs the contract value
--     corrected by a human first.
--   - ส่วนกลาง (ca371c71-4869-44be-926c-2d81a188d935): its only income
--     rows are "ขายรถยนต์ ทะเบียน 1ขฎ4525" (a company car sale) -- not
--     project billing, so this is not a case of untracked construction
--     income at all and creating a "งานตามสัญญา" quotation for it would
--     misrepresent an unrelated income entry as invoiced project work.
--
-- Part 1: 14 sites that had income but never had ANY contract value on
-- record -- give them a retroactive accepted quotation, single lump-sum
-- line ("งานตามสัญญา") sized to the sum of their existing income's
-- pre-VAT amounts (the only real number available for them).
DO $$
DECLARE
  site_rec RECORD;
  new_quotation_id UUID;
BEGIN
  FOR site_rec IN
    SELECT s.id, s.client_id, s.has_vat, s.tenant_id, s.start_date, s.created_at,
           (SELECT sum(i.amount_no_vat) FROM incomes i WHERE i.site_id = s.id) AS total_no_vat,
           (SELECT min(i.date) FROM incomes i WHERE i.site_id = s.id) AS earliest_income_date
    FROM sites s
    WHERE s.id = ANY(ARRAY[
      '7c6b7955-e8c6-4d01-a2c4-6eb3e1f159e2', -- ELSY - สุรินทร์
      'da2426eb-7b05-42b7-b9cb-abce3d7d65d8', -- PLAN MOTIF - คอร์ดแบดมินตัน
      '47dabdc6-ae11-4591-9c60-2f7a61138827', -- Bon Mache - Zone A
      '23b562ca-0358-47bf-9d4a-5c166afab1b2', -- Vaspace - Kronos
      '2a34859d-4fc5-403b-918c-d68e3d720da2', -- Retail - Line
      '00abc381-243c-4708-a07a-0a2f93c69913', -- พราว - มหิดล ศาลายา
      '033f13d5-ae73-4f7e-b03d-36841dffc072', -- Scheme - พี่ยศ ทองหล่อ
      'adcba196-cadc-489b-92d7-0d2db47e192a', -- J auto - TIT Tower
      'f61bcdca-61a6-4b0a-9d02-f5870c2652b8', -- THE NEST PROPERTY - ประชาชื่น 6
      '44786fb8-e6fe-4a50-93c0-c744c6d407d4', -- Charnakorn - VNT
      '6602d63f-8a63-405b-a1a1-2433b5e19848', -- MXE - Novotel
      'd956cfc9-7fc0-414b-aba4-7fea090b3a93', -- THE ROOM ตากสิน
      'cede6dcc-5c17-4a5d-bce5-b822ec9c8db8', -- Ananda - Artale
      'a737d5d2-7f83-4a93-80f6-4eedbb538492'  -- อาเรลอน เอ็นจิเนียริ่ง พี่เจ็ท - ทองหล่อ
    ]::uuid[])
  LOOP
    INSERT INTO quotations (client_id, site_id, date, status, has_vat, price_includes_vat, tenant_id)
    VALUES (
      site_rec.client_id, site_rec.id,
      COALESCE(site_rec.earliest_income_date, site_rec.start_date, site_rec.created_at::date),
      'accepted', site_rec.has_vat, false, site_rec.tenant_id
    )
    RETURNING id INTO new_quotation_id;

    INSERT INTO quotation_items (quotation_id, description, unit, quantity, unit_price, line_total, sort_order, tenant_id)
    VALUES (new_quotation_id, 'งานตามสัญญา', 'งาน', 1, site_rec.total_no_vat, site_rec.total_no_vat, 0, site_rec.tenant_id);
  END LOOP;
END $$;

-- Part 2: for every qualifying site (the 14 just quotationed above, plus
-- the 10 that already had a quotation from the previous backfill), walk
-- its income rows oldest-first and create one invoice/invoice_item/draw
-- per row, accumulating cumulative_pct on the site's single lump-sum
-- unit exactly like the live mark-paid flow would. target_pct is left
-- unrounded (matching the fix already applied to waterfall() -- rounding
-- here would silently lose baht on large contracts).
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
    SELECT id, tenant_id FROM sites WHERE id = ANY(ARRAY[
      -- already had a quotation before this migration
      'a1e320c2-80a2-4794-8af4-53cfb9bc08d9', -- โครงการศูนย์เวชศาสตร์นิวเคลียร์และศูนย์รังษีรักษา
      'b20b514b-0859-43b2-98ad-e558011eed04', -- BORG WARNER OFFICE
      'f0ff1b09-3cfa-4d6f-ba7b-a0291f20fcab', -- WELLFIT ศรีนคริน
      '4f76a6a6-ad86-4380-af64-46c8993e69a6', -- KAYAKI EMQ
      'c4d98532-d3d9-4e7c-b8b1-3afe9bd7f9db', -- Serene KM.8
      '79c37e30-f2ab-4da3-8922-62652ebcc274', -- บ้านปูน สระบุรี
      '7235a571-8ec9-44c6-8261-09ee5f0afcc7', -- บ้านเอ็น 59
      '6ef1755c-3961-49a9-9996-0d74e085e8b2', -- ครัวกลาง
      '1aeb910c-c264-4a3e-9456-01426dcb70ef', -- งานประตูหน้าต่าง อลูมิเนียมสโมสร-ป้อมยาม โครงการเดอะเนสท์ทาวน์ประชาชื่น6
      '627ec8ea-c31d-4b28-b631-5fbc50a7df1f', -- KAY SKV 49
      -- quotationed in Part 1 above
      '7c6b7955-e8c6-4d01-a2c4-6eb3e1f159e2', 'da2426eb-7b05-42b7-b9cb-abce3d7d65d8',
      '47dabdc6-ae11-4591-9c60-2f7a61138827', '23b562ca-0358-47bf-9d4a-5c166afab1b2',
      '2a34859d-4fc5-403b-918c-d68e3d720da2', '00abc381-243c-4708-a07a-0a2f93c69913',
      '033f13d5-ae73-4f7e-b03d-36841dffc072', 'adcba196-cadc-489b-92d7-0d2db47e192a',
      'f61bcdca-61a6-4b0a-9d02-f5870c2652b8', '44786fb8-e6fe-4a50-93c0-c744c6d407d4',
      '6602d63f-8a63-405b-a1a1-2433b5e19848', 'd956cfc9-7fc0-414b-aba4-7fea090b3a93',
      'cede6dcc-5c17-4a5d-bce5-b822ec9c8db8', 'a737d5d2-7f83-4a93-80f6-4eedbb538492'
    ]::uuid[])
  LOOP
    SELECT q.id AS quotation_id, qi.id AS quotation_item_id, qi.unit_price, qi.unit, qi.description, q.has_vat
    INTO q_rec
    FROM quotations q
    JOIN quotation_items qi ON qi.quotation_id = q.id
    WHERE q.site_id = site_rec.id AND q.status = 'accepted'
    ORDER BY q.created_at LIMIT 1;

    -- Seed the single unit for this lump-sum item (quantity=1 is
    -- "countable" per isCountable() -- exactly one unit row), matching
    -- buildUnitSeedRows() exactly so the app's own lazy-seed path sees
    -- this as already seeded, not something to seed again.
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
