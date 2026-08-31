-- supabase/migrations/2026-09-01-04-cheque-shared-check-date.sql
-- The cheque date is a property of the physical cheque, not of any one
-- expense it pays -- every expense linked to the same cheque must show
-- the same check_date. cheques.check_date is now the single source;
-- expenses.check_date stays as the column payment_forecast/
-- expenseFilters already read (no changes needed there), but is kept in
-- sync automatically: linking an expense to a cheque pulls the cheque's
-- date onto it, and editing a cheque's date cascades to every expense
-- already linked to it.
ALTER TABLE cheques ADD COLUMN check_date DATE;

CREATE OR REPLACE FUNCTION cheque_cascade_check_date()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
BEGIN
  IF NEW.check_date IS DISTINCT FROM OLD.check_date THEN
    UPDATE expenses SET check_date = NEW.check_date WHERE cheque_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_cheque_cascade_check_date
  AFTER UPDATE OF check_date ON cheques
  FOR EACH ROW
  EXECUTE FUNCTION cheque_cascade_check_date();

CREATE OR REPLACE FUNCTION expense_sync_check_date_from_cheque()
RETURNS TRIGGER
LANGUAGE plpgsql SET search_path = public
AS $$
DECLARE
  v_cheque_date DATE;
BEGIN
  IF NEW.cheque_id IS NOT NULL AND (TG_OP = 'INSERT' OR NEW.cheque_id IS DISTINCT FROM OLD.cheque_id) THEN
    SELECT check_date INTO v_cheque_date FROM cheques WHERE id = NEW.cheque_id;
    NEW.check_date := v_cheque_date;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER trg_expense_sync_check_date
  BEFORE INSERT OR UPDATE OF cheque_id ON expenses
  FOR EACH ROW
  EXECUTE FUNCTION expense_sync_check_date_from_cheque();
