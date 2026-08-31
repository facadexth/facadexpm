-- supabase/migrations/2026-09-02-06-extend-document-receipts-to-quotation-invoice.sql
-- Remote signing (2026-09-02-01/02) was v1'd cheque-only. Widening both
-- document_type CHECK constraints to also allow 'quotation' and 'invoice'
-- -- everything else (document_receipts table, document_receipt_links
-- table, storage bucket/policies, sign-link Edge Function's generic
-- linkId-driven flow) was already built generic over document_type and
-- needs no schema change.
ALTER TABLE document_receipts DROP CONSTRAINT document_receipts_document_type_check;
ALTER TABLE document_receipts ADD CONSTRAINT document_receipts_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice'));

ALTER TABLE document_receipt_links DROP CONSTRAINT document_receipt_links_document_type_check;
ALTER TABLE document_receipt_links ADD CONSTRAINT document_receipt_links_document_type_check
  CHECK (document_type IN ('cheque', 'quotation', 'invoice'));
