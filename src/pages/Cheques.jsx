// ============================================================
// Cheques — เช็ค
// ✅ Add/Edit/Delete cheques (เลขที่เช็ค, ธนาคาร)
// ✅ Mark a cheque cashed -- cascades to every linked expense still in
//    check_issued, flipping them to check_cleared in one go (DB trigger
//    cheque_cascade_status, see supabase/schema.sql)
// ✅ Shows total amount + expense count linked to each cheque
// ============================================================
import { useState } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import { useCheques, useQuery } from '../hooks/useSupabase.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { TrashIcon, PencilIcon } from '../components/icons.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'

const EMPTY_FORM = { cheque_no: '', bank: '', check_date: '', notes: '' }

function ChequeForm({ initial = EMPTY_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('cheque-form', { ...EMPTY_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))
  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 14 }}>
        <div>
          <label className="label">เลขที่เช็ค ★</label>
          <input className="input" required value={form.cheque_no} onChange={e => set('cheque_no', e.target.value)} placeholder="เช่น 0012345" />
        </div>
        <div>
          <label className="label">ธนาคารที่ออกเช็ค ★</label>
          <input className="input" required value={form.bank} onChange={e => set('bank', e.target.value)} placeholder="เช่น กสิกรไทย, ไทยพาณิชย์" />
        </div>
        <div>
          <label className="label">วันที่เช็ค ★</label>
          <input type="date" className="input" required value={form.check_date} onChange={e => set('check_date', e.target.value)} />
          {!isAdd && (
            <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 2 }}>
              แก้ไขวันที่นี้จะอัปเดตทุกรายจ่ายที่ผูกกับเช็คใบนี้ให้ตรงกันโดยอัตโนมัติ
            </div>
          )}
        </div>
        <div>
          <label className="label">หมายเหตุ</label>
          <input className="input" value={form.notes} onChange={e => set('notes', e.target.value)} />
        </div>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>{loading ? '⏳...' : '✅ บันทึก'}</button>
      </div>
    </form>
  )
}

export default function Cheques() {
  const { data: cheques, refetch } = useCheques()
  // Linked-expense totals per cheque -- a lightweight aggregate query
  // rather than a dedicated view, since it's only ever needed here.
  const { data: linkRows } = useQuery(async () => {
    const { data, error } = await supabase.from('expenses').select('cheque_id, amount').not('cheque_id', 'is', null)
    if (error) throw error
    return data
  })
  const totalsByCheque = (linkRows || []).reduce((map, r) => {
    const t = map[r.cheque_id] || { total: 0, count: 0 }
    t.total += r.amount || 0
    t.count += 1
    map[r.cheque_id] = t
    return map
  }, {})

  const [showForm, setShowForm] = useState(false)
  const [editCheque, setEditCheque] = useState(null)
  const [deleteId, setDeleteId] = useState(null)
  const [cashId, setCashId] = useState(null)
  const [saving, setSaving] = useState(false)

  const handleSave = async (form) => {
    setSaving(true)
    try {
      const payload = { cheque_no: form.cheque_no, bank: form.bank, check_date: form.check_date || null, notes: form.notes || null }
      if (editCheque) {
        const { error } = await supabase.from('cheques').update(payload).eq('id', editCheque.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('cheques').insert(payload)
        if (error) throw error
      }
      setShowForm(false); setEditCheque(null); refetch()
    } catch (e) { alert('Error: ' + e.message) }
    finally { setSaving(false) }
  }

  const handleDelete = async () => {
    if (!deleteId) return
    const { error } = await supabase.from('cheques').delete().eq('id', deleteId)
    if (!error) { setDeleteId(null); refetch() }
    else alert('ลบไม่ได้: ' + error.message)
  }

  const handleMarkCashed = async () => {
    if (!cashId) return
    const { error } = await supabase.from('cheques')
      .update({ status: 'cashed', cashed_at: new Date().toISOString() })
      .eq('id', cashId)
    if (!error) { setCashId(null); refetch() }
    else alert('Error: ' + error.message)
  }

  return (
    <div>
      <div style={{ display: 'flex', gap: 10, marginBottom: 20 }}>
        <button className="btn btn-primary" onClick={() => { setEditCheque(null); setShowForm(true) }}>+ เพิ่มเช็ค</button>
      </div>

      <div className="card">
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>เลขที่เช็ค</th><th>ธนาคาร</th><th>วันที่เช็ค</th><th>สถานะ</th>
                <th>ยอดรวม (รายจ่ายที่ผูกไว้)</th><th>วันที่ขึ้นเงิน</th><th></th>
              </tr>
            </thead>
            <tbody>
              {(cheques || []).map(c => {
                const t = totalsByCheque[c.id]
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.cheque_no}</td>
                    <td>{c.bank}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{c.check_date ? new Date(c.check_date).toLocaleDateString('th-TH') : '—'}</td>
                    <td>
                      <span className={`badge ${c.status === 'cashed' ? 'badge-check_cleared' : 'badge-check_issued'}`}>
                        {c.status === 'cashed' ? '🏦 ขึ้นเงินแล้ว' : '📄 ยังไม่ขึ้นเงิน'}
                      </span>
                    </td>
                    <td className="font-mono">
                      {t ? `${fmt(t.total)} บาท (${t.count} รายการ)` : <span style={{ color: 'var(--text3)' }}>— ยังไม่ผูกรายจ่าย</span>}
                    </td>
                    <td style={{ fontSize: 12, color: 'var(--text3)' }}>
                      {c.cashed_at ? new Date(c.cashed_at).toLocaleDateString('th-TH') : '—'}
                    </td>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <div className="actions-cell">
                        {c.status !== 'cashed' && (
                          <button className="btn btn-sm btn-success" onClick={() => setCashId(c.id)}>✅ ขึ้นเงินแล้ว</button>
                        )}
                        <button className="btn btn-sm btn-edit" onClick={() => { setEditCheque(c); setShowForm(true) }}><PencilIcon /></button>
                        <button className="btn btn-sm btn-danger" onClick={() => setDeleteId(c.id)}><TrashIcon /></button>
                      </div>
                    </td>
                  </tr>
                )
              })}
              {!(cheques || []).length && (
                <tr><td colSpan={7} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>ยังไม่มีเช็ค</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {showForm && (
        <Modal title={editCheque ? 'แก้ไขเช็ค' : 'เพิ่มเช็คใหม่'} onClose={() => { setShowForm(false); setEditCheque(null) }} maxWidth={420}>
          <ChequeForm initial={editCheque || EMPTY_FORM} onSave={handleSave} onCancel={() => { setShowForm(false); setEditCheque(null) }} loading={saving} />
        </Modal>
      )}

      {deleteId && (
        <ConfirmDialog title="ลบเช็ค" message="ยืนยันการลบเช็คนี้? รายจ่ายที่ผูกไว้จะไม่ถูกลบ แต่จะไม่มีเช็คผูกอยู่อีกต่อไป" onConfirm={handleDelete} onCancel={() => setDeleteId(null)} danger />
      )}

      {cashId && (
        <ConfirmDialog
          title="ยืนยันเช็คขึ้นเงินแล้ว"
          message="รายจ่ายทั้งหมดที่ยังค้างอยู่ (ออกเช็ค) และผูกกับเช็คนี้ จะถูกเปลี่ยนสถานะเป็น 'เช็คผ่าน' โดยอัตโนมัติ"
          onConfirm={handleMarkCashed}
          onCancel={() => setCashId(null)}
        />
      )}
    </div>
  )
}
