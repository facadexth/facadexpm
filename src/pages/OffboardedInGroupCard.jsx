// Owner card on the Communication Center: workers who left but are still in the LINE group
// (the bot cannot remove people). Mirrors the bell item `offboarded_in_group`; the row
// disappears once the owner marks it done. Until migration 2026-10-13-04 is applied the
// query errors and the card stays hidden.
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { isOffboardedInGroup } from '../lib/pendingRules.js'

export default function OffboardedInGroupCard() {
  const { tenant } = useTenant()
  const [rows, setRows] = useState([])
  const [busyId, setBusyId] = useState(null)

  const load = useCallback(async () => {
    if (!tenant?.id) return
    const { data, error } = await supabase.from('workers')
      .select('id, name, nickname, status, line_offboarding_alerted_at, line_group_removed_at')
      .eq('tenant_id', tenant.id).eq('status', 'inactive').not('line_offboarding_alerted_at', 'is', null)
    setRows(error ? [] : (data || []).filter(isOffboardedInGroup))
  }, [tenant?.id])
  useEffect(() => { load() }, [load])

  const markRemoved = async (id) => {
    setBusyId(id)
    try {
      const { error } = await supabase.from('workers')
        .update({ line_group_removed_at: new Date().toISOString() }).eq('id', id).eq('tenant_id', tenant.id)
      if (error) alert('บันทึกไม่สำเร็จ: ' + error.message)
    } finally {
      setBusyId(null)
      await load()
    }
  }

  if (!rows.length) return null
  return (
    <div className="card" style={{ marginBottom: 20, borderColor: 'var(--yellow)' }}>
      <div style={{ padding: 16, borderBottom: '1px solid var(--border)', fontWeight: 700 }}>⚠️ ช่างพ้นสภาพ ยังอยู่ในกลุ่ม LINE ({rows.length})</div>
      <div style={{ padding: '10px 16px', fontSize: 12, color: 'var(--text3)' }}>
        บอทลบคนออกจากกลุ่มเองไม่ได้ ให้ลบในแอป LINE แล้วกดปุ่มด้านล่าง
      </div>
      {rows.map(w => (
        <div key={w.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 16px', borderTop: '1px solid var(--border)' }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontWeight: 600 }}>{w.nickname || w.name}</div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>บอทพบเมื่อ {new Date(w.line_offboarding_alerted_at).toLocaleString('th-TH')}</div>
          </div>
          <button className="btn btn-sm btn-ghost" disabled={busyId === w.id} onClick={() => markRemoved(w.id)}>ลบออกจากกลุ่มแล้ว</button>
        </div>
      ))}
    </div>
  )
}
