-- Deposit deduction chosen when the invoice is created.
-- NULL  = legacy invoice (or created while the deposit box was hidden): the deduction is still worked out at payment time
--         from the site's default % and the remaining deposit balance, exactly as before.
-- value = the pre-VAT amount to deduct for THIS invoice (0 = deliberately none). Payment time uses it as the starting
--         value, still capped at the remaining deposit balance on the day the money arrives.
-- deposit_deduction_pct is for display only (amount / subtotal * 100).
-- Tables only: no view selects invoices.* by column list that needs refreshing.
ALTER TABLE public.invoices
  ADD COLUMN IF NOT EXISTS deposit_deduction_amount numeric(14,2),
  ADD COLUMN IF NOT EXISTS deposit_deduction_pct numeric(7,2);

DO $$ BEGIN
  ALTER TABLE public.invoices ADD CONSTRAINT invoices_deposit_deduction_nonneg
    CHECK (deposit_deduction_amount IS NULL OR deposit_deduction_amount >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
