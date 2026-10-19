// "จบไซท์งาน" — the one dialog for finishing a site. Records the handover date and the
// warranty, and (when the site still holds stock) returns leftover material to central stock.
// Stock: per spec decision #6, the job keeps 100% of its original cost -- leftover material
// re-enters stock at unit_cost = 0 (already fully expensed). Modeled as a transfer_out at this
// site paired with a transfer_in at the tenant's "ส่วนกลาง" site, both via record_stock_movement().
import { useState, useEffect, useRef } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import { fetchAllRows } from '../lib/fetchAllRows.js'
import { warrantyEnd } from '../lib/warranty.js'
import { Modal } from './Modal.jsx'

const bkkToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' })
const dmy = iso => (iso ? iso.split('-').reverse().join('/') : '—')

export default function FinishSiteModal({ site, onClose, onDone }) {
  const [loading, setLoading] = useState(true)
  const [rows, setRows] = useState([])
  const [handover, setHandover] = useState(bkkToday())
  const [months, setMonths] = useState('12')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const stockErrRef = useRef('')

  // Returns true on success. Open-time callers fail closed; the save-retry path stays soft.
  const loadRows = async () => {
    let data
    try {
      data = await fetchAllRows(() => supabase
        .from('inventory_stock_balances')
        .select('inventory_item_id, quantity_on_hand, inventory_items(name, base_unit)')
        .eq('site_id', site.id)
        .gt('quantity_on_hand', 0)
        .order('inventory_item_id'))
    } catch (err) { stockErrRef.current = err.message; setError(err.message); return false }
    setRows((data || []).map(r => ({
      inventory_item_id: r.inventory_item_id,
      name: r.inventory_items?.name,
      base_unit: r.inventory_items?.base_unit,
      quantity_on_hand: r.quantity_on_hand,
      leftover: String(r.quantity_on_hand),
    })))
    return true
  }

  useEffect(() => {
    let cancelled = false
    ;(async () => {
      const { data, error: siteErr } = await supabase.from('sites').select('warranty_months').eq('id', site.id).single()
      if (cancelled) return
      if (siteErr) {
        alert('โหลดข้อมูลไซท์ไม่สำเร็จ: ' + siteErr.message)
        onClose()
        return
      }
      setMonths(String(data?.warranty_months ?? 12))
      const ok = await loadRows()
      if (cancelled) return
      if (!ok) {
        alert('โหลดข้อมูลสต็อกไม่สำเร็จ: ' + stockErrRef.current)
        onClose()
        return
      }
      setLoading(false)
    })()
    return () => { cancelled = true }
  }, [site.id])

  const setLeftover = (id, v) => setRows(rs => rs.map(r => r.inventory_item_id === id ? { ...r, leftover: v } : r))

  const m = Number(months)
  const monthsOk = months !== '' && Number.isInteger(m) && m >= 0 && m <= 120
  const endDate = monthsOk ? warrantyEnd(handover, m) : null

  const handleConfirm = async () => {
    if (!handover) { alert('กรุณาระบุวันส่งมอบงาน'); return }
    if (!monthsOk) { alert('ระยะประกันต้องเป็นจำนวนเดือน 0–120'); return }
    setSaving(true)
    setError(null)
    try {
      const toTransfer = rows.filter(r => (parseFloat(r.leftover) || 0) > 0)
      if (toTransfer.length) {
        const { data: central, error: centralErr } = await supabase
          .from('sites').select('id').eq('name', 'ส่วนกลาง').limit(1)
        if (centralErr) throw centralErr
        const centralId = central?.[0]?.id
        if (!centralId) {
          throw new Error('ไม่พบไซท์งานชื่อ "ส่วนกลาง" — กรุณาสร้างไซท์งานชื่อนี้ก่อน เพื่อใช้เป็นที่รับวัสดุที่เหลือกลับเข้าสต็อกกลาง')
        }
        for (const r of toTransfer) {
          const qty = parseFloat(r.leftover) || 0
          const { error: outErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: r.inventory_item_id, p_site_id: site.id, p_movement_type: 'transfer_out',
            p_quantity: qty, p_unit_cost: null, p_reference_type: 'site_completion', p_reference_id: site.id, p_notes: null,
          })
          if (outErr) throw outErr
          const { error: inErr } = await supabase.rpc('record_stock_movement', {
            p_inventory_item_id: r.inventory_item_id, p_site_id: centralId, p_movement_type: 'transfer_in',
            p_quantity: qty, p_unit_cost: 0, p_reference_type: 'site_completion', p_reference_id: site.id, p_notes: null,
          })
          if (inErr) throw inErr
        }
      }
      const { error: siteErr } = await supabase.from('sites')
        .update({ status: 'Completed', end_date: handover, handover_date: handover, warranty_months: m })
        .eq('id', site.id)
      if (siteErr) throw siteErr
      onDone()
    } catch (e) {
      // Refresh rows from the live DB before surfacing the error: any item whose transfer
      // already succeeded this attempt now has less/zero balance, so a retry only
      // reprocesses what is still on hand.
      await loadRows()
      setError(e.message)
      alert('Error: ' + e.message)
    } finally { setSaving(false) }
  }

  return (
    <Modal title={`จบไซท์งาน — ${site.name}`} onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <p style={{ color: 'var(--text2)', fontSize: 13 }}>สถานะจะเปลี่ยนเป็น Completed และถือเป็นวันส่งมอบงาน ประกันเริ่มนับจากวันนี้</p>
        {loading ? <div>⏳ กำลังโหลด...</div> : (
          <>
            {rows.length > 0 && (
              <>
                <p style={{ color: 'var(--text2)', fontSize: 13 }}>
                  ไซท์นี้มีวัสดุคงคลังค้างอยู่ — กรอกจำนวนที่เหลือจริงต่อรายการ (ถ้าใช้หมดแล้วให้ใส่ 0) เพื่อโอนเข้าสต็อกกลาง (ส่วนกลาง) ที่ต้นทุน 0 บาท (งานนี้รับรู้ต้นทุนเต็มจำนวนไปแล้ว)
                </p>
                <div style={{ display: 'grid', gap: 8 }}>
                  {rows.map(r => (
                    <div key={r.inventory_item_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8 }}>
                      <span style={{ fontSize: 13 }}>{r.name} (มี {fmt(r.quantity_on_hand)} {r.base_unit})</span>
                      <input className="input input-sm num-spin" style={{ width: 100 }} type="number" min="0" step="any" max={r.quantity_on_hand}
                        value={r.leftover} onChange={e => setLeftover(r.inventory_item_id, e.target.value)} />
                    </div>
                  ))}
                </div>
              </>
            )}
            <div className="form-group">
              <label className="label">วันส่งมอบงาน</label>
              <input type="date" className="input" value={handover} onChange={e => setHandover(e.target.value)} />
            </div>
            <div className="form-group">
              <label className="label">ระยะประกัน (เดือน)</label>
              <input type="number" className="input num-spin" min="0" max="120" step="1" value={months} onChange={e => setMonths(e.target.value)} />
            </div>
            <div style={{ fontSize: 13, color: 'var(--text2)' }}>
              {!monthsOk ? 'ระยะประกันต้องอยู่ระหว่าง 0–120 เดือน'
                : m === 0 ? 'ไม่มีประกัน'
                : <>ประกันถึง <b>{dmy(endDate)}</b></>}
            </div>
            <div style={{ fontSize: 12, color: 'var(--text3)' }}>แก้วันส่งมอบหรือระยะประกันทีหลังได้ในหน้าแก้ไขไซท์</div>
            {error && <div className="alert alert-error">{error}</div>}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" disabled={saving || loading} onClick={handleConfirm}>
          {saving ? '⏳...' : 'ยืนยันจบงานและส่งมอบ'}
        </button>
      </div>
    </Modal>
  )
}
