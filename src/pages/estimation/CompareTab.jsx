// "เทียบราคาจริง" tab (mockup tab 5): pulls the agreed prices of the linked quotation back and compares them with the
// last sent offer. Read-only towards the estimate and the quotation; the only write is ONE appended 'agreed' snapshot
// when the button is pressed (opening the tab only ever reads).
import { useEffect, useMemo, useState } from 'react'
import { format } from 'date-fns'
import { supabase, fmt } from '../../lib/supabase.js'
import { useTenant } from '../../hooks/useTenant.js'
import { useUserRole } from '../../hooks/useUserRole.js'
import { canEditPage } from '../../lib/permissions.js'
import { canSendToQuotation } from './sendToQuotationGate.js'
import { usePriceStructure } from '../../hooks/usePriceStructure.js'
import { buildComparison, nextAgreedSubNo } from '../../lib/priceCompare.js'
import { revisionLabel } from '../../lib/quotationExport.js'

const SNAPSHOT_COLS = ['project_id', 'quotation_id', 'kind', 'revision', 'sub_no', 'price_as_of', 'factors', 'items', 'totals']
const pick = (obj, cols) => Object.fromEntries(cols.filter(c => obj[c] !== undefined).map(c => [c, obj[c]]))
const QUOTATION_COLS = 'id, status, revision, has_vat, price_includes_vat, discount_amount, discount_pct'
const ITEM_COLS = 'id, quotation_id, item_type, description, unit_price, quantity, line_total'

const f = n => (n == null || !Number.isFinite(Number(n)) ? '—' : fmt(Number(n)))
const pct = n => (n == null || !Number.isFinite(Number(n)) ? '—' : `${Number(n).toFixed(1)}%`)
const signed = n => (n == null || !Number.isFinite(Number(n)) ? '—' : Number(n) === 0 ? '—' : `${n > 0 ? '+' : ''}${fmt(Number(n))}`)
const pts = n => (n == null || !Number.isFinite(Number(n)) ? '—' : `${n > 0 ? '+' : ''}${Number(n).toFixed(1)} จุด`)
const dateOf = s => { try { return format(new Date(s), 'yyyy-MM-dd HH:mm') } catch { return '' } }
export const CONFIRM_SENT_TEXT = 'ใบเสนอราคายังไม่ได้ถูกยอมรับ ต้องการเทียบกับราคาปัจจุบันไหม'

export const snapshotLabel = s => revisionLabel(s.revision, s.sub_no)

// Latest sent snapshot of this quotation (highest revision, then sub_no).
export function lastSentSnapshot(snapshots, quotationId) {
  const sent = (snapshots || []).filter(s => s.kind === 'sent' && s.quotation_id === quotationId)
  sent.sort((a, b) => (a.revision - b.revision) || (a.sub_no - b.sub_no))
  return sent.length ? sent[sent.length - 1] : null
}

// Hook + button for Estimation.jsx: the tab exists only when the send-button gate passes and a quotation is linked.
export function useCompareAccess(project, canEdit) {
  const { hasModuleAccess } = useTenant()
  const { isAtLeast, role } = useUserRole()
  const ps = usePriceStructure(project ? project.id : null)
  const allowed = canSendToQuotation({
    canEditEstimation: canEdit, hasEstimation: hasModuleAccess('estimation'), hasQuotations: hasModuleAccess('quotations'),
    isAdmin: isAtLeast('ADMIN'), canEditQuotations: canEditPage(role, 'quotations'),
  })
  return { show: allowed && !!(ps.link && ps.link.quotation_id), ps }
}

export function CompareTabButton({ active, onClick, project, canEdit }) {
  const { show } = useCompareAccess(project, canEdit)
  if (!show) return null
  return <button type="button" className={`btn btn-sm ${active ? 'btn-primary' : 'btn-ghost'}`} onClick={onClick}>เทียบราคาจริง</button>
}

const TH = ['รายการ', 'จำนวน', 'เสนอ', 'ตกลง (ต่อชุด)', 'ส่วนลดท้ายบิล (กระจาย)', 'ตกลงจริง', 'ต่าง บาท', 'ต่าง %', 'ต้นทุนฐาน', 'กำไรที่ตั้ง', 'กำไรจริง', 'เทียบที่ตั้ง']

function ComparisonTable({ rows, extras, summary }) {
  const n = { textAlign: 'right' }
  return (
    <>
      <div style={{ overflowX: 'auto' }}>
        <table className="table" style={{ fontSize: 13 }}>
          <thead><tr>{TH.map((h, i) => <th key={h} style={i === 0 ? undefined : n}>{h}</th>)}</tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.openingId}>
                <td><b>{r.name || '—'}</b></td>
                <td style={n}>{f(r.quantity)}</td>
                <td style={n}>{f(r.offeredPrice)}</td>
                <td style={n}>{f(r.agreedUnit)}</td>
                <td style={n}>{r.discountShare ? `−${f(r.discountShare)}` : '—'}</td>
                <td style={n}><b>{f(r.agreedNet)}</b></td>
                <td style={{ ...n, color: r.diff < 0 ? 'var(--red, #c0392b)' : undefined }}>{signed(r.diff)}</td>
                <td style={n}>{pct(r.diffPct)}</td>
                <td style={n}>{f(r.costBase)}</td>
                <td style={n}>{pct(r.setProfitPct)}</td>
                <td style={n}><b>{pct(r.realProfitPct)}</b></td>
                <td style={n}>{pts(r.profitDiffPts)}</td>
              </tr>
            ))}
            {!rows.length && <tr><td colSpan={TH.length} style={{ color: 'var(--text3)' }}>ไม่มีรายการที่เทียบได้</td></tr>}
          </tbody>
        </table>
      </div>
      {extras && extras.removed && extras.removed.length > 0 && (
        <p style={{ fontSize: 12, margin: '8px 0 0' }}><b>ไม่มีในโครงสร้างราคา / ถูกลบจากใบเสนอราคา:</b> {extras.removed.map(r => r.name || r.openingId).join(', ')} (ไม่นับในการคำนวณกำไร)</p>
      )}
      {extras && extras.added && extras.added.length > 0 && (
        <p style={{ fontSize: 12, margin: '8px 0 0' }}><b>เพิ่มในใบเสนอราคา:</b> {extras.added.map(r => `${r.description || r.id} (${f(r.line_total != null ? r.line_total : Number(r.unit_price) * Number(r.quantity))})`).join(', ')} (ไม่นับในการคำนวณกำไร)</p>
      )}
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12, marginTop: 12 }}>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยอดที่เสนอ (ก่อน VAT)</div>
          <b style={{ fontSize: 18 }}>{f(summary.offeredTotal)}</b>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยอดที่ตกลงจริง (หลังส่วนลด)</div>
          <b style={{ fontSize: 18 }}>{f(summary.agreedTotal)}</b>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>ต่อรองลดไป {f(summary.offeredTotal - summary.agreedTotal)} ({pct(summary.reductionPct)})</div>
        </div>
        <div className="card" style={{ padding: 12 }}>
          <div style={{ fontSize: 12, color: 'var(--text3)' }}>กำไรทั้งโปรเจกต์: ตั้งไว้ → จริง</div>
          <b style={{ fontSize: 18 }}>{pct(summary.setProfitPct)} → {pct(summary.realProfitPct)}</b>
        </div>
      </div>
    </>
  )
}

// Presentational part (also what the smoke test renders).
export function CompareView({ quotation, shown, shownLabel, history, onPick, confirming, busy, error, notice, onPull, onConfirm, onCancel, canPull }) {
  const status = quotation ? quotation.status : null
  const accepted = status === 'accepted'
  const sentStatus = status === 'sent'
  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 12 }}>
      <h3 style={{ margin: 0 }}>หลังลูกค้าเซ็นรับ: ดึงราคาที่ตกลงกลับมาเทียบ</h3>
      <p style={{ margin: 0, fontSize: 12, color: 'var(--text3)' }}>
        ปุ่มนี้อ่านราคาต่อบรรทัดของใบที่ตกลงและส่วนลดท้ายบิล แล้วแสดงในโครงสร้างราคา ไม่แก้ตัวเลขประมาณราคา ไม่แก้ใบเสนอราคา กำไรจริงคิดจากฐานเดียวกับกำไรที่ตั้ง คือ (ราคาตกลง − (รวมต้นทุน + เผื่อเสียเศษ + ค่าขนส่ง + PM)) ÷ รวมต้นทุน
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button type="button" className="btn btn-primary btn-sm" disabled={!canPull || busy || !(accepted || sentStatus)} onClick={onPull}>ดึงราคาที่ตกลงกลับมาเทียบ</button>
        {!accepted && !sentStatus && <span style={{ fontSize: 12, color: 'var(--text3)' }}>ใช้ได้เมื่อใบเสนอราคาถูกยอมรับแล้ว</span>}
      </div>
      {confirming && (
        <div className="alert alert-warning" style={{ fontSize: 13 }}>
          {CONFIRM_SENT_TEXT}
          <div style={{ display: 'flex', gap: 8, marginTop: 8 }}>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={onConfirm}>เทียบกับราคาปัจจุบัน</button>
            <button type="button" className="btn btn-ghost btn-sm" disabled={busy} onClick={onCancel}>ยกเลิก</button>
          </div>
        </div>
      )}
      {error && <div className="alert alert-danger" style={{ fontSize: 13 }}>{error}</div>}
      {notice && <div style={{ fontSize: 12, color: 'var(--text3)' }}>{notice}</div>}
      {history && history.length > 0 && (
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap', fontSize: 12 }}>
          <span style={{ color: 'var(--text3)' }}>ผลเทียบที่เก็บไว้:</span>
          {history.map(s => (
            <button key={s.id} type="button" className="btn btn-ghost btn-sm" onClick={() => onPick && onPick(s.id)}>{dateOf(s.created_at)} · {snapshotLabel(s)}</button>
          ))}
        </div>
      )}
      {shown
        ? <>
            {shownLabel && <div style={{ fontSize: 12, color: 'var(--text3)' }}>{shownLabel}</div>}
            <ComparisonTable rows={shown.rows || []} extras={shown.extras} summary={shown.summary || {}} />
          </>
        : <div style={{ fontSize: 13, color: 'var(--text3)' }}>ยังไม่เคยดึงราคาที่ตกลง</div>}
    </div>
  )
}

export default function CompareTab({ project, canEdit }) {
  const { show, ps } = useCompareAccess(project, canEdit)
  const quotationId = ps.link ? ps.link.quotation_id : null
  const [quotation, setQuotation] = useState(null)
  const [fresh, setFresh] = useState(null)       // { rows, extras, summary, label } from a pull in this session
  const [pickedId, setPickedId] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')

  useEffect(() => {
    if (!quotationId) { setQuotation(null); return }
    let alive = true
    supabase.from('quotations').select(QUOTATION_COLS).eq('id', quotationId).maybeSingle().then(({ data, error: e }) => {
      if (!alive) return
      if (e) setError(e.message || 'อ่านใบเสนอราคาไม่สำเร็จ')
      else setQuotation(data || null)
    })
    return () => { alive = false }
  }, [quotationId])

  const history = useMemo(() => (ps.snapshots || []).filter(s => s.kind === 'agreed' && s.quotation_id === quotationId).slice().reverse(), [ps.snapshots, quotationId])
  const stored = useMemo(() => {
    const s = history.find(h => h.id === pickedId) || history[0]
    if (!s) return null
    const t = s.totals || {}
    return { rows: s.items || [], extras: t.extras || { removed: [], added: [] }, summary: t, label: `${dateOf(s.created_at)} · ${snapshotLabel(s)} (ที่เก็บไว้)` }
  }, [history, pickedId])
  const shown = fresh || stored

  if (!show) return null

  async function run() {
    setBusy(true); setError(''); setNotice(''); setConfirming(false)
    try {
      const q = await supabase.from('quotations').select(QUOTATION_COLS).eq('id', quotationId).single()
      if (q.error) throw q.error
      const it = await supabase.from('quotation_items').select(ITEM_COLS).eq('quotation_id', quotationId)
      if (it.error) throw it.error
      const sent = lastSentSnapshot(ps.snapshots, quotationId)
      const cmp = buildComparison({ snapshot: sent, quotation: q.data, lines: ps.lines, quotationItems: it.data || [] })
      if (!cmp) { setError('ยังไม่เคยส่งราคาไปใบเสนอราคา จึงไม่มีราคาที่เสนอไว้ให้เทียบ'); return }
      const revision = q.data.revision || 1
      const subNo = nextAgreedSubNo(ps.snapshots, quotationId, revision)
      const row = pick({
        project_id: project.id, quotation_id: quotationId, kind: 'agreed', revision, sub_no: subNo,
        price_as_of: sent.price_as_of || null, factors: sent.factors || {}, items: cmp.rows,
        totals: { ...cmp.summary, extras: cmp.extras },
      }, SNAPSHOT_COLS)
      const ins = await supabase.from('estimation_price_snapshots').insert(row)
      if (ins.error) throw ins.error
      setQuotation(q.data)
      setFresh({ ...cmp, label: `เทียบเมื่อสักครู่ · ${snapshotLabel({ revision, sub_no: subNo })}` })
      setPickedId(null)
      setNotice(`เก็บผลเทียบเป็น ${snapshotLabel({ revision, sub_no: subNo })} แล้ว`)
      if (ps.refetch) await ps.refetch()
    } catch (e) {
      setError(`เทียบราคาไม่สำเร็จ: ${(e && e.message) || e}`)
    } finally { setBusy(false) }
  }
  const onPull = () => { if (quotation && quotation.status === 'sent') setConfirming(true); else run() }
  return (
    <CompareView quotation={quotation} shown={shown} shownLabel={shown ? shown.label : ''} history={history}
      onPick={id => { setFresh(null); setPickedId(id) }} confirming={confirming} busy={busy} error={error} notice={notice}
      onPull={onPull} onConfirm={run} onCancel={() => setConfirming(false)} canPull={!!quotation} />
  )
}
