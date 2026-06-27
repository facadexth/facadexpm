// ============================================================
// Income — รายรับ
// ✅ Excel drag-drop import (ExcelUpload component)
// ✅ Add/Edit form (เลขใบแจ้งหนี้ auto, วันที่, ไซท์, ลูกค้า, ยอด, VAT, Tax, Retention)
// ✅ Date range filter (ค่าเริ่มต้น YTD)
// ✅ Cross-tab navigation: รับ navState.siteId มา pre-filter ได้
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useIncomes, useSites } from '../hooks/useSupabase.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'

const EMPTY_FORM = {
  invoice_no: '', date: '', site_id: '', client_name: '', description: '',
  amount_no_vat: '', vat: '', tax_withheld: '', retention: '', received_amount: ''
}

function IncomeForm({ initial = EMPTY_FORM, sites, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // คำนวณ received_amount อัตโนมัติ
  const calcReceived = () => {
    const noVat   = parseFloat(form.amount_no_vat) || 0
    const vat     = parseFloat(form.vat)           || 0
    const tax     = parseFloat(form.tax_withheld)  || 0
    const ret     = parseFloat(form.retention)     || 0
    return noVat + vat - tax - ret
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave({ ...form, received_amount: form.received_amount || calcReceived() }) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">เลขที่ใบแจ้งหนี้</label>
            <input className="input" value={form.invoice_no} onChange={e => set('invoice_no', e.target.value)} placeholder="ระบบจะ auto-generate ถ้าว่าง" />
          </div>
          <div>
            <label className="label">วันที่รับเงิน ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ไซท์งาน ★</label>
            <select className="select" required value={form.site_id} onChange={e => set('site_id', e.target.value)}>
              <option value="">— เลือกไซท์ —</option>
              {(sites || []).map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
            </select>
          </div>
          <div>
            <label className="label">ชื่อลูกค้า ★</label>
            <input className="input" required value={form.client_name} onChange={e => set('client_name', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">รายละเอียด ★</label>
          <input className="input" required value={form.description} onChange={e => set('description', e.target.value)} />
        </div>
        <div className="form-grid-4">
          <div>
            <label className="label">มูลค่าก่อน VAT ★</label>
            <input type="number" className="input" required min="0" step="0.01" value={form.amount_no_vat}
              onChange={e => set('amount_no_vat', e.target.value)} />
          </div>
          <div>
            <label className="label">VAT</label>
            <input type="number" className="input" min="0" step="0.01" value={form.vat}
              onChange={e => set('vat', e.target.value)} placeholder="7%" />
          </div>
          <div>
            <label className="label">Tax ถูกหัก</label>
            <input type="number" className="input" min="0" step="0.01" value={form.tax_withheld}
              onChange={e => set('tax_withheld', e.target.value)} placeholder="3%" />
          </div>
          <div>
            <label className="label">Retention</label>
            <input type="number" className="input" min="0" step="0.01" value={form.retention}
              onChange={e => set('retention', e.target.value)} />
          </div>
        </div>
        <div style={{ background: 'rgba(0,212,170,0.08)', borderRadius: 8, padding: '10px 14px', display: 'flex', alignItems: 'center', gap: 12 }}>
          <span style={{ color: 'var(--text2)', fontSize: 13 }}>ยอดที่ได้รับจริง:</span>
          <strong style={{ color: 'var(--green)', fontSize: 18 }}>{fmt(calcReceived())} บาท</strong>
          <div style={{ flex: 1 }} />
          <div>
            <label className="label" style={{ marginBottom: 2 }}>หรือระบุเอง</label>
            <input type="number" className="input input-sm" min="0" step="0.01" value={form.received_amount}
              onChange={e => set('received_amount', e.target.value)} style={{ width: 130 }} placeholder="(ปล่อยว่าง = auto)" />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-success" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function Income({ navigateTo, navState }) {
  const today  = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [siteId,   setSiteId]   = useState(navState?.siteId || '')
  const [search,   setSearch]   = useState('')
  const [showAdd,  setShowAdd]  = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState(null)
  const [showImport, setShowImport] = useState(false)

  useEffect(() => {
    if (navState?.siteId) setSiteId(navState.siteId)
  }, [navState])

  const filters = { from: dateFrom, to: dateTo, siteId, search }
  const { data: incomes, refetch } = useIncomes(filters)
  const { data: sites } = useSites()

  const totalReceived   = useMemo(() => (incomes || []).reduce((s, i) => s + (i.received_amount || 0), 0), [incomes])
  const totalNoVat      = useMemo(() => (incomes || []).reduce((s, i) => s + (i.amount_no_vat || 0), 0), [incomes])
  const totalTax        = useMemo(() => (incomes || []).reduce((s, i) => s + (i.tax_withheld || 0), 0), [incomes])
  const totalRetention  = useMemo(() => (incomes || []).reduce((s, i) => s + (i.retention || 0), 0), [incomes])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        invoice_no:     form.invoice_no || null,
        date:           form.date,
        site_id:        form.site_id || null,
        client_name:    form.client_name,
        description:    form.description,
        amount_no_vat:  parseFloat(form.amount_no_vat) || 0,
        vat:            parseFloat(form.vat) || 0,
        tax_withheld:   parseFloat(form.tax_withheld) || 0,
        retention:      parseFloat(form.retention) || 0,
        received_amount: parseFloat(form.received_amount) || 0,
      }
      if (editRow) {
        const { error } = await supabase.from('incomes').update(payload).eq('id', editRow.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('incomes').insert(payload)
        if (error) throw error
      }
      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('incomes').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch(); showToast('ลบแล้ว') }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <button className="btn btn-success" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มรายรับ</button>
        <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>
        <a className="btn btn-ghost" href="/templates/TEMPLATE_รายรับ.xlsx" download>📄 Template</a>
        <div style={{ flex: 1 }} />
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหา..." value={search} onChange={e => setSearch(e.target.value)} />
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      {/* ── Import ── */}
      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="income" onSuccess={(msg) => { showToast(msg); setShowImport(false); refetch() }} />
        </div>
      )}

      {/* ── Site filter ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <select className="select select-sm" value={siteId} onChange={e => setSiteId(e.target.value)} style={{ minWidth: 200 }}>
          <option value="">ทุกไซท์งาน</option>
          {(sites || []).map(s => <option key={s.id} value={s.id}>{s.site_number} · {s.name}</option>)}
        </select>
        {navState?.siteName && (
          <span className="badge" style={{ background: 'rgba(0,212,170,0.15)', color: 'var(--green)' }}>
            🔍 {navState.siteName}
            <button style={{ background:'none',border:'none',cursor:'pointer',color:'inherit',marginLeft:4 }} onClick={() => setSiteId('')}>✕</button>
          </span>
        )}
      </div>

      {/* ── KPI ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm green"><div className="kpi-label">ยอดรับจริง</div><div className="kpi-value" style={{color:'var(--green)'}}>{fmt(totalReceived)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">ก่อน VAT</div><div className="kpi-value">{fmt(totalNoVat)}</div></div>
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">Tax ถูกหัก</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalTax)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">Retention ค้าง</div><div className="kpi-value">{fmt(totalRetention)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนรายการ</div><div className="kpi-value">{(incomes||[]).length} ใบ</div></div>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขใบแจ้งหนี้</th>
                <th>วันที่</th>
                <th>ไซท์งาน</th>
                <th>ลูกค้า</th>
                <th>รายละเอียด</th>
                <th>ก่อน VAT</th>
                <th>VAT</th>
                <th>Tax หัก</th>
                <th>Retention</th>
                <th>ยอดรับจริง</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(incomes || []).map(i => (
                <tr key={i.id}>
                  <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}>{i.invoice_no || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text2)' }}>{fmtDate(i.date)}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)' }}>{i.site_number || '—'}</td>
                  <td style={{ fontSize: 12 }}>{i.client_name}</td>
                  <td style={{ maxWidth: 200, fontSize: 12 }}>{i.description}</td>
                  <td className="font-mono" style={{ color: 'var(--text2)' }}>{fmt(i.amount_no_vat)}</td>
                  <td className="font-mono" style={{ color: 'var(--text3)', fontSize: 11 }}>{i.vat > 0 ? fmt(i.vat) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.tax_withheld > 0 ? fmt(i.tax_withheld) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.retention > 0 ? fmt(i.retention) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(i.received_amount)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(i); setShowAdd(true) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(i.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
              {!(incomes||[]).length && (
                <tr><td colSpan={11} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบรายรับในช่วงเวลานี้</td></tr>
              )}
            </tbody>
            {(incomes||[]).length > 0 && (
              <tfoot>
                <tr style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                  <td colSpan={5} style={{ color: 'var(--text3)', fontSize: 12, paddingTop: 10 }}>รวมทั้งหมด</td>
                  <td className="font-mono" style={{ color: 'var(--text2)' }}>{fmt(totalNoVat)}</td>
                  <td />
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalTax)}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalRetention)}</td>
                  <td className="font-mono" style={{ color: 'var(--green)' }}>{fmt(totalReceived)}</td>
                  <td />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
      {showAdd && (
        <Modal title={editRow ? 'แก้ไขรายรับ' : 'เพิ่มรายรับ'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={660}>
          <IncomeForm
            initial={editRow || { ...EMPTY_FORM, site_id: siteId }}
            sites={sites}
            onSave={handleSave}
            onCancel={() => { setShowAdd(false); setEditRow(null) }}
            loading={saving}
          />
        </Modal>
      )}

      {/* ── Delete ── */}
      {deleteId && (
        <ConfirmDialog title="ลบรายรับ" message="ยืนยันการลบรายการนี้?" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
