// ============================================================
// Suppliers — ผู้จำหน่าย/Supplier
// ✅ Auto-number SP-YYYY-NNN
// ✅ Add/Edit/Delete CRUD
// ✅ Filter ตามหมวดสินค้า
// ✅ Multi-category (JSONB array) with checkboxes
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useSuppliers } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'

const SUPPLIER_TYPES = [
  'อลูมิเนียม', 'เหล็ก', 'อุปกรณ์', 'กระจก',
  'ซิลิโคน/ยาง', 'วัสดุสิ้นเปลือง', 'อลูมิเนียมคอมโพสิต', 'ฝ้ายิปซั่ม', 'สี'
]

const EMPTY_FORM = {
  name: '', contact_person: '', phone: '', email: '',
  category: [], payment_terms: '', address: '', notes: ''
}

function normCategory(raw) {
  // Normalize category to array regardless of what comes from DB
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  if (typeof raw === 'string') return raw ? [raw] : []
  return []
}

function SupplierForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial, category: normCategory(initial.category) })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const toggleType = (type) => {
    setForm(f => {
      const cats = Array.isArray(f.category) ? f.category : []
      return {
        ...f,
        category: cats.includes(type) ? cats.filter(c => c !== type) : [...cats, type]
      }
    })
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อ Supplier / บริษัท ★</label>
            <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น บริษัท กระจกไทย จำกัด" />
          </div>
          <div>
            <label className="label">ชื่อผู้ติดต่อ</label>
            <input className="input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ประเภทสินค้า (เลือกได้หลายอย่าง)</label>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 6 }}>
              {SUPPLIER_TYPES.map(type => {
                const checked = (Array.isArray(form.category) ? form.category : []).includes(type)
                return (
                  <label key={type} style={{
                    display: 'flex', alignItems: 'center', gap: 5, cursor: 'pointer',
                    padding: '4px 10px', borderRadius: 20, fontSize: 12, fontWeight: 500,
                    background: checked ? 'var(--accent)' : 'var(--bg3)',
                    color: checked ? '#fff' : 'var(--text2)',
                    border: `1px solid ${checked ? 'var(--accent)' : 'var(--border)'}`,
                    transition: 'all 0.15s',
                    userSelect: 'none',
                  }}>
                    <input
                      type="checkbox"
                      style={{ display: 'none' }}
                      checked={checked}
                      onChange={() => toggleType(type)}
                    />
                    {checked ? '✓ ' : ''}{type}
                  </label>
                )
              })}
            </div>
          </div>
          <div>
            <label className="label">เงื่อนไขการชำระ</label>
            <input className="input" value={form.payment_terms} onChange={e => set('payment_terms', e.target.value)} placeholder="เช่น 30 วัน / เงินสด" />
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">เบอร์โทร</label>
            <input className="input" value={form.phone} onChange={e => set('phone', e.target.value)} />
          </div>
          <div>
            <label className="label">อีเมล</label>
            <input type="email" className="input" value={form.email} onChange={e => set('email', e.target.value)} />
          </div>
        </div>
        <div>
          <label className="label">ที่อยู่</label>
          <input className="input" value={form.address} onChange={e => set('address', e.target.value)} />
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

export default function Suppliers() {
  const { data: suppliers, refetch } = useSuppliers()
  const [showForm, setShowForm] = useState(false)
  const [editItem, setEditItem] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving,     setSaving]     = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [toast,      setToast]      = useState(null)
  const [search,     setSearch]     = useState('')
  const [catFilter,  setCatFilter]  = useState('')

  const filtered = useMemo(() =>
    (suppliers || []).filter(s => {
      const cats = normCategory(s.category)
      return (!catFilter || cats.includes(catFilter)) &&
        (!search || s.name?.toLowerCase().includes(search.toLowerCase()) ||
          s.supplier_number?.toLowerCase().includes(search.toLowerCase()))
    })
  , [suppliers, search, catFilter])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const cats = normCategory(form.category)
      const payload = {
        name: form.name, contact_person: form.contact_person || null,
        phone: form.phone || null, email: form.email || null,
        category: cats.length ? cats : null,
        payment_terms: form.payment_terms || null,
        address: form.address || null, notes: form.notes || null,
      }
      if (editItem) {
        const { error } = await supabase.from('suppliers').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('suppliers').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('suppliers').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}
      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่ม Supplier</button>
        <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>
        <a className="btn btn-ghost" href="/templates/TEMPLATE_Supplier.xlsx" download>📄 Template</a>
        <input className="input input-sm" style={{ width: 200 }}
          placeholder="ค้นหาชื่อ / รหัส..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select input-sm" style={{ width: 160 }} value={catFilter} onChange={e => setCatFilter(e.target.value)}>
          <option value="">ทุกประเภท</option>
          {SUPPLIER_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="supplier" onSuccess={(msg) => {
            setToast(msg); setShowImport(false); refetch()
            setTimeout(() => setToast(null), 3000)
          }} />
        </div>
      )}

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>รหัส Supplier</th>
                <th>ชื่อ Supplier / บริษัท</th>
                <th>หมวดสินค้า</th>
                <th>ผู้ติดต่อ</th>
                <th>เบอร์โทร</th>
                <th>เงื่อนไขชำระ</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(s => (
                <tr key={s.id}>
                  <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap', fontWeight: 700 }}>{s.supplier_number}</td>
                  <td>
                    <div style={{ fontWeight: 600 }}>{s.name}</div>
                    {s.address && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{s.address}</div>}
                  </td>
                  <td>
                    {normCategory(s.category).length
                      ? <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                          {normCategory(s.category).map(c => <span key={c} className="badge" style={{ fontSize: 11 }}>{c}</span>)}
                        </div>
                      : <span style={{ color: 'var(--text3)' }}>—</span>
                    }
                  </td>
                  <td style={{ fontSize: 12 }}>{s.contact_person || '—'}</td>
                  <td style={{ fontSize: 12 }}>{s.phone || '—'}</td>
                  <td style={{ fontSize: 12 }}>{s.payment_terms || '—'}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(s); setShowForm(true) }}>แก้ไข</button>
                    <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(s.id)}>ลบ</button>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีข้อมูล Supplier</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.supplier_number}` : 'เพิ่ม Supplier ใหม่'} onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={600}>
          <SupplierForm initial={editItem || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบ Supplier"
          message="ยืนยันการลบ Supplier รายนี้? (รายจ่ายที่ link อยู่จะถูก unlink)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
