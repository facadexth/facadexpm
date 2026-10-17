// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act } from '@testing-library/react'
import { useState } from 'react'
import CardTable from './CardTable.jsx'
import * as phone from '../hooks/useIsPhone.js'

afterEach(cleanup)
beforeEach(() => vi.restoreAllMocks())

const Table = ({ rows = 1 }) => (
  <table>
    <thead><tr><th className="sortable">เลขที่ ↑</th><th>ลูกค้า</th><th>ยอดรวม</th><th>สถานะ</th><th></th></tr></thead>
    <tbody>
      {Array.from({ length: rows }, (_, i) => (
        <tr key={i}><td>QT{i + 1}</td><td>คุณบิ๊ก</td><td>186,500.00</td><td><span className="badge badge-pending">รอ</span></td><td><button>⋮</button></td></tr>
      ))}
    </tbody>
  </table>
)

describe('CardTable', () => {
  it('desktop: renders exactly the table-wrap div with no decoration', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<CardTable><Table /></CardTable>)
    const wrap = container.firstChild
    expect(wrap.tagName).toBe('DIV')
    expect(wrap.className).toBe('table-wrap')
    expect(wrap.attributes).toHaveLength(1)
    expect(container.querySelector('td[data-label]')).toBeNull()
    expect(container.querySelector('th[data-sortable]')).toBeNull()
  })

  it('desktop: className override is passed through unchanged', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<CardTable className="table-wrap table-wrap-fill"><Table /></CardTable>)
    expect(container.firstChild.className).toBe('table-wrap table-wrap-fill')
  })

  it('phone: decorates cells with data-label and inferred roles, marks sortable headers', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(<CardTable><Table /></CardTable>)
    expect(container.firstChild.className).toBe('table-wrap card-table')
    const tds = [...container.querySelectorAll('tbody td')]
    expect(tds.map(td => td.dataset.label)).toEqual(['เลขที่', 'ลูกค้า', 'ยอดรวม', 'สถานะ', ''])
    expect(tds.map(td => td.dataset.role)).toEqual(['title', 'sub', 'amount', 'status', 'actions'])
    const ths = [...container.querySelectorAll('thead th')]
    expect(ths.map(th => th.dataset.sortable)).toEqual(['true', 'false', 'false', 'false', 'false'])
  })

  it('phone: a map overrides inference', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(<CardTable map={{ title: 'ลูกค้า', sub: ['เลขที่'] }}><Table /></CardTable>)
    const tds = [...container.querySelectorAll('tbody td')]
    expect(tds.map(td => td.dataset.role)).toEqual(['sub', 'title', 'amount', 'status', 'actions'])
  })

  it('phone: the empty-state row is marked, not decorated', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const { container } = render(
      <CardTable><table><thead><tr><th>a</th><th>b</th></tr></thead><tbody><tr><td colSpan={2}>ไม่พบข้อมูล</td></tr></tbody></table></CardTable>
    )
    const td = container.querySelector('tbody td')
    expect(td.dataset.empty).toBe('true')
    expect(td.dataset.role).toBeUndefined()
  })

  it('phone: rows added after mount are decorated too (MutationObserver)', async () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    let setRows
    function Page() { const [rows, s] = useState(1); setRows = s; return <CardTable><Table rows={rows} /></CardTable> }
    const { container } = render(<Page />)
    await act(async () => { setRows(3); await new Promise(r => setTimeout(r, 0)) })
    const titles = [...container.querySelectorAll('td[data-role="title"]')]
    expect(titles.map(td => td.textContent)).toEqual(['QT1', 'QT2', 'QT3'])
  })
})
