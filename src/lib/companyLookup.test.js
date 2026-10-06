import { describe, it, expect } from 'vitest'
import {
  ALLOWED_DOMAINS, DAILY_LOOKUP_CAP, MAX_SEARCHES, allowedDomainOf, buildLookupRequest, candidatesFromContent,
  capDecision, cleanCompanyName, collectEvidence, isValidThaiId13 as serverValid, normalizeDigits as serverNorm,
  parseCandidatesJson, textContainsId, validateCandidates,
} from '../../supabase/functions/_shared/company-lookup.ts'
import { isValidThaiId13, normalizeDigits } from './dbdCompanyParse.js'

const ID_A = '0107544000108'
const ID_B = '0107542000011'

// synthetic Anthropic response fixture
const fixture = ({ id = ID_A, jsonSources, cites } = {}) => ([
  { type: 'text', text: 'ค้นหา...' },
  { type: 'server_tool_use', id: 'srvtoolu_1', name: 'web_search', input: { query: 'x' } },
  { type: 'web_search_tool_result', tool_use_id: 'srvtoolu_1', content: [
    { type: 'web_search_result', url: 'https://datawarehouse.dbd.go.th/a', title: 'DBD', encrypted_content: 'zzz' },
  ] },
  { type: 'text', text: '[{"name":"บริษัท ทดสอบ จำกัด","address":"99 ถนนสุขุมวิท กรุงเทพ 10110","taxId":"' + id + '","sources":' +
    JSON.stringify(jsonSources ?? [{ url: 'https://datawarehouse.dbd.go.th/a', title: 'DBD' }]) + '}]',
  citations: cites ?? [
    { type: 'web_search_result_location', url: 'https://datawarehouse.dbd.go.th/a', title: 'DBD', cited_text: 'เลขทะเบียนนิติบุคคล ' + id },
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
})

describe('allowlist', () => {
  it('is official-first and contains no wildcard or scheme', () => {
    expect(ALLOWED_DOMAINS[0]).toBe('dbd.go.th')
    for (const d of ALLOWED_DOMAINS) expect(d).toMatch(/^[a-z0-9.-]+$/)
  })
  it('matches domain and subdomains, rejects look-alikes', () => {
    expect(allowedDomainOf('https://datawarehouse.dbd.go.th/juristic')).toBe('dbd.go.th')
    expect(allowedDomainOf('https://www.dataforthai.com/x')).toBe('dataforthai.com')
    expect(allowedDomainOf('https://evil-dbd.go.th/')).toBeNull()
    expect(allowedDomainOf('https://dbd.go.th.evil.com/')).toBeNull()
    expect(allowedDomainOf('javascript:alert(1)')).toBeNull()
    expect(allowedDomainOf('not a url')).toBeNull()
    expect(allowedDomainOf(null)).toBeNull()
  })
})

describe('request + input + cap', () => {
  it('request uses the documented tool shape', () => {
    const r = buildLookupRequest('บริษัท ก จำกัด')
    expect(r.model).toBe('claude-sonnet-5-5')
    expect(r.tools[0]).toMatchObject({ type: 'web_search_20250305', name: 'web_search', max_uses: MAX_SEARCHES, allowed_domains: ALLOWED_DOMAINS })
    expect(r.tools[0].blocked_domains).toBeUndefined()
  })
  it('cleans the name', () => {
    expect(cleanCompanyName('  บริษัท   ก  จำกัด ')).toBe('บริษัท ก จำกัด')
    expect(cleanCompanyName('ก')).toBeNull()
    expect(cleanCompanyName('ก'.repeat(121))).toBeNull()
    expect(cleanCompanyName(5)).toBeNull()
  })
  it('cap logic', () => {
    expect(capDecision(0).allowed).toBe(true)
    expect(capDecision(DAILY_LOOKUP_CAP - 1)).toEqual({ allowed: true, remaining: 1 })
    expect(capDecision(DAILY_LOOKUP_CAP)).toEqual({ allowed: false, remaining: 0 })
    expect(capDecision(999).allowed).toBe(false)
    expect(capDecision(NaN).allowed).toBe(true)
    expect(capDecision(5, 5).allowed).toBe(false)
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
})

describe('textContainsId', () => {
  it('finds plain, grouped and Thai-digit IDs; not inside longer runs', () => {
    expect(textContainsId('เลข 0107544000108 ครับ', ID_A)).toBe(true)
    expect(textContainsId('เลข 0-1075-44000-10-8', ID_A)).toBe(true)
    expect(textContainsId('เลข ๐๑๐๗๕๔๔๐๐๐๑๐๘', ID_A)).toBe(true)
    expect(textContainsId('99' + ID_A, ID_A)).toBe(false)
    expect(textContainsId(ID_A + '9', ID_A)).toBe(false)
    expect(textContainsId('nothing', ID_A)).toBe(false)
  })
})

describe('validateCandidates / candidatesFromContent', () => {
  it('keeps a good single-source candidate', () => {
    const { candidates } = candidatesFromContent(fixture())
    expect(candidates).toHaveLength(1)
    expect(candidates[0]).toMatchObject({ taxId: ID_A, taxIdValid: true, verification: 'single_source' })
    expect(candidates[0].sources[0].url).toContain('dbd.go.th')
  })
  it('multi_source needs 2+ distinct allowed domains with the ID in cited_text', () => {
    const cites = [
      { url: 'https://datawarehouse.dbd.go.th/a', title: 'a', cited_text: ID_A },
      { url: 'https://www.dbd.go.th/b', title: 'b', cited_text: ID_A },
    ]
    expect(candidatesFromContent(fixture({ cites })).candidates[0].verification).toBe('single_source') // same domain twice
    cites.push({ url: 'https://www.dataforthai.com/c', title: 'c', cited_text: 'ทะเบียน ' + ID_A })
    expect(candidatesFromContent(fixture({ cites })).candidates[0].verification).toBe('multi_source')
  })
  it('drops an ID that fails the checksum', () => {
    expect(candidatesFromContent(fixture({ id: '0107544000109' })).candidates).toEqual([])
  })
  it('drops an ID whose digits are not in any cited_text (guard)', () => {
    const cites = [{ url: 'https://dbd.go.th/a', title: 'a', cited_text: 'บริษัท ทดสอบ จำกัด ไม่มีเลข' }]
    expect(candidatesFromContent(fixture({ cites })).candidates).toEqual([])
    expect(candidatesFromContent(fixture({ cites: [] })).candidates).toEqual([])
  })
  it('digits only in a non-allowed domain citation do not count', () => {
    const cites = [{ url: 'https://evil.example.com/a', title: 'e', cited_text: ID_A }]
    expect(candidatesFromContent(fixture({ cites })).candidates).toEqual([])
  })
  it('drops candidates without a source on an allowed domain', () => {
    expect(candidatesFromContent(fixture({ jsonSources: [{ url: 'https://evil.example.com/x', title: 'x' }] })).candidates).toEqual([])
    expect(candidatesFromContent(fixture({ jsonSources: [] })).candidates).toEqual([])
  })
  it('lists ambiguous companies (max 3) and dedupes by ID', () => {
    const mk = (id, n) => ({ name: n, address: null, taxId: id, sources: [{ url: 'https://dbd.go.th/x', title: 't' }] })
    const ev = collectEvidence([{ type: 'text', text: '', citations: [
      { url: 'https://dbd.go.th/x', title: 't', cited_text: `${ID_A} ${ID_B} 0107536000633 0107537000114` },
    ] }])
    const out = validateCandidates([mk(ID_A, 'ก'), mk(ID_A, 'ก ซ้ำ'), mk(ID_B, 'ข'), mk('0107536000633', 'ค'), mk('0107537000114', 'ง')], ev)
    expect(out.map(c => c.taxId)).toEqual([ID_A, ID_B, '0107536000633'])
  })
  it('tolerates junk input and search errors', () => {
    expect(validateCandidates([null, 5, 'x', {}, { name: 'ก' }], collectEvidence([]))).toEqual([])
    expect(validateCandidates('nope', collectEvidence(null))).toEqual([])
    const ev = collectEvidence([{ type: 'web_search_tool_result', content: { type: 'web_search_tool_result_error', error_code: 'unavailable' } }])
    expect(ev.searchErrors).toEqual(['unavailable'])
    expect(candidatesFromContent([{ type: 'text', text: '[]' }]).candidates).toEqual([])
  })
  it('collects evidence counts', () => {
    const ev = collectEvidence(fixture())
    expect(ev.searches).toBe(1)
    expect(ev.resultUrls).toHaveLength(1)
    expect(ev.citations).toHaveLength(1)
  })
})
