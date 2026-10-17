import { describe, it, expect } from 'vitest'
import { inferRoles, cleanLabel } from './cardTable.js'

const cell = (o = {}) => ({ text: 'x', numeric: false, hasBadge: false, hasButton: false, ...o })

describe('cleanLabel', () => {
  it('strips sort glyphs and trims', () => {
    expect(cleanLabel('รหัส ↑')).toBe('รหัส')
    expect(cleanLabel('ชื่อ ↕ ')).toBe('ชื่อ')
    expect(cleanLabel('ยอด ⇅')).toBe('ยอด')
    expect(cleanLabel(' สถานะ↓')).toBe('สถานะ')
    expect(cleanLabel(null)).toBe('')
  })
})

describe('inferRoles', () => {
  it('quotation-like table: title, subs, amount, status, actions', () => {
    const headers = ['เลขที่ ↓', 'วันที่', 'ลูกค้า', 'ไซท์งาน', 'รายการ', 'ยอดรวม', 'สถานะ', '']
    const row = [cell({ text: 'QT1' }), cell({ text: '14 ต.ค.' }), cell({ text: 'คุณบิ๊ก' }), cell({ text: 'บ้าน' }), cell({ text: '6 รายการ' }),
      cell({ text: '186,500.00', numeric: true }), cell({ text: 'รออนุมัติ', hasBadge: true }), cell({ text: '', hasButton: true })]
    expect(inferRoles(headers, row)).toEqual(['title', 'sub', 'sub', 'row', 'row', 'amount', 'status', 'actions'])
  })

  it('skips # / ลำดับ for the title; a map overrides inference', () => {
    const headers = ['#', 'ชื่อ', 'จำนวน']
    const row = [cell({ text: '1', numeric: true }), cell({ text: 'a' }), cell({ text: '5', numeric: true })]
    expect(inferRoles(headers, row)).toEqual(['hide', 'title', 'row'])
    expect(inferRoles(headers, row, { amount: 'จำนวน', hide: [] })).toEqual(['row', 'title', 'amount'])
    expect(inferRoles(headers, row, { title: 2, sub: ['ชื่อ'] })).toEqual(['hide', 'sub', 'title'])
  })

  it('the last numeric money column is the amount; other numbers stay rows', () => {
    const headers = ['ชื่อ', 'จำนวน', 'ราคา/หน่วย', 'รวม']
    const row = [cell(), cell({ numeric: true }), cell({ numeric: true }), cell({ numeric: true })]
    expect(inferRoles(headers, row)).toEqual(['title', 'row', 'row', 'amount'])
  })

  it('empty table (no sample row): title and subs from headers, money header still becomes amount', () => {
    expect(inferRoles(['รหัส', 'ชื่อ', 'ยอด'], null)).toEqual(['title', 'sub', 'amount'])
  })

  it("actions = 'last' and an empty-header last column without a button is actions only when empty", () => {
    const headers = ['ชื่อ', 'หมายเหตุ', '']
    expect(inferRoles(headers, [cell(), cell(), cell({ text: 'x' })], { actions: 'last' })).toEqual(['title', 'sub', 'actions'])
    expect(inferRoles(headers, [cell(), cell(), cell({ text: 'x' })])).toEqual(['title', 'sub', 'sub'])
    expect(inferRoles(headers, [cell(), cell(), cell({ text: '' })])).toEqual(['title', 'sub', 'actions'])
  })

  it('a checkbox column counts as actions, badge column as status, even when first', () => {
    const headers = ['', 'สถานะ', 'ชื่อ']
    const row = [cell({ text: '', hasButton: true }), cell({ text: 'จ่ายแล้ว', hasBadge: true }), cell({ text: 'a' })]
    expect(inferRoles(headers, row)).toEqual(['row', 'status', 'title'])
  })
})
