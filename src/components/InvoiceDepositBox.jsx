// "หักมัดจำสำหรับใบนี้" -- the deposit box of the create-invoice form. State lives in useDepositChoiceState (called at
// the top of the form, before its early returns); the box itself is presentational plus its own input handlers.
import { useState } from 'react'
import { fmt } from '../lib/supabase.js'
import { round2 } from '../lib/depositCalc.js'
import { resolveDepositChoice, cleanDecimalText, fullDepositAmount } from '../lib/invoiceDeposit.js'

/** mode/text are null until the user touches them -> fall back to the site's default % (or "none" without one). */
export function useDepositChoiceState(siteDepositPct) {
  const [modeRaw, setMode] = useState(null)
  const [textRaw, setText] = useState(null)
  const [warned, setWarned] = useState(false)
  const mode = modeRaw ?? (siteDepositPct > 0 ? 'pct' : 'none')
  const text = textRaw ?? (mode === 'pct' ? String(siteDepositPct) : '')
  return { mode, text, warned, setMode, setText, setWarned }
}

const MODES = [['none', 'ไม่หัก'], ['pct', 'หักเป็น %'], ['value', 'หักเป็นมูลค่า']]

export default function InvoiceDepositBox({ choice, subtotal, vat, total, taxOffset, whtPct, retentionPct, balance, siteDepositPct }) {
  const { mode, text, warned, setMode, setText, setWarned } = choice
  const dep = resolveDepositChoice({ subtotal, mode, text, balance })
  const onInput = (raw) => {
    const typed = cleanDecimalText(raw)
    const r = resolveDepositChoice({ subtotal, mode, text: typed, balance })
    setMode(mode)
    setText(r.over ? r.cappedText : typed)
    setWarned(r.over)
  }
  const pickMode = (m) => { setMode(m); setText(m === 'pct' ? String(siteDepositPct || '') : ''); setWarned(false) }
  const takeAll = () => { setMode('value'); setText(String(fullDepositAmount(subtotal, balance))); setWarned(false) }

  // same formula as handleMarkPaid: the tax base excludes the slice already taxed on the deposit invoice(s)
  const whtBase = Math.max(0, subtotal - (taxOffset || 0))
  const wht = round2(whtBase * (whtPct || 0) / 100)
  const retention = round2(subtotal * (retentionPct || 0) / 100)
  const received = round2(subtotal + vat - wht - retention - dep.amount)
  const row = { display: 'flex', justifyContent: 'space-between' }

  return (
    <div style={{ background: 'rgba(0,0,0,0.2)', borderRadius: 8, padding: '10px 14px', fontSize: 13, marginTop: 12, display: 'grid', gap: 6 }}>
      <div style={{ fontWeight: 700 }}>หักมัดจำสำหรับใบนี้</div>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>มัดจำคงเหลือของไซท์ <strong className="font-mono">{fmt(balance)}</strong> บาท</div>
      <div role="group" aria-label="วิธีหักมัดจำ" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
        {MODES.map(([m, label]) => (
          <button key={m} type="button" className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={mode === m} onClick={() => pickMode(m)}>{label}</button>
        ))}
        <button type="button" className="btn btn-sm btn-ghost" onClick={takeAll}>หักมัดจำคงเหลือทั้งหมด</button>
      </div>
      {mode === 'none' ? (
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>ใบนี้จะไม่หักมัดจำ</div>
      ) : (
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          <input
            id="inv-deposit-input" type="text" inputMode="decimal" autoComplete="off" className="input input-sm" style={{ width: 120 }}
            aria-label={mode === 'pct' ? 'เปอร์เซ็นต์ที่หักมัดจำ' : 'มูลค่ามัดจำที่หัก (บาท ก่อน VAT)'}
            value={text} onChange={e => onInput(e.target.value)}
          />
          <span style={{ fontSize: 12, color: 'var(--text3)' }}>{mode === 'pct' ? '%' : 'บาท (มูลค่าก่อน VAT)'}</span>
          <span id="inv-deposit-caption" style={{ fontSize: 12, color: 'var(--text3)' }}>
            = <strong className="font-mono">{fmt(dep.amount)}</strong> บาท · <strong className="font-mono">{dep.pct}</strong>% ของงวดนี้ · มัดจำคงเหลือหลังหักใบนี้ (ประมาณการ) <strong className="font-mono">{fmt(round2(balance - dep.amount))}</strong> บาท
          </span>
        </div>
      )}
      {(warned || dep.over) && (
        <div id="inv-deposit-warn" role="alert" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--amber, #b45309)', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
          ใส่เกินที่หักได้ (มัดจำคงเหลือหรือมูลค่าของใบนี้) ระบบปรับเป็น {fmt(dep.amount)} บาท ({dep.pct}%) ให้แล้ว
        </div>
      )}
      <div style={{ fontSize: 11, color: 'var(--text3)' }}>ผูกกับใบแจ้งหนี้นี้ใบเดียว ตอนกดยืนยันชำระ ระบบใช้ยอดนี้เป็นค่าเริ่มต้น (ยังแก้ได้ และไม่เกินมัดจำคงเหลือ ณ วันรับเงิน)</div>
      <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 6, display: 'grid', gap: 2 }}>
        <div style={{ fontSize: 11.5, color: 'var(--text3)' }}>ประมาณการเงินที่จะได้รับจริงของใบนี้</div>
        <div style={row}><span>รวมเรียกเก็บ</span><span className="font-mono">{fmt(total)}</span></div>
        {wht > 0 && <div style={row}><span>หัก ณ ที่จ่าย (คิดจาก {fmt(whtBase)})</span><span className="font-mono">− {fmt(wht)}</span></div>}
        {retention > 0 && <div style={row}><span>หักประกันผลงาน</span><span className="font-mono">− {fmt(retention)}</span></div>}
        <div style={row}><span>หักมัดจำ</span><span className="font-mono">− {fmt(dep.amount)}</span></div>
        <div id="inv-deposit-received" style={{ ...row, fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 4 }}><span>รับจริง</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(received)}</span></div>
      </div>
    </div>
  )
}
