-- ============================================================
-- site_cost_estimates — per-site budget estimate, one row per real
-- inventory_categories row instead of sites' old 5 fixed cost_* columns.
-- Requested by the tenant: "เอาหมวดหมู่เป็นหลัก โดยที่ไซท์งานให้เลือกจาก
-- หมวดหมู่นี้ แล้วส่งต่อไปที่การตัดสต๊อก" -- make inventory_categories the
-- single source of category names, let the Sites cost-breakdown card pick
-- from that same list, and feed each site's own estimate ratio into that
-- site's stock-deduction default split (Inventory.jsx InvoiceDeductionRow)
-- instead of always falling back to the tenant-wide default.
--
-- The old sites.cost_aluminum/cost_glass/cost_equipment/cost_rubber/
-- cost_other/cost_labor columns and every view that selects them are left
-- completely untouched (still readable, still populated by
-- siteFormToPayload for old callers) -- this is a new, additive table.
-- Sites.jsx's own cost-breakdown UI switches to reading/writing this table
-- instead of those columns; nothing else needs to change.
-- ============================================================

CREATE TABLE site_cost_estimates (
  id                    UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id             UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  site_id               UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  inventory_category_id UUID NOT NULL REFERENCES inventory_categories(id) ON DELETE CASCADE,
  estimated_amount      NUMERIC NOT NULL DEFAULT 0,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (site_id, inventory_category_id)
);

CREATE INDEX idx_site_cost_estimates_tenant_id ON site_cost_estimates(tenant_id);
CREATE INDEX idx_site_cost_estimates_site_id ON site_cost_estimates(site_id);

ALTER TABLE site_cost_estimates ENABLE ROW LEVEL SECURITY;

-- Same gate as inventory_categories itself (this table only makes sense
-- once a tenant has real inventory categories to estimate against).
CREATE POLICY admin_full_access ON site_cost_estimates FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));
