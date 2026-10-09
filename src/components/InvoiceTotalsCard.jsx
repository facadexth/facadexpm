// ============================================================
// InvoiceTotalsCard -- the ONE card of the create-invoice form that holds the deposit choice, the totals (VAT) and the
// withholding tax, ending in the cash the customer is expected to pay. Everything shown comes from `calc`
// (lib/invoiceNet.computeInvoiceNet), the same pipeline the "กรอกยอดที่ต้องการเรียกเก็บ" back-solver uses.
// Deposit state lives in useDepositChoiceState (called at the top of the form, before its early returns).
// ============================================================
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
const row = { display: 'flex', justifyContent: 'space-between', gap: 12 }
const small = { fontSize: 11.5, color: 'var(--text3)' }

export default function InvoiceTotalsCard({
  calc, hasVat, isSplit, materialLabor,
  showDeposit, choice, siteDepositPct, remaining, reservedTotal, reservedInvoices, free, availableOffset,
  includeWht, setIncludeWht, whtPct, setWhtPct, legacyDepositPct,
}) {
  const { mode, text, warned, setMode, setText, setWarned } = choice
  const dep = calc.dep
  const onInput = (raw) => {
    const typed = cleanDecimalText(raw)
    const r = resolveDepositChoice({ subtotal: calc.baseSubtotal, mode, text: typed, balance: free })
    setMode(mode)
    setText(r.over ? r.cappedText : typed)
    setWarned(r.over)
  }
  const pickMode = (m) => { setMode(m); setText(m === 'pct' ? String(siteDepositPct || '') : ''); setWarned(false) }
  const takeAll = () => { setMode('value'); setText(String(fullDepositAmount(calc.baseSubtotal, free))); setWarned(false) }

  return (
    <div className="card card-body" style={{ marginTop: 12, display: 'grid', gap: 8, fontSize: 13 }}>
      {showDeposit && (
        <>
          <div style={{ fontWeight: 700 }}>หักมัดจำสำหรับใบนี้</div>
          <div style={small}>
            มัดจำคงเหลือของไซท์ <strong className="font-mono">{fmt(remaining)}</strong> บาท
            {reservedTotal > 0 && (
              <> · จองไว้แล้วโดยใบที่ยังไม่ชำระ <strong className="font-mono">{fmt(reservedTotal)}</strong> บาท
                ({(reservedInvoices || []).map(i => i.invoice_number).join(', ')}) · ใช้ได้ <strong className="font-mono">{fmt(free)}</strong> บาท</>
            )}
          </div>
          <div role="group" aria-label="วิธีหักมัดจำ" style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {MODES.map(([m, label]) => (
              <button key={m} type="button" className={`btn btn-sm ${mode === m ? 'btn-primary' : 'btn-ghost'}`} aria-pressed={mode === m} onClick={() => pickMode(m)}>{label}</button>
            ))}
            <button type="button" className="btn btn-sm btn-ghost" onClick={takeAll}>หักมัดจำคงเหลือทั้งหมด</button>
          </div>
          {mode === 'none' ? (
            <div style={small}>ใบนี้จะไม่หักมัดจำ</div>
          ) : (
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
              <input
                id="inv-deposit-input" type="text" inputMode="decimal" autoComplete="off" className="input input-sm" style={{ width: 120 }}
                aria-label={mode === 'pct' ? 'เปอร์เซ็นต์ที่หักมัดจำ' : 'มูลค่ามัดจำที่หัก (บาท ก่อน VAT)'}
                value={text} onChange={e => onInput(e.target.value)}
              />
              <span style={small}>{mode === 'pct' ? '%' : 'บาท (มูลค่าก่อน VAT)'}</span>
              <span id="inv-deposit-caption" style={small}>
                = <strong className="font-mono">{fmt(dep.amount)}</strong> บาท · <strong className="font-mono">{dep.pct}</strong>% ของงวดนี้ · มัดจำที่ใช้ได้หลังหักใบนี้ (ประมาณการ) <strong className="font-mono">{fmt(round2(free - dep.amount))}</strong> บาท
              </span>
            </div>
          )}
          {(warned || dep.over) && (
            <div id="inv-deposit-warn" role="alert" style={{ background: 'rgba(245,158,11,0.15)', color: 'var(--amber, #b45309)', borderRadius: 7, padding: '6px 10px', fontSize: 12 }}>
              ใส่เกินที่หักได้ (มัดจำที่ใช้ได้หรือมูลค่าของใบนี้) ระบบปรับเป็น {fmt(dep.amount)} บาท ({dep.pct}%) ให้แล้ว
            </div>
          )}
          <div style={{ ...small, fontSize: 11 }}>ผูกกับใบแจ้งหนี้นี้ใบเดียว ตอนกดยืนยันชำระ ระบบใช้ยอดนี้เป็นค่าเริ่มต้น (ยังแก้ได้ และไม่เกินมัดจำคงเหลือ ณ วันรับเงิน)</div>
        </>
      )}
      {!showDeposit && legacyDepositPct > 0 && (
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>
          📐 ตอนกดยืนยันชำระใบแจ้งหนี้นี้ ระบบจะหักเงินมัดจำอัตโนมัติ {legacyDepositPct}% ของยอดก่อน VAT ของใบนี้ —
          หรือหักเท่าที่มัดจำคงเหลืออยู่ ถ้าน้อยกว่านั้น
        </div>
      )}

      <div style={{ display: 'grid', gap: 3, borderTop: showDeposit || legacyDepositPct > 0 ? '1px dashed var(--border)' : 'none', paddingTop: showDeposit || legacyDepositPct > 0 ? 8 : 0 }}>
        {isSplit && (
          <>
            <div style={row}><span>รวมค่าของ</span><span className="font-mono">{fmt(materialLabor.material)}</span></div>
            <div style={row}><span>รวมค่าแรง</span><span className="font-mono">{fmt(materialLabor.labor)}</span></div>
          </>
        )}
        <div style={row}><span>รวมงวดนี้ (ก่อน VAT)</span><span className="font-mono">{fmt(calc.subtotal)}</span></div>
        {hasVat && (
          <div>
            <div style={row}><span>VAT (7%)</span><span className="font-mono">{fmt(calc.vat)}</span></div>
            {calc.taxOffset > 0 && (
              <div style={small}>
                คิดจาก {fmt(Math.max(0, calc.subtotal - calc.taxOffset))} บาท (ตัด {fmt(Math.min(calc.subtotal, calc.taxOffset))} บาทที่หักมัดจำในใบนี้ ซึ่งเสีย VAT ไปแล้วตอนรับมัดจำ)
              </div>
            )}
            {showDeposit && calc.taxOffset === 0 && availableOffset > 0 && (
              <div style={small}>คิดจากยอดเต็มของงวดนี้ (ใบนี้ไม่หักมัดจำ)</div>
            )}
          </div>
        )}
        <div style={{ ...row, fontWeight: 700, borderTop: '1px solid var(--border)', marginTop: 4, paddingTop: 4 }}>
          <span>รวมเรียกเก็บงวดนี้</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(calc.total)}</span>
        </div>
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', paddingTop: 8, borderTop: '1px dashed var(--border)' }}>
        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, color: 'var(--text2)' }}>
          <input type="checkbox" checked={includeWht} onChange={e => setIncludeWht(e.target.checked)} />
          หัก ณ ที่จ่ายสำหรับใบนี้
        </label>
        {includeWht && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="number" min="0" max="100" step="any" className="input input-sm" style={{ width: 60 }}
              value={whtPct} onChange={e => setWhtPct(e.target.value)} />
            <span style={small}>%</span>
          </div>
        )}
      </div>
      <div style={{ ...small, fontSize: 11 }}>
        การตั้งค่านี้ผูกกับใบแจ้งหนี้นี้ใบเดียว — ตอนกดยืนยันชำระ ระบบจะหัก ณ ที่จ่ายตามนี้เสมอ ไม่ว่า % เริ่มต้นของไซท์จะเปลี่ยนไปภายหลังหรือไม่
      </div>

      {showDeposit && (
        <div style={{ borderTop: '1px dashed var(--border)', paddingTop: 6, display: 'grid', gap: 2 }}>
          <div style={small}>ประมาณการเงินที่จะได้รับจริงของใบนี้</div>
          <div style={row}><span>รวมเรียกเก็บงวดนี้</span><span className="font-mono">{fmt(calc.total)}</span></div>
          {calc.wht > 0 && <div style={row}><span>หัก ณ ที่จ่าย (คิดจาก {fmt(calc.whtBase)})</span><span className="font-mono">− {fmt(calc.wht)}</span></div>}
          {calc.retention > 0 && <div style={row}><span>หักประกันผลงาน</span><span className="font-mono">− {fmt(calc.retention)}</span></div>}
          <div style={row}><span>หักมัดจำ</span><span className="font-mono">− {fmt(calc.depositAmount)}</span></div>
          <div id="inv-deposit-received" style={{ ...row, fontWeight: 700, borderTop: '1px solid var(--border)', paddingTop: 4 }}>
            <span>รับจริง</span><span className="font-mono" style={{ color: 'var(--accent)' }}>{fmt(calc.net)}</span>
          </div>
        </div>
      )}
    </div>
  )
}
