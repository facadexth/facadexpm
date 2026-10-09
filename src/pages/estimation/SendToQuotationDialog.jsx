// "ส่งไปใบเสนอราคา" / "อัปเดตราคาไปใบเสนอราคา" dialog (mockup tab 2 + 4). Builds the lines, shows what will be
// created / updated and the label it will be sent as, then runs pushToQuotation. No confirm()/alert().
import { useState, useEffect, useMemo } from 'react'
import { format, addDays } from 'date-fns'
import { supabase } from '../../lib/supabase.js'
import { useClients } from '../../hooks/useSupabase.js'
import { Modal } from '../../components/Modal.jsx'
import { buildLines, revisionLabel, compareWithLastSent } from '../../lib/quotationExport.js'
import { preparePlan, loadLinkedQuotation, pushToQuotation, buildSnapshotPayload } from '../../lib/estimationQuotationApi.js'
import { projectFactors } from '../../lib/priceStructureInputs.js'

export const DEFAULT_VALID_DAYS = 30
const STATUS_TH = { draft: 'ร่าง', sent: 'ส่งแล้ว', accepted: 'ลูกค้ารับแล้ว', rejected: 'ถูกปฏิเสธ', expired: 'หมดอายุ' }

const Check = ({ checked, disabled, onChange, children }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer', fontSize: 13 }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    {children}
  </label>
)

export const unresolvedMessage = skipped =>
  `มี ${skipped.length} รายการที่คิดราคาไม่ได้ (${skipped.map(s => s.opening_no || '—').join(', ')}) ต้องแก้ให้คิดได้ก่อน หรือติ๊ก "ข้ามรายการที่คิดไม่ได้"`

// Inline second step shown when the quotation is already accepted (invoices may reference its lines).
export function AcceptedConfirm({ label, busy, onConfirm, onBack }) {
  return (
    <div className="alert alert-warning" style={{ fontSize: 13 }}>
      <b>ยืนยันอีกครั้ง:</b> ใบเสนอราคานี้ลูกค้ารับแล้ว และอาจมีใบแจ้งหนี้อ้างอิงบรรทัดอยู่ การอัปเดตจะดึงใบกลับเป็นร่างและเขียนทับราคาเป็น {label} (บรรทัดที่มีใบแจ้งหนี้อ้างอิงจะไม่ถูกลบ)
      <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onConfirm}>{busy ? 'กำลังบันทึก...' : 'ยืนยันอัปเดต'}</button>
        <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onBack}>ย้อนกลับ</button>
      </div>
    </div>
  )
}

// props: project, items (openings), result (priceProject output), descriptionCtxById, link, snapshots, tenant,
// onClose, onDone(label). preloaded = { quotation, plan } is for tests only (skips the database reads).
export default function SendToQuotationDialog({ project, items, result, descriptionCtxById, link: linkProp, snapshots, tenant, onClose, onDone, clients: clientsProp, preloaded }) {
  const clientsQ = useClients()
  const clients = clientsProp || clientsQ.data || []
  const today = format(new Date(), 'yyyy-MM-dd')
  const [link, setLink] = useState(linkProp || null)   // re-read from the database on open and on submit

  const [quotation, setQuotation] = useState(preloaded ? preloaded.quotation : null)
  const [plan, setPlan] = useState(preloaded ? preloaded.plan : null)
  const [loading, setLoading] = useState(!preloaded)
  const [clientId, setClientId] = useState('')
  const [siteName, setSiteName] = useState('')
  const [date, setDate] = useState(today)
  const [validDays, setValidDays] = useState(String(DEFAULT_VALID_DAYS))
  const [attachOn, setAttachOn] = useState(link ? link.attach_enabled !== false : true)
  const [attachMode, setAttachMode] = useState((link && link.attach_mode) || 'pages')
  const [attachView, setAttachView] = useState((link && link.attach_view) || 'both')
  const [splitOn, setSplitOn] = useState(!!(link && link.split_enabled))
  const [splitPct, setSplitPct] = useState(String(link && link.split_material_pct != null ? link.split_material_pct : 80))
  const [skipUnresolved, setSkipUnresolved] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [doneLabel, setDoneLabel] = useState(null)

  const isExisting = !!quotation
  const effectiveSplit = isExisting ? quotation.pricing_mode === 'split' : splitOn
  const pctNum = Number(splitPct)
  const pctOk = splitPct !== '' && Number.isFinite(pctNum) && pctNum >= 0 && pctNum <= 100

  const { lines, skipped } = useMemo(() => buildLines({
    rows: result.rows, items, descriptionCtxById, descriptionFormat: project.description_format,
    split: { enabled: effectiveSplit, materialPct: pctOk ? pctNum : 80 },
  }), [result, items, descriptionCtxById, project.description_format, effectiveSplit, pctOk, pctNum])

  // Read the linked quotation (if any) once, then the plan for the preview.
  useEffect(() => {
    if (preloaded) return undefined
    let alive = true
    ;(async () => {
      try {
        const { link: l, quotation: q } = await loadLinkedQuotation({ supabase, project })
        const p = await preparePlan({ supabase, project, quotation: q, newLines: lines })
        if (alive) { setLink(l); setQuotation(q); setPlan(p) }
      } catch (e) { if (alive) setError(e.message || String(e)) }
      finally { if (alive) setLoading(false) }
    })()
    return () => { alive = false }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const lastSnap = useMemo(() => {
    if (!quotation) return null
    const sent = (snapshots || []).filter(s => s.kind === 'sent' && s.quotation_id === quotation.id)
    return sent[sent.length - 1] || null
  }, [quotation, snapshots])
  const lastLabel = lastSnap ? revisionLabel(lastSnap.revision, lastSnap.sub_no) : null
  const comparison = useMemo(() => (isExisting ? compareWithLastSent({ snapshot: lastSnap, rows: result.rows, items }) : null), [isExisting, lastSnap, result, items])
  const totalBeforeVat = lines.reduce((s, l) => s + l.item.line_total, 0)
  const signed = n => (n > 0 ? '+' : '') + Number(n).toLocaleString('th-TH')
  const nextLabel = plan ? revisionLabel(plan.newRevision, plan.subNo) : (isExisting ? null : 'R1-1')

  const actionOf = useMemo(() => {
    const m = {}
    if (plan) { plan.updates.forEach(u => { m[u.openingId] = 'update' }); plan.inserts.forEach(i => { if (!m[i.openingId]) m[i.openingId] = 'create' }) }
    return m
  }, [plan])
  const noPreview = useMemo(() => {
    const ids = new Set(lines.map(l => l.openingId))
    return (items || []).filter(i => ids.has(i.id) && !i.preview_svg_out)
  }, [lines, items])
  const itemNo = id => ((items || []).find(i => i.id === id) || {}).opening_no || '—'

  const blockedByUnresolved = skipped.length > 0 && !skipUnresolved
  const missingCustomer = !isExisting && !clientId
  const canSubmit = !busy && !loading && !doneLabel && !missingCustomer && !blockedByUnresolved && lines.length > 0 && (!effectiveSplit || pctOk) && !!plan

  const submit = async () => {
    setBusy(true); setError(null)
    try {
      // Re-read everything now: the quotation may have changed since the dialog opened.
      const { link: freshLink, quotation: q } = await loadLinkedQuotation({ supabase, project })
      if (!q && !clientId) throw new Error('ใบเสนอราคาเดิมถูกลบไปแล้ว กรุณาเลือกลูกค้าเพื่อสร้างใบใหม่')
      const fresh = await preparePlan({ supabase, project, quotation: q, newLines: lines })
      setLink(freshLink); setQuotation(q); setPlan(fresh)
      if (fresh.needsAcceptedConfirm && !confirming) { setConfirming(true); return }
      const r = await pushToQuotation({
        supabase, project, link: freshLink, quotation: q, plan: fresh, lines, tenant,
        header: {
          client_id: clientId, site_name: siteName.trim(), date, validDays,
          attach_enabled: attachOn, attach_mode: attachMode, attach_view: attachView,
          split_enabled: q ? q.pricing_mode === 'split' : splitOn, split_material_pct: pctOk ? pctNum : 80,
        },
        snapshotPayload: buildSnapshotPayload({ result, items, factors: projectFactors(project) }),
      })
      setDoneLabel(r.label); setConfirming(false)
      if (onDone) await onDone(r.label)
    } catch (e) {
      setError(e && e.message ? e.message : String(e)); setConfirming(false)
    } finally { setBusy(false) }
  }

  const validUntil = (() => { const n = parseInt(validDays, 10); try { return date && Number.isFinite(n) ? format(addDays(new Date(date), n), 'yyyy-MM-dd') : '' } catch { return '' } })()

  return (
    <Modal title={isExisting ? 'อัปเดตราคาไปใบเสนอราคา' : 'ส่งไปใบเสนอราคา'} onClose={() => (busy ? false : onClose())} maxWidth={820}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {doneLabel ? (
          <div className="alert alert-success" style={{ fontSize: 14 }}>ส่งเป็น <b>{doneLabel}</b> เรียบร้อย ใบเสนอราคาอยู่ในสถานะร่าง เปิดดูและส่งต่อได้ที่หน้าใบเสนอราคา</div>
        ) : (
          <>
            {loading && <div style={{ color: 'var(--text3)', fontSize: 13 }}>กำลังโหลดข้อมูลใบเสนอราคา...</div>}
            {isExisting ? (
              <div className="alert" style={{ fontSize: 13 }}>
                ใบเสนอราคา <b className="font-mono">{quotation.quotation_number || ''}</b> · ลูกค้า {quotation.clients ? quotation.clients.name : '—'} · ไซต์ {quotation.site_name || '—'} · สถานะ <b>{STATUS_TH[quotation.status] || quotation.status}</b>
                {lastLabel && <> · ส่งล่าสุด <b>{lastLabel}</b></>}
              </div>
            ) : (
              <>
                <div style={{ fontSize: 12, color: 'var(--text3)' }}>สร้างใบเสนอราคาเป็นร่าง 1 รายการต่อ 1 ชุด ผูกโปรเจกต์กับใบนี้ ส่งครั้งต่อไปจะอัปเดตเฉพาะบรรทัดที่ระบบสร้าง</div>
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                  <div>
                    <label className="label">ลูกค้า *</label>
                    <select className="input" value={clientId} onChange={e => setClientId(e.target.value)}>
                      <option value="">— เลือกลูกค้า —</option>
                      {clients.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
                    </select>
                  </div>
                  <div>
                    <label className="label">ไซต์งาน</label>
                    <input className="input" value={siteName} onChange={e => setSiteName(e.target.value)} placeholder="ชื่อไซต์งาน (ไม่บังคับ)" />
                  </div>
                  <div>
                    <label className="label">วันที่เอกสาร</label>
                    <input className="input" type="date" value={date} onChange={e => setDate(e.target.value)} />
                  </div>
                  <div>
                    <label className="label">ยืนราคา (วัน)</label>
                    <input className="input" type="number" min="0" value={validDays} onChange={e => setValidDays(e.target.value)} />
                    {validUntil && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>ยืนราคาถึง {validUntil}</div>}
                  </div>
                </div>
              </>
            )}

            <div className="alert alert-success" style={{ fontSize: 13 }}>
              ราคาล็อกตามวันที่ราคาโปรเจกต์ <b className="font-mono">{project.price_as_of || '—'}</b>{!isExisting && validDays !== '' && <> ใบเสนอราคาจะยืนราคา {validDays} วัน</>}
            </div>

            <div style={{ display: 'grid', gap: 8 }}>
              <Check checked={attachOn} onChange={setAttachOn}>แนบแบบท้ายใบเสนอราคา</Check>
              {attachOn && (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                  <div>
                    <label className="label">รูปแบบการแนบ</label>
                    <select className="input" value={attachMode} onChange={e => setAttachMode(e.target.value)}>
                      <option value="pages">หน้าแยกท้ายเอกสาร (ภาพใหญ่ รายการละภาพ)</option>
                      <option value="thumb" disabled>ภาพเล็กในบรรทัดรายการ (เร็วๆ นี้)</option>
                      <option value="both" disabled>ทั้งสองแบบ (เร็วๆ นี้)</option>
                    </select>
                    <div className="attach-mode-soon" style={{ fontSize: 12, color: 'var(--text-muted, #6a6f85)', marginTop: 4 }}>ภาพเล็กในบรรทัดรายการ: เร็วๆ นี้ ตอนนี้แนบได้เฉพาะหน้าแยกท้ายเอกสาร</div>
                  </div>
                  <div>
                    <label className="label">มุมมอง</label>
                    <select className="input" value={attachView} onChange={e => setAttachView(e.target.value)}>
                      <option value="both">ภายนอกและภายใน</option>
                      <option value="out">ภายนอกอย่างเดียว</option>
                      <option value="in">ภายในอย่างเดียว</option>
                    </select>
                  </div>
                </div>
              )}
            </div>

            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <Check checked={effectiveSplit} disabled={isExisting} onChange={setSplitOn}>แยกค่าของ/ค่าแรง</Check>
              <span style={{ fontSize: 13, display: 'inline-flex', alignItems: 'center', gap: 4 }}>
                ค่าของ
                <input className="input" type="number" min="0" max="100" style={{ width: 70 }} disabled={!effectiveSplit} value={splitPct} onChange={e => setSplitPct(e.target.value)} />
                % / ค่าแรง {pctOk ? 100 - pctNum : '—'} %
              </span>
              {isExisting && <span style={{ fontSize: 11, color: 'var(--text3)' }}>รูปแบบราคาตามใบเสนอราคาที่สร้างไว้แล้ว</span>}
              {effectiveSplit && !pctOk && <span style={{ fontSize: 12, color: 'var(--red)' }}>ใส่เปอร์เซ็นต์ 0 ถึง 100</span>}
            </div>

            <div>
              <div className="label">บรรทัดที่จะ{isExisting ? 'สร้าง / อัปเดต' : 'สร้าง'} ({lines.length} รายการ)</div>
              <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                <table style={{ width: '100%', fontSize: 12.5 }}>
                  <thead><tr><th style={{ textAlign: 'left', padding: 6 }}>รายการ</th><th style={{ textAlign: 'right', padding: 6 }}>จำนวน</th><th style={{ textAlign: 'right', padding: 6 }}>ราคา/ชุด</th><th style={{ padding: 6 }}>การทำงาน</th></tr></thead>
                  <tbody>
                    {lines.map(l => (
                      <tr key={l.openingId}>
                        <td style={{ padding: 6 }}>{l.item.description}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{l.item.quantity}</td>
                        <td style={{ padding: 6, textAlign: 'right' }}>{Number(l.item.unit_price).toLocaleString('th-TH')}</td>
                        <td style={{ padding: 6, textAlign: 'center' }}>{actionOf[l.openingId] === 'update' ? 'อัปเดต' : 'สร้างใหม่'}</td>
                      </tr>
                    ))}
                    {plan && plan.keeps.map(k => (
                      <tr key={'k' + k.openingId} style={{ color: 'var(--text3)' }}>
                        <td style={{ padding: 6 }} colSpan={3}>{itemNo(k.openingId)} · {k.reason}</td><td style={{ padding: 6, textAlign: 'center' }}>เก็บไว้</td>
                      </tr>
                    ))}
                    {plan && plan.deletes.length > 0 && (
                      <tr style={{ color: 'var(--text3)' }}><td style={{ padding: 6 }} colSpan={3}>รายการที่ถูกลบออกจากโปรเจกต์ ({plan.deletes.length} บรรทัด)</td><td style={{ padding: 6, textAlign: 'center' }}>ลบ</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
              <div style={{ fontSize: 13, marginTop: 6, fontWeight: 600 }}>รวม (ก่อน VAT) <span className="font-mono">{Number(totalBeforeVat).toLocaleString('th-TH')}</span> บาท</div>
              <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>เขียนลงเฉพาะใบเสนอราคาของโปรเจกต์นี้ ลูกค้าที่ไม่มีโมดูลประเมินราคาไม่เห็นปุ่มนี้และไม่มีอะไรเปลี่ยน</div>
              <div style={{ fontSize: 13, marginTop: 6 }}>
                {lastLabel && <>ล่าสุด <b>{lastLabel}</b> · </>}จะส่งเป็น <b>{nextLabel || '—'}</b>
              </div>
            </div>

            {comparison && lastSnap && (
              <div>
                <div className="label">เปรียบเทียบกับที่ส่งล่าสุด ({lastLabel})</div>
                <div style={{ maxHeight: 220, overflow: 'auto', border: '1px solid var(--border)', borderRadius: 6 }}>
                  <table style={{ width: '100%', fontSize: 12.5 }}>
                    <thead><tr><th style={{ textAlign: 'left', padding: 6 }}>รายการ</th><th style={{ textAlign: 'right', padding: 6 }}>ราคาเดิม ({lastLabel})</th><th style={{ textAlign: 'right', padding: 6 }}>ราคาใหม่ ({nextLabel})</th><th style={{ textAlign: 'right', padding: 6 }}>ต่าง</th><th style={{ textAlign: 'right', padding: 6 }}>ต่าง %</th></tr></thead>
                    <tbody>
                      {comparison.rows.map(r => (
                        <tr key={r.openingId}>
                          <td style={{ padding: 6 }}>{r.opening_no || '—'}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{r.oldPrice == null ? '—' : Number(r.oldPrice).toLocaleString('th-TH')}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{Number(r.newPrice).toLocaleString('th-TH')}</td>
                          <td style={{ padding: 6, textAlign: 'right', color: r.diff < 0 ? 'var(--red)' : undefined }}>{r.diff == null ? 'ใหม่' : r.diff === 0 ? '—' : signed(r.diff)}</td>
                          <td style={{ padding: 6, textAlign: 'right' }}>{r.pct == null || r.diff === 0 ? '—' : `${r.pct > 0 ? '+' : ''}${r.pct.toFixed(1)}%`}</td>
                        </tr>
                      ))}
                    </tbody>
                    <tfoot><tr style={{ fontWeight: 700 }}>
                      <td style={{ padding: 6 }}>รวม (ก่อน VAT)</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{Number(comparison.oldTotal).toLocaleString('th-TH')}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{Number(comparison.newTotal).toLocaleString('th-TH')}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{comparison.diffTotal === 0 ? '—' : signed(comparison.diffTotal)}</td>
                      <td style={{ padding: 6, textAlign: 'right' }}>{comparison.oldTotal > 0 && comparison.diffTotal !== 0 ? `${comparison.diffTotal > 0 ? '+' : ''}${(comparison.diffTotal / comparison.oldTotal * 100).toFixed(1)}%` : '—'}</td>
                    </tr></tfoot>
                  </table>
                </div>
              </div>
            )}
            {plan && plan.bumpRevision && (
              <div className="alert alert-warning" style={{ fontSize: 13 }}>
                ใบนี้{STATUS_TH[quotation.status] ? `อยู่ในสถานะ "${STATUS_TH[quotation.status]}"` : 'ส่งไปแล้ว'} จะถูกดึงกลับเป็นร่างและนับเป็น revision {plan.newRevision} ภาพของ revision ปัจจุบันถูกเก็บในประวัติ
                {plan.statusWarning && ` (สถานะเดิมคือ ${STATUS_TH[quotation.status] || quotation.status})`}
              </div>
            )}
            {noPreview.length > 0 && (
              <div className="alert alert-warning" style={{ fontSize: 13 }}>
                มี {noPreview.length} รายการที่ยังไม่ได้บันทึกภาพตัวอย่าง ({noPreview.map(i => i.opening_no || '—').join(', ')}) จะส่งโดยไม่มีหน้าแนบของรายการนั้น
              </div>
            )}
            {skipped.length > 0 && (
              <div className="alert alert-error" style={{ fontSize: 13 }}>
                <div>{unresolvedMessage(skipped)}</div>
                <div style={{ marginTop: 6 }}><Check checked={skipUnresolved} onChange={setSkipUnresolved}>ข้ามรายการที่คิดไม่ได้</Check></div>
              </div>
            )}
            {confirming && plan && plan.needsAcceptedConfirm && <AcceptedConfirm label={revisionLabel(plan.newRevision, plan.subNo)} busy={busy} onConfirm={submit} onBack={() => setConfirming(false)} />}
            {error && <div className="alert alert-error" style={{ fontSize: 13 }}>{error}</div>}
          </>
        )}
      </div>
      <div className="modal-footer">
        {doneLabel ? (
          <button type="button" className="btn btn-primary" onClick={onClose}>ปิด</button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={onClose}>ยกเลิก</button>
            {!confirming && (
              <button type="button" className="btn btn-primary" disabled={!canSubmit} onClick={submit}>
                {busy ? 'กำลังบันทึก...' : isExisting ? (plan && plan.bumpRevision ? 'ดึงกลับเป็นร่างและอัปเดตราคา' : 'อัปเดตราคา') : 'สร้างใบเสนอราคาร่าง'}
              </button>
            )}
          </>
        )}
      </div>
    </Modal>
  )
}
