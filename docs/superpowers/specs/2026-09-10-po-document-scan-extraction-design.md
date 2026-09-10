# PO Document Scan Extraction — Design Spec

Date: 2026-09-10

## Problem

Suppliers deliver goods with a printed document (delivery note, provisional
invoice, or quotation — format varies per supplier, e.g. the dot-matrix
"ใบส่งสินค้าชั่วคราว" style). Today, creating the matching Purchase Order in
FacadeX means retyping every line item by hand from that paper document.
`purchase_order_attachments` already lets a PO keep a scan of the document
for reference, but nothing reads it — a human still transcribes every field.

## Goal

Let a user photograph or upload that document and have FacadeX pre-fill a
new PO's line items (description, quantity, unit, unit price) plus a
best-guess supplier/date/reference, using an AI vision call server-side.
The user always reviews and can edit before saving — this assists manual
entry, it never silently creates a PO on its own.

## Non-goals

- No true model fine-tuning. "Training" here means few-shot calibration:
  saving a handful of verified-correct (document, extraction) pairs per
  supplier and including them as reference examples in future extraction
  calls to the same general-purpose vision model. This is enough because a
  given supplier's document layout is stable for years (confirmed by the
  user) — it is not an attempt to build a bespoke OCR model per supplier.
- No support for parsing anything other than the "goods and prices" table
  a supplier document contains. Signatures, stamps, and boilerplate terms
  text are ignored.
- No batch upload (multiple documents at once) in this iteration.

## Architecture

One new Supabase Edge Function, `extract-po-document`, is the only thing
that calls the AI. It is stateless with respect to the app's data model:

```
Request:  { image_base64, mime_type, examples?: [{ image_base64, mime_type, extracted }] }
Response: {
  supplier_name_guess: string | null,
  document_date_guess: string | null,   // ISO date, best-effort
  reference_no_guess: string | null,
  line_items: [{ description, quantity, unit, unit_price }]
}
```

It sends the image (and any calibration examples, as prior-turn
image+JSON pairs) to Claude's vision API with a fixed system prompt
describing the target JSON shape, parses the model's JSON response, and
returns it verbatim (or a `{ error }` shape on failure — see Error
handling). It has no knowledge of suppliers, POs, or tenants; both call
sites below pass it whatever context they have. Uses a current
Claude model with vision support (model name is an implementation
detail, not fixed by this spec).

Phone camera photos can be several MB — the frontend downscales/
recompresses the image (e.g. to a max dimension around 1600px, JPEG)
before base64-encoding and sending it, both to keep the request small and
because a vision model doesn't benefit from resolution far beyond what's
needed to read printed text. Calibration example images saved to
`supplier-doc-examples` are stored at this same downscaled size, not the
original.

Two call sites, both client-side, both hitting this one function:

1. **Suppliers page — calibration.** Upload a sample document for a
   supplier (no examples sent, or that supplier's existing ones if
   re-calibrating) → review/correct the returned line items → save the
   corrected result as a new calibration example for that supplier.
2. **PO creation — actual use.** Supplier must already be selected. Upload
   a document → call the function with that supplier's saved examples (if
   any) → the returned guess pre-fills the existing create-PO form's
   fields. Nothing is saved until the user hits the form's own save
   button, same as manual entry today.

## Data model

One new table, one new storage bucket, modeled directly on
`purchase_order_attachments` / `po-attachments` (2026-08-17-06):

```sql
CREATE TABLE supplier_document_examples (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL DEFAULT current_tenant_id() REFERENCES tenants(id),
  supplier_id   UUID NOT NULL REFERENCES suppliers(id) ON DELETE CASCADE,
  file_path     TEXT NOT NULL,   -- storage: supplier-doc-examples/{tenant_id}/{supplier_id}/{uuid}.{ext}
  extracted     JSONB NOT NULL,  -- the corrected, verified extraction (same shape as line_items above)
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_supplier_document_examples_supplier_id ON supplier_document_examples(supplier_id);
CREATE INDEX idx_supplier_document_examples_tenant_id ON supplier_document_examples(tenant_id);

ALTER TABLE supplier_document_examples ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_full_access ON supplier_document_examples FOR ALL TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'))
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND has_module_access('purchase_orders'));

INSERT INTO storage.buckets (id, name, public) VALUES ('supplier-doc-examples', 'supplier-doc-examples', false)
ON CONFLICT (id) DO NOTHING;

CREATE POLICY supplier_doc_examples_tenant_access ON storage.objects FOR ALL TO authenticated
  USING (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  )
  WITH CHECK (
    bucket_id = 'supplier-doc-examples'
    AND is_admin_or_owner()
    AND (storage.foldername(name))[1] = current_tenant_id()::text
    AND has_module_access('purchase_orders')
  );
```

**Cap: 3 examples per supplier.** When a 4th is saved, delete the oldest
(by `created_at`) for that supplier first. Three verified examples is
enough for few-shot calibration on a layout that doesn't change; keeping
this small keeps both storage and the per-call prompt size bounded.

## API key / cost ownership

Single platform-wide `ANTHROPIC_API_KEY` stored as an Edge Function
secret (`supabase secrets set`), paid by FacadeX (the platform), not
per-tenant. Confirmed acceptable at current scale (effectively one real
tenant today). No per-tenant rate limiting in this iteration — worth
adding later if this becomes multi-tenant-heavy, out of scope now.

## UI changes

**`src/pages/Suppliers.jsx`** — each row's action cell gets a new
"🎓 ฝึกอ่านเอกสาร" button (alongside the existing แก้ไข/ลบ) opening a new
modal component (`SupplierDocumentTrainingModal`):
- File input → on select, calls `extract-po-document` (via a new
  `extractPoDocument()` helper in `src/hooks/useSupabase.js` or a small
  `src/lib/` module) with that supplier's existing
  `supplier_document_examples` rows as `examples`.
- Renders the returned `line_items` in an editable table (reuse the same
  row shape/inputs as the PO line-item editor in `PurchaseOrders.jsx` —
  extract that into a shared small component if it isn't already
  reasonably reusable, per the "design for isolation" principle, but
  don't over-refactor beyond what this needs).
- "💾 บันทึกเป็นตัวอย่าง" uploads the original image to
  `supplier-doc-examples` and inserts a `supplier_document_examples` row
  with the corrected JSON.
- Lists existing examples for that supplier (thumbnail or filename +
  saved date) with a ลบ button each.

**`src/pages/PurchaseOrders.jsx`** — the create-PO form gets a new
"📷 อัพโหลดจากใบส่งของ/ใบเสนอราคา" control, disabled until `form.supplier_id`
is set. On upload: calls `extract-po-document` with that supplier's saved
examples, then maps the response onto the form's existing item rows
(clearing/replacing the current line-item rows with the extracted ones)
and sets date/reference fields if guessed and not already filled by the
user. No new table needed here — this only ever populates the existing
`purchase_order_items` shape at save time, same as manual entry.

## Error handling

- Edge function returns `{ error: string }` on any failure (AI API error,
  non-JSON response, image too large/unsupported format) — the frontend
  shows a toast with that message and leaves the form exactly as it was
  (no partial pre-fill). Manual entry is always available; this feature
  never blocks PO creation.
- If the AI returns JSON that doesn't match the expected shape (missing
  `line_items`, wrong types), treat it the same as an error rather than
  rendering malformed data into the form.

## Testing

- Unit tests (`src/lib/*.test.js`) for the response-validation/shaping
  logic that turns the edge function's JSON into the form's line-item
  rows — cover missing fields, wrong types, empty `line_items`.
- No automated test can assert real extraction accuracy against an
  arbitrary photograph; verify that manually with the user's real
  documents (the sample image already in hand, plus at least one more
  supplier's format) before considering this done.
