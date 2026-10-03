// field-form — public, unauthenticated endpoint behind /f/<token> in the
// frontend (see main.jsx + src/FieldFormPage.jsx). Same pattern as
// sign-link/PublicSignPage: the public page never touches the database
// directly with the anon key, every read/write goes through here using
// the service role, so line_deep_link_tokens/leave_requests/
// purchase_orders never need an anon RLS policy at all.
//
// A token is single-use (line_deep_link_tokens.used_at) and short-lived
// (expires_at, set by whoever creates it -- the LINE webhook, when a
// worker taps เบิกของ/ขอลา/เช็คอิน/เช็คเอาท์ on the Rich Menu).
//
// เบิกของ submits straight into a REAL purchase_orders row (status
// 'draft', no supplier_id yet -- a worker in the field has no way to
// know which supplier to order from) + one purchase_order_items row per
// requested line (catalog pick, or free-typed name+unit for stock not
// in the catalog yet), then pushes a LINE message to every linked
// ADMIN/OWNER so it doesn't just sit unnoticed until someone opens the
// PO list. ขอลา still writes a 'pending' leave_requests row -- approving
// that in HR.jsx is what creates the real worker_assignments day(s).
//
// เช็คอิน/เช็คเอาท์ (added 2026-09-28) used to be a LINE-native
// location-share two-step flow directly in line-webhook -- moved here
// because LINE's own location picker lets the sender drag the pin to
// ANY point on the map before sending (confirmed exploitable live: a
// user checked in from ~685m away by moving the shared pin). A browser
// geolocation permission prompt has no such manual-placement UI, so
// routing through this same one-time-link page instead closes that
// gap. Calls the SAME perform_worker_checkin_by_id/
// perform_worker_checkout_by_id RPCs the old flow used -- the geofence
// logic itself is unchanged, only how the coordinates are obtained. A
// distance-rejection does NOT mark the token used (unlike a successful
// submit) -- lets the worker walk closer and retry with the same link
// inside its 30-minute window, matching the old flow's retry behavior.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
import { withPushBudget } from '../_shared/push-budget.ts'
import { isPushEnabled } from '../_shared/push-settings.ts'
import { tenantHasModuleAccess } from '../_shared/tenant-access.ts'
import { APP_URL } from '../_shared/app-url.ts'

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

  const { data: worker } = await admin.from('workers').select('id, name, nickname, tenant_id, line_user_id, annual_leave_days, annual_sick_leave_days').eq('id', tok.worker_id).maybeSingle()
  if (!worker) return { reason: 'not_found' as const }
  return { tok, worker }
}

// Same "which site is this worker actually on today" resolution
// line-webhook's own resolveTodaysSite uses -- duplicated here (Deno
// Edge Functions can't share code across function directories except
// via ../_shared/) since this is the only other place that needs it.
async function resolveTodaysSite(workerId: string, tenantId: string): Promise<{ id: string; name: string } | null> {
  const { data: assignment } = await admin
    .from('worker_assignments')
    .select('site_id')
    .eq('worker_id', workerId)
    .eq('tenant_id', tenantId)
    .eq('date', bangkokToday())
    .in('type', ['site', 'factory', 'subcontract'])
    .not('site_id', 'is', null)
    .limit(1)
    .maybeSingle()
  if (!assignment?.site_id) return null
  const { data: site } = await admin.from('sites').select('id, name').eq('id', assignment.site_id).maybeSingle()
  return site ?? null
}

async function resolveOpenTasksForWorker(workerId: string, tenantId: string): Promise<Array<{ name: string }>> {
  const { data } = await admin
    .from('phase_task_workers')
    .select('phase_tasks!inner(name, status, tenant_id, sort_order)')
    .eq('worker_id', workerId)
    .eq('phase_tasks.tenant_id', tenantId)
    .neq('phase_tasks.status', 'done')
    .order('sort_order', { referencedTable: 'phase_tasks' })
  return (data ?? []).map((row: any) => ({ name: row.phase_tasks.name as string }))
}

// Pushes to every ADMIN/OWNER with a linked LINE account for this
// tenant -- same user_roles.line_user_id the "เชื่อมต่อ LINE ส่วนตัว" card
// in CommunicationCenter.jsx sets up. Best-effort: a push failure never
// blocks the PO/leave request itself from having been created.
async function notifyAdmins(tenantId: string, text: string, toggleKey: string) {
  if (!(await isPushEnabled(admin, tenantId, toggleKey))) return
  const { data: admins } = await admin.from('user_roles').select('line_user_id').eq('tenant_id', tenantId).in('role', ['OWNER', 'ADMIN']).not('line_user_id', 'is', null)
  for (const a of admins ?? []) {
    await withPushBudget(admin, tenantId, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, a.line_user_id as string, text)).catch((e) => console.error('notifyAdmins push failed', e))
  }
}

// Remaining ลากิจ/ลาป่วย for the current (Bangkok) calendar year -- mirrors
// useLeaveQuotaUsage/useSickLeaveQuotaUsage in src/hooks/useSupabase.js
// EXACTLY (same worker_assignments row-count * 0.5 convention, same legacy
// 'leave' => leave_personal rule) so the LINE-side numbers never drift from
// what HR.jsx/MySchedule.jsx show in the app itself.
async function leaveQuotaRemaining(workerId: string, annualLeaveDays: number, annualSickDays: number) {
  const year = Number(bangkokToday().slice(0, 4))
  const from = `${year}-01-01`
  const to = `${year}-12-31`
  const [personalRes, sickRes] = await Promise.all([
    admin.from('worker_assignments').select('id').eq('worker_id', workerId).in('type', ['leave_personal', 'leave']).gte('date', from).lte('date', to),
    admin.from('worker_assignments').select('id').eq('worker_id', workerId).eq('type', 'leave_sick').gte('date', from).lte('date', to),
  ])
  const personalUsed = (personalRes.data?.length ?? 0) * 0.5
  const sickUsed = (sickRes.data?.length ?? 0) * 0.5
  return { remainingPersonal: annualLeaveDays - personalUsed, remainingSick: annualSickDays - sickUsed }
}

// Confirms back to the WORKER who submitted the request -- previously only
// notifyAdmins fired, so a worker's only feedback was the one-time in-browser
// success message, easy to lose once they close the LINE in-app browser tab.
// Best-effort, same as notifyAdmins: a push failure never blocks the request
// itself from having been created.
async function notifyWorker(tenantId: string, lineUserId: string | null | undefined, text: string, toggleKey: string) {
  if (!lineUserId) return
  if (!(await isPushEnabled(admin, tenantId, toggleKey))) return
  await withPushBudget(admin, tenantId, () => sendLinePush(LINE_CHANNEL_ACCESS_TOKEN, lineUserId, text)).catch((e) => console.error('notifyWorker push failed', e))
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
      // Real gap closed 2026-10-01: this whole /f/<token> flow is reached
      // only via a LINE deep-link, but nothing downstream ever checked
      // line_bot module access -- see tenant-access.ts's header for the
      // full reasoning (same fix as line-webhook's).
      if (!(await tenantHasModuleAccess(admin, worker.tenant_id, 'line_bot'))) return json({ reason: 'line_bot_disabled' }, 200)
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

      if (tok.action_type === 'check_in' || tok.action_type === 'check_out') {
        const site = await resolveTodaysSite(worker.id, worker.tenant_id)
        if (!site) return json({ actionType: tok.action_type, workerName, reason: 'no_site' })
        return json({ actionType: tok.action_type, workerName, siteName: site.name })
      }
      if (tok.action_type === 'leave') {
        const { remainingPersonal, remainingSick } = await leaveQuotaRemaining(worker.id, worker.annual_leave_days ?? 0, worker.annual_sick_leave_days ?? 0)
        return json({ actionType: tok.action_type, workerName, remainingPersonal, remainingSick })
      }
      return json({ actionType: tok.action_type, workerName })
    }

    if (action === 'submit') {
      const result = await loadToken(token)
      if ('reason' in result) return json({ reason: result.reason }, 200)
      const { tok, worker } = result
      if (!(await tenantHasModuleAccess(admin, worker.tenant_id, 'line_bot'))) return json({ reason: 'line_bot_disabled' }, 200)
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
        await notifyAdmins(worker.tenant_id, `📦 ${workerName} ขอเบิกที่ไซต์ ${site.name}:\n${itemLines}\nสร้างใบสั่งซื้อร่างไว้ให้แล้ว รอเลือกซัพพลายเออร์และราคาที่ ${APP_URL}`, 'line_push_material_request_admin')
        return json({ ok: true, workerName })
      }

      if (tok.action_type === 'leave') {
        const leaveType = body?.leaveType as string | undefined
        const dateFrom = body?.dateFrom as string | undefined
        const dateTo = (body?.dateTo as string | undefined) || dateFrom
        const reason = body?.reason ? String(body.reason).trim() : null
        const requestedShift = body?.shift as string | undefined
        if (leaveType !== 'leave_sick' && leaveType !== 'leave_personal') return json({ error: 'invalid_leave_type' }, 400)
        if (!dateFrom) return json({ error: 'missing_date' }, 400)
        // Morning/afternoon-only leave only makes sense for a single day --
        // never trust the client for a multi-day range, force full_day
        // server-side regardless of what shift value was sent.
        const shift = dateFrom === dateTo && (requestedShift === 'morning' || requestedShift === 'evening') ? requestedShift : 'full_day'
        const { error } = await admin.from('leave_requests').insert({
          tenant_id: worker.tenant_id, worker_id: tok.worker_id, leave_type: leaveType, date_from: dateFrom, date_to: dateTo, reason, shift,
        })
        if (error) return json({ error: error.message }, 500)

        await admin.from('line_deep_link_tokens').update({ used_at: new Date().toISOString() }).eq('id', tok.id)
        const leaveLabel = leaveType === 'leave_sick' ? 'ลาป่วย' : 'ลากิจ'
        const shiftLabel = shift === 'morning' ? ' (ช่วงเช้า)' : shift === 'evening' ? ' (ช่วงบ่าย)' : ''
        const dateLabel = dateFrom === dateTo ? dateFrom : `${dateFrom} — ${dateTo}`
        await notifyAdmins(worker.tenant_id, `🏖️ ${workerName} ขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel}\nรออนุมัติที่หน้าบุคคล → คำขอลา`, 'line_push_leave_request_admin')
        await notifyWorker(worker.tenant_id, worker.line_user_id, `✅ ส่งคำขอ${leaveLabel}${shiftLabel} วันที่ ${dateLabel} เรียบร้อยแล้ว\nรอแอดมิน/เจ้าของตรวจสอบและอนุมัติ`, 'line_push_leave_ack_worker')
        return json({ ok: true, workerName })
      }

      if (tok.action_type === 'check_in' || tok.action_type === 'check_out') {
        const lat = Number(body?.lat)
        const lng = Number(body?.lng)
        if (!Number.isFinite(lat) || !Number.isFinite(lng)) return json({ error: 'missing_location' }, 400)

        const site = await resolveTodaysSite(worker.id, worker.tenant_id)
        if (!site) return json({ error: 'no_site' }, 400)

        const rpcName = tok.action_type === 'check_in' ? 'perform_worker_checkin_by_id' : 'perform_worker_checkout_by_id'
        const { data, error } = await admin.rpc(rpcName, { p_worker_id: worker.id, p_site_id: site.id, p_lat: lat, p_lng: lng })
        const result = data?.[0] as { success: boolean; distance_m: number | null; radius_m: number | null; message: string } | undefined
        if (error || !result) return json({ error: error?.message ?? 'rpc_failed' }, 500)

        if (!result.success) {
          // Distance rejection -- token stays unused so the same link
          // can be retried after walking closer, within its 30-minute
          // window, same UX the old LINE-location two-step flow had.
          return json({ ok: false, message: result.message, distanceM: result.distance_m, radiusM: result.radius_m })
        }

        await admin.from('line_deep_link_tokens').update({ used_at: new Date().toISOString() }).eq('id', tok.id)

        const openTasks = tok.action_type === 'check_in' ? await resolveOpenTasksForWorker(worker.id, worker.tenant_id) : []
        return json({ ok: true, message: result.message, siteName: site.name, openTasks: openTasks.map(t => t.name) })
      }

      return json({ error: 'unknown_action_type' }, 400)
    }

    return json({ error: 'unknown_action' }, 400)
  } catch (e) {
    return json({ error: (e as Error).message }, 500)
  }
})
