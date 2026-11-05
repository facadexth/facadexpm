// src/lib/providerLogos.js
// Extruder logos (alu_providers.logo_path) in the same private bucket as the profile pictures.
// Signed URLs come from useImageUrls in profileImages.js.
import { supabase } from './supabase.js'
import { PROFILE_IMAGE_BUCKET } from './profileImages.js'

// A new name per upload, so a cached copy of the old logo is never shown for the new one.
export const providerLogoPath = (tenantId, providerId, now = Date.now()) => `${tenantId}/logos/${providerId}-${now}.png`

// Scales the picture down to at most 600 px wide on its own background. Browser only.
export async function shrinkLogo(file) {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 600 / bmp.width)
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(bmp.width * scale))
  canvas.height = Math.max(1, Math.round(bmp.height * scale))
  canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height)
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/png'))
}

// Uploads under a new name, points the extruder at it, then drops the old file.
export async function replaceProviderLogo({ tenantId, provider, file, shrink = shrinkLogo, now = Date.now() }) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('เลือกไฟล์รูป (PNG, JPG)')
  const blob = await shrink(file)
  const path = providerLogoPath(tenantId, provider.id, now)
  const { error: e1 } = await supabase.storage.from(PROFILE_IMAGE_BUCKET).upload(path, blob, { contentType: 'image/png', upsert: false })
  if (e1) throw e1
  const { data, error: e2 } = await supabase.from('alu_providers').update({ logo_path: path }).eq('id', provider.id).select('id')
  if (e2 || !data?.length) {
    await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([path])
    throw e2 || new Error('ไม่มีสิทธิ์แก้โรงรีดนี้')
  }
  // The old file is unreferenced now; failing to delete it leaves an unused file, never a broken logo.
  if (provider.logo_path && provider.logo_path !== path) await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([provider.logo_path])
  return path
}

export async function removeProviderLogo({ provider }) {
  const { data, error } = await supabase.from('alu_providers').update({ logo_path: null }).eq('id', provider.id).select('id')
  if (error) throw error
  if (!data?.length) throw new Error('ไม่มีสิทธิ์แก้โรงรีดนี้')
  if (provider.logo_path) await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([provider.logo_path])
}
