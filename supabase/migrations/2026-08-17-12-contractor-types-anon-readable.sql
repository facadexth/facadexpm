-- The signup form's contractor-type dropdown fetches contractor_types
-- BEFORE the visitor is authenticated -- supabase-js uses the anon API
-- key and PostgREST evaluates RLS as the `anon` Postgres role at that
-- point, not `authenticated`. The original policy (2026-08-17-07) was
-- scoped `TO authenticated` only, so every real, unauthenticated
-- signup visitor got zero rows back -- an empty, required dropdown
-- that made self-serve signup impossible. Verified live: `SET LOCAL
-- role = 'anon'; SELECT count(*) FROM contractor_types;` returned 0
-- before this fix.
--
-- contractor_types content (trade key, Thai label, sort order) is
-- non-sensitive shared reference data, so widening read access to
-- `anon` is safe -- unlike contractor_type_categories/
-- contractor_type_category_suppliers, which stay authenticated-only
-- (only Settings.jsx, requiring a session, reads them today; the
-- signup trigger itself runs SECURITY DEFINER and bypasses RLS).
DROP POLICY anyone_reads_contractor_types ON contractor_types;
CREATE POLICY anyone_reads_contractor_types ON contractor_types
  FOR SELECT TO anon, authenticated USING (true);
