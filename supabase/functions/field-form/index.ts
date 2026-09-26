// field-form — public, unauthenticated endpoint behind /f/<token> in the
// frontend (see main.jsx + src/FieldFormPage.jsx). Same pattern as
// sign-link/PublicSignPage: the public page never touches the database
// directly with the anon key, every read/write goes through here using
// the service role, so line_deep_link_tokens/leave_requests/
// purchase_orders never need an anon RLS policy at all.
//
// A token is single-use (line_deep_link_tokens.used_at) and short-lived
// (expires_at, set by whoever creates it -- the LINE webhook, when a
// worker taps เบิกของ/ขอลา on the Rich Menu).
//
// เบิกของ submits straight into a REAL purchase_orders row (status
// 'draft', no supplier_id yet -- a worker in the field has no way to
// know which supplier to order from) + one purchase_order_items row per
// requested line (catalog pick, or free-typed name+unit for stock not
// in the catalog yet), then pushes a LINE message to every linked
// ADMIN/OWNER so it doesn't just sit unnoticed until someone opens the
// PO list. ขอลา still writes a 'pending' leave_requests row -- approving
// that in HR.jsx is what creates the real worker_assignments day(s).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
const APP_URL = 'https://pm.facadex.co.th'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// Shared by both actions: loads the token row plus the worker's own
// {id, name, tenant_id}, or a `reason` FieldFormPage already knows how
// to render.
async function loadToken(token: string) {
  const { data: tok } = await admin
    .from('line_deep_link_tokens')
    .select('id, worker_id, action_type, expires_at, used_at')
    .eq('token', token)
    .maybeSingle()
  if (!tok) return { reason: 'not_found' as const }
  if (tok.used_at) return { reason: 'used' as const }
  if (new Date(tok.expires_at as string).getTime() < Date.now()) return { reason: 'expired' as const }

  const { data: worker } = await admin.from('workers').select('id, name, nickname, tenant_id').eq('id', tok.worker_id).maybeSingle()
  if (!worker) return { reason: 'not_found' as const }
  return { tok, worker }
}

// Pushes to every ADMIN/OWNER with a linked LINE account for this
// tenant -- same user_roles.line_user_id the "เชื่อมต่อ LINE ส่วนตัว" card
// in CommunicationCenter.jsx sets up. Best-effort: a push failure never
// blocks the PO/leave request itself from having been created.
async function notifyAdmins(tenantId: string, text: string) {
  const { data: settings } = await admin.from('line_settings').select('channel_access_token').eq('tenant_id', tenantId).maybeSingle()
  if (!settings?.channel_access_token) return
  const { data: admins } = await admin.from('user_roles').select('line_user_id').eq('tenant_id', tenantId).in('role', ['OWNER', 'ADMIN']).not('line_user_id', 'is', null)
  for (const a of admins ?? []) {
    await sendLinePush(settings.channel_access_token, a.line_user_id as string, text).catch((e) => console.error('notifyAdmins push failed', e))
  }
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
      const { tok, worker } = result
      const workerName = worker.nickname || worker.name

      if (tok.action_type === 'material_request') {
        const [itemsRes, sitesRes] = await Promise.all([
          admin.from('inventory_items').select('id, name, base_unit, category_id, expense_categories(name)')
            .eq('tenant_id', worker.tenant_id).eq('item_kind', 'raw_material').eq('active', true).order('name'),
          admin.from('sites').select('id, name').eq('tenant_id', worker.tenant_id).eq('status', 'Ongoing').order('name'),
        ])
        const items = (itemsRes.data ?? []).map((it: any) => ({
          id: it.id, name: it.name, unit: it.base_unit, categoryId: it.category_id, categoryName: it.expense_categories?.name || 'อื่นๆ',
        }))
        const categoryMap = new Map<string, string>()
        for (const it of items) if (it.categoryId) categoryMap.set(it.categoryId, it.categoryName)
        const categories = [...categoryMap.entries()].map(([id, name]) => ({ id, name }))
        return json({ actionType: 'material_request', workerName, categories, items, sites: sitesRes.data ?? [] })
      }
      return json({ actionType: tok.action_type, workerName })
    }

    if (action === 'submit') {
      const result = await loadToken(token)
      if ('reason' in result) return json({ reason: result.reason }, 200)
      const { tok, worker } = result
      const workerName = worker.nickname || worker.name

      if (tok.action_type === 'material_request') {
        const siteId = body?.siteId as string | undefined
        const rawItems = Array.isArray(body?.items) ? body.items : []
        if (!siteId || rawItems.length === 0) return json({ error: 'missing_fields' }, 400)

        const { data: site } = await admin.from('sites').select('name').eq('id', siteId).eq('tenant_id', worker.tenant_id).maybeSingle()
        if (!site) return json({ error: 'site_not_found' }, 400)

        // Resolve every line -- either a catalog item (itemId) or a
        // free-typed one (manualName/manualUnit, for stock not in the
        // catalog yet), each still tagged with a category so the header's
        // required category_id has something to point at.
        const resolved: { description: string; unit: string; quantity: number; categoryId: string; inventoryItemId: string | null }[] = []
        for (const raw of rawItems) {
          const quantity = Number(raw?.quantity)
          if (!quantity || quantity <= 0) return json({ error: 'invalid_quantity' }, 400)

          if (raw?.itemId) {
            const { data: item } = await admin.from('inventory_items').select('name, base_unit, category_id')
              .eq('id', raw.itemId).eq('tenant_id', worker.tenant_id).maybeSingle()
            if (!item) return json({ error: 'item_not_found' }, 400)
            resolved.push({ description: item.name, unit: item.base_unit, quantity, categoryId: item.category_id, inventoryItemId: raw.itemId })
          } else {
            const manualName = String(raw?.manualName || '').trim()
            const manualUnit = String(raw?.manualUnit || '').trim()
            const categoryId = raw?.categoryId as string | undefined
            if (!manualName || !manualUnit || !categoryId) return json({ error: 'missing_fields' }, 400)
            const { data: category } = await admin.from('expense_categories').select('id').eq('id', categoryId).eq('tenant_id', worker.tenant_id).maybeSingle()
            if (!category) return json({ error: 'category_not_found' }, 400)
            resolved.push({ description: manualName, unit: manualUnit, quantity, categoryId, inventoryItemId: null })
          }
        }

        const { data: po, error: poError } = await admin.from('purchase_orders').insert({
          tenant_id: worker.tenant_id, site_id: siteId, category_id: resolved[0].categoryId, supplier_id: null,
          date: bangkokToday(), status: 'draft', has_vat: true, price_includes_vat: false,
          ordered_by: workerName, notes: `ขอเบิกผ่านไลน์โดย ${workerName}`,
        }).select('id').single()
        if (poError || !po) return json({ error: poError?.message ?? 'po_insert_failed' }, 500)

        const { error: itemsError } = await admin.from('purchase_order_items').insert(
          resolved.map((r, i) => ({
            po_id: po.id, tenant_id: worker.tenant_id, description: r.description, quantity: r.quantity, unit: r.unit,
            unit_price: 0, line_total: 0, sort_order: i, inventory_item_id: r.inventoryItemId,
          }))
        )
        if (itemsError) return json({ error: itemsError.message }, 500)

        await admin.from('line_deep_link_tokens').update({ used_at: new Date().toISOString() }).eq('id', tok.id)
        const itemLines = resolved.map(r => `- ${r.description} (${r.quantity} ${r.unit})`).join('\n')
        await notifyAdmins(worker.tenant_id, `📦 ${workerName} ขอเบิกที่ไซต์ ${site.name}:\n${itemLines}\nสร้างใบสั่งซื้อร่างไว้ให้แล้ว รอเลือกซัพพลายเออร์และราคาที่ ${APP_URL}`)
        return json({ ok: true, workerName })
      }

      if (tok.action_type === 'leave') {
        const leaveType = body?.leaveType as string | undefined
        const dateFrom = body?.dateFrom as string | undefined
        const dateTo = (body?.dateTo as string | undefined) || dateFrom
        const reason = body?.reason ? String(body.reason).trim() : null
        if (leaveType !== 'leave_sick' && leaveType !== 'leave_personal') return json({ error: 'invalid_leave_type' }, 400)
        if (!dateFrom) return json({ error: 'missing_date' }, 400)
        const { error } = await admin.from('leave_requests').insert({
          tenant_id: worker.tenant_id, worker_id: tok.worker_id, leave_type: leaveType, date_from: dateFrom, date_to: dateTo, reason,
        })
        if (error) return json({ error: error.message }, 500)

        await admin.from('line_deep_link_tokens').update({ used_at: new Date().toISOString() }).eq('id', tok.id)
        const leaveLabel = leaveType === 'leave_sick' ? 'ลาป่วย' : 'ลากิจ'
        const dateLabel = dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`
        await notifyAdmins(worker.tenant_id, `🏖️ ${workerName} ขอ${leaveLabel} วันที่ ${dateLabel}\nรออนุมัติที่หน้าบุคคล → คำขอลา`)
        return json({ ok: true, workerName })
      }

      return json({ error: 'unknown_action_type' }, 400)
    }

    return json({ error: 'unknown_action' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
