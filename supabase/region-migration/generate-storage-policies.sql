-- Generate exact CREATE POLICY DDL for storage.objects from the live pg_policies
-- catalog on Tokyo, rather than replaying the 12 migration files that touch
-- storage.objects (several of which are historical fixes superseding earlier
-- ones). This guarantees the policies actually enforced on Tokyo today.
-- Fix Round 1: USING is only valid for SELECT/UPDATE/DELETE/ALL policies.
-- INSERT-only policies take WITH CHECK only, and Postgres correctly stores
-- qual IS NULL for them. The original COALESCE(qual, 'true') wrongly
-- manufactured a USING (true) on top of that for INSERT-only policies.
-- Guard the USING clause on cmd != 'INSERT'; WITH CHECK logic is unchanged.
SELECT format(
  'CREATE POLICY %I ON storage.objects FOR %s TO %s%s%s;',
  policyname,
  cmd,
  array_to_string(roles, ', '),
  CASE WHEN cmd != 'INSERT' THEN format(' USING (%s)', COALESCE(qual, 'true')) ELSE '' END,
  CASE WHEN with_check IS NOT NULL THEN format(' WITH CHECK (%s)', with_check) ELSE '' END
) AS policy_ddl
FROM pg_policies
WHERE schemaname = 'storage' AND tablename = 'objects'
ORDER BY policyname;
