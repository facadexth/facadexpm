// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react'

const h = vi.hoisted(() => ({ load: null, release: null, wait: null, download: null }))

vi.mock('../lib/supabase.js', () => ({ supabase: { tag: 'client' } }))
vi.mock('../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: { company_name: 'สร้างดี' }, loading: false }) }))
vi.mock('../lib/pdf.js', () => ({ downloadPDF: (...a) => h.download(...a) }))
vi.mock('../lib/siteJobsheetLoad.js', () => ({ loadJobSheet: (...a) => h.load(...a) }))
vi.mock('../lib/repairWorkorderLoad.js', () => ({ waitForSheetImages: (...a) => h.wait(...a) }))
vi.mock('./SiteJobSheet.jsx', () => ({ default: ({ sheet, id }) => <div id={id} data-testid="sheet">{sheet.siteName}</div> }))

import SiteJobSheetModal, { beDateForFile, jobSheetFileName } from './SiteJobSheetModal.jsx'

afterEach(cleanup)

const SHEET = { siteName: 'คอนโด A/B', dateText: 'พฤหัสบดี 26/11/2569', mapUrl: 'https://maps.app/x' }

describe('jobSheetFileName', () => {
  it('uses dd-mm-yyyy BE and replaces / and \\', () => {
    expect(beDateForFile('2026-11-26')).toBe('26-11-2569')
    expect(beDateForFile('bad')).toBe('')
    expect(jobSheetFileName('A/B\\C', '2026-01-05')).toBe('ใบงาน-A-B-C-05-01-2569.pdf')
    expect(jobSheetFileName('  ', '2026-01-05')).toBe('ใบงาน-ไซท์-05-01-2569.pdf')
  })
})

describe('SiteJobSheetModal', () => {
  it('loads with the logged-in client, waits for images/QR, downloads site-js-<id> under the short name', async () => {
    h.load = vi.fn(async () => SHEET)
    h.wait = vi.fn(() => new Promise((r) => { h.release = r }))
    h.download = vi.fn(async () => {})
    render(<SiteJobSheetModal siteId="s1" date="2026-11-26" shortName="CDA" onClose={() => {}} />)
    await screen.findByTestId('sheet')
    expect(screen.getByText('ใบงานประจำวัน · คอนโด A/B · พฤหัสบดี 26/11/2569')).toBeTruthy()
    expect(h.load.mock.calls[0]).toEqual([{ tag: 'client' }, 's1', { company_name: 'สร้างดี' }, '2026-11-26'])
    const btn = screen.getByText('กำลังเตรียม…')
    expect(btn.disabled).toBe(true)
    await waitFor(() => expect(h.wait).toHaveBeenCalled())
    expect(h.wait.mock.calls[0][0].id).toBe('site-js-s1')
    expect(h.wait.mock.calls[0][1]).toEqual({ needQr: true })
    await act(async () => { h.release(true) })
    const ready = await screen.findByText('📄 ดาวน์โหลด PDF')
    expect(ready.disabled).toBe(false)
    fireEvent.click(ready)
    await waitFor(() => expect(h.download).toHaveBeenCalledWith('site-js-s1', 'ใบงาน-CDA-26-11-2569.pdf'))
  })

  it('falls back to the sheet site name (sanitised) and no QR wait when there is no map', async () => {
    h.load = vi.fn(async () => ({ ...SHEET, mapUrl: null }))
    h.wait = vi.fn(async () => true)
    h.download = vi.fn(async () => {})
    render(<SiteJobSheetModal siteId="s2" date="2026-11-26" onClose={() => {}} />)
    const ready = await screen.findByText('📄 ดาวน์โหลด PDF')
    expect(h.wait.mock.calls[0][1]).toEqual({ needQr: false })
    fireEvent.click(ready)
    await waitFor(() => expect(h.download).toHaveBeenCalledWith('site-js-s2', 'ใบงาน-คอนโด A-B-26-11-2569.pdf'))
  })

  it('shows the load error and keeps the button disabled', async () => {
    h.load = vi.fn(async () => { throw new Error('โหลดใบงานไม่สำเร็จ: boom') })
    h.wait = vi.fn(async () => true)
    render(<SiteJobSheetModal siteId="s1" date="2026-11-26" onClose={() => {}} />)
    expect(await screen.findByText('โหลดใบงานไม่สำเร็จ: boom')).toBeTruthy()
    expect(screen.getByText('กำลังเตรียม…').disabled).toBe(true)
    expect(screen.getByText('ใบงานประจำวัน')).toBeTruthy()
  })
})
