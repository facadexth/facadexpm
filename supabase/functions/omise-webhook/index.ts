// omise-webhook — Phase B self-service billing (2026-08-30)
// Public endpoint (verify_jwt: false) that Omise POSTs events to. Omise
// does NOT cryptographically sign webhooks, so the incoming body is never
// trusted for its `status` field -- it's only used to learn WHICH charge
// id to look up. This function then makes its own authenticated
// GET /charges/{id} call back to Omise (using our secret key) to confirm
// the charge's real, current status server-to-server before doing
// anything. On a confirmed successful charge, activates the tenant via
// activateTenantFromIntent() (shared with omise-create-charge's zero-cost
// proration path) -- can't call platform_set_tenant_package()/
// platform_set_tenant_status() here since those require a human
// platform_admins caller, which a webhook isn't.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { activateTenantFromIntent } from './_shared/activate-tenant.ts'

const OMISE_SECRET_KEY = Deno.env.get('OMISE_SECRET_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

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

      await activateTenantFromIntent(admin, intent, RESEND_API_KEY)
    } else if (['failed', 'expired'].includes(charge.status) && intent.status === 'pending') {
      await admin.from('payment_intents').update({ status: charge.status }).eq('id', intent.id)
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    console.error('omise-webhook error', e)
    return new Response('ok', { status: 200 })
  }
})
