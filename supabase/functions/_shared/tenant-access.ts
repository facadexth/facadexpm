// _shared/tenant-access.ts — tenant-id-scoped module entitlement check,
// callable from a service-role Edge Function with NO caller JWT/session
// (LINE's webhook calls us directly, not through an authenticated app
// user, so the RLS helper has_module_access(TEXT) is unusable here: it
// resolves the tenant from current_tenant_id(), which reads JWT claims
// that simply don't exist for a service-role client, and its EXECUTE
// grant is REVOKEd from anon/public anyway -- see
// 2026-08-16-13-lock-down-tenant-helper-functions.sql).
//
// Mirrors has_module_access()'s exact logic (trial_ends_at > now() OR a
// tenant_modules row for this key) against the same two tables, just
// parameterized by tenant_id instead of reading it from a session. A
// service-role client bypasses RLS entirely, so these are plain reads,
// not RPC calls.
//
// Real gap this exists to close (2026-10-01, before every tenant moved
// onto one shared platform bot): NONE of line-webhook/field-form/the
// four line-push-* cron functions ever checked module access at all --
// the line_bot module gate only ever hid the Communication Center page
// client-side, while the LINE backend itself (which burns LINE's
// per-recipient push quota, and can reach extract-po-document's
// Anthropic cost via field-form's เบิกของ photo-scan path) ran for ANY
// tenant with a channel_access_token configured, trial or not, forever.
// Still load-bearing after the shared-bot migration: every tenant now
// shares the same bot credentials, so this check is the ONLY thing
// gating LINE functionality per tenant at all -- see every
// tenantHasModuleAccess(...) call site across line-webhook,
// leave-notify, line-worker-offboarded, and the four line-push-*
// functions.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

// Modules a company only has through its own tenant_modules row, never from the free trial or a
// package. Keep in step with src/lib/modules.js and has_module_access() in the database.
export const EXPLICIT_ONLY_MODULES = ['estimation']

export async function tenantHasModuleAccess(admin: SupabaseClient, tenantId: string, moduleKey: string): Promise<boolean> {
  const { data: tenant } = await admin.from('tenants').select('trial_ends_at').eq('id', tenantId).maybeSingle()
  // The free trial opens every module except the explicit-only ones (see EXPLICIT_ONLY_MODULES).
  if (tenant?.trial_ends_at && new Date(tenant.trial_ends_at as string) > new Date() && !EXPLICIT_ONLY_MODULES.includes(moduleKey)) return true

  const { data: mod } = await admin.from('tenant_modules').select('tenant_id').eq('tenant_id', tenantId).eq('module_key', moduleKey).maybeSingle()
  return !!mod
}
