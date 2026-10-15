// @vitest-environment jsdom
import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { useBackToClose } from './useBackToClose.js'

afterEach(cleanup)

afterEach(() => vi.restoreAllMocks())

describe('useBackToClose (moved out of Modal, same contract)', () => {
  it('pushes one history entry on mount and calls onClose on popstate', () => {
    const onClose = vi.fn()
    const push = vi.spyOn(window.history, 'pushState')
    renderHook(() => useBackToClose(onClose))
    expect(push).toHaveBeenCalledTimes(1)
    expect(window.history.state).toEqual({ modalOpen: true })
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('re-pushes the entry when onClose returns false (close refused)', () => {
    const onClose = vi.fn(() => false)
    renderHook(() => useBackToClose(onClose))
    window.history.replaceState(null, '')          // the browser consumed the entry on back
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(window.history.state).toEqual({ modalOpen: true })
  })

  it('closed another way: pops its own entry on unmount (the popstate it causes is swallowed, not a close)', () => {
    const onClose = vi.fn()
    // like a browser: back() fires a popstate; the hook must NOT treat its own clean-up popstate as a close
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
    const { unmount } = renderHook(() => useBackToClose(onClose))
    expect(window.history.state).toEqual({ modalOpen: true })
    unmount()
    expect(back).toHaveBeenCalledTimes(1)
    expect(onClose).not.toHaveBeenCalled()
  })

  it('(legacy shape) pops its own entry on unmount', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
    const { unmount } = renderHook(() => useBackToClose(() => {}))
    expect(window.history.state).toEqual({ modalOpen: true })
    unmount()
    expect(back).toHaveBeenCalledTimes(1)
  })

  it('closed by back: does not call history.back() on unmount', () => {
    const back = vi.spyOn(window.history, 'back').mockImplementation(() => {})
    const { unmount } = renderHook(() => useBackToClose(() => {}))
    window.history.replaceState(null, '')
    window.dispatchEvent(new PopStateEvent('popstate'))
    unmount()
    expect(back).not.toHaveBeenCalled()
  })
})
