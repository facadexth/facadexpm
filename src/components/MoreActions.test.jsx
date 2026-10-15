// @vitest-environment jsdom
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import MoreActions from './MoreActions.jsx'
import * as phone from '../hooks/useIsPhone.js'

afterEach(cleanup)
beforeEach(() => vi.restoreAllMocks())

describe('MoreActions', () => {
  it('desktop: children only, no wrapper', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(false)
    const { container } = render(<MoreActions><button>A</button><button>B</button></MoreActions>)
    expect([...container.childNodes].map(n => n.textContent)).toEqual(['A', 'B'])
  })

  it('phone: ⋯ opens the menu with the children; a click inside closes it; outside tap closes it', () => {
    vi.spyOn(phone, 'useIsPhone').mockReturnValue(true)
    const onA = vi.fn()
    render(<MoreActions><button onClick={onA}>A</button></MoreActions>)
    expect(screen.queryByText('A')).toBeNull()
    fireEvent.click(screen.getByLabelText('เพิ่มเติม'))
    fireEvent.click(screen.getByText('A'))
    expect(onA).toHaveBeenCalled()
    expect(screen.queryByText('A')).toBeNull()
    fireEvent.click(screen.getByLabelText('เพิ่มเติม'))
    expect(screen.getByText('A')).toBeTruthy()
    fireEvent.pointerDown(document.body)
    expect(screen.queryByText('A')).toBeNull()
  })
})
