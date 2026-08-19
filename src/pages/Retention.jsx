// ============================================================
// Retention — สรุปสถานะเงินประกันผลงาน (client retention) ต่อไซท์งาน
// ✅ วันครบกำหนด = sites.end_date + default_retention_period_days
// ✅ บันทึกว่าคืนแล้ว (ทั้งก้อนต่อไซท์ ไม่แยกตามใบแจ้งหนี้)
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSiteRetentionSummary } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'
import { retentionStatusFor } from '../lib/retentionStatus.js'

function ReleaseDialog({ row, onClose, onSaved }) {
  const [releaseDate, setReleaseDate] = useState(new Date().toISOString().slice(0, 10))
  const [saving, setSaving] = useState(false)

  const save = async () => {
    setSaving(true)
    const { error } = await supabase
      .from('sites')
      .update({ retention_released: true, retention_released_date: releaseDate })
      .eq('id', row.site_id)
    setSaving(false)
    if (error) { alert('Error: ' + error.message); return }
    onSaved()
  }

  return (
    <Modal title={`บันทึกว่าคืนแล้ว — ${row.name}`} onClose={onClose} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>ยอด Retention: <strong>{fmt(row.total_retention)} บาท</strong></div>
        <div>
          <label className="label">วันที่ได้รับคืน ★</label>
          <input type="date" className="input" required value={releaseDate} onChange={e => setReleaseDate(e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={save} disabled={saving}>{saving ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </Modal>
  )
}

export default function Retention({ openSiteOverview }) {
  const { data: rows, refetch } = useSiteRetentionSummary()
  const [releaseRow, setReleaseRow] = useState(null)

  const visible = (rows || []).filter(r => r.total_retention > 0)

  return (
    <div>
      <div style={{ marginBottom: 14 }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, marginBottom: 4 }}>🔒 Retention</h2>
        <p style={{ fontSize: 13, color: 'var(--text3)' }}>
          สรุปเงินประกันผลงานที่ถูกหักไว้ต่อไซท์งาน และวันครบกำหนดคืน (คำนวณจากวันจบงาน + ระยะเวลา retention ที่ตั้งไว้ในหน้าไซท์งาน)
        </p>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ไซท์งาน</th>
                <th>วันจบงาน</th>
                <th>ยอด Retention</th>
                <th>วันครบกำหนด</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {visible.map(row => {
                const status = retentionStatusFor(row)
                return (
                  <tr key={row.site_id}>
                    <td style={{ fontWeight: 600, fontSize: 13, cursor: 'pointer' }} onClick={() => openSiteOverview(row.site_id)}>{row.name}</td>
                    <td style={{ fontSize: 12 }}>{row.end_date ? fmtDate(row.end_date) : 'รอจบงาน'}</td>
                    <td className="font-mono" style={{ fontWeight: 700 }}>{fmt(row.total_retention)}</td>
                    <td style={{ fontSize: 12 }}>{!row.end_date ? 'รอจบงาน' : (row.due_date ? fmtDate(row.due_date) : '—')}</td>
                    <td><span className={`badge ${status.cls}`}>{status.label}</span></td>
                    <td>
                      {row.retention_released ? (
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>คืนวันที่ {fmtDate(row.retention_released_date)}</span>
                      ) : (
                        <button className="btn btn-sm btn-primary" onClick={() => setReleaseRow(row)}>✅ บันทึกว่าคืนแล้ว</button>
                      )}
                    </td>
                  </tr>
                )
              })}
              {!visible.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ยังไม่มีไซท์งานที่มี Retention</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {releaseRow && (
        <ReleaseDialog row={releaseRow} onClose={() => setReleaseRow(null)} onSaved={() => { setReleaseRow(null); refetch() }} />
      )}
    </div>
  )
}
