-- supabase/migrations/2026-08-29-15-seat-limit-user-roles-update.sql
-- The real admin-invite flow (UserManagement.jsx) never hits owner_inserts:
-- handle_new_user() (SECURITY DEFINER, bypasses RLS) always creates the
-- user_roles row as WORKER first, then the app's own upsert(onConflict:
-- user_email) resolves as an UPDATE since the row already exists. The
-- previous migration (2026-08-29-14) only gated INSERT, leaving the actual
-- promotion path (WORKER -> ADMIN/OWNER) unenforced. Fixes that here.
--
-- "old.id = user_roles.id" must stay qualified with the outer table name --
-- an unqualified "id" on the right resolves to the subquery's own "old"
-- alias (innermost scope wins), making the EXISTS always true regardless
-- of which row is being updated. Confirmed via live dry-run before this
-- fix: qualifying it was required for the block to actually trigger.
DROP POLICY owner_updates ON user_roles;
CREATE POLICY owner_updates ON user_roles FOR UPDATE TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (
    is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write()
    AND (
      role NOT IN ('OWNER','ADMIN')
      OR EXISTS (SELECT 1 FROM user_roles old WHERE old.id = user_roles.id AND old.role IN ('OWNER','ADMIN'))
      OR tenant_under_seat_limit('admins')
    )
  );
