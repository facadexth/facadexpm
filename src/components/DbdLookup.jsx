// ============================================================
// DbdLookup — ช่วยกรอกชื่อ/ที่อยู่/เลขผู้เสียภาษี จากหน้า DBD (กึ่งอัตโนมัติ)
// 1) คัดลอกชื่อ + เปิด DBD  2) วางข้อความผลลัพธ์  3) ตรวจ/แก้ในพรีวิว แล้วกด "ใช้ข้อมูลนี้"
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { parseDbdText, isValidThaiId13, normalizeDigits } from '../lib/dbdCompanyParse.js'

const DBD_URL = 'https://datawarehouse.dbd.go.th/juristic'

export default function DbdLookup({ name, address, taxId, onApply }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [pv, setPv] = useState(null) // { name, address, taxId, multiple }
  const [aiBusy, setAiBusy] = useState(false)
  const [aiCands, setAiCands] = useState(null) // null = not run, [] = none found
  const [aiError, setAiError] = useState('')

  const AI_FAIL = 'ค้นหาอัตโนมัติไม่สำเร็จ — ใช้ปุ่ม "ค้นหาใน DBD" แล้ววางข้อความแทนได้'
  const searchAi = async () => {
    const q = (name || '').trim()
    if (q.length < 2) { setAiError('พิมพ์ชื่อบริษัทก่อน (อย่างน้อย 2 ตัวอักษร)'); return }
    setAiBusy(true); setAiError(''); setAiCands(null)
    try {
      const { data, error } = await supabase.functions.invoke('lookup-company', { body: { name: q } })
      if (error) {
        let msg = AI_FAIL
        try { const b = await error.context?.json(); if (b?.error) msg = b.error } catch { /* generic */ }
        setAiError(msg)
      } else {
        setAiCands(Array.isArray(data?.candidates) ? data.candidates : [])
      }
    } catch {
      setAiError(AI_FAIL)
    } finally {
      setAiBusy(false)
    }
  }
  const pickCandidate = c => {
    setPv({ name: c.name || '', address: c.address || '', taxId: c.taxId || '', multiple: false })
    setOpen(true)
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
      {aiCands && aiCands.length === 0 && (
        <div style={{ fontSize: 12, color: '#b45309', marginTop: 6 }}>
          ไม่พบบริษัทจากแหล่งที่เชื่อถือได้ — ลอง "ค้นหาใน DBD" แล้ววางข้อความแทน
        </div>
      )}
      {aiCands && aiCands.length > 0 && (
        <div style={{ display: 'grid', gap: 8, marginTop: 8 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>เลือกบริษัทที่ถูกต้อง แล้วตรวจในพรีวิวก่อนกด "ใช้ข้อมูลนี้"</div>
          {aiCands.map((c, i) => (
            <div key={c.taxId + i} style={{ padding: 10, border: '1px solid var(--border)', borderRadius: 8, display: 'grid', gap: 4 }}>
              <div style={{ fontWeight: 600 }}>{c.name}</div>
              {c.address && <div style={{ fontSize: 12 }}>{c.address}</div>}
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
                {(c.sources || []).map((src, k) => (
                  <a key={k} href={src.url} target="_blank" rel="noopener noreferrer">{src.title || src.url}</a>
                ))}
              </div>
              <div><button type="button" className="btn btn-ghost btn-sm" onClick={() => pickCandidate(c)}>เลือกรายการนี้</button></div>
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
