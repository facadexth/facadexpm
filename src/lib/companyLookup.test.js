import { describe, it, expect } from 'vitest'
import {
  ALLOWED_DOMAINS, JSON_DELIMITER, budgetDay, shouldRefund, MAX_CONTINUATIONS, MAX_SEARCHES, allowedDomainOf, budgetOutcome, buildLookupRequest,
  candidatesFromContent, cleanCompanyName, collectEvidence, companyNameCore, isValidThaiId13 as serverValid,
  lookupOutcome, normalizeDigits as serverNorm, parseCandidatesJson, textContainsId, validateCandidates,
} from '../../supabase/functions/_shared/company-lookup.ts'
import { isValidThaiId13, normalizeDigits } from './dbdCompanyParse.js'
import { LOOKUP_ALLOWED_DOMAINS, safeSourceUrl } from './companyLookupUi.js'

const ID_A = '0107544000108'
const ID_B = '0107542000011'
const NAME = 'บริษัท ทดสอบ จำกัด'
const DBD = 'https://datawarehouse.dbd.go.th/a'

// synthetic Anthropic response fixture: prose, delimiter, JSON; citation quotes the sentence
const answer = (id, sources, extra = {}) =>
  'ทดสอบ จำกัด เลข ' + id + '\n' + JSON_DELIMITER + '\n' +
  JSON.stringify([{ name: NAME, address: '99 ถนนสุขุมวิท กรุงเทพ 10110', taxId: id, sources, ...extra }])
const fixture = ({ id = ID_A, sources, cites, text } = {}) => ([
  { type: 'text', text: 'ค้นหา...' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
    { type: 'web_search_result', url: DBD, title: 'DBD', encrypted_content: 'zzz' },
  ] },
  { type: 'text', text: text ?? answer(id, sources ?? [{ url: DBD, title: 'DBD' }]),
    citations: cites ?? [
      { type: 'web_search_result_location', url: DBD, title: 'DBD', cited_text: NAME + ' เลขทะเบียนนิติบุคคล ' + id },
    ] },
])

describe('shared checksum stays in sync with the browser copy', () => {
  const samples = [ID_A, ID_B, '0107536000633', '0107537000114', '0105564000013', '1234567890123', '', '๐๑๐๗๕๔๔๐๐๐๑๐๘', '0-1075-44000-10-8', '12']
  it('same answers', () => {
    for (const s of samples) {
      expect(serverValid(s)).toBe(isValidThaiId13(s))
      expect(serverNorm(s)).toBe(normalizeDigits(s))
    }
  })
  it('browser allowlist mirror equals the server constant', () => {
    expect(LOOKUP_ALLOWED_DOMAINS).toEqual(ALLOWED_DOMAINS)
  })
})

describe('allowlist', () => {
  it('is official-first and contains no wildcard or scheme', () => {
    expect(ALLOWED_DOMAINS[0]).toBe('dbd.go.th')
    for (const d of ALLOWED_DOMAINS) expect(d).toMatch(/^[a-z0-9.-]+$/)
  })
  it('matches https domain and subdomains, rejects look-alikes and http', () => {
    expect(allowedDomainOf('https://datawarehouse.dbd.go.th/juristic')).toBe('dbd.go.th')
    expect(allowedDomainOf('https://www.dataforthai.com/x')).toBe('dataforthai.com')
    expect(allowedDomainOf('http://dbd.go.th/x')).toBeNull()
    expect(allowedDomainOf('https://evil-dbd.go.th/')).toBeNull()
    expect(allowedDomainOf('https://dbd.go.th.evil.com/')).toBeNull()
    expect(allowedDomainOf('javascript:alert(1)')).toBeNull()
    expect(allowedDomainOf('not a url')).toBeNull()
    expect(allowedDomainOf(null)).toBeNull()
  })
  it('browser safeSourceUrl only passes https + allowlist', () => {
    expect(safeSourceUrl('https://www.dbd.go.th/x')).toBe('https://www.dbd.go.th/x')
    expect(safeSourceUrl('http://dbd.go.th/x')).toBeNull()
    expect(safeSourceUrl('javascript:alert(1)')).toBeNull()
    expect(safeSourceUrl('https://evil.com/dbd.go.th')).toBeNull()
    expect(safeSourceUrl(undefined)).toBeNull()
  })
})

describe('request + input + budget', () => {
  it('request uses the documented tool shape; one continuation max', () => {
    const r = buildLookupRequest('บริษัท ก จำกัด')
    expect(r.model).toBe('claude-sonnet-5-5')
    expect(r.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, allowed_domains: ALLOWED_DOMAINS })
    expect(r.tools[0].blocked_domains).toBeUndefined()
    expect(r.system).toContain(JSON_DELIMITER)
    expect(MAX_CONTINUATIONS).toBe(1)
  })
  it('cleans the name incl. control chars', () => {
    expect(cleanCompanyName('  บริษัท   ก  จำกัด ')).toBe('บริษัท ก จำกัด')
    expect(cleanCompanyName('บริษัท\u0000ก\u0007\nข')).toBe('บริษัท ก ข')
    expect(cleanCompanyName('ก')).toBeNull()
    expect(cleanCompanyName('ก'.repeat(121))).toBeNull()
    expect(cleanCompanyName(5)).toBeNull()
  })
  it('maps the DB reservation result to a Thai message for each limit', () => {
    expect(budgetOutcome('ok')).toMatchObject({ ok: true })
    const t = budgetOutcome('tenant_cap'), g = budgetOutcome('global_cap'), e = budgetOutcome(null)
    expect([t.ok, g.ok, e.ok]).toEqual([false, false, false])
    expect(t.code).toBe('tenant_cap')
    expect(g.code).toBe('global_cap')
    expect(e.code).toBe('error')
    expect(new Set([t.message, g.message, e.message]).size).toBe(3)
    expect(budgetOutcome('unknown_tenant').ok).toBe(false)
  })
  it('reads the jsonb {status, day} reservation result', () => {
    expect(budgetOutcome({ status: 'ok', day: '2026-10-08' }).ok).toBe(true)
    expect(budgetOutcome({ status: 'global_cap', day: '2026-10-08' }).code).toBe('global_cap')
    expect(budgetOutcome({}).code).toBe('error')
    expect(budgetDay({ status: 'ok', day: '2026-10-08' })).toBe('2026-10-08')
    expect(budgetDay({ day: 'x' })).toBeNull()
    expect(budgetDay(null)).toBeNull()
  })
  it('refunds only when Anthropic certainly did not bill', () => {
    expect(shouldRefund({ kind: 'http', status: 500 })).toBe(true)
    expect(shouldRefund({ kind: 'http', status: 429 })).toBe(true)
    expect(shouldRefund({ kind: 'http', status: 400 })).toBe(true)
    expect(shouldRefund({ kind: 'fetch', errorName: 'TypeError' })).toBe(true)
    expect(shouldRefund({ kind: 'fetch', errorName: 'TimeoutError' })).toBe(false)
    expect(shouldRefund({ kind: 'fetch', errorName: 'AbortError' })).toBe(false)
    expect(shouldRefund({ kind: 'unparseable_200' })).toBe(false)
    expect(shouldRefund({ kind: 'http', status: 200 })).toBe(false)
    // an earlier successful response in the same lookup means it was spent
    expect(shouldRefund({ kind: 'http', status: 500 }, true)).toBe(false)
    expect(shouldRefund({ kind: 'fetch', errorName: 'TypeError' }, true)).toBe(false)
  })
  it('incomplete is not "not found"', () => {
    expect(lookupOutcome('pause_turn', 0)).toBe('incomplete')
    expect(lookupOutcome('max_tokens', 0)).toBe('incomplete')
    expect(lookupOutcome('end_turn', 0)).toBe('not_found')
    expect(lookupOutcome('pause_turn', 1)).toBe('ok')
  })
})

describe('parseCandidatesJson', () => {
  it('handles fences, prose, object wrapper, garbage', () => {
    expect(parseCandidatesJson('```json\n[{"a":1}]\n```')).toEqual([{ a: 1 }])
    expect(parseCandidatesJson('here: [{"a":1}] done')).toEqual([{ a: 1 }])
    expect(parseCandidatesJson('{"candidates":[{"a":1}]}')).toEqual([{ a: 1 }])
    expect(parseCandidatesJson('[]')).toEqual([])
    expect(parseCandidatesJson('nonsense')).toEqual([])
    expect(parseCandidatesJson(undefined)).toEqual([])
  })
  it('survives bracketed narration before the JSON', () => {
    expect(parseCandidatesJson('ค้นหา [DBD] แล้ว [1] พบ\n[{"a":1}]')).toEqual([{ a: 1 }])
    expect(parseCandidatesJson('ดู [1] และ [2]')).toEqual([])
  })
})

describe('collectEvidence: only the final answer after the delimiter is parsed', () => {
  it('ignores narration before tool blocks and prose before the delimiter', () => {
    const ev = collectEvidence([
      { type: 'text', text: 'ค้นหา [DBD] ก่อน [1]' },
      { type: 'server_tool_use', id: 's', name: 'web_search', input: {} },
      { type: 'web_search_tool_result', tool_use_id: 's', content: [] },
      { type: 'text', text: 'บรรทัดอ้างอิง [2]\n' + JSON_DELIMITER + '\n[' },
      { type: 'text', text: '{"name":"x"}]' },
    ])
    expect(ev.text.trim()).toBe('[{"name":"x"}]')
  })
  it('collects citations from all text blocks', () => {
    const ev = collectEvidence(fixture())
    expect(ev.citations).toHaveLength(1)
    expect(ev.searches).toBe(1)
    expect(ev.resultUrls).toHaveLength(1)
  })
})

describe('textContainsId / companyNameCore', () => {
  it('finds plain, grouped and Thai-digit IDs; not inside longer runs', () => {
    expect(textContainsId('เลข 0107544000108 ครับ', ID_A)).toBe(true)
    expect(textContainsId('เลข 0-1075-44000-10-8', ID_A)).toBe(true)
    expect(textContainsId('เลข ๐๑๐๗๕๔๔๐๐๐๑๐๘', ID_A)).toBe(true)
    expect(textContainsId('99' + ID_A, ID_A)).toBe(false)
    expect(textContainsId(ID_A + '9', ID_A)).toBe(false)
    expect(textContainsId('nothing', ID_A)).toBe(false)
  })
  it('strips legal-form words, spaces, case, Thai digits', () => {
    expect(companyNameCore('บริษัท  ABC  ๑๒ จำกัด (มหาชน)')).toBe('abc12')
    expect(companyNameCore('ห้างหุ้นส่วนจำกัด สยาม')).toBe('สยาม')
    expect(companyNameCore('บจก. เอ')).toBe('เอ')
    expect(companyNameCore('บริษัท จำกัด')).toBe('')
    expect(companyNameCore('ABC Co., Ltd.')).toBe('abc')
    expect(companyNameCore('Siam Glass Public Company Limited (PCL)')).toBe('siamglass')
    expect(companyNameCore('XYZ Corporation Inc.')).toBe('xyz')
    expect(companyNameCore('Cosmo Limited')).toBe('cosmo') // "co" inside a word is kept
    expect(companyNameCore('บริษัท ABC จำกัด')).toBe('abc')
  })
})

describe('validateCandidates / candidatesFromContent', () => {
  it('keeps a good single-source candidate and builds sources from citations', () => {
    const { candidates, rawCount, drops } = candidatesFromContent(fixture())
    expect(rawCount).toBe(1)
    expect(drops).toEqual([])
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ taxId: ID_A, taxIdValid: true, verification: 'single_source' })
    expect(candidates[0].sources).toEqual([{ url: DBD, title: 'DBD' }])
  })
  it('drops an invented URL: sources come only from citations', () => {
    const { candidates } = candidatesFromContent(fixture({ sources: [{ url: 'https://dbd.go.th/invented', title: 'fake' }] }))
    expect(candidates).toHaveLength(1)
    expect(candidates[0].sources.map(s => s.url)).toEqual([DBD])
  })
  it('multi_source needs 2+ distinct allowed domains citing the ID with the name', () => {
    const c = (url, t = NAME + ' ' + ID_A) => ({ url, title: 't', cited_text: t })
    const cites = [c(DBD), c('https://www.dbd.go.th/b')]
    expect(candidatesFromContent(fixture({ cites })).candidates[0].verification).toBe('single_source')
    cites.push(c('https://www.dataforthai.com/c'))
    const r = candidatesFromContent(fixture({ cites })).candidates[0]
    expect(r.verification).toBe('multi_source')
    expect(r.sources).toHaveLength(3)
  })
  it('drops an ID that fails the checksum', () => {
    const r = candidatesFromContent(fixture({ id: '0107544000109' }))
    expect(r.candidates).toEqual([])
    expect(r.drops).toEqual(['checksum'])
  })
  it('drops an ID whose digits are not in any cited_text', () => {
    const cites = [{ url: DBD, title: 'a', cited_text: NAME + ' ไม่มีเลข' }]
    expect(candidatesFromContent(fixture({ cites })).drops).toEqual(['id_not_cited'])
    expect(candidatesFromContent(fixture({ cites: [] })).drops).toEqual(['no_allowed_source'])
  })
  it('drops an ID found only in ANOTHER company\'s citation (name mismatch)', () => {
    const cites = [{ url: DBD, title: 'DBD', cited_text: 'บริษัท อื่น จำกัด เลข ' + ID_A }]
    const r = candidatesFromContent(fixture({ cites }))
    expect(r.candidates).toEqual([])
    expect(r.drops).toEqual(['name_not_cited'])
  })
  it('name may match in the citation title instead of cited_text', () => {
    const cites = [{ url: DBD, title: NAME + ' - DBD', cited_text: 'เลขทะเบียน ' + ID_A }]
    expect(candidatesFromContent(fixture({ cites })).candidates).toHaveLength(1)
  })
  it('digits only in a non-allowed or http citation do not count', () => {
    const bad = [{ url: 'https://evil.example.com/a', title: NAME, cited_text: NAME + ID_A }]
    expect(candidatesFromContent(fixture({ cites: bad })).candidates).toEqual([])
    const http = [{ url: 'http://dbd.go.th/a', title: NAME, cited_text: NAME + ' ' + ID_A }]
    expect(candidatesFromContent(fixture({ cites: http })).candidates).toEqual([])
  })
  it('lists ambiguous companies (max 3), each needing its own named citation, deduped by ID', () => {
    const mk = (id, n) => ({ name: n, address: null, taxId: id, sources: [] })
    const cite = (id, n) => ({ url: DBD, title: 't', cited_text: `${n} ${id}` })
    const ev = collectEvidence([{ type: 'text', text: '', citations: [
      cite(ID_A, 'บริษัท ก จำกัด'), cite(ID_B, 'บริษัท ข จำกัด'), cite('0107536000633', 'บริษัท ค จำกัด'), cite('0107537000114', 'บริษัท ง จำกัด'),
    ] }])
    const v = validateCandidates([mk(ID_A, 'บริษัท ก จำกัด'), mk(ID_A, 'บริษัท ก จำกัด'), mk(ID_B, 'บริษัท ข จำกัด'),
      mk('0107536000633', 'บริษัท ค จำกัด'), mk('0107537000114', 'บริษัท ง จำกัด')], ev)
    expect(v.candidates.map(c => c.taxId)).toEqual([ID_A, ID_B, '0107536000633'])
    expect(v.drops).toEqual(['duplicate'])
  })
  it('tolerates junk input and search errors', () => {
    expect(validateCandidates([null, 5, 'x', {}, { name: 'ก' }], collectEvidence([])).candidates).toEqual([])
    expect(validateCandidates('nope', collectEvidence(null)).candidates).toEqual([])
    const ev = collectEvidence([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }])
    expect(ev.searchErrors).toEqual(['unavailable'])
    expect(candidatesFromContent([{ type: 'text', text: JSON_DELIMITER + '[]' }]).candidates).toEqual([])
  })
})
