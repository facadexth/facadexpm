// ============================================================
// photoUpload -- shared client-side helper for uploading photos to the
// line-site-photos bucket + inserting their line_site_photos row, used
// by both the admin triage tray (PhaseKanbanBoard.jsx) and the WORKER
// per-task upload (MySchedule.jsx). Downscales every image before
// upload (a raw phone photo can be 5-10MB, a bulk selection a dozen at
// once) and follows the LINE webhook's own path convention exactly
// (<tenant_id>/<site_id>/<timestamp>-<worker_id>.jpg) so LINE- and
// web-originated photos stay indistinguishable to the rest of the app.
// See docs/superpowers/specs/2026-09-29-kanban-photo-upload-design.md.
// ============================================================
import { supabase } from './supabase.js'

/** Target size for an image before upload -- never upscales, only
 *  shrinks the longest side down to maxDim. Same math as
 *  poDocumentExtraction.js's computeDownscaledSize (kept as its own
 *  copy here since that module is PO-scan-specific and this one has no
 *  reason to depend on it). */
export function computePhotoDownscaledSize(width, height, maxDim = 1600) {
  if (width <= maxDim && height <= maxDim) return { width, height }
  const scale = width >= height ? maxDim / width : maxDim / height
  return { width: Math.round(width * scale), height: Math.round(height * scale) }
}

async function downscaleToJpegBlob(file, maxDim = 1600, quality = 0.8) {
  const bitmap = await createImageBitmap(file, { resizeWidth: maxDim, resizeQuality: 'medium', imageOrientation: 'from-image' })
  try {
    const { width, height } = computePhotoDownscaledSize(bitmap.width, bitmap.height, maxDim)
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    canvas.getContext('2d').drawImage(bitmap, 0, 0, width, height)
    return await new Promise((resolve, reject) => {
      canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/jpeg', quality)
    })
  } finally {
    bitmap.close()
  }
}

/**
 * Uploads one File to line-site-photos + inserts its line_site_photos
 * row. Removes the just-uploaded storage object if the DB insert fails,
 * so a partial failure never leaves an orphaned file with no DB row
 * (same shape as AttachmentsSection.jsx's own upload-then-insert
 * pattern). taskId may be null (an unassigned tray upload) or a fixed
 * value (a worker uploading straight to one task).
 */
export async function uploadSitePhoto({ file, tenantId, workerId, siteId, taskId = null, date }) {
  const blob = await downscaleToJpegBlob(file)
  const photoPath = `${tenantId}/${siteId}/${Date.now()}-${workerId}.jpg`
  const { error: uploadError } = await supabase.storage.from('line-site-photos').upload(photoPath, blob, { contentType: 'image/jpeg' })
  if (uploadError) throw uploadError
  const { error: insertError } = await supabase.from('line_site_photos')
    .insert({ tenant_id: tenantId, worker_id: workerId, site_id: siteId, date, photo_path: photoPath, task_id: taskId })
  if (insertError) {
    await supabase.storage.from('line-site-photos').remove([photoPath])
    throw insertError
  }
  return { photo_path: photoPath }
}

/**
 * Uploads every file in a FileList/array, continuing past individual
 * failures rather than aborting the whole batch. Returns which files
 * made it and which didn't (with their errors) so the caller can report
 * a single end-of-batch summary instead of one alert per file.
 */
export async function uploadSitePhotos(files, opts) {
  const succeeded = []
  const failed = []
  for (const file of Array.from(files)) {
    try {
      succeeded.push(await uploadSitePhoto({ file, ...opts }))
    } catch (error) {
      failed.push({ file, error })
    }
  }
  return { succeeded, failed }
}
