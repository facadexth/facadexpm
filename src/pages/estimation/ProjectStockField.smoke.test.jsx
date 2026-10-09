// SSR smoke test: the project stock field is seeded from the project it is given, and a keyed remount is a fresh seed.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
const { default: ProjectStockField } = await import('./ProjectStockField.jsx')

describe('ProjectStockField', () => {
  it('shows each project\'s own value, blank when it has none', () => {
    const a = renderToString(<ProjectStockField key="A" project={{ id: 'A', stock_length_m: 6 }} defaultM={6.4} canEdit onSave={() => {}} />)
    const b = renderToString(<ProjectStockField key="B" project={{ id: 'B', stock_length_m: null }} defaultM={6.4} canEdit onSave={() => {}} />)
    expect(a).toContain('value="6"')
    expect(b).not.toContain('value="6"')
    expect(b).toContain('placeholder="6.4"')
  })
})
