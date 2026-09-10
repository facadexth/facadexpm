// src/pages/BomTemplates.jsx
// ============================================================
// BOM Templates -- admin screen for the estimation module's guided
// template editor plus its two small reference catalogs (finishes,
// glass types). Gated on has_module_access('estimation').
// See docs/superpowers/specs/2026-09-10-bom-template-engine-design.md.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { useBomTemplates, useAluminumFinishes, useBomGlassTypes } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { fmt } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

function FinishForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('aluminum-finish-form', { name: '', price_per_kg: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อสีผิว ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น POWDER COATING SAHARA" />
        </div>
        <div>
          <label className="label">ราคา/กก. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_kg} onChange={e => set('price_per_kg', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

function GlassTypeForm({ initial, onSave, onCancel, loading }) {
  const [form, setForm, clearDraft] = useDraftForm('bom-glass-type-form', { name: '', price_per_sqm: '', active: true, ...initial }, !initial?.id)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อกระจก ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น กระจกใส 10มม." />
        </div>
        <div>
          <label className="label">ราคา/ตร.ม. ★</label>
          <input className="input" required type="number" min="0" step="0.01" value={form.price_per_sqm} onChange={e => set('price_per_sqm', e.target.value)} />
        </div>
        {initial?.id && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function BomTemplates(props) {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'bom_templates')

  const [view, setView] = useState('templates')

  const { data: templates, refetch: refetchTemplates } = useBomTemplates()
  const { data: finishes, refetch: refetchFinishes } = useAluminumFinishes()
  const { data: glassTypes, refetch: refetchGlassTypes } = useBomGlassTypes()

  const [showFinishForm, setShowFinishForm] = useState(false)
  const [editFinish, setEditFinish] = useState(null)
  const [savingFinish, setSavingFinish] = useState(false)
  const [deleteFinishId, setDeleteFinishId] = useState(null)

  const [showGlassForm, setShowGlassForm] = useState(false)
  const [editGlass, setEditGlass] = useState(null)
  const [savingGlass, setSavingGlass] = useState(false)
  const [deleteGlassId, setDeleteGlassId] = useState(null)

  const handleSaveFinish = async (form) => {
    setSavingFinish(true)
    try {
      const payload = { name: form.name, price_per_kg: parseFloat(form.price_per_kg) || 0, active: form.active !== false }
      const { error } = editFinish
        ? await supabase.from('aluminum_finishes').update(payload).eq('id', editFinish.id)
        : await supabase.from('aluminum_finishes').insert(payload)
      if (error) throw error
      setShowFinishForm(false); setEditFinish(null); refetchFinishes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingFinish(false) }
  }

  const handleDeleteFinish = async () => {
    if (!deleteFinishId) return
    const { error } = await supabase.from('aluminum_finishes').delete().eq('id', deleteFinishId)
    if (!error) { setDeleteFinishId(null); refetchFinishes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

  const handleSaveGlass = async (form) => {
    setSavingGlass(true)
    try {
      const payload = { name: form.name, price_per_sqm: parseFloat(form.price_per_sqm) || 0, active: form.active !== false }
      const { error } = editGlass
        ? await supabase.from('bom_glass_types').update(payload).eq('id', editGlass.id)
        : await supabase.from('bom_glass_types').insert(payload)
      if (error) throw error
      setShowGlassForm(false); setEditGlass(null); refetchGlassTypes()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingGlass(false) }
  }

  const handleDeleteGlass = async () => {
    if (!deleteGlassId) return
    const { error } = await supabase.from('bom_glass_types').delete().eq('id', deleteGlassId)
    if (!error) { setDeleteGlassId(null); refetchGlassTypes() }
    else alert('ลบไม่สำเร็จ (อาจมีการใช้งานผูกอยู่): ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
        <button className={`btn btn-sm ${view === 'templates' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('templates')}>🧩 BOM Templates</button>
        <button className={`btn btn-sm ${view === 'finishes' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('finishes')}>🎨 สีผิวอลูมิเนียม</button>
        <button className={`btn btn-sm ${view === 'glass_types' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('glass_types')}>🪟 ชนิดกระจก</button>
      </div>

      {view === 'templates' && (
        <div style={{ color: 'var(--text3)' }}>Task 9 fills this in.</div>
      )}

      {view === 'finishes' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditFinish(null); setShowFinishForm(true) }}>+ เพิ่มสีผิว</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อสีผิว</th><th>ราคา/กก.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(finishes || []).map(f => (
                    <tr key={f.id}>
                      <td style={{ fontWeight: 600 }}>{f.name}</td>
                      <td className="font-mono">{fmt(f.price_per_kg)}</td>
                      <td>{f.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditFinish(f); setShowFinishForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteFinishId(f.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(finishes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีสีผิว</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {view === 'glass_types' && (
        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditGlass(null); setShowGlassForm(true) }}>+ เพิ่มชนิดกระจก</button>}
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr><th>ชื่อกระจก</th><th>ราคา/ตร.ม.</th><th>สถานะ</th><th></th></tr></thead>
                <tbody>
                  {(glassTypes || []).map(g => (
                    <tr key={g.id}>
                      <td style={{ fontWeight: 600 }}>{g.name}</td>
                      <td className="font-mono">{fmt(g.price_per_sqm)}</td>
                      <td>{g.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditGlass(g); setShowGlassForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteGlassId(g.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!(glassTypes || []).length && <tr><td colSpan={4} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีชนิดกระจก</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}

      {showFinishForm && (
        <Modal title={editFinish ? `แก้ไข ${editFinish.name}` : 'เพิ่มสีผิวใหม่'} onClose={() => { setShowFinishForm(false); setEditFinish(null) }} maxWidth={420}>
          <FinishForm initial={editFinish || {}} onSave={handleSaveFinish} onCancel={() => { setShowFinishForm(false); setEditFinish(null) }} loading={savingFinish} />
        </Modal>
      )}
      {deleteFinishId && <ConfirmDialog title="ลบสีผิว" message="ยืนยันการลบ?" onConfirm={handleDeleteFinish} onCancel={() => setDeleteFinishId(null)} />}

      {showGlassForm && (
        <Modal title={editGlass ? `แก้ไข ${editGlass.name}` : 'เพิ่มชนิดกระจกใหม่'} onClose={() => { setShowGlassForm(false); setEditGlass(null) }} maxWidth={420}>
          <GlassTypeForm initial={editGlass || {}} onSave={handleSaveGlass} onCancel={() => { setShowGlassForm(false); setEditGlass(null) }} loading={savingGlass} />
        </Modal>
      )}
      {deleteGlassId && <ConfirmDialog title="ลบชนิดกระจก" message="ยืนยันการลบ?" onConfirm={handleDeleteGlass} onCancel={() => setDeleteGlassId(null)} />}
    </div>
  )
}
