// ============================================================
// Sites — ไซท์งาน
// ✅ Add/Edit ไซท์ (ชื่อ, สถานะ, วันเริ่ม/จบ, มูลค่าสัญญา)
// ✅ Countdown display + overdue notice
// ✅ ปุ่ม "จบไซท์งาน" พร้อม confirm dialog
// ✅ Cost breakdown (ตั้งค่าต้นทุนต่อประเภท)
// ✅ กดตัวเลขรายรับ/รายจ่าย → navigate พร้อม filter ไซท์
// ✅ Labor cost แยกช่างบริษัท vs sub-contract
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSites, useLaborCost, useClients } from '../hooks/useSupabase.js'
import { fmt, fmtDate, countdown } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'

const STATUS_OPTS = ['Ongoing', 'Completed', 'On Hold', 'Cancelled']

const COST_TYPES = [
  { key: 'cost_aluminum',   label: 'อลูมิเนียม/เหล็ก' },
  { key: 'cost_glass',      label: 'กระจก' },
  { key: 'cost_equipment',  label: 'อุปกรณ์' },
  { key: 'cost_rubber',     label: 'ซิลิโคน/ยาง' },
  { key: 'cost_labor',      label: 'ค่าแรง Sub-contract' },
  { key: 'cost_other',      label: 'เบ็ดเตล็ด' },
]

const EMPTY_FORM = {
  name: '', client_id: '', location: '',
  status: 'Ongoing', start_date: '', end_date: '',
  contract_value: '', notes: '',
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, '']))
}

function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const totalCostBreakdown = COST_TYPES.reduce((s, t) => s + (parseFloat(form[t.key]) || 0), 0)

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อไซท์งาน ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น NCP Tower B" />
          </div>
          <div>
            <label className="label">ลูกค้า / เจ้าของงาน</label>
            <select className="select" value={form.client_id} onChange={e => set('client_id', e.target.value)}>
              <option value="">— เลือกลูกค้า —</option>
              {clients.map(c => <option key={c.id} value={c.id}>{c.client_number} · {c.name}</option>)}
            </select>
          </div>
        </div>
        <div>
          <label className="label">ที่ตั้งโครงการ</label>
          <input className="input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="จังหวัด / ที่อยู่" />
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUS_OPTS.map(s => <option key={s}>{s}</option>)}
            </select>
          </div>
          <div>
            <label className="label">วันเริ่มต้น</label>
            <input type="date" className="input" value={form.start_date} onChange={e => set('start_date', e.target.value)} />
          </div>
          <div>
            <label className="label">วันจบงาน</label>
            <input type="date" className="input" value={form.end_date} onChange={e => set('end_date', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">มูลค่าสัญญา (บาท)</label>
          <input type="number" className="input" min="0" step="0.01" value={form.contract_value}
            onChange={e => set('contract_value', e.target.value)} placeholder="มูลค่ารวม VAT / ตามสัญญา" />
        </div>

        {/* Cost Breakdown */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            ต้นทุนประมาณการ (ระบุหรือไม่ก็ได้)
          </div>
          <div className="form-grid-3">
            {COST_TYPES.map(t => (
              <div key={t.key}>
                <label className="label">{t.label}</label>
                <input type="number" className="input input-sm" min="0" step="0.01"
                  value={form[t.key]} onChange={e => set(t.key, e.target.value)} placeholder="บาท" />
              </div>
            ))}
          </div>
          {totalCostBreakdown > 0 && (
            <div style={{ marginTop: 8, fontSize: 12, color: 'var(--text3)' }}>
              รวมต้นทุนที่ระบุ: <strong style={{ color: 'var(--yellow)' }}>{fmt(totalCostBreakdown)} บาท</strong>
              {form.contract_value && (
                <span style={{ marginLeft: 8 }}>
                  ({((totalCostBreakdown / parseFloat(form.contract_value)) * 100).toFixed(1)}% ของมูลค่าสัญญา)
                </span>
              )}
            </div>
          )}
        </div>

        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Sites({ navigateTo }) {
  const { data: sites, refetch } = useSites()
  const { data: laborData } = useLaborCost()
  const { data: clients }   = useClients()

  const [showForm,    setShowForm]    = useState(false)
  const [editSite,    setEditSite]    = useState(null)     // site object to edit
  const [completeId,  setCompleteId]  = useState(null)     // id to mark completed
  const [deleteId,    setDeleteId]    = useState(null)
  const [saving,      setSaving]      = useState(false)
  const [showImport,  setShowImport]  = useState(false)
  const [toast,       setToast]       = useState(null)
  const [statusFilter, setStatusFilter] = useState('Ongoing')
  const [search,      setSearch]      = useState('')
  const [sortCol,     setSortCol]     = useState('site_number')
  const [sortDir,     setSortDir]     = useState('asc')

  // Labor cost lookup
  const laborBysite = useMemo(() => {
    const m = {}
    ;(laborData || []).forEach(l => {
      if (!m[l.site_id]) m[l.site_id] = 0
      m[l.site_id] += l.labor_cost || 0
    })
    return m
  }, [laborData])

  const filtered = useMemo(() => {
    let rows = (sites || [])
      .filter(s => !statusFilter || statusFilter === 'All' || s.status === statusFilter)
      .filter(s => !search || s.name?.toLowerCase().includes(search.toLowerCase()) || s.site_number?.toLowerCase().includes(search.toLowerCase()))
    return [...rows].sort((a, b) => {
      const va = a[sortCol] ?? ''
      const vb = b[sortCol] ?? ''
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [sites, statusFilter, search, sortCol, sortDir])

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  // ── Handlers ──
  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name:           form.name,
        client_id:      form.client_id || null,
        location:       form.location || null,
        status:         form.status,
        start_date:     form.start_date || null,
        end_date:       form.end_date || null,
        contract_value: parseFloat(form.contract_value) || null,
        notes:          form.notes || null,
        ...Object.fromEntries(COST_TYPES.map(t => [t.key, parseFloat(form[t.key]) || null]))
      }
      if (editSite) {
        const { error } = await supabase.from('sites').update(payload).eq('id', editSite.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('sites').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditSite(null); refetch()
    } catch (e) {
      alert('บันทึกไม่สำเร็จ: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleComplete = async () => {
    if (!completeId) return
    const { error } = await supabase.from('sites').update({ status: 'Completed', end_date: new Date().toISOString().slice(0,10) }).eq('id', completeId)
    if (!error) { setCompleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('sites').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}
      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-primary" onClick={() => { setEditSite(null); setShowForm(true) }}>+ เพิ่มไซท์งาน</button>
        <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>
        <a className="btn btn-ghost" href="/templates/TEMPLATE_ไซท์งาน.xlsx" download>📄 Template</a>
        <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อ / รหัส..." value={search} onChange={e => setSearch(e.target.value)} />
        <div style={{ display: 'flex', gap: 4 }}>
          {['All', ...STATUS_OPTS].map(s => (
            <button key={s}
              className={`btn btn-sm ${statusFilter === s ? 'btn-primary' : 'btn-ghost'}`}
              onClick={() => setStatusFilter(s)}>{s}</button>
          ))}
        </div>
      </div>

      {/* ── Import Zone ── */}
      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="site" onSuccess={(msg) => {
            setToast(msg); setShowImport(false); refetch()
            setTimeout(() => setToast(null), 3000)
          }} />
        </div>
      )}

      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th className="sortable" onClick={() => toggleSort('site_number')}>รหัส{si('site_number')}</th>
                <th className="sortable" onClick={() => toggleSort('name')}>ชื่อไซท์งาน{si('name')}</th>
                <th className="sortable" onClick={() => toggleSort('status')}>สถานะ{si('status')}</th>
                <th className="sortable" onClick={() => toggleSort('contract_value')}>มูลค่าสัญญา{si('contract_value')}</th>
                <th className="sortable" onClick={() => toggleSort('total_income')}>รายรับ (เบิก){si('total_income')}</th>
                <th className="sortable" onClick={() => toggleSort('total_expense')}>รายจ่าย{si('total_expense')}</th>
                <th className="sortable" onClick={() => toggleSort('gross_profit')}>กำไร{si('gross_profit')}</th>
                <th className="sortable" onClick={() => toggleSort('billing_pct')}>% เบิก{si('billing_pct')}</th>
                <th>ค่าแรงช่าง</th>
                <th className="sortable" onClick={() => toggleSort('end_date')}>วันจบงาน{si('end_date')}</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => {
                const days = s.end_date ? countdown(s.end_date) : null
                const pct  = s.billing_pct
                const laborCost = laborBysite[s.id] || 0
                return (
                  <tr key={s.id}>
                    <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}>{s.site_number}</td>
                    <td>
                      <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                      {(s.client_display_name || s.client_name) && (
                        <div style={{ fontSize: 11, color: 'var(--text3)' }}>
                          {s.client_number && <span style={{ color: 'var(--accent)' }}>{s.client_number} · </span>}
                          {s.client_display_name || s.client_name}
                        </div>
                      )}
                    </td>
                    <td>
                      <span className={`badge badge-status-${s.status?.toLowerCase().replace(' ','-')}`}>{s.status}</span>
                    </td>
                    <td className="font-mono" style={{ color: 'var(--text2)' }}>
                      {s.contract_value > 0 ? fmt(s.contract_value) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    {/* รายรับ — คลิกไปหน้า Income */}
                    <td
                      className="font-mono"
                      style={{ color: 'var(--green)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('income', { siteId: s.id, siteName: s.name })}
                      title="ดูรายรับของไซท์นี้"
                    >
                      {s.total_income > 0 ? fmt(s.total_income) : '—'}
                    </td>
                    {/* รายจ่าย — คลิกไปหน้า Expenses */}
                    <td
                      className="font-mono"
                      style={{ color: 'var(--red)', cursor: 'pointer', textDecoration: 'underline dotted' }}
                      onClick={() => navigateTo('expenses', { siteId: s.id, siteName: s.name })}
                      title="ดูรายจ่ายของไซท์นี้"
                    >
                      {s.total_expense > 0 ? fmt(s.total_expense) : '—'}
                    </td>
                    <td className="font-mono" style={{ color: (s.gross_profit||0) >= 0 ? 'var(--green)' : 'var(--red)', fontWeight: 700 }}>
                      {s.total_income > 0 ? fmt(s.gross_profit) : '—'}
                    </td>
                    <td style={{ minWidth: 100 }}>
                      {pct != null ? (
                        <>
                          <div className="progress" style={{ marginBottom: 2 }}>
                            <div className={`progress-bar ${pct>100?'over':''}`} style={{ width: `${Math.min(100,pct)}%` }} />
                          </div>
                          <span style={{ fontSize: 10, color: pct>100?'var(--red)':'var(--text2)' }}>{pct.toFixed(1)}%</span>
                        </>
                      ) : <span style={{ fontSize: 11, color: 'var(--text3)' }}>ใส่มูลค่าสัญญา</span>}
                    </td>
                    <td
                      className="font-mono"
                      style={{ color: laborCost > 0 ? 'var(--yellow)' : 'var(--text3)', fontSize: 12, cursor: laborCost>0?'pointer':'default', textDecoration: laborCost>0?'underline dotted':'none' }}
                      onClick={() => laborCost > 0 && navigateTo('assign', { siteId: s.id, siteName: s.name })}
                      title={laborCost > 0 ? 'ดูรายชื่อช่างของไซท์นี้' : ''}
                    >
                      {laborCost > 0 ? fmt(laborCost) : '—'}
                    </td>
                    <td>
                      {s.end_date ? (
                        <div>
                          <div style={{ fontSize: 11, color: 'var(--text2)', whiteSpace: 'nowrap' }}>{fmtDate(s.end_date)}</div>
                          {days !== null && (
                            <div className={`countdown ${days < 0 ? 'overdue' : days < 14 ? 'warning' : 'ok'}`}>
                              {days < 0 ? `เกิน ${Math.abs(days)} วัน` : `เหลือ ${days} วัน`}
                            </div>
                          )}
                        </div>
                      ) : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" style={{ marginRight: 4 }} onClick={() => { setEditSite(s); setShowForm(true) }}>✏️</button>
                      {s.status === 'Ongoing' && (
                        <button className="btn btn-sm btn-warning" style={{ marginRight: 4 }} onClick={() => setCompleteId(s.id)} title="จบไซท์งาน">✅ จบงาน</button>
                      )}
                      <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(s.id)} title="ลบ">🗑️</button>
                    </td>
                  </tr>
                )
              })}
              {!filtered.length && (
                <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบข้อมูลไซท์งาน</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
      {showForm && (
        <Modal
          title={editSite ? `แก้ไข: ${editSite.name}` : 'เพิ่มไซท์งานใหม่'}
          onClose={() => { setShowForm(false); setEditSite(null) }}
          maxWidth={680}
        >
          <SiteForm
            initial={editSite || EMPTY_FORM}
            clients={clients || []}
            onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditSite(null) }}
            loading={saving}
          />
        </Modal>
      )}

      {/* ── Confirm Complete ── */}
      {completeId && (
        <ConfirmDialog
          title="จบไซท์งาน"
          message={`ยืนยันการจบงานไซท์นี้? สถานะจะเปลี่ยนเป็น Completed และบันทึกวันที่วันนี้เป็นวันจบงาน`}
          onConfirm={handleComplete}
          onCancel={() => setCompleteId(null)}
        />
      )}

      {/* ── Confirm Delete ── */}
      {deleteId && (
        <ConfirmDialog
          title="ลบไซท์งาน"
          message={`ยืนยันการลบไซท์งานนี้? ข้อมูลทั้งหมดที่เชื่อมโยงอาจได้รับผลกระทบ`}
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
          danger
        />
      )}
    </div>
  )
}
