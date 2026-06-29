// ============================================================
// Assign — Assign ช่างต่อไซท์งาน
// ✅ ตาราง assignment รายเดือน (เลือก month/year)
// ✅ เพิ่ม/ลบ assignment: ช่าง × ไซท์ × วัน
// ✅ ตาราง labor cost ต่อไซท์ (วันทำงาน × daily_rate)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useWorkers, useAssignments, useLaborCost, useSites } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal } from '../components/Modal.jsx'
import { format, getDaysInMonth } from 'date-fns'

export default function Assign({ navState }) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year,  setYear]  = useState(now.getFullYear())
  const [showAssignForm, setShowAssignForm] = useState(false)
  const [saving, setSaving] = useState(false)

  // Assignment form
  const [asgWorker, setAsgWorker] = useState('')
  const [asgSite,   setAsgSite]   = useState(navState?.siteId || '')
  const [asgDate,   setAsgDate]   = useState(format(new Date(), 'yyyy-MM-dd'))
  const [asgNotes,  setAsgNotes]  = useState('')
  const [asgType,    setAsgType]    = useState('site')
  const [asgOtHours, setAsgOtHours] = useState(0)

  const { data: workers } = useWorkers()
  const { data: assignments, refetch: refetchAssign } = useAssignments(month, year)
  const { data: laborData } = useLaborCost()
  const { data: sites }  = useSites()

  // ── Matrix: worker × day → site ──
  const daysInMonth = getDaysInMonth(new Date(year, month - 1))
  const dayHeaders  = Array.from({ length: daysInMonth }, (_, i) => i + 1)

  const matrix = useMemo(() => {
    // map[worker_id][day] = { type, site, ot }
    const m = {}
    ;(assignments || []).forEach(a => {
      if (!m[a.worker_id]) m[a.worker_id] = {}
      const day = parseInt(a.date?.slice(8, 10))
      m[a.worker_id][day] = { type: a.type || 'site', site: a.sites?.site_number || '', ot: a.ot_hours || 0 }
    })
    return m
  }, [assignments])

  // ── Labor cost per site ──
  const laborBySite = useMemo(() => {
    const m = {}
    ;(laborData || []).forEach(l => {
      if (!m[l.site_id]) m[l.site_id] = { site_name: l.site_name, site_number: l.site_number, total: 0, workers: [] }
      m[l.site_id].total += l.labor_cost || 0
      m[l.site_id].workers.push({ name: l.worker_name, days: l.days_worked, daily_rate: l.daily_rate, cost: l.labor_cost })
    })
    return Object.values(m)
  }, [laborData])

  // ── Handlers ──
  const handleSaveAssignment = async () => {
    if (!asgWorker || !asgDate) return alert('กรุณาเลือกช่างและวันที่')
    if ((asgType === 'site') && !asgSite) return alert('กรุณาเลือกไซท์งาน')
    setSaving(true)
    try {
      // Upsert (worker_id + date unique)
      const { error } = await supabase.from('worker_assignments').upsert(
        { worker_id: asgWorker, site_id: (asgType === 'site' || asgType === 'subcontract') ? asgSite || null : null, date: asgDate, type: asgType, ot_hours: parseFloat(asgOtHours) || 0, notes: asgNotes || null },
        { onConflict: 'worker_id,date' }
      )
      if (error) throw error
      setShowAssignForm(false); refetchAssign()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

  const TYPE_COLOR = {
    site:        { bg: 'rgba(108,99,255,0.25)', color: 'var(--accent)' },
    office:      { bg: 'rgba(78,205,196,0.25)', color: 'var(--blue)' },
    leave:       { bg: 'rgba(255,107,107,0.25)', color: 'var(--red)' },
    holiday:     { bg: 'rgba(94,97,128,0.25)',  color: 'var(--text3)' },
    subcontract: { bg: 'rgba(255,209,102,0.25)', color: 'var(--yellow)' },
  }
  const TYPE_LABEL = { site: '', office: 'OF', leave: 'LA', holiday: 'HO', subcontract: 'SC' }

  return (
    <div>
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-ghost" onClick={() => setShowAssignForm(true)}>+ Assign งาน</button>
        <div style={{ flex: 1 }} />
        <select className="select select-sm" value={month} onChange={e => setMonth(parseInt(e.target.value))}>
          {MONTHS.map((m, i) => <option key={i+1} value={i+1}>{m}</option>)}
        </select>
        <select className="select select-sm" value={year} onChange={e => setYear(parseInt(e.target.value))}>
          {[2024, 2025, 2026, 2027].map(y => <option key={y}>{y}</option>)}
        </select>
      </div>

      {/* ── Assignment Matrix ── */}
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ตาราง Assign — {MONTHS[month-1]} {year + 543}
      </div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 8, flexWrap: 'wrap' }}>
        {Object.entries(TYPE_COLOR).map(([t, c]) => (
          <span key={t} style={{ fontSize: 11, background: c.bg, color: c.color, padding: '2px 8px', borderRadius: 10 }}>
            {t === 'site' ? '🏗️ ไซท์' : t === 'office' ? '🏢 ออฟฟิศ' : t === 'leave' ? '🏖️ ลา' : t === 'holiday' ? '🎌 หยุด' : '🔧 Sub'}
          </span>
        ))}
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="table-wrap" style={{ overflowX: 'auto' }}>
          <table style={{ minWidth: 900 }}>
            <thead>
              <tr>
                <th style={{ minWidth: 100, position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 10 }}>ช่าง</th>
                {dayHeaders.map(d => (
                  <th key={d} style={{ minWidth: 28, padding: '6px 2px', textAlign: 'center', fontSize: 10, color: 'var(--text3)' }}>{d}</th>
                ))}
                <th style={{ minWidth: 50, textAlign: 'right' }}>รวมวัน</th>
              </tr>
            </thead>
            <tbody>
              {(workers || []).map(w => {
                const row = matrix[w.id] || {}
                const totalDays = Object.values(row).filter(c => c.type === 'site' || c.type === 'subcontract').length
                const leaveDays = Object.values(row).filter(c => c.type === 'leave').length
                return (
                  <tr key={w.id}>
                    <td style={{ position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 5, whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{w.nickname || w.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>{fmt(w.daily_rate)} บ/วัน</div>
                    </td>
                    {dayHeaders.map(d => (
                      <td key={d} style={{ padding: '2px', textAlign: 'center' }}>
                        {row[d] ? (() => {
                          const cell = row[d]
                          const tc = TYPE_COLOR[cell.type] || TYPE_COLOR.site
                          const label = TYPE_LABEL[cell.type] || cell.site
                          return (
                            <span style={{ fontSize: 8, background: tc.bg, color: tc.color, borderRadius: 3, padding: '1px 3px', display: 'inline-block', maxWidth: 30, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={`${cell.type}${cell.site ? ' · '+cell.site : ''}${cell.ot > 0 ? ' OT'+cell.ot+'h' : ''}`}>
                              {label || cell.site}
                              {cell.ot > 0 && <span style={{ fontSize: 7 }}>⚡</span>}
                            </span>
                          )
                        })() : <span style={{ color: 'var(--bg4)', fontSize: 8 }}>·</span>}
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontSize: 11, whiteSpace: 'nowrap' }}>
                      {totalDays > 0 && <span style={{ color: 'var(--green)', fontWeight: 700 }}>{totalDays}วัน</span>}
                      {leaveDays > 0 && <span style={{ color: 'var(--red)', marginLeft: 4 }}>LA{leaveDays}</span>}
                      {totalDays === 0 && leaveDays === 0 && <span style={{ color: 'var(--text3)' }}>0</span>}
                    </td>
                  </tr>
                )
              })}
              {!(workers||[]).length && (
                <tr><td colSpan={daysInMonth + 2} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── OT Summary ── */}
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        สรุป OT (Overtime)
      </div>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ช่าง</th>
                <th style={{ textAlign: 'center' }}>รวม OT (ชั่วโมง)</th>
                <th style={{ textAlign: 'left' }}>รายละเอียด OT</th>
              </tr>
            </thead>
            <tbody>
              {(workers || []).map(w => {
                const row = matrix[w.id] || {}
                const otEntries = Object.entries(row)
                  .filter(([_, cell]) => cell.ot > 0)
                  .map(([day, cell]) => ({ day: parseInt(day), ot: cell.ot, site: cell.site }))
                const totalOt = otEntries.reduce((sum, e) => sum + e.ot, 0)
                return totalOt > 0 ? (
                  <tr key={w.id}>
                    <td style={{ fontWeight: 600 }}>{w.nickname || w.name}</td>
                    <td style={{ textAlign: 'center', fontWeight: 700, color: 'var(--yellow)', fontSize: 14 }}>{totalOt}h</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>
                      {otEntries.map((e, i) => (
                        <span key={i} style={{ display: 'inline-block', marginRight: 12 }}>
                          <strong>{e.day}/{month}</strong> {e.ot}h {e.site && <span style={{ color: 'var(--text3)' }}>@ {e.site}</span>}
                        </span>
                      ))}
                    </td>
                  </tr>
                ) : null
              })}
              {!Object.values(matrix).some(row => Object.values(row).some(cell => cell.ot > 0)) && (
                <tr><td colSpan={3} style={{ textAlign: 'center', color: 'var(--text3)', padding: 16 }}>ไม่มี OT ในเดือนนี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Labor Cost per Site ── */}
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ค่าแรงช่างบริษัท ต่อไซท์งาน (ทุกช่วงเวลา)
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))', gap: 12, marginBottom: 24 }}>
        {laborBySite.map((s, i) => (
          <div key={i} className="card card-body" style={{ padding: '14px 16px' }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 10 }}>
              <div>
                <div style={{ fontSize: 11, color: 'var(--accent)' }}>{s.site_number}</div>
                <div style={{ fontWeight: 700, fontSize: 14 }}>{s.site_name}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: 'var(--text3)' }}>รวมค่าแรงช่าง</div>
                <div style={{ color: 'var(--yellow)', fontWeight: 800, fontSize: 18 }}>{fmt(s.total)}</div>
              </div>
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
              {s.workers.map((w, j) => (
                <div key={j} style={{ display: 'flex', justifyContent: 'space-between', fontSize: 12, borderTop: j > 0 ? '1px solid var(--border)' : 'none', paddingTop: j > 0 ? 4 : 0 }}>
                  <span style={{ color: 'var(--text2)' }}>{w.name}</span>
                  <span style={{ color: 'var(--text3)' }}>{w.days} วัน × {fmt(w.daily_rate)} = <strong style={{ color: 'var(--text)' }}>{fmt(w.cost)}</strong></span>
                </div>
              ))}
            </div>
          </div>
        ))}
        {!laborBySite.length && <div style={{ color: 'var(--text3)', fontSize: 13 }}>ยังไม่มีข้อมูล assignment</div>}
      </div>

      {/* ── Assignment Form Modal ── */}
      {showAssignForm && (
        <Modal title="Assign ช่างเข้าไซท์" onClose={() => setShowAssignForm(false)} maxWidth={400}>
          <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
            <div>
              <label className="label">ช่าง ★</label>
              <select className="select" value={asgWorker} onChange={e => setAsgWorker(e.target.value)}>
                <option value="">— เลือกช่าง —</option>
                {(workers || []).map(w => <option key={w.id} value={w.id}>{w.name} ({w.nickname})</option>)}
              </select>
            </div>
            <div>
              <label className="label">ประเภท ★</label>
              <select className="select" value={asgType} onChange={e => setAsgType(e.target.value)}>
                <option value="site">🏗️ ทำงานที่ไซท์</option>
                <option value="office">🏢 งานออฟฟิศ</option>
                <option value="leave">🏖️ ลา</option>
                <option value="holiday">🎌 หยุด</option>
                <option value="subcontract">🔧 Sub-contract</option>
              </select>
            </div>
            {(asgType === 'site' || asgType === 'subcontract') && (
              <div>
                <label className="label">ไซท์งาน {asgType === 'site' ? '★' : ''}</label>
                <select className="select" value={asgSite} onChange={e => setAsgSite(e.target.value)}>
                  <option value="">— เลือกไซท์ —</option>
                  {(sites || []).filter(s => s.status === 'Ongoing').map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
                </select>
              </div>
            )}
            {asgType === 'site' && (
              <div>
                <label className="label">OT (ชั่วโมง)</label>
                <input type="number" className="input" min="0" step="0.5" value={asgOtHours}
                  onChange={e => setAsgOtHours(parseFloat(e.target.value) || 0)} placeholder="0 = ไม่มี OT" />
              </div>
            )}
            <div>
              <label className="label">วันที่ ★</label>
              <input type="date" className="input" value={asgDate} onChange={e => setAsgDate(e.target.value)} />
            </div>
            <div>
              <label className="label">หมายเหตุ</label>
              <input className="input" value={asgNotes} onChange={e => setAsgNotes(e.target.value)} />
            </div>
            <div style={{ fontSize: 11, color: 'var(--text3)' }}>
              หมายเหตุ: ถ้า Assign ช่างเดิมซ้ำวันเดิม จะอัปเดตไซท์ใหม่แทน (upsert)
            </div>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setShowAssignForm(false)}>ยกเลิก</button>
            <button className="btn btn-primary" onClick={handleSaveAssignment} disabled={saving}>
              {saving ? '⏳...' : '✅ บันทึก'}
            </button>
          </div>
        </Modal>
      )}

    </div>
  )
}
