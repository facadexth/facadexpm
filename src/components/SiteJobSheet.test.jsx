// @vitest-environment jsdom
import { describe, it, expect, afterEach, vi } from 'vitest'
import { render, screen, cleanup, waitFor } from '@testing-library/react'

vi.mock('qrcode', () => ({ default: { toDataURL: vi.fn(() => Promise.resolve('data:image/png;base64,QR')) } }))

import QRCode from 'qrcode'
import SiteJobSheet from './SiteJobSheet.jsx'
import { buildJobSheet } from '../../supabase/functions/_shared/site-jobsheet.ts'

afterEach(() => { cleanup(); vi.clearAllMocks() })

const card = (over = {}) => ({
  id: 'c1', phase_id: 'p1', name: 'งาน', zone: null, status: 'not_started', sort_order: 0,
  progress_mode: 'status', planned_qty: null, done_qty: null, unit: null, issue_report_id: null,
  has_children: false, worker_ids: [], updated_at: '2026-11-20T03:00:00Z', ...over,
})

const input = (over = {}) => ({
  tenant: { company_name: 'บริษัท เฟซาด เอ็กซ์ จำกัด', address: '99 ถ.แจ้งวัฒนะ', phone: '02-000-0000', logo_url: null },
  date: '2026-11-26',
  site: { id: 's1', name: 'คอนโด The Line', location: '88 ถ.พระราม 9', map_url: 'https://maps.example/x', lat: null, lng: null, safety_note: 'ใส่เข็มขัดนิรภัยทุกครั้ง' },
  tenantSafetyDefault: null,
  run: { index: 3, total: 5, from: '2026-11-24', to: '2026-11-28' },
  crew: [
    { worker_id: 'w1', name: 'สมชาย', nickname: 'ชาย', shifts: ['morning', 'evening'], is_team_leader: true },
    { worker_id: 'w2', name: 'บอย', nickname: null, shifts: ['morning'], is_team_leader: false },
  ],
  phases: [
    { id: 'p1', name: 'ติดตั้งบานกระจก', sort_order: 1 },
    { id: 'pi', name: 'ปัญหา', sort_order: 99, is_issue_phase: true },
  ],
  cards: [
    card({ id: 'a', zone: 'ชั้น 21', name: 'ติดตั้งบานเลื่อน W1–W6', status: 'in_progress', progress_mode: 'quantity', planned_qty: 6, done_qty: 4, unit: 'บาน', worker_ids: ['w2'] }),
    card({ id: 'b', zone: 'ชั้น 21', name: 'ติดตั้งมุ้งลวด', sort_order: 1 }),
    card({ id: 'c', zone: 'ชั้น 20', name: 'ยิงซิลิโคนรอบบาน', worker_ids: ['w1'] }),
    card({ id: 'x', phase_id: 'pi', zone: 'ชั้น 21', name: 'บาน W5 รางเบี้ยว' }),
  ],
  drawings: [{ id: 'd1', title: 'ผังชั้น 21', url: 'https://x/d1.pdf' }, { id: 'd2', title: 'แบบบาน W1', url: null }],
  viewerWorkerId: null,
  ...over,
})

const sheet = (over) => buildJobSheet(input(over))

describe('SiteJobSheet', () => {
  it('renders header, cards, safety, counts and the root id', async () => {
    const { container } = render(<SiteJobSheet sheet={sheet()} id="js-doc" />)
    expect(container.querySelector('#js-doc')).toBeTruthy()
    expect(screen.getByText('ใบงานประจำวัน')).toBeTruthy()
    expect(screen.getByText(sheet().dateText)).toBeTruthy()
    expect(screen.getByText('ฟ')).toBeTruthy()
    expect(screen.getByText('การ์ดงานวันนี้ (3 ใบ)')).toBeTruthy()
    expect(screen.getByText('⚠️ ใส่เข็มขัดนิรภัยทุกครั้ง')).toBeTruthy()
    expect(screen.getByText('4/6 บาน')).toBeTruthy()
    expect(screen.getByText('กำลังทำ')).toBeTruthy()
    expect(screen.getAllByText('เสร็จทั้งการ์ด')).toHaveLength(3)
    expect(screen.getAllByText('ทำต่อพรุ่งนี้')).toHaveLength(3)
    expect(screen.getByText('สมชาย (ชาย) · เช้า + บ่าย')).toBeTruthy()
    expect(screen.getByText('หัวหน้าทีม', { selector: 'div' })).toBeTruthy()
    expect(screen.getByText('ผู้ตรวจ (PM)')).toBeTruthy()
    await waitFor(() => expect(container.querySelector('img[alt="แผนที่"]')).toBeTruthy())
    expect(QRCode.toDataURL).toHaveBeenCalledWith('https://maps.example/x', { margin: 0, width: 160 })
  })

  it('one zone row per group, zone only when a single phase', () => {
    const { container } = render(<SiteJobSheet sheet={sheet()} id="x" />)
    const zones = [...container.querySelectorAll('[data-zone-row]')].map((r) => r.textContent)
    expect(zones).toEqual(['ชั้น 20', 'ชั้น 21'])
    const rows = [...container.querySelectorAll('[data-card-row]')].map((r) => r.firstChild.textContent)
    expect(rows).toEqual(['1', '2', '3'])
  })

  it('zone rows carry the phase name when the sheet spans several phases', () => {
    const base = input()
    const s = sheet({
      phases: [...base.phases, { id: 'p2', name: 'ซิลิโคน', sort_order: 2 }],
      cards: [...base.cards, card({ id: 'd', phase_id: 'p2', zone: 'ชั้น 20', name: 'ยิงขอบ' })],
    })
    const { container } = render(<SiteJobSheet sheet={s} id="x" />)
    const zones = [...container.querySelectorAll('[data-zone-row]')].map((r) => r.textContent)
    expect(zones).toEqual(['ติดตั้งบานกระจก · ชั้น 20', 'ติดตั้งบานกระจก · ชั้น 21', 'ซิลิโคน · ชั้น 20'])
  })

  it('run dots: done green, today blue, rest grey', () => {
    const { container } = render(<SiteJobSheet sheet={sheet()} id="x" />)
    const dots = [...container.querySelectorAll('[data-dot]')].map((d) => d.getAttribute('data-dot'))
    expect(dots).toEqual(['done', 'done', 'today', 'todo', 'todo'])
    expect(screen.getByText(sheet().runText)).toBeTruthy()
  })

  it('dots come from sheet.run, not from parsing runText', () => {
    const { container } = render(<SiteJobSheet sheet={{ ...sheet(), runText: 'อะไรก็ได้', run: { index: 1, total: 2 } }} id="x" />)
    const dots = [...container.querySelectorAll('[data-dot]')].map((d) => d.getAttribute('data-dot'))
    expect(dots).toEqual(['today', 'todo'])
  })

  it('two phases with the same name still get separate zone rows with the phase name', () => {
    const base = input()
    const s = sheet({
      phases: [...base.phases, { id: 'p2', name: 'ติดตั้งบานกระจก', sort_order: 2 }],
      cards: [...base.cards, card({ id: 'd', phase_id: 'p2', zone: 'ชั้น 20', name: 'ยิงขอบ' })],
    })
    const { container } = render(<SiteJobSheet sheet={s} id="x" />)
    const zones = [...container.querySelectorAll('[data-zone-row]')].map((r) => r.textContent)
    expect(zones).toEqual(['ติดตั้งบานกระจก · ชั้น 20', 'ติดตั้งบานกระจก · ชั้น 21', 'ติดตั้งบานกระจก · ชั้น 20'])
    expect(container.querySelectorAll('[data-card-row]')).toHaveLength(4)
  })

  it('no run -> ไม่มีข้อมูลรอบ and no dots', () => {
    const { container } = render(<SiteJobSheet sheet={sheet({ run: null })} id="x" />)
    expect(screen.getByText('ไม่มีข้อมูลรอบ')).toBeTruthy()
    expect(container.querySelector('[data-run-dots]')).toBeNull()
  })

  it('problems and drawings blocks show their content', () => {
    const { container } = render(<SiteJobSheet sheet={sheet()} id="x" />)
    expect(screen.getByText('ปัญหาที่ต้องแก้ (ภายใน)')).toBeTruthy()
    expect(screen.getByText('บาน W5 รางเบี้ยว · ชั้น 21')).toBeTruthy()
    expect(screen.getByText('แบบที่เกี่ยวข้อง')).toBeTruthy()
    expect(container.querySelector('[data-drawings]').textContent).toContain('ผังชั้น 21 · แบบบาน W1')
    expect(container.querySelectorAll('[data-drawings] img')).toHaveLength(0)
  })

  it('problems block hidden when empty; drawings block hidden when none', () => {
    const base = input()
    const { container } = render(<SiteJobSheet sheet={sheet({ cards: base.cards.filter((c) => c.id !== 'x'), drawings: [] })} id="x" />)
    expect(screen.queryByText('ปัญหาที่ต้องแก้ (ภายใน)')).toBeNull()
    expect(container.querySelector('[data-problems]')).toBeNull()
    expect(screen.queryByText('แบบที่เกี่ยวข้อง')).toBeNull()
  })

  it('no QR without mapUrl', () => {
    const base = input()
    const { container } = render(<SiteJobSheet sheet={sheet({ site: { ...base.site, map_url: null } })} id="x" />)
    expect(container.querySelector('img[alt="แผนที่"]')).toBeNull()
    expect(QRCode.toDataURL).not.toHaveBeenCalled()
  })

  it('footer text', () => {
    const s = sheet()
    render(<SiteJobSheet sheet={s} id="x" />)
    expect(screen.getByText(`ใบงานประจำวัน ${s.dateText} · คอนโด The Line · เอกสารภายใน`)).toBeTruthy()
  })

  it('logo image replaces the initial when logoUrl is set', () => {
    const base = input()
    const { container } = render(<SiteJobSheet sheet={sheet({ tenant: { ...base.tenant, logo_url: 'https://x/logo.png' } })} id="x" />)
    expect(container.querySelector('img[src="https://x/logo.png"]')).toBeTruthy()
    expect(screen.queryByText('ฟ')).toBeNull()
  })
})
