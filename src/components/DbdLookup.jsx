// ============================================================
// DbdLookup — ช่วยกรอกชื่อ/ที่อยู่/เลขผู้เสียภาษี จากหน้า DBD (กึ่งอัตโนมัติ)
// 1) คัดลอกชื่อ + เปิด DBD  2) วางข้อความผลลัพธ์  3) ตรวจ/แก้ในพรีวิว แล้วกด "ใช้ข้อมูลนี้"
// ============================================================
import { useState } from 'react'
import { parseDbdText, isValidThaiId13 } from '../lib/dbdCompanyParse.js'

const DBD_URL = 'https://datawarehouse.dbd.go.th/juristic'

export default function DbdLookup({ name, address, taxId, onApply }) {
  const [open, setOpen] = useState(false)
  const [raw, setRaw] = useState('')
  const [pv, setPv] = useState(null) // { name, address, taxId, multiple }

  const openDbd = async () => {
    try {
      if (name && navigator.clipboard) await navigator.clipboard.writeText(name)
    } catch { /* silent */ }
    window.open(DBD_URL, '_blank', 'noopener,noreferrer')
    setOpen(true)
  }

  const onPaste = text => {
    setRaw(text)
    if (!text.trim()) { setPv(null); return }
    const r = parseDbdText(text)
    setPv({ name: r.name || '', address: r.address || '', taxId: r.taxId || '', multiple: r.multiple })
  }

  const setField = (k, v) => setPv(p => ({ ...p, [k]: v }))
  const idOk = pv?.taxId ? isValidThaiId13(pv.taxId) : null

  const apply = () => {
    onApply({
      ...(pv.name.trim() ? { name: pv.name.trim() } : {}),
      ...(pv.address.trim() ? { address: pv.address.trim() } : {}),
      ...(pv.taxId.trim() ? { taxId: pv.taxId.replace(/\D/g, '') } : {}),
    })
    setPv(null); setRaw(''); setOpen(false)
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
        <button type="button" className="btn btn-ghost btn-sm" onClick={openDbd}>ค้นหาใน DBD</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => setOpen(o => !o)}>
          {open ? '▾' : '▸'} วางข้อความจาก DBD
        </button>
      </div>
      {open && (
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
                pv.taxId && (idOk
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
