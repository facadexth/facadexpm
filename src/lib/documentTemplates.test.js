import { describe, it, expect } from 'vitest'
import { resolveDocumentTemplate, tintHex } from './documentTemplates'
import { DEFAULT_DOCUMENT_STYLE } from './documentStyle'

const templates = [
  { key: 'classic', layout: 'classic', status: 'published', style: {} },
  { key: 'modern', layout: 'modern', status: 'published', style: { accent: '#1e3a5f' } },
  { key: 'premium', layout: 'premium', status: 'draft', style: { accent: '#7a4b2a' } },
]
const packs = [{
  id: 'p1', status: 'published', hero_path: 'p1/hero.jpg',
  gallery: [{ path: 'p1/a.jpg', caption_th: 'ประตู' }, { path: 'p1/b.jpg', caption_th: '' }],
  features_th: ['รับประกัน', ' ', 'ติดตั้งเร็ว'], tagline_th: 'งานเนี้ยบ',
}]

describe('resolveDocumentTemplate', () => {
  it('no template chosen keeps the tenant legacy style on classic', () => {
    const r = resolveDocumentTemplate({ tenant: { document_style: { nameSize: 22 } }, templates, packs })
    expect(r.layout).toBe('classic')
    expect(r.style.nameSize).toBe(22)
    expect(r.content).toBeNull()
  })

  it('no tenant at all still gives defaults', () => {
    const r = resolveDocumentTemplate({ tenant: null, templates: null, packs: null })
    expect(r.layout).toBe('classic')
    expect(r.style.accent).toBe(DEFAULT_DOCUMENT_STYLE.accent)
  })

  it('draft template falls back to classic', () => {
    const r = resolveDocumentTemplate({
      tenant: { document_template_key: 'premium', document_content: { hero_path: 'x.jpg' } }, templates, packs,
    })
    expect(r.layout).toBe('classic')
  })

  it('unknown key falls back to classic', () => {
    expect(resolveDocumentTemplate({ tenant: { document_template_key: 'zzz' }, templates, packs }).layout).toBe('classic')
  })

  it('modern without any cover image falls back to classic', () => {
    const r = resolveDocumentTemplate({ tenant: { document_template_key: 'modern', document_content: {} }, templates, packs })
    expect(r.layout).toBe('classic')
  })

  it('modern with own cover uses it and is not "default images"', () => {
    const r = resolveDocumentTemplate({
      tenant: { document_template_key: 'modern', document_content: { hero_path: 't/h.jpg', pack_id: 'p1' } }, templates, packs,
    })
    expect(r.layout).toBe('modern')
    expect(r.content.heroPath).toBe('t/h.jpg')
    expect(r.usingDefaultImages).toBe(false)
  })

  it('modern with a pack uses pack images, drops blank features, trims to limits', () => {
    const r = resolveDocumentTemplate({
      tenant: { document_template_key: 'modern', document_content: { pack_id: 'p1' } }, templates, packs,
    })
    expect(r.layout).toBe('modern')
    expect(r.usingDefaultImages).toBe(true)
    expect(r.content.heroPath).toBe('p1/hero.jpg')
    expect(r.content.features).toEqual(['รับประกัน', 'ติดตั้งเร็ว'])
    expect(r.content.tagline).toBe('งานเนี้ยบ')
    expect(r.content.gallery).toHaveLength(2)
  })

  it('unpublished pack is ignored', () => {
    const r = resolveDocumentTemplate({
      tenant: { document_template_key: 'modern', document_content: { pack_id: 'p1' } },
      templates, packs: [{ ...packs[0], status: 'draft' }],
    })
    expect(r.layout).toBe('classic')
  })

  it('caps gallery at 4 and features at 3', () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ path: `g${i}.jpg`, caption: 'c' }))
    const r = resolveDocumentTemplate({
      tenant: { document_template_key: 'modern', document_content: { hero_path: 'h.jpg', gallery: many, features: ['a', 'b', 'c', 'd'] } },
      templates, packs,
    })
    expect(r.content.gallery).toHaveLength(4)
    expect(r.content.features).toHaveLength(3)
  })

  it('tenant accent wins over template accent; bad accent is ignored', () => {
    const content = { hero_path: 'h.jpg' }
    const mine = resolveDocumentTemplate({ tenant: { document_template_key: 'modern', document_accent: '#ff0000', document_content: content }, templates, packs })
    expect(mine.accent).toBe('#ff0000')
    expect(mine.style.accentTint).toBe(tintHex('#ff0000', 0.9))
    const bad = resolveDocumentTemplate({ tenant: { document_template_key: 'modern', document_accent: 'red', document_content: content }, templates, packs })
    expect(bad.accent).toBe('#1e3a5f')
  })

  it('classic key applies tenant accent too', () => {
    const r = resolveDocumentTemplate({ tenant: { document_template_key: 'classic', document_accent: '#00aa00' }, templates, packs })
    expect(r.layout).toBe('classic')
    expect(r.accent).toBe('#00aa00')
  })
})

describe('tintHex', () => {
  it('moves toward white and returns plain hex', () => {
    expect(tintHex('#000000', 0.5)).toBe('#808080')
    expect(tintHex('#ffffff', 0.9)).toBe('#ffffff')
  })
  it('bad input gives a safe grey', () => {
    expect(tintHex('nope', 0.5)).toBe('#f4f4f6')
  })
})
