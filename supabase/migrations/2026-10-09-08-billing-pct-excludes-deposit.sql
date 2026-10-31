-- % เบิก (billing_pct) must not count the deposit as a billing. Before: Σ received_amount of EVERY income, so a site that
-- had only collected its deposit already showed e.g. 29.2% (SOAP OPERA, deposit 81,338.40 / contract 278,949).
-- Now: Σ (received_amount + deposit_deduction) over incomes whose type is not 'มัดจำ'.
--   * the deposit receipt itself is excluded;
--   * the deposit that a progress invoice applied (deposit_deduction) is added back, otherwise a fully billed site
--     would stall around 70% because that slice of the work was paid by the deposit, not by cash on that invoice.
-- Only the billing_pct expression changes; every other column, the security_invoker option and the grants are untouched
-- (CREATE OR REPLACE keeps them). total_income (the "รายรับ" figure) is unchanged.
CREATE OR REPLACE VIEW public.site_financial_summary WITH (security_invoker = true) AS
 WITH quotation_discount AS MATERIALIZED (
         SELECT q.id AS quotation_id,
                CASE
                    WHEN COALESCE(q.discount_pct, 0::numeric) <> 0::numeric THEN GREATEST(0::numeric, 1::numeric - q.discount_pct / 100::numeric)
                    WHEN q.discount_amount IS NOT NULL AND COALESCE(qt.raw_total, 0::numeric) > 0::numeric THEN GREATEST(0::numeric, (qt.raw_total - q.discount_amount) / qt.raw_total)
                    ELSE 1::numeric
                END AS price_multiplier
           FROM quotations q
             LEFT JOIN ( SELECT quotation_items.quotation_id,
                    sum(quotation_items.line_total) AS raw_total
                   FROM quotation_items
                  GROUP BY quotation_items.quotation_id) qt ON qt.quotation_id = q.id
        ), worker_cost AS (
         SELECT labor_cost_by_site.site_id,
            sum(labor_cost_by_site.labor_cost) AS labor_cost
           FROM labor_cost_by_site
          GROUP BY labor_cost_by_site.site_id
        ), worker_ot AS (
         SELECT ot_cost_by_site.site_id,
            sum(ot_cost_by_site.ot_cost) AS ot_cost
           FROM ot_cost_by_site
          GROUP BY ot_cost_by_site.site_id
        ), subcontractor_cost AS (
         SELECT expenses.site_id,
            sum(expenses.amount) AS subcontractor_labor_cost
           FROM expenses
          WHERE expenses.is_subcontract = true
          GROUP BY expenses.site_id
        ), activity AS (
         SELECT all_dates.site_id,
            max(all_dates.last_date) AS last_activity_date
           FROM ( SELECT expenses.site_id,
                    max(expenses.date) AS last_date
                   FROM expenses
                  GROUP BY expenses.site_id
                UNION ALL
                 SELECT incomes.site_id,
                    max(incomes.date) AS last_date
                   FROM incomes
                  WHERE incomes.site_id IS NOT NULL
                  GROUP BY incomes.site_id
                UNION ALL
                 SELECT worker_assignments.site_id,
                    max(worker_assignments.date) AS last_date
                   FROM worker_assignments
                  GROUP BY worker_assignments.site_id) all_dates
          GROUP BY all_dates.site_id
        )
 SELECT s.id,
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
    COALESCE(exp.total_expense, 0::numeric) + COALESCE(wc.labor_cost, 0::numeric) + COALESCE(wo.ot_cost, 0::numeric) AS total_expense,
    COALESCE(inc.total_income, 0::numeric) AS total_income,
    COALESCE(inc.total_income, 0::numeric) - (COALESCE(exp.total_expense, 0::numeric) + COALESCE(wc.labor_cost, 0::numeric) + COALESCE(wo.ot_cost, 0::numeric)) AS gross_profit,
        CASE
            WHEN s.contract_value > 0::numeric THEN round(COALESCE(bil.billed_amount, 0::numeric) / s.contract_value * 100::numeric, 1)
            ELSE NULL::numeric
        END AS billing_pct,
    COALESCE(exp.outstanding_expense, 0::numeric) AS outstanding_expense,
    s.distance_km,
    s.map_url,
    c.contact_person AS client_contact_person,
    c.phone AS client_phone,
    s.has_vat,
    s.contract_value_no_vat,
    s.default_vat_pct,
    s.default_tax_withheld_pct,
    s.default_retention_pct,
    s.default_retention_period_days,
    s.default_deposit_pct,
    COALESCE(inv.invoiced_amount, 0::numeric) AS invoiced_amount,
        CASE
            WHEN s.contract_value > 0::numeric THEN round(COALESCE(inv.invoiced_amount, 0::numeric) / s.contract_value * 100::numeric, 1)
            ELSE NULL::numeric
        END AS invoiced_pct,
    COALESCE(wc.labor_cost, 0::numeric) + COALESCE(wo.ot_cost, 0::numeric) AS worker_labor_cost,
    COALESCE(sc.subcontractor_labor_cost, 0::numeric) AS subcontractor_labor_cost,
    s.lat,
    s.lng,
    act.last_activity_date
   FROM sites s
     LEFT JOIN clients c ON s.client_id = c.id
     LEFT JOIN ( SELECT expenses.site_id,
            sum(expenses.amount) AS total_expense,
            sum(
                CASE
                    WHEN expenses.status = ANY (ARRAY['pending'::text, 'check_issued'::text]) THEN expenses.amount
                    ELSE 0::numeric
                END) AS outstanding_expense
           FROM expenses
          GROUP BY expenses.site_id) exp ON exp.site_id = s.id
     LEFT JOIN ( SELECT incomes.site_id,
            sum(incomes.received_amount) AS total_income
           FROM incomes
          GROUP BY incomes.site_id) inc ON inc.site_id = s.id
     LEFT JOIN ( SELECT incomes.site_id,
            sum(incomes.received_amount + COALESCE(incomes.deposit_deduction, 0::numeric)) AS billed_amount
           FROM incomes
          WHERE incomes.income_type IS DISTINCT FROM 'มัดจำ'::text
          GROUP BY incomes.site_id) bil ON bil.site_id = s.id
     LEFT JOIN worker_cost wc ON wc.site_id = s.id
     LEFT JOIN worker_ot wo ON wo.site_id = s.id
     LEFT JOIN subcontractor_cost sc ON sc.site_id = s.id
     LEFT JOIN ( SELECT q.site_id,
            sum(qiu.cumulative_pct / 100::numeric * qiu.unit_qty * qi.unit_price * COALESCE(qd.price_multiplier, 1::numeric) *
                CASE
                    WHEN q.has_vat AND NOT q.price_includes_vat THEN 1.07
                    ELSE 1::numeric
                END) AS invoiced_amount
           FROM quotation_item_units qiu
             JOIN quotation_items qi ON qi.id = qiu.quotation_item_id
             JOIN quotations q ON q.id = qi.quotation_id
             LEFT JOIN quotation_discount qd ON qd.quotation_id = q.id
          WHERE q.site_id IS NOT NULL
          GROUP BY q.site_id) inv ON inv.site_id = s.id
     LEFT JOIN activity act ON act.site_id = s.id;

CREATE OR REPLACE VIEW public.sites_progress WITH (security_invoker = true) AS
 SELECT s.id,
    s.site_number,
    s.name,
    s.status,
    s.start_date,
    s.end_date,
        CASE
            WHEN s.contract_value > 0::numeric THEN round(COALESCE(sum(i.received_amount + COALESCE(i.deposit_deduction, 0::numeric)), 0::numeric) / s.contract_value * 100::numeric, 1)
            ELSE NULL::numeric
        END AS billing_pct
   FROM sites s
     LEFT JOIN incomes i ON i.site_id = s.id AND i.income_type IS DISTINCT FROM 'มัดจำ'::text
  GROUP BY s.id, s.site_number, s.name, s.status, s.start_date, s.end_date, s.contract_value;
