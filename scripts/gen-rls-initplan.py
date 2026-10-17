"""Generate ALTER POLICY statements that wrap per-request functions in (SELECT ...).

Postgres then evaluates each function once per query (an InitPlan) instead of once
per row. Only functions whose answer cannot depend on the row are wrapped: no
arguments, or literal arguments only. Usage: python3 gen-rls-initplan.py policies.json
(policies.json = json_agg of pg_policies rows with t/p quoted, cmd, q, w)."""
import json, re, sys

NOARG = r'(?:current_tenant_id|is_admin_or_owner|tenant_can_write|is_owner|my_worker_id|auth\.email|auth\.uid|auth\.jwt)\(\)'
LITERAL = r"(?:has_module_access\('[^']*'::text\)|tenant_under_seat_limit\('[^']*'::text, (?:true|false)\))"
PAT = re.compile(r'(?<![\w.])(?<!SELECT )(' + NOARG + '|' + LITERAL + ')')

def wrap(expr):
    return PAT.sub(lambda m: '(SELECT ' + m.group(1) + ')', expr) if expr else expr

out = []
for r in json.load(open(sys.argv[1])):
    q, w = wrap(r['q']), wrap(r['w'])
    if q == r['q'] and w == r['w']:
        continue
    s = f"ALTER POLICY {r['p']} ON public.{r['t']}"
    if r['q'] is not None: s += f"\n  USING ({q})"
    if r['w'] is not None: s += f"\n  WITH CHECK ({w})"
    out.append(s + ';')
print('\n\n'.join(out))
print(f'-- {len(out)} policies', file=sys.stderr)
