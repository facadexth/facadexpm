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
import { useState, useEffect, useCallback, useRef } from 'react'
import { supabase, fmt } from './lib/supabase.js'
import { PayslipSheetView } from './pages/hr/Payslip.jsx'
import { downloadPDF } from './lib/pdf.js'
import { MONTHS_TH } from './lib/payroll/period.js'
import { removeBlockOrClear } from './lib/rowEditing.js'
import { parseAdvanceAmount } from './lib/payroll/advanceRules.js'
import { checkinPageLabels } from './lib/checkinLabels.js'

const REASON_MESSAGES = {
  not_found: 'ไม่พบลิงก์นี้ — อาจพิมพ์ผิดหรือลิงก์ถูกลบไปแล้ว',
  expired: 'ลิงก์นี้หมดอายุแล้ว — กดปุ่มในไลน์อีกครั้งเพื่อขอลิงก์ใหม่',
  used: 'ลิงก์นี้ถูกใช้ไปแล้ว — กดปุ่มในไลน์อีกครั้งถ้าต้องการส่งคำขอใหม่',
  no_site: 'ไม่พบงานที่มอบหมายวันนี้ — กรุณาติดต่อแอดมิน',
  network_error: 'เชื่อมต่อไม่สำเร็จ — เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่ หรือกดปุ่มในไลน์อีกครั้ง',
  payroll_disabled: 'ยังขอเบิกเงินผ่านไลน์ไม่ได้ กรุณาติดต่อเจ้าของบริษัท',
  payslip_disabled: 'ยังขอสลิปผ่าน LINE ไม่ได้ ติดต่อแอดมินครับ',
  line_bot_disabled: 'ฟีเจอร์นี้ไม่ได้เปิดใช้งานสำหรับบริษัทของคุณ — กรุณาติดต่อแอดมิน',
}

// Never show a non-Thai (raw server/network) message to a worker.
export function thaiOr(msg, fallback) {
  return typeof msg === 'string' && /[\u0E00-\u0E7F]/.test(msg) ? msg : fallback
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
function CheckInFlow({ token, actionType, workerName, siteName, placeKind }) {
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

  // A fixed-location link (office admin, no site today) says the place in the title.
  const labels = checkinPageLabels({ actionType, workerName, siteName, placeKind })

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>{labels.title}</div>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 18 }}>
        {labels.subtitle}
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
              {labels.farFrom} {Math.round(distanceInfo.distanceM)} เมตร (ต้องอยู่ในระยะ {Math.round(distanceInfo.radiusM)} เมตร)
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={requestAndSubmit}>🔄 ลองอีกครั้ง</button>
        </div>
      )}
    </Shell>
  )
}

// Assembly day (2026-10-21, รวมพลที่บริษัท/โรงงานก่อน): ONE link, the page shows the step the
// day's order says comes next -- big -- and records it from the phone's GPS. field-form picks the
// actual step server-side (it may record "ถึงไซท์" if the worker forgot to tap at the factory).
const STEP_COLORS = { assembly_leave: '#B45309', site_arrive: '#1D4ED8', site_leave: '#0F766E', assembly_return: '#7C3AED' }

function TimeClockFlow({ token, workerName, next, steps }) {
  const [phase, setPhase] = useState('ready') // ready | requesting | submitting | success | rejected | error
  const [message, setMessage] = useState('')
  const [distanceInfo, setDistanceInfo] = useState(null)
  const [openTasks, setOpenTasks] = useState([])
  const [doneKey, setDoneKey] = useState(null)
  const [hint, setHint] = useState('')

  const record = useCallback(() => {
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
            setHint(data.hint || '')
            setDoneKey(data.step ? `${data.step.kind}|${data.step.siteId ?? ''}` : null)
          } else {
            setPhase('rejected')
            setMessage(data?.message || 'อยู่นอกระยะที่กำหนด')
            setDistanceInfo({ distanceM: data?.distanceM, radiusM: data?.radiusM })
          }
        } catch (e) {
          setPhase('error')
          setMessage(thaiOr(e.message, 'บันทึกไม่สำเร็จ กรุณาลองใหม่'))
        }
      },
      (err) => { setPhase('error'); setMessage(geoErrorMessage(err)) },
      { enableHighAccuracy: true, timeout: 15000, maximumAge: 0 },
    )
  }, [token])

  const isDone = (st) => st.done || doneKey === `${st.kind}|${st.siteId ?? ''}`
  const color = next ? STEP_COLORS[next.kind] : 'var(--green)'

  return (
    <Shell>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 10 }}>สวัสดีครับคุณ{workerName}</div>
      {!next ? (
        <div style={{ textAlign: 'center', padding: '16px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700 }}>วันนี้บันทึกครบทุกจุดแล้ว</div>
        </div>
      ) : (
        <div style={{ background: color, color: '#fff', borderRadius: 12, padding: 14, marginBottom: 12 }}>
          <div style={{ fontSize: 12, opacity: 0.9 }}>ขั้นต่อไป</div>
          <h2 style={{ fontSize: 22, fontWeight: 800, margin: '2px 0' }}><span aria-hidden="true">{next.emoji} </span>{next.title}</h2>
          <div style={{ fontSize: 13, opacity: 0.95 }}>📍 {next.place}</div>
        </div>
      )}

      {next && phase === 'ready' && (
        <button type="button" className="btn btn-primary" style={{ width: '100%', height: 48, fontSize: 16, fontWeight: 700 }} onClick={record}>
          บันทึก {next.title}
        </button>
      )}
      {next?.kind === 'assembly_leave' && phase === 'ready' && (steps || []).some(st => st.kind === 'site_arrive') && (
        <div style={{ fontSize: 13, color: 'var(--text3)', textAlign: 'center', marginTop: 8 }}>
          ลืมกดตอนออกจาก{next.place}? อยู่ที่{(steps.find(st => st.kind === 'site_arrive') || {}).place}แล้วกดได้เลย ระบบบันทึก "ถึง" ให้
        </div>
      )}
      {(phase === 'requesting' || phase === 'submitting') && (
        <div style={{ textAlign: 'center', padding: '12px 0', color: 'var(--text3)' }}>
          {phase === 'requesting' ? '⏳ กำลังขอตำแหน่งของคุณ... (อนุญาตให้เว็บใช้ตำแหน่งด้วยครับ)' : '⏳ กำลังบันทึก...'}
        </div>
      )}
      {phase === 'success' && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 6 }}>✅</div>
          <div style={{ fontWeight: 700 }}>{message}</div>
          {hint && (
            <div style={{ marginTop: 12, background: '#1D4ED8', color: '#fff', borderRadius: 12, padding: 14, fontSize: 17, fontWeight: 800, whiteSpace: 'pre-line' }}>👉 {hint}</div>
          )}
          {openTasks.length > 0 && (
            <div style={{ textAlign: 'left', fontSize: 13, color: 'var(--text3)', marginTop: 12, border: '1px solid var(--border)', borderRadius: 10, padding: 12 }}>
              <div style={{ fontWeight: 700, marginBottom: 6 }}>🔧 งานของคุณวันนี้</div>
              {openTasks.map((t, i) => <div key={i}>• {t}</div>)}
            </div>
          )}
          <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 8 }}>ขั้นต่อไป กดปุ่มเช็คอินในไลน์อีกครั้ง</div>
        </div>
      )}
      {(phase === 'error' || phase === 'rejected') && (
        <div style={{ textAlign: 'center', padding: '12px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 6 }}>⚠️</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>{message}</div>
          {phase === 'rejected' && distanceInfo?.distanceM != null && (
            <div style={{ fontSize: 12.5, color: 'var(--text3)', marginBottom: 10 }}>
              อยู่นอกพื้นที่ (ห่าง {Math.round(distanceInfo.distanceM)} เมตร ต้องอยู่ในระยะ {Math.round(distanceInfo.radiusM)} เมตร)
            </div>
          )}
          <button type="button" className="btn btn-primary" onClick={record}>🔄 ลองอีกครั้ง</button>
        </div>
      )}

      <div style={{ marginTop: 16, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>ลำดับวันนี้</div>
        {(steps || []).map((st, i) => (
          <div key={i} style={{ display: 'flex', gap: 8, fontSize: 13, padding: '3px 0', color: isDone(st) ? 'var(--text3)' : 'var(--text)' }}>
            <span>{isDone(st) ? '✅' : st.emoji}</span>
            <span>{st.title}</span>
            {(st.kind === 'site_arrive' || st.kind === 'site_leave') && <span style={{ color: 'var(--text3)' }}>· {st.place}</span>}
          </div>
        ))}
      </div>
    </Shell>
  )
}

const SHEET_W = 794
const SHEET_H = 559

// สลิปเงินเดือน: list of closed months -> tap one -> A5 slip + save as PDF.
// The 794px sheet is scaled down with a CSS transform to fit a phone; the
// scale is dropped to 1 while html2pdf captures it so the PDF stays full size.
function PayslipFlow({ token, workerName, months }) {
  const [slip, setSlip] = useState(null) // { year, month, data }
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [fit, setFit] = useState(true)
  const [width, setWidth] = useState(typeof window !== 'undefined' ? window.innerWidth : SHEET_W)
  const boxRef = useRef(null)

  useEffect(() => {
    const el = boxRef.current
    if (!el) return undefined
    const measure = () => {
      const w = el.getBoundingClientRect().width || el.clientWidth
      setWidth(w || (typeof window !== 'undefined' ? window.innerWidth : SHEET_W))
    }
    measure()
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', measure)
      return () => window.removeEventListener('resize', measure)
    }
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [slip])

  const openMonth = async (m) => {
    if (loading) return
    setLoading(true)
    setError(null)
    try {
      const { data, error: err } = await supabase.functions.invoke('field-form', { body: { action: 'slip', token, year: m.year, month: m.month } })
      if (err) {
        let msg = null
        try { msg = (await err.context?.json?.())?.error } catch { /* not JSON */ }
        throw msg ? new Error(msg) : err
      }
      if (data?.reason === 'no_slip') { setError('ไม่พบสลิปเดือนนี้'); return }
      if (data?.reason) { setError(REASON_MESSAGES[data.reason === 'payroll_disabled' ? 'payslip_disabled' : data.reason] || 'เกิดข้อผิดพลาด กรุณาลองใหม่'); return }
      if (data?.error) throw new Error(data.error)
      setSlip({ year: m.year, month: m.month, data })
    } catch (e) {
      setError(thaiOr(e.message, 'ส่งไม่สำเร็จ กรุณาลองใหม่'))
    } finally {
      setLoading(false)
    }
  }

  const savePdf = async () => {
    if (saving || !slip) return
    setSaving(true)
    setFit(false)
    try {
      await new Promise(r => requestAnimationFrame(() => r()))
      const label = (slip.data.worker?.nickname || slip.data.worker?.name || workerName || 'slip').replace(/\s+/g, '_')
      await downloadPDF('payslip-a5', `สลิปเงินเดือน_${label}_${MONTHS_TH[slip.month - 1]}${slip.year + 543}.pdf`, { format: 'a5', orientation: 'landscape', margin: 0 })
    } catch (e) {
      setError(thaiOr(e.message, 'บันทึก PDF ไม่สำเร็จ กรุณาลองใหม่'))
    } finally {
      setFit(true)
      setSaving(false)
    }
  }

  if (slip) {
    const d = slip.data
    const s = fit ? Math.min(1, width / SHEET_W) : 1
    return (
      <Shell wide>
        <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 12 }}>🧾 สลิปเงินเดือน</div>
        <div ref={boxRef} style={{ width: '100%', overflow: fit ? 'hidden' : 'visible' }}>
          <div style={{ height: SHEET_H * s }}>
            <div style={{ width: SHEET_W, transform: `scale(${s})`, transformOrigin: 'top left' }}>
              <PayslipSheetView record={{ ...d.record, workers: d.worker }} year={slip.year} month={slip.month} period={d.period} tenant={d.tenant} otItem={d.otItem} ytd={d.ytd} contribBalance={d.contribBalance ?? null} />
            </div>
          </div>
        </div>
        {error && <div className="alert alert-error" style={{ fontSize: 12.5, marginTop: 10 }}>{error}</div>}
        <div style={{ display: 'flex', gap: 8, marginTop: 14, flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-ghost" disabled={saving} onClick={() => { setSlip(null); setError(null) }}>← เลือกเดือนอื่น</button>
          <button type="button" className="btn btn-primary" disabled={saving} onClick={savePdf}>{saving ? '⏳ กำลังสร้าง PDF...' : '⬇️ บันทึก PDF'}</button>
        </div>
      </Shell>
    )
  }

  return (
    <Shell>
      <div style={{ fontWeight: 700, fontSize: 16, marginBottom: 4 }}>🧾 สลิปเงินเดือน</div>
      <div style={{ fontSize: 13, color: 'var(--text3)', marginBottom: 18 }}>สวัสดีครับคุณ{workerName}</div>
      {(months || []).length === 0 ? (
        <div style={{ textAlign: 'center', color: 'var(--text3)', padding: '20px 0' }}>ยังไม่มีสลิปที่ปิดงวดแล้วใน 12 เดือนล่าสุด</div>
      ) : (
        <div style={{ display: 'grid', gap: 8 }}>
          {months.map(m => (
            <button key={`${m.year}-${m.month}`} type="button" className="btn btn-ghost" disabled={loading} style={{ justifyContent: 'flex-start', textAlign: 'left' }}
              onClick={() => openMonth(m)}>
              {MONTHS_TH[m.month - 1]} {m.year + 543} · สุทธิ {fmt(m.netPay)} บาท
            </button>
          ))}
        </div>
      )}
      {loading && <div style={{ fontSize: 12.5, color: 'var(--text3)', marginTop: 12, textAlign: 'center' }}>กำลังโหลดสลิป…</div>}
      {error && <div className="alert alert-error" style={{ fontSize: 12.5, marginTop: 12 }}>{error}</div>}
    </Shell>
  )
}

const LEAVE_TYPES = [
  { value: 'leave_personal', label: '🏖️ ลากิจ' },
  { value: 'leave_sick', label: '🤒 ลาป่วย' },
]
const LEAVE_STATUS = {
  pending: { label: 'รอตรวจสอบ', color: 'var(--yellow)' },
  approved: { label: 'อนุมัติแล้ว', color: 'var(--green)' },
  rejected: { label: 'ไม่อนุมัติ', color: 'var(--red)' },
}
const SHIFT_LABEL = { morning: ' (ช่วงเช้า)', evening: ' (ช่วงบ่าย)' }

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

function Shell({ children, wide }) {
  return (
    <div style={{ minHeight: '100vh', background: 'var(--bg)', display: 'flex', alignItems: 'flex-start', justifyContent: 'center', padding: 20 }}>
      <div className="card" style={{ maxWidth: wide ? 840 : 420, width: '100%', padding: wide ? '20px 16px' : '28px 24px', marginTop: 20 }}>
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

  const [advAmount, setAdvAmount] = useState('')
  const [advTitle, setAdvTitle] = useState('')
  const [advInstallments, setAdvInstallments] = useState(1)
  const advParsed = parseAdvanceAmount(advAmount)
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
    if (submitting) return
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
        : state.actionType === 'advance'
        ? { action: 'submit', token, amount: advAmount, installments: Number(advInstallments), title: advTitle.trim() }
        : { action: 'submit', token, leaveType, dateFrom, dateTo: dateTo || dateFrom, reason: reason.trim() || null, shift: isSingleDay ? shift : 'full_day' }
      const { data, error } = await supabase.functions.invoke('field-form', { body })
      if (error) {
        // A 400 from the function carries a Thai message in its JSON body.
        let msg = null
        try { msg = (await error.context?.json?.())?.error } catch { /* not JSON */ }
        throw msg ? new Error(msg) : error
      }
      if (data?.reason) { setState(s => ({ ...s, reason: data.reason })); return }
      if (data?.error) throw new Error(data.error)
      setSubmitted(true)
    } catch (e) {
      setSubmitError(thaiOr(e.message, 'ส่งไม่สำเร็จ กรุณาลองใหม่'))
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
    return <CheckInFlow token={token} actionType={state.actionType} workerName={state.workerName} siteName={state.siteName} placeKind={state.placeKind} />
  }

  if (state.actionType === 'time_clock') {
    return <TimeClockFlow token={token} workerName={state.workerName} next={state.next} steps={state.steps} />
  }

  if (state.actionType === 'payslip') {
    return <PayslipFlow token={token} workerName={state.workerName} months={state.months} />
  }

  if (submitted) {
    return (
      <Shell>
        <div style={{ textAlign: 'center', padding: '20px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 8 }}>✅</div>
          <div style={{ fontWeight: 700, marginBottom: 4 }}>ส่งคำขอแล้ว</div>
          <div style={{ fontSize: 13, color: 'var(--text3)' }}>
            {state.actionType === 'material_request' ? 'สร้างใบสั่งซื้อร่างไว้ให้แล้ว แอดมินจะเลือกซัพพลายเออร์และราคาต่อ'
              : state.actionType === 'advance' ? 'ส่งคำขอแล้ว รอเจ้าของอนุมัติ พิมพ์ "ยอดเบิก" ในแชตเพื่อดูสถานะ'
              : 'รอแอดมิน/เจ้าของตรวจสอบและอนุมัติ'}
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
        {state.actionType === 'material_request' ? '📦 ขอเบิกของ' : state.actionType === 'advance' ? '💸 ขอเบิกเงิน' : '🏖️ ขอลา'}
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
        ) : state.actionType === 'advance' ? (
          <>
            <div style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '10px 12px', fontSize: 13 }}>
              <div>ยอดคืนคงเหลือของคุณ {Number(state.outstanding || 0).toLocaleString('th-TH')} บาท</div>
              {Number(state.pendingOther) > 0 && (
                <div style={{ color: 'var(--text3)', marginTop: 2 }}>รออนุมัติ {Number(state.pendingOther).toLocaleString('th-TH')} บาท</div>
              )}
            </div>
            <div>
              <label className="label">จำนวนเงิน (บาท) *</label>
              <input className="input" inputMode="decimal" value={advAmount} onChange={e => setAdvAmount(e.target.value)} />
              {advAmount.trim() !== '' && !advParsed.ok && (
                <div style={{ color: 'var(--red)', fontSize: 12.5, marginTop: 4 }}>{advParsed.error}</div>
              )}
            </div>
            <div>
              <label className="label">เหตุผล (ถ้ามี)</label>
              <input className="input" value={advTitle} maxLength={100} onChange={e => setAdvTitle(e.target.value)} />
            </div>
            <div>
              <label className="label">ผ่อนกี่เดือน</label>
              <select className="select" value={advInstallments} onChange={e => setAdvInstallments(Number(e.target.value))}>
                {(state.installmentOptions || [1, 2, 3, 4, 5, 6]).map(n => (
                  <option key={n} value={n}>
                    {advParsed.ok
                      ? `ผ่อน ${n} เดือน (เดือนละ ~${Math.ceil(advParsed.amount / n).toLocaleString('th-TH')} บาท)`
                      : `ผ่อน ${n} เดือน`}
                  </option>
                ))}
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
            {(state.recentRequests || []).length > 0 && (
              <div>
                <div className="label">ผลการลาของฉัน</div>
                <div style={{ display: 'grid', gap: 6 }}>
                  {state.recentRequests.map((r, i) => {
                    const st = LEAVE_STATUS[r.status] || LEAVE_STATUS.pending
                    return (
                      <div key={i} style={{ border: '1px solid var(--border)', borderRadius: 10, padding: '8px 12px', display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <div>
                          <div style={{ fontSize: 13, fontWeight: 600 }}>{r.leave_type === 'leave_sick' ? 'ลาป่วย' : 'ลากิจ'}{SHIFT_LABEL[r.shift] || ''}</div>
                          <div style={{ fontSize: 11, color: 'var(--text3)' }}>{r.date_from === r.date_to ? r.date_from : `${r.date_from} ถึง ${r.date_to}`}</div>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 600, color: st.color }}>{st.label}</span>
                      </div>
                    )
                  })}
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

        <button type="submit" className="btn btn-primary" disabled={submitting || (state.actionType === 'material_request' && !canSubmitMaterial) || (state.actionType === 'advance' && !advParsed.ok)}>
          {submitting ? '⏳ กำลังส่ง...' : '✅ ส่งคำขอ'}
        </button>
      </form>
    </Shell>
  )
}
