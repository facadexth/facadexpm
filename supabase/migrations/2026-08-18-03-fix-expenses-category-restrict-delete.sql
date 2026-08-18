-- expenses.category_id was ON DELETE SET NULL, but Categories.jsx's own
-- delete dialog promises "ถ้ามีรายจ่ายในหมวดนี้ ระบบจะไม่อนุญาต" (deletion
-- will be blocked if expenses use this category) and its error handler
-- expects a failed delete to mean exactly that. The DB never actually
-- enforced it -- every deletion silently succeeded and orphaned every
-- expense that referenced it instead of being blocked.
--
-- Found live: a user deleted "ค่าใช้จ่ายสำนักงาน" and recreated it,
-- expecting the old expenses to still be tagged (per the dialog's promise)
-- -- instead ~553 expenses now have category_id = NULL with no audit
-- trail of which ones used to belong to it (no trigger on expenses,
-- audit_logs has zero entries for expense_categories deletes), so the
-- data is unrecoverable. purchase_orders.category_id already correctly
-- uses ON DELETE RESTRICT (schema.sql:530) -- this brings expenses in
-- line with that existing pattern.
ALTER TABLE expenses DROP CONSTRAINT expenses_category_id_fkey;
ALTER TABLE expenses ADD CONSTRAINT expenses_category_id_fkey
  FOREIGN KEY (category_id) REFERENCES expense_categories(id) ON DELETE RESTRICT;
