-- supabase/migrations/2026-08-30-02-seat-limit-statement-level-trigger.sql
-- Closes a batch-insert/batch-update bypass: RLS WITH CHECK is evaluated
-- per-row against a per-statement snapshot, so sibling rows within the SAME
-- multi-row INSERT/UPDATE never see each other's pending changes. Verified
-- live: a single 3-row INSERT of new Ongoing sites, all independently
-- checked against the same pre-statement count, sailed through a max_sites=1
-- cap entirely (each row's tenant_under_seat_limit('sites') call saw 0
-- existing rows, not 0-then-1-then-2). This is directly reachable through
-- the app's own Excel bulk-import feature (ExcelUpload.jsx does a single
-- multi-row .insert(rows)), not just a hypothetical crafted API call.
--
-- Fixed with an AFTER ... FOR EACH STATEMENT trigger (not FOR EACH ROW) that
-- re-validates the aggregate exactly once after the whole batch has already
-- been applied within the same transaction -- if it fails, the entire
-- statement (all rows, not just the offending one) rolls back. Reuses
-- tenant_under_seat_limit() unchanged; no new limit logic. current_tenant_id()
-- inside it correctly resolves to the caller's own tenant regardless of how
-- many rows were touched, since every row in the statement already had to
-- pass tenant_id = current_tenant_id() individually via the per-row RLS
-- check for the statement to get this far at all.
CREATE OR REPLACE FUNCTION check_seat_limit_after_statement()
RETURNS TRIGGER
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public
AS $$
DECLARE
  v_kind TEXT := TG_ARGV[0];
BEGIN
  IF NOT tenant_under_seat_limit(v_kind) THEN
    RAISE EXCEPTION 'Package % limit exceeded for this tenant', v_kind
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END;
$$;

CREATE TRIGGER trg_seat_limit_sites AFTER INSERT OR UPDATE ON sites
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('sites');
CREATE TRIGGER trg_seat_limit_user_roles AFTER INSERT OR UPDATE ON user_roles
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('admins');
CREATE TRIGGER trg_seat_limit_workers AFTER INSERT ON workers
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('workers');
