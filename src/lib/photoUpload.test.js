import { describe, it, expect, vi } from 'vitest'

// Mock supabase to avoid WebSocket initialization issues in test environment
vi.mock('./supabase.js', () => ({
  supabase: {
    storage: {
      from: vi.fn(),
    },
    from: vi.fn(),
  },
}))

import { computePhotoDownscaledSize } from './photoUpload.js'

describe('computePhotoDownscaledSize', () => {
  it('leaves an image already under maxDim unchanged', () => {
    expect(computePhotoDownscaledSize(800, 600, 1600)).toEqual({ width: 800, height: 600 })
  })
  it('scales down a landscape image so the longest side hits maxDim', () => {
    expect(computePhotoDownscaledSize(3200, 1600, 1600)).toEqual({ width: 1600, height: 800 })
  })
  it('scales down a portrait image so the longest side hits maxDim', () => {
    expect(computePhotoDownscaledSize(1200, 4000, 1600)).toEqual({ width: 480, height: 1600 })
  })
  it('never upscales a small image', () => {
    expect(computePhotoDownscaledSize(400, 300, 1600)).toEqual({ width: 400, height: 300 })
  })
})
