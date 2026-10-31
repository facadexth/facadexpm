// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor, cleanup } from '@testing-library/react'

const invoke = vi.fn()
vi.mock('./lib/supabase.js', () => ({ supabase: { functions: { invoke: (...a) => invoke(...a) } } }))

import FieldFormPage from './FieldFormPage.jsx'

const FAC = 'โรงงาน (ส่วนกลาง)'
const steps = [
  { kind: 'assembly_leave', siteId: null, done: false, emoji: '🏭', title: `ออกจาก${FAC}`, place: FAC },
  { kind: 'site_arrive', siteId: 'a', done: false, emoji: '🏗️', title: 'ถึงไซท์', place: 'SOAP OPERA' },
  { kind: 'site_leave', siteId: 'a', done: false, emoji: '🏗️', title: 'ออกจากไซท์', place: 'SOAP OPERA' },
  { kind: 'assembly_return', siteId: null, done: false, emoji: '🏭', title: `กลับถึง${FAC}`, place: FAC },
]
const info = { actionType: 'time_clock', workerName: 'ต้น', next: steps[0], steps }

let submitReply
beforeEach(() => {
  cleanup()
  invoke.mockReset()
  submitReply = { ok: true, message: `บันทึกออกจาก${FAC} แล้ว — เริ่มนับเวลางาน`, step: { ...steps[0], done: true }, title: steps[0].title, siteName: FAC, openTasks: [] }
  invoke.mockImplementation(async (_n, { body }) => (body.action === 'info' ? { data: info, error: null } : { data: submitReply, error: null }))
  Object.defineProperty(globalThis.navigator, 'geolocation', {
    configurable: true,
    value: { getCurrentPosition: (ok) => ok({ coords: { latitude: 13.75, longitude: 100.5 } }) },
  })
})

describe('FieldFormPage time_clock (assembly day)', () => {
  it('shows the next step big with the real location name, and the day order', async () => {
    render(<FieldFormPage token="t" />)
    expect(await screen.findByRole('heading', { name: `ออกจาก${FAC}` })).toBeTruthy()
    expect(screen.getAllByText(/SOAP OPERA/).length).toBeGreaterThan(0)
    expect(screen.getByText(`กลับถึง${FAC}`)).toBeTruthy()
  })

  it('records the step from GPS and shows the result', async () => {
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByRole('button', { name: /บันทึก/ }))
    await waitFor(() => expect(screen.getByText(/เริ่มนับเวลางาน/)).toBeTruthy())
    const submit = invoke.mock.calls.find(c => c[1].body.action === 'submit')
    expect(submit[1].body).toEqual({ action: 'submit', token: 't', lat: 13.75, lng: 100.5 })
  })

  it('refused outside the radius: shows the distance and a retry', async () => {
    submitReply = { ok: false, message: `คุณอยู่ห่างจาก${FAC} 2400 เมตร ต้องอยู่ในระยะ 200 เมตรจึงจะบันทึกได้`, distanceM: 2400, radiusM: 200 }
    render(<FieldFormPage token="t" />)
    fireEvent.click(await screen.findByRole('button', { name: /บันทึก/ }))
    await waitFor(() => expect(screen.getAllByText(/2400 เมตร/).length).toBeGreaterThan(0))
    expect(screen.getByRole('button', { name: /ลองอีกครั้ง/ })).toBeTruthy()
  })

  it('a finished day says so', async () => {
    invoke.mockImplementation(async () => ({ data: { ...info, next: null, steps: steps.map(s => ({ ...s, done: true })) }, error: null }))
    render(<FieldFormPage token="t" />)
    expect(await screen.findByText(/บันทึกครบทุกจุดแล้ว/)).toBeTruthy()
  })
})
