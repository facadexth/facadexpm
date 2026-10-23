// Site plans (reused every งวด) + markup: rect (drag) and pin (click), each tied to a report card.
import { useEffect, useRef, useState } from 'react'
import PlanMarkup from './PlanMarkup.jsx'
import { uploadSiteDrawing, saveSiteDrawingMarks } from '../../../hooks/useDeliveryReport.js'
import { supabase } from '../../../lib/supabase.js'

const clamp01 = v => Math.min(1, Math.max(0, Number.isFinite(v) ? v : 0))
const r4 = v => Math.round(v * 10000) / 10000

// Normalise a mark so the DB CHECKs (0≤x,y,w,h≤1, x+w≤1, y+h≤1) always hold.
export function clampMark(m) {
  const x = clamp01(r4(m.x)), y = clamp01(r4(m.y))
  if (m.kind !== 'rect') return { ...m, x, y, w: null, h: null }
  const w = Math.min(clamp01(r4(m.w)), r4(1 - x)), h = Math.min(clamp01(r4(m.h)), r4(1 - y))
  return { ...m, x, y, w: Math.max(0, w), h: Math.max(0, h) }
}

export function pointToFraction(e, el) {
  const r = el.getBoundingClientRect()
  if (!r.width || !r.height) return { x: 0, y: 0 }
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
}

export default function PlanMarkupEditor({ siteId, tenantId, plans = [], marksByPlan = {}, cards = [], colourFor, onChanged }) {
  const [activeId, setActiveId] = useState(plans[0]?.id || null)
  const [marks, setMarks] = useState([])
  const [tool, setTool] = useState('rect')
  const [drag, setDrag] = useState(null)
  const [pending, setPending] = useState(null) // index of a new mark waiting for its card
  const [urls, setUrls] = useState({})
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [dirty, setDirty] = useState(false)
  const imgRef = useRef(null)
  const fileRef = useRef(null)
  const plan = plans.find(p => p.id === activeId) || null
  const cardOrder = cards.map(c => c.taskId)

  useEffect(() => { if (!activeId && plans[0]) setActiveId(plans[0].id) }, [plans, activeId])
  useEffect(() => { setMarks(marksByPlan[activeId] || []); setDirty(false); setPending(null) }, [activeId, marksByPlan])
  useEffect(() => {
    const need = plans.filter(p => !p.url && !urls[p.id] && p.file_path)
    if (!need.length) return
    let off = false
    Promise.all(need.map(async p => {
      const { data } = await supabase.storage.from('site-drawings').createSignedUrl(p.file_path, 3600)
      return [p.id, data?.signedUrl]
    })).then(pairs => { if (!off) setUrls(u => ({ ...u, ...Object.fromEntries(pairs) })) }).catch(() => {})
    return () => { off = true }
  }, [plans, urls])

  const addMark = m => {
    setPending(marks.length)
    setMarks([...marks, clampMark({ task_id: null, ...m })])
    setDirty(true)
  }
  const down = e => {
    if (!imgRef.current || pending != null) return
    const p = pointToFraction(e, imgRef.current)
    if (tool === 'pin') { addMark({ kind: 'pin', x: p.x, y: p.y }); return }
    e.currentTarget.setPointerCapture?.(e.pointerId)
    setDrag({ x0: p.x, y0: p.y, x1: p.x, y1: p.y })
  }
  const move = e => {
    if (!drag || !imgRef.current) return
    const p = pointToFraction(e, imgRef.current)
    setDrag(d => ({ ...d, x1: p.x, y1: p.y }))
  }
  const up = e => {
    if (!drag || !imgRef.current) return
    const p = pointToFraction(e, imgRef.current)
    const x = Math.min(drag.x0, p.x), y = Math.min(drag.y0, p.y)
    const w = Math.abs(p.x - drag.x0), h = Math.abs(p.y - drag.y0)
    setDrag(null)
    if (w < 0.01 || h < 0.01) return
    addMark({ kind: 'rect', x, y, w, h })
  }
  const setCard = (i, taskId) => { setMarks(ms => ms.map((m, j) => (j === i ? { ...m, task_id: taskId || null } : m))); setDirty(true) }
  const removeMark = i => { setMarks(ms => ms.filter((_, j) => j !== i)); setPending(null); setDirty(true) }

  const onFile = async e => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setErr(''); setBusy(true)
    try {
      const row = await uploadSiteDrawing({ siteId, tenantId, file })
      if (row?.id) setActiveId(row.id)
      onChanged?.()
    } catch (x) { setErr(x?.message || 'อัปโหลดไม่สำเร็จ') } finally { setBusy(false) }
  }
  const save = async () => {
    if (!plan) return
    setErr(''); setBusy(true)
    try {
      await saveSiteDrawingMarks(plan.id, marks.map(clampMark))
      setDirty(false); setPending(null)
      onChanged?.()
    } catch (x) { setErr(x?.message || 'บันทึกไม่สำเร็จ') } finally { setBusy(false) }
  }

  const dragRect = drag && (
    <rect x={Math.min(drag.x0, drag.x1)} y={Math.min(drag.y0, drag.y1)} width={Math.abs(drag.x1 - drag.x0)} height={Math.abs(drag.y1 - drag.y0)}
      fill="#f97316" fillOpacity={0.2} stroke="#f97316" strokeDasharray="4 3" strokeWidth={2} vectorEffect="non-scaling-stroke" />
  )
  const btn = on => ({ padding: '6px 12px', borderRadius: 8, border: '1px solid #d1d5db', background: on ? '#111827' : '#fff', color: on ? '#fff' : '#111827', fontSize: 14 })
  const cardName = id => cards.find(c => c.taskId === id)?.title || ''

  return (
    <div style={{ maxWidth: '100%', overflow: 'hidden' }}>
      {err && <div role="alert" style={{ background: '#fef2f2', color: '#b91c1c', border: '1px solid #fecaca', borderRadius: 8, padding: '8px 12px', marginBottom: 8 }}>{err}</div>}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
        {plans.map(p => <button key={p.id} type="button" style={btn(p.id === activeId)} onClick={() => setActiveId(p.id)}>{p.title || 'แบบ'}</button>)}
        <button type="button" style={btn(false)} disabled={busy} onClick={() => fileRef.current?.click()}>＋ แบบแปลน</button>
        <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,application/pdf" hidden data-testid="plan-file" onChange={onFile} />
      </div>
      {!plan ? (
        <p style={{ color: '#6b7280', fontSize: 14 }}>ยังไม่มีแบบแปลนของหน้างานนี้ — กด ＋ แบบแปลน (รูปภาพ หรือ PDF หน้าเดียว)</p>
      ) : (
        <>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 8 }}>
            <button type="button" style={btn(tool === 'rect')} onClick={() => setTool('rect')}>สี่เหลี่ยม</button>
            <button type="button" style={btn(tool === 'pin')} onClick={() => setTool('pin')}>หมุด</button>
            <button type="button" style={{ ...btn(false), marginLeft: 'auto', background: dirty ? '#f97316' : '#fff', color: dirty ? '#fff' : '#111827' }} disabled={busy || !dirty} onClick={save}>บันทึก</button>
          </div>
          <PlanMarkup plan={plan} src={plan.url || urls[plan.id]} marks={marks} colourFor={colourFor} cardOrder={cardOrder}
            imgRef={imgRef} onPointerDown={down} onPointerMove={move} onPointerUp={up}>{dragRect}</PlanMarkup>
          <ul style={{ listStyle: 'none', padding: 0, margin: '8px 0 0', display: 'grid', gap: 6 }}>
            {marks.map((m, i) => (
              <li key={m.id || 'n' + i} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 14, outline: pending === i ? '2px solid #f97316' : 'none', borderRadius: 6, padding: 2 }}>
                <span style={{ width: 12, height: 12, borderRadius: 3, background: colourFor?.(m.task_id) || '#9ca3af', flex: 'none' }} />
                <span style={{ flex: 'none' }}>{m.kind === 'rect' ? 'สี่เหลี่ยม' : 'หมุด'}</span>
                <select aria-label={`การ์ดของเครื่องหมาย ${i + 1}`} value={m.task_id || ''} style={{ minWidth: 0, flex: 1 }}
                  onChange={e => { setCard(i, e.target.value); if (pending === i) setPending(null) }}>
                  <option value="">— เลือกการ์ด —</option>
                  {cards.map(c => <option key={c.taskId} value={c.taskId}>{c.title}</option>)}
                </select>
                <button type="button" aria-label={`ลบเครื่องหมาย ${i + 1}`} title={cardName(m.task_id)} style={btn(false)} onClick={() => removeMark(i)}>ลบ</button>
              </li>
            ))}
          </ul>
          {pending != null && <p style={{ fontSize: 13, color: '#f97316', margin: '4px 0 0' }}>เลือกการ์ดของเครื่องหมายใหม่</p>}
        </>
      )}
    </div>
  )
}
