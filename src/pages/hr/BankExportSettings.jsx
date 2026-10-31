// One-time SCB setup for the payroll upload file (reference doc §2.8).
import { useEffect, useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useTenant } from '../../hooks/useTenant.js'
import { useBankSettings } from '../../hooks/usePayroll.js'
import { scbCheckDigitOk } from '../../lib/bankExport/banks.js'

const EMPTY = { product: 'SPN', debit_account: '', fee_account: '', fee_charge: 'OUR', system_ref: '' }

export default function BankExportSettings() {
  const { tenant } = useTenant()
  const { data, refetch } = useBankSettings()
  const [f, setF] = useState(EMPTY)
  useEffect(() => { if (data) setF({ ...EMPTY, ...data }) }, [data])
  const set = (k, v) => setF(x => ({ ...x, [k]: v }))
  const save = async () => {
    const fee = f.fee_account || f.debit_account
    if (!scbCheckDigitOk(f.debit_account)) return alert('เลขบัญชีต้นทางไม่ถูกต้อง')
    if (!scbCheckDigitOk(fee)) return alert('เลขบัญชีหักค่าธรรมเนียมไม่ถูกต้อง')
    // tenant_id is the table PK, so onConflict must name it. The DB default fills it
    // on insert; we send it explicitly so the conflict target is always present.
    const row = { tenant_id: tenant?.id, bank: 'scb', product: f.product, debit_account: f.debit_account, fee_account: fee, fee_charge: f.fee_charge, system_ref: f.system_ref || null, updated_at: new Date().toISOString() }
    if (!row.tenant_id) delete row.tenant_id
    const { error } = await supabase.from('payroll_bank_settings').upsert(row, { onConflict: 'tenant_id' })
    if (error) alert('บันทึกไม่สำเร็จ: ' + error.message)
    else { alert('✅ บันทึกแล้ว'); refetch() }
  }
  return (
    <div className="card" style={{ display: 'grid', gap: 10, maxWidth: 520 }}>
      <div className="card-title">🏦 ไฟล์จ่ายเงินเดือน SCB Business Anywhere</div>
      <label className="label">บริการ</label>
      <select className="input" value={f.product} onChange={e => set('product', e.target.value)}>
        <option value="SPN">Payroll – SMART โอนวันถัดไป (ทุกธนาคาร)</option>
        <option value="SPS">Payroll – SMART โอนวันเดียวกัน (ทุกธนาคาร)</option>
        <option value="PAY">Payroll (เฉพาะบัญชีไทยพาณิชย์)</option>
      </select>
      <label className="label">บัญชีต้นทาง (ไทยพาณิชย์ 10 หลัก)</label>
      <input className="input" inputMode="numeric" value={f.debit_account || ''} onChange={e => set('debit_account', e.target.value.replace(/\D/g, '').slice(0, 10))} />
      <label className="label">บัญชีหักค่าธรรมเนียม (ว่าง = บัญชีเดียวกัน)</label>
      <input className="input" inputMode="numeric" value={f.fee_account || ''} onChange={e => set('fee_account', e.target.value.replace(/\D/g, '').slice(0, 10))} />
      <label className="label">ใครจ่ายค่าธรรมเนียม</label>
      <select className="input" value={f.fee_charge} onChange={e => set('fee_charge', e.target.value)}>
        <option value="OUR">บริษัท</option><option value="BEN">ผู้รับเงิน</option>
      </select>
      <label className="label">รหัสบริษัท / System Reference ID (ถ้าธนาคารให้มา)</label>
      <input className="input" value={f.system_ref || ''} onChange={e => set('system_ref', e.target.value.replace(/[^A-Za-z0-9]/g, '').slice(0, 18))} />
      <button className="btn btn-primary" onClick={save}>💾 บันทึก</button>
    </div>
  )
}
