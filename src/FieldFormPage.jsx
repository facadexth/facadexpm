// FieldFormPage — the page a link like /f/<token> opens to, from the LINE
// crew bot's เบิกของ/ขอลา/เช็คอิน/เช็คเอาท์ Rich Menu buttons. Deliberately
// outside the normal authenticated app shell (see main.jsx) -- no login,
// no session, nothing here ever touches the database directly with the
// anon key. Every read/write goes through the field-form Edge Function,
// which validates the token server-side with the service role (same
// pattern as /sign/<linkId> + PublicSignPage).
//
// เบิกของ picks from real catalog dropdowns (หมวดหมู่ -> รายการ -> จำนวน ->
// ไซต์งาน), not free text -- submitting creates a real purchase_orders
// 'draft' row straight away and pushes a LINE message to admins, who fill
// in the supplier/price later (see field-form's submit handler). ขอลา
// still lands as 'pending' -- an ADMIN/OWNER approves it in HR.jsx.
//
// เช็คอิน/เช็คเอาท์ (2026-09-28) deliberately reads the browser's real GPS
// via navigator.geolocation instead of using a form -- this replaces
// LINE's own native location-share picker, which lets the sender drag
// the pin to any point on the map before sending (confirmed exploitable
// live: a user checked in from ~685m away by moving the shared pin). A
// browser permission prompt has no such manual-placement UI.
import { useState, useEffect, useCallback } from 'react'
import { supabase } from './lib/supabase.js'
import { removeBlockOrClear } from './lib/rowEditing.js'

const REASON_MESSAGES = {
  not_found: 'ไม่พบลิงก์นี้ — อาจพิมพ์ผิดหรือลิงก์ถูกลบไปแล้ว',
  expired: 'ลิงก์นี้หมดอายุแล้ว — กดปุ่มในไลน์อีกครั้งเพื่อขอลิงก์ใหม่',
  used: 'ลิงก์นี้ถูกใช้ไปแล้ว — กดปุ่มในไลน์อีกครั้งถ้าต้องการส่งคำขอใหม่',
  no_site: 'ไม่พบงานที่มอบหมายวันนี้ — กรุณาติดต่อแอดมิน',
  network_error: 'เชื่อมต่อไม่สำเร็จ — เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่ หรือกดปุ่มในไลน์อีกครั้ง',
  line_bot_disabled: 'ฟีเจอร์นี้ไม่ได้เปิดใช้งานสำหรับบริษัทของคุณ — กรุณาติดต่อแอดมิน',
}

// Maps navigator.geolocation's error.code to a clear Thai instruction --
// PERMISSION_DENIED is by far the most common real-world case (worker
// tapped "ไม่อนุญาต" on the browser prompt, or the phone's system-level
// location setting is off).
function geoErrorMessage(err) {
  if (err?.code === 1) return 'คุณไม่ได้อนุญาตให้เว็บนี้ใช้ตำแหน่ง — กรุณาอนุญาต (หรือเปิด GPS ของเครื่อง) แล้วลองใหม่'
  if (err?.code === 2) return 'ไม่สามารถระบุตำแหน่งได้ — ลองออกมานอกอาคารหรือรอสัญญาณ GPS แล้วลองใหม่'
  if (err?.code === 3) return 'ค้นหาตำแหน่งนานเกินไป — กรุณาลองใหม่'
  return 'เกิดข้อผิดพลาดในการขอตำแหน่ง — กรุณาลองใหม่'
}

// เช็คอิน/เช็คเอาท์: no form fields, just request GPS -> submit -> show
// result. `phase`: 'requesting' | 'error' | 'submitting' | 'success' | 'rejected'.
function CheckInFlow({ token, actionType, workerName, siteName }) {
  const [phase, setPhase] = useState('requesting')
  const [message, setMessage] = useState('')
  const [distanceInfo, setDistanceInfo] = useState(null)
  const [openTasks, setOpenTasks] = useState([])

  const requestAndSubmit = useCallback(() => {
    setPhase('requesting')
    if (!navigator.geolocation) {
      setPhase('error')
      setMessage('เบราว์เซอร์นี้ไม่รองรับการขอตำแหน่ง กรุณาใช้เบราว์เซอร์อื่น')
      return
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        setPhase('submitting')
        try {
          const { data, error } = await supabase.functions.invoke('field-form', {
            body: { action: 'submit', token, lat: pos.coords.latitude, lng: pos.coords.longitude },
          })
          if (error) throw error
          if (data?.error) throw new Error(data.error)
          if (data?.ok) {
            setPhase('success')
            setMessage(data.message || '')
            setOpenTasks(data.openTasks || [])
          } else {
            setPhase('rejected')
            setMessage(data?.message || 'อยู่นอกระยะที่กำหนด')
            setDistanceInfo({ distanceM: data?.distanceM, radiusM: data?.radiusM })
          }
        } catch (e) {
          setPhase('error')
          setMessage(e.message)
        }
      },
      (err) => { setPhase('error'); setMessage(geoErrorMessage(err)) },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }, [token])

  useEffect(() => { requestAndSubmit() }, [requestAndSubmit])

  const title = actionType === 'check_in' ? '📍 เช็คอิน' : '📍 เช็คเอาท์'

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 18 }}>
        สวัสดีครับคุณ{workerName} — {siteName}
      </div>

      {(phase === 'requesting' || phase === 'submitting') && (
        <div style={{ textAlign: 'center', padding: '20px 0', color: 'var(--text3)' }}>
          {phase === 'requesting' ? '⏳ กำลังขอตำแหน่งของคุณ... (อนุญาตให้เว็บใช้ตำแหน่งด้วยครับ)' : '⏳ กำลังบันทึก...'}
        </div>
      )}

      {phase === 'success' && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{message}</div>
          {openTasks.length > 0 && (
            <div style={{ textAlign: 'left', fontSize: 13, color: 'var(--text3)', marginTop: 14, border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>🔧 งานของคุณวันนี้</div>
              {openTasks.map((t, i) => <div key={i}>• {t}</div>)}
            </div>
          )}
        </div>
      )}

      {(phase === 'error' || phase === 'rejected') && (
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{message}</div>
          {phase === 'rejected' && distanceInfo?.distanceM != null && (
            <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 12 }}>
              ห่างจากไซท์งาน {Math.round(distanceInfo.distanceM)} เมตร (ต้องอยู่ในระยะ {Math.round(distanceInfo.radiusM)} เมตร)
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={requestAndSubmit}>🔄 ลองอีกครั้ง</button>
        </div>
      )}
    </Shell>
  )
}

const LEAVE_TYPES = [
  { value: 'leave_personal', label: '🏖️ ลากิจ' },
  { value: 'leave_sick', label: '🤒 ลาป่วย' },
]

const LEAVE_SHIFTS = [
  { value: 'full_day', label: 'เต็มวัน' },
  { value: 'morning', label: 'ช่วงเช้า' },
  { value: 'evening', label: 'ช่วงบ่าย' },
]

const MANUAL_ITEM = '__manual__'
let lineSeq = 0
function newLine() {
  return { id: `line-${++lineSeq}`, categoryId: '', itemId: '', itemQuery: '', manualName: '', manualUnit: '', quantity: '' }
}

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

  const [lines, setLines] = useState([newLine()])
  const [siteId, setSiteId] = useState('')

  const [leaveType, setLeaveType] = useState('leave_personal')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [reason, setReason] = useState('')
  const [shift, setShift] = useState('full_day')
  const isSingleDay = !dateTo || dateTo === dateFrom
  // เช้า/บ่าย only makes sense for one day -- switching to a multi-day range
  // resets back to เต็มวัน and hides the picker, same rule field-form itself
  // re-validates server-side (never trusts the client's shift value either).
  const setDateToAndResetShift = (value) => {
    setDateTo(value)
    if (value && value !== dateFrom) setShift('full_day')
  }

  const loadInfo = useCallback(() => {
    setState({ loading: true })
    supabase.functions.invoke('field-form', { body: { action: 'info', token } })
      .then(({ data, error }) => {
        if (error || !data) { setState({ loading: false, reason: 'not_found' }); return }
        if (data.reason) { setState({ loading: false, reason: data.reason }); return }
        setState({ loading: false, ...data })
      })
      .catch(() => {
        // supabase.functions.invoke() rejecting (network/CORS failure, LINE
        // in-app browser quirks) used to leave state.loading stuck at true
        // forever with no error shown -- this is what a user saw as the
        // page hanging on "กำลังโหลด" indefinitely.
        setState({ loading: false, reason: 'network_error' })
      })
  }, [token])

  useEffect(() => { loadInfo() }, [loadInfo])

  const itemsInCategory = (categoryId) => (state.items || []).filter(it => it.categoryId === categoryId)
  const addLine = () => setLines(ls => [...ls, newLine()])
  const removeLine = (id) => setLines(ls => removeBlockOrClear(ls, ls.findIndex(l => l.id === id), 1, newLine))
  const updateLine = (id, patch) => setLines(ls => ls.map(l => (l.id === id ? { ...l, ...patch } : l)))

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setSubmitError(null)
    try {
      const body = state.actionType === 'material_request'
        ? {
            action: 'submit', token, siteId,
            items: lines.map(l => ({
              categoryId: l.categoryId,
              itemId: l.itemId && l.itemId !== MANUAL_ITEM ? l.itemId : null,
              manualName: l.itemId === MANUAL_ITEM ? l.manualName.trim() : null,
              manualUnit: l.itemId === MANUAL_ITEM ? l.manualUnit.trim() : null,
              quantity: Number(l.quantity),
            })),
          }
        : { action: 'submit', token, leaveType, dateFrom, dateTo: dateTo || dateFrom, reason: reason.trim() || null, shift: isSingleDay ? shift : 'full_day' }
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
        {state.reason === 'network_error' && (
          <div style={{ textAlign: 'center' }}>
            <button type="button" className="btn btn-primary" onClick={loadInfo}>🔄 ลองอีกครั้ง</button>
          </div>
        )}
      </Shell>
    )
  }

  if (state.actionType === 'check_in' || state.actionType === 'check_out') {
    return <CheckInFlow token={token} actionType={state.actionType} workerName={state.workerName} siteName={state.siteName} />
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

  const canSubmitMaterial = siteId && lines.length > 0 && lines.every(l => {
    if (!l.categoryId || !(Number(l.quantity) > 0)) return false
    if (l.itemId === MANUAL_ITEM) return l.manualName.trim() && l.manualUnit.trim()
    return !!l.itemId
  })

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>
        {state.actionType === 'material_request' ? '📦 ขอเบิกของ' : '🏖️ ขอลา'}
      </div>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 18 }}>สวัสดีครับคุณ{state.workerName}</div>

      <form onSubmit={submit} style={{ display: 'grid', gap: 14 }}>
        {state.actionType === 'material_request' ? (
          <>
            {lines.map((line, idx) => {
              const items = itemsInCategory(line.categoryId)
              const isManual = line.itemId === MANUAL_ITEM
              const selectedItem = items.find(it => it.id === line.itemId)
              const unit = selectedItem?.unit || (isManual ? line.manualUnit : '')
              return (
                <div key={line.id} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: 12, display: 'grid', gap: 10, position: 'relative' }}>
                  {lines.length > 1 ? (
                    <button type="button" onClick={() => removeLine(line.id)} aria-label="ลบรายการนี้"
                      style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', color: 'var(--text3)', fontSize: 16, cursor: 'pointer', lineHeight: 1, padding: 4 }}>✕</button>
                  ) : (
                    <button type="button" onClick={() => removeLine(line.id)}
                      style={{ position: 'absolute', top: 8, right: 8, background: 'none', border: 'none', color: 'var(--text3)', fontSize: 12, cursor: 'pointer', lineHeight: 1, padding: 4 }}>ลบข้อมูลทั้งหมด</button>
                  )}
                  <div style={{ fontSize: 12, fontWeight: 700, color: 'var(--text3)' }}>รายการที่ {idx + 1}</div>
                  <div>
                    <label className="label">หมวดหมู่ *</label>
                    <select className="select" required value={line.categoryId}
                      onChange={e => updateLine(line.id, { categoryId: e.target.value, itemId: '', itemQuery: '', manualName: '', manualUnit: '' })}>
                      <option value="">-- เลือกหมวดหมู่ --</option>
                      {(state.categories || []).map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">รายการ *</label>
                    {isManual ? (
                      <div style={{ display: 'grid', gridTemplateColumns: '2fr 1fr', gap: 10 }}>
                        <div>
                          <label className="label">ชื่อสินค้า *</label>
                          <input className="input" required value={line.manualName} onChange={e => updateLine(line.id, { manualName: e.target.value })} placeholder="เช่น ปูนซีเมนต์ตราเสือ" />
                        </div>
                        <div>
                          <label className="label">หน่วย *</label>
                          <input className="input" required value={line.manualUnit} onChange={e => updateLine(line.id, { manualUnit: e.target.value })} placeholder="เช่น ถุง" />
                        </div>
                        <button type="button" className="btn btn-ghost btn-sm" style={{ gridColumn: '1 / -1', justifySelf: 'start' }}
                          onClick={() => updateLine(line.id, { itemId: '', manualName: '', manualUnit: '' })}>← กลับไปค้นหารายการเดิม</button>
                      </div>
                    ) : selectedItem ? (
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', border: '1px solid var(--border)', borderRadius: 8, padding: '9px 12px' }}>
                        <span>{selectedItem.name} <span style={{ color: 'var(--text3)', fontSize: 12.5 }}>({selectedItem.unit})</span></span>
                        <button type="button" className="btn btn-ghost btn-sm" onClick={() => updateLine(line.id, { itemId: '', itemQuery: '' })}>เปลี่ยน</button>
                      </div>
                    ) : (
                      <>
                        <div style={{ display: 'flex', gap: 8 }}>
                          <input className="input" style={{ flex: 1 }} disabled={!line.categoryId} placeholder="พิมพ์ค้นหารายการ..."
                            value={line.itemQuery} onChange={e => updateLine(line.id, { itemQuery: e.target.value })} />
                          <button type="button" className="btn btn-ghost btn-sm" disabled={!line.categoryId} style={{ whiteSpace: 'nowrap' }}
                            onClick={() => updateLine(line.id, { itemId: MANUAL_ITEM, itemQuery: '' })}>➕ ใหม่</button>
                        </div>
                        {line.categoryId && (() => {
                          const q = line.itemQuery.trim().toLowerCase()
                          const filtered = q ? items.filter(it => it.name.toLowerCase().includes(q)) : items
                          return (
                            <div style={{ maxHeight: 180, overflowY: 'auto', border: '1px solid var(--border)', borderRadius: 8, marginTop: 6 }}>
                              {filtered.length === 0 ? (
                                <div style={{ padding: '10px 12px', fontSize: 12.5, color: 'var(--text3)' }}>ไม่พบรายการนี้ — กด "➕ ใหม่" เพื่อเพิ่มสินค้าใหม่</div>
                              ) : filtered.map((it, i) => (
                                <div key={it.id} onClick={() => updateLine(line.id, { itemId: it.id, itemQuery: '' })}
                                  style={{ padding: '9px 12px', cursor: 'pointer', borderTop: i > 0 ? '1px solid var(--border)' : 'none' }}>
                                  {it.name} <span style={{ color: 'var(--text3)', fontSize: 12 }}>({it.unit})</span>
                                </div>
                              ))}
                            </div>
                          )
                        })()}
                      </>
                    )}
                  </div>
                  <div>
                    <label className="label">จำนวน {unit ? `(${unit})` : ''} *</label>
                    <input className="input num-spin" type="number" required min="0" step="any" value={line.quantity} onChange={e => updateLine(line.id, { quantity: e.target.value })} />
                  </div>
                </div>
              )
            })}
            <button type="button" className="btn btn-ghost btn-sm" onClick={addLine} style={{ justifySelf: 'start' }}>+ เพิ่มรายการ</button>
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
            {(state.remainingPersonal != null || state.remainingSick != null) && (
              <div style={{ display: 'flex', gap: 10 }}>
                <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>ลากิจคงเหลือ</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: state.remainingPersonal < 0 ? 'var(--red)' : 'var(--text)' }}>{state.remainingPersonal} วัน</div>
                </div>
                <div style={{ flex: 1, border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', textAlign: 'center' }}>
                  <div style={{ fontSize: 11, color: 'var(--text3)' }}>ลาป่วยคงเหลือ</div>
                  <div style={{ fontSize: 18, fontWeight: 700, color: state.remainingSick < 0 ? 'var(--red)' : 'var(--text)' }}>{state.remainingSick} วัน</div>
                </div>
              </div>
            )}
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
                <input className="input" type="date" value={dateTo} min={dateFrom || undefined} onChange={e => setDateToAndResetShift(e.target.value)} placeholder="เว้นว่างถ้าลาวันเดียว" />
              </div>
            </div>
            {isSingleDay && (
              <div>
                <label className="label">ช่วงเวลา *</label>
                <div style={{ display: 'flex', gap: 8 }}>
                  {LEAVE_SHIFTS.map(s => (
                    <button key={s.value} type="button"
                      className={shift === s.value ? 'btn btn-primary btn-sm' : 'btn btn-ghost btn-sm'}
                      style={{ flex: 1 }} onClick={() => setShift(s.value)}>{s.label}</button>
                  ))}
                </div>
              </div>
            )}
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
