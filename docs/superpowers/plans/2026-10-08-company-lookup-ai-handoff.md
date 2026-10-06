# AI company lookup (ค้นหาอัตโนมัติ) — handoff

Branch `feat/dbd-company-lookup`. Nothing here has been run against the real Anthropic API, and the migration is NOT applied.

## What it does
In the supplier and client forms, `DbdLookup` has a new button "ค้นหาอัตโนมัติ (AI)" next to "ค้นหาใน DBD" (the paste flow stays as the fallback).
It calls the edge function `lookup-company` with `{name}`. The function asks Claude (`claude-sonnet-5-5`) to search the web with the web search tool restricted to an allowlist, and returns up to 3 candidates `{name, address, taxId, taxIdValid, verification, sources[]}`.
The user picks one candidate. It feeds the existing editable preview, and the form is only filled after "ใช้ข้อมูลนี้". Nothing is auto-filled. The AI address is labelled "ที่อยู่จาก AI — ตรวจก่อนใช้" (it is not verified by the server).

Prompt shape: short prose (one quoted source sentence per candidate), a line `###JSON###`, then the JSON. Only the text after the delimiter, and only text blocks after the last tool block, is parsed. Citations are collected from all text blocks.

Server-side trust rules (all in `supabase/functions/_shared/company-lookup.ts`, unit-tested):
1. The 13-digit ID must pass the Thai checksum, otherwise the candidate is dropped.
2. The ID's digits must appear in the `cited_text` of an https citation on an allowed domain, otherwise it is dropped. Search result bodies are encrypted, so `cited_text` (max 150 chars) is the only fetched text the server sees.
3. That same citation's `cited_text` or `title` must contain the company-name core (name minus บริษัท / จำกัด / (มหาชน) / ห้างหุ้นส่วน… / หจก. / บจก., whitespace, Thai digits and case normalised), otherwise it is dropped. This stops an ID cited for another company.
4. `sources` are built by the server from those citations only. URLs the model wrote itself are ignored.
5. `multi_source` = qualifying citations from 2+ distinct allowlisted domains, otherwise `single_source`.
6. Final `stop_reason` of `pause_turn` or `max_tokens` with no candidates returns code `incomplete` (Thai "ค้นหาไม่เสร็จ ลองใหม่หรือใช้การวางข้อความ"), not "not found".
Gate (same as extract-po-document): JWT required (deployed WITH verification), `is_admin_or_owner()`, `tenant_can_write()`, `current_tenant_id()`, all via the caller's JWT; Thai 403. The Suppliers/Clients forms are only editable by ADMIN+ and are not behind a module key, so there is no `has_module_access` check. The AI button stays visible; a non-admin gets the Thai error.

## Budget (migration `supabase/migrations/2026-10-08-03-company-lookup-usage.sql`, NOT applied)
- Tables: `company_lookup_caps(plan, daily_cap)` seeded trial 5 / active 30 / expired 0 / `_global` 300 (adjust with a plain UPDATE; unknown plan falls back to 5); `company_lookup_usage(tenant_id, day, count)`, PK (tenant_id, day). RLS on, no policies, no grants to app roles.
- Functions (SECURITY DEFINER, `REVOKE ALL FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE TO service_role`):
  - `consume_company_lookup(p_tenant uuid) returns text` -> `'ok' | 'tenant_cap' | 'global_cap' | 'unknown_tenant'`. It reserves BEFORE the Anthropic call (every attempt counts). It enforces the per-tenant plan cap and the global all-tenant daily ceiling atomically (an advisory lock serialises callers, and the upsert has `WHERE count < cap`).
  - `refund_company_lookup(p_tenant uuid)` decrements (floor 0). It is called only when the Anthropic call failed before any successful API response (fetch error or non-2xx), or when the handler threw before a response.
- Day = Bangkok date. The old count-after-success functions are gone (never applied).

## Release order
1. Apply the migration, then diff the function ACLs against what is expected (a past restore lost function grants: see 2026-10-03-07). Check that `anon` and `authenticated` cannot EXECUTE the two functions or read the two tables.
2. Confirm web search is enabled for the Anthropic org in the Claude Console (a disabled org gets 400 "web search is not enabled", which the function maps to "บริการค้นหายังไม่เปิดใช้"). The `ANTHROPIC_API_KEY` secret already exists.
3. `npx supabase functions deploy lookup-company --project-ref kntspldhvcjeaubtqtkn --use-api` (NOT `--no-verify-jwt`).
4. Build and deploy the web app.

## Allowlist (single editable constant `ALLOWED_DOMAINS`)
`dbd.go.th` (includes datawarehouse.dbd.go.th), `rd.go.th`, `set.or.th`, `sec.or.th`, `dataforthai.com`. Subdomains are included automatically; https only. No wildcards or schemes (the API rejects them); keep ASCII-only. The browser mirror is `src/lib/companyLookupUi.js` (source links render only for https + allowlist); a test keeps both in sync.

## Pricing (source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool and https://platform.claude.com/docs/en/about-claude/pricing)
- Web search: $10 per 1,000 searches ($0.01 each; errors are not billed), plus standard token cost. Search results count as input tokens.
- Claude Sonnet 5.5: $2 / MTok input, $10 / MTok output.
- Up to 4 searches = $0.04 plus tokens. My earlier guess of $0.05-0.10 per lookup MAY BE TOO LOW: a `pause_turn` continuation resends the search results as input tokens (`MAX_CONTINUATIONS` is 1 to limit this), so a lookup may cost more. Use the first live logs (`company_lookup`: inputTokens, outputTokens, webSearchRequests, continuations) to re-estimate before raising caps.
- Worst case with the caps: 300 lookups per day globally, trial tenant 5 per day, active tenant 30 per day.
- Tool version used: `web_search_20250305` (basic). If the API returns a 400 mentioning `allowed_callers`, add `allowed_callers: ['direct']` in `buildLookupRequest`.

## Logs
Each call logs one JSON line `company_lookup` (no names): rawCandidates, drops by reason (checksum / duplicate / no_allowed_source / id_not_cited / name_not_cited / malformed), kept, stopReason, continuations, summed inputTokens / outputTokens / webSearchRequests, citation count, search error codes. `company_lookup_budget` is logged when a cap blocks a call.

## Unverified (never run against the real API)
- Whether the search tool can read dbd.go.th / datawarehouse.dbd.go.th behind its bot wall. If it cannot, results will mostly come from dataforthai.com and will be `single_source`.
- Whether the model's text blocks carry `citations` when it also writes JSON, and whether the cited snippet contains both name and ID within 150 chars. The guards depend on it. If not, every candidate is dropped and users see "ไม่พบ". Check the first live logs (`drops`).
- The model name `claude-sonnet-5-5` (from the owner's instruction; extract-po-document uses `claude-sonnet-5`).
- The SQL was never run: the migration has not been applied or syntax-checked against a database.
- The Deno edge function was never deployed or run; the vitest tests cover only the shared pure module.
- Owner must test with 3-5 real companies, including one with a duplicate-looking name, before relying on it.
