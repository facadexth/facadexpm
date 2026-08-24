-- Full snapshot history for quotations — every time an existing quotation
-- is edited, the state it had *before* the edit (header fields + items,
-- as one JSONB blob) is written here tagged with the revision number it
-- was at. The live `quotations`/`quotation_items` rows always represent
-- the current (latest) revision — only past revisions live here, so a
-- quotation still on revision 1 has zero rows in this table, not one.
-- client_name is denormalized into the snapshot because the client row
-- itself can be renamed/deleted later and history should still read as
-- it did at the time.
CREATE TABLE quotation_revisions (
  id            UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  quotation_id  UUID NOT NULL REFERENCES quotations(id) ON DELETE CASCADE,
  revision      INTEGER NOT NULL,
  snapshot      JSONB NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id)
);

CREATE INDEX idx_quotation_revisions_quotation_id ON quotation_revisions(quotation_id);
CREATE INDEX idx_quotation_revisions_tenant_id ON quotation_revisions(tenant_id);

ALTER TABLE quotation_revisions ENABLE ROW LEVEL SECURITY;

CREATE POLICY admin_full_access ON quotation_revisions FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('quotations'));
