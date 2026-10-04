-- 'estimation' (ประเมินราคา / BOM templates) is unfinished and specific to FacadeX, so it is
-- visible to FacadeX only. Two things used to hand it to other companies:
--   1. the free trial: has_module_access() answered "yes" to EVERY module while a company's
--      trial was running, so every new sign-up saw the tab;
--   2. the Business and Enterprise packages, which listed it (migration 2026-10-01-03).
-- Both are closed here. A company now has it only through its own tenant_modules row (FacadeX
-- and the qatest-proteam test account today). The RLS policies on the estimation tables call
-- has_module_access('estimation'), so the database enforces this too, not just the menu.
--
-- Keep the list below in step with src/lib/modules.js and
-- supabase/functions/_shared/tenant-access.ts. To grant it to another company later:
--   INSERT INTO tenant_modules (tenant_id, module_key)
--   SELECT id, 'estimation' FROM tenants WHERE company_name = '...' ON CONFLICT DO NOTHING;

DELETE FROM package_modules WHERE module_key = 'estimation';

-- Anything handed out by the package sync that is not one of the two intended holders.
DELETE FROM tenant_modules
WHERE module_key = 'estimation'
  AND tenant_id NOT IN (
    SELECT id FROM tenants
    WHERE company_name IN ('บริษัท ฟาซาด เอ๊กซ์ จำกัด', 'qatest-proteam-owner@facadex.co.th')
  );

CREATE OR REPLACE FUNCTION public.has_module_access(p_module_key text)
 RETURNS boolean
 LANGUAGE sql
 STABLE SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
  SELECT COALESCE(
    ((SELECT trial_ends_at > now() FROM tenants WHERE id = current_tenant_id())
       AND p_module_key <> ALL (ARRAY['estimation']))
    OR EXISTS (
      SELECT 1 FROM tenant_modules
      WHERE tenant_id = current_tenant_id() AND module_key = p_module_key
    ),
    false
  );
$function$;

-- Same grants as before (signed-in users and the server, never anon).
REVOKE ALL ON FUNCTION public.has_module_access(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.has_module_access(text) TO authenticated, service_role;
