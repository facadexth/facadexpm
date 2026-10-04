// Modules that are NEVER part of the free-trial "everything is on" grant and are not sold
// in any package: a company only has one if its own row exists in tenant_modules (granted
// by hand). Mirror of the list inside has_module_access() in the database (migration
// 2026-10-04-02) and of EXPLICIT_ONLY_MODULES in supabase/functions/_shared/tenant-access.ts.
//
// 'estimation' (ประเมินราคา / BOM templates) is unfinished and built around FacadeX's own
// workflow, so only FacadeX is granted it. To give it to another company later:
//   INSERT INTO tenant_modules (tenant_id, module_key)
//   SELECT id, 'estimation' FROM tenants WHERE company_name = '...' ON CONFLICT DO NOTHING;
export const EXPLICIT_ONLY_MODULES = ['estimation']

export function trialGrantsModule(moduleKey) {
  return !EXPLICIT_ONLY_MODULES.includes(moduleKey)
}

// Whether a company has a module: core features always; the free trial opens every module
// except the explicit-only ones; otherwise it needs its own grant.
export function companyHasModule(moduleKey, { isTrialActive, enabledModules }) {
  if (!moduleKey) return true
  if (isTrialActive && trialGrantsModule(moduleKey)) return true
  return (enabledModules || []).includes(moduleKey)
}
