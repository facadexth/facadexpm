// sign-link — Remote document signing (2026-09-02)
// Public, unauthenticated endpoint behind /sign/<linkId> in the frontend.
// The whole point of this function is that the public signing page NEVER
// talks to the database directly with the anon key -- every read and
// write for a document_receipt_link goes through here, using the service
// role, so no RLS policy on document_receipt_links/document_receipts/
// cheques/storage ever needs to grant anon access. This function IS the
// access control: it only ever acts on the one row matching the linkId
// the caller supplied, and only while that link is unexpired and unused.
import { createClient } from 'jsr:@supabase/supabase-js@2'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Only 'cheque' exists today, but this stays a lookup table (not baked
// into SQL) so a future document type is one entry, not a rewrite.
const DOCUMENT_LOADERS: Record<string, (id: string) => Promise<Record<string, unknown> | null>> = {
  cheque: async (id: string) => {
    const { data } = await admin.from('cheques').select('cheque_no, bank, check_date, status, tenant_id').eq('id', id).maybeSingle()
    if (!data) return null
    return { label: `เช็ค ${data.cheque_no}`, bank: data.bank, check_date: data.check_date, status: data.status, tenant_id: data.tenant_id }
  },
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
  if (new Date(link.expires_at) < new Date()) return json({ valid: false, reason: 'expired' })

  const loader = DOCUMENT_LOADERS[link.document_type as string]
  if (!loader) return json({ valid: false, reason: 'unsupported_document_type' })
  const doc = await loader(link.document_id as string)
  if (!doc) return json({ valid: false, reason: 'document_not_found' })

  const { data: tenant } = await admin.from('tenants').select('company_name').eq('id', doc.tenant_id).maybeSingle()

  if (action === 'info') {
    return json({
      valid: true,
      alreadySigned: !!link.signed_at,
      document: doc,
      tenantName: tenant?.company_name ?? null,
    })
  }

  if (action === 'submit') {
    if (link.signed_at) return json({ error: 'ลิงก์นี้เซ็นไปแล้ว' }, 409)

    const { signerName, signerNote, signatureDataUrl } = body
    if (!signerName || typeof signerName !== 'string' || !signerName.trim()) {
      return json({ error: 'signerName required' }, 400)
    }
    if (!signatureDataUrl || typeof signatureDataUrl !== 'string') {
      return json({ error: 'signatureDataUrl required' }, 400)
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

    await admin.from('document_receipt_links').update({ signed_at: new Date().toISOString(), receipt_id: receipt.id }).eq('id', linkId)

    return json({ success: true })
  }

  return json({ error: 'Unknown action' }, 400)
})
