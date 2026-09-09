-- supabase/migrations/2026-09-09-05-document-receipts-signer-email.sql
-- Remote signing (PublicSignPage / sign-link Edge Function) can now
-- optionally email the client a copy confirmation of what they signed
-- (via Resend, same pattern as subscription_receipts' payment-receipt
-- email in _shared/activate-tenant.ts). signer_email is what the client
-- typed on the sign form; email_sent_at/email_error mirror
-- subscription_receipts' own tracking columns so a failed send is
-- visible without needing log access.
ALTER TABLE document_receipts ADD COLUMN signer_email TEXT;
ALTER TABLE document_receipts ADD COLUMN email_sent_at TIMESTAMPTZ;
ALTER TABLE document_receipts ADD COLUMN email_error TEXT;
