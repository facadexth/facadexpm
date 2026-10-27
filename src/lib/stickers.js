// src/lib/stickers.js
// Piece and offcut stickers from a cut plan (live or the issued snapshot). Pure: the QR images and end glyphs are
// drawn in stickerRender.js. Order = cutting order: per group, stock-offcut bars then new bars; each bar's pieces,
// then its remainder. Piece numbering k/total runs across the whole project.

export const PAPERS = {
  roll50x30: { w: 50, h: 30, label: 'ม้วน 50×30 มม.' },
  roll60x40: { w: 60, h: 40, label: 'ม้วน 60×40 มม.' },
  roll40x30: { w: 40, h: 30, label: 'ม้วน 40×30 มม.' },
  a4x24: { sheet: 'a4', cols: 3, rows: 8, w: 70, h: 37, label: 'A4 24 ดวง (70×37 มม.)' },
}

export const NEW_OFFCUT_CODE = 'OC-ใหม่'

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
    const sub = [g.die_no || g.name || '', finish].filter(Boolean).join(' · ')
    const offSub = [[g.die_no, g.name].filter(Boolean).join(' '), finish].filter(Boolean).join(' · ')
    const byKey = new Map((g.newOffcuts || []).map(o => [o.key, o]))
    const seq = [
      ...g.offcutBars.map(b => ({ bar: b, ref: b.offcut.code, label: b.offcut.code })),
      ...g.bars.map((b, i) => ({ bar: b, ref: String(i + 1), label: `เส้น ${i + 1}` })),
    ]
    for (const { bar, ref, label } of seq) {
      for (const p of bar.pieces) {
        k++
        const openingId = p.item_id ?? (items || {})[p.opening_no] ?? null
        out.push({
          kind: 'piece', groupKey: g.key, title: `${p.opening_no} · ${roleTh(p.role_name)}`, length_mm: mmOf(p.length_m), sub,
          ends: [p.end_a || 'square', p.end_b || 'square'], notchText: notchText(p.notch), footL: projectName || '', footR: `${label} · ${k}/${total}`,
          qr: openingId ? `#tab=estimation&project=${projectId}&item=${openingId}` : `#tab=estimation&project=${projectId}`,
        })
      }
      const o = byKey.get(`${g.key}#${ref}`)
      if (!o || (codes && !isOffcutKept(o, { codes }))) continue
      const code = codes ? codes[o.key] : null
      out.push({
        kind: 'offcut', groupKey: g.key, title: 'เศษ → เข้าสต็อก', code: code || NEW_OFFCUT_CODE, length_mm: mmOf(o.length_m), sub: offSub,
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
