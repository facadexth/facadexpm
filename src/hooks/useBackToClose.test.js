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

  it('close with X, then open another overlay: ONE back press closes the new one (no leaked suppression)', () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
    const first = renderHook(() => useBackToClose(() => {}))
    first.unmount()                                            // closed with X → its own back() popstate has no listener
    const onClose = vi.fn()
    renderHook(() => useBackToClose(onClose))
    window.dispatchEvent(new PopStateEvent('popstate'))        // the user's real back press
    expect(onClose).toHaveBeenCalledTimes(1)
  })

  it('nested: the inner overlay closing with X does not close the outer one', () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
    const outerClose = vi.fn()
    renderHook(() => useBackToClose(outerClose))
    const inner = renderHook(() => useBackToClose(() => {}))
    inner.unmount()
    expect(outerClose).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(outerClose).toHaveBeenCalledTimes(1)
  })

  it('async back (real browsers): close with X then open another overlay in the same tick → the new one stays open', async () => {
    vi.useFakeTimers()
    vi.spyOn(window.history, 'back').mockImplementation(() => { setTimeout(() => window.dispatchEvent(new PopStateEvent('popstate')), 0) })
    const first = renderHook(() => useBackToClose(() => {}))
    first.unmount()                                            // back() queued
    const onClose = vi.fn()
    renderHook(() => useBackToClose(onClose))                  // opened before the popstate arrives
    await vi.runAllTimersAsync()                               // the stale popstate arrives now
    expect(onClose).not.toHaveBeenCalled()
    window.dispatchEvent(new PopStateEvent('popstate'))        // the user's real back press
    expect(onClose).toHaveBeenCalledTimes(1)
    vi.useRealTimers()
  })

  it('a real back press closes only the top overlay', () => {
    vi.spyOn(window.history, 'back').mockImplementation(() => window.dispatchEvent(new PopStateEvent('popstate')))
    const outer = vi.fn(), inner = vi.fn()
    renderHook(() => useBackToClose(outer))
    const h = renderHook(() => useBackToClose(inner))
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(inner).toHaveBeenCalledTimes(1); expect(outer).not.toHaveBeenCalled()
    h.unmount()                                                // closed by back: no extra back()
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(outer).toHaveBeenCalledTimes(1)
  })

  it('uses the latest onClose, not the one from the first render', () => {
    const a = vi.fn(), b = vi.fn()
    const h = renderHook(({ fn }) => useBackToClose(fn), { initialProps: { fn: a } })
    h.rerender({ fn: b })
    window.dispatchEvent(new PopStateEvent('popstate'))
    expect(a).not.toHaveBeenCalled(); expect(b).toHaveBeenCalledTimes(1)
  })
})
