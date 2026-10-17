// @vitest-environment jsdom
// The OWNER can assign PM: the role picker offers it and saving writes role 'PM'.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const updates = []
const USERS = [{ id: 'u1', user_email: 'a@x.co', display_name: 'Aom', role: 'ADMIN', created_at: '2026-10-01T00:00:00Z', assigned_checkin_location_id: null }]

vi.mock('../hooks/useSupabase.js', () => ({
  useSeatStatus: () => ({ data: { admins: { used: 1, max: 5 } }, refetch: () => {} }),
  useCheckinLocations: () => ({ data: [] }),
}))
vi.mock('../lib/supabase.js', () => {
  const chain = (table, rows) => {
    const q = {
      select: () => q, order: () => q,
      update: payload => { updates.push({ table, payload }); return q },
      eq: () => q, then: res => Promise.resolve({ data: rows, error: null }).then(res),
    }
    return q
  }
  return { supabase: { from: table => chain(table, table === 'user_roles' ? USERS : []), rpc: async () => ({ data: [], error: null }) } }
})

import UserManagement from './UserManagement.jsx'

afterEach(() => { cleanup(); updates.length = 0; vi.restoreAllMocks() })

describe('UserManagement PM role', () => {
  it('offers PM when creating and editing, and saves role PM', async () => {
    vi.spyOn(window, 'alert').mockImplementation(() => {})
    const { container } = render(<UserManagement />)
    fireEvent.click((await screen.findAllByText('แก้ไข'))[0])
    const select = container.ownerDocument.querySelector('select')
    expect([...select.options].map(o => o.value)).toEqual(['OWNER', 'ADMIN', 'PM', 'WORKER'])
    fireEvent.change(select, { target: { value: 'PM' } })
    // PM gets the check-in location picker and its description
    expect(screen.getByText('ตำแหน่งเช็คอินที่กำหนด')).toBeTruthy()
    expect(screen.getByText(/ไม่เห็นข้อมูลเงิน/)).toBeTruthy()
    fireEvent.click(screen.getByText(/อัปเดต/, { selector: 'button' }))
    await waitFor(() => expect(updates.some(u => u.table === 'user_roles' && u.payload.role === 'PM')).toBe(true))
  })

  it('create picker offers ADMIN, PM, OWNER', async () => {
    const { container } = render(<UserManagement />)
    await screen.findAllByText('แก้ไข')
    fireEvent.click(screen.getByText(/สร้าง|เพิ่ม/, { selector: 'button' }))
    const select = container.ownerDocument.querySelector('select')
    expect([...select.options].map(o => o.value)).toEqual(['ADMIN', 'PM', 'OWNER'])
  })
})
