// omise-create-charge — Phase B self-service billing (2026-08-30)
// Called by an authenticated tenant admin/owner to start a PromptPay
// payment for a package. Creates an Omise Source + Charge, records a
// `payment_intents` row, and returns the scannable QR code image URL.
// The actual activation happens later, in omise-webhook, once Omise
// confirms the charge really completed.
//
// Proration (2026-08-30): if the caller already has an active paid plan
// with time remaining, this is an UPGRADE -- credit = old_plan_price *
// (days_remaining / 30), charge = max(0, new_plan_price - credit), and
// the billing anniversary (plan_expires_at) is PRESERVED, not reset to
// "+1 month from today" (a fresh subscription still gets a new 1-month
// cycle). If the credit fully covers the new tier (charge <= 0), there's
// nothing to collect -- skip Omise entirely and activate immediately via
// the same activateTenantFromIntent() the webhook uses for paid charges.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { activateTenantFromIntent } from './_shared/activate-tenant.ts'

const OMISE_SECRET_KEY = Deno.env.get('OMISE_SECRET_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

// Called directly from the browser (UpgradeModal.jsx) -- needs CORS, or the
// preflight OPTIONS request fails and the browser never sends the real
// POST at all (surfaces client-side as "Failed to send a request to the
// Edge Function", not as any error this function's own code ever runs).
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}

function omiseAuthHeader() {
  return 'Basic ' + btoa(OMISE_SECRET_KEY + ':')
}

async function omisePost(path: string, params: Record<string, string>) {
  const res = await fetch(`https://api.omise.co${path}`, {
    method: 'POST',
    headers: {
      Authorization: omiseAuthHeader(),
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`Omise ${path} failed: ${JSON.stringify(json)}`)
  return json
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405, headers: corsHeaders })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401, headers: corsHeaders })
  }

  try {
    const { package_id } = await req.json()
    if (!package_id) {
      return new Response(JSON.stringify({ error: 'package_id required' }), { status: 400, headers: corsHeaders })
    }

    // Bound to the CALLER's own JWT -- respects RLS, so current_tenant_id()
    // / is_admin_or_owner() work exactly like everywhere else in the app
    // instead of being re-implemented here.
    const userClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader } },
    })

    const { data: pkg, error: pkgError } = await userClient
      .from('packages').select('id, name, price_monthly').eq('id', package_id).single()
    if (pkgError || !pkg) {
      return new Response(JSON.stringify({ error: 'Package not found' }), { status: 404, headers: corsHeaders })
    }
    if (pkg.price_monthly == null || pkg.price_monthly <= 0) {
      return new Response(JSON.stringify({ error: 'Package has no payable monthly price (Free or Custom/Enterprise)' }), { status: 400, headers: corsHeaders })
    }

    // member_reads_own_tenant RLS means this always returns exactly the
    // caller's own tenant row, with no explicit filter needed.
    const { data: tenantRow } = await userClient
      .from('tenants').select('id, package_id, plan, plan_expires_at').single()

    let chargeAmount = pkg.price_monthly
    let targetExpiresAt: string

    const isUpgrade = !!(
      tenantRow?.plan === 'active' &&
      tenantRow.package_id &&
      tenantRow.package_id !== package_id &&
      tenantRow.plan_expires_at &&
      new Date(tenantRow.plan_expires_at) > new Date()
    )

    if (isUpgrade) {
      const { data: currentPkg } = await userClient
        .from('packages').select('price_monthly').eq('id', tenantRow!.package_id).single()
      if (currentPkg?.price_monthly) {
        const remainingDays = Math.max(0, (new Date(tenantRow!.plan_expires_at as string).getTime() - Date.now()) / 86400000)
        const credit = currentPkg.price_monthly * (remainingDays / 30)
        chargeAmount = Math.max(0, Math.round((pkg.price_monthly - credit) * 100) / 100)
      }
      targetExpiresAt = tenantRow!.plan_expires_at as string // preserve billing anniversary
    } else {
      const d = new Date()
      d.setMonth(d.getMonth() + 1)
      targetExpiresAt = d.toISOString()
    }

    // INSERT goes through the caller's own RLS (admin_inserts requires
    // is_admin_or_owner()) -- starting a payment is a billing-level action.
    const { data: intent, error: intentError } = await userClient
      .from('payment_intents')
      .insert({ package_id, amount: chargeAmount, target_plan_expires_at: targetExpiresAt })
      .select()
      .single()
    if (intentError) {
      return new Response(JSON.stringify({ error: intentError.message }), { status: 400, headers: corsHeaders })
    }

    // Proration fully covered the new tier -- nothing to collect. Activate
    // immediately via the same path the webhook uses for real payments,
    // and skip Omise (and its ฿0 charge, which it doesn't support anyway).
    if (chargeAmount <= 0) {
      const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      await adminClient
        .from('payment_intents')
        .update({ status: 'successful', confirmed_at: new Date().toISOString() })
        .eq('id', intent.id)
      await activateTenantFromIntent(adminClient, { ...intent, amount: 0 }, RESEND_API_KEY)

      return new Response(JSON.stringify({
        payment_intent_id: intent.id,
        status: 'successful',
        activated_immediately: true,
        qr_image_uri: null,
      }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
    }

    const amountSatang = Math.round(chargeAmount * 100)

    const source = await omisePost('/sources', {
      amount: String(amountSatang),
      currency: 'thb',
      type: 'promptpay',
    })

    const charge = await omisePost('/charges', {
      amount: String(amountSatang),
      currency: 'thb',
      source: source.id,
      return_uri: 'https://pm.facadex.co.th/',
      'metadata[payment_intent_id]': intent.id,
    })

    // No UPDATE policy exists for `authenticated` on payment_intents (only
    // the webhook, via service_role, transitions status) -- the caller's
    // own client can't write omise_charge_id back, so use a service-role
    // client for this one write.
    const adminClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
    await adminClient
      .from('payment_intents')
      .update({ omise_source_id: source.id, omise_charge_id: charge.id })
      .eq('id', intent.id)

    const qrImageUri =
      charge?.source?.scannable_code?.image?.download_uri ??
      source?.scannable_code?.image?.download_uri ??
      null

    return new Response(JSON.stringify({
      payment_intent_id: intent.id,
      charge_id: charge.id,
      status: charge.status,
      qr_image_uri: qrImageUri,
      prorated: isUpgrade,
      amount: chargeAmount,
    }), { headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500, headers: corsHeaders })
  }
})
