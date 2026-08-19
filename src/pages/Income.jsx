// ============================================================
// Income — รายรับ
// ✅ Excel drag-drop import (ExcelUpload component)
// ✅ Add/Edit form (เลขใบแจ้งหนี้ auto, วันที่, ไซท์, ลูกค้า, ยอด, VAT, Tax, Retention)
// ✅ Date range filter (ค่าเริ่มต้น YTD)
// ✅ Cross-tab navigation: รับ navState.siteId มา pre-filter ได้
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useIncomes, useSites, useSiteDepositBalance } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { useTenant } from '../hooks/useTenant.js'
import { calcDepositDeduction, remainingBalanceForEdit } from '../lib/depositCalc.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import { format, startOfYear, endOfYear } from 'date-fns'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))

const EMPTY_FORM = {
  invoice_no: '', date: '', site_id: '', client_name: '', description: '',
  amount_no_vat: '', vat_pct: '', tax_pct: '', retention_pct: '', received_amount: '',
  income_type: 'ปกติ', deposit_pct: '',
}

function IncomeForm({ initial = EMPTY_FORM, sites, onSave, onCancel, loading, hasModuleAccess = () => false }) {
  const isAdd = !initial?.id
  const [form, setForm, clearFormDraft] = useDraftForm('income-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // คำนวณ VAT / Tax ถูกหัก / Retention อัตโนมัติจาก % ของมูลค่าก่อน VAT
  const noVat       = parseFloat(form.amount_no_vat) || 0
  const vatAmt       = noVat * (parseFloat(form.vat_pct)       || 0) / 100
  const taxAmt        = noVat * (parseFloat(form.tax_pct)       || 0) / 100
  const retentionAmt = noVat * (parseFloat(form.retention_pct) || 0) / 100

  const isDepositRow = form.income_type === 'มัดจำ'
  const depositModuleOn = hasModuleAccess('client_deposits')
  const { data: depositBalance } = useSiteDepositBalance(depositModuleOn ? form.site_id : null)
  // `initial` (not `form`) on purpose -- this must stay the value this row
  // had BEFORE this edit session started, not drift as the user edits
  // other fields. See remainingBalanceForEdit's doc comment.
  const remainingBalance = remainingBalanceForEdit(depositBalance?.remaining_balance, initial?.deposit_deduction)
  const depositAmt = (depositModuleOn && !isDepositRow)
    ? calcDepositDeduction(noVat, parseFloat(form.deposit_pct) || 0, remainingBalance)
    : 0

  const calcReceived = () => noVat + vatAmt - taxAmt - retentionAmt - depositAmt

  return (
    <form onSubmit={e => {
      e.preventDefault()
      clearFormDraft()
      onSave({
        ...form,
        vat: vatAmt.toFixed(2),
        tax_withheld: taxAmt.toFixed(2),
        retention: retentionAmt.toFixed(2),
        deposit_deduction: depositAmt.toFixed(2),
        received_amount: form.received_amount || calcReceived(),
      })
    }}>
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
            <SearchableSelect
              required
              value={form.site_id}
              onChange={id => {
                const site = (sites || []).find(s => s.id === id)
                setForm(f => ({
                  ...f,
                  site_id: id,
                  client_name: site?.client_display_name || site?.client_name || f.client_name,
                  vat_pct:       site?.default_vat_pct          ?? f.vat_pct,
                  tax_pct:       site?.default_tax_withheld_pct ?? f.tax_pct,
                  retention_pct: site?.default_retention_pct    ?? f.retention_pct,
                  deposit_pct:   site?.default_deposit_pct      ?? f.deposit_pct,
                }))
              }}
              placeholder="— เลือกไซท์ —"
              options={siteOpts(sites)}
            />
          </div>
          <div>
            <label className="label">ลูกค้า</label>
            <div className="input" style={{ display: 'flex', alignItems: 'center', color: form.client_name ? 'var(--text)' : 'var(--text3)' }}>
              {form.client_name || '(เลือกไซท์งานก่อน — ลูกค้าจะขึ้นอัตโนมัติ)'}
            </div>
          </div>
        </div>
        <div>
          <label className="label">รายละเอียด ★</label>
          <input className="input" required value={form.description} onChange={e => set('description', e.target.value)} />
        </div>
        {hasModuleAccess('client_deposits') && (
          <div>
            <label className="label">ประเภทรายรับ</label>
            <select className="select" value={form.income_type} onChange={e => set('income_type', e.target.value)}>
              <option value="ปกติ">ปกติ</option>
              <option value="มัดจำ">มัดจำ</option>
            </select>
          </div>
        )}
        <div className="form-grid-4">
          <div>
            <label className="label">มูลค่าก่อน VAT ★</label>
            <input type="number" className="input" required min="0" step="0.01" value={form.amount_no_vat}
              onChange={e => set('amount_no_vat', e.target.value)} />
          </div>
          <div>
            <label className="label">VAT (%)</label>
            <input type="number" className="input" min="0" step="0.01" value={form.vat_pct}
              onChange={e => set('vat_pct', e.target.value)} placeholder="7" />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{fmt(vatAmt)} บาท</div>
          </div>
          <div>
            <label className="label">Tax ถูกหัก (%)</label>
            <input type="number" className="input" min="0" step="0.01" value={form.tax_pct}
              onChange={e => set('tax_pct', e.target.value)} placeholder="3" />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{fmt(taxAmt)} บาท</div>
          </div>
          <div>
            <label className="label">Retention (%)</label>
            <input type="number" className="input" min="0" step="0.01" value={form.retention_pct}
              onChange={e => set('retention_pct', e.target.value)} />
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>{fmt(retentionAmt)} บาท</div>
          </div>
          {hasModuleAccess('client_deposits') && !isDepositRow && (
            <div>
              <label className="label">หักมัดจำ (%)</label>
              <input type="number" className="input" min="0" step="0.01" value={form.deposit_pct}
                onChange={e => set('deposit_pct', e.target.value)} />
              <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                {fmt(depositAmt)} บาท (คงเหลือมัดจำ {fmt(remainingBalance)})
              </div>
            </div>
          )}
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

export default function Income({ navigateTo, navState, openSiteOverview }) {
  const { isAtLeast, role } = useUserRole()
  const { hasModuleAccess } = useTenant()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'income')
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
  const totalDeposit    = useMemo(() => (incomes || []).reduce((s, i) => s + (i.deposit_deduction || 0), 0), [incomes])

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
        income_type:     form.income_type || 'ปกติ',
        deposit_deduction: parseFloat(form.deposit_deduction) || 0,
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
        {canEdit && <button className="btn btn-success" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มรายรับ</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
        <a className="btn btn-ghost" href="/templates/TEMPLATE_รายรับ.xlsx" download>📄 Template</a>
        <div style={{ flex: 1 }} />
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหา..." value={search} onChange={e => setSearch(e.target.value)} />
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" style={{ width: 140 }} value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      {/* ── Import ── */}
      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="income" onSuccess={(msg) => { showToast(msg); setShowImport(false); refetch() }} />
        </div>
      )}

      {/* ── Site filter ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 220 }}>
          <SearchableSelect
            value={siteId}
            onChange={setSiteId}
            placeholder="ทุกไซท์งาน"
            options={siteOpts(sites)}
          />
        </div>
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
                <th>หักมัดจำ</th>
                <th>ยอดรับจริง</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(incomes || []).map(i => (
                <tr key={i.id}>
                  <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap' }}>{i.invoice_no || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap', fontSize: 12, color: 'var(--text2)' }}>{fmtDate(i.date)}</td>
                  <td style={{ fontSize: 11, color: 'var(--accent)', cursor: i.site_id ? 'pointer' : 'default' }} title={i.site_number || undefined}
                    onClick={() => i.site_id && openSiteOverview(i.site_id)}>{i.site_name || '—'}</td>
                  <td style={{ fontSize: 12 }}>{i.client_name}</td>
                  <td style={{ maxWidth: 200, fontSize: 12 }}>{i.description}</td>
                  <td className="font-mono" style={{ color: 'var(--text2)' }}>{fmt(i.amount_no_vat)}</td>
                  <td className="font-mono" style={{ color: 'var(--text3)', fontSize: 11 }}>{i.vat > 0 ? fmt(i.vat) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.tax_withheld > 0 ? fmt(i.tax_withheld) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.retention > 0 ? fmt(i.retention) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--yellow)', fontSize: 11 }}>{i.deposit_deduction > 0 ? fmt(i.deposit_deduction) : '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--green)', fontWeight: 700 }}>{fmt(i.received_amount)}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(i); setShowAdd(true) }}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(i.id)}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!(incomes||[]).length && (
                <tr><td colSpan={12} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบรายรับในช่วงเวลานี้</td></tr>
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
                  <td className="font-mono" style={{ color: 'var(--yellow)' }}>{fmt(totalDeposit)}</td>
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
            initial={editRow ? {
              ...editRow,
              vat_pct:       editRow.amount_no_vat ? +((editRow.vat||0)           / editRow.amount_no_vat * 100).toFixed(2) : '',
              tax_pct:       editRow.amount_no_vat ? +((editRow.tax_withheld||0)  / editRow.amount_no_vat * 100).toFixed(2) : '',
              retention_pct: editRow.amount_no_vat ? +((editRow.retention||0)     / editRow.amount_no_vat * 100).toFixed(2) : '',
              income_type:   editRow.income_type || 'ปกติ',
              deposit_pct:   editRow.amount_no_vat ? +((editRow.deposit_deduction||0) / editRow.amount_no_vat * 100).toFixed(2) : '',
            } : (() => {
              const site = (sites || []).find(s => s.id === siteId)
              return {
                ...EMPTY_FORM,
                site_id: siteId,
                client_name: site?.client_display_name || site?.client_name || '',
                vat_pct:       site?.default_vat_pct          ?? EMPTY_FORM.vat_pct,
                tax_pct:       site?.default_tax_withheld_pct ?? EMPTY_FORM.tax_pct,
                retention_pct: site?.default_retention_pct    ?? EMPTY_FORM.retention_pct,
                deposit_pct:   site?.default_deposit_pct      ?? EMPTY_FORM.deposit_pct,
              }
            })()}
            sites={sites}
            onSave={handleSave}
            onCancel={() => { setShowAdd(false); setEditRow(null) }}
            loading={saving}
            hasModuleAccess={hasModuleAccess}
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
