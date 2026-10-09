// Characterization of the printed quotation (QuotationPaper) BEFORE the optional attachment pages were added
// (Task 11, Phase 3). The HTML fixture below was captured from the unchanged component and committed first;
// any later change that alters the output for a quotation without attachment pages fails this test.
// Server-side render only: no effects, no Supabase (the mock below never answers a query).
import { describe, it, expect, vi } from 'vitest'
import { renderToString } from 'react-dom/server'

vi.mock('../lib/supabase.js', () => ({
  supabase: {},
  fmt: (n, decimals = 2) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })),
  fmtShort: n => String(n),
  fmtDate: d => (d ? new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'),
  countdown: () => null,
}))
const { QuotationPaper } = await import('./Quotations.jsx')
const { FIXTURE } = await import('./__fixtures__/quotationPaperFixture.js')

describe('QuotationPaper characterization (before attachment pages)', () => {
  it('renders exactly the captured HTML for a representative quotation', async () => {
    const html = renderToString(<QuotationPaper {...FIXTURE} />)
    await expect(html).toMatchFileSnapshot('./__fixtures__/quotationPaper.before.html')
  })
})
