// _shared/activate-tenant.ts — single source of truth for "apply a
// successful payment_intents row to its tenant": update plan/package,
// resync tenant_modules, log to tenant_status_log, issue + email a
// subscription receipt. Called from two places that must never drift
// apart: omise-webhook (normal paid upgrades/subscriptions, after Omise
// confirms the charge) and omise-create-charge (the zero-cost proration
// case, where the credited amount already covers the new tier in full,
// so there's nothing to charge and no charge id to wait on).
//
// NOTE: this file is duplicated verbatim into both function deployments
// (Supabase Edge Functions don't share a filesystem at runtime) -- this
// copy under _shared/ is the single copy to edit; the deploy step reads
// it fresh into each function's bundle.
import type { SupabaseClient } from 'jsr:@supabase/supabase-js@2'

const SELLER_TENANT_ID = '1b9affc4-2136-4ed1-b168-a36e6624e743'

const fmtBaht = (n: number) => n.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })

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

export async function activateTenantFromIntent(
  admin: SupabaseClient,
  intent: { id: string; tenant_id: string; package_id: string; amount: number; omise_charge_id: string | null; target_plan_expires_at: string | null },
  resendApiKey: string,
) {
  const expiresAtIso = intent.target_plan_expires_at ?? (() => {
    const d = new Date(); d.setMonth(d.getMonth() + 1); return d.toISOString()
  })()

  await admin
    .from('tenants')
    .update({ package_id: intent.package_id, plan: 'active', plan_expires_at: expiresAtIso })
    .eq('id', intent.tenant_id)

  // Mirror platform_set_tenant_package()'s module sync (full delete-then-
  // insert -- equivalent net effect to its delete-not-in + insert-on-
  // conflict, without needing a subquery PostgREST filters can't express).
  const { data: modules } = await admin
    .from('package_modules')
    .select('module_key')
    .eq('package_id', intent.package_id)
  const moduleKeys = (modules ?? []).map((m: { module_key: string }) => m.module_key)

  await admin.from('tenant_modules').delete().eq('tenant_id', intent.tenant_id)
  if (moduleKeys.length) {
    await admin
      .from('tenant_modules')
      .insert(moduleKeys.map((key: string) => ({ tenant_id: intent.tenant_id, module_key: key })))
  }

  await admin.from('tenant_status_log').insert({
    tenant_id: intent.tenant_id,
    plan: 'active',
    plan_expires_at: expiresAtIso,
    changed_by: intent.omise_charge_id ? `omise:${intent.omise_charge_id}` : 'omise:zero-cost-upgrade',
  })

  // Issue + email a subscription receipt. Never let a receipt/email
  // failure undo or block the activation above.
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
      console.error('activate-tenant: receipt insert failed', receiptError)
    } else if (ownerRole?.user_email && Number(receipt.amount) > 0) {
      // A ฿0 proration credit (fully covered by unused old-plan value)
      // still gets a receipt row for the audit trail, but there's no
      // real payment to send a "receipt" email about.
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
        headers: { Authorization: `Bearer ${resendApiKey}`, 'Content-Type': 'application/json' },
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
        console.error('activate-tenant: resend send failed', errText)
        await admin.from('subscription_receipts').update({ email_error: errText.slice(0, 500) }).eq('id', receipt.id)
      }
    }
  } catch (receiptErr) {
    console.error('activate-tenant: receipt/email step failed', receiptErr)
  }
}
