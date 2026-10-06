// ============================================================
// DbdLookup — ช่วยกรอกชื่อ/ที่อยู่/เลขผู้เสียภาษี จากหน้า DBD (กึ่งอัตโนมัติ)
// 1) คัดลอกชื่อ + เปิด DBD  2) วางข้อความผลลัพธ์  3) ตรวจ/แก้ในพรีวิว แล้วกด "ใช้ข้อมูลนี้"
// ============================================================
import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { safeSourceUrl, computeAutofill } from '../lib/companyLookupUi.js'
import { parseDbdText, isValidThaiId13, normalizeDigits } from '../lib/dbdCompanyParse.js'

const DBD_URL = 'https://datawarehouse.dbd.go.th/juristic'

export default function DbdLookup({ name, address, taxId, onApply }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [pv, setPv] = useState(null) // { name, address, taxId, multiple }
  const [aiBusy, setAiBusy] = useState(false)
  const [aiCands, setAiCands] = useState(null) // null = not run, [] = none found
  const [aiError, setAiError] = useState('')
  const [fill, setFill] = useState(null) // { cand, prev, skipped, nameSuggestion } after an auto-fill
  // latest form values, read inside async handlers (props captured at click time go stale)
  const curRef = useRef({})
  curRef.current = { name, address, taxId }

  const AI_FAIL = 'ค้นหาอัตโนมัติไม่สำเร็จ — ใช้ปุ่ม "ค้นหาใน DBD" แล้ววางข้อความแทนได้'
  const searchAi = async () => {
    const q = (name || '').trim()
    if (q.length < 2) { setAiError('พิมพ์ชื่อบริษัทก่อน (อย่างน้อย 2 ตัวอักษร)'); return }
    setAiBusy(true); setAiError(''); setAiCands(null); setFill(null)
    try {
      const { data, error } = await supabase.functions.invoke('lookup-company', { body: { name: q } })
      if (error) {
        let msg = AI_FAIL
        try { const b = await error.context?.json(); if (b?.error) msg = b.error } catch { /* generic */ }
        setAiError(msg)
      } else if (data?.code === 'incomplete') {
        setAiError(data.error || AI_FAIL)
      } else {
        const cands = Array.isArray(data?.candidates) ? data.candidates : []
        if (cands.length === 1) autofill(cands[0])
        else setAiCands(cands)
      }
    } catch {
      setAiError(AI_FAIL)
    } finally {
      setAiBusy(false)
    }
  }
  // One-click fill: empty fields are filled at once, nothing is saved (the form's own
  // บันทึก does that). `prev` remembers old values so "ยกเลิก" can restore them.
  const autofill = c => {
    const { patch, skipped, nameSuggestion } = computeAutofill(c, curRef.current)
    const prev = {}
    for (const k of Object.keys(patch)) prev[k] = curRef.current[k] ?? ''
    if (Object.keys(patch).length) onApply(patch)
    setRaw(''); setPv(null); setAiCands(null)
    setFill({ cand: c, prev, skipped, nameSuggestion })
  }
  const takeAiValue = (key, value) => {
    onApply({ [key]: value })
    setFill(f => ({
      ...f,
      prev: key in f.prev ? f.prev : { ...f.prev, [key]: curRef.current[key] ?? '' },
      skipped: f.skipped.filter(s => s.key !== key),
      nameSuggestion: key === 'name' ? null : f.nameSuggestion,
    }))
  }
  const undoFill = () => {
    if (fill && Object.keys(fill.prev).length) onApply(fill.prev)
    setFill(null)
  }

  const openDbd = async () => {
    window.open(DBD_URL, '_blank', 'noopener,noreferrer')
    setOpen(true)
    try {
      if (name && navigator.clipboard) await navigator.clipboard.writeText(name)
    } catch { /* silent */ }
  }

  const onPaste = text => {
    setRaw(text)
    if (!text.trim()) { setPv(null); return }
    const r = parseDbdText(text)
    setPv({ name: r.name || '', address: r.address || '', taxId: r.taxId || '', multiple: r.multiple })
  }

  const setField = (k, v) => setPv(p => ({ ...p, [k]: v }))
  const idOk = pv?.taxId ? isValidThaiId13(pv.taxId) : null
  const idLenOk = pv?.taxId ? normalizeDigits(pv.taxId).replace(/\D/g, '').length === 13 : true

  const apply = () => {
    onApply({
      ...(pv.name.trim() ? { name: pv.name.trim() } : {}),
      ...(pv.address.trim() ? { address: pv.address.trim() } : {}),
      ...(pv.taxId.trim() ? { taxId: normalizeDigits(pv.taxId).replace(/\D/g, '') } : {}),
    })
    setPv(null); setRaw(''); setOpen(false); setAiCands(null)
  }

  const row = (label, key, current, extra) => {
    const val = pv[key]
    const replacing = current && val.trim() && current.trim() !== val.trim()
    return (
      <div key={key}>
        <label className="label">{label}</label>
        <input className="input" value={val} onChange={e => setField(key, e.target.value)} placeholder="ไม่พบในข้อความ — เว้นว่างไว้ = ไม่เปลี่ยน" />
        {extra}
        {replacing && (
          <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
            จะแทนที่ค่าเดิม: <span style={{ textDecoration: 'line-through' }}>{current}</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={searchAi} disabled={aiBusy}>
          {aiBusy ? 'กำลังค้นหา… (ประมาณ 10-30 วินาที)' : 'ค้นหาอัตโนมัติ (AI)'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={openDbd}>ค้นหาใน DBD</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'} วางข้อความจาก DBD
        </button>
      </div>
      {aiError && <div style={{ fontSize: 12, color: '#dc2626', marginTop: 6 }}>{aiError}</div>}
      {fill && (() => {
        const c = fill.cand
        const filled = [
          'taxId' in fill.prev && 'เลขผู้เสียภาษี',
          'address' in fill.prev && 'ที่อยู่',
        ].filter(Boolean)
        const link = { background: 'none', border: 'none', padding: 0, color: 'var(--primary, #2563eb)', cursor: 'pointer', fontSize: 12, textDecoration: 'underline' }
        const label = { taxId: 'เลขผู้เสียภาษี', address: 'ที่อยู่' }
        return (
          <div style={{ marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8, display: 'grid', gap: 4, fontSize: 12 }}>
            <div style={{ fontWeight: 600 }}>
              {filled.length ? `กรอกให้แล้ว: ${filled.join(', ')} (ยังไม่ได้บันทึก — ตรวจแล้วกดบันทึกของฟอร์ม)` : 'ไม่มีช่องว่างให้กรอก'}
            </div>
            <div>
              ชื่อที่จดทะเบียน: {c.name}{' '}
              {fill.nameSuggestion && <button type="button" style={link} onClick={() => takeAiValue('name', fill.nameSuggestion)}>ใช้ชื่อนี้</button>}
            </div>
            <div>
              {c.taxId}{' '}
              {isValidThaiId13(c.taxId)
                ? <span style={{ color: '#16a34a' }}>✓ เลขถูกต้องตามสูตร</span>
                : <span style={{ color: '#dc2626' }}>เลขไม่ถูกต้องตามสูตร</span>}
            </div>
            {c.address && <div style={{ color: '#b45309' }}>ที่อยู่จาก AI — ตรวจก่อนใช้</div>}
            <div style={{ color: c.verification === 'multi_source' ? '#16a34a' : '#b45309' }}>
              {c.verification === 'multi_source' ? 'ยืนยันจากหลายแหล่ง' : 'แหล่งเดียว — ตรวจก่อนบันทึก'}
            </div>
            <div style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              {(c.sources || []).map((src, k) => {
                const href = safeSourceUrl(src.url)
                return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{src.title || href}</a> : null
              })}
            </div>
            {fill.skipped.map(s => (
              <div key={s.key} style={{ color: '#b45309' }}>
                {label[s.key]}มีค่าอยู่แล้ว ({s.current}) จึงไม่ทับ — AI พบ: {s.ai}{' '}
                <button type="button" style={link} onClick={() => takeAiValue(s.key, s.ai)}>ใช้ค่าจาก AI แทน</button>
              </div>
            ))}
            <div>
              <button type="button" className="btn btn-ghost btn-sm" onClick={undoFill}>ยกเลิก (คืนค่าเดิม)</button>
            </div>
          </div>
        )
      })()}
      {aiCands && aiCands.length === 0 && (
        <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
          ไม่พบบริษัทจากแหล่งที่เชื่อถือได้ — ลอง "ค้นหาใน DBD" แล้ววางข้อความแทน
        </div>
      )}
      {aiCands && aiCands.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>พบหลายบริษัท — กดเลือกบริษัทที่ถูกต้อง ระบบจะกรอกลงช่องให้ทันที</div>
          {aiCands.map((c, i) => (
            <div key={c.taxId + i} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 8, display: 'grid', gap: 4 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              {c.address && <div style={{ fontSize: 12 }}>{c.address} <span style={{ color: '#b45309' }}>(ที่อยู่จาก AI — ตรวจก่อนใช้)</span></div>}
              <div style={{ fontSize: 12 }}>
                {c.taxId}{' '}
                {isValidThaiId13(c.taxId)
                  ? <span style={{ color: '#16a34a' }}>✓ เลขถูกต้องตามสูตร</span>
                  : <span style={{ color: '#dc2626' }}>เลขไม่ถูกต้องตามสูตร</span>}
              </div>
              <div style={{ fontSize: 12, color: c.verification === 'multi_source' ? '#16a34a' : '#b45309' }}>
                {c.verification === 'multi_source' ? 'ยืนยันจากหลายแหล่ง' : 'แหล่งเดียว — ตรวจกับ DBD ก่อนใช้'}
              </div>
              <div style={{ fontSize: 11, display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                {(c.sources || []).map((src, k) => {
                  const href = safeSourceUrl(src.url)
                  return href ? <a key={k} href={href} target="_blank" rel="noopener noreferrer">{src.title || href}</a> : null
                })}
              </div>
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => autofill(c)}>เลือกและกรอกให้</button></div>
            </div>
          ))}
        </div>
      )}
      {(open || pv) && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8, padding: 10, border: '1px solid var(--border)', borderRadius: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>
            วางชื่อในช่องค้นหาของ DBD เลือกบริษัท แล้วคัดลอกข้อความหน้าผลลัพธ์กลับมาวางที่นี่
          </div>
          <textarea className="input" rows={4} value={raw} onChange={e => onPaste(e.target.value)} placeholder="วางข้อความจาก DBD" />
          {pv && (
            <>
              {pv.multiple && (
                <div style={{ fontSize: 12, color: '#b45309' }}>พบหลายบริษัทในข้อความ — แสดงรายการแรก กรุณาตรวจสอบ</div>
              )}
              {!pv.name && !pv.address && !pv.taxId && (
                <div style={{ fontSize: 12, color: '#b45309' }}>อ่านข้อมูลไม่ได้ — กรอกในช่องด้านล่างเองได้</div>
              )}
              {row('ชื่อบริษัท', 'name', name)}
              {row('ที่อยู่', 'address', address)}
              {row('เลขประจำตัวผู้เสียภาษี', 'taxId', taxId,
                pv.taxId && (idOk && idLenOk
                  ? <div style={{ fontSize: 12, color: '#16a34a' }}>✓ เลขถูกต้องตามสูตร</div>
                  : <div style={{ fontSize: 12, color: '#dc2626' }}>เลขไม่ถูกต้องตามสูตร</div>))}
              <div>
                <button type="button" className="btn btn-primary btn-sm" onClick={apply}>ใช้ข้อมูลนี้</button>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  )
}
