// Reminder card on the Sites page: warranty ends within 30 days -> contact the customer.
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { bangkokToday, buildFollowupRows, followupMessage } from '../lib/warrantyFollowup.js'
import { formatThaiDate } from '../lib/thaiDate.js'

const baht = n => '฿' + Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })

export default function WarrantyFollowupCard() {
  const [rows, setRows] = useState([])
  const [copied, setCopied] = useState(null)
  const [busy, setBusy] = useState(null)

  useEffect(() => {
    let alive = true
    ;(async () => {
      const { data: sites, error } = await supabase.from('sites')
        .select('id, name, site_number, status, client_id, handover_date, warranty_months, warranty_followup_at')
        .eq('status', 'Completed').not('handover_date', 'is', null)
      if (error || !sites?.length) return
      const today = bangkokToday()
      // cheap pre-filter so the lookups below only cover candidate sites
      const due = buildFollowupRows(sites, today).map(r => r.id)
      if (!due.length) return
      const dueSites = sites.filter(s => due.includes(s.id))
      const clientIds = [...new Set(dueSites.map(s => s.client_id).filter(Boolean))]
      const [cl, ln, rt] = await Promise.all([
        supabase.from('clients').select('id, name, phone').in('id', clientIds),
        supabase.from('customer_line_accounts').select('client_id').in('client_id', clientIds),
        supabase.from('site_retention_summary').select('site_id, total_retention, retention_released').in('site_id', due),
      ])
      if (!alive) return
      setRows(buildFollowupRows(dueSites, today, {
        clientsById: Object.fromEntries((cl.data || []).map(c => [c.id, c])),
        linkedClientIds: new Set((ln.data || []).map(a => a.client_id)),
        retentionBySite: Object.fromEntries((rt.data || []).map(r => [r.site_id, r])),
      }))
    })()
    return () => { alive = false }
  }, [])

  const copy = async r => {
    try {
      await navigator.clipboard.writeText(followupMessage(r.siteName, r.end))
      setCopied(r.id); setTimeout(() => setCopied(c => (c === r.id ? null : c)), 2000)
    } catch (e) { alert('คัดลอกไม่สำเร็จ: ' + e.message) }
  }

  const markDone = async r => {
    setBusy(r.id)
    // Write ONLY warranty_followup_at: a DB trigger clears it if handover/months change in the same update.
    const { error } = await supabase.from('sites').update({ warranty_followup_at: new Date().toISOString() }).eq('id', r.id)
    setBusy(null)
    if (error) { alert('Error: ' + error.message); return }
    setRows(list => list.filter(x => x.id !== r.id))
  }

  const total = useMemo(() => rows.length, [rows])
  if (!total) return null

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div style={{ fontWeight: 700, marginBottom: 4 }}>🛡️ ประกันใกล้หมด — ทักลูกค้า ({total})</div>
      <div style={{ fontSize: 13, color: 'var(--text-muted, #666)', marginBottom: 10 }}>ประกันจะหมดภายใน 30 วัน ทักลูกค้าถามว่ามีจุดไหนต้องตรวจหรือแก้ไหม</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {rows.map(r => (
          <div key={r.id} style={{ border: '1px solid var(--border, #ddd)', borderRadius: 8, padding: 10, display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', justifyContent: 'space-between' }}>
            <div style={{ minWidth: 0, flex: '1 1 240px' }}>
              <div style={{ fontWeight: 600 }}>{r.siteName} <span style={{ fontWeight: 400, fontSize: 12 }}>{r.siteNumber}</span></div>
              <div style={{ fontSize: 13 }}>{r.clientName} · {r.lineLinked ? 'เชื่อม LINE แล้ว' : (r.phone || 'ไม่มีเบอร์')}</div>
              <div style={{ fontSize: 13 }}>ส่งมอบ {formatThaiDate(r.handover)} · ประกันถึง {formatThaiDate(r.end)} <b>(เหลือ {r.daysLeft} วัน)</b></div>
              {r.retentionDue > 0 && <div style={{ fontSize: 13 }}>เรียกคืนเงินประกันผลงาน {baht(r.retentionDue)}</div>}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="btn btn-sm" onClick={() => copy(r)}>{copied === r.id ? 'คัดลอกแล้ว' : 'คัดลอกข้อความ'}</button>
              <button className="btn btn-sm btn-primary" disabled={busy === r.id} onClick={() => markDone(r)}>ทักแล้ว</button>
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
