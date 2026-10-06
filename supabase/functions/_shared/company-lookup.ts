// ============================================================
// Pure logic for the AI company lookup (edge function lookup-company).
// No I/O, so vitest imports it directly and the edge function reuses it.
//
// Trust model: the model only proposes candidates. The server keeps a
// candidate only when (a) it has a source URL on ALLOWED_DOMAINS,
// (b) its 13-digit ID passes the Thai checksum, and (c) the ID's digits
// really appear in the cited_text of a citation from an allowed domain.
// (Search result bodies are encrypted by Anthropic, so cited_text, <=150
// chars, is the only fetched text the server can see.)
// ============================================================

// ---- EDITABLE: the only sites the search tool may use -----------------
// Bare domains (no scheme, no wildcard). Subdomains are included
// automatically by the API, and by hostAllowed() below.
// Government / official first, then one established commercial register.
export const ALLOWED_DOMAINS: string[] = [
  'dbd.go.th',            // กรมพัฒนาธุรกิจการค้า (includes datawarehouse.dbd.go.th)
  'rd.go.th',             // กรมสรรพากร
  'set.or.th',            // ตลาดหลักทรัพย์แห่งประเทศไทย
  'sec.or.th',            // ก.ล.ต.
  'dataforthai.com',      // ทะเบียนนิติบุคคล (commercial aggregator)
]

export const COMPANY_LOOKUP_MODEL = 'claude-sonnet-5-5'
export const MAX_SEARCHES = 4
export const MAX_CONTINUATIONS = 2
// ---- EDITABLE: successful lookups per tenant per Bangkok day ----------
export const DAILY_LOOKUP_CAP = 30
export const MAX_CANDIDATES = 3

export const LOOKUP_SYSTEM_PROMPT = `You look up Thai registered companies (juristic persons) using web search restricted to official and registry sites.
Given a company name, find the company or companies that name refers to.
Return JSON ONLY, no prose, no code fences, in exactly this shape:
[{"name": "<registered name in Thai>", "address": "<registered head-office address or null>", "taxId": "<13-digit juristic registration number>", "sources": [{"url": "<page url>", "title": "<page title>"}]}]
Rules:
- Never guess. Only include a value that you read in a search result; use null for an address you did not see.
- taxId must be the 13 digits exactly as shown in a source. If you did not see it, leave the candidate out.
- If the name is ambiguous, list every distinct company (maximum 3), each with its own sources.
- If you cannot find the company, return [].
- Every candidate needs at least one source url that you actually used.`

export function lookupUserPrompt(name: string): string {
  return `Company name: ${name}`
}

export function buildLookupRequest(name: string) {
  return {
    model: COMPANY_LOOKUP_MODEL,
    max_tokens: 2048,
    system: LOOKUP_SYSTEM_PROMPT,
    tools: [{
      type: 'web_search_20250305',
      name: 'web_search',
      max_uses: MAX_SEARCHES,
      allowed_domains: ALLOWED_DOMAINS,
      user_location: { type: 'approximate', country: 'TH', timezone: 'Asia/Bangkok' },
    }],
    messages: [{ role: 'user', content: lookupUserPrompt(name) }],
  }
}

// ---- input ------------------------------------------------------------
export function cleanCompanyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\s+/g, ' ').trim()
  return t.length >= 2 && t.length <= 120 ? t : null
}

// ---- cap --------------------------------------------------------------
export function capDecision(countToday: number, cap: number = DAILY_LOOKUP_CAP) {
  const used = Number.isFinite(countToday) && countToday > 0 ? Math.floor(countToday) : 0
  return { allowed: used < cap, remaining: Math.max(0, cap - used) }
}

// ---- digits / checksum (keep in sync with src/lib/dbdCompanyParse.js; a test enforces it)
export function normalizeDigits(s: unknown): string {
  return String(s ?? '').replace(/[๐-๙]/g, (ch) => String('๐๑๒๓๔๕๖๗๘๙'.indexOf(ch)))
}

export function isValidThaiId13(raw: unknown): boolean {
  const s = normalizeDigits(raw).replace(/[\s-]/g, '')
  if (!/^\d{13}$/.test(s)) return false
  let sum = 0
  for (let i = 0; i < 12; i++) sum += Number(s[i]) * (13 - i)
  return (11 - (sum % 11)) % 10 === Number(s[12])
}

// ---- domains ----------------------------------------------------------
// Returns the matching allowlist entry for a URL, or null. Subdomains match;
// look-alikes (evil-dbd.go.th, dbd.go.th.evil.com) do not.
export function allowedDomainOf(url: unknown, allowed: string[] = ALLOWED_DOMAINS): string | null {
  if (typeof url !== 'string') return null
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null
    host = u.hostname.toLowerCase()
  } catch {
    return null
  }
  for (const d of allowed) {
    if (host === d || host.endsWith('.' + d)) return d
  }
  return null
}

// ---- response evidence ------------------------------------------------
export type Citation = { url: string; title: string; citedText: string }
export type Evidence = {
  text: string
  citations: Citation[]
  resultUrls: string[]
  searchErrors: string[]
  searches: number
}

// deno-lint-ignore no-explicit-any
export function collectEvidence(content: any[]): Evidence {
  const ev: Evidence = { text: '', citations: [], resultUrls: [], searchErrors: [], searches: 0 }
  if (!Array.isArray(content)) return ev
  for (const b of content) {
    if (!b || typeof b !== 'object') continue
    if (b.type === 'server_tool_use') ev.searches++
    else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        for (const r of b.content) if (r && typeof r.url === 'string') ev.resultUrls.push(r.url)
      } else if (b.content?.type === 'web_search_tool_result_error') {
        ev.searchErrors.push(String(b.content.error_code ?? 'unknown'))
      }
    } else if (b.type === 'text') {
      if (typeof b.text === 'string') ev.text += b.text
      if (Array.isArray(b.citations)) {
        for (const c of b.citations) {
          if (c && typeof c.url === 'string' && typeof c.cited_text === 'string') {
            ev.citations.push({ url: c.url, title: String(c.title ?? ''), citedText: c.cited_text })
          }
        }
      }
    }
  }
  return ev
}

// True when the 13 digits of `id` occur in `text` (after Thai-digit
// normalisation), as one run or in Thai grouping 1-4-5-2-1, and are not
// part of a longer digit run.
export function textContainsId(text: unknown, id: string): boolean {
  const t = normalizeDigits(text)
  const d = id.split('')
  const grouped = `${d[0]}[ -]${d.slice(1, 5).join('')}[ -]${d.slice(5, 10).join('')}[ -]${d.slice(10, 12).join('')}[ -]${d[12]}`
  const re = new RegExp(`(?<!\\d-?)(?:${id}|${grouped})(?!-?\\d)`)
  return re.test(t)
}

// ---- tolerant JSON parse of the model's answer ------------------------
export function parseCandidatesJson(text: unknown): unknown[] {
  if (typeof text !== 'string') return []
  const t = text.replace(/```(?:json)?/gi, '')
  const tryParse = (s: string): unknown => { try { return JSON.parse(s) } catch { return undefined } }
  const unwrap = (v: unknown): unknown[] | null => {
    if (Array.isArray(v)) return v
    if (v && typeof v === 'object' && Array.isArray((v as { candidates?: unknown }).candidates)) {
      return (v as { candidates: unknown[] }).candidates
    }
    return null
  }
  const direct = unwrap(tryParse(t.trim()))
  if (direct) return direct
  const a = t.indexOf('['), z = t.lastIndexOf(']')
  if (a !== -1 && z > a) {
    const arr = unwrap(tryParse(t.slice(a, z + 1)))
    if (arr) return arr
  }
  const o = t.indexOf('{'), oz = t.lastIndexOf('}')
  if (o !== -1 && oz > o) {
    const arr = unwrap(tryParse(t.slice(o, oz + 1)))
    if (arr) return arr
  }
  return []
}

// ---- validation -------------------------------------------------------
export type Candidate = {
  name: string
  address: string | null
  taxId: string
  taxIdValid: true
  verification: 'multi_source' | 'single_source'
  sources: { url: string; title: string }[]
}

export function validateCandidates(raw: unknown[], ev: Evidence, allowed: string[] = ALLOWED_DOMAINS): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const allowedCitations = ev.citations.filter((c) => allowedDomainOf(c.url, allowed))
  for (const item of Array.isArray(raw) ? raw : []) {
    if (out.length >= MAX_CANDIDATES) break
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    if (!name) continue
    const taxId = normalizeDigits(r.taxId).replace(/[\s-]/g, '')
    if (!isValidThaiId13(taxId) || seen.has(taxId)) continue

    const sources: { url: string; title: string }[] = []
    for (const s of Array.isArray(r.sources) ? r.sources : []) {
      const url = (s as { url?: unknown })?.url
      if (typeof url === 'string' && allowedDomainOf(url, allowed) && !sources.some((x) => x.url === url)) {
        sources.push({ url, title: String((s as { title?: unknown }).title ?? '').slice(0, 200) })
      }
    }
    if (sources.length === 0) continue

    // the digits must really appear in a visible, allowed-domain citation
    const domains = new Set<string>()
    for (const c of allowedCitations) {
      if (textContainsId(c.citedText, taxId)) domains.add(allowedDomainOf(c.url, allowed)!)
    }
    if (domains.size === 0) continue

    seen.add(taxId)
    const address = typeof r.address === 'string' && r.address.trim()
      ? r.address.replace(/\s+/g, ' ').trim().slice(0, 400)
      : null
    out.push({
      name, address, taxId, taxIdValid: true,
      verification: domains.size >= 2 ? 'multi_source' : 'single_source',
      sources,
    })
  }
  return out
}

// One call: model content blocks -> final candidates.
// deno-lint-ignore no-explicit-any
export function candidatesFromContent(content: any[]): { candidates: Candidate[]; evidence: Evidence } {
  const evidence = collectEvidence(content)
  return { candidates: validateCandidates(parseCandidatesJson(evidence.text), evidence), evidence }
}
