# Task 6 report — edge function `repair-workorder`

Status: DONE (not deployed; deploy needs `--no-verify-jwt`).

## Files
- `supabase/functions/_shared/repair-workorder-logic.ts` — `handleRepairWorkorder(body, deps, now)`, pure, deps-injected (copy of the customer-form-logic pattern). Also exports `decodePngDataUrl`, `MAX_SIGNATURE_BYTES` (300 KB), `SIGNED_URL_SECONDS` (7200), `SIGNER_NAME_MAX` (100).
- `supabase/functions/repair-workorder/index.ts` — shell: CORS, service-role client, real deps. Reuses `loadWorkOrderInput` + `buildWorkOrder` (R1); reads `tenants(company_name, address, phone, logo_url)` for the token's tenant itself; passes only the token's ticket id to the loader.
- `src/lib/repairWorkorderLogic.test.js` — 55 tests.

## Behaviour
Request: POST JSON `{ action, token, ... }`.

Request-shape errors (400): non-object → `bad_request`; token missing/>128 → `missing_token`; other action → `unknown_action`; sign: signerName trimmed empty or >100 → `bad_name`; signaturePng not `data:image/png;base64,`, invalid base64, decoded >300 KB (checked from length before decoding), or no PNG magic bytes → `bad_signature`. Body checks run before any DB read.

Token checks (same for all three actions), in order; refusals are **HTTP 200 `{ reason }`** for every action (page renders one refusal screen):
1. token not found / action_type ≠ `repair_workorder` / no repair_ticket_id → `not_found`
2. `expires_at <= now` → `expired` (`used_at` ignored — multi-use)
3. worker missing, other tenant than token, or `status ≠ 'active'` → `not_found`
4. tenant lacks module `line_bot` → `line_bot_disabled` (extra reason, not in the brief's list — see below)
5. no `worker_assignments` row with tenant_id + worker_id + repair_ticket_id → `not_assigned`
6. ticket missing / other tenant → `not_found`; ticket `declined` → `declined`

- `view` → `{ ok: true, workOrder }`, signed URLs 2 h, today = Bangkok date.
- `sign` → latest receipt exists and `force !== true` → `{ ok: true, already: true, receipt }`; else upload PNG bytes (contentType image/png) to `document-receipts` at `<tenant>/repair_ticket/<ticketId>/<now>-crew.png`, insert `document_receipts` with explicit `tenant_id`, `document_type 'repair_ticket'`, `signed_by 'crew:' + worker.name` → `{ ok: true, receipt }`. If the insert fails the uploaded PNG is removed and 500 is returned. `receipt` = `{ id, signer_name, signed_at }` (no signature URL — page can `view` again to see the printed one).
- `sign_link` → insert `document_receipt_links` (explicit tenant_id, `created_by 'crew:' + name`), push `กรุณาเซ็นรับงานซ่อม <number>\n<APP_URL>/sign/<id>` to `repair_tickets.line_user_id` via `pushToCustomer(customerPushDeps(admin), …)`; a throw or skip → `sent:false`. Returns `{ ok: true, sent, url }`.
- Any dep throw → 500 `{ error: 'failed' }`, no raw text. Non-POST → 405.

## Module choice
`line_bot`, same as field-form for every LINE crew link, and the repairs page itself is gated by `module: 'line_bot'` in App.jsx. Refusal `line_bot_disabled` (field-form's existing name) — Task 7 page must render it (suggest the same text as expired/unavailable).

## Verification
- `npx vitest run src/lib/repairWorkorderLogic.test.js` — 55 passed (first run failed: module missing).
- `npm test` — 354 files / 4592 tests passed.
- `DENO_NO_PACKAGE_JSON=1 npx -y deno@2.1.4 check --node-modules-dir=none supabase/functions/repair-workorder/index.ts` — clean.
- No DB calls, no deploy, no push.

## Concerns / notes for the controller
1. Double-tap race: two simultaneous `sign` calls both see no receipt and both insert → two rows. The latest one is shown everywhere (loader orders by signed_at desc), so this matches review focus 4 ("one visible latest receipt, no crash") but is not strictly once-only.
2. `sign_link` has no rate limit of its own: each call inserts a `document_receipt_links` row (7-day default expiry). Customer pushes are protected by the per-tenant push budget; the link rows are not. Page should disable the button after one tap.
3. `sign_link` is allowed even when a receipt already exists (brief did not say otherwise).
4. Deploy: `supabase functions deploy repair-workorder --no-verify-jwt` (supabase/config.toml has no per-function entries, so nothing added there). Needs the 2026-11-25-03 migration live first (repair_ticket_id column + document_type 'repair_ticket').
5. Assignment check is on any date (not just today), per the brief's wording; a worker on another day of the same ticket still sees it until the token expires.
