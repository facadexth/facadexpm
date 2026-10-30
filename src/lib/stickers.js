// src/lib/stickers.js
// Piece and offcut stickers from a cut plan (live or the issued snapshot). Pure: the QR images and end glyphs are
// drawn in stickerRender.js; the text (die tag, finish line) by StickerFace in StickerSheet.jsx. Order = cutting order: per group, stock-offcut bars then new bars; each bar's pieces,
// then its remainder. Piece numbering k/total runs across the whole project.

export const PAPERS = {
  roll50x30: { w: 50, h: 30, label: 'ม้วน 50×30 มม.' },
  roll60x40: { w: 60, h: 40, label: 'ม้วน 60×40 มม.' },
  roll40x30: { w: 40, h: 30, label: 'ม้วน 40×30 มม.' },
  a4x24: { sheet: 'a4', cols: 3, rows: 8, w: 70, h: 37, label: 'A4 24 ดวง (70×37 มม.)' },
}

export const NEW_OFFCUT_CODE = 'OC-ใหม่'

// Printed in red in place of the die no. when the profile has none (alu_profiles.drawing_no empty).
export const NO_DIE_TEXT = 'ไม่มีรหัส'

// Font size (mm, on a 50×30 label) of the finish line: the largest that fits the text on 2 lines of the ~35 mm text
// column beside the QR (about 0.6 em per character), never under 1.4 mm. The line wraps; it is never cut with "…".
const FINISH_SIZES = [2.2, 1.9, 1.6, 1.4]
export function finishFontMm(text) {
  const n = String(text || '').length
  return FINISH_SIZES.find(fs => Math.ceil((n * 0.6 * fs) / 35) <= 2) ?? FINISH_SIZES[FINISH_SIZES.length - 1]
}

const END_LABELS = { square: '90°', miter45: '45°', notch: 'บาก' }
export const endLabel = end => END_LABELS[end] || END_LABELS.square

// bomEngine.js names the grid lines in English; the shop reads Thai.
const ROLE_TH = { 'Horizontal rail': 'ซอยนอน', 'Vertical mullion': 'ซอยตั้ง' }
export const roleTh = name => ROLE_TH[name] || name || ''

const size = n => (Number(n) > 0 ? String(Number(n)) : null)
// "บากรับกรอบนอน 20×8"; the size only when both are known, never "null×null".
export function notchText(notch) {
  if (!notch) return null
  const name = notch.joint_name || 'บาก'
  const w = size(notch.width_mm), d = size(notch.depth_mm)
  return w && d ? `${name} ${w}×${d}` : name
}

// dd/mm/yy in the Buddhist year (27/10/69), as the shop writes dates.
export function shortDate(date) {
  const d = new Date(date)
  const p = n => String(n).padStart(2, '0')
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${p((d.getFullYear() + 543) % 100)}`
}

// Offcuts an issued plan stocked: { [plan_key]: code }, any status (a kept offcut later used or discarded still had
// its sticker). Rows come from alu_offcuts.
export function issuedOffcutCodes(offcutRows, planId) {
  const out = {}
  if (!planId) return out
  for (const r of offcutRows || []) if (r.source_plan_id === planId && r.plan_key) out[r.plan_key] = r.code
  return out
}

// Kept = goes into offcut stock. Issued plan (codes given): kept ⇔ it got a code. Live plan: the default (≥ min keep)
// unless the user flipped it.
export function isOffcutKept(offcut, { codes, flipped } = {}) {
  if (!offcut) return false
  if (codes) return Object.prototype.hasOwnProperty.call(codes, offcut.key)
  return offcut.keep !== !!(flipped && flipped.has(offcut.key))
}

const mmOf = m => Math.round(Number(m) * 1000)

// codes: null/undefined before issue (every remainder gets a sticker, code "OC-ใหม่"); after issue the
// issuedOffcutCodes map (only kept remainders get a sticker). items: { opening_no: opening id } fallback for the QR.
export function stickerModel({ plan, projectName, projectId, items, codes, date }) {
  if (!plan) return []
  const groups = plan.groups || []
  const total = groups.reduce((n, g) => n + [...g.offcutBars, ...g.bars].reduce((a, b) => a + b.pieces.length, 0), 0)
  const day = shortDate(date || new Date())
  const out = []
  let k = 0
  for (const g of groups) {
    const finish = g.finish_name || ''
    const die = g.die_no || null
    // An offcut sticker has no part name, so its finish line names the profile too.
    const offFinish = [g.name, finish].filter(Boolean).join(' · ')
    const byKey = new Map((g.newOffcuts || []).map(o => [o.key, o]))
    const seq = [
      ...g.offcutBars.map(b => ({ bar: b, ref: b.offcut.code, label: b.offcut.code, barNo: null })),
      ...g.bars.map((b, i) => ({ bar: b, ref: String(i + 1), label: `เส้น ${i + 1}`, barNo: i + 1 })),
    ]
    for (const { bar, ref, label, barNo } of seq) {
      for (const p of bar.pieces) {
        k++
        const openingId = p.item_id ?? (items || {})[p.opening_no] ?? null
        out.push({
          kind: 'piece', groupKey: g.key, barNo, seq: k, total, title: `${p.opening_no} · ${roleTh(p.role_name)}`, length_mm: mmOf(p.length_m), die, finish,
          ends: [p.end_a || 'square', p.end_b || 'square'], notchText: notchText(p.notch), footL: projectName || '', footR: `${label} · ${k}/${total}`,
          qr: openingId ? `#tab=estimation&project=${projectId}&item=${openingId}` : `#tab=estimation&project=${projectId}`,
        })
      }
      const o = byKey.get(`${g.key}#${ref}`)
      if (!o || (codes && !isOffcutKept(o, { codes }))) continue
      const code = codes ? codes[o.key] : null
      out.push({
        kind: 'offcut', groupKey: g.key, barNo, title: 'เศษ → เข้าสต็อก', code: code || NEW_OFFCUT_CODE, length_mm: mmOf(o.length_m), die, finish: offFinish,
        ends: [o.end_a || 'square', 'square'], notchText: null, footL: `จาก ${projectName || ''}`, footR: `${label} · ${day}`,
        qr: code ? `#tab=estimation&offcut=${code}` : null, offKey: o.key, keepDefault: codes ? true : !!o.keep,
      })
    }
  }
  return out
}

// Print pages: one sticker per page on a roll, 24 per page on A4.
export function stickerPages(stickers, paper) {
  const per = paper && paper.sheet ? paper.cols * paper.rows : 1
  const pages = []
  for (let i = 0; i < (stickers || []).length; i += per) pages.push(stickers.slice(i, i + per))
  return pages
}

// Print rounds of `size` bars: [{ from: 1, to: 10 }, { from: 11, to: 20 }, ...] for n new bars.
export function barChunks(n, size = 10) {
  const out = []
  for (let a = 1; a <= n; a += size) out.push({ from: a, to: Math.min(n, a + size - 1) })
  return out
}

// A typed bar range (n >= 1): whole numbers inside 1..n, swapped when typed the other way round; a blank or
// non-number end becomes 1 (from) or n (to).
export function clampRange(from, to, n) {
  const whole = (v, fallback) => {
    const x = Math.trunc(Number(v))
    return String(v ?? '').trim() !== '' && Number.isFinite(x) ? Math.min(n, Math.max(1, x)) : fallback
  }
  let a = whole(from, 1)
  let b = whole(to, n)
  if (a > b) [a, b] = [b, a]
  return { from: a, to: b }
}

// One profile group's stickers from new bar `from` to bar `to`. Stock-offcut bars are cut before bar 1, so their
// pieces and remainders belong to the range that starts at bar 1. A remainder goes with its own bar.
export function stickersInRange(stickers, groupKey, from, to) {
  return (stickers || []).filter(s => s.groupKey === groupKey && (s.barNo == null ? from <= 1 : s.barNo >= from && s.barNo <= to))
}
