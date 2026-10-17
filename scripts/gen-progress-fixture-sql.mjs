#!/usr/bin/env node
// Prints plpgsql statements that load src/pages/sites/progressCalc.fixtures.json
// into fresh sites and assert node_progress / site_progress_pct for every case,
// plus the points the database gives each BOQ card (fixture weight_pts).
// Paste the output into the DO block of
// supabase/tests/2026-10-17-09-gantt-progress-data.test.sql. That block must
// declare: v_tenant uuid (the tenant to insert into), r jsonb (results),
// v_fx_bad int (mismatch counter, start at 0).
// Ids are md5('gpf|<case>|<fixture id>')::uuid, so the output is stable.
// Optional fixture fields default to: subtask_id/parent_task_id/issue_report_id
// null, progress_mode 'status', planned_qty null, done_qty 0, is_vo false,
// vo_value null (no phase_vo_values row, counts as 0), is_issue_phase false,
// parent_subtask_id null, boq_items [] (unit_value null = a manual line).
// Card points are never inserted: the database computes them (general cards 0,
// BOQ cards split by value), and each BOQ card's fixture weight_pts is asserted.
// A priced BOQ line gets a quotation item of the same quantity with
// line_total = unit_value x planned_qty, on one draft quotation per case.
// Usage: node scripts/gen-progress-fixture-sql.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const cases = JSON.parse(readFileSync(join(root, 'src/pages/sites/progressCalc.fixtures.json'), 'utf8'))

const lit = (v) => (v === null || v === undefined ? 'NULL'
  : typeof v === 'number' ? String(v)
  : typeof v === 'boolean' ? String(v)
  : `'${String(v).replace(/'/g, "''")}'`)

const out = []
cases.forEach((c, idx) => {
  const n = idx + 1
  const uid = (id) => (id === null || id === undefined ? 'NULL' : `md5('gpf|${n}|${id}')::uuid`)
  const slug = c.name.replace(/[^a-z0-9]+/gi, '_').toLowerCase()
  const key = (what, expected) => `fx${n}_${slug}_${what}_MUST${expected === null ? 'null' : expected}`
  const site = uid('site')

  out.push(`  -- fixture ${n}: ${c.name}`)
  out.push(`  INSERT INTO sites (id, tenant_id, site_number, name, contract_value) VALUES (${site}, v_tenant, 'GT-PF-${String(n).padStart(2, '0')}', ${lit('progress fixture: ' + c.name)}, ${lit(c.contract_value ?? 0)});`)
  // an empty PLAN first: deriving a split parent's status is gated until the site has a PLAN
  out.push(`  PERFORM snapshot_site_plan(${site}, 'progress fixture', true, 'system');`)
  c.phases.forEach((p, i) => {
    out.push(`  INSERT INTO site_phases (id, tenant_id, site_id, name, sort_order, billing_weight_pct, status, is_vo, is_issue_phase) VALUES (${uid(p.id)}, v_tenant, ${site}, ${lit(p.id)}, ${i + 1}, ${lit(p.billing_weight_pct ?? 0)}, ${lit(p.status ?? 'not_started')}, ${lit(p.is_vo ?? false)}, ${lit(p.is_issue_phase ?? false)});`)
    // vo_value is money: it lives in phase_vo_values (OWNER/ADMIN only), not on site_phases
    if (p.vo_value !== undefined && p.vo_value !== null) {
      out.push(`  INSERT INTO phase_vo_values (phase_id, tenant_id, vo_value) VALUES (${uid(p.id)}, v_tenant, ${lit(p.vo_value)});`)
    }
  })
  ;(c.subtasks || []).forEach((s, i) => {
    out.push(`  INSERT INTO phase_subtasks (id, tenant_id, site_id, phase_id, parent_subtask_id, name, sort_order, billing_weight_pct, status) VALUES (${uid(s.id)}, v_tenant, ${site}, ${uid(s.phase_id)}, ${uid(s.parent_subtask_id)}, ${lit(s.id)}, ${i + 1}, ${lit(s.billing_weight_pct ?? 0)}, ${lit(s.status ?? 'not_started')});`)
  })
  const lines = c.boq_items || []
  const quot = uid('quotation')
  if (lines.some((l) => l.unit_value != null)) {
    out.push(`  INSERT INTO quotations (id, tenant_id, client_id, site_id, date, status, quotation_number) VALUES (${quot}, v_tenant, (SELECT id FROM clients WHERE tenant_id = v_tenant ORDER BY created_at, id LIMIT 1), ${site}, current_date, 'draft', 'GT-PF-Q${String(n).padStart(2, '0')}');`)
  }
  lines.forEach((l, i) => {
    const qi = l.unit_value != null ? uid('qi|' + l.id) : 'NULL'
    if (l.unit_value != null) {
      out.push(`  INSERT INTO quotation_items (id, tenant_id, quotation_id, description, quantity, unit_price, line_total, sort_order) VALUES (${qi}, v_tenant, ${quot}, ${lit(l.id)}, ${lit(l.planned_qty)}, ${lit(l.unit_value)}, ${lit(l.unit_value * l.planned_qty)}, ${i + 1});`)
    }
    out.push(`  INSERT INTO boq_items (id, tenant_id, site_id, quotation_item_id, code, description, planned_qty, sort_order) VALUES (${uid(l.id)}, v_tenant, ${site}, ${qi}, ${lit(l.id)}, ${lit(l.id)}, ${lit(l.planned_qty)}, ${i + 1});`)
  })
  const reports = [...new Set((c.tasks || []).map((t) => t.issue_report_id).filter(Boolean))]
  reports.forEach((rid) => {
    out.push(`  INSERT INTO line_issue_reports (id, tenant_id, site_id, message) VALUES (${uid(rid)}, v_tenant, ${site}, ${lit('progress fixture issue ' + rid)});`)
  })
  ;(c.tasks || []).forEach((t, i) => {
    out.push(`  INSERT INTO phase_tasks (id, tenant_id, site_id, phase_id, subtask_id, parent_task_id, name, sort_order, status, progress_mode, planned_qty, done_qty, boq_item_id, issue_report_id) VALUES (${uid(t.id)}, v_tenant, ${site}, ${uid(t.phase_id)}, ${uid(t.subtask_id)}, ${uid(t.parent_task_id)}, ${lit(t.id)}, ${i + 1}, ${lit(t.status ?? 'not_started')}, ${lit(t.progress_mode ?? 'status')}, ${lit(t.planned_qty ?? null)}, ${lit(t.done_qty ?? 0)}, ${uid(t.boq_item_id)}, ${uid(t.issue_report_id)});`)
  })
  const check = (what, expr, expected) => {
    out.push(`  x := ${expr};`)
    out.push(`  r := r || jsonb_build_object('${key(what, expected)}', x);`)
    out.push(`  IF x IS DISTINCT FROM ${expected === null ? 'NULL' : `${expected}::numeric`} THEN v_fx_bad := v_fx_bad + 1; END IF;`)
  }
  ;(c.tasks || []).filter((t) => t.progress_mode === 'quantity').forEach((t) => {
    check(`pts_${t.id}`, `(SELECT weight_pts FROM phase_tasks WHERE id = ${uid(t.id)})`, t.weight_pts)
  })
  Object.entries(c.expect.phases).forEach(([pid, pct]) => {
    check(`phase_${pid}`, `round(node_progress(${uid(pid)}) * 100, 2)`, pct)
  })
  check('contract', `(SELECT contract_pct FROM site_progress_pct(${site}))`, c.expect.contract_pct)
  check('total', `(SELECT total_pct FROM site_progress_pct(${site}))`, c.expect.total_pct ?? null)
})
console.log(out.join('\n'))
