-- site_financial_summary was taking 5-9s under RLS (vs ~150ms as a
-- non-RLS superuser) for tenants with a nontrivial number of quotations.
-- Root cause: the quotation_discount CTE (used only by the invoiced_amount
-- subquery) was being re-executed once PER outer row of the qiu/qi/q join
-- instead of computed once, because RLS's extra is_admin_or_owner()/
-- has_module_access() predicates confuse the planner's row-count estimates
-- for that join enough that it chooses a nested loop over materializing
-- the CTE. Verified via EXPLAIN ANALYZE as the authenticated role with a
-- real tenant's JWT claims: forcing materialization drops full-view
-- execution time from ~5.9s to ~1.2s, with no change in output.
--
-- Marking the CTE MATERIALIZED forces Postgres to compute it once and
-- reuse it, which is what a plain (non-RLS) query already did by default.
create or replace view public.site_financial_summary
with (security_invoker = true) as
with quotation_discount as materialized (
  select q.id as quotation_id,
    case
        when coalesce(q.discount_pct, 0) <> 0 then greatest(0, 1 - q.discount_pct / 100)
        when q.discount_amount is not null and coalesce(qt.raw_total, 0) > 0
            then greatest(0, (qt.raw_total - q.discount_amount) / qt.raw_total)
        else 1
    end as price_multiplier
  from quotations q
  left join (
    select quotation_items.quotation_id, sum(quotation_items.line_total) as raw_total
    from quotation_items
    group by quotation_items.quotation_id
  ) qt on qt.quotation_id = q.id
), worker_cost as (
  select labor_cost_by_site.site_id, sum(labor_cost_by_site.labor_cost) as labor_cost
  from labor_cost_by_site
  group by labor_cost_by_site.site_id
), worker_ot as (
  select ot_cost_by_site.site_id, sum(ot_cost_by_site.ot_cost) as ot_cost
  from ot_cost_by_site
  group by ot_cost_by_site.site_id
), subcontractor_cost as (
  select expenses.site_id, sum(expenses.amount) as subcontractor_labor_cost
  from expenses
  where expenses.is_subcontract = true
  group by expenses.site_id
), activity as (
  select all_dates.site_id, max(all_dates.last_date) as last_activity_date
  from (
    select expenses.site_id, max(expenses.date) as last_date
    from expenses
    group by expenses.site_id
    union all
    select incomes.site_id, max(incomes.date) as last_date
    from incomes
    where incomes.site_id is not null
    group by incomes.site_id
    union all
    select worker_assignments.site_id, max(worker_assignments.date) as last_date
    from worker_assignments
    group by worker_assignments.site_id
  ) all_dates
  group by all_dates.site_id
)
select
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
  c.name as client_display_name,
  c.client_number,
  coalesce(exp.total_expense, 0) + coalesce(wc.labor_cost, 0) + coalesce(wo.ot_cost, 0) as total_expense,
  coalesce(inc.total_income, 0) as total_income,
  coalesce(inc.total_income, 0) - (coalesce(exp.total_expense, 0) + coalesce(wc.labor_cost, 0) + coalesce(wo.ot_cost, 0)) as gross_profit,
  case when s.contract_value > 0 then round(coalesce(inc.total_income, 0) / s.contract_value * 100, 1) else null end as billing_pct,
  coalesce(exp.outstanding_expense, 0) as outstanding_expense,
  s.distance_km,
  s.map_url,
  c.contact_person as client_contact_person,
  c.phone as client_phone,
  s.has_vat,
  s.contract_value_no_vat,
  s.default_vat_pct,
  s.default_tax_withheld_pct,
  s.default_retention_pct,
  s.default_retention_period_days,
  s.default_deposit_pct,
  coalesce(inv.invoiced_amount, 0) as invoiced_amount,
  case when s.contract_value > 0 then round(coalesce(inv.invoiced_amount, 0) / s.contract_value * 100, 1) else null end as invoiced_pct,
  coalesce(wc.labor_cost, 0) + coalesce(wo.ot_cost, 0) as worker_labor_cost,
  coalesce(sc.subcontractor_labor_cost, 0) as subcontractor_labor_cost,
  s.lat,
  s.lng,
  act.last_activity_date
from sites s
left join clients c on s.client_id = c.id
left join (
  select expenses.site_id,
    sum(expenses.amount) as total_expense,
    sum(case when expenses.status = any (array['pending','check_issued']) then expenses.amount else 0 end) as outstanding_expense
  from expenses
  group by expenses.site_id
) exp on exp.site_id = s.id
left join (
  select incomes.site_id, sum(incomes.received_amount) as total_income
  from incomes
  group by incomes.site_id
) inc on inc.site_id = s.id
left join worker_cost wc on wc.site_id = s.id
left join worker_ot wo on wo.site_id = s.id
left join subcontractor_cost sc on sc.site_id = s.id
left join (
  select q.site_id,
    sum(qiu.cumulative_pct / 100 * qiu.unit_qty * qi.unit_price * coalesce(qd.price_multiplier, 1) *
        case when q.has_vat and not q.price_includes_vat then 1.07 else 1 end) as invoiced_amount
  from quotation_item_units qiu
  join quotation_items qi on qi.id = qiu.quotation_item_id
  join quotations q on q.id = qi.quotation_id
  left join quotation_discount qd on qd.quotation_id = q.id
  where q.site_id is not null
  group by q.site_id
) inv on inv.site_id = s.id
left join activity act on act.site_id = s.id;
