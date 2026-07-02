-- Assign redesign: expose distance_km + map_url through site_financial_summary
-- (Sites table/edit form read this view.) Applied 2026-07-02.
-- New columns appended at the end so CREATE OR REPLACE VIEW is allowed.

CREATE OR REPLACE VIEW site_financial_summary AS
SELECT s.id, s.site_number, s.name, s.status, s.start_date, s.end_date,
    s.contract_value, s.client_id, s.client_name, s.location,
    s.cost_aluminum, s.cost_glass, s.cost_equipment, s.cost_rubber, s.cost_labor, s.cost_other,
    c.name AS client_display_name, c.client_number,
    COALESCE(sum(e.amount), 0::numeric) AS total_expense,
    COALESCE(sum(i.received_amount), 0::numeric) AS total_income,
    COALESCE(sum(i.received_amount), 0::numeric) - COALESCE(sum(e.amount), 0::numeric) AS gross_profit,
    CASE WHEN s.contract_value > 0::numeric
         THEN round(COALESCE(sum(i.received_amount), 0::numeric) / s.contract_value * 100::numeric, 1)
         ELSE NULL::numeric END AS billing_pct,
    COALESCE(sum(CASE WHEN e.status = ANY (ARRAY['pending'::text, 'check_issued'::text]) THEN e.amount ELSE 0::numeric END), 0::numeric) AS outstanding_expense,
    s.distance_km,
    s.map_url
   FROM sites s
     LEFT JOIN clients c ON s.client_id = c.id
     LEFT JOIN expenses e ON e.site_id = s.id
     LEFT JOIN incomes i ON i.site_id = s.id
  GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value,
           s.client_id, s.client_name, s.location, s.cost_aluminum, s.cost_glass, s.cost_equipment,
           s.cost_rubber, s.cost_labor, s.cost_other, c.name, c.client_number, s.distance_km, s.map_url;
