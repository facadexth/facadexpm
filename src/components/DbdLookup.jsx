// ============================================================
// DbdLookup — ช่วยกรอกที่อยู่/เลขผู้เสียภาษี ของบริษัท
// - "ค้นหาอัตโนมัติ (AI)": เรียก edge function lookup-company แล้วกรอกช่องว่างให้ทันที
//   (ไม่บันทึกอะไรเอง) พร้อมแถบสรุป + ยกเลิก (คืนค่าเดิม)
// - "ค้นหาใน DBD": เปิดเว็บ DBD แท็บใหม่ และคัดลอกชื่อที่พิมพ์ไว้ให้
// ============================================================
import { useRef, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { safeSourceUrl, computeAutofill } from '../lib/companyLookupUi.js'
import { isValidThaiId13 } from '../lib/dbdCompanyParse.js'

const DBD_URL = 'https://datawarehouse.dbd.go.th/juristic'

export default function DbdLookup({ name, address, taxId, onApply }) {
  const [aiBusy, setAiBusy] = useState(false)
  const [aiCands, setAiCands] = useState(null) // null = not run, [] = none found
  const [aiError, setAiError] = useState('')
  const [fill, setFill] = useState(null) // { cand, prev, skipped, nameSuggestion } after an auto-fill
  const [dbdHint, setDbdHint] = useState(false)
  // latest form values, read inside async handlers (props captured at click time go stale)
  const curRef = useRef({})
  curRef.current = { name, address, taxId }

  const AI_FAIL = 'ค้นหาอัตโนมัติไม่สำเร็จ — ใช้ปุ่ม "ค้นหาใน DBD" เปิดเว็บ DBD แล้วกรอกเองได้'
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
    setAiCands(null)
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

  // Plain helper: open DBD in a new tab, then copy the typed name (silent if refused).
  const openDbd = async () => {
    window.open(DBD_URL, '_blank', 'noopener,noreferrer')
    setDbdHint(true)
    try {
      if (name && navigator.clipboard) await navigator.clipboard.writeText(name)
    } catch { /* silent */ }
  }

  return (
    <div style={{ marginTop: 6 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-ghost btn-sm" onClick={searchAi} disabled={aiBusy}>
          {aiBusy ? 'กำลังค้นหา… (ประมาณ 10-30 วินาที)' : 'ค้นหาอัตโนมัติ (AI)'}
        </button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={openDbd}>ค้นหาใน DBD</button>
      </div>
      {dbdHint && (
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>
          เปิดเว็บ DBD ในแท็บใหม่แล้ว และคัดลอกชื่อที่พิมพ์ไว้ให้ — กดวาง (Ctrl+V) ในช่องค้นหาของ DBD ได้เลย
        </div>
      )}
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
          ไม่พบบริษัทจากแหล่งที่เชื่อถือได้ — ลองใช้ปุ่ม "ค้นหาใน DBD" เปิดเว็บ DBD แล้วกรอกเอง
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
    </div>
  )
}
