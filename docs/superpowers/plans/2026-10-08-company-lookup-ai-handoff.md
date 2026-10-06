# AI company lookup (ค้นหาอัตโนมัติ) — handoff

Branch `feat/dbd-company-lookup`. Nothing here has been run against the real Anthropic API, and the migration is NOT applied.

## What it does
In the supplier and client forms, `DbdLookup` has the button "ค้นหาอัตโนมัติ (AI)" next to "ค้นหาใน DBD". The old "วางข้อความจาก DBD" paste flow and its parser were REMOVED; "ค้นหาใน DBD" is now only a helper that opens DBD in a new tab and copies the typed name. `src/lib/dbdCompanyParse.js` keeps only `isValidThaiId13` and `normalizeDigits`.
One click on the AI button fills the EMPTY form fields (tax ID, address) immediately, keeps the typed name (offers "ใช้ชื่อนี้"), lists non-empty fields it did not overwrite (with "ใช้ค่าจาก AI แทน"), and shows a banner with an undo ("ยกเลิก (คืนค่าเดิม)"). Nothing is saved until the form's own บันทึก.
It calls the edge function `lookup-company` with `{name}`. The function asks Claude (`claude-sonnet-5-5`) to search the web with the web search tool restricted to an allowlist, and returns up to 3 candidates `{name, address, taxId, taxIdValid, verification, sources[]}`.
The user picks one candidate. It feeds the existing editable preview, and the form is only filled after "ใช้ข้อมูลนี้". Nothing is auto-filled. The AI address is labelled "ที่อยู่จาก AI — ตรวจก่อนใช้" (it is not verified by the server).

Prompt shape: short prose (one quoted source sentence per candidate), a line `###JSON###`, then the JSON. Only the text after the delimiter, and only text blocks after the last tool block, is parsed. Citations are collected from all text blocks.

Server-side trust rules (all in `supabase/functions/_shared/company-lookup.ts`, unit-tested):
1. The 13-digit ID must pass the Thai checksum, otherwise the candidate is dropped.
2. The ID's digits must appear in the `cited_text` of an https citation on an allowed domain, otherwise it is dropped. Search result bodies are encrypted, so `cited_text` (max 150 chars) is the only fetched text the server sees.
3. That same citation's `cited_text` or `title` must contain the company-name core (name minus บริษัท / จำกัด / (มหาชน) / ห้างหุ้นส่วน… / หจก. / บจก., whitespace, Thai digits and case normalised), otherwise it is dropped. This stops an ID cited for another company.
4. `sources` are built by the server from those citations only. URLs the model wrote itself are ignored.
5. `multi_source` = qualifying citations from 2+ distinct allowlisted domains, otherwise `single_source`.
6. Final `stop_reason` of `pause_turn` or `max_tokens` with no candidates returns code `incomplete` (Thai "ค้นหาไม่เสร็จ ลองใหม่ หรือใช้ปุ่ม "ค้นหาใน DBD" แล้วกรอกเอง"), not "not found".
Gate (same as extract-po-document): JWT required (deployed WITH verification), `is_admin_or_owner()`, `tenant_can_write()`, `current_tenant_id()`, all via the caller's JWT; Thai 403. The Suppliers/Clients forms are only editable by ADMIN+ and are not behind a module key, so there is no `has_module_access` check. The AI button stays visible; a non-admin gets the Thai error.

## Budget (migration `supabase/migrations/2026-10-08-03-company-lookup-usage.sql`, NOT applied)
- Tables: `company_lookup_caps(plan, daily_cap)` seeded trial 5 / active 30 / expired 0 / `_global` 300 (adjust with a plain UPDATE; unknown plan falls back to 5); `company_lookup_usage(tenant_id, day, count)`, PK (tenant_id, day). RLS on, no policies, no grants to app roles.
- Functions (SECURITY DEFINER, `REVOKE ALL FROM PUBLIC, anon, authenticated`, `GRANT EXECUTE TO service_role`):
  - `consume_company_lookup(p_tenant uuid) returns jsonb` -> `{status: 'ok' | 'tenant_cap' | 'global_cap' | 'unknown_tenant', day: 'YYYY-MM-DD'}` (the Bangkok day counted). It reserves BEFORE the Anthropic call (every attempt counts). It enforces the per-tenant plan cap and the global all-tenant daily ceiling atomically (an advisory lock serialises callers, and the upsert has `WHERE count < cap`).
  - `refund_company_lookup(p_tenant uuid, p_day date)` decrements (floor 0) on the day that was counted. It is called only when Anthropic certainly did not bill (`shouldRefund`): a non-2xx HTTP status, or a fetch failure that is not an abort/timeout, with no earlier successful response in the same lookup. A timeout (50 s deadline) or a 200 whose body cannot be parsed counts as SPENT, with no refund. A handler throw refunds only if it happened before the Anthropic call began. The refund result is logged (`company_lookup_refund`).
  - Both functions use `SET search_path = public, pg_temp`. The migration drops and recreates them, so it can be re-run.
- Day = Bangkok date. The old count-after-success functions are gone (never applied).

## Release order
1. `2026-10-08-03-company-lookup-usage.sql` (budget). ALREADY APPLIED by the owner; do not edit it, put changes in a new migration. Diff the function ACLs against what is expected (a past restore lost function grants: see 2026-10-03-07).
2. Apply `2026-10-08-04-company-lookup-stats.sql` (statistics table, NOT APPLIED yet). Check that `anon` and `authenticated` cannot read or insert it or use its sequence.
3. Confirm web search is enabled for the Anthropic org in the Claude Console (a disabled org gets 400 "web search is not enabled", which the function maps to "บริการค้นหายังไม่เปิดใช้"). The `ANTHROPIC_API_KEY` secret already exists.
4. Redeploy the function (it now writes stats rows; if the table is missing it only logs an error and the lookup still works): `npx supabase functions deploy lookup-company --project-ref kntspldhvcjeaubtqtkn --use-api` (NOT `--no-verify-jwt`).
5. Build and deploy the web app.

## Statistics (`company_lookup_stats`, migration 2026-10-08-04)
One row per paid attempt, inserted by the edge function (service role) after the Anthropic response: outcome `found` / `not_found` / `incomplete`, or `error` only when the call was billed or possibly billed (not refunded; usage unknown, so tokens and cost are NULL). Columns: tenant_id, day (Bangkok), outcome, candidates_kept, web_search_requests, input_tokens, output_tokens, est_cost_usd, domains (allowlisted hostnames of the kept citations), multi_source. No names, tax IDs or addresses are stored. A failed insert is logged and never fails the lookup. Cost comes from editable constants in `_shared/company-lookup.ts` ($0.01 per search, $2/M input, $10/M output).
Owner queries (run in the SQL editor as service role; there is deliberately no client-readable view):
```sql
-- lookups and estimated cost per day
select day, count(*) as lookups, sum(est_cost_usd) as est_cost_usd
from company_lookup_stats group by day order by day desc;
-- total estimated cost
select sum(est_cost_usd) as total_est_cost_usd, count(*) as lookups from company_lookup_stats;
-- which sites answer (kept citations)
select d as domain, count(*) as lookups
from company_lookup_stats, unnest(domains) as d group by d order by lookups desc;
-- found vs not_found rate
select outcome, count(*) as n, round(100.0 * count(*) / sum(count(*)) over (), 1) as pct
from company_lookup_stats group by outcome order by n desc;
-- how often 2+ sources agree
select multi_source, count(*) from company_lookup_stats where outcome = 'found' group by multi_source;
```

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
