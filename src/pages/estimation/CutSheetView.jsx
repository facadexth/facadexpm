// src/pages/estimation/CutSheetView.jsx
// "ใบตัด — แยกตามหน้าตัด": every bar of the cut plan drawn to scale, stock offcuts first, identical new bars on one
// row. Before issue it shows the live plan; after issue it shows the frozen snapshot (alu_cut_plans.plan) and warns
// when the items have changed since. Issue / void are confirmed inline; the parent does the writes.
import { useState } from 'react'
import { fmtDate } from '../../lib/supabase.js'
import { groupIdenticalBars } from '../../lib/cutPlan.js'
import { barNosLabel, openingColorIndex } from './projectBomHelpers.js'

// Remainders under 50 mm are saw loss (same threshold as cutPlan.js buildCutPlan): drawn, never labelled.
const SAW_LOSS_M = 0.05
const PALETTE = ['#a8b5e8', '#f0a08c', '#8fd0c8', '#c9c27a', '#d3a8e0', '#9cc7f0', '#f2c38f', '#b5d99c']
const mm = m => String(Math.round(Number(m) * 1000))
const f2 = n => Number(n).toFixed(2)
const muted = { fontSize: 12, color: 'var(--text3)' }
const hatch = 'repeating-linear-gradient(45deg, var(--bg4), var(--bg4) 4px, transparent 4px, transparent 8px)'
const keepFill = 'rgba(var(--green-rgb), 0.35)'
const tag = { fontSize: 11, padding: '1px 6px', borderRadius: 4, fontWeight: 600 }

function BarRow({ bar, label, fullLength, colorOf, minKeep, fromStock }) {
  const L = Number(bar.length_m)
  const left = Number(bar.left_m)
  const keep = left + 1e-9 >= minKeep
  const labelled = left + 1e-9 >= SAW_LOSS_M
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(90px, 140px) 1fr 70px', gap: 8, alignItems: 'center' }}>
      <div style={{ fontSize: 12 }}>{label}</div>
      <div style={{
        display: 'flex', height: 34, border: '1px solid var(--text)', borderRadius: 3, overflow: 'hidden', minWidth: 0,
        maxWidth: `${(100 * L) / fullLength}%`, ...(fromStock ? { outline: '3px solid var(--yellow)', outlineOffset: -3 } : {}),
      }}>
        {bar.pieces.map((p, i) => (
          <div key={i} title={`${p.opening_no} ${p.role_name}${p.item_name ? ` · ${p.item_name}` : ''}`} style={{
            flex: `0 0 ${(100 * p.length_m) / L}%`, background: PALETTE[colorOf(p.opening_no) % PALETTE.length], color: '#1d2420',
            borderRight: '2px solid var(--text)', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center',
            fontSize: 11, lineHeight: 1.15, overflow: 'hidden', minWidth: 0, textAlign: 'center', padding: '0 2px', whiteSpace: 'nowrap',
          }}>
            <b className="font-mono">{mm(p.length_m)}</b><span>{p.opening_no} {p.role_name}</span>
          </div>
        ))}
        {left > 1e-9 && (
          <div style={{ flex: '1 1 auto', background: keep ? keepFill : hatch, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 11, color: keep ? 'var(--text)' : 'var(--text3)', overflow: 'hidden', minWidth: 0 }}>
            {labelled && left / L > 0.045 ? mm(left) : ''}
          </div>
        )}
      </div>
      <div className="font-mono" style={{ fontSize: 12, textAlign: 'right' }}>{labelled ? `เศษ ${mm(left)}` : ''}</div>
    </div>
  )
}

function GroupSheet({ g, colorOf, minKeep }) {
  const L = Number(g.length_m)
  const rows = groupIdenticalBars(g.bars)
  return (
    <div style={{ display: 'grid', gap: 8, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div>
          {g.die_no ? <b className="font-mono">{g.die_no}</b> : null}{g.die_no ? ' · ' : ''}{g.name || '?'}{g.finish_name ? ` · ${g.finish_name}` : ''} · เส้น <b className="font-mono">{f2(L)}</b> ม.
          {g.custom && <> <span style={{ ...tag, background: 'rgba(255,209,102,0.2)', color: 'var(--yellow)' }}>สั่งพิเศษ</span></>}
        </div>
        <div className="font-mono" style={muted}>
          {g.offcutBars.length > 0 ? `เศษสต็อก ${g.offcutBars.length} + ` : ''}{g.bars.length} เส้นใหม่{g.no_weight ? '' : ` · ${f2(g.kg)} กก.`}
        </div>
      </div>
      {g.offcutBars.map(b => (
        <BarRow key={b.offcut.id} bar={b} fullLength={L} colorOf={colorOf} minKeep={minKeep} fromStock
          label={<><span style={{ ...tag, background: 'var(--yellow)', color: '#1d2420' }}>{b.offcut.code}</span> <span className="font-mono">{mm(b.length_m)}</span></>} />
      ))}
      {rows.map(r => (
        <BarRow key={r.nos[0]} bar={r.bar} fullLength={L} colorOf={colorOf} minKeep={minKeep} label={barNosLabel(r.nos)} />
      ))}
      {g.unplaced.length > 0 && (
        <div style={{ fontSize: 12, color: 'var(--red)' }}>
          ตัดไม่ได้ — ยาวเกินเส้น: {g.unplaced.map((p, i) => <span key={i}>{i ? ', ' : ''}{p.opening_no} {p.role_name} <span className="font-mono">{mm(p.length_m)}</span></span>)}
        </div>
      )}
    </div>
  )
}

export default function CutSheetView({ plan, issued, settings, canEdit, onIssue, onVoid, busy }) {
  const [confirming, setConfirming] = useState(null) // 'issue' | 'void' | null
  const shown = issued ? issued.plan : plan
  const colors = openingColorIndex(shown)
  const colorOf = no => colors.get(no) ?? 0
  const minKeep = Number(settings.min_keep_offcut_m)
  const mismatch = !!issued && !!plan && issued.signature !== plan.signature
  const hasUnplaced = !plan || plan.groups.some(g => g.unplaced.length > 0)
  const run = async fn => { try { await fn() } finally { setConfirming(null) } }

  return (
    <div className="card" style={{ padding: 16, display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <div style={{ fontWeight: 700 }}>ใบตัด — แยกตามหน้าตัด</div>
        <span style={muted}>เศษสต็อกตัดก่อน แล้วค่อยเส้นใหม่ · เส้นที่ตัดเหมือนกันรวมแถว · ตัวเลข = มม.</span>
      </div>

      {issued ? (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className="badge badge-ongoing">ยืนยันแล้ว {fmtDate(issued.issued_at)}</span>
          {canEdit && confirming !== 'void' && <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming('void')}>ยกเลิกใบตัด</button>}
        </div>
      ) : canEdit && confirming !== 'issue' && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || hasUnplaced} onClick={() => setConfirming('issue')}>ยืนยันใบตัด (ตัดเศษสต็อก + สร้างสติกเกอร์)</button>
          {plan && hasUnplaced && <span style={{ fontSize: 12, color: 'var(--red)' }}>มีท่อนที่ตัดไม่ได้ — แก้ก่อนยืนยัน</span>}
        </div>
      )}
      {confirming === 'issue' && (
        <div className="alert alert-info" style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>ยืนยันใบตัดนี้? เศษสต็อกที่ใช้จะถูกตัดออกจากสต็อก และเศษที่เก็บจะเข้าสต็อก</span>
          <button type="button" className="btn btn-primary btn-sm" disabled={busy || hasUnplaced} onClick={() => run(onIssue)}>{busy ? 'กำลังบันทึก...' : 'ยืนยัน'}</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>ไม่ใช่</button>
        </div>
      )}
      {confirming === 'void' && (
        <div className="alert alert-warning" style={{ fontSize: 13, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <span>ยกเลิกใบตัดนี้? เศษสต็อกที่ใช้จะกลับเข้าสต็อก และเศษที่ใบนี้สร้างจะถูกนำออก</span>
          <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => run(onVoid)}>{busy ? 'กำลังบันทึก...' : 'ยกเลิกใบตัด'}</button>
          <button type="button" className="btn btn-sm btn-ghost" disabled={busy} onClick={() => setConfirming(null)}>ไม่ใช่</button>
        </div>
      )}
      {mismatch && <div className="alert alert-warning" style={{ fontSize: 13 }}>ใบตัดไม่ตรงกับรายการปัจจุบัน — ยกเลิกแล้วยืนยันใหม่ถ้าต้องการใบตัดตามรายการล่าสุด</div>}

      {!shown ? <div style={muted}>กำลังคำนวณ...</div> : (
        <>
          <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', fontSize: 12 }}>
            {[...colors.keys()].map(no => (
              <span key={no} style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><i style={{ width: 14, height: 14, border: '1px solid var(--text)', background: PALETTE[colorOf(no) % PALETTE.length] }} />{no}</span>
            ))}
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><i style={{ width: 14, height: 14, border: '1px solid var(--text)', background: 'var(--yellow)' }} />เศษจากสต็อก</span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><i style={{ width: 14, height: 14, border: '1px solid var(--text)', background: keepFill }} />เศษเก็บใช้ต่อ (≥ {mm(minKeep)})</span>
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}><i style={{ width: 14, height: 14, border: '1px solid var(--text)', background: hatch }} />เศษทิ้ง</span>
          </div>
          {shown.groups.length === 0
            ? <div style={muted}>ไม่มีเส้นอลูมิเนียมที่ต้องตัด</div>
            : shown.groups.map(g => <GroupSheet key={g.key} g={g} colorOf={colorOf} minKeep={minKeep} />)}
        </>
      )}
    </div>
  )
}
