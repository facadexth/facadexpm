// RepairFormPage — the page /r/<token> opens to, from the customer LINE bot's แจ้งซ่อม button
// (CRM phase 1). Like FieldFormPage it lives outside the app shell (see main.jsx): no login, and
// nothing here touches the database with the anon key. Every call goes through the customer-form
// Edge Function (info / upload_url / submit), which checks the token with the service role.
//
// Flow (owner-approved mockup 2026-11-24): site → one item at a time (location, symptom, photos)
// → list → confirm (preferred days + slot + note) → done. Rules shared with the server live in
// supabase/functions/_shared/repair-form.ts; the state machine lives in lib/repairFormState.js.
import { useState, useEffect, useReducer, useRef, useCallback } from 'react'
import { supabase } from './lib/supabase.js'
import { resizeToJpeg } from './lib/resizeImage.js'
import { readVideoSeconds } from './lib/videoDuration.js'
import { formatThaiDate } from './lib/thaiDate.js'
import {
  repairFormReducer, resumeState, loadDraft, saveDraft, clearDraft,
} from './lib/repairFormState.js'
import {
  validateItem, validateRepairForm, addDays, LIMITS, SLOTS, LOCATIONS, SYMPTOMS,
} from '../supabase/functions/_shared/repair-form.ts'

const BUCKET = 'repair-media'
const VIDEO_MIMES = ['video/mp4', 'video/quicktime', 'video/webm']
const RAW_IMAGE_MIMES = ['image/jpeg', 'image/png']
const BAD_LINK = ['expired', 'not_found', 'used', 'line_bot_disabled', 'no_sites']

const MSG = {
  expired: 'ลิงก์หมดอายุ กดแจ้งซ่อมใน LINE อีกครั้ง',
  no_sites: 'ยังไม่พบไซท์ของคุณ กรุณาติดต่อบริษัท',
  line_bot_disabled: 'ยังแจ้งซ่อมผ่านฟอร์มไม่ได้ กรุณาติดต่อบริษัท',
  network: 'เชื่อมต่อไม่สำเร็จ เช็คสัญญาณอินเทอร์เน็ตแล้วลองใหม่',
  failed: 'ส่งไม่สำเร็จ กรุณาลองใหม่',
  upload: 'อัปโหลดรูปไม่สำเร็จ กรุณาลองใหม่',
  badImage: 'ไฟล์รูปนี้เปิดไม่ได้ ลองถ่ายใหม่',
  badVideo: 'เปิดวิดีโอไม่ได้ ลองถ่ายใหม่',
  badType: 'ไฟล์ชนิดนี้ใช้ไม่ได้',
  tooBig: 'ไฟล์ใหญ่เกิน 50 MB',
  tooLong: `วิดีโอยาวได้ไม่เกิน ${LIMITS.maxVideoSeconds} วินาที`,
  tooManyImages: `รูปได้ไม่เกิน ${LIMITS.maxImages} รูป`,
  tooManyVideos: 'วิดีโอได้ 1 คลิป',
}

const usedText = (n) => (n ? `ส่งเรื่องนี้แล้ว เลขที่ ${n}` : 'ส่งเรื่องนี้แล้ว')
function badLinkText(reason, ticketNumber) {
  if (reason === 'used') return usedText(ticketNumber)
  if (reason === 'no_sites') return MSG.no_sites
  if (reason === 'line_bot_disabled') return MSG.line_bot_disabled
  return MSG.expired // expired, not_found
}

const isThai = (s) => typeof s === 'string' && /[฀-๿]/.test(s)
class UserError extends Error {}

// One call to customer-form. Non-2xx bodies are read from error.context (same as FieldFormPage).
async function callFn(body) {
  try {
    const { data, error } = await supabase.functions.invoke('customer-form', { body })
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

const WEEKDAYS = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']
const weekday = (ymd) => WEEKDAYS[new Date(`${ymd}T00:00:00Z`).getUTCDay()]
const DAYS_PER_PAGE = 14

function dayRange(bounds, count) {
  const out = []
  if (!bounds?.min || !bounds?.max) return out
  let d = bounds.min
  while (d <= bounds.max && out.length < count) { out.push(d); d = addDays(d, 1) }
  return out
}

const CSS = `
.rf{min-height:100vh;background:var(--bg);color:var(--text);font-size:15px;line-height:1.6;overflow-x:hidden}
.rf *{box-sizing:border-box}
.rf-top{background:var(--bg2);border-bottom:1px solid var(--border);padding:10px 16px;display:flex;align-items:center;gap:10px;font-size:13px}
.rf-top b{flex:1;font-size:15px;min-width:0;overflow-wrap:anywhere}
.rf-top span{color:var(--text3);min-width:0;overflow-wrap:anywhere;text-align:right}
.rf-wrap{max-width:480px;margin:0 auto;padding:0 16px 40px}
.rf-steps{display:flex;gap:4px;padding:10px 0 0}
.rf-steps i{flex:1;height:4px;border-radius:2px;background:var(--border)}
.rf-steps i.on{background:var(--green)}
.rf-screen{display:grid;gap:12px;padding-top:14px;align-content:start;min-width:0}
.rf-screen h3{font-size:18px;font-weight:700;margin:0;overflow-wrap:anywhere}
.rf-lbl{font-weight:600;font-size:13.5px}
.rf-chips{display:flex;flex-wrap:wrap;gap:6px}
.rf-chip{border:1px solid var(--border);background:var(--bg2);color:var(--text);border-radius:999px;padding:6px 12px;font:inherit;font-size:14px;cursor:pointer;max-width:100%}
.rf-chip.on{border-color:var(--green);background:rgba(var(--green-rgb),.18);font-weight:600}
.rf textarea,.rf input[type=text]{width:100%;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;font-size:16px;color:var(--text);background:var(--bg2)}
.rf textarea{min-height:70px;resize:vertical}
.rf-shot{display:flex;gap:8px;flex-wrap:wrap}
.rf-ph{width:72px;height:72px;border-radius:10px;background:var(--bg3) center/cover no-repeat;position:relative;display:grid;place-items:center;font-size:24px}
.rf-ph button{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;border:0;background:var(--text);color:var(--bg);font-size:12px;cursor:pointer}
.rf-cam{width:72px;height:72px;border-radius:10px;border:2px dashed var(--text3);display:grid;place-items:center;text-align:center;font-size:11.5px;line-height:1.3;color:var(--text3);cursor:pointer;background:var(--bg2)}
.rf-cam span{font-size:22px;display:block;line-height:1.1}
.rf-cam input{display:none}
.rf-big{display:block;width:100%;border:0;border-radius:12px;padding:13px;font:inherit;font-size:16px;font-weight:600;cursor:pointer;background:var(--green);color:var(--on-accent)}
.rf-big:disabled{opacity:.45;cursor:not-allowed}
.rf-big.ghost{background:transparent;color:var(--text);border:2px solid var(--green)}
.rf-hint{font-size:12.5px;color:var(--text3)}
.rf-err{font-size:13px;color:var(--red)}
.rf-items{display:grid;gap:8px}
.rf-item{border:1px solid var(--border);background:var(--bg2);border-radius:12px;padding:10px;display:grid;grid-template-columns:auto minmax(0,1fr) auto;gap:10px;align-items:start}
.rf-item .n{width:26px;height:26px;border-radius:50%;background:rgba(var(--green-rgb),.18);display:grid;place-items:center;font-weight:700;font-size:13px}
.rf-item .t{font-weight:600;overflow-wrap:anywhere}
.rf-item .d{font-size:13px;color:var(--text3);overflow-wrap:anywhere}
.rf-item .acts{display:grid;gap:4px}
.rf-item .acts button{border:0;background:none;color:var(--accent);font:inherit;font-size:13px;cursor:pointer;padding:0}
.rf-sites{display:grid;gap:8px}
.rf-sites button{text-align:left;border:1px solid var(--border);border-radius:12px;padding:12px;background:var(--bg2);font:inherit;color:var(--text);cursor:pointer;overflow-wrap:anywhere}
.rf-sites button.on{border-color:var(--green);background:rgba(var(--green-rgb),.18)}
.rf-tbl{overflow-x:auto}
.rf-tbl table{border-collapse:collapse;width:100%;font-size:13px}
.rf-tbl th,.rf-tbl td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--border);vertical-align:top;overflow-wrap:anywhere}
.rf-tbl th{color:var(--text3);font-weight:500;white-space:nowrap}
.rf-done{display:grid;gap:12px;justify-items:center;text-align:center;padding-top:30px}
.rf-done .ok{width:64px;height:64px;border-radius:50%;background:var(--green);color:var(--on-accent);display:grid;place-items:center;font-size:32px}
.rf-msg{text-align:center;padding:48px 0;display:grid;gap:14px;justify-items:center}
.rf button:focus-visible,.rf-cam:focus-within{outline:3px solid var(--accent);outline-offset:2px}
`

const STEP_IDX = { site: 0, item: 1, list: 2, confirm: 3, done: 3 }

function Page({ title, brand, step, children }) {
  return (
    <div className="rf">
      <style>{CSS}</style>
      <div className="rf-top"><b>{title}</b>{brand ? <span>{brand}</span> : null}</div>
      <div className="rf-wrap">
        {step ? (
          <div className="rf-steps" aria-hidden="true">
            {[0, 1, 2, 3].map((i) => <i key={i} className={i <= STEP_IDX[step] ? 'on' : ''} />)}
          </div>
        ) : null}
        {children}
      </div>
    </div>
  )
}

const countKind = (files, kind) => files.filter((f) => f.mediaType === kind).length

export default function RepairFormPage({ token }) {
  const [phase, setPhase] = useState({ loading: true }) // {loading} | {reason, ticketNumber} | {info}
  const [state, dispatch] = useReducer(repairFormReducer, null)
  const [fileError, setFileError] = useState('')
  const [submitErrors, setSubmitErrors] = useState([])
  const [submitting, setSubmitting] = useState(false)
  const [sitePick, setSitePick] = useState(null)
  const [dayCount, setDayCount] = useState(DAYS_PER_PAGE)
  const stateRef = useRef(state)
  stateRef.current = state
  const pending = useRef({ image: 0, video: 0 })
  const previews = useRef(new Map()) // storage path -> object URL (this visit only; never in the draft)

  const loadInfo = useCallback(async () => {
    setPhase({ loading: true })
    const res = await callFn({ action: 'info', token })
    const b = res.body
    if (BAD_LINK.includes(b.reason)) { setPhase({ reason: b.reason, ticketNumber: b.ticketNumber }); return }
    if (!res.ok || !b.ok || !Array.isArray(b.sites)) { setPhase({ reason: 'network' }); return }
    dispatch({ type: 'load', state: resumeState(b, loadDraft(token)) })
    setPhase({ info: b })
  }, [token])

  useEffect(() => { loadInfo() }, [loadInfo])

  // Draft: every change, but never mid-upload (a half-uploaded item would come back broken).
  useEffect(() => {
    if (!state || state.step === 'done' || state.draft.uploading > 0) return
    saveDraft(token, state)
  }, [token, state])

  useEffect(() => () => { for (const u of previews.current.values()) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } } }, [])

  const uploadOne = useCallback(async (file, key) => {
    const type = file.type || ''
    const kind = type.startsWith('video/') ? 'video' : type.startsWith('image/') || type === '' ? 'image' : null
    if (!kind) { setFileError(MSG.badType); return }
    const have = countKind(stateRef.current.draft.files, kind) + pending.current[kind]
    if (kind === 'image' && have >= LIMITS.maxImages) { setFileError(MSG.tooManyImages); return }
    if (kind === 'video' && have >= LIMITS.maxVideos) { setFileError(MSG.tooManyVideos); return }

    pending.current[kind]++
    dispatch({ type: 'fileStarted', key })
    try {
      let blob = file
      let mime = type
      let seconds
      if (kind === 'video') {
        if (!VIDEO_MIMES.includes(type)) throw new UserError(MSG.badType)
        if (file.size > LIMITS.maxBytes) throw new UserError(MSG.tooBig)
        try { seconds = await readVideoSeconds(file) } catch { throw new UserError(MSG.badVideo) }
        if (seconds > LIMITS.maxVideoSeconds) throw new UserError(MSG.tooLong)
        seconds = Math.round(seconds * 10) / 10
      } else {
        try {
          blob = await resizeToJpeg(file, 1600, 0.82)
          mime = 'image/jpeg'
        } catch {
          if (!RAW_IMAGE_MIMES.includes(type)) throw new UserError(MSG.badImage)
          blob = file
          mime = type
        }
      }
      if (!(blob.size > 0)) throw new UserError(kind === 'video' ? MSG.badVideo : MSG.badImage)
      if (blob.size > LIMITS.maxBytes) throw new UserError(MSG.tooBig)

      const res = await callFn({ action: 'upload_url', token, mime, mediaType: kind, bytes: blob.size })
      if (BAD_LINK.includes(res.body.reason)) {
        setPhase({ reason: res.body.reason, ticketNumber: res.body.ticketNumber })
        throw new UserError('')
      }
      if (!res.ok || !res.body.path || !res.body.uploadToken) throw new UserError(MSG.upload)
      const { error } = await supabase.storage.from(BUCKET)
        .uploadToSignedUrl(res.body.path, res.body.uploadToken, blob, { contentType: mime })
      if (error) throw new UserError(MSG.upload)

      if (kind === 'image' && typeof URL.createObjectURL === 'function') {
        try { previews.current.set(res.body.path, URL.createObjectURL(blob)) } catch { /* no preview */ }
      }
      const uploaded = { path: res.body.path, mediaType: kind, bytes: blob.size }
      if (seconds !== undefined) uploaded.seconds = seconds
      dispatch({ type: 'fileUploaded', key, file: uploaded })
    } catch (e) {
      dispatch({ type: 'fileFailed', key })
      if (e instanceof UserError) { if (e.message) setFileError(e.message) } else setFileError(MSG.upload)
    } finally {
      pending.current[kind]--
    }
  }, [token])

  const onFiles = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // the same file can be picked again after a failure
    if (!files.length || !stateRef.current) return
    setFileError('')
    const key = stateRef.current.draft.key
    for (const f of files) uploadOne(f, key)
  }

  const send = async () => {
    if (submitting || !state) return
    const payload = {
      siteId: state.siteId,
      items: state.items.map((it) => ({
        location: it.location, room: it.room, symptom: it.symptom, note: it.note,
        files: it.files.map((f) => {
          const o = { path: f.path, mediaType: f.mediaType, bytes: f.bytes }
          if (typeof f.seconds === 'number') o.seconds = f.seconds
          return o
        }),
      })),
      preferredDays: state.preferredDays,
      preferredSlot: state.preferredSlot,
      note: state.note,
    }
    const bounds = phase.info?.bounds
    if (bounds?.min) {
      const errs = validateRepairForm(payload, addDays(bounds.min, -1))
      if (errs.length) { setSubmitErrors(errs); return }
    }
    setSubmitting(true)
    setSubmitErrors([])
    try {
      const res = await callFn({ action: 'submit', token, payload })
      const b = res.body
      if (res.ok && b.ok && b.ticketNumber) {
        clearDraft(token)
        dispatch({ type: 'submitted', ticketNumber: b.ticketNumber })
        return
      }
      if (BAD_LINK.includes(b.reason)) { setPhase({ reason: b.reason, ticketNumber: b.ticketNumber }); return }
      if (res.status >= 400 && res.status < 500 && Array.isArray(b.errors) && b.errors.some(isThai)) {
        setSubmitErrors(b.errors.filter(isThai))
      } else {
        setSubmitErrors([MSG.failed])
      }
    } finally {
      setSubmitting(false)
    }
  }

  // ---------- screens ----------

  if (phase.loading) {
    return <Page title="แจ้งซ่อม"><div className="rf-msg rf-hint">กำลังโหลด...</div></Page>
  }

  if (phase.reason) {
    const network = phase.reason === 'network'
    return (
      <Page title="แจ้งซ่อม">
        <div className="rf-msg">
          <div style={{ fontSize: 32 }}>{phase.reason === 'used' ? '✅' : '⚠️'}</div>
          <div style={{ fontWeight: 600 }}>{network ? MSG.network : badLinkText(phase.reason, phase.ticketNumber)}</div>
          {network ? <button type="button" className="rf-big" onClick={loadInfo}>🔄 ลองอีกครั้ง</button> : null}
        </div>
      </Page>
    )
  }

  if (!state) return null
  const info = phase.info
  const brand = info.brandName || ''
  const sites = info.sites
  const site = sites.find((s) => s.id === state.siteId)
  const locations = Array.isArray(info.locations) && info.locations.length ? info.locations : LOCATIONS
  const symptoms = Array.isArray(info.symptoms) && info.symptoms.length ? info.symptoms : SYMPTOMS

  if (state.step === 'done') {
    return (
      <Page title="ส่งแล้ว" brand={brand} step="done">
        <div className="rf-screen">
          <div className="rf-done">
            <div className="ok">✓</div>
            <h3>{`รับเรื่องแล้ว เลขที่ ${state.ticketNumber}`}</h3>
            {state.items.length ? <p>{state.items.length} รายการ</p> : null}
            <p className="rf-hint">ทีมจะติดต่อกลับเพื่อนัดเข้าซ่อม ดูความคืบหน้าได้ที่เมนู "สถานะแจ้งซ่อม" ใน LINE</p>
          </div>
        </div>
      </Page>
    )
  }

  if (state.step === 'site') {
    const sel = sitePick ?? state.siteId
    return (
      <Page title="แจ้งซ่อม · เลือกงาน" brand={brand} step="site">
        <div className="rf-screen">
          <h3>แจ้งซ่อมงานไหนครับ</h3>
          <div className="rf-sites">
            {sites.map((s) => (
              <button key={s.id} type="button" className={sel === s.id ? 'on' : ''} aria-pressed={sel === s.id} onClick={() => setSitePick(s.id)}>
                <b>{s.name}</b>
              </button>
            ))}
          </div>
          <button type="button" className="rf-big" disabled={!sel} onClick={() => dispatch({ type: 'pickSite', siteId: sel })}>ถัดไป</button>
        </div>
      </Page>
    )
  }

  if (state.step === 'item') {
    const d = state.draft
    const n = state.editIndex !== null ? state.editIndex + 1 : state.items.length + 1
    const errs = validateItem(d)
    const canConfirm = errs.length === 0 && d.uploading === 0
    const set = (patch) => dispatch({ type: 'setDraft', patch })
    return (
      <Page title={`รายการที่ ${n}`} brand={brand} step="item">
        <div className="rf-screen">
          <h3>รายการที่ {n}</h3>
          {site && sites.length > 1 ? <p className="rf-hint">{site.name}</p> : null}
          <div className="rf-lbl">1. ตรงไหน</div>
          <div className="rf-chips">
            {locations.map((x) => (
              <button key={x} type="button" className={`rf-chip${d.location === x ? ' on' : ''}`} aria-pressed={d.location === x} onClick={() => set({ location: x })}>{x}</button>
            ))}
          </div>
          <input type="text" placeholder="ห้อง / ชั้น เช่น ห้องนอนชั้น 2 (ไม่บังคับ)" aria-label="ห้อง / ชั้น" value={d.room} maxLength={100} onChange={(e) => set({ room: e.target.value })} />
          <div className="rf-lbl">2. เป็นอะไร</div>
          <div className="rf-chips">
            {symptoms.map((x) => (
              <button key={x} type="button" className={`rf-chip${d.symptom === x ? ' on' : ''}`} aria-pressed={d.symptom === x} onClick={() => set({ symptom: x })}>{x}</button>
            ))}
          </div>
          <textarea placeholder="เล่าเพิ่มเติม (ไม่บังคับ)" aria-label="เล่าเพิ่มเติม" value={d.note} maxLength={1000} onChange={(e) => set({ note: e.target.value })} />
          <div className="rf-lbl">3. ถ่ายรูปจุดที่มีปัญหา (อย่างน้อย 1 รูป · วิดีโอไม่เกิน 30 วิ ได้)</div>
          <div className="rf-shot">
            {d.files.map((f, i) => {
              const url = previews.current.get(f.path)
              return (
                <div key={f.path} className="rf-ph" style={url ? { backgroundImage: `url(${url})` } : undefined}>
                  {url ? null : <span aria-hidden="true">{f.mediaType === 'video' ? '🎥' : '📷'}</span>}
                  <button type="button" aria-label="ลบไฟล์" onClick={() => dispatch({ type: 'removeFile', index: i })}>✕</button>
                </div>
              )
            })}
            {d.uploading > 0 ? <div className="rf-ph" aria-label="กำลังอัปโหลด"><span aria-hidden="true">⏳</span></div> : null}
            <label className="rf-cam"><input type="file" accept="image/*" capture="environment" onChange={onFiles} /><div><span>📷</span>ถ่ายรูป</div></label>
            <label className="rf-cam"><input type="file" accept="video/*" capture onChange={onFiles} /><div><span>🎥</span>วิดีโอ</div></label>
            <label className="rf-cam"><input type="file" accept="image/*,video/*" multiple onChange={onFiles} /><div><span>🖼</span>เลือกจากเครื่อง</div></label>
          </div>
          {d.uploading > 0 ? <p className="rf-hint">กำลังอัปโหลด...</p> : null}
          {fileError ? <p className="rf-err" role="alert">{fileError}</p> : null}
          {errs.length ? <p className="rf-err">{errs.join(' · ')}</p> : null}
          <button type="button" className="rf-big" disabled={!canConfirm} onClick={() => { setFileError(''); dispatch({ type: 'confirmItem' }) }}>✔ ยืนยันรายการนี้</button>
          {state.items.length || state.editIndex !== null
            ? <button type="button" className="rf-big ghost" onClick={() => { setFileError(''); dispatch({ type: 'cancelItem' }) }}>ยกเลิกรายการนี้</button>
            : null}
        </div>
      </Page>
    )
  }

  if (state.step === 'list') {
    const pics = state.items.reduce((a, x) => a + x.files.length, 0)
    return (
      <Page title="รายการแจ้งซ่อม" brand={brand} step="list">
        <div className="rf-screen">
          <h3>{site?.name || ''}</h3>
          <p className="rf-hint">{state.items.length} รายการ · {pics} รูป</p>
          <div className="rf-items">
            {state.items.map((x, i) => {
              const img = countKind(x.files, 'image')
              const vid = countKind(x.files, 'video')
              return (
                <div key={i} className="rf-item">
                  <span className="n">{i + 1}</span>
                  <div>
                    <div className="t">{x.location}{x.room ? ` · ${x.room}` : ''}</div>
                    <div className="d">{x.symptom}{x.note ? ` — ${x.note}` : ''}</div>
                    <div className="d">📷 {img}{vid ? ` · 🎥 ${vid}` : ''}</div>
                  </div>
                  <div className="acts">
                    <button type="button" onClick={() => dispatch({ type: 'editItem', index: i })}>แก้ไข</button>
                    <button type="button" onClick={() => dispatch({ type: 'deleteItem', index: i })}>ลบ</button>
                  </div>
                </div>
              )
            })}
          </div>
          {state.items.length < LIMITS.maxItems
            ? <button type="button" className="rf-big ghost" onClick={() => { setFileError(''); dispatch({ type: 'addAnother' }) }}>+ เพิ่มรายการ</button>
            : <p className="rf-hint">ได้ไม่เกิน {LIMITS.maxItems} รายการ</p>}
          <button type="button" className="rf-big" disabled={!state.items.length} onClick={() => { setSubmitErrors([]); dispatch({ type: 'toConfirm' }) }}>ครบแล้ว ไปหน้ายืนยัน</button>
        </div>
      </Page>
    )
  }

  // confirm
  const days = dayRange(info.bounds, dayCount)
  const allDays = dayRange(info.bounds, LIMITS.maxDaysAhead + 1)
  return (
    <Page title="ยืนยันแจ้งซ่อม" brand={brand} step="confirm">
      <div className="rf-screen">
        <h3>ตรวจอีกครั้งก่อนส่ง</h3>
        <div className="rf-tbl">
          <table>
            <thead><tr><th>#</th><th>ตรงไหน</th><th>เป็นอะไร</th><th>รูป</th></tr></thead>
            <tbody>
              {state.items.map((x, i) => (
                <tr key={i}>
                  <td>{i + 1}</td>
                  <td>{x.location}{x.room ? <><br /><span className="rf-hint">{x.room}</span></> : null}</td>
                  <td>{x.symptom}</td>
                  <td>{x.files.length}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="rf-lbl">วันที่สะดวกให้ช่างเข้า (เลือกได้ไม่เกิน 3 วัน)</div>
        <div className="rf-chips">
          {days.map((day) => {
            const on = state.preferredDays.includes(day)
            return (
              <button key={day} type="button" className={`rf-chip${on ? ' on' : ''}`} aria-pressed={on}
                disabled={!on && state.preferredDays.length >= LIMITS.maxPreferredDays}
                onClick={() => dispatch({ type: 'toggleDay', day })}>
                {weekday(day)} {formatThaiDate(day)}
              </button>
            )
          })}
        </div>
        {days.length < allDays.length
          ? <button type="button" className="rf-chip" style={{ justifySelf: 'start' }} onClick={() => setDayCount((c) => c + DAYS_PER_PAGE)}>ดูวันถัดไป</button>
          : null}
        <div className="rf-chips">
          {Object.entries(SLOTS).map(([value, label]) => {
            const on = state.preferredSlot === value
            return (
              <button key={value} type="button" className={`rf-chip${on ? ' on' : ''}`} aria-pressed={on}
                onClick={() => dispatch({ type: 'setSlot', slot: on ? null : value })}>{label}</button>
            )
          })}
        </div>
        <p className="rf-hint">ทีมจะยืนยันวันนัดอีกครั้งทาง LINE</p>
        <div className="rf-lbl">หมายเหตุถึงทีม (ไม่บังคับ)</div>
        <textarea aria-label="หมายเหตุถึงทีม" value={state.note} maxLength={1000} onChange={(e) => dispatch({ type: 'setNote', note: e.target.value })} />
        {submitErrors.length
          ? <div className="rf-err" role="alert">{submitErrors.map((m, i) => <div key={i}>{m}</div>)}</div>
          : null}
        <button type="button" className="rf-big" disabled={submitting} onClick={send}>{submitting ? '⏳ กำลังส่ง...' : '📨 ส่งแจ้งซ่อม'}</button>
        <button type="button" className="rf-big ghost" disabled={submitting} onClick={() => dispatch({ type: 'toList' })}>กลับไปแก้</button>
      </div>
    </Page>
  )
}
