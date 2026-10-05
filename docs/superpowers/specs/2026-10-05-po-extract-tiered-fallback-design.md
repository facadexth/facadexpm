# PO document extract: cheaper-first reading, manual fallback, supplier examples

Date: 2026-10-05. Status: draft for owner review. Builds on
`2026-09-10-po-document-scan-extraction-design.md` (original scan pipeline).

## Goal

The PO document scan (`extract-po-document` edge function, also reused by the
"swap tax invoice" action) must not depend entirely on the AI call and the
tenant's monthly scan quota. Outcome the owner wants:

1. Most scans use a cheaper model; the stronger model runs only when needed.
2. When the AI is unavailable or the quota is used up, the user is never
   blocked: they see the document and type the lines in.
3. The existing per-supplier "calibration examples" keep working and are used
   in more places.

Customers are told to **check every scan result before saving**; the result
always lands in the editable form. A one-line reminder is added to the form.

## Context (verified 2026-10-05)

- Documents are a mix of phone photos, scanned PDFs and PDFs made by scanner
  apps. Almost none have a usable text layer, so a free non-AI reader (PDF text
  or browser OCR) was considered and rejected: it would rarely apply and Thai
  OCR on dot-matrix print is unreliable.
- 61 scans recorded in `document_scan_usage`: 27 PDF, 8 JPEG, 26 untyped older.
- Quota per package (`packages.max_document_scans_per_month`): Free 10, Solo 50,
  Pro Team 100, Business 500, Enterprise unlimited.
- Client entry points: PO form (`PurchaseOrders.jsx` `handleScanUpload`), swap
  modal (same file, passes no examples today), supplier page (`Suppliers.jsx`,
  saves calibration examples). All go through `extractPoDocument` in
  `src/hooks/useSupabase.js`.
- Calibration examples: table `supplier_document_examples`, max 3 per supplier,
  `saveSupplierDocumentExample(supplierId, base64, mimeType, extracted)` already
  inserts the new one first, then prunes the oldest. These are few-shot
  examples sent with each call, not model training.

## Blocking prerequisite

Every call on CHANG currently returns 502 (9 of 9 since 2026-10-05 04:22,
under 1.2 s, after the auth and quota gates pass, so it fails in the Anthropic
call). Cause not yet confirmed: most likely the `ANTHROPIC_API_KEY` secret is
missing on CHANG, or the model name is rejected. The Console key "CHANGPM"
expires **2026-10-10**; credits were $2.83. The owner creates a new key and sets
the secret, and turns on credit auto-reload. Nothing below can be verified
until this is fixed.

## Design

### 1. Cheaper model first (edge function)

- One merged system prompt: the owner's reference prompt (strict JSON,
  explicit reject path, Thai/English) plus the fields the app uses today:
  `supplier_name_guess`, `document_date_guess`, `reference_no_guess`, per-line
  `discount_pct`, and a new optional `printed_subtotal`. Per-line field names
  stay `description`, `quantity`, `unit`, `unit_price`, `discount_pct` so the
  client parser is unchanged. Reject path: `{"status":"error","message":
  "unreadable_document_or_missing_table"}`.
- First pass: cheap model (Haiku 4.5). Second pass, once, with the current
  stronger model, only if the first result fails a check:
  JSON parses, `status` is success, every line has quantity > 0 and a price,
  and if `printed_subtotal` is present the sum of
  `quantity * unit_price * (1 - discount_pct/100)` is within tolerance.
  Second pass runs only if enough request time remains; otherwise the response
  is `ai_unavailable` and the client shows the manual-entry notice.
- Supplier examples are sent in both passes.
- The checks live in a small pure module (testable with vitest, imported by the
  function).
- Cache: new table `scan_result_cache(tenant_id, file_sha256, result jsonb,
  created_at)`, unique `(tenant_id, file_sha256)`, RLS tenant-scoped. Client
  computes SHA-256 of the exact payload bytes; function checks the cache before
  any model call. The hash must include the supplier-example ids so changing
  examples invalidates it.
- Quota: one successful document = one scan, whichever model read it.
  Rejected reads, failed calls, cache hits and the second pass are not
  counted. `document_scan_usage` gains nullable `model_used`. Weighted quota is
  out of scope.
- Error responses become `{ error, code }` with codes `quota_exhausted` (429),
  `ai_unavailable`, `unreadable`, `too_long`. The existing `error` text stays,
  so an old client keeps working.

### 2. Manual-entry fallback (client)

- `extractPoDocument` returns `code` as well as the message.
- The PO form keeps the picked file (object URL) after any outcome and shows a
  collapsible preview above `ItemsEditor` (image or embedded PDF, tap for full
  size, folded by default on mobile).
- Failures show a yellow notice, not a red dead end: quota exhausted (with a link to the
  tenant billing page), AI unavailable, unreadable (suggest retaking the
  photo), too long. The user types lines in the existing `ItemsEditor`.
- Swap modal gets the same notice and preview. Manual entry there must still
  pass the existing amount-match safeguard (total within the tolerance of the
  expense's `amount_no_vat`). Its current manual fields are to be confirmed
  when the plan is written.
- Manual entry writes nothing to `document_scan_usage`.
- Reminder text in the PO form: "ตรวจรายการทุกครั้งก่อนบันทึก".

### 3. Supplier examples (v1 scope)

1. Used in both model passes (above).
2. Swap modal passes the supplier's examples (today it passes `[]`).
3. After a scan, once the user has corrected the lines and saves the PO, offer
   "เก็บใบนี้เป็นตัวอย่างของซัพพลายเออร์". It calls the existing
   `saveSupplierDocumentExample` with the kept base64/mime type and the final
   lines as `extracted` (same shape as the model output). Only offered when the
   document came from a scan in this session. The 3-example cap and
   insert-then-prune order are unchanged.
4. Deferred: using examples' known units and prices as an extra plausibility
   check, and prefilling manual entry from a supplier's past lines.

## Rollout order (each step backward compatible)

0. Fix the 502 / new key (owner).
1. Migration (additive, nullable): `document_scan_usage.model_used`,
   `scan_result_cache` + RLS. Before applying: check no view uses
   `document_scan_usage.*` (view column freeze), and no new function is
   callable by anon. Migrations go live when applied.
2. Edge function deploy.
3. Web deploy via `npm run deploy` (chang-ship guards), then live check in Chrome.

## Testing

- vitest: sanity checks (quantity, price, subtotal tolerance), error-code to
  message mapping, cache-key construction.
- Evaluation before shipping cheap-first: run both models over the saved supplier
  examples plus a few real photos and PDFs. Ship the cheap-first path only if
  the cheap model matches the strong one on the checks and the second pass
  triggers on well under half the documents; otherwise ship the fallback and
  caching parts only. Also measure how much saved examples (full images)
  raise input tokens and offset the saving.
- Provider comparison (evaluation only): the same evaluation also runs
  **Gemini Pro** (Google) as a challenger next to the Anthropic models, to see
  whether any non-Anthropic option gives equal accuracy at lower cost on real
  documents. Measure per document: field accuracy against the corrected
  result, whether the subtotal check passes, input/output tokens and cost.
  Rules for this comparison:
  - Offline script run by the owner or on the owner's machine; nothing is wired
    into production and no new edge-function secret is added. The Gemini API key
    stays local and never goes in the repo or the chat.
  - Use only documents the owner supplies or FacadeX's own tenant. Other
    tenants' saved supplier examples are not sent to Google.
  - Pricing and model names are checked against Google's current docs at run
    time, not assumed. Gemini Pro is usually priced above its Flash tier, so a
    Flash model may be added to the run if Pro does not beat the Anthropic
    cost.
  - Switching the production provider is a separate decision and a separate
    spec (new function code, new secret, data-protection review). It happens
    only if a challenger is clearly cheaper at equal accuracy.
- Live on changpm.app: one PDF and one photo through the PO form and swap
  modal, plus a deliberately blurry photo for the reject path. The
  quota-exhausted message is covered by the unit test (not forced on prod).

## Risks

- A cheap-model read can be plausible but wrong, especially with no printed
  subtotal, and wrong prices feed weighted-average inventory cost. Mitigations:
  the result is always reviewed in the editable form, the reminder text, the
  swap amount-match check, and the evaluation gate.
- Two sequential model calls may hit the edge function time limit on large
  documents (handled by the time-remaining rule).
- Cache stores PO data: tenant-scoped with RLS, keyed by hash.
- Model IDs to be verified against the API during implementation (code uses
  `claude-sonnet-5`).
- Operational: key expiry 2026-10-10 and low credits.

## Out of scope

Switching the production provider away from Anthropic (only evaluated, see
Testing), free non-AI reading (PDF text layer, browser OCR), weighted quota, prefill from
past supplier lines, plausibility checks from examples, removing the
"TEMPORARY diagnostic" `console.error` lines in `PurchaseOrderForm`.
