// Worker form section: employee code, pay type, daily wage, bank details,
// and amounts for every fixed_per_worker pay item.
import { BANKS, suggestBranch, validateAccount } from '../../lib/bankExport/banks.js'

export default function WorkerPayFields({ form, set, payItems = [], amounts = {}, setAmount }) {
  const fixed = payItems.filter(i => i.active && i.method === 'fixed_per_worker')
  const acctError = form.bank_code && form.bank_account_no ? validateAccount(form.bank_code, form.bank_account_no) : null
  const onAccount = v => {
    const digits = v.replace(/\D/g, '').slice(0, 25)
    set('bank_account_no', digits)
    const b = suggestBranch(form.bank_code, digits)
    if (b && !form.bank_branch_touched) set('bank_branch_code', b)
  }
  return (
    <div style={{ display: 'grid', gap: 12, borderTop: '1px solid var(--border)', paddingTop: 12 }}>
      <div style={{ fontWeight: 700 }}>💼 เงินเดือนและบัญชีรับเงิน</div>
      <div className="form-grid-2">
        <div>
          <label className="label">รหัสพนักงาน</label>
          <input className="input" value={form.employee_code || ''} onChange={e => set('employee_code', e.target.value.trim())} placeholder="เช่น EMP-001" />
        </div>
        <div>
          <label className="label">ประเภทการจ่าย</label>
          <select className="select" value={form.pay_type || 'monthly'} onChange={e => set('pay_type', e.target.value)}>
            <option value="monthly">รายเดือน</option>
            <option value="daily">รายวัน</option>
          </select>
        </div>
        {form.pay_type === 'daily' && (
          <div>
            <label className="label">ค่าแรงต่อวัน (บาท)</label>
            <input className="input" type="number" min="0" value={form.daily_wage ?? ''} onChange={e => set('daily_wage', e.target.value)} />
          </div>
        )}
      </div>
      <div className="form-grid-2">
        <div>
          <label className="label">ธนาคาร</label>
          <select className="select" value={form.bank_code || ''} onChange={e => set('bank_code', e.target.value || null)}>
            <option value="">— ไม่ระบุ —</option>
            {BANKS.map(b => <option key={b.code} value={b.code}>{b.name}</option>)}
          </select>
        </div>
        <div>
          <label className="label">เลขบัญชี</label>
          <input className="input" inputMode="numeric" value={form.bank_account_no || ''} onChange={e => onAccount(e.target.value)} />
          {acctError && <div style={{ color: 'var(--red)', fontSize: 12 }}>{acctError}</div>}
        </div>
        <div>
          <label className="label">ชื่อบัญชี</label>
          <input className="input" value={form.bank_account_name || ''} onChange={e => set('bank_account_name', e.target.value)} placeholder="ว่างไว้ = ใช้ชื่อพนักงาน" />
        </div>
        <div>
          <label className="label">รหัสสาขา (4 หลัก)</label>
          <input className="input" inputMode="numeric" value={form.bank_branch_code || ''}
            onChange={e => { set('bank_branch_touched', true); set('bank_branch_code', e.target.value.replace(/\D/g, '').slice(0, 4)) }} />
        </div>
      </div>
      {fixed.length > 0 && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(160px, 1fr))', gap: 12 }}>
          {fixed.map(i => (
            <div key={i.id}>
              <label className="label">{i.name} ({i.side === 'earning' ? 'เงินได้' : 'เงินหัก'}) / เดือน</label>
              <input className="input" type="number" min="0" value={amounts[i.id] ?? ''} onChange={e => setAmount(i.id, e.target.value)} />
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
