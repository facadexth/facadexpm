// I-4: while the add-on maps are loading, the send-to-quotation action is disabled with a Thai hint.
import { describe, it, expect, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {}, fmt: n => String(n) }))
vi.mock('../../hooks/useTenant.js', () => ({ useTenant: () => ({ tenant: {}, hasModuleAccess: () => true }) }))
vi.mock('../../hooks/useUserRole.js', () => ({ useUserRole: () => ({ isAtLeast: () => true, role: 'OWNER' }) }))
const { default: SendToQuotationButton } = await import('./SendToQuotationButton.jsx')

const props = { project: { id: 'p1' }, items: [], result: { rows: [], totals: {} }, index: { types: {} }, templatesById: {}, infillTypesById: {}, packageItems: null, canEdit: true, ps: {} }

describe('SendToQuotationButton add-on gate', () => {
  it('add-ons loading ⇒ disabled with the hint', () => {
    const html = renderToStaticMarkup(<SendToQuotationButton {...props} addonsLoading />)
    expect(html).toMatch(/<button[^>]*disabled=""[^>]*>ส่งไปใบเสนอราคา/)
    expect(html).toContain('กำลังโหลดข้อมูลช่องแสง')
  })
  it('loaded ⇒ enabled, no hint', () => {
    const html = renderToStaticMarkup(<SendToQuotationButton {...props} addonsLoading={false} />)
    expect(html).not.toContain('disabled')
    expect(html).not.toContain('กำลังโหลดข้อมูลช่องแสง')
  })
})
