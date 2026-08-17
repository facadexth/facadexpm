// ============================================================
// Expenses — รายจ่าย
// ✅ Excel drag-drop import (ใช้ ExcelUpload component)
// ✅ Add/Edit form (วันที่, รายละเอียด, ไซท์, หมวด, ผู้จำหน่าย, มูลค่า, วิธีชำระ, สถานะ)
// ✅ Toggle สถานะ inline พร้อม confirm dialog
// ✅ Date range filter (ค่าเริ่มต้น YTD)
// ✅ Filter ตามไซท์, หมวด, สถานะ, ค้นหา
// ✅ Cross-tab navigation: รับ navState.siteId มา pre-filter ได้
// ============================================================
import { useState, useEffect, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useExpenses, useSites, useCategories, useSuppliers } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { fmt, fmtDate } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'
import SearchableSelect from '../components/SearchableSelect.jsx'
import { format, startOfYear, endOfYear } from 'date-fns'
import {
  creditTermDays as computeCreditTermDays, paymentMethodOptions, billingDueTargetField,
  calcDueDate, resolvePaymentMethodOnSupplierChange,
} from '../lib/supplierCredit.js'

const siteOpts = (sites) => (sites || []).map(s => ({
  value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}`,
}))
const catOpts = (categories) => (categories || []).map(c => ({ value: c.id, label: c.name, keywords: c.name }))
const supplierOpts = (suppliers) => (suppliers || []).map(s => ({
  value: s.id, label: `${s.supplier_number} · ${s.name}`, keywords: `${s.supplier_number} ${s.name}`,
}))

const PAYMENT_METHODS = ['transfer', 'check', 'cash']
const STATUSES = ['awaiting_billing', 'pending', 'check_issued', 'check_cleared', 'paid']
const STATUS_LABELS = {
  awaiting_billing: '🧾 รอวางบิล',
  pending: '⏳ ค้างจ่าย',
  check_issued: '📄 ออกเช็ค',
  check_cleared: '🏦 เช็คผ่าน',
  paid: '✅ จ่ายแล้ว',
}

const EMPTY_FORM = {
  date: '', description: '', site_id: '', category_id: '', supplier: '', supplier_id: '',
  amount: '', payment_method: 'transfer', check_date: '', billing_date: '', due_date: '',
  status: 'pending', payer: '', notes: '', invoice_no: ''
}

function ExpenseForm({ initial = EMPTY_FORM, sites, categories, suppliers = [], onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  // เครดิตเทอมของ Supplier ที่เลือก (วัน) — ใช้คำนวณวันครบกำหนดจากวันวางบิล
  const selectedSupplier = suppliers.find(s => s.id === form.supplier_id)
  const creditTermDays = computeCreditTermDays(selectedSupplier)
  const methodOptions = paymentMethodOptions(selectedSupplier)

  // วันวางบิล → คำนวณวันครบกำหนดให้อัตโนมัติ
  // เช็ค: เขียนลง check_date · เครดิต: เขียนลง due_date — เฉพาะตอนที่ยังไม่ได้กรอกวันครบกำหนดเอง
  const setBillingDate = (val) => {
    setForm(f => {
      const next = { ...f, billing_date: val }
      const targetField = billingDueTargetField(f.payment_method)
      if (!f[targetField] && val && creditTermDays != null) {
        next[targetField] = calcDueDate(val, creditTermDays)
      }
      return next
    })
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">วันที่สั่งซื้อ ★</label>
            <input type="date" className="input" required value={form.date} onChange={e => set('date', e.target.value)} />
          </div>
          <div>
            <label className="label">เลขที่ใบกำกับ</label>
            <input className="input" value={form.invoice_no} onChange={e => set('invoice_no', e.target.value)} placeholder="ถ้ามี" />
          </div>
        </div>
        <div>
          <label className="label">รายละเอียด ★</label>
          <input className="input" required value={form.description} onChange={e => set('description', e.target.value)} />
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ไซท์งาน ★</label>
            <SearchableSelect
              required
              value={form.site_id}
              onChange={id => set('site_id', id)}
              placeholder="— เลือกไซท์ —"
              options={siteOpts(sites)}
            />
          </div>
          <div>
            <label className="label">หมวดค่าใช้จ่าย ★</label>
            <SearchableSelect
              required
              value={form.category_id}
              onChange={id => set('category_id', id)}
              placeholder="— เลือกหมวด —"
              options={catOpts(categories)}
            />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">Supplier</label>
            <SearchableSelect
              value={form.supplier_id}
              onChange={id => {
                const sup = suppliers.find(s => s.id === id)
                const hasCredit = !sup || sup.credit_days != null
                setForm(f => ({
                  ...f,
                  supplier_id: id,
                  supplier: sup ? sup.name : (id ? f.supplier : ''),
                  payment_method: resolvePaymentMethodOnSupplierChange(f.payment_method, hasCredit),
                }))
              }}
              placeholder="— เลือก Supplier —"
              options={supplierOpts(suppliers)}
            />
          </div>
          <div>
            <label className="label">มูลค่า (บาท) ★</label>
            <input type="number" className="input" required min="0" step="0.01" value={form.amount}
              onChange={e => set('amount', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-3">
          <div>
            <label className="label">วิธีชำระ ★</label>
            <select className="select" value={form.payment_method} onChange={e => set('payment_method', e.target.value)}>
              {methodOptions.includes('transfer') && <option value="transfer">โอนเงิน</option>}
              {methodOptions.includes('check') && <option value="check">เช็ค</option>}
              {methodOptions.includes('cash') && <option value="cash">เงินสด</option>}
              {methodOptions.includes('credit') && <option value="credit">เครดิต</option>}
            </select>
          </div>
          {form.payment_method === 'check' && (
            <div>
              <label className="label">วันที่เช็ค / Due date</label>
              <input type="date" className="input" value={form.check_date} onChange={e => set('check_date', e.target.value)} />
            </div>
          )}
          <div>
            <label className="label">สถานะ</label>
            <select className="select" value={form.status} onChange={e => set('status', e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
        </div>
        {(form.payment_method === 'check' || form.payment_method === 'credit') && (
          <div className="form-grid-2">
            <div>
              <label className="label">วันวางบิล</label>
              <input type="date" className="input" value={form.billing_date} onChange={e => setBillingDate(e.target.value)} />
            </div>
            {form.payment_method === 'credit' && (
              <div>
                <label className="label">วันครบกำหนด (due date)</label>
                <input type="date" className="input" value={form.due_date} onChange={e => set('due_date', e.target.value)} />
                <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
                  {creditTermDays != null ? `คำนวณจากเครดิตเทอมของ Supplier (${creditTermDays} วัน) — แก้ไขเองได้` : 'ไม่พบเครดิตเทอมของ Supplier — กรอกวันครบกำหนดเอง'}
                </div>
              </div>
            )}
            {form.payment_method === 'check' && (
              <div style={{ fontSize: 11, color: 'var(--text3)', alignSelf: 'end', paddingBottom: 8 }}>
                {creditTermDays != null ? `วันที่เช็คด้านบนคำนวณจากเครดิตเทอมของ Supplier (${creditTermDays} วัน) — แก้ไขเองได้` : 'ไม่พบเครดิตเทอมของ Supplier — กรอกวันที่เช็คเอง'}
              </div>
            )}
          </div>
        )}
        <div className="form-grid-2">
          <div>
            <label className="label">ผู้จ่าย</label>
            <input className="input" value={form.payer} onChange={e => set('payer', e.target.value)} />
          </div>
          <div>
            <label className="label">หมายเหตุ</label>
            <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
          </div>
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function Expenses({ navigateTo, navState }) {
  const { isAtLeast } = useUserRole()
  const canEdit = isAtLeast('ADMIN')
  const today = new Date()
  const ytdFrom = format(startOfYear(today), 'yyyy-MM-dd')
  const ytdTo   = format(endOfYear(today),   'yyyy-MM-dd')

  const [dateFrom, setDateFrom] = useState(ytdFrom)
  const [dateTo,   setDateTo]   = useState(ytdTo)
  const [dateField, setDateField] = useState('date')
  const [siteId,   setSiteId]   = useState(navState?.siteId || '')
  const [catId,    setCatId]    = useState('')
  const [supplierId, setSupplierId] = useState('')
  const [status,   setStatus]   = useState('')
  const [search,   setSearch]   = useState('')
  const [showAdd,  setShowAdd]  = useState(false)
  const [editRow,  setEditRow]  = useState(null)
  const [toggleRow,setToggleRow]= useState(null)  // { id, currentStatus }
  const [newStatus, setNewStatus] = useState('')
  const [deleteId, setDeleteId] = useState(null)
  const [saving,   setSaving]   = useState(false)
  const [toast,    setToast]    = useState(null)
  const [showImport, setShowImport] = useState(false)

  // ถ้า navigate มาพร้อม siteId ให้ set filter
  useEffect(() => {
    if (navState?.siteId) setSiteId(navState.siteId)
  }, [navState])

  const filters = { from: dateFrom, to: dateTo, dateField, siteId, categoryId: catId, supplierId, status, search }
  const { data: expenses, refetch } = useExpenses(filters)
  const { data: sites }      = useSites()
  const { data: categories } = useCategories()
  const { data: suppliers }  = useSuppliers()

  const totalAmount = useMemo(() => (expenses || []).reduce((s, e) => s + (e.amount || 0), 0), [expenses])
  const totalPaid   = useMemo(() => (expenses || []).filter(e => e.status === 'paid' || e.status === 'check_cleared').reduce((s, e) => s + (e.amount || 0), 0), [expenses])
  const totalPending = useMemo(() => (expenses || []).filter(e => e.status === 'pending' || e.status === 'check_issued').reduce((s, e) => s + (e.amount || 0), 0), [expenses])

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(null), 3000) }

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        date:           form.date,
        description:    form.description,
        site_id:        form.site_id || null,
        category_id:    form.category_id || null,
        supplier:       form.supplier || null,
        supplier_id:    form.supplier_id || null,
        amount:         parseFloat(form.amount) || 0,
        payment_method: form.payment_method,
        check_date:     form.check_date || null,
        billing_date:   form.billing_date || null,
        due_date:       form.due_date || null,
        status:         form.status,
        payer:          form.payer || null,
        notes:          form.notes || null,
        invoice_no:     form.invoice_no || null,
      }
      if (editRow) {
        const { error } = await supabase.from('expenses').update(payload).eq('id', editRow.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('expenses').insert(payload)
        if (error) throw error
      }
      setShowAdd(false); setEditRow(null); refetch(); showToast('บันทึกสำเร็จ')
    } catch (e) {
      alert('Error: ' + e.message)
    } finally {
      setSaving(false)
    }
  }

  const handleToggleStatus = async () => {
    if (!toggleRow || !newStatus) return
    const { error } = await supabase.from('expenses').update({ status: newStatus }).eq('id', toggleRow.id)
    if (!error) { setToggleRow(null); refetch(); showToast('อัปเดตสถานะแล้ว') }
    else alert('Error: ' + error.message)
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('expenses').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch(); showToast('ลบแล้ว') }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      {/* ── Toolbar ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        {canEdit && <button className="btn btn-primary" onClick={() => { setEditRow(null); setShowAdd(true) }}>+ เพิ่มรายจ่าย</button>}
        {canEdit && <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>}
        <a className="btn btn-ghost" href="/templates/TEMPLATE_รายจ่าย.xlsx" download>📄 Template</a>
        <div style={{ flex: 1 }} />
        <input className="input input-sm" style={{ width: 180 }} placeholder="ค้นหารายละเอียด..." value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select select-sm" value={dateField} onChange={e => setDateField(e.target.value)}>
          <option value="date">วันที่สั่งซื้อ</option>
          <option value="billing_date">วันวางบิล</option>
          <option value="due">วันครบกำหนด (เช็ค/เครดิต)</option>
        </select>
        <input type="date" className="input input-sm" value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
        <span style={{ color: 'var(--text3)' }}>—</span>
        <input type="date" className="input input-sm" value={dateTo} onChange={e => setDateTo(e.target.value)} />
      </div>

      {/* ── Import Zone ── */}
      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="expense" onSuccess={(msg) => { showToast(msg); setShowImport(false); refetch() }} />
        </div>
      )}

      {/* ── Sub-filters ── */}
      <div style={{ display: 'flex', gap: 10, marginBottom: 14, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ minWidth: 200 }}>
          <SearchableSelect value={siteId} onChange={setSiteId} placeholder="ทุกไซท์งาน" options={siteOpts(sites)} />
        </div>
        <div style={{ minWidth: 170 }}>
          <SearchableSelect value={catId} onChange={setCatId} placeholder="ทุกหมวด" options={catOpts(categories)} />
        </div>
        <div style={{ minWidth: 190 }}>
          <SearchableSelect value={supplierId} onChange={setSupplierId} placeholder="ทุก Supplier" options={supplierOpts(suppliers)} />
        </div>
        <select className="select select-sm" value={status} onChange={e => setStatus(e.target.value)}>
          <option value="">ทุกสถานะ</option>
          {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
        </select>
        {navState?.siteName && (
          <span className="badge" style={{ background: 'rgba(108,99,255,0.2)', color: 'var(--accent)' }}>
            🔍 {navState.siteName} <button style={{ background:'none',border:'none',cursor:'pointer',color:'inherit',marginLeft:4 }} onClick={() => setSiteId('')}>✕</button>
          </span>
        )}
      </div>

      {/* ── KPI Row ── */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 14, flexWrap: 'wrap' }}>
        <div className="kpi-card kpi-sm red"><div className="kpi-label">รายจ่ายรวม</div><div className="kpi-value" style={{color:'var(--red)'}}>{fmt(totalAmount)}</div></div>
        <div className="kpi-card kpi-sm green"><div className="kpi-label">จ่ายแล้ว</div><div className="kpi-value" style={{color:'var(--green)'}}>{fmt(totalPaid)}</div></div>
        <div className="kpi-card kpi-sm yellow"><div className="kpi-label">ค้างจ่าย</div><div className="kpi-value" style={{color:'var(--yellow)'}}>{fmt(totalPending)}</div></div>
        <div className="kpi-card kpi-sm"><div className="kpi-label">จำนวนรายการ</div><div className="kpi-value">{(expenses||[]).length} รายการ</div></div>
      </div>

      {/* ── Table ── */}
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>วันที่</th>
                <th>รายละเอียด</th>
                <th>ไซท์งาน</th>
                <th>หมวด</th>
                <th>ผู้จำหน่าย</th>
                <th>มูลค่า</th>
                <th>วิธีชำระ</th>
                <th>วันเช็ค</th>
                <th>สถานะ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {(expenses || []).map(e => (
                <tr key={e.id}>
                  <td style={{ whiteSpace: 'nowrap', color: 'var(--text2)', fontSize: 12 }}>{fmtDate(e.date)}</td>
                  <td style={{ maxWidth: 220 }}>
                    <div style={{ fontWeight: 500, fontSize: 13 }}>{e.description}</div>
                    {e.invoice_no && <div style={{ fontSize: 10, color: 'var(--text3)' }}>#{e.invoice_no}</div>}
                    {e.po_id && <span className="badge" style={{ background: 'rgba(108,99,255,0.15)', color: 'var(--accent)', fontSize: 10, marginTop: 2 }}>🧾 จาก PO</span>}
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--accent)' }} title={e.site_number || undefined}>{e.site_name || '—'}</td>
                  <td style={{ fontSize: 11 }}>
                    {e.category_name
                      ? <span className="badge" style={{ background: 'rgba(108,99,255,0.15)', color: 'var(--accent)' }}>{e.category_name}</span>
                      : <span style={{ color: 'var(--text3)' }}>—</span>}
                  </td>
                  <td style={{ fontSize: 12, color: 'var(--text2)' }}>{e.supplier || '—'}</td>
                  <td className="font-mono" style={{ color: 'var(--red)', fontWeight: 700 }}>{fmt(e.amount)}</td>
                  <td style={{ fontSize: 11 }}>
                    <span className={`badge badge-method-${e.payment_method}`}>{e.payment_method === 'transfer' ? 'โอน' : e.payment_method === 'check' ? 'เช็ค' : 'เงินสด'}</span>
                  </td>
                  <td style={{ fontSize: 11, color: 'var(--text3)', whiteSpace: 'nowrap' }}>{e.check_date ? fmtDate(e.check_date) : '—'}</td>
                  <td>
                    {/* คลิกเพื่อเปลี่ยนสถานะ */}
                    <button
                      className={`badge badge-${e.status}`}
                      style={{ cursor: 'pointer', border: 'none', background: 'none', padding: 0 }}
                      onClick={() => { setToggleRow(e); setNewStatus(e.status) }}
                      title="คลิกเพื่อเปลี่ยนสถานะ"
                    >
                      {STATUS_LABELS[e.status] || e.status}
                    </button>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {canEdit && (
                      <>
                        <button className="btn btn-sm btn-ghost" onClick={() => { setEditRow(e); setShowAdd(true) }}>✏️</button>
                        <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(e.id)}>🗑️</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!(expenses||[]).length && (
                <tr><td colSpan={10} style={{ textAlign: 'center', color: 'var(--text3)', padding: 32 }}>ไม่พบรายจ่ายในช่วงเวลานี้</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* ── Add/Edit Modal ── */}
      {showAdd && (
        <Modal title={editRow ? 'แก้ไขรายจ่าย' : 'เพิ่มรายจ่าย'} onClose={() => { setShowAdd(false); setEditRow(null) }} maxWidth={660}>
          <ExpenseForm
            initial={editRow || { ...EMPTY_FORM, site_id: siteId }}
            sites={sites}
            categories={categories}
            suppliers={suppliers || []}
            onSave={handleSave}
            onCancel={() => { setShowAdd(false); setEditRow(null) }}
            loading={saving}
          />
        </Modal>
      )}

      {/* ── Toggle Status Dialog ── */}
      {toggleRow && (
        <Modal title="เปลี่ยนสถานะรายจ่าย" onClose={() => setToggleRow(null)} maxWidth={360}>
          <div className="modal-body">
            <div style={{ marginBottom: 8, color: 'var(--text2)', fontSize: 13 }}>{toggleRow.description}</div>
            <div style={{ marginBottom: 12, color: 'var(--red)', fontWeight: 700 }}>{fmt(toggleRow.amount)} บาท</div>
            <label className="label">เปลี่ยนเป็น</label>
            <select className="select" value={newStatus} onChange={e => setNewStatus(e.target.value)}>
              {STATUSES.map(s => <option key={s} value={s}>{STATUS_LABELS[s]}</option>)}
            </select>
          </div>
          <div className="modal-footer">
            <button className="btn btn-ghost" onClick={() => setToggleRow(null)}>ยกเลิก</button>
            <button className="btn btn-primary" onClick={handleToggleStatus}>ยืนยัน</button>
          </div>
        </Modal>
      )}

      {/* ── Delete Confirm ── */}
      {deleteId && (
        <ConfirmDialog title="ลบรายจ่าย" message="ยืนยันการลบรายการนี้?" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
