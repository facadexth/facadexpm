// src/pages/estimation/StalePriceBanner.jsx
// "มีราคาใหม่ N รายการ" (mockup screen 4): lines whose price row would differ if the project's price date were today.
// The refresh button (edit rights only, never automatic) moves the project's price date to today after a confirm
// dialog that lists the changes and says every item is re-priced.
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { ConfirmDialog } from '../../components/Modal.jsx'
import { localDateString } from '../../lib/localDate.js'
import { changesView, refreshWarning, refreshPatch } from './staleView.js'

function ChangesTable({ rows }) {
  return (
    <table style={{ marginTop: 8, width: '100%', fontSize: 12 }}>
      <thead><tr><th>รายการ</th><th>ชิ้นส่วน</th><th>ราคาเดิม</th><th>ราคาใหม่</th></tr></thead>
      <tbody>{rows.map((r, i) => <tr key={i}><td>{r.item}</td><td>{r.part}</td><td>{r.before}</td><td>{r.after}</td></tr>)}</tbody>
    </table>
  )
}

export default function StalePriceBanner({ changes, itemsById, index, priceAsOf, projectId, canEdit, onRefreshed }) {
  const [open, setOpen] = useState(false)
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  if (!changes.length) return null
  const { itemCount, rows } = changesView(changes, itemsById, index)

  const refresh = async () => {
    if (busy) return
    setBusy(true); setError('')
    let updated = false
    try {
      const { error: e } = await supabase.from('estimation_projects').update(refreshPatch()).eq('id', projectId)
      if (e) throw e
      updated = true
    } catch (e) {
      setError('อัปเดตราคาไม่สำเร็จ: ' + ((e && e.message) || String(e)) + ' (ราคาของโปรเจกต์ยังไม่เปลี่ยน ลองใหม่อีกครั้ง)')
      setBusy(false)
      return
    }
    try {
      if (updated && onRefreshed) await onRefreshed()
      setConfirm(false)
    } catch {
      setError('อัปเดตแล้ว แต่โหลดข้อมูลใหม่ไม่สำเร็จ กรุณารีเฟรชหน้า')
    } finally { setBusy(false) }
  }

  return (
    <div style={{ padding: 12, background: 'var(--blue-bg, #e8f1ff)', border: '1px solid var(--blue, #4a90e2)', borderRadius: 8, fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <span>💡 <b>มีราคาใหม่ {itemCount} รายการ</b> (โปรเจกต์ล็อกราคา ณ {priceAsOf})</span>
        <span style={{ display: 'flex', gap: 6 }}>
          <button type="button" className="btn btn-sm btn-ghost" onClick={() => setOpen(o => !o)}>{open ? 'ซ่อน' : 'ดูรายการ'}</button>
          {canEdit && <button type="button" className="btn btn-sm btn-primary" onClick={() => { setError(''); setConfirm(true) }}>อัปเดตเป็นราคาปัจจุบัน</button>}
        </span>
      </div>
      {error && !confirm && <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>}
      {open && <ChangesTable rows={rows} />}
      {confirm && (
        <ConfirmDialog maxWidth={640} title="อัปเดตเป็นราคาปัจจุบัน" confirmDisabled={busy} onCancel={() => !busy && setConfirm(false)} onConfirm={refresh}
          message={(
            <div>
              <div style={{ fontWeight: 700 }}>{refreshWarning(priceAsOf, localDateString(new Date()))}</div>
              <div style={{ fontSize: 12, marginTop: 6 }}>รายการที่ราคาเปลี่ยน ({itemCount} รายการ):</div>
              <div style={{ maxHeight: 240, overflow: 'auto' }}><ChangesTable rows={rows} /></div>
              {error && <div className="alert alert-error" style={{ marginTop: 8 }}>{error}</div>}
            </div>
          )} />
      )}
    </div>
  )
}
