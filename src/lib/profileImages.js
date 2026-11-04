// src/lib/profileImages.js
// Profile cross-section pictures (alu_profiles.image_path) in the private estimation-images bucket:
// signed URLs (batched, cached), the "t = <thickness> mm" band every picture carries, and replace / remove.
import { useEffect, useState } from 'react'
import { supabase } from './supabase.js'

export const PROFILE_IMAGE_BUCKET = 'estimation-images'
const SIGN_SECONDS = 3600
const CHUNK = 100
const cache = new Map() // path -> { url, until }

// Same text as the imported catalogue pictures: one decimal for whole tenths (2 -> 2.0), otherwise as is (1.25).
export function thicknessLabel(t) {
  const v = Number(t)
  if (t === null || t === undefined || t === '' || !Number.isFinite(v) || v <= 0) return 't = ?'
  return `t = ${Math.round(v * 10) / 10 === v ? v.toFixed(1) : String(v)} mm`
}

// A new name per upload, so a browser or CDN copy of the old picture is never shown for the new one.
export const profileImagePath = (tenantId, profileId, now = Date.now()) => `${tenantId}/profiles/${profileId}-${now}.png`

export async function signImagePaths(paths, now = Date.now()) {
  const out = {}
  const need = []
  for (const p of new Set((paths || []).filter(Boolean))) {
    const c = cache.get(p)
    if (c && c.until > now) out[p] = c.url
    else need.push(p)
  }
  for (let i = 0; i < need.length; i += CHUNK) {
    const { data, error } = await supabase.storage.from(PROFILE_IMAGE_BUCKET).createSignedUrls(need.slice(i, i + CHUNK), SIGN_SECONDS)
    if (error) throw error
    for (const r of data || []) {
      if (!r.signedUrl || r.error) continue
      out[r.path] = r.signedUrl
      cache.set(r.path, { url: r.signedUrl, until: now + (SIGN_SECONDS - 300) * 1000 })
    }
  }
  return out
}

export const clearImageUrlCache = () => cache.clear()

// { [path]: url } for the given paths. A path without a URL (no access, missing file) simply has no picture.
export function useImageUrls(paths) {
  const key = [...new Set((paths || []).filter(Boolean))].sort().join('\n')
  const [urls, setUrls] = useState({})
  useEffect(() => {
    if (!key) { setUrls({}); return }
    let live = true
    signImagePaths(key.split('\n')).then(u => { if (live) setUrls(u) }).catch(() => { if (live) setUrls({}) })
    return () => { live = false }
  }, [key])
  return urls
}

// Draws the picture on white with the thickness band underneath, like the catalogue imports. Browser only.
export async function stampThickness(file, thickness) {
  const bmp = await createImageBitmap(file)
  const scale = Math.min(1, 900 / bmp.width)
  const w = Math.max(1, Math.round(bmp.width * scale))
  const h = Math.max(1, Math.round(bmp.height * scale))
  const band = Math.max(40, Math.round(w * 0.08))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h + band
  const ctx = canvas.getContext('2d')
  ctx.fillStyle = '#ffffff'
  ctx.fillRect(0, 0, w, h + band)
  ctx.drawImage(bmp, 0, 0, w, h)
  ctx.fillStyle = '#000000'
  ctx.font = `${Math.round(band * 0.6)}px Helvetica, Arial, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(thicknessLabel(thickness), w / 2, h + band / 2)
  return new Promise((resolve, reject) => canvas.toBlob(b => (b ? resolve(b) : reject(new Error('แปลงรูปไม่สำเร็จ'))), 'image/png'))
}

// Uploads the stamped picture under a new name, points the profile at it, then drops the old file.
export async function replaceProfileImage({ tenantId, profile, file, stamp = stampThickness, now = Date.now() }) {
  if (!file || !/^image\//.test(file.type || '')) throw new Error('เลือกไฟล์รูป (PNG, JPG)')
  const blob = await stamp(file, profile.thickness_mm)
  const path = profileImagePath(tenantId, profile.id, now)
  const { error: e1 } = await supabase.storage.from(PROFILE_IMAGE_BUCKET).upload(path, blob, { contentType: 'image/png', upsert: false })
  if (e1) throw e1
  const { error: e2 } = await supabase.from('alu_profiles').update({ image_path: path }).eq('id', profile.id)
  if (e2) {
    await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([path])
    throw e2
  }
  // The old file is unreferenced now; failing to delete it leaves an unused file, never a broken picture.
  if (profile.image_path && profile.image_path !== path) await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([profile.image_path])
  return path
}

export async function removeProfileImage({ profile }) {
  const { error } = await supabase.from('alu_profiles').update({ image_path: null }).eq('id', profile.id)
  if (error) throw error
  if (profile.image_path) await supabase.storage.from(PROFILE_IMAGE_BUCKET).remove([profile.image_path])
}
