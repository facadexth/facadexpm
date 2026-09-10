// ============================================================
// Categories — หมวดหมู่ (รวม expense_categories + อดีต inventory_categories)
// ✅ Add/Edit/Delete
// ✅ ชื่อ, สี, ใช้คิดต้นทุน/ตัดสต็อก
// ✅ จัดลำดับผ่านปุ่ม ↑/↓ เท่านั้น (ไม่มีเลข sort_order ให้กรอกตรงๆ)
// ============================================================
import { useState, useMemo } from 'react'
import { supabase } from '../lib/supabase.js'
import { useCategories, setCategoryUseForDeduction } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { TrashIcon, PencilIcon } from '../components/icons.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

const PRESET_COLORS = [
  '#6c63ff','#00d4aa','#ff6b6b','#ffd166','#4ecdc4',
  '#a29bfe','#fd79a8','#74b9ff','#55efc4','#fab1a0'
]

const EMPTY_FORM = { name: '', color: '#6c63ff', sort_order: 99, code_prefix: '' }

function CatForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('categories-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">ชื่อหมวด ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น ค่ากระจก, ค่าอลูมิเนียม" />
        </div>
        <div>
          <label className="label">รหัสย่อ (สำหรับตั้งรหัสสินค้าคงคลังอัตโนมัติ)</label>
          <input className="input" value={form.code_prefix || ''} onChange={e => set('code_prefix', e.target.value.toUpperCase())} placeholder="เช่น OPK, GLS — เว้นว่างได้ถ้าไม่ต้องการ" style={{ maxWidth: 160 }} />
          <p style={{ fontSize: 11.5, color: 'var(--text3)', margin: '4px 0 0' }}>ถ้าตั้งไว้ สินค้าคงคลังใหม่ในหมวดนี้ที่เว้นช่องรหัสว่างไว้จะได้รหัสอัตโนมัติ เช่น {form.code_prefix || 'OPK'}-0001, {form.code_prefix || 'OPK'}-0002 ...</p>
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
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
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
  const [search,   setSearch]   = useState('')
  const [sortCol,  setSortCol]  = useState('sort_order')
  const [sortDir,  setSortDir]  = useState('asc')
  const [savingDeductionId, setSavingDeductionId] = useState(null)

  const toggleSort = (col) => {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }
  const si = (col) => sortCol === col ? (sortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const filtered = useMemo(() => {
    const rows = (categories || []).filter(c => !search || c.name?.toLowerCase().includes(search.toLowerCase()))
    return [...rows].sort((a, b) => {
      const va = a[sortCol] ?? '', vb = b[sortCol] ?? ''
      if (typeof va === 'number') return sortDir === 'asc' ? va - vb : vb - va
      return sortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [categories, search, sortCol, sortDir])

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = { name: form.name, color: form.color, code_prefix: form.code_prefix?.trim() || null }
      if (editCat) {
        const { error } = await supabase.from('expense_categories').update(payload).eq('id', editCat.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('expense_categories').insert({ ...payload, sort_order: form.sort_order })
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
    else alert('ลบไม่ได้: อาจมีรายจ่าย/สินค้าคงคลังที่ใช้หมวดนี้อยู่')
  }

  const moveOrder = async (cat, dir) => {
    const newOrder = cat.sort_order + dir
    await supabase.from('expense_categories').update({ sort_order: newOrder }).eq('id', cat.id)
    refetch()
  }

  const handleToggleDeduction = async (cat) => {
    setSavingDeductionId(cat.id)
    try {
      await setCategoryUseForDeduction(cat.id, !cat.use_for_cost_deduction)
      refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSavingDeductionId(null) }
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20, alignItems: 'center', flexWrap: 'wrap' }}>
        <button className="btn btn-primary" onClick={() => { setEditCat(null); setShowForm(true) }}>+ เพิ่มหมวดหมู่</button>
        <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อหมวด..." value={search} onChange={e => setSearch(e.target.value)} />
      </div>

      <p style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 12, maxWidth: 640 }}>
        ติ๊ก "ใช้คิดต้นทุน/ตัดสต็อก" สำหรับหมวดที่จะใช้คิด "ต้นทุนประมาณการ" ในหน้าไซท์งาน และใช้ตั้งสัดส่วน % ตัดสต็อกในหน้าคลังสินค้า —
        หมวดที่ไม่ติ๊กยังใช้แท็กรายจ่าย/สินค้าคงคลังได้ตามปกติ แค่ไม่นับรวมในต้นทุน/การตัดสต็อก
      </p>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>สี</th>
                <th className="sortable" onClick={() => toggleSort('name')}>ชื่อหมวด{si('name')}</th>
                <th>รหัสย่อ</th>
                <th>ใช้คิดต้นทุน/ตัดสต็อก</th>
                <th>เรียง</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              {filtered.map((c, i) => (
                <tr key={c.id}>
                  <td>
                    <span style={{ display: 'inline-block', width: 20, height: 20, borderRadius: 4, background: c.color || '#6c63ff' }} />
                  </td>
                  <td style={{ fontWeight: 600 }}>
                    <span className="badge" style={{ background: `${c.color}22`, color: c.color || 'var(--accent)', fontSize: 13 }}>{c.name}</span>
                  </td>
                  <td style={{ fontSize: 12, fontFamily: 'monospace', color: 'var(--text3)' }}>{c.code_prefix || '—'}</td>
                  <td style={{ textAlign: 'center' }}>
                    <input type="checkbox" checked={!!c.use_for_cost_deduction} disabled={savingDeductionId === c.id}
                      onChange={() => handleToggleDeduction(c)} />
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div className="actions-cell">
                      {/* moveOrder bumps this row's own sort_order by ±1 --
                          only makes sense (and only visually reflects) as
                          "move up/down" when the table is actually sorted
                          by sort_order; sorted by name it'd silently
                          renumber a row without moving it in the view the
                          user is looking at, so hide the buttons then. */}
                      {sortCol === 'sort_order' && sortDir === 'asc' ? (
                        <>
                          <button className="btn btn-sm btn-ghost" onClick={() => moveOrder(c, -1)} disabled={i === 0}>↑</button>
                          <button className="btn btn-sm btn-ghost" onClick={() => moveOrder(c, 1)} disabled={i === filtered.length - 1}>↓</button>
                        </>
                      ) : (
                        <span style={{ fontSize: 11, color: 'var(--text3)' }}>—</span>
                      )}
                    </div>
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    <div className="actions-cell">
                      <button className="btn btn-sm btn-edit" onClick={() => { setEditCat(c); setShowForm(true) }}><PencilIcon /></button>
                      <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(c.id)}><TrashIcon /></button>
                    </div>
                  </td>
                </tr>
              ))}
              {!filtered.length && (
                <tr><td colSpan={6} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีหมวดหมู่</td></tr>
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
        <ConfirmDialog title="ลบหมวดหมู่" message="ยืนยันการลบ? (ถ้ามีรายจ่าย/สินค้าคงคลังในหมวดนี้ ระบบจะไม่อนุญาต)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}
    </div>
  )
}
