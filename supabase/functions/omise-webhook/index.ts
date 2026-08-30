// omise-webhook — Phase B self-service billing (2026-08-30)
// Public endpoint (verify_jwt: false) that Omise POSTs events to. Omise
// does NOT cryptographically sign webhooks, so the incoming body is never
// trusted for its `status` field -- it's only used to learn WHICH charge
// id to look up. This function then makes its own authenticated
// GET /charges/{id} call back to Omise (using our secret key) to confirm
// the charge's real, current status server-to-server before doing
// anything. On a confirmed successful charge, activates the tenant
// directly via the service-role client, mirroring exactly what
// platform_set_tenant_package()/platform_set_tenant_status() do -- those
// RPCs can't be called here since they require the caller to be a human
// platform_admins member, which a webhook isn't.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const OMISE_SECRET_KEY = Deno.env.get('OMISE_SECRET_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

function omiseAuthHeader() {
  return 'Basic ' + btoa(OMISE_SECRET_KEY + ':')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  // Always respond 200 (even on our own errors) so Omise doesn't retry-storm
  // over a transient bug on our side -- log instead, for debugging.
  try {
    const body = await req.json().catch(() => null)
    const chargeId = body?.data?.id
    if (!chargeId || typeof chargeId !== 'string') {
      return new Response('ok', { status: 200 })
    }

    const chargeRes = await fetch(`https://api.omise.co/charges/${chargeId}`, {
      headers: { Authorization: omiseAuthHeader() },
    })
    if (!chargeRes.ok) {
      console.error('omise-webhook: charge refetch failed', chargeId, await chargeRes.text())
      return new Response('ok', { status: 200 })
    }
    const charge = await chargeRes.json()

    const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

    const { data: intent } = await admin
      .from('payment_intents')
      .select('*')
      .eq('omise_charge_id', charge.id)
      .maybeSingle()
    if (!intent) {
      // Unknown charge (not one we created, or already deleted) -- ignore.
      return new Response('ok', { status: 200 })
    }

    if (charge.status === 'successful' && intent.status !== 'successful') {
      await admin
        .from('payment_intents')
        .update({ status: 'successful', confirmed_at: new Date().toISOString() })
        .eq('id', intent.id)

      const expiresAt = new Date()
      expiresAt.setMonth(expiresAt.getMonth() + 1)
      const expiresAtIso = expiresAt.toISOString()

      await admin
        .from('tenants')
        .update({ package_id: intent.package_id, plan: 'active', plan_expires_at: expiresAtIso })
        .eq('id', intent.tenant_id)

      // Mirror platform_set_tenant_package()'s module sync -- net effect of
      // delete-not-in + insert-on-conflict-do-nothing is the same as a
      // full delete-then-insert of the target set, and PostgREST filters
      // can't express a subquery the way the raw-SQL RPC does.
      const { data: modules } = await admin
        .from('package_modules')
        .select('module_key')
        .eq('package_id', intent.package_id)
      const moduleKeys = (modules ?? []).map((m: { module_key: string }) => m.module_key)

      await admin.from('tenant_modules').delete().eq('tenant_id', intent.tenant_id)
      if (moduleKeys.length) {
        await admin
          .from('tenant_modules')
          .insert(moduleKeys.map((key) => ({ tenant_id: intent.tenant_id, module_key: key })))
      }

      await admin.from('tenant_status_log').insert({
        tenant_id: intent.tenant_id,
        plan: 'active',
        plan_expires_at: expiresAtIso,
        changed_by: `omise:${charge.id}`,
      })
    } else if (['failed', 'expired'].includes(charge.status) && intent.status === 'pending') {
      await admin.from('payment_intents').update({ status: charge.status }).eq('id', intent.id)
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    console.error('omise-webhook error', e)
    return new Response('ok', { status: 200 })
  }
})
