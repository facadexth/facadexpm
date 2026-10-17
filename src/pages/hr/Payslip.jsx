// src/pages/hr/Payslip.jsx
// A5 landscape payslip (mockup screen 1). Built only from the record's own
// lines (name snapshots), so an old month always prints as it was paid.
// Payer / payee are typed names only (owner's decision: no signature lines).
import { useEffect, useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import { useTenant } from '../../hooks/useTenant.js'
import { supabase, fmt } from '../../lib/supabase.js'
import { downloadPDF } from '../../lib/pdf.js'
import { thaiBahtText } from '../../lib/thaiBahtText.js'
import { periodLabel, MONTHS_TH } from '../../lib/payroll/period.js'

// Show only the last 4 digits; 10-digit accounts keep the 3-1-5-1 bank grouping.
export function maskAcct(a) {
  const d = String(a ?? '').replace(/\D/g, '')
  if (!d) return '—'
  const m = 'x'.repeat(Math.max(0, d.length - 4)) + d.slice(-4)
  if (d.length === 10) return `${m.slice(0, 3)}-${m[3]}-${m.slice(4, 9)}-${m[9]}`
  return m.match(/.{1,4}/g).join('-')
}
const thDate = d => { if (!d) return '—'; const [y, m, day] = d.split('-'); return `${+day}/${m}/${+y + 543}` }

function useYearToDate(workerId, year, month) {
  const [ytd, setYtd] = useState(null)
  useEffect(() => {
    let off = false
    supabase.from('salary_record_lines')
      .select('side, amount, pay_items(method, system_key), salary_records!inner(worker_id, year, month, payroll_periods!inner(status))')
      .eq('salary_records.worker_id', workerId).eq('salary_records.year', year).lte('salary_records.month', month)
      .eq('salary_records.payroll_periods.status', 'closed')
      .then(({ data }) => {
        if (off || !data) return
        setYtd({
          earnings: data.filter(l => l.side === 'earning').reduce((s, l) => s + Number(l.amount), 0),
          sso: data.filter(l => l.pay_items?.method === 'sso').reduce((s, l) => s + Number(l.amount), 0),
          // money the company keeps back for the worker's retirement (the "หักเงินสมทบ" line)
          contrib: data.filter(l => l.pay_items?.system_key === 'contribution_deduct').reduce((s, l) => s + Number(l.amount), 0),
        })
      })
      .catch(() => {})
    return () => { off = true }
  }, [workerId, year, month])
  return ytd
}

const CSS = `
.payslip-a5{position:relative;width:794px;height:559px;box-sizing:border-box;overflow:hidden;padding:26px 30px 20px;background:#fff;color:#1b1f1d;font-family:Sarabun,sans-serif;font-size:12.5px;line-height:1.45;display:grid;grid-template-rows:auto auto 1fr auto auto;gap:10px}
.payslip-a5 .hd{display:flex;justify-content:space-between;gap:16px;border-bottom:2px solid #1b1f1d;padding-bottom:8px}
.payslip-a5 .co{font-weight:700;font-size:15px}.payslip-a5 .co small{display:block;font-weight:400;font-size:11px;color:#555}
.payslip-a5 .tt{text-align:right}.payslip-a5 .tt b{font-size:16px;display:block}.payslip-a5 .tt span{font-size:11.5px;color:#444}
.payslip-a5 .who{display:grid;grid-template-columns:repeat(3,1fr);gap:2px 16px;font-size:11.5px}.payslip-a5 .who span{color:#666;margin-right:6px}
.payslip-a5 .money{display:grid;grid-template-columns:1fr 1fr;gap:18px;align-content:start}
.payslip-a5 table{width:100%;border-collapse:collapse}.payslip-a5 th{text-align:left;font-size:11.5px;border-bottom:1px solid #1b1f1d;padding:2px 0}
.payslip-a5 td{padding:2px 0;border-bottom:1px dotted #c9cfcc}.payslip-a5 td small{color:#666;font-size:10.5px}
.payslip-a5 .num{text-align:right;font-variant-numeric:tabular-nums}.payslip-a5 .sum td{font-weight:700;border-top:1px solid #1b1f1d;border-bottom:none;padding-top:4px}
.payslip-a5 .facts{display:flex;flex-wrap:wrap;gap:4px 18px;font-size:11px;color:#444;border-top:1px solid #c9cfcc;padding-top:6px}
.payslip-a5 .ft{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:16px;align-items:end}
.payslip-a5 .neg{color:#b42318}
.payslip-a5 .net{background:#fff;color:#1b1f1d;border:1.5px solid #1b1f1d;padding:6px 12px;border-radius:3px}.payslip-a5 .net .v{font-size:19px;font-weight:700}
.payslip-a5 .sg{text-align:center;font-size:11px;color:#444}.payslip-a5 .sg b{display:block;font-size:12.5px;color:#1b1f1d;margin-bottom:2px}
.payslip-a5 .wm{position:absolute;left:0;right:0;top:40%;text-align:center;font-size:90px;font-weight:700;color:rgba(154,91,0,.14);transform:rotate(-12deg);pointer-events:none}
`

export function PayslipSheet({ record, year, month, period }) {
  const { tenant } = useTenant()
  const w = record.workers || {}
  const lines = [...(record.salary_record_lines || [])].sort((a, b) => a.sort_order - b.sort_order)
  const earn = lines.filter(l => l.side === 'earning')
  const ded = lines.filter(l => l.side === 'deduction')
  const sum = ls => ls.reduce((s, l) => s + Number(l.amount), 0)
  const f = record.facts || {}
  const hasFacts = Object.keys(f).length > 0
  const fv = (v, d = 0) => (hasFacts ? (v ?? d) : '—')
  const ytd = useYearToDate(record.worker_id, year, month)
  const isDraft = (period?.status || 'draft') === 'draft'
  const row = l => (
    <tr key={l.id}>
      <td>{l.name}{l.quantity && l.rate ? <small> {l.quantity} × {fmt(l.rate)}</small> : null}{l.note ? <small> · {l.note}</small> : null}</td>
      <td className={l.side === 'deduction' ? 'num neg' : 'num'}>{fmt(l.amount)}</td>
    </tr>
  )
  return (
    <div id="payslip-a5" className="payslip-a5">
      <style>{CSS}</style>
      {isDraft && <div className="wm">ร่าง</div>}
      <div className="hd">
        <div className="co">{tenant?.company_name}<small>{tenant?.tax_id ? `เลขผู้เสียภาษี ${tenant.tax_id}` : ''}</small></div>
        <div className="tt"><b>สลิปเงินเดือน{isDraft ? ' (ร่าง)' : ''}</b><span>งวด {periodLabel(year, month)} · วันที่จ่าย {thDate(period?.paid_date || record.paid_date)}</span></div>
      </div>
      <div className="who">
        <div><span>ชื่อ</span>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</div>
        <div><span>รหัส</span>{w.employee_code || '—'}</div>
        <div><span>ตำแหน่ง</span>{w.position || '—'}</div>
      </div>
      <div className="money">
        <table>
          <thead><tr><th>รายการเงินได้</th><th className="num">บาท</th></tr></thead>
          <tbody>{earn.map(row)}<tr className="sum"><td>รวมเงินได้</td><td className="num">{fmt(sum(earn))}</td></tr></tbody>
        </table>
        <table>
          <thead><tr><th>รายการเงินหัก</th><th className="num">บาท</th></tr></thead>
          <tbody>{ded.map(row)}<tr className="sum"><td>รวมเงินหัก</td><td className="num">{fmt(sum(ded))}</td></tr></tbody>
        </table>
      </div>
      <div className="facts">
        <span>วันทำงาน <b>{fv(f.daysWorked, '—')}</b> วัน</span>
        <span>ลากิจ <b>{fv(f.leavePersonalDays)}</b> วัน</span>
        <span>ลาป่วย <b>{fv(f.leaveSickDays)}</b> วัน</span>
        <span>OT <b>{fv(f.otHours)}</b> ชม.</span>
        {f.holidayShifts ? <span>กะวันหยุด <b>{f.holidayShifts}</b></span> : null}
        {ytd && <span>สะสมปี {year + 543}: เงินได้ <b>{fmt(ytd.earnings)}</b> · ประกันสังคม <b>{fmt(ytd.sso)}</b> · เงินสมทบ <b>{fmt(ytd.contrib)}</b></span>}
      </div>
      <div className="ft">
        <div className="net">
          <div style={{ fontSize: 11, opacity: 0.8 }}>จ่ายสุทธิ</div>
          <div className="v">{fmt(record.net_pay)}</div>
          <div style={{ fontSize: 11 }}>({thaiBahtText(Number(record.net_pay))})</div>
        </div>
        <div className="sg"><b>{tenant?.company_name}</b>ผู้จ่ายเงิน</div>
        <div className="sg"><b>{w.bank_account_name || w.name}</b>ผู้รับเงิน</div>
      </div>
    </div>
  )
}

export default function PayslipModal({ record, year, month, period, onClose }) {
  const label = (record.workers?.nickname || record.workers?.name || 'slip').replace(/\s+/g, '_')
  const download = () => downloadPDF('payslip-a5', `สลิปเงินเดือน_${label}_${MONTHS_TH[month - 1]}${year + 543}.pdf`, { format: 'a5', orientation: 'landscape', margin: 0 })
  return (
    <Modal title={`สลิปเงินเดือน — ${record.workers?.name || ''}`} onClose={onClose} maxWidth={860}>
      <div className="modal-body" style={{ overflowX: 'auto' }}>
        <PayslipSheet record={record} year={year} month={month} period={period} />
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" onClick={download}>⬇️ ดาวน์โหลด PDF</button>
      </div>
    </Modal>
  )
}
