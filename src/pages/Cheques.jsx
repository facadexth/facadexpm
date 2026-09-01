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
import { useCheques, useQuery, useAppSetting } from '../hooks/useSupabase.js'
import { useTenant } from '../hooks/useTenant.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import DocumentReceiptModal from '../components/DocumentReceiptModal.jsx'
import SignLinkModal from '../components/SignLinkModal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import RowActionsMenu from '../components/RowActionsMenu.jsx'
import { THAI_BANKS } from '../lib/thaiBanks.js'

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
          <select className="select" required value={form.bank} onChange={e => set('bank', e.target.value)}>
            <option value="">— เลือกธนาคาร —</option>
            {/* คงค่าที่กรอกไว้แบบข้อความอิสระ (ก่อนเปลี่ยนเป็น dropdown) ไว้เป็นตัวเลือก
                เดิมด้วย ไม่งั้น select จะแสดงว่างเปล่าทั้งที่มีข้อมูลอยู่จริง */}
            {form.bank && !THAI_BANKS.includes(form.bank) && <option value={form.bank}>{form.bank} (เดิม)</option>}
            {THAI_BANKS.map(b => <option key={b} value={b}>{b}</option>)}
          </select>
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
  const { tenant } = useTenant()
  const { data: cheques, refetch } = useCheques()
  // เปิด/ปิดวิธีเซ็นรับแต่ละแบบ -- ตั้งค่าได้ที่หน้าตั้งค่า (Settings.jsx)
  const { data: signPhysicalVal } = useAppSetting('sign_physical_enabled', 'true')
  const { data: signDigitalVal } = useAppSetting('sign_digital_enabled', 'true')
  const signPhysicalEnabled = signPhysicalVal !== 'false'
  const signDigitalEnabled = signDigitalVal !== 'false'
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

  // ใบเซ็นรับล่าสุดต่อเช็ค -- ใช้แสดงลิงก์ "ดูใบเซ็นรับ" และรู้ว่าเช็คใบไหน
  // เซ็นรับไปแล้วบ้าง (document_receipts เป็นตารางกลาง ใช้ document_type='cheque'
  // กรองเอาเฉพาะของเช็ค)
  const { data: receiptRows, refetch: refetchReceipts } = useQuery(async () => {
    const { data, error } = await supabase.from('document_receipts').select('*').eq('document_type', 'cheque').order('signed_at', { ascending: false })
    if (error) throw error
    return data
  })
  const receiptByCheque = (receiptRows || []).reduce((map, r) => {
    if (!map[r.document_id]) map[r.document_id] = r // แถวแรกที่เจอคือล่าสุด (เรียง signed_at DESC ไว้แล้ว)
    return map
  }, {})

  const [signTarget, setSignTarget] = useState(null)
  const [viewReceipt, setViewReceipt] = useState(null)
  const [viewReceiptUrl, setViewReceiptUrl] = useState(null)
  // ลิงก์เซ็นรับระยะไกล -- ไม่ต้องเจอหน้ากัน ส่งลิงก์นี้ผ่านช่องทางไหนก็ได้
  // (LINE, SMS, อีเมล) ผู้รับเปิดเองแล้วเซ็นบนอุปกรณ์ของเขา หมดอายุใน 7 วัน
  // (document_receipt_links.expires_at default) ตัวลิงก์เองไม่ทำอะไรจนกว่า
  // จะมีคนเซ็นจริงผ่าน Edge Function sign-link -- สถานะเช็คยังคงเดิมจนกว่านั้น
  const [linkTarget, setLinkTarget] = useState(null)

  const handleSignSaved = async () => {
    if (signTarget) {
      await supabase.from('cheques').update({ status: 'received' }).eq('id', signTarget.id)
    }
    setSignTarget(null)
    refetch()
    refetchReceipts()
  }

  const openViewReceipt = async (receipt) => {
    setViewReceipt(receipt)
    setViewReceiptUrl(null)
    const { data, error } = await supabase.storage.from('document-receipts').createSignedUrl(receipt.signature_path, 60)
    if (!error) setViewReceiptUrl(data.signedUrl)
  }

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
                const receipt = receiptByCheque[c.id]
                const statusBadge = c.status === 'cashed'
                  ? { cls: 'badge-check_cleared', label: '🏦 ขึ้นเงินแล้ว' }
                  : c.status === 'received'
                    ? { cls: 'badge-received', label: '✍️ รับเช็คแล้ว' }
                    : { cls: 'badge-check_issued', label: '📄 ยังไม่ขึ้นเงิน' }
                return (
                  <tr key={c.id}>
                    <td style={{ fontWeight: 600 }}>{c.cheque_no}</td>
                    <td>{c.bank}</td>
                    <td style={{ fontSize: 12, color: 'var(--text2)' }}>{c.check_date ? new Date(c.check_date).toLocaleDateString('th-TH') : '—'}</td>
                    <td>
                      <span className={`badge ${statusBadge.cls}`}>{statusBadge.label}</span>
                      {receipt && (
                        <div>
                          <button type="button" className="btn btn-ghost btn-sm" style={{ padding: 0, fontSize: 11 }} onClick={() => openViewReceipt(receipt)}>
                            📝 ดูใบเซ็นรับ
                          </button>
                        </div>
                      )}
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
                        <RowActionsMenu items={[
                          ...(c.status !== 'cashed' && signPhysicalEnabled ? [{ label: '🖊️ ให้เซ็นรับ', onClick: () => setSignTarget(c) }] : []),
                          ...(c.status === 'issued' && signDigitalEnabled ? [{ label: '🔗 ลิงก์เซ็นรับ', onClick: () => setLinkTarget(c) }] : []),
                          { label: '✏️ แก้ไข', onClick: () => { setEditCheque(c); setShowForm(true) } },
                          { label: '🗑️ ลบ', onClick: () => setDeleteId(c.id), danger: true },
                        ]} />
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

      {signTarget && (
        <DocumentReceiptModal
          documentType="cheque"
          documentId={signTarget.id}
          tenantId={tenant?.id}
          title={`เซ็นรับเช็ค ${signTarget.cheque_no}`}
          onClose={() => setSignTarget(null)}
          onSaved={handleSignSaved}
        />
      )}

      {viewReceipt && (
        <Modal title="ใบเซ็นรับ" onClose={() => setViewReceipt(null)} maxWidth={420}>
          <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
            <div><span className="label">ผู้รับ</span> {viewReceipt.signer_name}</div>
            {viewReceipt.signer_note && <div><span className="label">หมายเหตุ</span> {viewReceipt.signer_note}</div>}
            <div><span className="label">วันที่เซ็น</span> {new Date(viewReceipt.signed_at).toLocaleString('th-TH')}</div>
            <div><span className="label">บันทึกโดย</span> {viewReceipt.signed_by}</div>
            <div>
              <label className="label">ลายเซ็น</label>
              {viewReceiptUrl
                ? <img src={viewReceiptUrl} alt="ลายเซ็น" style={{ width: '100%', border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }} />
                : <div style={{ color: 'var(--text3)', fontSize: 12 }}>กำลังโหลด...</div>}
            </div>
          </div>
          <div className="modal-footer">
            <button type="button" className="btn btn-ghost" onClick={() => setViewReceipt(null)}>ปิด</button>
          </div>
        </Modal>
      )}

      {linkTarget && (
        <SignLinkModal documentType="cheque" documentId={linkTarget.id} onClose={() => setLinkTarget(null)} />
      )}
    </div>
  )
}
