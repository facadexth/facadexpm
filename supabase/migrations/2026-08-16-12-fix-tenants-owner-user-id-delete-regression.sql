-- tenants.owner_user_id NOT NULL REFERENCES auth.users(id) (no ON DELETE
-- action = RESTRICT) combined with the pre-existing handle_user_role_deleted
-- trigger (which auto-deletes the matching auth.users row whenever its
-- user_roles row is deleted) created a real regression: deleting the
-- user_roles row of whoever created a tenant now fails with a raw FK
-- violation via UserManagement.jsx's "delete user" admin action, since the
-- auth.users delete is blocked while tenants.owner_user_id still points at
-- it. Discovered live while cleaning up a Task 8 test signup, not from any
-- task's diff — owner_user_id is pure bookkeeping (who created the tenant),
-- never read by any RLS policy or app query, so relaxing it is safe.
--
-- Verified live via disposable fixture: insert an auth.users row (fires
-- handle_new_user, creating its own tenant+OWNER), delete that user_roles
-- row, confirm no FK error, confirm the tenant's owner_user_id is NULL and
-- the auth.users row is gone (cascaded by the pre-existing trigger).
ALTER TABLE tenants ALTER COLUMN owner_user_id DROP NOT NULL;
ALTER TABLE tenants DROP CONSTRAINT tenants_owner_user_id_fkey;
ALTER TABLE tenants ADD CONSTRAINT tenants_owner_user_id_fkey
  FOREIGN KEY (owner_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;
