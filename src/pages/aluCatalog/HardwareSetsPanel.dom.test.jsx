// @vitest-environment jsdom
// The hardware set page in a browser-like DOM: a failed save shows its error inside the open set form; a failed
// purchase-price load is said out loud (panel and stock picker); "ลบชุด" asks in the page, then removes or refuses.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup, within } from '@testing-library/react'

const state = vi.hoisted(() => ({ answer: null, rpc: null, log: [] }))
vi.mock('../../lib/supabase.js', () => {
  const from = table => {
    const calls = []
    state.log.push({ table, calls })
    const b = new Proxy({}, {
      get(_, k) {
        if (k === 'then') return (res, rej) => Promise.resolve(state.answer(table, calls)).then(res, rej)
        return (...a) => { calls.push([k, ...a]); return b }
      },
    })
    return b
  }
  return { supabase: { from, rpc: (...a) => state.rpc(...a) } }
})
const TABLES = {
  alu_parts: [
    { id: 'SET', code: 'P-0025', name: 'อุปกรณ์หน้าต่างบานเลื่อนสวน', kind: 'hardware_set', unit: 'ชุด', active: true },
    { id: 'P9', code: 'P-0009', name: 'ลูกล้อบานเลื่อน', kind: 'hardware', unit: 'ชิ้น', active: true, inventory_item_id: 'i1' },
  ],
  alu_part_set_items: [{ id: 'a', set_id: 'SET', part_id: 'P9', quantity: 4 }],
}
const refetch = vi.fn(async () => {})
vi.mock('../../hooks/useAluCatalog.js', () => ({
  useCatalogTable: table => ({ data: TABLES[table] || [], error: null, loading: false, refetch }),
}))
const { default: HardwareSetsPanel } = await import('./HardwareSetsPanel.jsx')
const { default: StockItemPicker } = await import('./StockItemPicker.jsx')
const { SECTIONS } = await import('../../lib/hardwareSetView.js')

const ok = () => ({ data: [], count: 0, error: null })
beforeEach(() => {
  cleanup()
  state.log = []
  state.answer = ok
  state.rpc = async () => ({ data: [], error: null })
  refetch.mockClear()
})
const isRemove = calls => calls.some(c => c[0] === 'delete')
const openSet = async () => fireEvent.click(await screen.findByRole('button', { name: /อุปกรณ์หน้าต่างบานเลื่อนสวน/ }))

describe('set form errors', () => {
  it('a failed create shows its error inside the open form, which stays open', async () => {
    state.answer = (table, calls) => (calls.some(c => c[0] === 'insert') ? { data: null, error: { code: '23505', message: 'dup' } } : ok())
    render(<HardwareSetsPanel canEdit />)
    fireEvent.click(screen.getByRole('button', { name: '+ ชุดใหม่' }))
    const modal = document.querySelector('.modal')
    fireEvent.change(modal.querySelector('input.input'), { target: { value: 'ชุดใหม่ A' } })
    fireEvent.submit(modal.querySelector('form'))
    await waitFor(() => expect(within(modal).getByRole('alert').textContent).toContain('มีข้อมูลนี้อยู่แล้ว (ซ้ำ)'))
    expect(document.querySelector('.modal')).toBe(modal)
  })
  it('a missing name is said inside the form', async () => {
    render(<HardwareSetsPanel canEdit />)
    fireEvent.click(screen.getByRole('button', { name: '+ ชุดใหม่' }))
    const modal = document.querySelector('.modal')
    fireEvent.submit(modal.querySelector('form'))
    await waitFor(() => expect(within(modal).getByRole('alert').textContent).toContain('กรุณากรอก: ชื่อชุด'))
  })
})

describe('purchase prices that fail to load', () => {
  it('the panel warns and falls back to the catalogue', async () => {
    state.rpc = async () => ({ data: null, error: { message: 'boom' } })
    render(<HardwareSetsPanel canEdit />)
    await openSet()
    expect(await screen.findByText('โหลดราคาซื้อล่าสุดไม่สำเร็จ — แสดงราคาแคตตาล็อกแทน')).toBeTruthy()
  })
  it('no warning when they load', async () => {
    render(<HardwareSetsPanel canEdit />)
    await openSet()
    await screen.findByText(/ราคาชุด = รวมราคาของในชุด/)
    expect(screen.queryByText(/โหลดราคาซื้อล่าสุดไม่สำเร็จ/)).toBeNull()
  })
  it('the stock picker warns, and no line claims "ยังไม่มีราคาซื้อ"', async () => {
    state.answer = table => (table === 'inventory_items'
      ? { data: [{ id: 'i1', code: 'HW0001', name: 'มือจับกระทุ้ง', base_unit: 'ชิ้น', active: true, expense_categories: { name: 'อุปกรณ์' } }], error: null }
      : ok())
    state.rpc = async () => ({ data: null, error: { message: 'boom' } })
    render(<StockItemPicker section={SECTIONS[0]} busy={false} onPick={() => {}} onCreate={() => {}} onClose={() => {}} />)
    expect(await screen.findByText('โหลดราคาซื้อไม่สำเร็จ')).toBeTruthy()
    expect(screen.getByText(/มือจับกระทุ้ง/)).toBeTruthy()
    expect(document.body.textContent).not.toContain('ยังไม่มีราคาซื้อ')
  })
})

describe('ลบชุด', () => {
  it('asks in the page; a used set is refused and nothing is removed', async () => {
    state.answer = (table, calls) => (!isRemove(calls) && table === 'estimation_openings' ? { count: 2, error: null } : ok())
    render(<HardwareSetsPanel canEdit />)
    await openSet()
    fireEvent.click(screen.getByRole('button', { name: 'ลบชุด' }))
    expect(screen.getByText(/ลบชุด อุปกรณ์หน้าต่างบานเลื่อนสวน\?/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }))
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('ชุดนี้มีรายการใช้อยู่ — ปิดใช้งานแทน'))
    expect(state.log.filter(e => isRemove(e.calls))).toEqual([])
  })
  it('ยกเลิก closes the question without touching anything', async () => {
    render(<HardwareSetsPanel canEdit />)
    await openSet()
    fireEvent.click(screen.getByRole('button', { name: 'ลบชุด' }))
    fireEvent.click(screen.getByRole('button', { name: 'ยกเลิก' }))
    expect(screen.queryByRole('button', { name: 'ยืนยันลบ' })).toBeNull()
    expect(state.log.length).toBe(0)
  })
  it('an unused set is removed (one request on the set row) and the list reloads', async () => {
    state.answer = (table, calls) => (isRemove(calls) ? { data: [{ id: 'x' }], error: null } : ok())
    render(<HardwareSetsPanel canEdit />)
    await openSet()
    fireEvent.click(screen.getByRole('button', { name: 'ลบชุด' }))
    fireEvent.click(screen.getByRole('button', { name: 'ยืนยันลบ' }))
    await screen.findByText('ลบชุด อุปกรณ์หน้าต่างบานเลื่อนสวน แล้ว')
    expect(state.log.filter(e => isRemove(e.calls)).map(e => e.table)).toEqual(['alu_parts'])
    expect(refetch).toHaveBeenCalled()
  })
})
