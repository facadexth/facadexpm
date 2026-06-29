// ============================================================
// Clients — ลูกค้า/เจ้าของงาน
// ✅ Auto-number CL-YYYY-NNN
// ✅ ประเภท: DEVELOPER / ENDUSER / ผู้รับเหมา
// ✅ Add/Edit/Delete CRUD + Excel Import
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useClients } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import ExcelUpload from '../components/ExcelUpload.jsx'

const CLIENT_TYPES = ['DEVELOPER', 'ENDUSER', 'ผู้รับเหมา']

const TYPE_STYLE = {
  'DEVELOPER': { bg: 'rgba(108,99,255,0.15)', color: 'var(--accent)' },
  'ENDUSER':   { bg: 'rgba(0,212,170,0.15)',  color: 'var(--green)' },
  'ผู้รับเหมา': { bg: 'rgba(255,209,102,0.15)', color: 'var(--yellow)' },
}

const EMPTY_FORM = {
  name: '', contact_person: '', position: '',
  phone: '', email: '', client_type: '',
  address: '', province: '', notes: ''
}

function ClientForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อลูกค้า / บริษัท ★</label>
            <input className="input" required value={form.name}
              onChange={e => set('name', e.target.value)} placeholder="เช่น บริษัท NCP จำกัด" />
          </div>
          <div>
            <label className="label">ประเภทลูกค้า</label>
            <select className="select" value={form.client_type} onChange={e => set('client_type', e.target.value)}>
              <option value="">— เลือกประเภท —</option>
              {CLIENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
        </div>
        <div className="form-grid-2">
          <div>
            <label className="label">ชื่อผู้ติดต่อ</label>
            <input className="input" value={form.contact_person} onChange={e => set('contact_person', e.target.value)} />
          </div>
          <div>
            <label className="label">ตำแหน่ง</label>
            <input className="input" value={form.position}
              onChange={e => set('position', e.target.value)} placeholder="เช่น ผู้จัดการโครงการ" />
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

export default function Clients() {
  const { data: clients, refetch } = useClients()
  const [showForm,   setShowForm]   = useState(false)
  const [editItem,   setEditItem]   = useState(null)
  const [deleteId,   setDeleteId]   = useState(null)
  const [saving,     setSaving]     = useState(false)
  const [showImport, setShowImport] = useState(false)
  const [toast,      setToast]      = useState(null)
  const [search,     setSearch]     = useState('')
  const [typeFilter, setTypeFilter] = useState('')

  const filtered = useMemo(() =>
    (clients || []).filter(c =>
      (!typeFilter || c.client_type === typeFilter) &&
      (!search ||
        c.name?.toLowerCase().includes(search.toLowerCase()) ||
        c.client_number?.toLowerCase().includes(search.toLowerCase()) ||
        c.contact_person?.toLowerCase().includes(search.toLowerCase()))
    )
  , [clients, search, typeFilter])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = {
        name:           form.name,
        contact_person: form.contact_person || null,
        position:       form.position || null,
        phone:          form.phone || null,
        email:          form.email || null,
        client_type:    form.client_type || null,
        address:        form.address || null,
        province:       form.province || null,
        notes:          form.notes || null,
      }
      if (editItem) {
        const { error } = await supabase.from('clients').update(payload).eq('id', editItem.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('clients').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditItem(null); refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('clients').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      {toast && <div className="alert alert-success" style={{ marginBottom: 12 }}>✅ {toast}</div>}

      <div style={{ display: 'flex', gap: 10, marginBottom: 16, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => { setEditItem(null); setShowForm(true) }}>+ เพิ่มลูกค้า</button>
        <button className="btn btn-ghost" onClick={() => setShowImport(v => !v)}>📥 Import Excel</button>
        <a className="btn btn-ghost" href="/templates/TEMPLATE_ลูกค้า.xlsx" download>📄 Template</a>
        <input className="input input-sm" style={{ width: 220 }}
          placeholder="ค้นหาชื่อ / รหัส / ผู้ติดต่อ..."
          value={search} onChange={e => setSearch(e.target.value)} />
        <select className="select input-sm" style={{ width: 160 }} value={typeFilter} onChange={e => setTypeFilter(e.target.value)}>
          <option value="">ทุกประเภท</option>
          {CLIENT_TYPES.map(t => <option key={t} value={t}>{t}</option>)}
        </select>
        <span style={{ color: 'var(--text3)', fontSize: 13 }}>{filtered.length} รายการ</span>
      </div>

      {showImport && (
        <div style={{ marginBottom: 16 }}>
          <ExcelUpload type="client" onSuccess={(msg) => {
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
                <th>รหัสลูกค้า</th>
                <th>ชื่อลูกค้า / บริษัท</th>
                <th>ประเภท</th>
                <th>ชื่อผู้ติดต่อ / ตำแหน่ง</th>
                <th>เบอร์โทร</th>
                <th>อีเมล</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(c => {
                const ts = TYPE_STYLE[c.client_type] || {}
                return (
                  <tr key={c.id}>
                    <td style={{ color: 'var(--accent)', fontSize: 11, whiteSpace: 'nowrap', fontWeight: 700 }}>{c.client_number}</td>
                    <td>
                      <div style={{ fontWeight: 600 }}>{c.name}</div>
                      {c.notes && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.notes}</div>}
                    </td>
                    <td>
                      {c.client_type
                        ? <span style={{ background: ts.bg, color: ts.color, padding: '3px 10px', borderRadius: 20, fontSize: 11, fontWeight: 700 }}>{c.client_type}</span>
                        : <span style={{ color: 'var(--text3)' }}>—</span>}
                    </td>
                    <td>
                      <div>{c.contact_person || <span style={{ color: 'var(--text3)' }}>—</span>}</div>
                      {c.position && <div style={{ fontSize: 11, color: 'var(--text3)' }}>{c.position}</div>}
                    </td>
                    <td style={{ fontSize: 12 }}>{c.phone || '—'}</td>
                    <td style={{ fontSize: 12 }}>{c.email || '—'}</td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button className="btn btn-sm btn-ghost" onClick={() => { setEditItem(c); setShowForm(true) }}>แก้ไข</button>
                      <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(c.id)}>ลบ</button>
                    </td>
                  </tr>
                )
              })}
              {!filtered.length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีข้อมูลลูกค้า</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editItem ? `แก้ไข ${editItem.client_number}` : 'เพิ่มลูกค้าใหม่'}
          onClose={() => { setShowForm(false); setEditItem(null) }} maxWidth={600}>
          <ClientForm initial={editItem || EMPTY_FORM} onSave={handleSave}
            onCancel={() => { setShowForm(false); setEditItem(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog
          title="ลบลูกค้า"
          message="ยืนยันการลบลูกค้ารายนี้? (ไซท์งานที่ link อยู่จะถูก unlink)"
          onConfirm={handleDelete}
          onCancel={() => setDeleteId(null)}
        />
      )}
    </div>
  )
}
