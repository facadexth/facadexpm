// Builds the SCB upload file for a confirmed/closed month. Workers that can't
// go in the file (no account, bad branch…) are listed so the admin pays them by hand.
import { useMemo, useState } from 'react'
import { useUserRole } from '../../hooks/useUserRole.js'
import { Modal } from '../../components/Modal.jsx'
import { useBankSettings } from '../../hooks/usePayroll.js'
import { buildScbPayrollFile } from '../../lib/bankExport/scb.js'
import { fmt } from '../../lib/supabase.js'
import { monthRange } from '../../lib/payroll/period.js'

export default function BankExportModal({ records, year, month, onClose }) {
  const { data: settings, loading, error } = useBankSettings()
  const { isAtLeast } = useUserRole()
  const [valueDate, setValueDate] = useState(monthRange(year, month).to)
  const rows = useMemo(() => records.map(r => ({
    ref: r.workers?.employee_code || '',
    name: r.workers?.bank_account_name || r.workers?.name,
    bank_code: r.workers?.bank_code || '',
    account: r.workers?.bank_account_no || '',
    branch: r.workers?.bank_branch_code || '',
    amount: Number(r.net_pay),
    email: '',
  })), [records])
  let result = null
  let fatal = null
  if (settings) {
    try { result = buildScbPayrollFile({ settings, valueDate, now: new Date(), rows }) }
    catch (e) { fatal = e.message }
  }
  const download = () => {
    const blob = new Blob([result.content], { type: 'text/plain;charset=utf-8' }) // JS strings → UTF-8, no BOM
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = result.filename
    a.click()
    setTimeout(() => URL.revokeObjectURL(a.href), 1000)
  }
  return (
    <Modal title="ไฟล์จ่ายเงินเดือน SCB" onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        {loading && <div>⏳</div>}
        {!loading && error && <div style={{ color: 'var(--red)' }}>โหลดการตั้งค่าไม่สำเร็จ: {error}</div>}
        {!loading && !error && !settings && (isAtLeast('OWNER')
          ? <div>ยังไม่ได้ตั้งค่าบัญชีต้นทาง ไปที่ ตั้งค่า → ไฟล์จ่ายเงินเดือน (SCB)</div>
          : <div>ให้เจ้าของบริษัทตั้งค่าบัญชีต้นทางที่ ตั้งค่า → ไฟล์จ่ายเงินเดือน (SCB) ก่อน</div>)}
        {settings && (
          <>
            <label className="label">วันที่โอน</label>
            <input className="input" type="date" value={valueDate} onChange={e => setValueDate(e.target.value)} />
            {fatal && <div style={{ color: 'var(--red)' }}>{fatal}</div>}
            {result && <div>{result.count} คน · รวม <b>{fmt(result.total)}</b> บาท · บริการ {settings.product}</div>}
            {result?.errors.length > 0 && (
              <div>
                <b>ไม่ได้ใส่ในไฟล์ {result.errors.length} คน (ต้องโอนเอง):</b>
                {result.errors.map(e => <div key={`${e.ref}-${e.name}`}>• {e.name}: {e.message}</div>)}
              </div>
            )}
          </>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
        <button className="btn btn-primary" disabled={!result || !result.count} onClick={download}>⬇️ ดาวน์โหลดไฟล์</button>
      </div>
    </Modal>
  )
}
