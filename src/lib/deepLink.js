// src/lib/deepLink.js
// Deep links into a tab: `#tab=<id>(&key=value)*` (sticker QR codes, push notifications). The hash is untrusted
// input: only the known keys below, only values matching VALUE, anything else is dropped. App.jsx sets the tab and
// parks the params in sessionStorage (survives the login screen and a reload); the tab's page takes them once.
const KEYS = ['project', 'item', 'offcut']
const VALUE = /^[\w-]{1,64}$/
const STORAGE_KEY = 'deeplink'
const MAX_AGE_MS = 10 * 60 * 1000
export const NOT_FOUND_TEXT = 'ไม่พบโปรเจกต์/บานนี้ หรือไม่มีสิทธิ์เข้าถึง'

const cleanParams = raw => {
  const out = {}
  for (const k of KEYS) if (typeof raw[k] === 'string' && VALUE.test(raw[k])) out[k] = raw[k]
  return out
}

// '#tab=estimation&project=a&item=b' -> { tab: 'estimation', params: { project: 'a', item: 'b' } }; not a tab link -> null.
export function parseDeepLink(hash) {
  if (typeof hash !== 'string') return null
  const [first, ...rest] = hash.replace(/^#/, '').split('&')
  const m = /^tab=([\w-]+)$/.exec(first || '')
  if (!m) return null
  const raw = {}
  for (const part of rest) {
    const i = part.indexOf('=')
    if (i < 1) continue
    const k = part.slice(0, i)
    if (KEYS.includes(k) && !(k in raw)) raw[k] = part.slice(i + 1)
  }
  return { tab: m[1], params: cleanParams(raw) }
}

export function saveDeepLink(link, now = Date.now()) {
  if (!link || !Object.keys(link.params || {}).length) return
  try { sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ tab: link.tab, at: now, params: link.params })) } catch { /* storage blocked: the tab still opens */ }
}

// The parked params for `tab`, removed on read (once only). Another tab's or a stale link is dropped too.
export function takeDeepLink(tab, now = Date.now()) {
  let stored = null
  try {
    const s = sessionStorage.getItem(STORAGE_KEY)
    if (s == null) return null
    sessionStorage.removeItem(STORAGE_KEY)
    stored = JSON.parse(s)
  } catch { return null }
  if (!stored || typeof stored !== 'object' || stored.tab !== tab || !(now - Number(stored.at) <= MAX_AGE_MS)) return null
  const params = cleanParams(stored.params && typeof stored.params === 'object' ? stored.params : {})
  return Object.keys(params).length ? params : null
}

// What the estimation page should open for these params, looked up only in the lists it already loaded (RLS-scoped):
// { projectId?, itemId?, tab?, offcutCode?, notice? }. `offcut` = the alu_offcuts row found by the code, or null.
export function resolveEstimationLink(params, { projects, openings, offcut }) {
  const projectIds = new Set((projects || []).map(p => p.id))
  if (params.offcut) {
    const code = params.offcut
    if (!offcut) return { notice: `ไม่พบเศษ ${code} หรือไม่มีสิทธิ์เข้าถึง` }
    if (offcut.status !== 'in_stock') return { notice: `เศษ ${code} ไม่อยู่ในสต็อกแล้ว (ถูกใช้หรือทิ้งไปแล้ว)` }
    if (!offcut.source_project_id || !projectIds.has(offcut.source_project_id)) return { notice: `ไม่พบโปรเจกต์ที่มาของเศษ ${code} หรือไม่มีสิทธิ์เข้าถึง` }
    return { projectId: offcut.source_project_id, tab: 'bom', offcutCode: code }
  }
  const opening = params.item ? (openings || []).find(o => o.id === params.item) : null
  const projectId = params.project || (opening ? opening.project_id : null)
  if (!projectId) return params.item ? { notice: NOT_FOUND_TEXT } : {}
  if (!projectIds.has(projectId)) return { notice: NOT_FOUND_TEXT }
  if (!params.item) return { projectId }
  if (!opening || opening.project_id !== projectId) return { projectId, notice: NOT_FOUND_TEXT }
  return { projectId, itemId: opening.id }
}
