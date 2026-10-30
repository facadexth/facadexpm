// src/pages/estimation/StickerSheet.jsx
// "สติกเกอร์แปะท่อน": one sticker per cut piece and per remainder, in cutting order, previewed at the chosen label
// size. Before issue the user ticks "ไม่เก็บ" on remainders not to keep (onFlip); after issue the stickers come from
// the frozen snapshot with the real offcut codes, and the PDF can be downloaded. QR and end glyphs are PNG images.
import { useEffect, useMemo, useRef, useState } from 'react'
import { PAPERS, stickerModel, stickerPages, endLabel, isOffcutKept, NO_DIE_TEXT, finishFontMm } from '../../lib/stickers.js'
import { qrDataUrl, endGlyphDataUrl, downloadStickersPdf } from '../../lib/stickerRender.js'
import InlineError from './InlineError.jsx'
import MissingDieNotice from './MissingDieNotice.jsx'

const ALL = '__all'
const PRINT_ID = 'sticker-print'
const PREVIEW_PX_PER_MM = 4
const muted = { fontSize: 12, color: 'var(--text3)' }
const groupLabel = g => [[g.die_no, g.name].filter(Boolean).join(' '), g.finish_name].filter(Boolean).join(' · ') || '?'
const origin = () => (typeof window !== 'undefined' ? window.location.origin : '')
const glyphKey = s => `${s.ends[0]}|${s.ends[1]}`

// u(n) turns millimetres into a CSS length: px on the preview, real mm in the print container.
function StickerFace({ s, paper, u, qrImg, glyphImg }) {
  const f = Math.min(paper.w / 50, paper.h / 30)
  const z = n => u(n * f)
  const off = s.kind === 'offcut'
  const line = { whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }
  const dieStyle = { background: s.die ? '#111111' : '#b3261e', color: '#ffffff', borderRadius: z(0.5), padding: `0 ${z(0.6)}`, marginRight: z(0.8) }
  return (
    <div style={{ width: '100%', height: '100%', boxSizing: 'border-box', padding: z(1.4), display: 'grid', gridTemplateColumns: '1fr auto', gridTemplateRows: 'auto auto auto auto 1fr', columnGap: z(1.2),
      background: off ? '#eaf6f1' : '#ffffff', color: '#111111', border: off ? `${z(0.5)} solid #1f6f5c` : 'none', fontFamily: 'inherit', lineHeight: 1.2, overflow: 'hidden' }}>
      <div style={{ ...line, fontWeight: 700, fontSize: z(2.5), color: off ? '#1f6f5c' : '#111111' }}><span className="font-mono" style={dieStyle}>{s.die || NO_DIE_TEXT}</span>{off ? <>{s.title} <span className="font-mono">{s.code}</span></> : s.title}</div>
      <div style={{ gridColumn: 2, gridRow: '1 / 4', width: z(11), height: z(11) }}>
        {qrImg ? <img src={qrImg} alt="" style={{ width: '100%', height: '100%', display: 'block' }} />
          : <div style={{ width: '100%', height: '100%', border: '1px dashed #999999', fontSize: z(1.8), display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#777777', textAlign: 'center' }}>QR</div>}
      </div>
      <div className="font-mono" style={{ ...line, fontSize: z(5), fontWeight: 600, lineHeight: 1.05 }}>{s.length_mm}<span style={{ fontSize: z(2) }}> มม.</span></div>
      {/* The finish name: its own line, wraps, smaller when long -- never cut with "…" (screen and PDF alike). */}
      <div data-role="finish" style={{ fontSize: z(finishFontMm(s.finish)), lineHeight: 1.15, fontWeight: 600, whiteSpace: 'normal', overflowWrap: 'anywhere', minWidth: 0 }}>{s.finish}</div>
      <div style={{ ...line, gridColumn: '1 / 3', display: 'flex', alignItems: 'center', gap: z(0.8), fontSize: z(2.1) }}>
        <b>{endLabel(s.ends[0])}</b>
        {glyphImg ? <img src={glyphImg} alt="" style={{ width: z(17.5), height: z(3.5), flex: '0 0 auto' }} /> : <span style={{ width: z(17.5), height: z(3.5), flex: '0 0 auto', border: '1px solid #111111' }} />}
        <b>{endLabel(s.ends[1])}</b>
        {s.notchText && <span style={line}>· {s.notchText}</span>}
      </div>
      <div className="font-mono" style={{ gridColumn: '1 / 3', alignSelf: 'end', display: 'flex', justifyContent: 'space-between', gap: z(1), fontSize: z(1.9), color: '#555555', borderTop: '1px solid #cccccc', paddingTop: z(0.3) }}>
        <span style={line}>{s.footL}</span><span style={{ whiteSpace: 'nowrap' }}>{s.footR}</span>
      </div>
    </div>
  )
}

// codes: issued plan only, { remainder key: offcut code } from issuedOffcutCodes; null while the offcuts load.
export default function StickerSheet({ plan, issued, codes, projectName, projectId, openingIds, flipped, onFlip, missingDie = null }) {
  const shown = issued ? issued.plan : plan
  const codesMissing = !!issued && !codes
  const groups = useMemo(() => (shown ? shown.groups : []), [shown])
  const [groupKey, setGroupKey] = useState(null)
  const [paperKey, setPaperKey] = useState('roll50x30')
  const [images, setImages] = useState({}) // qr text / glyph key -> data URL
  const [busy, setBusy] = useState(false)
  const [printing, setPrinting] = useState(false)
  const [error, setError] = useState(null)
  const imagesRef = useRef(images)
  imagesRef.current = images
  const paper = PAPERS[paperKey]

  const all = useMemo(() => stickerModel({ plan: shown, projectName, projectId, items: openingIds, codes: issued ? codes || {} : null, date: issued ? issued.issued_at : undefined }),
    [shown, projectName, projectId, openingIds, codes, issued])
  const selected = groupKey === ALL ? ALL : (groups.some(g => g.key === groupKey) ? groupKey : (groups[0] && groups[0].key))
  const visible = useMemo(() => (selected === ALL ? all : all.filter(s => s.groupKey === selected)), [all, selected])
  // After issue every listed offcut was stocked; a leftover flip from before the issue must not grey it out.
  const kept = s => s.kind !== 'offcut' || !!issued || isOffcutKept({ key: s.offKey, keep: s.keepDefault }, { flipped })
  const toPrint = visible.filter(kept)
  const pieceCount = visible.filter(s => s.kind === 'piece').length

  // Draw the missing QR codes and glyphs (browser only; the SSR preview shows placeholders).
  const ensureImages = async list => {
    const have = imagesRef.current
    const add = {}
    for (const s of list) {
      if (!have[glyphKey(s)] && !add[glyphKey(s)]) add[glyphKey(s)] = endGlyphDataUrl(s.ends[0], s.ends[1])
      if (s.qr && !have[s.qr] && !add[s.qr]) add[s.qr] = await qrDataUrl(origin() + '/' + s.qr)
    }
    if (Object.keys(add).length) setImages(prev => ({ ...prev, ...add }))
  }
  useEffect(() => { ensureImages(visible).catch(e => console.error('sticker images', e)) }, [visible]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!printing) return undefined
    const id = requestAnimationFrame(() => {
      downloadStickersPdf(PRINT_ID, paper, `สติกเกอร์-${projectName || 'โปรเจกต์'}.pdf`)
        .catch(e => setError(e.message || String(e)))
        .finally(() => { setPrinting(false); setBusy(false) })
    })
    return () => cancelAnimationFrame(id)
  }, [printing]) // eslint-disable-line react-hooks/exhaustive-deps

  const download = async () => {
    setBusy(true); setError(null)
    try { await ensureImages(toPrint); setPrinting(true) } catch (e) { setError(e.message || String(e)); setBusy(false) }
  }

  if (!shown) return null
  const px = n => `${n * PREVIEW_PX_PER_MM}px`
  const mmU = n => `${n}mm`
  const offCount = visible.length - pieceCount

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>สติกเกอร์แปะท่อน</div>
        <span style={muted}>เรียงตามลำดับตัด · แปะทันทีที่ตัดแต่ละท่อน · เศษก็แปะ</span>
      </div>
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <div><label className="label">หน้าตัด</label>
          <select className="input" value={selected || ''} onChange={e => setGroupKey(e.target.value)}>
            {groups.map(g => <option key={g.key} value={g.key}>{groupLabel(g)}</option>)}
            {groups.length > 1 && <option value={ALL}>ทุกหน้าตัด</option>}
          </select>
        </div>
        <div><label className="label">กระดาษ</label>
          <select className="input" value={paperKey} onChange={e => setPaperKey(e.target.value)}>
            {Object.entries(PAPERS).map(([k, p]) => <option key={k} value={k}>{p.label}</option>)}
          </select>
        </div>
        <div style={{ display: 'grid', gap: 4 }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={!issued || codesMissing || busy || toPrint.length === 0} onClick={download}>
            {busy ? 'กำลังสร้าง PDF...' : 'ดาวน์โหลด PDF สติกเกอร์'}
          </button>
        </div>
      </div>
      {error && <InlineError title="สร้าง PDF ไม่สำเร็จ" onClose={() => setError(null)}>{error}</InlineError>}
      <MissingDieNotice missing={missingDie} />
      {!issued && <div style={{ fontSize: 12, color: 'var(--yellow)' }}>ยืนยันใบตัดก่อน จึงจะได้รหัสเศษสำหรับสติกเกอร์</div>}
      {codesMissing && <div style={muted}>กำลังโหลดรหัสเศษ...</div>}
      <div style={muted}>
        {pieceCount} ท่อน + เศษ {offCount} ชิ้น
        {issued ? ' (เฉพาะเศษที่เก็บเข้าสต็อก)' : ' (ติ๊ก "ไม่เก็บ" ชิ้นที่ไม่เอามาใช้ — ไม่พิมพ์ และไม่เข้าสต็อก)'}
      </div>

      {visible.length === 0 ? <div style={muted}>ไม่มีสติกเกอร์</div> : (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
          {visible.map((s, i) => {
            const dropped = !kept(s)
            return (
              <div key={i} style={{ position: 'relative', width: px(paper.w), maxWidth: '100%', aspectRatio: `${paper.w} / ${paper.h}`, border: '1px dashed #888888', borderRadius: 4, overflow: 'hidden', opacity: dropped ? 0.35 : 1 }}>
                <StickerFace s={s} paper={paper} u={px} qrImg={s.qr ? images[s.qr] : null} glyphImg={images[glyphKey(s)]} />
                {s.kind === 'offcut' && (
                  <label style={{ position: 'absolute', right: 4, bottom: px(4), fontSize: 11, display: 'flex', gap: 3, alignItems: 'center', color: '#333333', background: 'rgba(255,255,255,0.8)', padding: '0 3px', borderRadius: 3 }}>
                    <input type="checkbox" style={{ width: 'auto', margin: 0 }} checked={dropped} disabled={!!issued} onChange={() => onFlip && onFlip(s.offKey)} />ไม่เก็บ
                  </label>
                )}
              </div>
            )
          })}
        </div>
      )}
      <div style={muted}>สติกเกอร์ท่อน: รูปแท่งเล็กบอกหัวซ้าย/ขวา ตัด 90° หรือ 45° และการบาก · สติกเกอร์เศษ: QR ใช้สแกนเบิกเศษในงานถัดไป</div>

      {printing && (
        <div style={{ position: 'fixed', left: -10000, top: 0 }} aria-hidden="true">
          <div id={PRINT_ID} style={{ width: paper.sheet ? '210mm' : mmU(paper.w), background: '#ffffff' }}>
            {stickerPages(toPrint, paper).map((page, pi) => (
              paper.sheet ? (
                <div key={pi} className="stk-page" style={{ width: '210mm', height: `${paper.rows * paper.h}mm`, display: 'grid', gridTemplateColumns: `repeat(${paper.cols}, ${paper.w}mm)`, gridAutoRows: `${paper.h}mm`, overflow: 'hidden' }}>
                  {page.map((s, i) => <div key={i} style={{ overflow: 'hidden' }}><StickerFace s={s} paper={paper} u={mmU} qrImg={s.qr ? images[s.qr] : null} glyphImg={images[glyphKey(s)]} /></div>)}
                </div>
              ) : (
                // A hair under the label height so the page break never lands exactly on a page edge (blank page).
                <div key={pi} className="stk-page" style={{ width: mmU(paper.w), height: `${paper.h - 0.3}mm`, overflow: 'hidden' }}>
                  <StickerFace s={page[0]} paper={paper} u={mmU} qrImg={page[0].qr ? images[page[0].qr] : null} glyphImg={images[glyphKey(page[0])]} />
                </div>
              )
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
