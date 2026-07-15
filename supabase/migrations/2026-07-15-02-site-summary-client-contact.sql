-- Expose the linked client's contact_person/phone on site_financial_summary,
-- so the Assign page's "copy for LINE" export can include the site contact
-- without a separate clients fetch. Appended at the end (CREATE OR REPLACE
-- VIEW can't reorder/rename existing columns, only add new ones).
CREATE OR REPLACE VIEW site_financial_summary AS
SELECT
  s.id,
  s.site_number,
  s.name,
  s.status,
  s.start_date,
  s.end_date,
  s.contract_value,
  s.client_id,
  s.client_name,
  s.location,
  s.cost_aluminum,
  s.cost_glass,
  s.cost_equipment,
  s.cost_rubber,
  s.cost_labor,
  s.cost_other,
  c.name AS client_display_name,
  c.client_number,
  COALESCE(SUM(e.amount), 0)          AS total_expense,
  COALESCE(SUM(i.received_amount), 0) AS total_income,
  COALESCE(SUM(i.received_amount), 0) - COALESCE(SUM(e.amount), 0) AS gross_profit,
  CASE WHEN s.contract_value > 0
    THEN ROUND(COALESCE(SUM(i.received_amount), 0) / s.contract_value * 100, 1)
    ELSE NULL
  END AS billing_pct,
  COALESCE(SUM(CASE WHEN e.status IN ('pending','check_issued') THEN e.amount ELSE 0 END), 0) AS outstanding_expense,
  s.distance_km,
  s.map_url,
  c.contact_person AS client_contact_person,
  c.phone          AS client_phone
FROM sites s
LEFT JOIN clients c ON s.client_id = c.id
LEFT JOIN expenses e ON e.site_id = s.id
LEFT JOIN incomes i ON i.site_id = s.id
GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
  s.client_id, s.client_name, s.location, s.cost_aluminum, s.cost_glass, s.cost_equipment,
  s.cost_rubber, s.cost_labor, s.cost_other, c.name, c.client_number, s.distance_km, s.map_url,
  c.contact_person, c.phone;
