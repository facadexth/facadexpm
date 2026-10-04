// _shared/push-settings.ts -- per-tenant on/off switches for LINE push messages.
//
// Pushes count against the LINE bot's monthly message quota (shared by all
// tenants); replies to something a person typed do not. Each push the system
// sends on its own has a switch in Settings -> "การแจ้งเตือนทาง LINE", stored in
// app_settings as the string 'true' / 'false'.
//
// A tenant that never touched a switch keeps today's behaviour (the default
// below), so shipping the switches changes nothing until an owner flips one.
// The same list, with labels, lives in src/lib/linePushToggles.js for the UI;
// a test keeps the two in step.

import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

export const PUSH_TOGGLE_DEFAULTS: Record<string, boolean> = {
  // Existing key (predates this list); off unless an owner turned it on.
  cheque_reminder_line_enabled: false,
  line_push_quotation_followup: true,
  line_push_leave_result: true,
  line_push_leave_request_admin: true,
  line_push_leave_ack_worker: true,
  line_push_material_request_admin: true,
  line_push_offboarding: true,
  // Free device notifications (Web Push); one switch per kind of event, independent of LINE.
  web_push_leave_request: true,
  web_push_material_request: true,
  web_push_issue_report: true,
  web_push_quotation_expiry: true,
}

export function parseToggle(value: unknown, defaultOn: boolean): boolean {
  if (value === true || value === 'true') return true
  if (value === false || value === 'false') return false
  return defaultOn
}

// Fails toward the default if the setting cannot be read: a lookup hiccup
// should not silently turn a notification off (the push budget is what
// protects the quota, not this switch).
export async function isPushEnabled(
  admin: Pick<SupabaseClient, 'from'>,
  tenantId: string,
  key: string,
): Promise<boolean> {
  const defaultOn = PUSH_TOGGLE_DEFAULTS[key] ?? true
  const { data, error } = await admin.from('app_settings').select('value').eq('tenant_id', tenantId).eq('key', key).maybeSingle()
  if (error) {
    console.error('push toggle lookup failed', tenantId, key, (error as { code?: string }).code ?? 'unknown')
    return defaultOn
  }
  return parseToggle(data?.value, defaultOn)
}
