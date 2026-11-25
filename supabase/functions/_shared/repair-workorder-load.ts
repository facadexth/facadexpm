// Reads everything the repair work order (ใบงานซ่อม) prints and returns a WorkOrderInput for
// buildWorkOrder (_shared/repair-workorder.ts). Shared by the web app (src/lib/repairWorkorderLoad.js,
// logged-in client under RLS) and the repair-workorder edge function (service-role client), so:
//   - only plain supabase-js query calls (from/select/eq/order/limit/maybeSingle), no Deno/web imports;
//   - nothing relies on RLS or the logged-in user: the ticket is read first and every other query is
//     also filtered by the ticket's tenant_id.
// Signed URLs come from the caller (signUrls), so the storage client and expiry stay the caller's choice.
// Every query error throws Error('โหลดใบงานซ่อมไม่สำเร็จ: …').

import type { WorkOrderInput } from './repair-workorder.ts'

export const REPAIR_MEDIA_BUCKET = 'repair-media'
export const RECEIPT_BUCKET = 'document-receipts'
export const RECEIPT_DOCUMENT_TYPE = 'repair_ticket'

// deno-lint-ignore no-explicit-any
type Db = any
export type SignUrls = (bucket: string, paths: string[]) => Promise<(string | null)[]>
export type LoadOptions = { today: string; signUrls: SignUrls; tenant: WorkOrderInput['tenant'] }

const FAIL = 'โหลดใบงานซ่อมไม่สำเร็จ: '

function fail(e: { message?: string } | null | undefined): never {
  throw new Error(FAIL + (e?.message || 'ไม่ทราบสาเหตุ'))
}

// Signs the non-empty paths in one call; result is aligned with `paths` (null where missing/failed).
async function signAligned(signUrls: SignUrls, bucket: string, paths: (string | null | undefined)[]): Promise<(string | null)[]> {
  const wanted = paths.filter((p): p is string => typeof p === 'string' && p !== '')
  if (!wanted.length) return paths.map(() => null)
  const signed = await signUrls(bucket, wanted)
  const byPath = new Map<string, string | null>()
  wanted.forEach((p, i) => byPath.set(p, signed?.[i] ?? null))
  return paths.map((p) => (p ? byPath.get(p) ?? null : null))
}

export async function loadWorkOrderInput(db: Db, ticketId: string, opts: LoadOptions): Promise<WorkOrderInput> {
  const { today, signUrls, tenant } = opts

  const { data: t, error: te } = await db.from('repair_tickets')
    .select('id, tenant_id, ticket_number, created_at, source, description, scheduled_date, scheduled_start, duration_hours, preferred_days, preferred_slot, sites(name, location, map_url, lat, lng, handover_date, warranty_months), clients(name, phone)')
    .eq('id', ticketId).maybeSingle()
  if (te) fail(te)
  if (!t) fail({ message: 'ไม่พบงานซ่อมนี้' })
  const tenantId = t.tenant_id

  const { data: items, error: ie } = await db.from('repair_ticket_items')
    .select('id, seq, location, room, symptom, note')
    .eq('tenant_id', tenantId).eq('ticket_id', t.id).order('seq', { ascending: true })
  if (ie) fail(ie)

  // Only the customer's images/videos are printed; plain files (PDF etc.) cannot go in an <img>.
  const { data: mediaRows, error: me } = await db.from('repair_ticket_media')
    .select('id, item_id, role, media_type, storage_path, created_at')
    .eq('tenant_id', tenantId).eq('ticket_id', t.id).eq('role', 'customer')
    .order('created_at', { ascending: true })
  if (me) fail(me)
  const media = ((mediaRows || []) as Array<{ id: string; item_id: string | null; role: string; media_type: string; storage_path: string }>)
    .filter((m) => m.media_type === 'image' || m.media_type === 'video')
  // Videos print as a "▶ วิดีโอ" tile, so only images need a URL.
  const mediaUrls = await signAligned(signUrls, REPAIR_MEDIA_BUCKET, media.map((m) => (m.media_type === 'image' ? m.storage_path : null)))

  // Crew = the ticket's assignments on the appointment day (one row per shift -> one entry per worker;
  // leader when any of that worker's rows is marked).
  const crew: WorkOrderInput['crew'] = []
  if (t.scheduled_date) {
    const { data: rows, error: ce } = await db.from('worker_assignments')
      .select('worker_id, is_team_leader, workers(name, nickname)')
      .eq('tenant_id', tenantId).eq('repair_ticket_id', t.id).eq('date', t.scheduled_date)
      .order('created_at', { ascending: true })
    if (ce) fail(ce)
    const byWorker = new Map<string, WorkOrderInput['crew'][number]>()
    for (const r of (rows || []) as Array<{ worker_id: string; is_team_leader?: boolean | null; workers?: { name?: string | null; nickname?: string | null } | null }>) {
      const seen = byWorker.get(r.worker_id)
      if (seen) { if (r.is_team_leader) seen.is_team_leader = true; continue }
      const entry = { name: r.workers?.name || '', nickname: r.workers?.nickname || null, is_team_leader: !!r.is_team_leader }
      byWorker.set(r.worker_id, entry)
      crew.push(entry)
    }
  }

  // Latest customer signature (signing again adds a new row; the newest one is printed).
  const { data: receipts, error: re } = await db.from('document_receipts')
    .select('signer_name, signed_at, signature_path')
    .eq('tenant_id', tenantId).eq('document_type', RECEIPT_DOCUMENT_TYPE).eq('document_id', t.id)
    .order('signed_at', { ascending: false }).limit(1)
  if (re) fail(re)
  const r0 = (receipts || [])[0] as { signer_name: string; signed_at: string; signature_path: string | null } | undefined
  let receipt: WorkOrderInput['receipt'] = null
  if (r0) {
    const [url] = await signAligned(signUrls, RECEIPT_BUCKET, [r0.signature_path])
    receipt = { signer_name: r0.signer_name, signed_at: r0.signed_at, signature_url: url }
  }

  return {
    tenant: tenant || {},
    ticket: {
      ticket_number: t.ticket_number, created_at: t.created_at, source: t.source, description: t.description ?? null,
      scheduled_date: t.scheduled_date ?? null, scheduled_start: t.scheduled_start ?? null, duration_hours: t.duration_hours ?? null,
      preferred_days: t.preferred_days ?? null, preferred_slot: t.preferred_slot ?? null,
    },
    site: t.sites ?? null,
    client: t.clients ?? null,
    items: items || [],
    media: media.map((m, i) => ({
      id: m.id, item_id: m.item_id ?? null, role: m.role, media_type: m.media_type as 'image' | 'video', url: mediaUrls[i],
    })),
    crew,
    receipt,
    today,
  }
}
