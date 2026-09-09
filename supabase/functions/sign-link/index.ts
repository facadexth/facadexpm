// sign-link — Remote document signing (2026-09-02, extended 2026-09-09)
// Public, unauthenticated endpoint behind /sign/<linkId> in the frontend.
// The whole point of this function is that the public signing page NEVER
// talks to the database directly with the anon key -- every read and
// write for a document_receipt_link goes through here, using the service
// role, so no RLS policy on document_receipt_links/document_receipts/
// cheques/storage ever needs to grant anon access. This function IS the
// access control: it only ever acts on the one row matching the linkId
// the caller supplied, and only while that link is unexpired (or, for
// 'info', already signed -- a signed link stays viewable/downloadable
// forever so the client can revisit it, only the *submit* action checks
// expiry+unsigned).
//
// 2026-09-09 extension: DOCUMENT_LOADERS now return the full printable
// document (line items, tenant letterhead info, bank account, notes) not
// just a one-line summary, so PublicSignPage can show the client what
// they're actually signing -- both before signing (preview) and after
// (the same view, plus their signature and a PDF download). Also added:
// an optional signerEmail on submit that, if given, gets a Resend email
// confirming what was signed with a link back to view/download it again
// (same RESEND_API_KEY + api.resend.com/emails pattern already used for
// subscription-receipt emails in _shared/activate-tenant.ts -- no new
// provider integration needed).
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const RESEND_API_KEY = Deno.env.get('RESEND_API_KEY')
const APP_URL = 'https://pm.facadex.co.th'
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

const VAT_RATE = 0.07
function round2(n: number) {
  return Math.round(n * 100) / 100
}

type DocItem = { description: string; unit: string | null; quantity: number; unitPrice: number; lineTotal: number }
type BankAccount = { bank_name: string; account_name: string; account_no: string } | null

// This stays a lookup table (not baked into SQL) so a future document type
// is one entry, not a rewrite. Every loader returns a superset of fields;
// PublicSignPage renders whichever ones are present for that type.
const DOCUMENT_LOADERS: Record<string, (id: string) => Promise<Record<string, unknown> | null>> = {
  cheque: async (id: string) => {
    const { data } = await admin.from('cheques').select('cheque_no, bank, check_date, status, tenant_id').eq('id', id).maybeSingle()
    if (!data) return null
    return { type: 'cheque', label: `เช็ค ${data.cheque_no}`, bank: data.bank, check_date: data.check_date, status: data.status, tenant_id: data.tenant_id }
  },
  // Totals here are display-only (rounded, computed the same way
  // calcQuotationTotals/calcInvoiceTotals do client-side) -- the row
  // itself (or its items) stays the one authoritative source; this
  // function never writes a total anywhere.
  quotation: async (id: string) => {
    const { data } = await admin.from('quotations')
      .select(`
        quotation_number, date, valid_until, status, has_vat, price_includes_vat,
        discount_amount, discount_pct, payment_terms, notes, tenant_id, site_name,
        clients(name, address, tax_id),
        bank_accounts(bank_name, account_name, account_no),
        quotation_items(description, unit, quantity, unit_price, line_total, sort_order, item_type)
      `)
      .eq('id', id).maybeSingle()
    if (!data) return null
    const rawItems = (data.quotation_items as Array<{ description: string; unit: string | null; quantity: number; unit_price: number; line_total: number | null; sort_order: number; item_type: string | null }> ?? [])
      .filter((it) => it.item_type === 'item' || !it.item_type)
      .sort((a, b) => a.sort_order - b.sort_order)
    const items: DocItem[] = rawItems.map((it) => ({
      description: it.description, unit: it.unit, quantity: it.quantity, unitPrice: it.unit_price,
      lineTotal: it.line_total ?? it.quantity * it.unit_price,
    }))
    const rawTotal = items.reduce((s, it) => s + it.lineTotal, 0)
    const discountedRaw = data.discount_pct
      ? Math.max(0, rawTotal * (1 - (data.discount_pct as number) / 100))
      : Math.max(0, rawTotal - ((data.discount_amount as number) || 0))
    let subtotal: number, vat: number, total: number
    if (!data.has_vat) { total = round2(discountedRaw); subtotal = total; vat = 0 }
    else if (data.price_includes_vat) { total = round2(discountedRaw); subtotal = round2(total / (1 + VAT_RATE)); vat = round2(total - subtotal) }
    else { subtotal = round2(discountedRaw); vat = round2(subtotal * VAT_RATE); total = round2(subtotal + vat) }

    const client = data.clients as { name?: string; address?: string; tax_id?: string } | null
    return {
      type: 'quotation', label: `ใบเสนอราคา ${data.quotation_number}`, number: data.quotation_number,
      date: data.date, validUntil: data.valid_until, status: data.status, tenant_id: data.tenant_id,
      clientName: client?.name, clientAddress: client?.address, clientTaxId: client?.tax_id,
      siteName: data.site_name, items, hasVat: data.has_vat, subtotal, vat, total,
      notes: data.notes, paymentTerms: data.payment_terms,
      bankAccount: (data.bank_accounts as BankAccount) ?? null,
    }
  },
  invoice: async (id: string) => {
    const { data } = await admin.from('invoices')
      .select(`
        invoice_number, date, status, has_vat, subtotal, vat, total, notes, tenant_id,
        sites(name),
        quotations(quotation_number, clients(name, address, tax_id)),
        bank_accounts(bank_name, account_name, account_no),
        invoice_items(description, unit, draw_qty, unit_price, line_total, sort_order)
      `)
      .eq('id', id).maybeSingle()
    if (!data) return null
    const rawItems = (data.invoice_items as Array<{ description: string; unit: string | null; draw_qty: number; unit_price: number; line_total: number; sort_order: number }> ?? [])
      .sort((a, b) => a.sort_order - b.sort_order)
    const items: DocItem[] = rawItems.map((it) => ({
      description: it.description, unit: it.unit, quantity: it.draw_qty, unitPrice: it.unit_price, lineTotal: it.line_total,
    }))
    const quotation = data.quotations as { quotation_number?: string; clients?: { name?: string; address?: string; tax_id?: string } } | null
    const client = quotation?.clients
    return {
      type: 'invoice', label: `ใบแจ้งหนี้ ${data.invoice_number}`, number: data.invoice_number,
      date: data.date, status: data.status, tenant_id: data.tenant_id,
      clientName: client?.name, clientAddress: client?.address, clientTaxId: client?.tax_id,
      siteName: (data.sites as { name?: string } | null)?.name, quotationNumber: quotation?.quotation_number,
      items, hasVat: data.has_vat, subtotal: data.subtotal, vat: data.vat, total: data.total,
      notes: data.notes, bankAccount: (data.bank_accounts as BankAccount) ?? null,
    }
  },
}

async function sendSignConfirmationEmail(to: string, doc: Record<string, unknown>, tenantName: string, signerName: string, linkId: string) {
  if (!RESEND_API_KEY) return { sent: false, error: 'RESEND_API_KEY not configured' }
  const viewUrl = `${APP_URL}/sign/${linkId}`
  const html = `
    <div style="font-family: Sarabun, Arial, sans-serif; max-width: 480px; margin: 0 auto;">
      <h2 style="margin-bottom: 4px;">✅ เซ็นรับเอกสารเรียบร้อยแล้ว</h2>
      <p style="color:#555;">${tenantName ? `${tenantName}<br/>` : ''}${doc.label as string}</p>
      <p style="color:#555;">ผู้เซ็นรับ: ${signerName}</p>
      <p style="margin-top:20px;"><a href="${viewUrl}" style="background:#6c63ff;color:#fff;padding:10px 18px;border-radius:8px;text-decoration:none;">ดูเอกสารที่เซ็นแล้ว / ดาวน์โหลด</a></p>
      <p style="color:#999;font-size:12px;margin-top:20px;">อีเมลนี้ส่งอัตโนมัติเพื่อยืนยันว่าคุณได้เซ็นรับเอกสารข้างต้นแล้ว</p>
    </div>`
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'FacadeXPM <contact@facadex.co.th>',
        to: [to],
        subject: `ยืนยันการเซ็นรับ ${doc.label} — ${tenantName || 'FacadeXPM'}`,
        html,
      }),
    })
    if (res.ok) return { sent: true }
    return { sent: false, error: (await res.text()).slice(0, 500) }
  } catch (e) {
    return { sent: false, error: String(e).slice(0, 500) }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  let body: Record<string, unknown>
  try {
    body = await req.json()
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }

  const { action, linkId } = body
  if (!linkId || typeof linkId !== 'string') return json({ error: 'linkId required' }, 400)

  const { data: link, error: linkError } = await admin
    .from('document_receipt_links')
    .select('*')
    .eq('id', linkId)
    .maybeSingle()

  if (linkError) return json({ error: linkError.message }, 500)
  if (!link) return json({ valid: false, reason: 'not_found' })
  // An already-signed link stays viewable (so the client can revisit /
  // re-download) even past its original 7-day expiry -- only a not-yet-
  // signed link actually expires.
  if (!link.signed_at && new Date(link.expires_at) < new Date()) return json({ valid: false, reason: 'expired' })

  const loader = DOCUMENT_LOADERS[link.document_type as string]
  if (!loader) return json({ valid: false, reason: 'unsupported_document_type' })
  const doc = await loader(link.document_id as string)
  if (!doc) return json({ valid: false, reason: 'document_not_found' })

  const { data: tenant } = await admin.from('tenants').select('company_name, address, tax_id, phone, logo_url').eq('id', doc.tenant_id).maybeSingle()

  if (action === 'info') {
    let signature: { url: string | null; signerName: string | null; signedAt: string | null } | null = null
    if (link.signed_at && link.receipt_id) {
      const { data: receipt } = await admin.from('document_receipts').select('signature_path, signer_name, signed_at').eq('id', link.receipt_id).maybeSingle()
      if (receipt) {
        const { data: signedUrl } = await admin.storage.from('document-receipts').createSignedUrl(receipt.signature_path, 60 * 60)
        signature = { url: signedUrl?.signedUrl ?? null, signerName: receipt.signer_name, signedAt: receipt.signed_at }
      }
    }
    return json({
      valid: true,
      alreadySigned: !!link.signed_at,
      document: doc,
      tenant: tenant ?? null,
      tenantName: tenant?.company_name ?? null,
      signature,
    })
  }

  if (action === 'submit') {
    if (link.signed_at) return json({ error: 'ลิงก์นี้เซ็นไปแล้ว' }, 409)
    if (new Date(link.expires_at) < new Date()) return json({ error: 'ลิงก์นี้หมดอายุแล้ว' }, 410)

    const { signerName, signerNote, signerEmail, signatureDataUrl } = body
    if (!signerName || typeof signerName !== 'string' || !signerName.trim()) {
      return json({ error: 'signerName required' }, 400)
    }
    if (!signatureDataUrl || typeof signatureDataUrl !== 'string') {
      return json({ error: 'signatureDataUrl required' }, 400)
    }
    const emailTrimmed = signerEmail && typeof signerEmail === 'string' ? signerEmail.trim() : ''
    // Loose check only -- Resend itself will reject a truly malformed
    // address; this just avoids an obviously-wrong value blocking signing.
    if (emailTrimmed && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailTrimmed)) {
      return json({ error: 'อีเมลไม่ถูกต้อง' }, 400)
    }

    const base64 = signatureDataUrl.replace(/^data:image\/png;base64,/, '')
    const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0))
    const filePath = `${doc.tenant_id}/${link.document_type}/${link.document_id}/${Date.now()}-remote.png`
    const { error: uploadError } = await admin.storage.from('document-receipts').upload(filePath, bytes, { contentType: 'image/png' })
    if (uploadError) return json({ error: uploadError.message }, 500)

    const { data: receipt, error: receiptError } = await admin
      .from('document_receipts')
      .insert({
        tenant_id: doc.tenant_id,
        document_type: link.document_type,
        document_id: link.document_id,
        signer_name: (signerName as string).trim(),
        signer_note: signerNote && typeof signerNote === 'string' ? signerNote.trim() || null : null,
        signer_email: emailTrimmed || null,
        signature_path: filePath,
        signed_by: `remote link (created by ${link.created_by})`,
      })
      .select()
      .single()
    if (receiptError) {
      await admin.storage.from('document-receipts').remove([filePath])
      return json({ error: receiptError.message }, 500)
    }

    if (link.document_type === 'cheque') {
      await admin.from('cheques').update({ status: 'received' }).eq('id', link.document_id).eq('status', 'issued')
    }
    // A client's signature IS acceptance -- flips status immediately so
    // staff see it as accepted without a manual step. Site linkage (which
    // needs a human to pick/create a site) stays a separate follow-up: the
    // frontend now shows "🔗 ผูกไซท์งาน" on any accepted-but-unsited
    // quotation (see Quotations.jsx), reusing the same accept modal.
    // Invoice signing is delivery/receipt acknowledgment only -- no status
    // change, matching how payment already stays a separate deliberate
    // action (MarkPaidModal).
    if (link.document_type === 'quotation') {
      await admin.from('quotations').update({ status: 'accepted' }).eq('id', link.document_id).eq('status', 'sent')
    }

    await admin.from('document_receipt_links').update({ signed_at: new Date().toISOString(), receipt_id: receipt.id }).eq('id', linkId)

    if (emailTrimmed) {
      const result = await sendSignConfirmationEmail(emailTrimmed, doc, (tenant?.company_name as string) ?? '', (signerName as string).trim(), linkId)
      await admin.from('document_receipts').update({
        email_sent_at: result.sent ? new Date().toISOString() : null,
        email_error: result.sent ? null : result.error,
      }).eq('id', receipt.id)
    }

    return json({ success: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
