// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,QR')) } }))

import QRCode from 'qrcode'
import RepairWorkOrderSheet from './RepairWorkOrderSheet.jsx'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const wo = (over = {}) => ({
  number: 'RP2611-012',
  reportedText: 'แจ้งทาง LINE 25/11/2569',
  company: { name: 'บริษัท เฟซาด เอ็กซ์ จำกัด', address: '1 ถนนสุขุมวิท', phone: '02-111-2222', logoUrl: null },
  siteName: 'บ้านคุณสมใจ',
  address: '88/12 หมู่บ้านลดาวัลย์',
  customerText: 'คุณสมใจ ใจดี · 081-234-5678',
  mapUrl: 'https://www.google.com/maps?q=13.7,100.5',
  appointmentText: 'พฤหัส 26/11/2569 · 22:00 · ประมาณ 3 ชม.',
  crewText: 'ช่างเอ (หัวหน้าทีม), ช่างดี',
  warranty: { kind: 'active', text: '✓ อยู่ในประกัน ถึง 15/01/2570 · ไม่เก็บเงิน' },
  preferredText: 'ลูกค้าสะดวก: 27/11/2569 · กลางคืน',
  customerNote: 'มีสุนัขในบ้าน',
  rows: [
    { no: 1, where: 'ห้องนอน', room: 'ชั้น 2', symptom: 'รั่วซึม', note: 'น้ำซึมขอบล่าง', photos: [{ url: 'https://x/1.jpg', video: false }] },
    { no: 2, where: 'ห้องนั่งเล่น', room: '', symptom: 'เปิดปิดยาก', note: '', photos: [{ url: 'https://x/2.mp4', video: true }] },
  ],
  receipt: null,
  ...over,
})

describe('RepairWorkOrderSheet', () => {
  it('renders header, rows, warranty, safety and the root id', async () => {
    const { container } = render(<RepairWorkOrderSheet wo={wo()} id="wo-doc" />)
    expect(container.querySelector('#wo-doc')).toBeTruthy()
    expect(screen.getByText('ใบงานซ่อม')).toBeTruthy()
    expect(screen.getByText('RP2611-012')).toBeTruthy()
    expect(screen.getByText('รายการที่ต้องซ่อม (2 รายการ)')).toBeTruthy()
    expect(screen.getByText('ห้องนอน')).toBeTruthy()
    expect(screen.getByText('ห้องนั่งเล่น')).toBeTruthy()
    expect(screen.getByText('✓ อยู่ในประกัน ถึง 15/01/2570 · ไม่เก็บเงิน')).toBeTruthy()
    expect(screen.getByText('⚠️ ก่อนเริ่มงาน: ถ่ายรูปจุดซ่อมก่อนแตะงานทุกจุด · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ')).toBeTruthy()
    expect(screen.getByText('มีสุนัขในบ้าน')).toBeTruthy()
    expect(screen.getByText('▶ วิดีโอ')).toBeTruthy()
    expect(screen.getByText('RP2611-012 · บ้านคุณสมใจ')).toBeTruthy()
    expect(screen.getByText('บร')).toBeTruthy() // initials box (no logo)
    await waitFor(() => expect(container.querySelector('img[alt="แผนที่"]')).toBeTruthy())
    expect(QRCode.toDataURL).toHaveBeenCalledWith('https://www.google.com/maps?q=13.7,100.5', { margin: 0, width: 160 })
  })

  it('no QR when mapUrl is null; ยังไม่ได้นัด; no customer note box', () => {
    const { container } = render(<RepairWorkOrderSheet wo={wo({ mapUrl: null, appointmentText: null, customerNote: null })} id="x" />)
    expect(container.querySelector('img[alt="แผนที่"]')).toBeNull()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
    expect(screen.getByText('ยังไม่ได้นัด')).toBeTruthy()
    expect(screen.queryByText('หมายเหตุจากลูกค้า:')).toBeNull()
  })

  it('shows the signature image, signer name and Bangkok date/time when a receipt exists', () => {
    const receipt = { signer_name: 'สมใจ ใจดี', signed_at: '2026-11-27T18:05:00Z', signature_url: 'https://x/sig.png' }
    const { container } = render(<RepairWorkOrderSheet wo={wo({ receipt })} id="x" />)
    const img = container.querySelector('img[alt="ลายเซ็นลูกค้า"]')
    expect(img).toBeTruthy()
    expect(img.getAttribute('src')).toBe('https://x/sig.png')
    expect(screen.getByText('สมใจ ใจดี')).toBeTruthy()
    expect(screen.getByText('28/11/2569 01:05')).toBeTruthy()
  })

  it('caps photos at 3 per cell and shows +N; null url renders a placeholder', () => {
    const photos = [1, 2, 3, 4, 5].map((n) => ({ url: n === 2 ? null : `https://x/${n}.jpg`, video: false }))
    const { container } = render(<RepairWorkOrderSheet wo={wo({ rows: [{ ...wo().rows[0], photos }] })} id="x" />)
    expect(screen.getByText('+2')).toBeTruthy()
    expect(container.querySelectorAll('img[data-photo]')).toHaveLength(2)
    expect(container.querySelectorAll('[data-photo-missing]')).toHaveLength(1)
    expect(screen.getByText('รายการที่ต้องซ่อม (1 รายการ)')).toBeTruthy()
  })

  it('warranty colour per kind', () => {
    const { rerender } = render(<RepairWorkOrderSheet wo={wo({ warranty: { kind: 'expired', text: 'นอก' } })} id="x" />)
    expect(screen.getByText('นอก').style.color).toBe('rgb(194, 101, 0)')
    rerender(<RepairWorkOrderSheet wo={wo({ warranty: { kind: 'none', text: 'ไม่มีประกัน' } })} id="x" />)
    expect(screen.getByText('ไม่มีประกัน').style.color).toBe('rgb(102, 102, 102)')
  })
})
