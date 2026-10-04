---
name: chang-ship
description: Use when shipping or verifying a change to CHANG / FacadeXPM (changpm.app): deploying the web app, Supabase edge functions or SQL, testing a database change safely, and checking the live site in Chrome. Covers the guards, the commands, and the traps found in practice.
---

# Shipping a change to CHANG

Live site https://changpm.app (Cloudflare Workers). Backend: Supabase project **CHANG** `kntspldhvcjeaubtqtkn`. The old Tokyo project `yyzbgdmgyvvypfcjuhtr` is only a reference; a build must never point at it.

## 1. Web app
1. `npx vitest run` (all green) and `npm run build`.
2. `npm run deploy` = build, `verify-bundle` (must contain the CHANG ref, must not contain the Tokyo one), `smoke-boot` (Playwright: app starts, login renders), then `wrangler deploy`. Never run bare `wrangler deploy`.
3. `git push` is harmless: Cloudflare's Git auto-build is disconnected on purpose (it used to overwrite manual deploys and cause stale-chunk blank pages).
4. "No deploy targets" printed by wrangler is normal (the custom domain is attached in the dashboard).

## 2. Edge functions
`npx supabase functions deploy <name> --project-ref kntspldhvcjeaubtqtkn --use-api` (no Docker needed).
Add `--no-verify-jwt` for line-webhook, field-form, sign-link, omise-webhook. Cron-called functions keep JWT on and check `x-cron-secret` via `verify_cron_secret()`. Shared code lives in `supabase/functions/_shared/`; keep new pure logic there so vitest can import it (`import ... from '../../supabase/functions/_shared/x.ts'`). Secrets are set by the owner in the Supabase dashboard; never ask for them in chat and never print rows that contain them (select named columns only).

## 3. SQL / migrations
- Write `supabase/migrations/YYYY-MM-DD-NN-name.sql`, apply with `npx supabase db query --linked -f <file>` (history table is not updated; the file in git is the record). A migration is live the moment it runs.
- Every new SECURITY DEFINER function: `REVOKE ALL ... FROM PUBLIC, anon` then `GRANT` only what is needed. A restore once silently lost every REVOKE.
- A view's `x.*` column list freezes at creation; re-create views after adding columns.
- `upsert` `onConflict` must name the real unique index; PostgREST embeds need exact FK names when there are FKs both ways.
- Test DB logic in a transaction that ends with `RAISE EXCEPTION 'RESULT ...'` (nothing persists). To act as a user: `SET LOCAL ROLE authenticated` plus `set_config('request.jwt.claims', json_build_object('email', ..., 'role','authenticated','sub', ...)::text, true)`.
- The Supabase MCP `execute_sql` shows only the LAST statement's result; run checks one at a time.

## 4. Verify on the live site (Chrome tool)
- The app is a PWA in `prompt` mode: after a deploy the open tab keeps the old bundle. `registration.update()`, wait (install can take 10-20 s), click the "รีเฟรชเพื่ออัปเดต" banner and then the "🔄 รีเฟรชเพื่ออัปเดต" button in the modal; compare the loaded `index-*.js` against `fetch('/?x='+Date.now(), {cache:'no-store'})`. Repeat if a newer deploy landed meanwhile.
- Use the tab group the tool gives you; the logged-in profile is the owner's, so only read and click through screens, never enter credentials or change data you were not asked to.
- Call an edge function from the page with the user's own session: `localStorage` key `sb-*-auth-token` → `access_token` → `fetch(.../functions/v1/<fn>, {headers:{Authorization:'Bearer '+t}})`; do not print the token.
- State plainly what was verified live and what was only tested in the database or by unit tests.

## 5. Data traps seen
- A mistyped date (year 82026) stretched charts and would have been written into `sites.end_date`; chart code now ignores dates outside 2000-2100. Check data when a chart looks wrong.
- `useExpenses/useIncomes` are paged (1000 rows); use `fetchAllRows` for totals.
- Thai text in generated images: render with headless Chromium, not PIL.
