// src/components/CatalogCrud.jsx
// ============================================================
// Generic list + add/edit/delete modal for one flat catalog table. The
// aluminium catalog tabs are mostly configuration of this component.
// Pure form logic lives in lib/catalogForm.js (tested); this file is the
// view, in the same style as AluminumProfiles.jsx.
// ============================================================
import { useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal, ConfirmDialog } from './Modal.jsx'
import { emptyForm, formFromRow, buildPayload, missingRequired, resolveOptions, friendlyDbError } from '../lib/catalogForm.js'

export function ActiveBadge({ active }) {
  return active
    ? <span className="badge badge-paid">ใช้งานอยู่</span>
    : <span className="badge badge-finished">ปิดใช้งาน</span>
}

export function CrudForm({ fields, initial, onSave, onCancel, loading }) {
  const [form, setForm] = useState(initial)
  // a field may declare clears: [keys] -- dependent fields reset when it changes
  const set = (k, v) => setForm(f => {
    const next = { ...f, [k]: v }
    const clears = fields.find(x => x.key === k)?.clears || []
    for (const c of clears) next[c] = ''
    return next
  })

  const renderInput = (f) => {
    if (f.type === 'checkbox') {
      return (
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
          <input type="checkbox" checked={!!form[f.key]} onChange={e => set(f.key, e.target.checked)} />
          {f.label}
        </label>
      )
    }
    if (f.type === 'select') {
      return (
        <select className="input" required={f.required} value={form[f.key]} onChange={e => set(f.key, e.target.value)}>
          <option value="">{f.required ? '— เลือก —' : '—'}</option>
          {resolveOptions(f, form).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      )
    }
    return (
      <input
        className="input" required={f.required}
        type={f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'}
        step={f.type === 'number' ? (f.step || 'any') : undefined} min={f.min}
        placeholder={f.placeholder} value={form[f.key]} onChange={e => set(f.key, e.target.value)}
      />
    )
  }

  return (
    <form onSubmit={e => { e.preventDefault(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {fields.map(f => (
          <div key={f.key}>
            {f.type !== 'checkbox' && <label className="label">{f.label}{f.required ? ' ★' : ''}</label>}
            {renderInput(f)}
            {f.hint && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>{f.hint}</div>}
          </div>
        ))}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function CatalogCrud({
  title, table, fields, columns, rows, onChanged, canEdit,
  scope = {}, addLabel = '+ เพิ่ม', emptyText = 'ยังไม่มีข้อมูล', validate, rowActions, allowEdit = true,
}) {
  const [editing, setEditing] = useState(null)   // null | 'new' | row
  const [deleteId, setDeleteId] = useState(null)
  const [saving, setSaving] = useState(false)

  const close = () => setEditing(null)

  const handleSave = async (form) => {
    const missing = missingRequired(fields, form)
    if (missing.length) { alert('กรุณากรอก: ' + missing.join(', ')); return }
    const problem = validate ? validate(form) : null
    if (problem) { alert(problem); return }
    setSaving(true)
    try {
      const payload = buildPayload(fields, form)
      if (editing === 'new') {
        const { error } = await supabase.from(table).insert({ ...payload, ...scope })
        if (error) throw error
      } else {
        const { error } = await supabase.from(table).update(payload).eq('id', editing.id)
        if (error) throw error
      }
      close(); onChanged()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(e)) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    const { error } = await supabase.from(table).delete().eq('id', deleteId)
    if (error) { alert('ลบไม่สำเร็จ: ' + friendlyDbError(error)); return }
    setDeleteId(null); onChanged()
  }

  return (
    <div style={{ marginBottom: 24 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
        <h3 style={{ margin: 0, fontSize: 15 }}>{title}</h3>
        {canEdit && <button className="btn btn-sm btn-primary" onClick={() => setEditing('new')}>{addLabel}</button>}
      </div>
      <div className="card">
        <div className="table-wrap">
          <table>
            <thead><tr>{columns.map(c => <th key={c.key}>{c.label}</th>)}<th></th></tr></thead>
            <tbody>
              {(rows || []).map(row => (
                <tr key={row.id}>
                  {columns.map(c => <td key={c.key}>{c.render ? c.render(row) : (row[c.key] ?? '—')}</td>)}
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {rowActions && rowActions(row)}
                    {canEdit && (
                      <>
                        {allowEdit && <button className="btn btn-sm btn-ghost" onClick={() => setEditing(row)}>แก้ไข</button>}
                        <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteId(row.id)}>ลบ</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
              {!(rows || []).length && <tr><td colSpan={columns.length + 1} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>{rows == null ? 'กำลังโหลด...' : emptyText}</td></tr>}
            </tbody>
          </table>
        </div>
      </div>

      {editing && (
        <Modal title={editing === 'new' ? `${addLabel.replace('+ ', '')}` : 'แก้ไขข้อมูล'} onClose={close} maxWidth={480}>
          <CrudForm
            fields={fields} loading={saving} onSave={handleSave} onCancel={close}
            initial={editing === 'new' ? emptyForm(fields, scope) : formFromRow(fields, editing)}
          />
        </Modal>
      )}
      {deleteId && (
        <ConfirmDialog title="ลบข้อมูล" message="ยืนยันการลบ? (ถ้ามีข้อมูลอื่นผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} />
      )}
    </div>
  )
}
