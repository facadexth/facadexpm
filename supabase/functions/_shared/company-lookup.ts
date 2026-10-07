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
// pause_turn continuations resend search results as input tokens (cost), so keep this at 1.
export const MAX_CONTINUATIONS = 1
export const MAX_CANDIDATES = 3
// Per-tenant (trial 5 / active 30) and global (300) daily caps live in the DB table
// company_lookup_caps (migration 2026-10-08-03), enforced atomically by consume_company_lookup().
export const JSON_DELIMITER = '###JSON###'

export const LOOKUP_SYSTEM_PROMPT = `You look up Thai registered companies (juristic persons) using web search restricted to official and registry sites.
Given a company name, find the company or companies that name refers to.
Answer in two parts:
PART 1 (short prose): one line per candidate company quoting, word for word, the source sentence that contains BOTH the company name and its 13-digit registration number. Do not add anything else.
Then a line containing exactly ${JSON_DELIMITER}
PART 2: JSON ONLY (no code fences) in exactly this shape:
[{"name": "<registered name in Thai>", "address": "<registered head-office address or null>", "taxId": "<13-digit juristic registration number>", "sources": [{"url": "<page url>", "title": "<page title>"}]}]
Rules:
- Never guess. Only include a value that you read in a search result; use null for an address you did not see.
- taxId must be the 13 digits exactly as shown in a source. If you did not see it, leave the candidate out.
- If the name is ambiguous, list every distinct company (maximum 3), each with its own sources.
- If you cannot find the company, write ${JSON_DELIMITER} followed by [].
- Every candidate needs at least one source url that you actually used.`

export function lookupUserPrompt(name: string): string {
  return `Company name (a company registered in Thailand): ${name}`
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
      // No user_location: the API rejected country 'TH' with a 400 ("Country code TH is not
      // supported") and timezone-only is untested. Thailand focus comes from the prompt instead.
    }],
    messages: [{ role: 'user', content: lookupUserPrompt(name) }],
  }
}

// ---- input ------------------------------------------------------------
export function cleanCompanyName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const t = raw.replace(/\p{Cc}/gu, ' ').replace(/\s+/g, ' ').trim()
  return t.length >= 2 && t.length <= 120 ? t : null
}

// ---- budget result from consume_company_lookup() -----------------------
export type BudgetCode = 'ok' | 'tenant_cap' | 'global_cap' | 'error'
// consume_company_lookup returns jsonb {status, day}; a bare status string is also accepted.
export function budgetStatus(result: unknown): string {
  if (typeof result === 'string') return result
  const s = (result as { status?: unknown } | null)?.status
  return typeof s === 'string' ? s : 'error'
}
export function budgetDay(result: unknown): string | null {
  const d = (result as { day?: unknown } | null)?.day
  return typeof d === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(d) ? d : null
}

// Refund the reservation ONLY when Anthropic certainly did not bill:
//  - a non-2xx HTTP status, or
//  - a fetch failure that is not an abort/timeout (the request may have been processed
//    when we gave up), and
//  - no earlier response in this lookup (a first call already succeeded = spent).
// A timeout, or a 200 whose body cannot be parsed, counts as SPENT.
export type FailureKind =
  | { kind: 'http'; status: number }
  | { kind: 'fetch'; errorName?: string }
  | { kind: 'unparseable_200' }
export function shouldRefund(f: FailureKind, priorResponse = false): boolean {
  if (priorResponse) return false
  if (f.kind === 'http') return !(f.status >= 200 && f.status < 300)
  if (f.kind === 'fetch') return f.errorName !== 'AbortError' && f.errorName !== 'TimeoutError'
  return false
}

export function budgetOutcome(raw: unknown): { ok: boolean; code: BudgetCode; message: string } {
  const result = budgetStatus(raw)
  if (result === 'ok') return { ok: true, code: 'ok', message: '' }
  if (result === 'tenant_cap') {
    return { ok: false, code: 'tenant_cap', message: 'ใช้ค้นหาอัตโนมัติครบโควตาของวันนี้แล้ว ลองใหม่พรุ่งนี้ หรือใช้ปุ่ม "ค้นหาใน DBD" เปิดเว็บ DBD แล้วกรอกเอง' }
  }
  if (result === 'global_cap') {
    return { ok: false, code: 'global_cap', message: 'ระบบค้นหาอัตโนมัติถึงขีดจำกัดรวมของวันนี้แล้ว ลองใหม่พรุ่งนี้ หรือใช้ปุ่ม "ค้นหาใน DBD" แทน' }
  }
  return { ok: false, code: 'error', message: 'ระบบค้นหาขัดข้อง ลองใหม่ภายหลัง หรือใช้ปุ่ม "ค้นหาใน DBD" แทน' }
}

// Final stop_reason + candidates -> outcome. Incomplete is NOT "not found".
export function lookupOutcome(stopReason: unknown, candidateCount: number): 'ok' | 'incomplete' | 'not_found' {
  if (candidateCount > 0) return 'ok'
  return stopReason === 'pause_turn' || stopReason === 'max_tokens' ? 'incomplete' : 'not_found'
}
// ---- statistics (table company_lookup_stats, migration 2026-10-08-04) -----
// EDITABLE price constants for the cost estimate (USD). Source: platform.claude.com pricing page.
export const PRICE_PER_SEARCH_USD = 0.01
export const PRICE_INPUT_PER_MTOK_USD = 2
export const PRICE_OUTPUT_PER_MTOK_USD = 10

export function estimateCostUsd(u: { searches?: number; inputTokens?: number; outputTokens?: number }): number {
  const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)
  const usd = n(u.searches) * PRICE_PER_SEARCH_USD
    + (n(u.inputTokens) / 1_000_000) * PRICE_INPUT_PER_MTOK_USD
    + (n(u.outputTokens) / 1_000_000) * PRICE_OUTPUT_PER_MTOK_USD
  return Math.round(usd * 100000) / 100000
}

// Distinct allowlisted hostnames of the KEPT sources only (never names/IDs/addresses).
export function statsDomains(candidates: Array<{ sources?: Array<{ url?: string }> }>, allowed: string[] = ALLOWED_DOMAINS): string[] {
  const hosts = new Set<string>()
  for (const c of Array.isArray(candidates) ? candidates : []) {
    for (const s of c?.sources ?? []) {
      if (allowedDomainOf(s?.url, allowed)) hosts.add(new URL(s.url as string).hostname.toLowerCase())
    }
  }
  return [...hosts].sort()
}

export type StatsOutcome = 'found' | 'not_found' | 'incomplete' | 'error'
export function buildStatsRow(a: {
  tenantId: string
  day: string
  outcome: StatsOutcome
  candidates?: Array<{ verification?: string; sources?: Array<{ url?: string }> }>
  searches?: number | null
  inputTokens?: number | null
  outputTokens?: number | null
}) {
  const cands = a.candidates ?? []
  const known = a.searches != null || a.inputTokens != null || a.outputTokens != null
  return {
    tenant_id: a.tenantId,
    day: a.day,
    outcome: a.outcome,
    candidates_kept: cands.length,
    web_search_requests: a.searches ?? null,
    input_tokens: a.inputTokens ?? null,
    output_tokens: a.outputTokens ?? null,
    est_cost_usd: known ? estimateCostUsd({ searches: a.searches ?? 0, inputTokens: a.inputTokens ?? 0, outputTokens: a.outputTokens ?? 0 }) : null,
    domains: statsDomains(cands),
    multi_source: cands.some((c) => c.verification === 'multi_source'),
  }
}

export const INCOMPLETE_MESSAGE = 'ค้นหาไม่เสร็จ ลองใหม่ หรือใช้ปุ่ม "ค้นหาใน DBD" แล้วกรอกเอง'

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
// Returns the matching allowlist entry for an https URL, or null. Subdomains
// match; look-alikes (evil-dbd.go.th, dbd.go.th.evil.com) and http: do not.
export function allowedDomainOf(url: unknown, allowed: string[] = ALLOWED_DOMAINS): string | null {
  if (typeof url !== 'string') return null
  let host: string
  try {
    const u = new URL(url)
    if (u.protocol !== 'https:') return null
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
  text: string // text blocks AFTER the last tool block, joined, after the delimiter (the JSON part)
  citations: Citation[] // citations from ALL text blocks
  resultUrls: string[]
  searchErrors: string[]
  searches: number
}

// deno-lint-ignore no-explicit-any
export function collectEvidence(content: any[]): Evidence {
  const ev: Evidence = { text: '', citations: [], resultUrls: [], searchErrors: [], searches: 0 }
  if (!Array.isArray(content)) return ev
  let lastTool = -1
  content.forEach((b, i) => {
    if (b && (b.type === 'server_tool_use' || b.type === 'web_search_tool_result')) lastTool = i
  })
  let answer = ''
  content.forEach((b, i) => {
    if (!b || typeof b !== 'object') return
    if (b.type === 'server_tool_use') ev.searches++
    else if (b.type === 'web_search_tool_result') {
      if (Array.isArray(b.content)) {
        for (const r of b.content) if (r && typeof r.url === 'string') ev.resultUrls.push(r.url)
      } else if (b.content?.type === 'web_search_tool_result_error') {
        ev.searchErrors.push(String(b.content.error_code ?? 'unknown'))
      }
    } else if (b.type === 'text') {
      if (typeof b.text === 'string' && i > lastTool) answer += b.text
      if (Array.isArray(b.citations)) {
        for (const c of b.citations) {
          if (c && typeof c.url === 'string' && typeof c.cited_text === 'string') {
            ev.citations.push({ url: c.url, title: String(c.title ?? ''), citedText: c.cited_text })
          }
        }
      }
    }
  })
  // only what follows the delimiter is JSON
  const d = answer.lastIndexOf(JSON_DELIMITER)
  ev.text = d === -1 ? answer : answer.slice(d + JSON_DELIMITER.length)
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

// Company name without the legal-form words, whitespace-stripped, lowercase.
export function companyNameCore(name: unknown): string {
  return normalizeDigits(name)
    .toLowerCase()
    .replace(/ห้างหุ้นส่วนจำกัด|ห้างหุ้นส่วนสามัญ|\(มหาชน\)|บริษัท|จำกัด|หจก\.?|บจก\.?/g, ' ')
    // English legal forms, with or without punctuation (co., ltd., public company limited, pcl, corp, inc ...)
    .replace(/(?<![a-z])(?:public|company|limited|corporation|corp|co|ltd|pcl|inc)(?![a-z])\.?/g, ' ')
    .replace(/[.,()]/g, ' ')
    .replace(/\s+/g, '')
}
function containsCore(text: unknown, core: string): boolean {
  return core.length > 0 && normalizeDigits(text).toLowerCase().replace(/[.,()]/g, ' ').replace(/\s+/g, '').includes(core)
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
  const whole = unwrap(tryParse(t.trim()))
  if (whole) return whole
  // narration like "ค้นหา [DBD] ..." or "[1]" may precede the JSON: try each '[' / '{' start
  const ends: number[] = []
  for (let i = 0; i < t.length; i++) if (t[i] === ']' || t[i] === '}') ends.push(i)
  let attempts = 0
  for (let i = 0; i < t.length && attempts < 60; i++) {
    if (t[i] !== '[' && t[i] !== '{') continue
    for (let k = ends.length - 1; k >= 0 && ends[k] > i; k--) {
      if (++attempts > 60) break
      const arr = unwrap(tryParse(t.slice(i, ends[k] + 1)))
      if (arr && arr.length > 0 && arr.every((x) => x && typeof x === 'object' && !Array.isArray(x))) return arr
      if (arr) break
    }
  }
  return []
}

// ---- validation -------------------------------------------------------
export type Candidate = {
  name: string
  address: string | null // taken from the model, not verified
  taxId: string
  taxIdValid: true
  verification: 'multi_source' | 'single_source'
  sources: { url: string; title: string }[]
}
export type DropReason = 'malformed' | 'checksum' | 'duplicate' | 'no_allowed_source' | 'id_not_cited' | 'name_not_cited'
export type Validation = { candidates: Candidate[]; drops: DropReason[] }

// Sources are built from the citations (never from model-written URLs): a citation
// counts only if it is on an allowed https domain, its cited_text contains the ID,
// and its cited_text or title contains the company-name core.
export function validateCandidates(raw: unknown[], ev: Evidence, allowed: string[] = ALLOWED_DOMAINS): Validation {
  const candidates: Candidate[] = []
  const drops: DropReason[] = []
  const seen = new Set<string>()
  const allowedCitations = ev.citations.filter((c) => allowedDomainOf(c.url, allowed))
  for (const item of Array.isArray(raw) ? raw : []) {
    if (candidates.length >= MAX_CANDIDATES) break
    if (!item || typeof item !== 'object') { drops.push('malformed'); continue }
    const r = item as Record<string, unknown>
    const name = typeof r.name === 'string' ? r.name.replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    const taxId = normalizeDigits(r.taxId).replace(/[\s-]/g, '')
    if (!name) { drops.push('malformed'); continue }
    if (!isValidThaiId13(taxId)) { drops.push('checksum'); continue }
    if (seen.has(taxId)) { drops.push('duplicate'); continue }
    if (allowedCitations.length === 0) { drops.push('no_allowed_source'); continue }

    const idCites = allowedCitations.filter((c) => textContainsId(c.citedText, taxId))
    if (idCites.length === 0) { drops.push('id_not_cited'); continue }
    const core = companyNameCore(name)
    const good = idCites.filter((c) => containsCore(c.citedText, core) || containsCore(c.title, core))
    if (good.length === 0) { drops.push('name_not_cited'); continue }

    const sources: { url: string; title: string }[] = []
    const domains = new Set<string>()
    for (const c of good) {
      domains.add(allowedDomainOf(c.url, allowed)!)
      if (!sources.some((x) => x.url === c.url)) sources.push({ url: c.url, title: c.title.slice(0, 200) })
    }
    seen.add(taxId)
    const address = typeof r.address === 'string' && r.address.trim()
      ? r.address.replace(/\s+/g, ' ').trim().slice(0, 400)
      : null
    candidates.push({
      name, address, taxId, taxIdValid: true,
      verification: domains.size >= 2 ? 'multi_source' : 'single_source',
      sources,
    })
  }
  return { candidates, drops }
}

// One call: model content blocks -> final candidates (+ diagnostics).
// deno-lint-ignore no-explicit-any
export function candidatesFromContent(content: any[]): { candidates: Candidate[]; evidence: Evidence; drops: DropReason[]; rawCount: number } {
  const evidence = collectEvidence(content)
  const raw = parseCandidatesJson(evidence.text)
  const v = validateCandidates(raw, evidence)
  return { candidates: v.candidates, evidence, drops: v.drops, rawCount: raw.length }
}
