// src/pages/hr/PayItemsEditor.jsx
// Tenant pay structure: add / rename / hide / reorder items and pick how each
// is calculated. System items (base pay, OT, SSO, unpaid leave, advances) can be
// renamed, hidden and reordered but not deleted or re-methoded (DB trigger).
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { usePayItems } from '../../hooks/usePayroll.js'
import { validatePayItems, SYSTEM_METHODS } from '../../lib/payroll/calc.js'

const METHOD_LABEL = {
  base_pay: 'ระบบคิด: เงินเดือน/ค่าแรง', ot: 'ระบบคิด: OT', sso: 'ระบบคิด: ประกันสังคม',
  unpaid_leave: 'ระบบคิด: ลาไม่รับค่าจ้าง', advances: 'จากระบบเบิกล่วงหน้า',
  fixed_per_worker: 'ค่าคงที่รายคน', manual_monthly: 'กรอกทุกเดือน', percent_of_item: '% ของรายการอื่น',
}
const USER_METHODS = ['fixed_per_worker', 'manual_monthly', 'percent_of_item']

export default function PayItemsEditor() {
  const { data: items, refetch } = usePayItems()
  const [busy, setBusy] = useState(false)
  const ver = item => item.id + ':' + item.name + ':' + JSON.stringify(item.params)
  if (!items) return <div className="card">⏳ กำลังโหลด...</div>

  const save = async (id, patch) => {
    const next = items.map(i => i.id === id ? { ...i, ...patch } : i)
    if (validatePayItems(next.filter(i => i.active)).length) {
      alert('ตั้งค่าไม่ได้: รายการ % อ้างถึงรายการที่ไม่มี หรืออ้างกันเป็นวง')
      return
    }
    setBusy(true)
    const { error } = await supabase.from('pay_items').update(patch).eq('id', id)
    setBusy(false)
    if (error) alert('บันทึกไม่สำเร็จ: ' + error.message); else refetch()
  }
  const move = async (item, dir) => {
    const same = items.filter(i => i.side === item.side)
    const other = same[same.findIndex(i => i.id === item.id) + dir]
    if (!other) return
    setBusy(true)
    const a = await supabase.from('pay_items').update({ sort_order: other.sort_order }).eq('id', item.id)
    const b = await supabase.from('pay_items').update({ sort_order: item.sort_order }).eq('id', other.id)
    setBusy(false)
    if (a.error || b.error) alert('สลับลำดับไม่สำเร็จ: ' + (a.error || b.error).message); else refetch()
  }
  const add = async side => {
    if (busy) return
    setBusy(true)
    const max = Math.max(0, ...items.filter(i => i.side === side).map(i => i.sort_order))
    const { error } = await supabase.from('pay_items').insert({
      name: side === 'earning' ? 'รายการเงินได้ใหม่' : 'รายการเงินหักใหม่', side, method: 'manual_monthly', sort_order: max + 1,
    })
    setBusy(false)
    if (error) alert('เพิ่มไม่สำเร็จ: ' + error.message); else refetch()
  }
  const remove = async item => {
    const dependent = items.find(i => i.id !== item.id && i.params?.of_item_id === item.id)
    if (dependent) { alert(`ลบไม่ได้: รายการ "${dependent.name}" คิดจากรายการนี้`); return }
    if (validatePayItems(items.filter(i => i.active && i.id !== item.id)).length) {
      alert('ลบไม่ได้: โครงสร้างรายการจะผิดพลาด (รายการ % อ้างถึงรายการนี้)')
      return
    }
    const { error } = await supabase.from('pay_items').delete().eq('id', item.id)
    if (error) {
      // Custom item already used by a confirmed/closed month: the FK SET NULL hits the lock trigger.
      alert(String(error.message).includes('ยืนยันหรือปิดงวด')
        ? 'รายการนี้ถูกใช้ในเดือนที่ยืนยัน/ปิดงวดแล้ว ลบไม่ได้ — ซ่อนแทน'
        : 'ลบไม่สำเร็จ: ' + error.message)
    } else refetch()
  }
  const refOptions = item => items.filter(i => i.active && i.id !== item.id && !['sso', 'advances'].includes(i.method))

  const row = item => {
    const isSystem = SYSTEM_METHODS.includes(item.method)
    return (
      <tr key={item.id} style={{ opacity: item.active ? 1 : 0.5 }}>
        <td style={{ whiteSpace: 'nowrap' }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => move(item, -1)} aria-label="เลื่อนขึ้น">▲</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => move(item, 1)} aria-label="เลื่อนลง">▼</button>
        </td>
        <td>
          <input key={ver(item)} className="input input-sm" defaultValue={item.name}
            onBlur={e => { const v = e.target.value.trim(); if (v && v !== item.name) save(item.id, { name: v }) }} />
        </td>
        <td>
          {isSystem ? <span className="badge">{METHOD_LABEL[item.method]}</span> : (
            <select className="input input-sm" value={item.method}
              onChange={e => save(item.id, {
                method: e.target.value,
                params: e.target.value === 'percent_of_item' ? { percent: 5, of_item_id: items.find(i => i.method === 'base_pay')?.id } : {},
              })}>
              {USER_METHODS.map(m => <option key={m} value={m}>{METHOD_LABEL[m]}</option>)}
            </select>
          )}
        </td>
        <td>
          {item.method === 'percent_of_item' && (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input key={ver(item)} className="input input-sm" type="number" min="0" style={{ width: 70 }} defaultValue={item.params?.percent}
                onBlur={e => { const v = Math.max(0, parseFloat(e.target.value) || 0); if (v !== Number(item.params?.percent)) save(item.id, { params: { ...item.params, percent: v } }) }} />% ของ
              <select className="input input-sm" value={item.params?.of_item_id || ''} onChange={e => save(item.id, { params: { ...item.params, of_item_id: e.target.value } })}>
                {refOptions(item).map(i => <option key={i.id} value={i.id}>{i.name}</option>)}
              </select>
            </span>
          )}
          {item.method === 'sso' && (
            <span style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <input key={ver(item)} className="input input-sm" type="number" min="0" style={{ width: 60 }} defaultValue={(item.params?.rate ?? 0.05) * 100}
                onBlur={e => { const v = Math.max(0, parseFloat(e.target.value) || 0) / 100; if (Math.abs(v - (item.params?.rate ?? 0.05)) > 1e-9) save(item.id, { params: { ...item.params, rate: v } }) }} />% สูงสุด
              <input key={ver(item)} className="input input-sm" type="number" min="0" style={{ width: 80 }} defaultValue={item.params?.cap ?? 875}
                onBlur={e => { const v = Math.max(0, parseFloat(e.target.value) || 0); if (v !== (item.params?.cap ?? 875)) save(item.id, { params: { ...item.params, cap: v } }) }} /> บาท
            </span>
          )}
          {item.method === 'ot' && (
            <span>× <input key={ver(item)} className="input input-sm" type="number" min="0" step="0.5" style={{ width: 60 }} defaultValue={item.params?.multiplier ?? 1.5}
              onBlur={e => { const v = Math.max(0, parseFloat(e.target.value)) || 1.5; if (v !== (item.params?.multiplier ?? 1.5)) save(item.id, { params: { ...item.params, multiplier: v } }) }} /> เท่า · ปัดขึ้นเป็นบาท</span>
          )}
        </td>
        <td>
          <select className="input input-sm" value={item.applies_to} onChange={e => save(item.id, { applies_to: e.target.value })}>
            <option value="all">ทุกคน</option><option value="monthly">รายเดือน</option><option value="daily">รายวัน</option>
          </select>
        </td>
        <td style={{ textAlign: 'center' }}>
          {item.side === 'earning' && <input type="checkbox" checked={item.sso_base} onChange={e => save(item.id, { sso_base: e.target.checked })} aria-label={`นับฐานประกันสังคม ${item.name}`} />}
        </td>
        <td style={{ textAlign: 'center' }}>
          <input type="checkbox" checked={item.active} onChange={e => save(item.id, { active: e.target.checked })} aria-label={`ใช้งาน ${item.name}`} />
        </td>
        <td>{!isSystem && <button className="btn btn-ghost btn-sm" onClick={() => remove(item)}>ลบ</button>}</td>
      </tr>
    )
  }

  const group = side => (
    <>
      <tr><td colSpan={8} style={{ fontWeight: 700, background: 'var(--bg3)' }}>{side === 'earning' ? 'เงินได้' : 'เงินหัก'}</td></tr>
      {items.filter(i => i.side === side).map(row)}
    </>
  )

  return (
    <div className="card" style={{ marginBottom: 24 }}>
      <div className="card-header" style={{ display: 'flex', justifyContent: 'space-between', flexWrap: 'wrap', gap: 8 }}>
        <div className="card-title">💼 โครงสร้างเงินเดือน</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => add('earning')}>+ รายการเงินได้</button>
          <button className="btn btn-ghost btn-sm" disabled={busy} onClick={() => add('deduction')}>+ รายการเงินหัก</button>
        </div>
      </div>
      <p style={{ color: 'var(--text3)', fontSize: 13 }}>มีผลกับการคำนวณครั้งถัดไป สลิปเดือนที่ผ่านมาไม่เปลี่ยน</p>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ minWidth: 820 }}>
          <thead><tr><th></th><th>ชื่อรายการ</th><th>วิธีคิด</th><th>ค่า</th><th>ใช้กับ</th><th>นับฐานประกันสังคม</th><th>ใช้งาน</th><th></th></tr></thead>
          <tbody>{group('earning')}{group('deduction')}</tbody>
        </table>
      </div>
    </div>
  )
}
