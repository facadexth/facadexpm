// FieldFormPage — the page a link like /f/<token> opens to, from the LINE
// crew bot's เบิกของ/ขอลา Rich Menu buttons. Deliberately outside the
// normal authenticated app shell (see main.jsx) -- no login, no session,
// nothing here ever touches the database directly with the anon key.
// Every read/write goes through the field-form Edge Function, which
// validates the token server-side with the service role (same pattern as
// /sign/<linkId> + PublicSignPage).
//
// เบิกของ picks from real catalog dropdowns (หมวดหมู่ -> รายการ -> จำนวน ->
// ไซต์งาน), not free text -- submitting creates a real purchase_orders
// 'draft' row straight away and pushes a LINE message to admins, who fill
// in the supplier/price later (see field-form's submit handler). ขอลา
// still lands as 'pending' -- an ADMIN/OWNER approves it in HR.jsx.
import { useState, useEffect, useMemo } from 'react'
import { supabase } from './lib/supabase.js'

const REASON_MESSAGES = {
  not_found: 'ไม่พบลิงก์นี้ — อาจพิมพ์ผิดหรือลิงก์ถูกลบไปแล้ว',
  expired: 'ลิงก์นี้หมดอายุแล้ว — กดปุ่มในไลน์อีกครั้งเพื่อขอลิงก์ใหม่',
  used: 'ลิงก์นี้ถูกใช้ไปแล้ว — กดปุ่มในไลน์อีกครั้งถ้าต้องการส่งคำขอใหม่',
}

const LEAVE_TYPES = [
  { value: 'leave_personal', label: '🏖️ ลากิจ' },
  { value: 'leave_sick', label: '🤒 ลาป่วย' },
]

function Shell({ children }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: 420, width: '100%', padding: '28px 24px', marginTop: 20 }}>
        {children}
      </div>
    </div>
  )
}

export default function FieldFormPage({ token }) {
  const [state, setState] = useState({ loading: true })
  const [submitting, setSubmitting] = useState(false)
  const [submitted, setSubmitted] = useState(false)
  const [submitError, setSubmitError] = useState(null)

  const [categoryId, setCategoryId] = useState('')
  const [itemId, setItemId] = useState('')
  const [quantity, setQuantity] = useState('')
  const [siteId, setSiteId] = useState('')

  const [leaveType, setLeaveType] = useState('leave_personal')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [reason, setReason] = useState('')

  useEffect(() => {
    supabase.functions.invoke('field-form', { body: { action: 'info', token } })
      .then(({ data, error }) => {
        if (error || !data) { setState({ loading: false, reason: 'not_found' }); return }
        if (data.reason) { setState({ loading: false, reason: data.reason }); return }
        setState({ loading: false, ...data })
      })
  }, [token])

  const itemsInCategory = useMemo(
    () => (state.items || []).filter(it => it.categoryId === categoryId),
    [state.items, categoryId]
  )
  const selectedItem = useMemo(() => (state.items || []).find(it => it.id === itemId), [state.items, itemId])

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      const body = state.actionType === 'material_request'
        ? { action: 'submit', token, itemId, quantity, siteId }
        : { action: 'submit', token, leaveType, dateFrom, dateTo: dateTo || dateFrom, reason: reason.trim() || null }
      const { data, error } = await supabase.functions.invoke('field-form', { body })
      if (error) throw error
      if (data?.reason) { setState(s => ({ ...s, reason: data.reason })); return }
      if (data?.error) throw new Error(data.error)
      setSubmitted(true)
    } catch (e) {
      setSubmitError(e.message)
    } finally {
      setSubmitting(false)
    }
  }

  if (state.loading) return <Shell><div style={{ textAlign: 'center', color: 'var(--text3)' }}>กำลังโหลด...</div></Shell>

  if (state.reason) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', color: 'var(--text3)', padding: '20px 0' }}>
          {REASON_MESSAGES[state.reason] || 'เกิดข้อผิดพลาด กรุณาลองใหม่'}
        </div>
      </Shell>
    )
  }

  if (submitted) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>ส่งคำขอแล้ว</div>
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>
            {state.actionType === 'material_request' ? 'สร้างใบสั่งซื้อร่างไว้ให้แล้ว แอดมินจะเลือกซัพพลายเออร์และราคาต่อ' : 'รอแอดมิน/เจ้าของตรวจสอบและอนุมัติ'}
          </div>
        </div>
      </Shell>
    )
  }

  const canSubmitMaterial = itemId && siteId && Number(quantity) > 0

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
        {state.actionType === 'material_request' ? '📦 ขอเบิกของ' : '🏖️ ขอลา'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 18 }}>สวัสดีครับคุณ{state.workerName}</div>

      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        {state.actionType === 'material_request' ? (
          <>
            <div>
              <label className="label">หมวดหมู่ *</label>
              <select className="select" required value={categoryId} onChange={e => { setCategoryId(e.target.value); setItemId('') }}>
                <option value="">-- เลือกหมวดหมู่ --</option>
                {(state.categories || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">รายการ *</label>
              <select className="select" required disabled={!categoryId} value={itemId} onChange={e => setItemId(e.target.value)}>
                <option value="">-- เลือกรายการ --</option>
                {itemsInCategory.map(it => <option key={it.id} value={it.id}>{it.name}</option>)}
              </select>
            </div>
            <div>
              <label className="label">จำนวน {selectedItem ? `(${selectedItem.unit})` : ''} *</label>
              <input className="input" type="number" required min="0" step="any" value={quantity} onChange={e => setQuantity(e.target.value)} />
            </div>
            <div>
              <label className="label">ไซต์งาน *</label>
              <select className="select" required value={siteId} onChange={e => setSiteId(e.target.value)}>
                <option value="">-- เลือกไซต์งาน --</option>
                {(state.sites || []).map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </div>
          </>
        ) : (
          <>
            <div>
              <label className="label">ประเภทการลา *</label>
              <select className="select" required value={leaveType} onChange={e => setLeaveType(e.target.value)}>
                {LEAVE_TYPES.map(t => <option key={t.value} value={t.value}>{t.label}</option>)}
              </select>
            </div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label className="label">ตั้งแต่วันที่ *</label>
                <input className="input" type="date" required value={dateFrom} onChange={e => setDateFrom(e.target.value)} />
              </div>
              <div>
                <label className="label">ถึงวันที่</label>
                <input className="input" type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateTo(e.target.value)} placeholder="เว้นว่างถ้าลาวันเดียว" />
              </div>
            </div>
            <div>
              <label className="label">เหตุผล (ถ้ามี)</label>
              <textarea className="input" rows={2} value={reason} onChange={e => setReason(e.target.value)} />
            </div>
          </>
        )}

        {submitError && <div className="alert alert-error" style={{ fontSize: 12.5 }}>{submitError}</div>}

        <button type="submit" className="btn btn-primary" disabled={submitting || (state.actionType === 'material_request' && !canSubmitMaterial)}>
          {submitting ? '⏳ กำลังส่ง...' : '✅ ส่งคำขอ'}
        </button>
      </form>
    </Shell>
  )
}
