-- Task 3's signup trigger seeds expense_categories from every
-- contractor_type_categories row matching a given contractor_type_id,
-- with no dedup. Nothing currently stops two rows for the same type
-- sharing a name -- today's seed data (verified) has no such
-- duplicates, but a future hand-edit to the template data reintroducing
-- one would fail silently until a real customer's signup hit the
-- expense_categories UNIQUE(tenant_id, name) constraint and broke.
-- This constraint fails loudly at template-data-entry time instead,
-- which is a controlled, admin-only, easily-fixed failure.
ALTER TABLE contractor_type_categories
  ADD CONSTRAINT contractor_type_categories_type_name_key UNIQUE (contractor_type_id, name);
