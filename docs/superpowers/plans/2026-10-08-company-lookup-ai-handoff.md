# AI company lookup (ค้นหาอัตโนมัติ) — handoff

Branch `feat/dbd-company-lookup`. Nothing here has been run against the real Anthropic API, and the migration is NOT applied.

## What it does
In the supplier and client forms, `DbdLookup` has a new button "ค้นหาอัตโนมัติ (AI)" next to "ค้นหาใน DBD" (the paste flow stays as the fallback).
It calls the edge function `lookup-company` with `{name}`. The function asks Claude (`claude-sonnet-5-5`) to search the web with the web search tool restricted to an allowlist, and returns up to 3 candidates `{name, address, taxId, taxIdValid, verification, sources[]}`.
The user picks one candidate. It feeds the existing editable preview, and the form is only filled after "ใช้ข้อมูลนี้". Nothing is auto-filled.

Server-side trust rules (all in `supabase/functions/_shared/company-lookup.ts`, unit-tested):
1. Candidate needs a source URL on an allowed domain.
2. The 13-digit ID must pass the Thai checksum, otherwise the candidate is dropped.
3. The ID's digits must appear in the `cited_text` of an allowed-domain citation, otherwise it is dropped. Search result bodies are encrypted (`encrypted_content`), so `cited_text` (max 150 chars) is the only fetched text the server can see.
4. `multi_source` = the same ID appears in citations from 2+ distinct allowlisted domains. Otherwise `single_source` (UI says "แหล่งเดียว — ตรวจกับ DBD ก่อนใช้").
5. Per tenant cap: 30 successful lookups per Bangkok day (`DAILY_LOOKUP_CAP`). Checked before the model call, incremented only when at least one candidate was returned. Over the cap returns HTTP 429 with code `daily_cap` and a Thai message.
Gate: JWT required, `tenant_can_write()` and `current_tenant_id()` via the caller's JWT. The counter uses the service role.

## Allowlist (single editable constant `ALLOWED_DOMAINS`)
`dbd.go.th` (includes datawarehouse.dbd.go.th), `rd.go.th`, `set.or.th`, `sec.or.th`, `dataforthai.com`. Subdomains are included automatically. No wildcards or schemes; the API rejects them. Keep ASCII-only.

## Release order
1. Apply `supabase/migrations/2026-10-08-03-company-lookup-usage.sql` (table + two service-role-only functions). Check the ACLs afterwards.
2. Confirm web search is enabled for the Anthropic org in the Claude Console (a disabled org gets 400 "web search is not enabled", which the function maps to "บริการค้นหายังไม่เปิดใช้"). The `ANTHROPIC_API_KEY` secret already exists.
3. `npx supabase functions deploy lookup-company --project-ref kntspldhvcjeaubtqtkn --use-api` (NOT `--no-verify-jwt`).
4. Build and deploy the web app.

## Pricing (source: https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool and https://platform.claude.com/docs/en/about-claude/pricing)
- Web search: $10 per 1,000 searches ($0.01 each; errors are not billed), plus standard token cost. Search results count as input tokens.
- Claude Sonnet 5.5: $2 / MTok input, $10 / MTok output.
- Rough cost per lookup: up to 4 searches = $0.04, plus tokens. A rough guess is a few cents in total, so about $0.05-0.10 worst case. At the cap of 30 per tenant per day that is under about $3 per tenant per day.
- Tool version used: `web_search_20250305` (basic). If the API returns a 400 mentioning `allowed_callers`, add `allowed_callers: ['direct']` to the tool in `buildLookupRequest`.

## API facts used
Tool params `max_uses`, `allowed_domains` (not together with `blocked_domains`), `user_location` (TH / Asia/Bangkok). Response blocks: `server_tool_use`, `web_search_tool_result` (a list of `{url,title,page_age,encrypted_content}`, or an error object, still HTTP 200), text blocks with `citations[]` `{url,title,cited_text}`. `stop_reason: pause_turn` is continued by resending the assistant content (max 2 continuations).

## Unverified (never run against the real API)
- Whether the search tool can read dbd.go.th / datawarehouse.dbd.go.th behind its bot wall. If it cannot, results will mostly come from dataforthai.com and will be `single_source`.
- Whether a JSON-only answer still carries `citations` on its text blocks. The ID guard depends on them. If it does not, every candidate is dropped and the user always sees "ไม่พบ". The first live test must check this; the function logs `company_lookup` with search/citation counts to help.
- The model name `claude-sonnet-5-5` (taken from the owner's instruction; extract-po-document uses `claude-sonnet-5`).
- The cap is check-then-increment (not atomic), so a burst of parallel calls can overshoot by a few.
- Owner must test with 3-5 real companies, including one with a duplicate-looking name, before relying on it.
