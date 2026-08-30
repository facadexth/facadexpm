-- supabase/migrations/2026-08-30-09-payment-intents-target-expiry.sql
-- Proration: the target plan_expires_at to apply on a successful payment
-- is computed once at omise-create-charge time (fresh subscription = now
-- + 1 month; upgrade mid-cycle = preserve the existing expiry, since the
-- charge amount was already discounted for the unused portion) and
-- stored here, so omise-webhook (and the zero-cost activation path in
-- omise-create-charge itself) just apply exactly what was decided rather
-- than recomputing/guessing later.
ALTER TABLE payment_intents ADD COLUMN target_plan_expires_at TIMESTAMPTZ;
