// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'

const uploadMock = vi.fn()
const saveMarksMock = vi.fn(async () => [])
vi.mock('../../../hooks/useDeliveryReport.js', () => ({
  uploadSiteDrawing: (...a) => uploadMock(...a),
  saveSiteDrawingMarks: (...a) => saveMarksMock(...a),
}))
vi.mock('../../../lib/supabase.js', () => ({
  supabase: { storage: { from: () => ({ createSignedUrl: async p => ({ data: { signedUrl: 'u:' + p } }) }) } },
}))

import PlanMarkup from './PlanMarkup.jsx'
import PlanMarkupEditor, { clampMark, markCardLabel } from './PlanMarkupEditor.jsx'
import { markColour } from '../../../lib/deliveryReport.js'

// jsdom has no PointerEvent; without this fireEvent.pointer* drops clientX/clientY.
if (!window.PointerEvent) {
  window.PointerEvent = class extends MouseEvent { constructor(t, p = {}) { super(t, p); this.pointerId = p.pointerId } }
}

afterEach(() => { cleanup(); vi.clearAllMocks() })

const plan = { id: 'p1', title: 'ชั้น 1', url: 'img.png', width: 400, height: 300 }
const rect = { id: 'm1', kind: 'rect', x: 0.1, y: 0.2, w: 0.3, h: 0.4, task_id: 't1' }
const attrs = el => ['x', 'y', 'width', 'height', 'fill'].map(a => el.getAttribute(a))
const sized = (w, h) => ({ left: 0, top: 0, width: w, height: h, right: w, bottom: h, x: 0, y: 0 })

describe('PlanMarkup', () => {
  it('marks survive resize', () => {
    const a = render(<div style={{ width: 400, height: 300 }}><PlanMarkup plan={plan} marks={[rect]} /></div>)
    const r1 = attrs(a.container.querySelector('rect'))
    cleanup()
    const b = render(<div style={{ width: 800, height: 600 }}><PlanMarkup plan={plan} marks={[rect]} /></div>)
    expect(attrs(b.container.querySelector('rect'))).toEqual(r1)
    expect(b.container.querySelector('svg').getAttribute('viewBox')).toBe('0 0 1 1')
    expect(b.container.querySelector('svg').getAttribute('preserveAspectRatio')).toBe('none')
  })

  it('colour follows colourFor', () => {
    const colourFor = id => markColour(id, { prevTaskIds: new Set(['t1']), thisTaskIds: new Set(['t2']) })
    const { container } = render(<PlanMarkup plan={plan} colourFor={colourFor} cardOrder={['t2']}
      marks={[rect, { kind: 'pin', x: 0.5, y: 0.5, task_id: 't2' }, { kind: 'pin', x: 0.6, y: 0.5, task_id: 't9' }]} />)
    expect(container.querySelector('rect').getAttribute('fill')).toBe('#16a34a')
    expect(container.querySelector('rect').getAttribute('fill-opacity')).toBe('0.35')
    const pins = container.querySelectorAll('[data-kind="pin"]')
    expect(pins[0].style.background).toBe('rgb(249, 115, 22)')
    expect(pins[0].textContent).toBe('1')
    expect(pins[1].style.background).toBe('rgb(156, 163, 175)')
    expect(pins[1].textContent).toBe('•')
  })
})

describe('PlanMarkup pins', () => {
  it('pin is placed by percentage and has a fixed px size', () => {
    const { container } = render(<PlanMarkup plan={plan} marks={[{ kind: 'pin', x: 0.25, y: 0.75, task_id: null }]} />)
    const pin = container.querySelector('[data-kind="pin"]')
    expect(pin.tagName).toBe('SPAN')
    expect(pin.style.left).toBe('25%')
    expect(pin.style.top).toBe('75%')
    expect(pin.style.width).toBe('22px')
    expect(pin.style.height).toBe('22px')
  })
})

describe('PlanMarkupEditor', () => {
  const cards = [{ taskId: 't1', title: 'ผนังกระจก A' }]
  const mount = (props = {}) => {
    const r = render(<PlanMarkupEditor siteId="s1" tenantId="tn" plans={[plan]} marksByPlan={{}} cards={cards} colourFor={() => '#9ca3af'} {...props} />)
    const img = r.container.querySelector('img')
    img.getBoundingClientRect = () => sized(400, 300)
    return { ...r, img }
  }

  it('click with pin tool at (200,150) on 400×300 image stores x 0.5 y 0.5', async () => {
    const { img } = mount()
    fireEvent.click(screen.getByText('หมุด'))
    fireEvent.pointerDown(img.parentElement, { clientX: 200, clientY: 150, pointerId: 1 })
    fireEvent.change(screen.getByLabelText('การ์ดของเครื่องหมาย 1'), { target: { value: 't1' } })
    fireEvent.click(screen.getByText('บันทึก'))
    await waitFor(() => expect(saveMarksMock).toHaveBeenCalled())
    const [planId, marks] = saveMarksMock.mock.calls[0]
    expect(planId).toBe('p1')
    expect(marks[0]).toMatchObject({ kind: 'pin', x: 0.5, y: 0.5, task_id: 't1' })
  })

  it('rect drag past the edge is clamped inside the image', async () => {
    const { img } = mount()
    const box = img.parentElement
    fireEvent.pointerDown(box, { clientX: 300, clientY: 150, pointerId: 1 })
    fireEvent.pointerMove(box, { clientX: 500, clientY: 400, pointerId: 1 })
    fireEvent.pointerUp(box, { clientX: 500, clientY: 400, pointerId: 1 })
    fireEvent.click(screen.getByText('บันทึก'))
    await waitFor(() => expect(saveMarksMock).toHaveBeenCalled())
    const m = saveMarksMock.mock.calls[0][1][0]
    expect(m).toMatchObject({ kind: 'rect', x: 0.75, y: 0.5, w: 0.25, h: 0.5 })
    expect(m.x + m.w).toBeLessThanOrEqual(1)
  })

  it('failed signed URL is not re-requested on re-render', async () => {
    const spy = vi.fn(async () => ({ data: null, error: { message: 'x' } }))
    const { supabase } = await import('../../../lib/supabase.js')
    const orig = supabase.storage.from
    supabase.storage.from = () => ({ createSignedUrl: spy })
    try {
      const p2 = { id: 'p2', title: 'B', file_path: 'a/b.png' }
      const props = { siteId: 's1', tenantId: 'tn', plans: [p2], marksByPlan: {}, cards, colourFor: () => '#000' }
      const r = render(<PlanMarkupEditor {...props} />)
      await waitFor(() => expect(spy).toHaveBeenCalledTimes(1))
      r.rerender(<PlanMarkupEditor {...props} />)
      r.rerender(<PlanMarkupEditor {...props} plans={[{ ...p2 }]} />)
      await new Promise(res => setTimeout(res, 30))
      expect(spy).toHaveBeenCalledTimes(1)
    } finally { supabase.storage.from = orig }
  })

  it('press on a zero-size image is ignored; pointercancel clears drag', () => {
    const { img } = mount()
    img.getBoundingClientRect = () => sized(0, 0)
    fireEvent.pointerDown(img.parentElement, { clientX: 10, clientY: 10, pointerId: 1 })
    img.getBoundingClientRect = () => sized(400, 300)
    expect(document.querySelectorAll('rect').length).toBe(0)
    fireEvent.pointerDown(img.parentElement, { clientX: 10, clientY: 10, pointerId: 1 })
    fireEvent.pointerMove(img.parentElement, { clientX: 200, clientY: 200, pointerId: 1 })
    expect(document.querySelectorAll('rect').length).toBe(1)
    fireEvent.pointerCancel(img.parentElement, { pointerId: 1 })
    expect(document.querySelectorAll('rect').length).toBe(0)
  })

  it('new mark shows the pick-card hint', () => {
    const { img } = mount()
    fireEvent.click(screen.getByText('หมุด'))
    fireEvent.pointerDown(img.parentElement, { clientX: 20, clientY: 20, pointerId: 1 })
    expect(screen.getByText('เลือกการ์ดของจุดนี้ก่อน')).toBeTruthy()
  })

  it('delete mark removes it', () => {
    mount({ marksByPlan: { p1: [rect] } })
    fireEvent.click(screen.getByLabelText('ลบเครื่องหมาย 1'))
    expect(document.querySelector('rect')).toBeNull()
  })

  it('multi-page PDF rejected with รองรับ PDF หน้าเดียว (inline alert)', async () => {
    uploadMock.mockRejectedValueOnce(new Error('รองรับ PDF หน้าเดียว'))
    mount()
    const file = new File(['%PDF'], 'plan.pdf', { type: 'application/pdf' })
    fireEvent.change(screen.getByTestId('plan-file'), { target: { files: [file] } })
    expect((await screen.findByRole('alert')).textContent).toBe('รองรับ PDF หน้าเดียว')
  })

  it('clampMark keeps x+w ≤ 1', () => {
    expect(clampMark({ kind: 'rect', x: 0.9, y: -1, w: 0.5, h: 2 })).toMatchObject({ x: 0.9, y: 0, w: 0.1, h: 1 })
  })
})

describe('mark labels', () => {
  afterEach(cleanup)

  it('a rect gets the same number badge as a pin of the same card', () => {
    const { container } = render(<PlanMarkup plan={{ url: 'x' }} cardOrder={['a', 'b']}
      marks={[{ kind: 'rect', x: 0.1, y: 0.1, w: 0.2, h: 0.2, task_id: 'b' }, { kind: 'pin', x: 0.5, y: 0.5, task_id: 'b' }]} />)
    expect(container.querySelector('[data-kind="rect-label"]').textContent).toBe('2')
    expect(container.querySelector('[data-kind="pin"]').textContent).toBe('2')
  })

  it('card picker label adds phase and floor so per-phase cards of one item differ', () => {
    expect(markCardLabel({ name: 'AD2', zone: 'FL.3' }, 'กระจก')).toBe('AD2 · กระจก · FL.3')
    expect(markCardLabel({ name: 'AD2', zone: null }, 'ผลิต')).toBe('AD2 · ผลิต')
  })
})
