// @vitest-environment jsdom
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { render, cleanup, act, fireEvent } from '@testing-library/react'
import LandscapeView from './LandscapeView.jsx'
import { PHONE_QUERY } from '../hooks/useIsPhone.js'

afterEach(cleanup)

function mockMedia({ phone = true, portrait = true, sideways = false } = {}) {
  const make = matches => {
    const listeners = new Set()
    const mql = {
      matches,
      addEventListener: (_, fn) => listeners.add(fn),
      removeEventListener: (_, fn) => listeners.delete(fn),
      fire(next) { mql.matches = next; listeners.forEach(fn => fn({ matches: next })) },
    }
    return mql
  }
  const q = { [PHONE_QUERY]: make(phone), '(orientation: portrait)': make(portrait), '(orientation: landscape)': make(!portrait), '(pointer: coarse) and (orientation: landscape) and (max-height: 499px)': make(sideways) }
  window.matchMedia = query => { if (!q[query]) throw new Error('unexpected query ' + query); return q[query] }
  // turning the phone: both queries flip
  q.turn = (toPortrait, height) => {
    window.innerHeight = height
    q['(orientation: portrait)'].fire(toPortrait)
    q['(orientation: landscape)'].fire(!toPortrait)
  }
  return q
}

const Child = () => <div data-testid="child">chart</div>

describe('LandscapeView', () => {
  let saved, savedH
  beforeEach(() => { saved = window.matchMedia; savedH = window.innerHeight })
  afterEach(() => { window.matchMedia = saved; window.innerHeight = savedH })

  it('desktop: returns the child itself, no wrapper', () => {
    mockMedia({ phone: false })
    const { container, getByTestId } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    expect(container.firstChild).toBe(getByTestId('child'))
  })

  it('phone: shows the button and the children inline', () => {
    mockMedia()
    const { getByText, getByTestId } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    expect(getByText('⤢ ดูแนวนอน').className).toBe('btn btn-ghost btn-sm phone-landscape-btn')
    expect(getByTestId('child')).toBeTruthy()
  })

  it('click opens the overlay with title and close button; children render once; X closes', () => {
    mockMedia()
    const { getByText, getByLabelText, queryByLabelText, getAllByTestId } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    fireEvent.click(getByText('⤢ ดูแนวนอน'))
    expect(document.querySelector('.phone-landscape-overlay')).toBeTruthy()
    expect(document.querySelector('.phone-landscape-overlay').parentElement).toBe(document.body)
    expect(getByText('Gantt')).toBeTruthy()
    expect(getByText('กำลังดูแนวนอน')).toBeTruthy()
    expect(getAllByTestId('child')).toHaveLength(1)
    fireEvent.click(getByLabelText('ปิดมุมมองแนวนอน'))
    expect(queryByLabelText('ปิดมุมมองแนวนอน')).toBeNull()
    expect(document.querySelector('.phone-landscape-overlay')).toBeNull()
  })

  it('Escape closes', () => {
    mockMedia()
    const { getByText } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    fireEvent.click(getByText('⤢ ดูแนวนอน'))
    fireEvent.keyDown(document, { key: 'Escape' })
    expect(document.querySelector('.phone-landscape-overlay')).toBeNull()
  })

  it('portrait: stage is rotated; landscape: it is not', () => {
    const q = mockMedia({ portrait: true })
    const { getByText } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    fireEvent.click(getByText('⤢ ดูแนวนอน'))
    expect(document.querySelector('.phone-landscape-stage').classList.contains('is-rotated')).toBe(true)
    act(() => q.turn(false, 390))
    expect(document.querySelector('.phone-landscape-stage').classList.contains('is-rotated')).toBe(false)
    act(() => q.turn(true, 844))
    expect(document.querySelector('.phone-landscape-overlay')).toBeTruthy()
    expect(document.querySelector('.phone-landscape-stage').classList.contains('is-rotated')).toBe(true)
  })

  it('turning the phone sideways (height < 500) opens it', () => {
    const q = mockMedia({ portrait: true })
    render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    expect(document.querySelector('.phone-landscape-overlay')).toBeNull()
    act(() => q.turn(false, 390))
    expect(document.querySelector('.phone-landscape-overlay')).toBeTruthy()
  })

  it('roomy landscape (height >= 500, e.g. unfolded foldable) does not auto-open', () => {
    const q = mockMedia({ portrait: true })
    const { getByText } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    act(() => q.turn(false, 700))
    expect(document.querySelector('.phone-landscape-overlay')).toBeNull()
    fireEvent.click(getByText('⤢ ดูแนวนอน'))
    expect(document.querySelector('.phone-landscape-overlay')).toBeTruthy()
  })

  it('autoOpen={false}: turning the phone does not open it', () => {
    const q = mockMedia({ phone: true, portrait: true })
    const { queryByText } = render(<LandscapeView title="S-curve" autoOpen={false}><Child /></LandscapeView>)
    act(() => q.turn(false, 390))
    expect(queryByText('S-curve')).toBeNull()
  })

  it('big phone held sideways (wider than 900px) still counts as a phone', () => {
    mockMedia({ phone: false, portrait: false, sideways: true })
    const { getByText } = render(<LandscapeView title="Gantt"><Child /></LandscapeView>)
    expect(getByText('⤢ ดูแนวนอน')).toBeTruthy()
  })

  it('turning the phone while another stage is open does not open a second one', () => {
    const q = mockMedia({ phone: true, portrait: true })
    const { getAllByText, queryByText } = render(<>
      <LandscapeView title="Gantt"><Child /></LandscapeView>
      <LandscapeView title="S-curve" autoOpen={false}><Child /></LandscapeView>
    </>)
    fireEvent.click(getAllByText('⤢ ดูแนวนอน')[1])
    expect(queryByText('S-curve')).toBeTruthy()
    act(() => q.turn(false, 390))
    expect(queryByText('Gantt')).toBeNull()
  })
})
