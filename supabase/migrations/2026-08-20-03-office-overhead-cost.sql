-- Overhead cost tracking: a worker assigned type='office' contributes zero
-- cost anywhere in the app today (labor_cost_by_site only counts
-- site/factory). These two columns let HR's payroll calc attribute a
-- cost-informational figure to office days, mirroring labor_cost_by_site's
-- own formula (monthly_salary / 26 * days). NUMERIC (not INT) because days
-- are counted in 0.5 increments (one shift = 0.5 day), matching how
-- leave_sick/leave_personal are already counted in handleCalcFromAssign.
--
-- This is purely informational -- it must never be added to or subtracted
-- from net_pay, and must never be written to the expenses table.
ALTER TABLE salary_records ADD COLUMN office_days NUMERIC DEFAULT 0;
ALTER TABLE salary_records ADD COLUMN office_cost NUMERIC DEFAULT 0;
