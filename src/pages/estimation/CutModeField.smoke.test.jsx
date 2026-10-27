// SSR smoke test: the job-type switch shows the stock length from the settings and is locked without edit rights.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
const { default: CutModeField } = await import('./CutModeField.jsx')

const render = props => renderToString(<CutModeField project={{ id: 'P' }} settings={{ stock_length_m: 6 }} canEdit onProjectSaved={() => {}} {...props} />).replaceAll('<!-- -->', '')

describe('CutModeField', () => {
  it('labels the normal job with the stock length from the settings; no cut_mode = normal job', () => {
    const html = render({})
    expect(html).toContain('งานทั่วไป · เส้น 6.00 ม. หาซื้อได้เลย')
    expect(html).toContain('งานโครงการ · สั่งความยาวพิเศษ')
    expect(html).toMatch(/aria-pressed="true"[^>]*>งานทั่วไป/)
    expect(html).not.toContain('disabled')
  })
  it('marks a project job and disables both buttons without edit rights', () => {
    const html = render({ project: { id: 'P', cut_mode: 'custom' }, canEdit: false })
    expect(html).toMatch(/aria-pressed="true"[^>]*>งานโครงการ/)
    expect((html.match(/disabled=""/g) || []).length).toBe(2)
  })
})
