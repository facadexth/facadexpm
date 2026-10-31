// Staff photo upload for repair tickets (งานซ่อม): downscale with the shared photoUpload helper,
// store in the private bucket repair-media at {tenantId}/{ticketId}/{role}-{ts}-{rand}.jpg
// (first folder = tenant, matching the bucket's storage policy), then insert the
// repair_ticket_media row. If the row insert fails, the uploaded object is removed again.
import { supabase } from './supabase.js'
import { downscaleToJpegBlob } from './photoUpload.js'

export const REPAIR_BUCKET = 'repair-media'

export function repairPhotoPath(tenantId, ticketId, role, nowMs = Date.now(), rand = Math.random().toString(36).slice(2, 8)) {
  return `${tenantId}/${ticketId}/${role}-${nowMs}-${rand}.jpg`
}

export async function uploadRepairPhoto({ file, tenantId, ticketId, role }) {
  if (!tenantId || !ticketId) throw new Error('ไม่พบข้อมูลบริษัทหรืองานซ่อม')
  if (!['customer', 'before', 'after'].includes(role)) throw new Error(`role ไม่ถูกต้อง: ${role}`)
  const blob = await downscaleToJpegBlob(file)
  const path = repairPhotoPath(tenantId, ticketId, role)
  const { error: upErr } = await supabase.storage.from(REPAIR_BUCKET).upload(path, blob, { contentType: 'image/jpeg' })
  if (upErr) throw upErr
  const row = {
    tenant_id: tenantId, ticket_id: ticketId, role, media_type: 'image', storage_path: path,
    file_name: file?.name || null, mime: 'image/jpeg', size_bytes: blob.size,
  }
  const { data, error: insErr } = await supabase.from('repair_ticket_media').insert(row).select('id, ticket_id, role, media_type, storage_path, file_name, created_at').single()
  if (insErr) {
    const { error: rmErr } = await supabase.storage.from(REPAIR_BUCKET).remove([path])
    if (rmErr) console.error('repair-media orphan cleanup failed', path, rmErr)
    throw insErr
  }
  return data
}

// Uploads every file, continuing past single failures. { succeeded: [rows], failed: [{file, error}] }.
export async function uploadRepairPhotos(files, opts) {
  const succeeded = []
  const failed = []
  for (const file of Array.from(files || [])) {
    try { succeeded.push(await uploadRepairPhoto({ file, ...opts })) } catch (error) { failed.push({ file, error }) }
  }
  return { succeeded, failed }
}
