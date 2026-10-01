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
// Real gap this exists to close: NONE of line-webhook/field-form/the
// four line-push-* cron functions ever checked module access at all --
// the line_bot module gate only ever hid the Communication Center page
// client-side, while the LINE backend itself (which burns LINE's
// per-recipient push quota, and can reach extract-po-document's
// Anthropic cost via field-form's เบิกของ photo-scan path) ran for ANY
// tenant with a channel_access_token configured, trial or not, forever.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export async function tenantHasModuleAccess(admin: SupabaseClient, tenantId: string, moduleKey: string): Promise<boolean> {
  const { data: tenant } = await admin.from('tenants').select('trial_ends_at').eq('id', tenantId).maybeSingle()
  if (tenant?.trial_ends_at && new Date(tenant.trial_ends_at as string) > new Date()) return true

  const { data: mod } = await admin.from('tenant_modules').select('tenant_id').eq('tenant_id', tenantId).eq('module_key', moduleKey).maybeSingle()
  return !!mod
}
