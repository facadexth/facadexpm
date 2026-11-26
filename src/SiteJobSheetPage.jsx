// /j/<token> -- the crew's daily job sheet (ใบงานประจำวัน) on a phone (CRM G, task 7). No login, no
// app shell: the LINE "งานวันนี้" link carries a site_jobsheet token; every read/write goes through
// the site-jobsheet Edge Function (logic in supabase/functions/_shared/site-jobsheet-logic.ts), which
// re-checks the worker is still booked at the site today on every call.
// Phone-native layout (owner mockup screens 2 + 3), not the scaled A4. Only today's team leader
// (sheet.viewerIsLeader) can tap a card: a bottom sheet with ทำต่อพรุ่งนี้ / เสร็จทั้งการ์ด, ≥1 photo
// (uploaded to a signed URL as soon as picked) and a note. Crew never enter quantities.
import { useState, useEffect, useRef, useCallback } from 'react'
import { supabase } from './lib/supabase.js'
import { resizeToJpeg } from './lib/resizeImage.js'

const BUCKET = 'line-site-photos'
const MAX_PHOTOS = 10
const MAX_BYTES = 15 * 1024 * 1024
const NOTE_MAX = 500
const RAW_IMAGE_MIMES = ['image/jpeg', 'image/png']

export const MSG = {
  expired: 'ลิงก์หมดอายุ กด "งานวันนี้" ใน LINE อีกครั้ง',
  not_assigned: 'วันนี้คุณไม่ได้อยู่ในทีมของไซท์นี้แล้ว',
  line_bot_disabled: 'ใบงานออนไลน์ยังไม่เปิดใช้ ติดต่อแอดมิน',
  network: 'โหลดไม่สำเร็จ ลองใหม่',
  not_leader: 'เฉพาะหัวหน้าทีมกดอัปเดตการ์ดได้',
  card_not_found: 'ไม่พบการ์ดนี้แล้ว ลองโหลดใหม่',
  saved: 'บันทึกแล้ว',
  saveFailed: 'บันทึกไม่สำเร็จ ลองใหม่',
  upload: 'อัปโหลดรูปไม่สำเร็จ ลองใหม่',
  badImage: 'ไฟล์รูปนี้เปิดไม่ได้ ลองถ่ายใหม่',
  tooBig: 'ไฟล์รูปใหญ่เกิน 15 MB',
  tooManyPhotos: `รูปได้ไม่เกิน ${MAX_PHOTOS} รูป`,
  tooManyToday: 'อัปโหลดรูปครบจำนวนของวันนี้แล้ว',
}

// Token-level refusals (the whole page stops). expired / not_found / anything unknown -> expired text.
const PAGE_REASONS = ['expired', 'not_found', 'not_assigned', 'line_bot_disabled']
export function reasonText(reason) {
  if (reason === 'not_assigned') return MSG.not_assigned
  if (reason === 'line_bot_disabled') return MSG.line_bot_disabled
  return MSG.expired
}

class UserError extends Error {}

// One call to site-jobsheet. Non-2xx bodies are read from error.context (same as RepairWorkOrderPage).
async function callFn(body) {
  try {
    const { data, error } = await supabase.functions.invoke('site-jobsheet', { body })
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
.js{min-height:100vh;background:var(--bg);color:var(--text);font-size:15px;line-height:1.55;overflow-x:hidden}
.js *{box-sizing:border-box}
.js-wrap{max-width:560px;margin:0 auto;padding:12px 12px calc(28px + env(safe-area-inset-bottom));display:grid;gap:10px;align-content:start}
.js-hdr{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.js-hdr h3{margin:0;font-size:18px;font-weight:700;overflow-wrap:anywhere}
.js-k{color:var(--text3);font-size:12.5px}
.js-day{background:#1f5f78;color:#fff;border-radius:10px;padding:4px 10px;font-weight:700;font-size:12.5px;white-space:nowrap}
.js-dots{display:flex;gap:4px;flex-wrap:wrap}
.js-dots i{width:22px;height:6px;border-radius:3px;background:#cfd8dc}
.js-dots i.d{background:#2f7d4f}
.js-dots i.t{background:#1f5f78}
.js-card{background:var(--bg2);border:1px solid var(--border);border-radius:12px;padding:10px 12px;display:grid;gap:6px;min-width:0}
.js-card>div{overflow-wrap:anywhere}
.js-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}
.js-btn{display:inline-block;border:1px solid #1f5f78;color:#1f5f78;background:var(--bg);border-radius:8px;padding:5px 10px;font:inherit;font-weight:600;font-size:13px;text-decoration:none;cursor:pointer}
.js-safety{background:#fff8e6;color:#3d3220;border:1px solid #e3c27a;border-radius:10px;padding:8px 10px;font-size:13px;overflow-wrap:anywhere}
.js-prob{border-color:var(--red)}
.js-prob b{color:var(--red)}
.js-zone{font-weight:700;font-size:13.5px;color:#1f5f78;margin-top:2px;overflow-wrap:anywhere}
.js-task{display:grid;grid-template-columns:22px minmax(0,1fr) auto;gap:8px;align-items:center;padding:7px 0;border:0;border-top:1px dashed var(--border);background:none;color:inherit;font:inherit;text-align:left;width:100%}
button.js-task{cursor:pointer}
.js-zone+.js-task{border-top:0}
.js-task .nm{overflow-wrap:anywhere}
.js-box{width:18px;height:18px;border:2px solid #9aa6ab;border-radius:4px;position:relative}
.js-warn{width:18px;text-align:center;font-size:15px;line-height:18px}
.js-box.done{background:#2f7d4f;border-color:#2f7d4f}
.js-box.done::after{content:"";position:absolute;left:4px;top:0;width:5px;height:10px;border:solid #fff;border-width:0 2px 2px 0;transform:rotate(45deg)}
.js-qty{font-variant-numeric:tabular-nums;font-size:13px;white-space:nowrap}
.js-me{font-size:11px;background:#fff4dc;color:#8a5a10;border-radius:4px;padding:0 5px;margin-left:4px;white-space:nowrap}
.js-drw{display:flex;gap:8px;flex-wrap:wrap}
.js-drw a,.js-drw span.t{width:84px;display:grid;gap:3px;justify-items:center;text-align:center;font-size:11.5px;color:var(--text);text-decoration:none;overflow-wrap:anywhere}
.js-drw .th{width:84px;height:64px;border-radius:8px;border:1px solid var(--border);background:var(--bg3);display:grid;place-items:center;overflow:hidden;font-weight:700;color:var(--text3)}
.js-drw .th img{width:100%;height:100%;object-fit:cover}
.js-ok{position:fixed;left:12px;right:12px;bottom:calc(16px + env(safe-area-inset-bottom));max-width:536px;margin:0 auto;z-index:40;background:var(--bg2);border:2px solid var(--green);border-radius:12px;padding:10px 40px 10px 12px;display:grid;gap:2px;overflow-wrap:anywhere;box-shadow:0 4px 16px rgba(0,0,0,.25)}
.js-ok .js-x{position:absolute;top:6px;right:6px;font-size:18px}
.js-hint{font-size:13px;color:var(--text3);text-align:center}
.js-big{display:block;width:100%;border:0;border-radius:12px;padding:12px;font:inherit;font-size:16px;font-weight:600;cursor:pointer;background:var(--green);color:var(--on-accent)}
.js-big:disabled{opacity:.45;cursor:not-allowed}
.js-big.ghost{background:transparent;color:var(--text);border:2px solid var(--green)}
.js-msg{max-width:480px;margin:0 auto;padding:64px 16px;text-align:center;display:grid;gap:14px;justify-items:center;overflow-wrap:anywhere}
.js-err{font-size:13px;color:var(--red);overflow-wrap:anywhere}
.js-ov{position:fixed;inset:0;background:rgba(0,0,0,.45);display:flex;align-items:flex-end;justify-content:center;z-index:50}
.js-sheet{background:var(--bg);width:100%;max-width:560px;border-radius:16px 16px 0 0;padding:14px 16px calc(16px + env(safe-area-inset-bottom));display:grid;gap:10px;max-height:92vh;overflow-y:auto}
.js-sheet .js-hdr b{overflow-wrap:anywhere}
.js-x{border:0;background:transparent;color:var(--text);font-size:22px;line-height:1;cursor:pointer;padding:0 4px}
.js-modes{display:flex;gap:8px;flex-wrap:wrap}
.js-mode{flex:1;min-width:140px;border:2px solid #1f5f78;color:#1f5f78;background:var(--bg);border-radius:10px;padding:10px;font:inherit;font-weight:600;font-size:14.5px;cursor:pointer}
.js-mode[aria-pressed=true]{background:#1f5f78;color:#fff}
.js-shot{display:flex;gap:8px;flex-wrap:wrap}
.js-ph{width:72px;height:72px;border-radius:10px;background:var(--bg3) center/cover no-repeat;position:relative;display:grid;place-items:center;font-size:12px;color:var(--text3)}
.js-ph button{position:absolute;top:-6px;right:-6px;width:24px;height:24px;border-radius:50%;border:0;background:var(--text);color:var(--bg);font-size:12px;cursor:pointer}
.js-cam{width:72px;height:72px;border-radius:10px;border:2px dashed var(--text3);display:grid;place-items:center;text-align:center;font-size:11.5px;line-height:1.3;color:var(--text3);cursor:pointer;background:var(--bg2)}
.js-cam span{font-size:22px;display:block;line-height:1.1}
.js-cam input{display:none}
.js textarea{width:100%;min-height:64px;resize:vertical;border:1px solid var(--border);border-radius:10px;padding:10px;font:inherit;font-size:16px;color:var(--text);background:var(--bg2)}
.js button:focus-visible,.js a:focus-visible,.js-cam:focus-within{outline:3px solid var(--accent);outline-offset:2px}
`

// One bar per day of the run: done days green, today blue, days still to come grey.
function RunDots({ run }) {
  const total = Number(run?.total), index = Number(run?.index)
  if (!(total > 0 && index >= 1 && index <= total)) return null
  return (
    <div className="js-dots" aria-label={`วันที่ ${index} จาก ${total}`}>
      {Array.from({ length: total }, (_, i) => (
        <i key={i} className={i + 1 < index ? 'd' : i + 1 === index ? 't' : ''} />
      ))}
    </div>
  )
}

// Image drawings get a thumbnail tile; anything else (PDF) a labelled tile -- never an <img>.
function Drawings({ drawings }) {
  const list = (drawings || []).filter((d) => d?.title)
  if (!list.length) return null
  return (
    <div className="js-card">
      <b>แบบที่เกี่ยวข้อง</b>
      <div className="js-drw">
        {list.map((d) => {
          const isImage = typeof d.mime === 'string' && d.mime.startsWith('image/')
          const label = d.mime === 'application/pdf' ? 'PDF' : 'ไฟล์'
          const thumb = isImage && d.url
            ? <div className="th"><img src={d.url} alt="" loading="lazy" /></div>
            : <div className="th">{isImage ? '🖼' : label}</div>
          return d.url ? (
            <a key={d.id} href={d.url} target="_blank" rel="noopener noreferrer">{thumb}<span>{d.title}</span></a>
          ) : (
            <span key={d.id} className="t">{thumb}<span>{d.title}</span></span>
          )
        })}
      </div>
    </div>
  )
}

let photoSeq = 0

function CardSheet({ token, card, onClose, onSaved, onPageReason }) {
  const [mode, setMode] = useState(null) // null | 'continue' | 'done'
  const [photos, setPhotos] = useState([]) // { key, status: 'up'|'ok', path, preview }
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const countRef = useRef(0)
  const previews = useRef([])
  const alive = useRef(true)

  useEffect(() => () => {
    alive.current = false
    for (const u of previews.current) { try { URL.revokeObjectURL(u) } catch { /* ignore */ } }
  }, [])

  const uploadOne = useCallback(async (file) => {
    if (countRef.current >= MAX_PHOTOS) { setErr(MSG.tooManyPhotos); return }
    countRef.current++
    const key = ++photoSeq
    setPhotos((p) => [...p, { key, status: 'up', path: null, preview: null }])
    try {
      let blob
      let mime
      try {
        blob = await resizeToJpeg(file, 1600, 0.82)
        mime = 'image/jpeg'
      } catch {
        if (!RAW_IMAGE_MIMES.includes(file.type)) throw new UserError(MSG.badImage)
        blob = file
        mime = file.type
      }
      if (!(blob?.size > 0)) throw new UserError(MSG.badImage)
      if (blob.size > MAX_BYTES) throw new UserError(MSG.tooBig)

      const res = await callFn({ token, action: 'upload_url', mime, bytes: blob.size })
      const reason = res.body.reason
      if (res.ok && PAGE_REASONS.includes(reason)) { onPageReason(reason); throw new UserError('') }
      if (res.ok && reason === 'not_leader') throw new UserError(MSG.not_leader)
      if (res.status === 429) throw new UserError(MSG.tooManyToday)
      if (!res.ok || !res.body.path || !res.body.uploadToken) throw new UserError(MSG.upload)
      const { error } = await supabase.storage.from(BUCKET)
        .uploadToSignedUrl(res.body.path, res.body.uploadToken, blob, { contentType: mime })
      if (error) throw new UserError(MSG.upload)

      let preview = null
      if (typeof URL.createObjectURL === 'function') {
        try { preview = URL.createObjectURL(blob); previews.current.push(preview) } catch { /* no preview */ }
      }
      if (alive.current) {
        setPhotos((p) => p.map((x) => (x.key === key ? { ...x, status: 'ok', path: res.body.path, preview } : x)))
      }
    } catch (e) {
      countRef.current--
      if (alive.current) {
        setPhotos((p) => p.filter((x) => x.key !== key))
        if (e instanceof UserError) { if (e.message) setErr(e.message) } else setErr(MSG.upload)
      }
    }
  }, [token, onPageReason])

  const onFiles = (e) => {
    const files = Array.from(e.target.files || [])
    e.target.value = '' // the same file can be picked again after a failure
    if (!files.length) return
    setErr('')
    for (const f of files) uploadOne(f)
  }

  const removePhoto = (key) => {
    countRef.current--
    setPhotos((p) => p.filter((x) => x.key !== key))
  }

  const ready = photos.filter((p) => p.status === 'ok')
  const uploading = photos.some((p) => p.status === 'up')
  const canSend = !!mode && ready.length >= 1 && !uploading && !busy

  const send = async () => {
    if (!canSend) return
    setBusy(true)
    setErr('')
    const res = await callFn({
      token,
      action: 'card_update',
      taskId: card.id,
      mode,
      photos: ready.map((p) => p.path),
      note: note.trim(),
    })
    setBusy(false)
    const b = res.body
    if (res.ok && b.ok && b.sheet) { onSaved(b.sheet, typeof b.statusNote === 'string' ? b.statusNote : ''); return }
    if (res.ok && PAGE_REASONS.includes(b.reason)) { onPageReason(b.reason); return }
    if (res.ok && b.reason === 'blocked') { setErr(typeof b.message === 'string' && b.message ? b.message : MSG.saveFailed); return }
    if (res.ok && b.reason === 'not_leader') { setErr(MSG.not_leader); return }
    if (res.ok && b.reason === 'card_not_found') { setErr(MSG.card_not_found); return }
    setErr(MSG.saveFailed)
  }

  return (
    <div className="js-ov" role="dialog" aria-modal="true" aria-label={card.name}>
      <div className="js-sheet">
        <div className="js-hdr">
          <b>{card.zone ? `${card.name} · ${card.zone}` : card.name}</b>
          <button type="button" className="js-x" aria-label="ปิด" onClick={onClose} disabled={busy}>✕</button>
        </div>
        <div className="js-k">จำนวน (PM กรอกในเว็บ)</div>
        <div className="js-card" style={{ fontVariantNumeric: 'tabular-nums' }}><b>{card.qtyText || '-'}</b></div>
        <div className="js-k">การ์ดนี้ · {card.statusText}</div>
        <div className="js-modes">
          <button type="button" className="js-mode" aria-pressed={mode === 'continue'} onClick={() => setMode('continue')}>⏳ ยังทำต่อพรุ่งนี้</button>
          {card.canClose ? (
            <button type="button" className="js-mode" aria-pressed={mode === 'done'} onClick={() => setMode('done')}>✅ เสร็จทั้งการ์ด</button>
          ) : null}
        </div>
        {!card.canClose && card.blockedText ? <div className="js-k">{card.blockedText}</div> : null}
        <div className="js-k">รูปงาน (อย่างน้อย 1 รูป)</div>
        <div className="js-shot">
          {photos.map((p) => (
            <div key={p.key} className="js-ph" style={p.preview ? { backgroundImage: `url(${p.preview})` } : undefined}>
              {p.status === 'up' ? 'กำลังส่ง…' : null}
              {p.status === 'ok' ? <button type="button" aria-label="ลบรูป" onClick={() => removePhoto(p.key)} disabled={busy}>✕</button> : null}
            </div>
          ))}
          {photos.length < MAX_PHOTOS ? (
            <>
              <label className="js-cam"><input type="file" accept="image/*" capture="environment" onChange={onFiles} aria-label="ถ่ายรูป" /><div><span>📷</span>ถ่ายรูป</div></label>
              <label className="js-cam"><input type="file" accept="image/*" multiple onChange={onFiles} aria-label="เลือกจากเครื่อง" /><div><span>🖼</span>เลือกจากเครื่อง</div></label>
            </>
          ) : null}
        </div>
        <div className="js-k">หมายเหตุ (ไม่บังคับ)</div>
        <textarea value={note} maxLength={NOTE_MAX} onChange={(e) => setNote(e.target.value)} aria-label="หมายเหตุ" />
        {err ? <div className="js-err" role="alert">{err}</div> : null}
        <button type="button" className="js-big" disabled={!canSend} onClick={send}>ส่ง</button>
      </div>
    </div>
  )
}

export default function SiteJobSheetPage({ token }) {
  const [state, setState] = useState({ phase: 'loading' }) // loading | error | ok
  const [open, setOpen] = useState(null) // card being updated (+ zone)
  const [saved, setSaved] = useState(null) // { note } after a successful card_update

  const load = useCallback(async () => {
    setState({ phase: 'loading' })
    const res = await callFn({ token, action: 'view' })
    if (res.ok && res.body.reason) { setState({ phase: 'error', msg: reasonText(res.body.reason) }); return }
    if (res.ok && res.body.ok && res.body.sheet) { setState({ phase: 'ok', sheet: res.body.sheet }); return }
    setState({ phase: 'error', msg: MSG.network, retry: true })
  }, [token])

  useEffect(() => { load() }, [load])

  const onPageReason = useCallback((reason) => {
    setOpen(null)
    setState({ phase: 'error', msg: reasonText(reason) })
  }, [])

  if (state.phase !== 'ok') {
    return (
      <div className="js">
        <style>{CSS}</style>
        <div className="js-msg">
          {state.phase === 'loading' ? <div>กำลังโหลด…</div> : null}
          {state.phase === 'error' && state.retry ? (
            <button type="button" className="js-big ghost" onClick={load}>{state.msg}</button>
          ) : null}
          {state.phase === 'error' && !state.retry ? <div role="alert">{state.msg}</div> : null}
        </div>
      </div>
    )
  }

  const sheet = state.sheet
  const leader = sheet.viewerIsLeader === true
  const problems = sheet.problems || []
  const groups = sheet.groups || []

  return (
    <div className="js">
      <style>{CSS}</style>
      <div className="js-wrap" style={saved ? { paddingBottom: 120 } : undefined}>
        <div className="js-hdr">
          <div style={{ minWidth: 0 }}>
            <div className="js-k">ใบงานติดตั้ง · {sheet.dateText}</div>
            <h3>{sheet.siteName}</h3>
          </div>
          {sheet.run ? <span className="js-day">วันที่ {sheet.run.index}/{sheet.run.total}</span> : null}
        </div>
        <RunDots run={sheet.run} />

        <div className="js-card">
          <div className="js-row">
            <span className="js-k">ที่อยู่</span> <span style={{ overflowWrap: 'anywhere' }}>{sheet.address}</span>
            {sheet.mapUrl ? <a className="js-btn" href={sheet.mapUrl} target="_blank" rel="noopener noreferrer">🗺️ แผนที่</a> : null}
          </div>
          <div><span className="js-k">หัวหน้าทีม · กะ</span> {sheet.leaderText}</div>
          <div><span className="js-k">ทีม</span> {sheet.crewText}</div>
        </div>

        <div className="js-safety">⚠️ {sheet.safetyNote}</div>

        {saved ? (
          <div className="js-ok" role="status">
            <b>{MSG.saved}</b>
            {saved.note ? <span>{saved.note}</span> : null}
            <button type="button" className="js-x" aria-label="ปิดข้อความ" onClick={() => setSaved(null)}>✕</button>
          </div>
        ) : null}

        {problems.length ? (
          <div className="js-card js-prob">
            <b>ปัญหาที่ต้องแก้</b>
            {problems.map((p) => (
              <div key={p.id} className="js-task" data-problem="">
                {/* PM-only: a warning marker, not a checkbox, so crew do not try to tick it. */}
                <span className="js-warn" aria-hidden="true">⚠️</span>
                <span className="nm">{p.name}<br /><span className="js-k">{p.zone}</span></span>
                <span />
              </div>
            ))}
          </div>
        ) : null}

        <div className="js-card">
          <div className="js-hdr">
            <b>การ์ดงาน (Kanban)</b>
            {sheet.progressText ? <span className="js-k" style={{ textAlign: 'right' }}>{sheet.progressText}</span> : null}
          </div>
          {groups.length === 0 ? <div className="js-k">ไม่มีการ์ดงาน</div> : null}
          {groups.map((g) => (
            <div key={`${g.phaseId}|${g.zone}`} style={{ display: 'grid' }}>
              <div className="js-zone">{g.phase} · {g.zone}</div>
              {g.cards.map((c) => {
                const body = (
                  <>
                    <span className={c.status === 'done' ? 'js-box done' : 'js-box'} />
                    <span className="nm">
                      {c.name}{c.mine ? <span className="js-me">ของคุณ</span> : null}
                      <br /><span className="js-k">{c.statusText}</span>
                    </span>
                    <span className="js-qty">{c.qtyText}</span>
                  </>
                )
                return leader ? (
                  <button
                    key={c.id}
                    type="button"
                    className="js-task"
                    data-card={c.id}
                    onClick={() => { setSaved(null); setOpen({ ...c, zone: g.zone }) }}
                  >{body}</button>
                ) : (
                  <div key={c.id} className="js-task" data-card={c.id}>{body}</div>
                )
              })}
            </div>
          ))}
        </div>

        <div className="js-hint">{leader ? 'กดการ์ดเพื่อแจ้งงานเสร็จหรือส่งรูปความคืบหน้า' : MSG.not_leader}</div>

        <Drawings drawings={sheet.drawings} />
      </div>
      {open ? (
        <CardSheet
          key={open.id}
          token={token}
          card={open}
          onClose={() => setOpen(null)}
          onPageReason={onPageReason}
          onSaved={(next, note) => {
            setOpen(null)
            setSaved({ note })
            setState({ phase: 'ok', sheet: next })
          }}
        />
      ) : null}
    </div>
  )
}
