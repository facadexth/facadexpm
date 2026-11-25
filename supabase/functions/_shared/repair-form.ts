// Validation rules for the LINE customer repair form.
// Shared by the form page (via vitest/Vite import), the repair-form edge
// function and the staff modal. Pure: no Deno or supabase imports.

export const LOCATIONS: readonly string[] = Object.freeze([
  'ห้องนอน', 'ห้องนั่งเล่น', 'ครัว', 'ห้องน้ำ', 'ระเบียง', 'ภายนอก', 'อื่นๆ',
])

export const SYMPTOMS: readonly string[] = Object.freeze([
  'รั่วซึม', 'เปิดปิดยาก', 'กระจกร้าว-แตก', 'ซีลยางหลุด', 'มือจับ-กลอนเสีย', 'อื่นๆ',
])

export const OTHER = 'อื่นๆ'

export const LIMITS = Object.freeze({
  maxItems: 20,
  maxImages: 5,
  maxVideos: 1,
  maxVideoSeconds: 30,
  maxBytes: 50 * 1024 * 1024,
  maxPreferredDays: 3,
  maxDaysAhead: 60,
})

export const SLOTS = Object.freeze({ morning: 'เช้า', afternoon: 'บ่าย', all_day: 'ทั้งวัน' })

export type Slot = 'morning' | 'afternoon' | 'all_day'

export type FormFile = { path: string; mediaType: 'image' | 'video'; bytes: number; seconds?: number }
export type FormItem = { location: string; room?: string; symptom: string; note?: string; files: FormFile[] }
export type FormPayload = {
  siteId: string
  items: FormItem[]
  preferredDays: string[] // YYYY-MM-DD
  preferredSlot: Slot | null
  note?: string
}

const blank = (s: unknown) => typeof s !== 'string' || s.trim() === ''

export function validateItem(item: FormItem): string[] {
  const errors: string[] = []
  if (!LOCATIONS.includes(item?.location)) errors.push('เลือกตำแหน่ง')
  if (!SYMPTOMS.includes(item?.symptom)) errors.push('เลือกอาการ')
  else if (item.symptom === OTHER && blank(item.note)) errors.push('อาการอื่นๆ กรุณาพิมพ์รายละเอียด')

  const files = Array.isArray(item?.files) ? item.files : []
  const images = files.filter((f) => f?.mediaType === 'image')
  const videos = files.filter((f) => f?.mediaType === 'video')
  if (images.length < 1) errors.push('ต้องมีรูปอย่างน้อย 1 รูป')
  if (images.length > LIMITS.maxImages) errors.push(`รูปได้ไม่เกิน ${LIMITS.maxImages} รูป`)
  if (videos.length > LIMITS.maxVideos) errors.push('วิดีโอได้ 1 คลิป')
  if (videos.some((v) => typeof v.seconds === 'number' && v.seconds > LIMITS.maxVideoSeconds)) {
    errors.push(`วิดีโอยาวได้ไม่เกิน ${LIMITS.maxVideoSeconds} วินาที`)
  }
  if (files.some((f) => !(typeof f?.bytes === 'number') || f.bytes > LIMITS.maxBytes)) {
    errors.push('ไฟล์ใหญ่เกิน 50 MB')
  }
  return errors
}

// ---- dates: plain YYYY-MM-DD strings, UTC math ----

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/

function parseDay(s: string): number | null {
  const m = typeof s === 'string' ? DATE_RE.exec(s) : null
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const t = Date.UTC(y, mo - 1, d)
  const back = new Date(t)
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) return null
  return t
}

const DAY_MS = 24 * 60 * 60 * 1000
const fmtDay = (t: number) => new Date(t).toISOString().slice(0, 10)

export function addDays(day: string, n: number): string {
  const t = parseDay(day)
  if (t === null) throw new Error(`bad date: ${day}`)
  return fmtDay(t + n * DAY_MS)
}

export function preferredDayBounds(todayBangkok: string): { min: string; max: string } {
  return { min: addDays(todayBangkok, 1), max: addDays(todayBangkok, LIMITS.maxDaysAhead) }
}

const isSlot = (s: unknown): s is Slot =>
  typeof s === 'string' && Object.prototype.hasOwnProperty.call(SLOTS, s)

export function validateRepairForm(p: FormPayload, todayBangkok: string): string[] {
  const errors: string[] = []
  const items = Array.isArray(p?.items) ? p.items : []
  if (items.length === 0) errors.push('ยังไม่มีรายการ')
  if (items.length > LIMITS.maxItems) errors.push(`ได้ไม่เกิน ${LIMITS.maxItems} รายการ`)
  items.forEach((item, i) => {
    for (const e of validateItem(item)) errors.push(`รายการ ${i + 1}: ${e}`)
  })

  const days = Array.isArray(p?.preferredDays) ? p.preferredDays : []
  if (days.length > LIMITS.maxPreferredDays) errors.push(`เลือกได้ไม่เกิน ${LIMITS.maxPreferredDays} วัน`)
  if (new Set(days).size !== days.length) errors.push('วันซ้ำกัน')
  if (days.length > 0) {
    const { min, max } = preferredDayBounds(todayBangkok)
    let bad = false, early = false, late = false
    for (const d of days) {
      if (parseDay(d) === null) bad = true
      else if (d < min) early = true // ISO strings compare in date order
      else if (d > max) late = true
    }
    if (bad) errors.push('วันที่ไม่ถูกต้อง')
    if (early) errors.push('เลือกวันตั้งแต่พรุ่งนี้')
    if (late) errors.push(`เลือกได้ไม่เกิน ${LIMITS.maxDaysAhead} วัน`)
    if (!p.preferredSlot || !isSlot(p.preferredSlot)) errors.push('เลือกช่วงเวลา')
  } else if (p?.preferredSlot != null && !isSlot(p.preferredSlot)) {
    errors.push('เลือกช่วงเวลา')
  }
  return errors
}

export function itemsDescription(items: FormItem[]): string {
  return (items || []).map((it, i) => {
    let line = `${i + 1}. ${it.location}`
    if (!blank(it.room)) line += ` (${it.room!.trim()})`
    line += ` — ${it.symptom}`
    if (!blank(it.note)) line += `: ${it.note!.trim()}`
    return line
  }).join('\n')
}
