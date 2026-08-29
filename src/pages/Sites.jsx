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
import { useSites, useLaborCost, useClients, useSeatStatus } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { useTenant } from '../hooks/useTenant.js'
import AttachmentsSection from '../components/AttachmentsSection.jsx'
import { fmt, fmtDate, countdown } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

const STATUS_OPTS = ['Ongoing', 'Completed', 'On Hold', 'Cancelled']

// cost_labor is intentionally absent here -- it's superseded by real,
// auto-computed labor cost (site_financial_summary.worker_labor_cost /
// subcontractor_labor_cost, shown in SiteOverviewModal's pie chart and no
// longer a manual estimate). The sites.cost_labor column itself is left
// untouched so no historical estimate data is lost.
const COST_TYPES = [
  { key: 'cost_aluminum',   label: 'อลูมิเนียม/เหล็ก' },
  { key: 'cost_glass',      label: 'กระจก' },
  { key: 'cost_equipment',  label: 'อุปกรณ์' },
  { key: 'cost_rubber',     label: 'ซิลิโคน/ยาง' },
  { key: 'cost_other',      label: 'เบ็ดเตล็ด' },
]

const EMPTY_FORM = {
  name: '', client_id: '', location: '',
  distance_km: '', map_url: '',
  status: 'Ongoing', start_date: '', end_date: '',
  has_vat: true, contract_value_no_vat: '', notes: '',
  default_vat_pct: 7, default_tax_withheld_pct: 3, default_retention_pct: 0,
  default_retention_period_days: '', default_deposit_pct: 0,
  ...Object.fromEntries(COST_TYPES.map(t => [t.key, '']))
}

const VAT_RATE = 0.07

/**
 * Build the `sites` insert/update payload from a SiteForm form object.
 * Shared by Sites.jsx's own add/edit flow and Quotations.jsx's
 * "accept quotation → create new site" flow, so both write the exact
 * same full set of fields (no silently-dropped fields in either place).
 */
export function siteFormToPayload(form) {
  const noVatValue = parseFloat(form.contract_value_no_vat) || 0
  const vatAmount = form.has_vat ? Math.round(noVatValue * VAT_RATE * 100) / 100 : 0
  const contractValueTotal = Math.round((noVatValue + vatAmount) * 100) / 100
  return {
    name:           form.name,
    client_id:      form.client_id || null,
    location:       form.location || null,
    distance_km:    parseFloat(form.distance_km) || null,
    map_url:        form.map_url || null,
    status:         form.status,
    start_date:     form.start_date || null,
    end_date:       form.end_date || null,
    has_vat:              form.has_vat,
    contract_value_no_vat: noVatValue || null,
    contract_value:        contractValueTotal || null,
    default_vat_pct:           form.default_vat_pct === '' ? null : parseFloat(form.default_vat_pct),
    default_tax_withheld_pct:  form.default_tax_withheld_pct === '' ? null : parseFloat(form.default_tax_withheld_pct),
    default_retention_pct:     form.default_retention_pct === '' ? null : parseFloat(form.default_retention_pct),
    default_retention_period_days: form.default_retention_period_days === '' ? null : parseInt(form.default_retention_period_days, 10),
    default_deposit_pct:       form.default_deposit_pct === '' ? null : parseFloat(form.default_deposit_pct),
    notes:          form.notes || null,
    ...Object.fromEntries(COST_TYPES.map(t => [t.key, parseFloat(form[t.key]) || null]))
  }
}

export function SiteForm({ initial = EMPTY_FORM, clients = [], onSave, onCancel, loading, hasModuleAccess = () => false, draftKey = 'sites-form', seat }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm(draftKey, { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  const sitesFull = isAdd && form.status === 'Ongoing' && seat?.sites?.max != null && seat.sites.used >= seat.sites.max

  const totalCostBreakdown = COST_TYPES.reduce((s, t) => s + (parseFloat(form[t.key]) || 0), 0)

  const noVatValue = parseFloat(form.contract_value_no_vat) || 0
  const vatAmount = form.has_vat ? Math.round(noVatValue * VAT_RATE * 100) / 100 : 0
  const contractValueTotal = Math.round((noVatValue + vatAmount) * 100) / 100

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อไซท์งาน ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น NCP Tower B" />
          </div>
          <div>
            <label className="label">ลูกค้า / เจ้าของงาน</label>
            <SearchableSelect
              value={form.client_id}
              onChange={id => set('client_id', id)}
              placeholder="— เลือกลูกค้า —"
              options={clients.map(c => ({
                value: c.id,
                label: `${c.client_number} · ${c.name}`,
                keywords: `${c.client_number} ${c.name}`,
              }))}
            />
          </div>
        </div>
        <div>
          <label className="label">ที่ตั้งโครงการ</label>
          <input className="input" value={form.location} onChange={e => set('location', e.target.value)} placeholder="จังหวัด / ที่อยู่" />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ระยะทางจากโรงงาน (กม.)</label>
            <input type="number" className="input" min="0" step="0.1" value={form.distance_km}
              onChange={e => set('distance_km', e.target.value)} placeholder="เที่ยวเดียว — ใช้คิดค่าเดินทาง (×2)" />
          </div>
          <div>
            <label className="label">ลิงก์ Google Maps</label>
            <input className="input" type="url" value={form.map_url} onChange={e => set('map_url', e.target.value)} placeholder="วางลิงก์แผนที่..." />
          </div>
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUS_OPTS.map(s => <option key={s}>{s}</option>)}
            </select>
            {sitesFull && (
              <div className="alert alert-warning" style={{ fontSize: 12, marginTop: 6 }}>
                ⚠️ Package ปัจจุบันอนุญาตไซท์งาน "กำลังดำเนินการ" สูงสุด {seat.sites.max} ไซท์ (ใช้ไปแล้ว {seat.sites.used})
                หากบันทึกอาจไม่สำเร็จ — ติดต่อผู้ดูแลระบบเพื่ออัปเกรด package
              </div>
            )}
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
          <label className="label">มูลค่าสัญญา</label>
          <div style={{ display: 'flex', gap: 16, marginBottom: 8 }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="has_vat" checked={form.has_vat === true} onChange={() => set('has_vat', true)} />
              มี VAT
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
              <input type="radio" name="has_vat" checked={form.has_vat === false} onChange={() => set('has_vat', false)} />
              ไม่มี VAT
            </label>
          </div>
          <div className="form-grid-2">
            <div>
              <label className="label">มูลค่าก่อน VAT (บาท)</label>
              <input type="number" className="input" min="0" step="0.01" value={form.contract_value_no_vat}
                onChange={e => set('contract_value_no_vat', e.target.value)} placeholder="ตามสัญญา" />
            </div>
            <div>
              <label className="label">รวม VAT (คำนวณอัตโนมัติ)</label>
              <input className="input" disabled value={fmt(contractValueTotal)}
                style={{ opacity: 0.7, cursor: 'not-allowed' }} />
            </div>
          </div>
          {form.has_vat && noVatValue > 0 && (
            <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text3)' }}>
              VAT 7%: {fmt(vatAmount)} บาท
            </div>
          )}
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
              {contractValueTotal > 0 && (
                <span style={{ marginLeft: 8 }}>
                  ({((totalCostBreakdown / contractValueTotal) * 100).toFixed(1)}% ของมูลค่าสัญญา)
                </span>
              )}
            </div>
          )}
        </div>

        {/* Income defaults */}
        <div>
          <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)', marginBottom: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
            ค่าเริ่มต้นสำหรับรายรับ (ใช้ auto-fill ตอนเพิ่มรายรับของไซท์นี้)
          </div>
          <div className="form-grid-4">
            <div>
              <label className="label">VAT (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_vat_pct} onChange={e => set('default_vat_pct', e.target.value)} placeholder="7" />
            </div>
            <div>
              <label className="label">Tax ถูกหัก (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_tax_withheld_pct} onChange={e => set('default_tax_withheld_pct', e.target.value)} placeholder="3" />
            </div>
            <div>
              <label className="label">Retention (%)</label>
              <input type="number" className="input input-sm" min="0" step="0.01"
                value={form.default_retention_pct} onChange={e => set('default_retention_pct', e.target.value)} placeholder="0" />
            </div>
            <div>
              <label className="label">ระยะเวลา retention (วัน)</label>
              <input type="number" className="input input-sm" min="0" step="1"
                value={form.default_retention_period_days} onChange={e => set('default_retention_period_days', e.target.value)} placeholder="เช่น 90" />
            </div>
            {hasModuleAccess('client_deposits') && (
              <div>
                <label className="label">มัดจำ (%)</label>
                <input type="number" className="input input-sm" min="0" step="0.01"
                  value={form.default_deposit_pct} onChange={e => set('default_deposit_pct', e.target.value)} placeholder="0" />
              </div>
            )}
          </div>
        </div>

        <div>
          <label className="label">หมายเหตุ</label>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Sites({ navigateTo, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'sites')
  const { tenant, hasModuleAccess } = useTenant()
  const { data: sites, refetch } = useSites()
  const { data: laborData } = useLaborCost()
  const { data: clients }   = useClients()
  const { data: seat, refetch: refetchSeat } = useSeatStatus()

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
      const payload = siteFormToPayload(form)
      if (editSite) {
        const { error } = await supabase.from('sites').update(payload).eq('id', editSite.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('sites').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditSite(null); refetch(); refetchSeat()
    } catch (e) {
      alert(e.message?.includes('row-level security policy')
        ? 'บันทึกไม่สำเร็จ: อาจเกินจำนวนไซท์งานที่ package ปัจจุบันอนุญาต กรุณาติดต่อผู้ดูแลระบบเพื่ออัปเกรด package'
        : 'บันทึกไม่สำเร็จ: ' + e.message)
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
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditSite(null); setShowForm(true) }}>+ เพิ่มไซท์งาน</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
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
                      <div
                        style={{ fontWeight: 600, fontSize: 13, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}
                        onClick={() => openSiteOverview(s.id)}
                      >
                        {s.name}
                        {s.map_url && (
                          <a href={s.map_url} target="_blank" rel="noreferrer" title="เปิดแผนที่ Google Maps"
                            style={{ textDecoration: 'none', fontSize: 13 }} onClick={e => e.stopPropagation()}>📍</a>
                        )}
                      </div>
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
                      {s.contract_value > 0
                        ? <>
                            {fmt(s.contract_value)}
                            <div style={{ fontSize: 10, color: 'var(--text3)', fontFamily: 'inherit' }}>
                              {s.has_vat ? 'รวม VAT' : 'ไม่มี VAT'}
                            </div>
                          </>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
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
                      {canEdit && (
                        <>
                          <button className="btn btn-sm btn-ghost" style={{ marginRight: 4 }} onClick={() => { setEditSite(s); setShowForm(true) }}>✏️</button>
                          {s.status === 'Ongoing' && (
                            <button className="btn btn-sm btn-warning" style={{ marginRight: 4 }} onClick={() => setCompleteId(s.id)} title="จบไซท์งาน">✅ จบงาน</button>
                          )}
                          <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(s.id)} title="ลบ">🗑️</button>
                        </>
                      )}
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
            hasModuleAccess={hasModuleAccess}
            seat={seat}
          />
          {editSite && tenant?.id && (
            <div className="modal-body" style={{ borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              <AttachmentsSection table="site_attachments" bucket="site-attachments" foreignKey="site_id" entityId={editSite.id} tenantId={tenant.id} />
            </div>
          )}
          {!editSite && (
            <div className="modal-body" style={{ fontSize: 12, color: 'var(--text3)', borderTop: '1px solid var(--border)', paddingTop: 12 }}>
              บันทึกไซท์งานก่อน จึงจะแนบไฟล์ได้
            </div>
          )}
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
