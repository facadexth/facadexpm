// SSR: the logo box shows a dash without a URL; the card offers upload / replace / remove only to editors.
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../../lib/supabase.js', () => ({ supabase: {} }))
const { default: ProviderLogo } = await import('../../components/ProviderLogo.jsx')
const { default: ProviderLogoCard } = await import('./ProviderLogoCard.jsx')
const html = el => renderToString(el).replace(/<!-- -->/g, '')

describe('ProviderLogo', () => {
  it('shows the logo, or a dash in the same box', () => {
    expect(html(<ProviderLogo url="https://s/l.png" name="ORM" />)).toContain('alt="โลโก้ ORM"')
    const none = html(<ProviderLogo url={null} name="ORM" />)
    expect(none).toContain('ไม่มีโลโก้')
    expect(none).not.toContain('<img')
  })
})

describe('ProviderLogoCard', () => {
  const p = { id: 'P', name: 'ORM', logo_path: 'T/logos/P-1.png' }
  it('an editor can replace or remove an existing logo', () => {
    const h = html(<ProviderLogoCard provider={p} url="https://s/l.png" tenantId="T" canEdit />)
    expect(h).toContain('เปลี่ยนโลโก้')
    expect(h).toContain('ลบโลโก้')
  })
  it('offers upload when there is no logo yet', () => {
    const h = html(<ProviderLogoCard provider={{ ...p, logo_path: null }} url={null} tenantId="T" canEdit />)
    expect(h).toContain('ยังไม่มีโลโก้')
    expect(h).toContain('อัปโหลดโลโก้')
  })
  it('a viewer sees the logo with no buttons', () => {
    const h = html(<ProviderLogoCard provider={p} url="https://s/l.png" tenantId="T" canEdit={false} />)
    expect(h).not.toContain('เปลี่ยนโลโก้')
    expect(h).not.toContain('ลบโลโก้')
  })
})
