// Task 11 isolation tests: the optional attachment pages ("แบบแนบ") must not change anything for a tenant
// without the estimation module (or a quotation without an estimation link). Server-side render only (no DOM
// in this repo's vitest setup): effects never run, so the loader is tested directly with a recording fake
// Supabase client -- the hook itself only calls the loader from an effect.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderToString, renderToStaticMarkup } from 'react-dom/server'

// Recording fake: every from(table) is logged; the chain resolves to fakeData[table] (or []).
const calls = []
let fakeData = {}
function chain(table) {
  const q = { table, ops: [] }
  const b = {
    select: (...a) => { q.ops.push(['select', ...a]); return b },
    eq: (...a) => { q.ops.push(['eq', ...a]); return b },
    in: (...a) => { q.ops.push(['in', ...a]); return b },
    limit: (...a) => { q.ops.push(['limit', ...a]); return b },
    order: (...a) => { q.ops.push(['order', ...a]); return b },
    then: (res, rej) => {
      let rows = fakeData[table] || []
      for (const [op, col, val] of q.ops) {
        if (op === 'eq') rows = rows.filter(r => r[col] === val)
        if (op === 'in') rows = rows.filter(r => val.includes(r[col]))
      }
      return Promise.resolve({ data: rows, error: null }).then(res, rej)
    },
  }
  return b
}
const fromSpy = vi.fn(table => { calls.push(table); return chain(table) })

vi.mock('../lib/supabase.js', () => ({
  supabase: { from: (...a) => fromSpy(...a) },
  fmt: (n, decimals = 2) => (n == null || isNaN(n) ? '—' : Number(n).toLocaleString('th-TH', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })),
  fmtShort: n => String(n),
  fmtDate: d => (d ? new Date(d).toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) : '—'),
  countdown: () => null,
}))

// Tenant as the Quotations page sees it (useTenant is mocked: the real one fetches on mount).
let tenantModules = []
vi.mock('../hooks/useTenant.js', () => ({
  useTenant: () => ({ tenant: {}, loading: false, hasModuleAccess: k => tenantModules.includes(k) }),
}))

// The real paginator measures in the DOM; under SSR it always yields one page. When splitAt is set, this
// wrapper splits the rows into two pages so numbering across several quotation pages can be checked.
let splitAt = null
vi.mock('../hooks/usePaginatedDocument.jsx', async importOriginal => {
  const actual = await importOriginal()
  return {
    ...actual,
    usePaginatedDocument: args => {
      const real = actual.usePaginatedDocument(args)
      if (splitAt == null) return real
      const pages = [args.items.slice(0, splitAt), args.items.slice(splitAt)]
      return { pages, pageCount: pages.length, measurementNode: null }
    },
  }
})

const { QuotationPaper } = await import('./Quotations.jsx')
const { FIXTURE } = await import('./__fixtures__/quotationPaperFixture.js')
const { useTenant } = await import('../hooks/useTenant.js')
const { default: AttachmentPages } = await import('./estimation/AttachmentPages.jsx')
const {
  loadQuotationAttachments, buildAttachmentItems, assembleAttachments, buildAttachmentCtx, canLoadAttachments, useQuotationAttachments,
} = await import('./estimation/useQuotationAttachments.js')

beforeEach(() => { calls.length = 0; fromSpy.mockClear(); fakeData = {}; tenantModules = []; splitAt = null })

const quotation = { id: 'q1', quotation_number: 'QT26-00001', revision: 2, quotation_items: FIXTURE.items.map((r, i) => ({ ...r, sort_order: i })) }

// ---- catalogue / estimation fixture used by the loader and the paper tests ----
const svg = '<svg width="360" height="300" viewBox="0 0 10 10"><rect width="5" height="5"/></svg>'
const estimation = {
  estimation_quotation_links: [{ id: 'L1', project_id: 'P1', quotation_id: 'q1', attach_enabled: true, attach_mode: 'pages', attach_view: 'both' }],
  estimation_projects: [{ id: 'P1', default_series_id: 'S1', default_finish_id: 'F1', default_infill_id: 'G1', default_thickness_mm: 1.4, default_sash_thickness_mm: null, hardware_package_id: 'PK1' }],
  estimation_quotation_lines: [
    { project_id: 'P1', opening_id: 'O1', item_row_id: 'r1' },
    { project_id: 'P1', opening_id: 'O2', item_row_id: 'r3' },
    { project_id: 'P1', opening_id: 'O3', item_row_id: 'r5' },
  ],
  estimation_openings: [
    { id: 'O3', project_id: 'P1', opening_no: 'F-01', template_id: 'TF', width_m: 1, height_m: 0.5, quantity: 3, no_hardware_set: true, preview_svg_out: svg, preview_svg_in: svg },
    { id: 'O1', project_id: 'P1', opening_no: 'W-01', item_name: 'หน้าต่างห้องนอน', template_id: 'TS', width_m: 1.2, height_m: 1.5, quantity: 2, preview_svg_out: svg, preview_svg_in: svg },
    { id: 'O2', project_id: 'P1', opening_no: 'D-01', template_id: 'TD', width_m: 0.9, height_m: 2.1, quantity: 1, thickness_mm: 2, sash_thickness_mm: 1.6, alu_finish_id: 'F2', preview_svg_out: svg, preview_svg_in: null },
    { id: 'O9', project_id: 'P1', opening_no: 'X-09', template_id: 'TS', width_m: 1, height_m: 1, quantity: 1 }, // no line -> skipped
  ],
  bom_templates: [{ id: 'TS', name: 'แม่แบบเลื่อน', type_id: 'slide' }, { id: 'TD', name: 'แม่แบบประตู', type_id: 'door' }, { id: 'TF', name: 'แม่แบบติดตาย', type_id: 'fixed' }],
  door_window_types: [{ id: 'win', name: 'หน้าต่าง', parent_id: null }, { id: 'slide', name: 'บานเลื่อน', parent_id: 'win' }, { id: 'door', name: 'ประตู', parent_id: null }, { id: 'fixed', name: 'บานติดตาย', parent_id: 'win' }],
  alu_hardware_package_items: [{ package_id: 'PK1', type_id: 'win', hardware_set_id: 'H1' }, { package_id: 'PK1', type_id: 'door', hardware_set_id: 'H2' }],
  alu_series: [{ id: 'S1', name: 'ซีรีส์ 40' }],
  alu_finishes: [{ id: 'F1', name: 'ขาว', color_hex: '#ffffff' }, { id: 'F2', name: 'ดำ', color_hex: '#000000' }],
  infill_types: [{ id: 'G1', code: 'TP6', name: 'เทมเปอร์ 6 มม.' }],
  alu_part_set_items: [{ set_id: 'H1', part_id: 'A1', quantity: 2 }, { set_id: 'H2', part_id: 'A2', quantity: 1 }],
  alu_parts: [
    { id: 'H1', kind: 'hardware_set', provider_id: 'V1', code: 'P-0001', name: 'ชุดหน้าต่าง' },
    { id: 'H2', kind: 'hardware_set', provider_id: 'V1', code: 'P-0002', name: 'ชุดประตู' },
    { id: 'A1', kind: 'hardware', name: 'ล้อ', unit: 'ชุด' }, { id: 'A2', kind: 'hardware', name: 'กุญแจ', unit: 'ตัว' },
  ],
  alu_providers: [{ id: 'V1', name: 'ยี่ห้อ A' }],
}

describe('(i) without attachment pages the quotation is unchanged', () => {
  it('still equals the characterization captured before Task 11', async () => {
    await expect(renderToString(<QuotationPaper {...FIXTURE} />)).toMatchFileSnapshot('./__fixtures__/quotationPaper.before.html')
  })
  it('extraPageCount 0 / empty extraPages render the same bytes', () => {
    const base = renderToString(<QuotationPaper {...FIXTURE} />)
    expect(renderToString(<QuotationPaper {...FIXTURE} extraPages={[]} extraPageCount={0} />)).toBe(base)
    expect(renderToString(<QuotationPaper {...FIXTURE} extraPages={() => <div>x</div>} />)).toBe(base)
  })
})

describe('(ii) tenant without estimation: zero queries', () => {
  it('the loader returns null without a single supabase.from call', async () => {
    tenantModules = ['quotations', 'invoices']
    fakeData = estimation   // even with a link in the DB, nothing is asked
    const { hasModuleAccess } = useTenant()
    expect(canLoadAttachments(quotation, hasModuleAccess)).toBe(false)
    expect(await loadQuotationAttachments({ quotation, hasModuleAccess })).toBeNull()
    expect(fromSpy).toHaveBeenCalledTimes(0)
  })
  it('no quotation id or no hasModuleAccess function -> null, zero calls', async () => {
    tenantModules = ['estimation']
    const { hasModuleAccess } = useTenant()
    expect(await loadQuotationAttachments({ quotation: { quotation_number: 'x' }, hasModuleAccess })).toBeNull()
    expect(await loadQuotationAttachments({ quotation, hasModuleAccess: undefined })).toBeNull()
    expect(fromSpy).toHaveBeenCalledTimes(0)
  })
  it('the hook renders null and queries nothing during render', () => {
    tenantModules = []
    function Probe() { const { hasModuleAccess } = useTenant(); const a = useQuotationAttachments(quotation, hasModuleAccess); return <i>{a === null ? 'null' : 'data'}</i> }
    expect(renderToStaticMarkup(<Probe />)).toBe('<i>null</i>')
    expect(fromSpy).toHaveBeenCalledTimes(0)
  })
})

describe('(iii) estimation module but nothing to attach: only the link lookup', () => {
  const run = async () => { tenantModules = ['estimation']; const { hasModuleAccess } = useTenant(); return loadQuotationAttachments({ quotation, hasModuleAccess }) }
  it('no link', async () => {
    fakeData = { ...estimation, estimation_quotation_links: [] }
    expect(await run()).toBeNull()
    expect(calls).toEqual(['estimation_quotation_links'])
  })
  it('link disabled', async () => {
    fakeData = { ...estimation, estimation_quotation_links: [{ ...estimation.estimation_quotation_links[0], attach_enabled: false }] }
    expect(await run()).toBeNull()
    expect(calls).toEqual(['estimation_quotation_links'])
  })
  it("mode 'thumb' (not built yet) shows nothing", async () => {
    fakeData = { ...estimation, estimation_quotation_links: [{ ...estimation.estimation_quotation_links[0], attach_mode: 'thumb' }] }
    expect(await run()).toBeNull()
    expect(calls).toEqual(['estimation_quotation_links'])
  })
  it('a link of another quotation is not used', async () => {
    fakeData = { ...estimation, estimation_quotation_links: [{ ...estimation.estimation_quotation_links[0], quotation_id: 'other' }] }
    expect(await run()).toBeNull()
    expect(calls).toEqual(['estimation_quotation_links'])
  })
  it('a query error becomes null (never thrown into the page)', async () => {
    tenantModules = ['estimation']
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const broken = { from: () => ({ select: () => ({ eq: () => ({ limit: () => Promise.resolve({ data: null, error: new Error('relation does not exist') }) }) }) }) }
    const { hasModuleAccess } = useTenant()
    expect(await loadQuotationAttachments({ supabase: broken, quotation, hasModuleAccess })).toBeNull()
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })
})

describe('loader happy path (estimation + link, mode pages/both)', () => {
  it.each(['pages', 'both'])('mode %s builds resolved items in quotation order and a page plan', async mode => {
    tenantModules = ['estimation']
    fakeData = { ...estimation, estimation_quotation_links: [{ ...estimation.estimation_quotation_links[0], attach_mode: mode }] }
    const { hasModuleAccess } = useTenant()
    const res = await loadQuotationAttachments({ quotation, hasModuleAccess })
    expect(res.items.map(i => i.opening_no)).toEqual(['W-01', 'D-01', 'F-01'])
    expect(res.extraPageCount).toBe(res.plan.pages.length)
    expect(res.plan.pages.map(p => p.kind)).toEqual(['items', 'hardware'])
    expect(res.imageUrls).toEqual({})
    expect(res.ctx.partsBySet.H1[0].part.name).toBe('ล้อ')
    const x = res.buildExtra(3)
    expect(x.plan.pages[0].pageNo).toBe(4)
    expect(x.plan.totalPages).toBe(3 + res.extraPageCount)
    expect(calls).not.toContain('quotation_items')   // the quotation already carries its rows
  })
})

// Splits the rendered paper into quotation part / attachment part and reads every "หน้า n/N" header label.
// The hidden measurement pass (real paginator, unmeasured under SSR) also holds a header; it is not a page.
const visible = html => html.split('visibility:hidden')[0]
const labels = html => [...visible(html).matchAll(/หน้า (\d+)\/(\d+)/g)].map(m => [Number(m[1]), Number(m[2])])
function rootClosesAtEnd(html) {
  // the root element opened first must be the one closed last (everything is inside the exported element)
  let depth = 0
  const re = /<(\/?)([a-zA-Z][\w-]*)([^>]*?)(\/?)>/g
  let m
  const voids = new Set(['img', 'br', 'hr', 'input', 'meta', 'link', 'col'])   // HTML void elements (React closes SVG ones explicitly)
  while ((m = re.exec(html))) {
    if (m[1]) depth--
    else if (!m[4] && !voids.has(m[2].toLowerCase())) depth++
    if (depth === 0 && re.lastIndex < html.length) return false
  }
  return depth === 0
}

describe('(iv) with attachment pages: numbering runs on and pages sit inside the exported element', () => {
  for (const split of [null, 3]) {
    it(`array form, 2 nodes (${split == null ? '1' : '2'} quotation page(s))`, () => {
      splitAt = split
      const extraPages = [{ key: 'a', node: <section className="att-a">A</section> }, { key: 'b', node: <section className="att-b">B</section> }]
      const html = renderToStaticMarkup(<QuotationPaper {...FIXTURE} extraPages={extraPages} extraPageCount={2} />)
      const [quotationPart, extraPart] = html.split('class="quotation-extra-pages"')
      const quotationPages = labels(quotationPart).length
      expect(quotationPages).toBe(split == null ? 1 : 2)
      const total = quotationPages + 2
      expect(labels(quotationPart)).toEqual(Array.from({ length: quotationPages }, (_, i) => [i + 1, total]))
      expect(extraPart.indexOf('att-a')).toBeLessThan(extraPart.indexOf('att-b'))
      expect(html.startsWith(`<div id="${FIXTURE.elementId}"`)).toBe(true)
      expect(rootClosesAtEnd(html)).toBe(true)
    })

    it(`function form with the real attachment pages (${split == null ? '1' : '2'} quotation page(s))`, () => {
      splitAt = split
      const items = buildAttachmentItems({
        openings: estimation.estimation_openings, lines: estimation.estimation_quotation_lines, quotationItems: quotation.quotation_items,
        project: estimation.estimation_projects[0], templatesById: Object.fromEntries(estimation.bom_templates.map(t => [t.id, t])),
        typesById: Object.fromEntries(estimation.door_window_types.map(t => [t.id, t])), packageItems: estimation.alu_hardware_package_items,
      })
      const ctx = buildAttachmentCtx({
        series: estimation.alu_series, finishes: estimation.alu_finishes, infills: estimation.infill_types,
        setRows: estimation.alu_parts.filter(p => p.kind === 'hardware_set'), setItems: estimation.alu_part_set_items, parts: estimation.alu_parts, providers: estimation.alu_providers,
      })
      const att = assembleAttachments({ items, ctx, view: 'both' })
      let seenCount = null
      const html = renderToStaticMarkup(
        <QuotationPaper {...FIXTURE} extraPageCount={att.extraPageCount}
          extraPages={({ quotationPageCount, renderHeader }) => {
            seenCount = quotationPageCount
            const x = att.buildExtra(quotationPageCount)
            return <AttachmentPages pages={x.plan.pages} ctx={x.ctx} imageUrls={x.imageUrls} totalPages={x.plan.totalPages} renderHeader={renderHeader} documentNumber="QT26-00001-R2" />
          }} />,
      )
      const [quotationPart, extraPart] = html.split('class="quotation-extra-pages"')
      const quotationPages = labels(quotationPart).length
      expect(seenCount).toBe(quotationPages)
      const total = quotationPages + att.extraPageCount
      // every header on every page, quotation and attachment: 1/N ... N/N in order
      expect(labels(html)).toEqual(Array.from({ length: total }, (_, i) => [i + 1, total]))
      // attachment pages come after the last quotation page and carry the "แบบแนบ" subtitle; quotation pages do not
      expect(quotationPart).not.toContain('แบบแนบ')
      expect((extraPart.match(/>แบบแนบ</g) || []).length).toBe(att.extraPageCount)
      expect((extraPart.match(/class="attachment-page"/g) || []).length).toBe(att.extraPageCount)
      expect(extraPart).toContain(`QT26-00001-R2 · หน้า ${total} / ${total}`)
      expect(html.startsWith(`<div id="${FIXTURE.elementId}"`)).toBe(true)
      expect(rootClosesAtEnd(html)).toBe(true)
    })
  }
})

describe('(v) buildAttachmentItems (pure)', () => {
  const base = {
    openings: estimation.estimation_openings, lines: estimation.estimation_quotation_lines, quotationItems: quotation.quotation_items,
    project: estimation.estimation_projects[0], templatesById: Object.fromEntries(estimation.bom_templates.map(t => [t.id, t])),
    typesById: Object.fromEntries(estimation.door_window_types.map(t => [t.id, t])), packageItems: estimation.alu_hardware_package_items,
  }
  it('keeps only mapped openings, in the order of the quotation rows', () => {
    const items = buildAttachmentItems(base)
    expect(items.map(i => i.id)).toEqual(['O1', 'O2', 'O3'])
    // reorder the quotation rows: D-01 (r3) first
    const reordered = quotation.quotation_items.map(r => (r.id === 'r3' ? { ...r, sort_order: -1 } : r))
    expect(buildAttachmentItems({ ...base, quotationItems: reordered }).map(i => i.id)).toEqual(['O2', 'O1', 'O3'])
  })
  it('skips an opening whose quotation row was deleted', () => {
    const rows = quotation.quotation_items.filter(r => r.id !== 'r5')
    expect(buildAttachmentItems({ ...base, quotationItems: rows }).map(i => i.id)).toEqual(['O1', 'O2'])
  })
  it('resolves thickness / sash / series / finish / glass by inheritance from the project', () => {
    const [w, d] = buildAttachmentItems(base)
    expect(w).toMatchObject({ frame_thickness_mm: 1.4, sash_thickness_mm: null, series_id: 'S1', alu_finish_id: 'F1', infill_type_id: 'G1' })
    expect(d).toMatchObject({ frame_thickness_mm: 2, sash_thickness_mm: 1.6, alu_finish_id: 'F2' })
  })
  it('hardware set comes from the project package by type (ancestor match); no_hardware_set wins', () => {
    const [w, d, f] = buildAttachmentItems(base)
    expect(w.hardware_set_id).toBe('H1')   // slide -> parent win -> H1
    expect(d.hardware_set_id).toBe('H2')
    expect(f.hardware_set_id).toBeNull()
    expect(f.no_hardware_set).toBe(true)
  })
  it('type_name from the type, falling back to the template name; item_name kept', () => {
    const [w] = buildAttachmentItems(base)
    expect(w.type_name).toBe('บานเลื่อน')
    expect(w.item_name).toBe('หน้าต่างห้องนอน')
    const noType = buildAttachmentItems({ ...base, templatesById: { ...base.templatesById, TS: { id: 'TS', name: 'แม่แบบเลื่อน' } } })
    expect(noType[0].type_name).toBe('แม่แบบเลื่อน')
  })
  it('without a package the legacy project default set applies', () => {
    const items = buildAttachmentItems({ ...base, packageItems: null, project: { ...base.project, hardware_package_id: null, default_hardware_set_id: 'H9' } })
    expect(items[0].hardware_set_id).toBe('H9')
  })
})
