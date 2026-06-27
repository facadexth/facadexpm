// ============================================================
// Categories — หมวดหมู่ค่าใช้จ่าย
// ✅ Add/Edit/Delete expense categories
// ✅ ชื่อ, สี, sort_order
// ✅ Drag-to-reorder via sort_order buttons
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useCategories } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'

const PRESET_COLORS = [
  '#6c63ff','#00d4aa','#ff6b6b','#ffd166','#4ecdc4',
  '#a29bfe','#fd79a8','#74b9ff','#55efc4','#fab1a0'
]

const EMPTY_FORM = { name: '', color: '#6c63ff', sort_order: 99 }

function CatForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const [form, setForm] = useState({ ...EMPTY_FORM, ...initial })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">ชื่อหมวด ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น ค่ากระจก, ค่าอลูมิเนียม" />
        </div>
        <div>
          <label className="label">สี</label>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 8 }}>
            {PRESET_COLORS.map(c => (
              <button key={c} type="button"
                style={{ width: 28, height: 28, borderRadius: 6, background: c, border: form.color === c ? '3px solid white' : '2px solid transparent', cursor: 'pointer' }}
                onClick={() => set('color', c)}
              />
            ))}
          </div>
          <input type="color" value={form.color} onChange={e => set('color', e.target.value)} style={{ width: 44, height: 32, borderRadius: 6, border: 'none', cursor: 'pointer', background: 'none' }} />
        </div>
        <div>
          <label className="label">ลำดับ (sort_order)</label>
          <input type="number" className="input" min="0" value={form.sort_order} onChange={e => set('sort_order', parseInt(e.target.value) || 0)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function Categories() {
  const { data: categories, refetch } = useCategories()
  const [showForm, setShowForm] = useState(false)
  const [editCat,  setEditCat]  = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [saving,   setSaving]   = useState(false)

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = { name: form.name, color: form.color, sort_order: form.sort_order }
      if (editCat) {
        const { error } = await supabase.from('expense_categories').update(payload).eq('id', editCat.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('expense_categories').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditCat(null); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('expense_categories').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('ลบไม่ได้: อาจมีรายจ่ายที่ใช้หมวดนี้อยู่')
  }

  const moveOrder = async (cat, dir) => {
    const newOrder = cat.sort_order + dir
    await supabase.from('expense_categories').update({ sort_order: newOrder }).eq('id', cat.id)
    refetch()
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className="btn btn-primary" onClick={() => { setEditCat(null); setShowForm(true) }}>+ เพิ่มหมวดหมู่</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr><th>สี</th><th>ชื่อหมวด</th><th>ลำดับ</th><th>เรียง</th><th></th></tr>
            </thead>
            <tbody>
              {(categories || []).map((c, i) => (
                <tr key={c.id}>
                  <td>
                    <span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: c.color || '#6c63ff' }} />
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    <span className="badge" style={{ background: `${c.color}22`, color: c.color || 'var(--accent)', fontSize: 13 }}>{c.name}</span>
                  </td>
                  <td style={{ color: 'var(--text3)', textAlign: 'center' }}>{c.sort_order}</td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => moveOrder(c, -1)} disabled={i === 0}>↑</button>
                    <button className="btn btn-sm btn-ghost" onClick={() => moveOrder(c, 1)} disabled={i === (categories||[]).length - 1}>↓</button>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <button className="btn btn-sm btn-ghost" onClick={() => { setEditCat(c); setShowForm(true) }}>✏️</button>
                    <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(c.id)}>🗑️</button>
                  </td>
                </tr>
              ))}
              {!(categories||[]).length && (
                <tr><td colSpan={5} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีหมวดหมู่</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editCat ? 'แก้ไขหมวดหมู่' : 'เพิ่มหมวดหมู่ใหม่'} onClose={() => { setShowForm(false); setEditCat(null) }} maxWidth={400}>
          <CatForm initial={editCat || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditCat(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบหมวดหมู่" message="ยืนยันการลบ? (ถ้ามีรายจ่ายในหมวดนี้ ระบบจะไม่อนุญาต)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
