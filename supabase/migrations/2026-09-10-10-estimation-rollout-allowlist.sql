-- Restrict the brand-new 'estimation' module (BOM Template Engine, built
-- today) to an explicit tenant allowlist instead of a tier-wide grant.
-- It was previously granted to every Pro Team/Business/Enterprise tenant
-- via package_modules, which auto-grants it to any tenant on those tiers
-- -- including real customers who haven't been introduced to this
-- feature yet. Narrow to direct tenant_modules grants only (owner's own
-- tenant + the QA test account), and drop the tier-wide default so new
-- signups on those tiers don't get it automatically either. To add
-- another test tenant later, grant it the same way:
--   INSERT INTO tenant_modules (tenant_id, module_key)
--   SELECT id, 'estimation' FROM tenants WHERE company_name = '...'
--   ON CONFLICT (tenant_id, module_key) DO NOTHING;
DELETE FROM package_modules WHERE module_key = 'estimation';

DELETE FROM tenant_modules
WHERE module_key = 'estimation'
  AND tenant_id NOT IN (
    SELECT id FROM tenants
    WHERE company_name IN ('บริษัท ฟาซาด เอ๊กซ์ จำกัด', 'qatest-proteam-owner@facadex.co.th')
  );
