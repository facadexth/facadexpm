// @vitest-environment jsdom
// I-4: a refetch keeps the last loaded add-on map (no plain-cost flash); undefined-equivalent only before the first load.
import { describe, it, expect, vi } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'

vi.mock('../lib/supabase.js', () => ({ supabase: {} }))
const pending = []
vi.mock('../lib/addonSave.js', () => ({
  loadItemAddons: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
  loadAddonPieces: vi.fn(() => new Promise((resolve) => pending.push(resolve))),
}))
const { useItemAddons } = await import('./useItemAddons.js')
const { useTemplateAddonPieces } = await import('./useTemplateAddonPieces.js')

describe('add-on hooks keep the previous map during a refetch', () => {
  it('useItemAddons', async () => {
    const ids = ['o1']
    const { result } = renderHook(() => useItemAddons(ids))
    expect(result.current.loaded).toBe(false)
    expect(result.current.loading).toBe(true)
    const first = { o1: [{ mode: 'merge' }] }
    await act(async () => { pending.shift()(first) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.loaded).toBe(true)
    const map = result.current.itemAddonsByOpening
    expect(map).toEqual(first)
    act(() => { result.current.refetch() })
    await waitFor(() => expect(result.current.loading).toBe(true))
    expect(result.current.loaded).toBe(true)
    expect(result.current.itemAddonsByOpening).toBe(map)
    await act(async () => { pending.shift()({ o1: [] }) })
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.itemAddonsByOpening).toEqual({ o1: [] })
  })
  it('useTemplateAddonPieces reports loaded only after its first load', async () => {
    const templates = [{ id: 'tp', layout_kind: 'sliding_2' }]
    const { result } = renderHook(() => useTemplateAddonPieces(templates))
    expect(result.current.loaded).toBe(false)
    await act(async () => { pending.shift()({ tp: [] }) })
    await waitFor(() => expect(result.current.loaded).toBe(true))
    expect(result.current.addonPiecesByTemplate).toEqual({ tp: [] })
  })
  it('no ids: loaded, not loading', () => {
    const { result } = renderHook(() => useItemAddons([]))
    expect(result.current.loaded).toBe(true)
    expect(result.current.loading).toBe(false)
  })
})
