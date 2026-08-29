-- supabase/migrations/2026-08-29-06-backfill-legacy-sites-into-quotations.sql
-- Legacy sites (created before the Quotation module existed, mostly via
-- Excel import) never went through a quotation -> accept flow, so they
-- have no quotations row and can't be picked when creating an invoice.
-- 123 sites had no quotation at the time this ran, split three ways:
--
--   1. 22 sites with both a client and a real contract_value_no_vat:
--      given a single retroactive accepted quotation, one lump-sum line
--      item ("งานตามสัญญา") equal to the site's existing
--      contract_value_no_vat. sites.contract_value/contract_value_no_vat
--      are left untouched -- this only adds the paper trail, it doesn't
--      recompute anything.
--   2. 13 sites with no client at all (client_id NOT NULL is required by
--      quotations, so these can't get a quotation yet regardless): given
--      a new placeholder client per site (named after the site, flagged
--      in its notes) so the site record itself isn't left dangling.
--      Still no quotation -- there's no real contract value to bill
--      here either (all 13 happen to be at contract_value_no_vat = 0).
--   3. 88 sites with a client but no (or zero) contract value: marked
--      status = 'Completed' instead -- nothing to retroactively invoice,
--      and this reads as "done, no open billing" rather than sitting
--      forever as an apparently-still-open site with a blank contract.

-- 1. Retroactive quotations for the 22 complete sites.
WITH target_sites AS (
  SELECT s.id, s.client_id, s.contract_value_no_vat, s.has_vat, s.tenant_id,
         COALESCE(s.start_date, s.created_at::date) AS q_date
  FROM sites s
  WHERE NOT EXISTS (SELECT 1 FROM quotations q WHERE q.site_id = s.id)
    AND s.client_id IS NOT NULL
    AND COALESCE(s.contract_value_no_vat, 0) > 0
),
inserted_quotations AS (
  INSERT INTO quotations (client_id, site_id, date, status, has_vat, price_includes_vat, tenant_id)
  SELECT client_id, id, q_date, 'accepted', has_vat, false, tenant_id
  FROM target_sites
  RETURNING id, site_id
)
INSERT INTO quotation_items (quotation_id, description, unit, quantity, unit_price, line_total, sort_order, tenant_id)
SELECT iq.id, 'งานตามสัญญา', 'งาน', 1, ts.contract_value_no_vat, ts.contract_value_no_vat, 0, ts.tenant_id
FROM inserted_quotations iq
JOIN target_sites ts ON ts.id = iq.site_id;

-- 2. Placeholder client per no-client site, linked back via an explicit
-- loop (not a name-based join) so duplicate site names can't cross-wire
-- the wrong client onto the wrong site.
DO $$
DECLARE
  r RECORD;
  new_client_id UUID;
BEGIN
  FOR r IN
    SELECT s.id, s.name, s.tenant_id
    FROM sites s
    WHERE NOT EXISTS (SELECT 1 FROM quotations q WHERE q.site_id = s.id)
      AND s.client_id IS NULL
  LOOP
    INSERT INTO clients (name, notes, tenant_id)
    VALUES (
      r.name,
      'สร้างอัตโนมัติ (ลูกค้าชั่วคราว) จากไซท์ที่ไม่มีลูกค้าผูกไว้ตอนสร้าง -- กรุณาตรวจสอบและแก้ไขข้อมูลลูกค้าจริง',
      r.tenant_id
    )
    RETURNING id INTO new_client_id;

    UPDATE sites SET client_id = new_client_id WHERE id = r.id;
  END LOOP;
END $$;

-- 3. Mark the remaining no-value sites Completed. Excludes any already
-- Completed so this is a no-op re-run, not just a same-value overwrite.
UPDATE sites
SET status = 'Completed'
WHERE id IN (
  SELECT s.id FROM sites s
  WHERE NOT EXISTS (SELECT 1 FROM quotations q WHERE q.site_id = s.id)
    AND s.client_id IS NOT NULL
    AND COALESCE(s.contract_value_no_vat, 0) = 0
)
AND status <> 'Completed';
