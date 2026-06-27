// ============================================================
// Assign — Assign ช่างต่อไซท์งาน
// ✅ Add/Edit ข้อมูลช่าง (ชื่อ, เงินเดือน, SSO, วันลา, ประกันสังคม)
// ✅ daily_rate คำนวณ auto = monthly_salary / 26
// ✅ ตาราง assignment รายเดือน (เลือก month/year)
// ✅ เพิ่ม/ลบ assignment: ช่าง × ไซท์ × วัน
// ✅ ตาราง labor cost ต่อไซท์ (วันทำงาน × daily_rate)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useWorkers, useAssignments, useLaborCost, useSites } from '../hooks/useSupabase.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { format, getDaysInMonth, startOfMonth, addDays } from 'date-fns'
import { th } from 'date-fns/locale'

const EMPTY_WORKER = {
  name: '', nickname: '', position: '',
  monthly_salary: '', status: 'active',
  sso_registered: false, annual_leave_days: 6, monthly_contribution: ''
}

function WorkerForm({ initial = EMPTY_WORKER, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_WORKER, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const dailyRate = form.monthly_salary ? (parseFloat(form.monthly_salary) / 26).toFixed(2) : '—'

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อ ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} />
          </div>
          <div>
            <label className="label">ชื่อเล่น</label>
            <input className="input" value={form.nickname} onChange={e => set('nickname', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position} onChange={e => set('position', e.target.value)} placeholder="ช่างกระจก, ช่างอลูมิเนียม..." />
          </div>
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive (ออกแล้ว)</option>
            </select>
          </div>
        </div>
        <div>
          <label className="label">เงินเดือน (บาท) ★</label>
          <input type="number" className="input" required min="0" step="0.01" value={form.monthly_salary}
            onChange={e => set('monthly_salary', e.target.value)} />
          <div style={{ marginTop: 4, fontSize: 11, color: 'var(--text3)' }}>
            → ค่าแรงรายวัน: <strong style={{ color: 'var(--yellow)' }}>{dailyRate} บาท/วัน</strong> (เงินเดือน ÷ 26)
          </div>
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">ประกันสังคม (SSO)</label>
            <select className="select" value={form.sso_registered ? 'yes' : 'no'} onChange={e => set('sso_registered', e.target.value === 'yes')}>
              <option value="yes">มี</option>
              <option value="no">ไม่มี</option>
            </select>
          </div>
          <div>
            <label className="label">วันลาต่อปี</label>
            <input type="number" className="input" min="0" value={form.annual_leave_days}
              onChange={e => set('annual_leave_days', parseInt(e.target.value) || 0)} />
          </div>
          <div>
            <label className="label">เงินสมทบ/เดือน</label>
            <input type="number" className="input" min="0" step="0.01" value={form.monthly_contribution}
              onChange={e => set('monthly_contribution', e.target.value)} placeholder="บาท (ถ้ามี)" />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function Assign({ navState }) {
  const now = new Date()
  const [month, setMonth] = useState(now.getMonth() + 1)
  const [year,  setYear]  = useState(now.getFullYear())
  const [showWorkerForm, setShowWorkerForm] = useState(false)
  const [editWorker,     setEditWorker]     = useState(null)
  const [showAssignForm, setShowAssignForm] = useState(false)
  const [saving, setSaving] = useState(false)
  const [deleteWorkerId, setDeleteWorkerId] = useState(null)

  // Assignment form
  const [asgWorker, setAsgWorker] = useState('')
  const [asgSite,   setAsgSite]   = useState(navState?.siteId || '')
  const [asgDate,   setAsgDate]   = useState(format(new Date(), 'yyyy-MM-dd'))
  const [asgNotes,  setAsgNotes]  = useState('')

  const { data: workers, refetch: refetchWorkers } = useWorkers()
  const { data: assignments, refetch: refetchAssign } = useAssignments(month, year)
  const { data: laborData } = useLaborCost()
  const { data: sites }  = useSites()

  // ── Matrix: worker × day → site ──
  const daysInMonth = getDaysInMonth(new Date(year, month - 1))
  const dayHeaders  = Array.from({ length: daysInMonth }, (_, i) => i + 1)

  const matrix = useMemo(() => {
    // map[worker_id][day] = site_number
    const m = {}
    ;(assignments || []).forEach(a => {
      if (!m[a.worker_id]) m[a.worker_id] = {}
      const day = parseInt(a.date?.slice(8, 10))
      m[a.worker_id][day] = a.sites?.site_number || a.site_id
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
  const handleSaveWorker = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name:                form.name,
        nickname:            form.nickname || null,
        position:            form.position || null,
        monthly_salary:      parseFloat(form.monthly_salary) || 0,
        status:              form.status,
        sso_registered:      form.sso_registered,
        annual_leave_days:   parseInt(form.annual_leave_days) || 0,
        monthly_contribution: parseFloat(form.monthly_contribution) || null,
      }
      if (editWorker) {
        const { error } = await supabase.from('workers').update(payload).eq('id', editWorker.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('workers').insert(payload)
        if (error) throw error
      }
      setShowWorkerForm(false); setEditWorker(null); refetchWorkers()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleSaveAssignment = async () => {
    if (!asgWorker || !asgSite || !asgDate) return alert('กรุณากรอกข้อมูลให้ครบ')
    setSaving(true)
    try {
      // Upsert (worker_id + date unique)
      const { error } = await supabase.from('worker_assignments').upsert(
        { worker_id: asgWorker, site_id: asgSite, date: asgDate, notes: asgNotes || null },
        { onConflict: 'worker_id,date' }
      )
      if (error) throw error
      setShowAssignForm(false); refetchAssign()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDeleteWorker = async () => {
    if (!deleteWorkerId) return
    const { error } = await supabase.from('workers').delete().eq('id', deleteWorkerId)
    if (!error) { setDeleteWorkerId(null); refetchWorkers() }
    else alert('Error: ' + error.message)
  }

  const MONTHS = ['ม.ค.','ก.พ.','มี.ค.','เม.ย.','พ.ค.','มิ.ย.','ก.ค.','ส.ค.','ก.ย.','ต.ค.','พ.ย.','ธ.ค.']

  return (
    <div>
      {/* ── Month selector ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => { setEditWorker(null); setShowWorkerForm(true) }}>+ เพิ่มช่าง</button>
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
                const totalDays = Object.keys(row).length
                return (
                  <tr key={w.id}>
                    <td style={{ position: 'sticky', left: 0, background: 'var(--bg3)', zIndex: 5, whiteSpace: 'nowrap' }}>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{w.nickname || w.name}</div>
                      <div style={{ fontSize: 10, color: 'var(--text3)' }}>{fmt(w.daily_rate)} บ/วัน</div>
                    </td>
                    {dayHeaders.map(d => (
                      <td key={d} style={{ padding: '2px', textAlign: 'center' }}>
                        {row[d]
                          ? <span style={{ fontSize: 8, background: 'rgba(108,99,255,0.25)', color: 'var(--accent)', borderRadius: 3, padding: '1px 2px', display: 'inline-block', maxWidth: 28, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
                              title={row[d]}>{row[d]}</span>
                          : <span style={{ color: 'var(--bg4)', fontSize: 8 }}>·</span>
                        }
                      </td>
                    ))}
                    <td style={{ textAlign: 'right', fontWeight: 700, color: totalDays > 0 ? 'var(--green)' : 'var(--text3)', fontSize: 13 }}>
                      {totalDays}
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

      {/* ── Workers Table ── */}
      <div style={{ marginBottom: 8, color: 'var(--text3)', fontSize: 11, fontWeight: 700, textTransform: 'uppercase', letterSpacing: 1 }}>
        ข้อมูลช่าง / พนักงาน
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>ชื่อ</th><th>ชื่อเล่น</th><th>ตำแหน่ง</th>
                <th>เงินเดือน</th><th>ค่าแรง/วัน</th>
                <th>SSO</th><th>วันลา/ปี</th><th>สถานะ</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(workers || []).map(w => (
                <tr key={w.id}>
                  <td style={{ fontWeight: 600 }}>{w.name}</td>
                  <td style={{ color: 'var(--text2)' }}>{w.nickname || '—'}</td>
                  <td style={{ fontSize: 12, color: 'var(--text3)' }}>{w.position || '—'}</td>
                  <td className="font-mono">{fmt(w.monthly_salary)}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(w.daily_rate)}</td>
                  <td>{w.sso_registered ? <span className="badge badge-paid">✓ มี</span> : <span style={{ color: 'var(--text3)', fontSize: 11 }}>—</span>}</td>
                  <td style={{ textAlign: 'center' }}>{w.annual_leave_days}</td>
                  <td><span className={`badge ${w.status === 'active' ? 'badge-paid' : 'badge-pending'}`}>{w.status}</span></td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditWorker(w); setShowWorkerForm(true) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setDeleteWorkerId(w.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
              {!(workers||[]).length && (
                <tr><td colSpan={9} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีช่าง</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Worker Form Modal ── */}
      {showWorkerForm && (
        <Modal title={editWorker ? `แก้ไข: ${editWorker.name}` : 'เพิ่มช่าง / พนักงาน'} onClose={() => { setShowWorkerForm(false); setEditWorker(null) }} maxWidth={560}>
          <WorkerForm initial={editWorker || EMPTY_WORKER} onSave={handleSaveWorker} onCancel={() => { setShowWorkerForm(false); setEditWorker(null) }} loading={saving} />
        </Modal>
      )}

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
              <label className="label">ไซท์งาน ★</label>
              <select className="select" value={asgSite} onChange={e => setAsgSite(e.target.value)}>
                <option value="">— เลือกไซท์ —</option>
                {(sites || []).filter(s => s.status === 'Ongoing').map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
              </select>
            </div>
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

      {/* ── Delete Worker Confirm ── */}
      {deleteWorkerId && (
        <ConfirmDialog title="ลบช่าง" message="ยืนยันการลบช่างคนนี้? ข้อมูล assignment ทั้งหมดของช่างนี้จะถูกลบด้วย" onConfirm={handleDeleteWorker} onCancel={() => setDeleteWorkerId(null)} danger />
      )}
    </div>
  )
}
