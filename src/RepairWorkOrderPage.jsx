// /w/<token> -- the crew's repair work order on a phone (CRM phase 2a, task 7). No login, no app
// shell: the LINE "งานวันนี้" link carries a repair_workorder token; every read/write goes through
// the repair-workorder Edge Function (logic in supabase/functions/_shared/repair-workorder-logic.ts),
// which re-checks the worker is still on the ticket each time.
// The A4 sheet (RepairWorkOrderSheet, 718px wide) is scaled down to the screen width; a sticky bar
// below it lets the customer sign on the crew's phone, or sends the customer a sign-later link.
import { useState, useEffect, useRef, useCallback, useLayoutEffect } from 'react'
import { supabase } from './lib/supabase.js'
import { A4_CONTENT_WIDTH_PX } from './lib/pdf.js'
import RepairWorkOrderSheet from './components/RepairWorkOrderSheet.jsx'
import SignaturePad from './components/SignaturePad.jsx'

export const MSG = {
  expired: 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง',
  not_assigned: 'คุณไม่ได้อยู่ในทีมของงานซ่อมนี้แล้ว',
  declined: 'งานซ่อมนี้ถูกยกเลิกแล้ว',
  line_bot_disabled: 'ใบงานซ่อมออนไลน์ยังไม่เปิดใช้ ติดต่อแอดมิน',
  network: 'โหลดไม่สำเร็จ ลองใหม่',
  saveFailed: 'บันทึกไม่สำเร็จ ลองใหม่',
  sent: 'ส่งลิงก์ให้ลูกค้าทาง LINE แล้ว',
  notSent: 'ส่งทาง LINE ไม่ได้ตอนนี้ แจ้งแอดมินให้ส่งลิงก์ให้ลูกค้า',
}

// expired / not_found / anything unknown -> the expired text.
export function reasonText(reason) {
  if (reason === 'not_assigned') return MSG.not_assigned
  if (reason === 'declined') return MSG.declined
  if (reason === 'line_bot_disabled') return MSG.line_bot_disabled
  return MSG.expired
}

// The client name is customerText up to ' · ' (the phone follows); '-' means no client.
export function clientNameOf(wo) {
  const t = typeof wo?.customerText === 'string' ? wo.customerText : ''
  if (!t || t === '-') return ''
  return t.split(' · ')[0].trim()
}

// One call to repair-workorder. Non-2xx bodies are read from error.context (same as RepairFormPage).
async function callFn(body) {
  try {
    const { data, error } = await supabase.functions.invoke('repair-workorder', { body })
    if (error) {
      let b = null
      try { b = await error.context?.json?.() } catch { /* not JSON */ }
      return { ok: false, status: error.context?.status ?? 0, body: b && typeof b === 'object' ? b : {} }
    }
    return { ok: true, status: 200, body: data && typeof data === 'object' ? data : {} }
  } catch {
    return { ok: false, status: 0, body: {} }
  }
}

const CSS = `
.wo{min-height:100vh;background:var(--bg);color:var(--text);font-size:15px;line-height:1.6;overflow-x:hidden;display:flex;flex-direction:column}
.wo *{box-sizing:border-box}
.wo-fit{padding:8px;flex:1}
.wo-scale{overflow:hidden;background:#fff;border-radius:6px}
.wo-scale>div{transform-origin:top left}
.wo-bar{position:sticky;bottom:0;background:var(--bg2);border-top:1px solid var(--border);padding:10px 12px calc(10px + env(safe-area-inset-bottom));display:grid;gap:8px}
.wo-big{display:block;width:100%;border:0;border-radius:12px;padding:12px;font:inherit;font-size:16px;font-weight:600;cursor:pointer;background:var(--green);color:var(--on-accent)}
.wo-big:disabled{opacity:.45;cursor:not-allowed}
.wo-big.ghost{background:transparent;color:var(--text);border:2px solid var(--green)}
.wo-note{font-size:14px;text-align:center;overflow-wrap:anywhere}
.wo-err{font-size:13px;color:var(--red);text-align:center;overflow-wrap:anywhere}
.wo-msg{max-width:480px;margin:0 auto;padding:64px 16px;text-align:center;display:grid;gap:14px;justify-items:center;overflow-wrap:anywhere}
.wo-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:50}
.wo-sheet{background:var(--bg);width:100%;max-width:520px;border-radius:16px 16px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));display:grid;gap:10px;max-height:92vh;overflow-y:auto}
.wo-sheet-hd{display:flex;justify-content:flex-end}
.wo-x{border:0;background:transparent;color:var(--text);font-size:22px;line-height:1;cursor:pointer;padding:4px 8px}
.wo-sheet input[type=text]{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;font-size:16px;color:var(--text);background:var(--bg2)}
.wo-pad{background:#fff;border-radius:10px;overflow:hidden}
.wo button:focus-visible{outline:3px solid var(--accent);outline-offset:2px}
`

// The 718px sheet scaled to the available width. The wrapper's height is the sheet's height x scale,
// so the sticky bar below never overlaps it. Both sizes are re-measured on resize (images/QR load late).
function FittedSheet({ wo }) {
  const outerRef = useRef(null)
  const innerRef = useRef(null)
  const [size, setSize] = useState({ scale: 1, height: 0 })

  const measure = useCallback(() => {
    const outer = outerRef.current
    const inner = innerRef.current
    if (!outer || !inner) return
    const w = outer.clientWidth
    const scale = w > 0 ? Math.min(1, w / A4_CONTENT_WIDTH_PX) : 1
    const height = inner.offsetHeight * scale
    setSize((s) => (s.scale === scale && s.height === height ? s : { scale, height }))
  }, [])

  useLayoutEffect(() => {
    measure()
    if (typeof ResizeObserver === 'function') {
      const ro = new ResizeObserver(() => measure())
      if (outerRef.current) ro.observe(outerRef.current)
      if (innerRef.current) ro.observe(innerRef.current)
      return () => ro.disconnect()
    }
    window.addEventListener('resize', measure)
    return () => window.removeEventListener('resize', measure)
  }, [measure, wo])

  return (
    <div ref={outerRef} className="wo-scale" style={size.height ? { height: size.height } : undefined}>
      <div ref={innerRef} style={{ width: A4_CONTENT_WIDTH_PX, transform: `scale(${size.scale})` }}>
        <RepairWorkOrderSheet wo={wo} id="repair-workorder-sheet" />
      </div>
    </div>
  )
}

function SignSheet({ token, wo, force, onClose, onSigned }) {
  const [name, setName] = useState(() => clientNameOf(wo))
  const [png, setPng] = useState(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [already, setAlready] = useState(null) // receipt returned with already: true

  const submit = async (withForce) => {
    if (busy) return
    setBusy(true)
    setErr('')
    const body = { token, action: 'sign', signerName: name.trim(), signaturePng: png }
    if (withForce) body.force = true
    const res = await callFn(body)
    setBusy(false)
    if (res.ok && res.body.reason) { setErr(reasonText(res.body.reason)); return }
    if (!res.ok || !res.body.ok) { setErr(MSG.saveFailed); return }
    if (res.body.already) { setAlready(res.body.receipt || { signer_name: '' }); return }
    onSigned()
  }

  const canSave = !!name.trim() && !!png && !busy

  return (
    <div className="wo-ov" role="dialog" aria-modal="true">
      <div className="wo-sheet">
        <div className="wo-sheet-hd">
          <button type="button" className="wo-x" aria-label="ปิด" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <input type="text" value={name} maxLength={100} onChange={(e) => setName(e.target.value)} aria-label="ชื่อผู้เซ็น" />
        <div className="wo-pad"><SignaturePad onChange={setPng} height={200} /></div>
        {already ? (
          <>
            <div className="wo-note">ลูกค้าเซ็นไปแล้ว: {already.signer_name}</div>
            <button type="button" className="wo-big ghost" disabled={!canSave} onClick={() => submit(true)}>เซ็นใหม่แทน</button>
          </>
        ) : (
          <button type="button" className="wo-big" disabled={!canSave} onClick={() => submit(force)}>บันทึกลายเซ็น</button>
        )}
        {err ? <div className="wo-err" role="alert">{err}</div> : null}
      </div>
    </div>
  )
}

export default function RepairWorkOrderPage({ token }) {
  const [state, setState] = useState({ phase: 'loading' }) // loading | error | ok
  const [signing, setSigning] = useState(null) // null | { force }
  const [later, setLater] = useState({ busy: false, result: '', err: '' })

  const load = useCallback(async (quiet) => {
    if (!quiet) setState({ phase: 'loading' })
    const res = await callFn({ token, action: 'view' })
    if (res.ok && res.body.reason) { setState({ phase: 'error', msg: reasonText(res.body.reason) }); return }
    if (res.ok && res.body.ok && res.body.workOrder) { setState({ phase: 'ok', wo: res.body.workOrder }); return }
    // A failed quiet refresh keeps the sheet already on screen.
    setState((s) => (quiet && s.phase === 'ok' ? s : { phase: 'error', msg: MSG.network, retry: true }))
  }, [token])

  useEffect(() => { load(false) }, [load])

  const sendLater = async () => {
    if (later.busy || later.result) return
    setLater({ busy: true, result: '', err: '' })
    const res = await callFn({ token, action: 'sign_link' })
    if (res.ok && res.body.reason) { setLater({ busy: false, result: '', err: reasonText(res.body.reason) }); return }
    if (!res.ok || !res.body.ok) { setLater({ busy: false, result: '', err: MSG.network }); return }
    if (res.body.already) {
      // The customer signed meanwhile (e.g. staff or another crew): say so and show the signature.
      setLater({ busy: false, result: `ลูกค้าเซ็นไปแล้ว: ${res.body.receipt?.signer_name ?? ''}`, err: '' })
      load(true)
      return
    }
    // sent: false also covers an existing recent link being returned instead of a new one.
    setLater({ busy: false, result: res.body.sent === true ? MSG.sent : MSG.notSent, err: '' })
  }

  if (state.phase !== 'ok') {
    return (
      <div className="wo">
        <style>{CSS}</style>
        <div className="wo-msg">
          {state.phase === 'loading' ? <div>กำลังโหลด…</div> : null}
          {state.phase === 'error' && state.retry ? (
            <button type="button" className="wo-big ghost" onClick={() => load(false)}>{state.msg}</button>
          ) : null}
          {state.phase === 'error' && !state.retry ? <div role="alert">{state.msg}</div> : null}
        </div>
      </div>
    )
  }

  const wo = state.wo
  return (
    <div className="wo">
      <style>{CSS}</style>
      <div className="wo-fit"><FittedSheet wo={wo} /></div>
      <div className="wo-bar">
        {wo.receipt ? (
          <>
            <div className="wo-note">ลูกค้าเซ็นไปแล้ว: {wo.receipt.signer_name}</div>
            <button type="button" className="wo-big ghost" onClick={() => setSigning({ force: true })}>เซ็นใหม่แทน</button>
          </>
        ) : (
          <button type="button" className="wo-big" onClick={() => setSigning({ force: false })}>✍️ ให้ลูกค้าเซ็นรับงาน</button>
        )}
        {later.result ? (
          <div className="wo-note">{later.result}</div>
        ) : (
          <button type="button" className="wo-big ghost" disabled={later.busy} onClick={sendLater}>🔗 ส่งลิงก์ให้ลูกค้าเซ็นทีหลัง</button>
        )}
        {later.err ? <div className="wo-err" role="alert">{later.err}</div> : null}
      </div>
      {signing ? (
        <SignSheet
          token={token}
          wo={wo}
          force={signing.force}
          onClose={() => setSigning(null)}
          onSigned={() => { setSigning(null); load(true) }}
        />
      ) : null}
    </div>
  )
}
