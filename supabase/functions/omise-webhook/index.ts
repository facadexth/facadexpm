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
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')!

// FacadeXPM-the-platform is operated by the same company as the real
// bootstrap tenant (confirmed with the user 2026-08-30) -- reused as the
// receipt's seller, rather than a separate hardcoded config.
const SELLER_TENANT_ID = '1b9affc4-2136-4ed1-b168-a36e6624e743'

function omiseAuthHeader() {
  return 'Basic ' + btoa(OMISE_SECRET_KEY + ':')
}

const fmtBaht = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

// Prices are VAT-inclusive (confirmed with the user) -- back out the VAT
// component for display rather than adding 7% on top.
function vatBreakdown(totalInclVat: number) {
  const beforeVat = Math.round((totalInclVat / 1.07) * 100) / 100
  const vat = Math.round((totalInclVat - beforeVat) * 100) / 100
  return { beforeVat, vat, total: totalInclVat }
}

function receiptEmailHtml(opts: {
  receiptNumber: string; issuedAt: string; packageName: string; amount: number
  seller: { company_name: string | null; address: string | null; tax_id: string | null; phone: string | null }
  buyer: { company_name: string | null; address: string | null; tax_id: string | null }
}) {
  const { beforeVat, vat, total } = vatBreakdown(opts.amount)
  return `
  <div style="font-family: sans-serif; max-width: 560px; margin: 0 auto; color: #1a1d2e;">
    <h2 style="margin-bottom: 4px;">ใบเสร็จรับเงิน / Receipt</h2>
    <div style="color: #666; margin-bottom: 20px;">เลขที่ ${opts.receiptNumber} — ${opts.issuedAt}</div>

    <table style="width: 100%; border-collapse: collapse; margin-bottom: 20px;">
      <tr>
        <td style="width: 50%; vertical-align: top; padding-right: 12px;">
          <div style="font-weight: 700; font-size: 12px; color: #666; text-transform: uppercase;">ผู้ขาย</div>
          <div>${opts.seller.company_name ?? '—'}</div>
          <div style="font-size: 13px; color: #555;">${opts.seller.address ?? ''}</div>
          <div style="font-size: 13px; color: #555;">เลขผู้เสียภาษี: ${opts.seller.tax_id ?? '—'}</div>
        </td>
        <td style="width: 50%; vertical-align: top;">
          <div style="font-weight: 700; font-size: 12px; color: #666; text-transform: uppercase;">ผู้ซื้อ</div>
          <div>${opts.buyer.company_name ?? '—'}</div>
          <div style="font-size: 13px; color: #555;">${opts.buyer.address ?? ''}</div>
          <div style="font-size: 13px; color: #555;">เลขผู้เสียภาษี: ${opts.buyer.tax_id ?? '—'}</div>
        </td>
      </tr>
    </table>

    <table style="width: 100%; border-collapse: collapse; border-top: 1px solid #ddd; border-bottom: 1px solid #ddd;">
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0;">ค่าบริการ FacadeXPM แพ็กเกจ ${opts.packageName} (รายเดือน)</td>
        <td style="padding: 8px 0; text-align: right;">${fmtBaht(beforeVat)}</td>
      </tr>
      <tr style="border-bottom: 1px solid #eee;">
        <td style="padding: 8px 0; color: #666;">ภาษีมูลค่าเพิ่ม 7% (รวมอยู่ในราคา)</td>
        <td style="padding: 8px 0; text-align: right; color: #666;">${fmtBaht(vat)}</td>
      </tr>
      <tr>
        <td style="padding: 8px 0; font-weight: 700;">รวมทั้งสิ้น</td>
        <td style="padding: 8px 0; text-align: right; font-weight: 700;">${fmtBaht(total)} บาท</td>
      </tr>
    </table>

    <p style="font-size: 12px; color: #999; margin-top: 24px;">
      อีเมลนี้เป็นใบเสร็จอิเล็กทรอนิกส์สำหรับการชำระค่าบริการ FacadeXPM ผ่าน PromptPay
    </p>
  </div>`
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

      // Issue + email a subscription receipt. Never let a receipt/email
      // failure undo or block the activation above -- the tenant is
      // already paid and active regardless of whether this succeeds.
      try {
        const [{ data: pkg }, { data: seller }, { data: buyer }, { data: ownerRole }] = await Promise.all([
          admin.from('packages').select('name').eq('id', intent.package_id).single(),
          admin.from('tenants').select('company_name, address, tax_id, phone').eq('id', SELLER_TENANT_ID).single(),
          admin.from('tenants').select('company_name, address, tax_id').eq('id', intent.tenant_id).single(),
          admin.from('user_roles').select('user_email').eq('tenant_id', intent.tenant_id).eq('role', 'OWNER').limit(1).maybeSingle(),
        ])

        const { data: receipt, error: receiptError } = await admin
          .from('subscription_receipts')
          .insert({
            payment_intent_id: intent.id,
            tenant_id: intent.tenant_id,
            package_name: pkg?.name ?? 'Unknown',
            amount: intent.amount,
            email_to: ownerRole?.user_email ?? null,
          })
          .select()
          .single()

        if (receiptError || !receipt) {
          console.error('omise-webhook: receipt insert failed', receiptError)
        } else if (ownerRole?.user_email) {
          const html = receiptEmailHtml({
            receiptNumber: receipt.receipt_number,
            issuedAt: new Date(receipt.issued_at).toLocaleDateString('th-TH'),
            packageName: receipt.package_name,
            amount: Number(receipt.amount),
            seller: seller ?? { company_name: null, address: null, tax_id: null, phone: null },
            buyer: buyer ?? { company_name: null, address: null, tax_id: null },
          })

          const emailRes = await fetch('https://api.resend.com/emails', {
            method: 'POST',
            headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              from: 'FacadeXPM <contact@facadex.co.th>',
              to: [ownerRole.user_email],
              subject: `ใบเสร็จรับเงิน ${receipt.receipt_number} — FacadeXPM`,
              html,
            }),
          })

          if (emailRes.ok) {
            await admin.from('subscription_receipts').update({ email_sent_at: new Date().toISOString() }).eq('id', receipt.id)
          } else {
            const errText = await emailRes.text()
            console.error('omise-webhook: resend send failed', errText)
            await admin.from('subscription_receipts').update({ email_error: errText.slice(0, 500) }).eq('id', receipt.id)
          }
        }
      } catch (receiptErr) {
        console.error('omise-webhook: receipt/email step failed', receiptErr)
      }
    } else if (['failed', 'expired'].includes(charge.status) && intent.status === 'pending') {
      await admin.from('payment_intents').update({ status: charge.status }).eq('id', intent.id)
    }

    return new Response('ok', { status: 200 })
  } catch (e) {
    console.error('omise-webhook error', e)
    return new Response('ok', { status: 200 })
  }
})
