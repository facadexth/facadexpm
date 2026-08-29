-- supabase/migrations/2026-08-30-04-revoke-trigger-fn-execute.sql
-- check_seat_limit_after_statement() is a trigger function (RETURNS
-- TRIGGER), never meant to be called directly -- Postgres itself already
-- blocks invoking it outside a trigger context ("trigger functions can
-- only be called as triggers"), so this isn't exploitable, but every other
-- SECURITY DEFINER function added this session got an explicit REVOKE/GRANT
-- and this one was missed. Closes a security-advisor warning and matches
-- the established pattern.
REVOKE EXECUTE ON FUNCTION check_seat_limit_after_statement() FROM PUBLIC, anon, authenticated;
