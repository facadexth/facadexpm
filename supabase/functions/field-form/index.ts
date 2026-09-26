// field-form — public, unauthenticated endpoint behind /f/<token> in the
// frontend (see main.jsx + src/FieldFormPage.jsx). Same pattern as
// sign-link/PublicSignPage: the public page never touches the database
// directly with the anon key, every read/write goes through here using
// the service role, so line_deep_link_tokens/material_requests/
// leave_requests never need an anon RLS policy at all.
//
// A token is single-use (line_deep_link_tokens.used_at) and short-lived
// (expires_at, set by whoever creates it -- the LINE webhook, when a
// worker taps เบิกของ/ขอลา on the Rich Menu). Submitting writes a
// 'pending' row for ADMIN/OWNER to review in HR.jsx -- this function
// never auto-approves anything.
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

// Shared by both actions: loads the token row plus the worker's display
// name, or a `reason` PublicFieldFormPage already knows how to render.
async function loadToken(token: string) {
  const { data: tok } = await admin
    .from('line_deep_link_tokens')
    .select('id, worker_id, action_type, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()
  if (!tok) return { reason: 'not_found' as const }
  if (tok.used_at) return { reason: 'used' as const }
  if (new Date(tok.expires_at as string).getTime() < Date.now()) return { reason: 'expired' as const }

  const { data: worker } = await admin.from('workers').select('name, nickname').eq('id', tok.worker_id).maybeSingle()
  if (!worker) return { reason: 'not_found' as const }
  return { tok, worker }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { headers: corsHeaders })

  try {
    const body = await req.json()
    const action = body?.action as string | undefined
    const token = body?.token as string | undefined
    if (!token) return json({ error: 'missing_token' }, 400)

    if (action === 'info') {
      const result = await loadToken(token)
      if ('reason' in result) return json({ reason: result.reason }, 200)
      return json({ actionType: result.tok.action_type, workerName: result.worker.nickname || result.worker.name })
    }

    if (action === 'submit') {
      const result = await loadToken(token)
      if ('reason' in result) return json({ reason: result.reason }, 200)
      const { tok, worker } = result

      if (tok.action_type === 'material_request') {
        const description = String(body?.description ?? '').trim()
        if (!description) return json({ error: 'missing_description' }, 400)
        const quantity = body?.quantity != null && body.quantity !== '' ? Number(body.quantity) : null
        const unit = body?.unit ? String(body.unit).trim() : null
        const { error } = await admin.from('material_requests').insert({
          tenant_id: (await admin.from('workers').select('tenant_id').eq('id', tok.worker_id).single()).data?.tenant_id,
          worker_id: tok.worker_id, description, quantity, unit,
        })
        if (error) return json({ error: error.message }, 500)
      } else if (tok.action_type === 'leave') {
        const leaveType = body?.leaveType as string | undefined
        const dateFrom = body?.dateFrom as string | undefined
        const dateTo = (body?.dateTo as string | undefined) || dateFrom
        const reason = body?.reason ? String(body.reason).trim() : null
        if (leaveType !== 'leave_sick' && leaveType !== 'leave_personal') return json({ error: 'invalid_leave_type' }, 400)
        if (!dateFrom) return json({ error: 'missing_date' }, 400)
        const { error } = await admin.from('leave_requests').insert({
          tenant_id: (await admin.from('workers').select('tenant_id').eq('id', tok.worker_id).single()).data?.tenant_id,
          worker_id: tok.worker_id, leave_type: leaveType, date_from: dateFrom, date_to: dateTo, reason,
        })
        if (error) return json({ error: error.message }, 500)
      } else {
        return json({ error: 'unknown_action_type' }, 400)
      }

      await admin.from('line_deep_link_tokens').update({ used_at: new Date().toISOString() }).eq('id', tok.id)
      return json({ ok: true, workerName: worker.nickname || worker.name })
    }

    return json({ error: 'unknown_action' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
