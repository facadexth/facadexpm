// omise-create-charge — Phase B self-service billing (2026-08-30)
// Called by an authenticated tenant admin/owner to start a PromptPay
// payment for a package. Creates an Omise Source + Charge, records a
// `payment_intents` row, and returns the scannable QR code image URL.
// The actual activation happens later, in omise-webhook, once Omise
// confirms the charge really completed.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const OMISE_SECRET_KEY = Deno.env.get('OMISE_SECRET_KEY')!
const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_ANON_KEY = Deno.env.get('SUPABASE_ANON_KEY')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

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
  if (req.method !== 'POST') return new Response('Method not allowed', { status: 405 })

  const authHeader = req.headers.get('Authorization')
  if (!authHeader) {
    return new Response(JSON.stringify({ error: 'Missing Authorization' }), { status: 401 })
  }

  try {
    const { package_id } = await req.json()
    if (!package_id) {
      return new Response(JSON.stringify({ error: 'package_id required' }), { status: 400 })
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
      return new Response(JSON.stringify({ error: 'Package not found' }), { status: 404 })
    }
    if (pkg.price_monthly == null || pkg.price_monthly <= 0) {
      return new Response(JSON.stringify({ error: 'Package has no payable monthly price (Free or Custom/Enterprise)' }), { status: 400 })
    }

    // INSERT goes through the caller's own RLS (admin_inserts requires
    // is_admin_or_owner()) -- starting a payment is a billing-level action.
    const { data: intent, error: intentError } = await userClient
      .from('payment_intents')
      .insert({ package_id, amount: pkg.price_monthly })
      .select()
      .single()
    if (intentError) {
      return new Response(JSON.stringify({ error: intentError.message }), { status: 400 })
    }

    const amountSatang = Math.round(pkg.price_monthly * 100)

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
    }), { headers: { 'Content-Type': 'application/json' } })
  } catch (e) {
    return new Response(JSON.stringify({ error: e instanceof Error ? e.message : String(e) }), { status: 500 })
  }
})
