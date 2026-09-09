-- ============================================================
-- inventory_categories.use_for_cost_deduction — lets a tenant tick which
-- categories actually participate in the site cost-estimate breakdown
-- (Sites.jsx) and the stock-deduction % split (Inventory.jsx), while
-- still keeping every category available for tagging inventory items.
-- Requested by the tenant: "หมวดหมู่ ให้ tick ว่าจะเอาหมวดไหนไปคิดเป็น
-- ต้นทุนและไปตัดสต๊อกบ้าง" -- categories with the box unticked simply
-- drop out of the cost/deduction math, they don't disappear from the
-- item-category picker.
-- Defaults to true so every existing category keeps behaving exactly
-- as it does today until someone unticks it.
-- ============================================================

ALTER TABLE inventory_categories
  ADD COLUMN use_for_cost_deduction BOOLEAN NOT NULL DEFAULT true;
