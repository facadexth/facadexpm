# Monthly Document Limits — Design Draft

> **Status: DRAFT, not implemented.** Written overnight while the user was
> asleep, as a starting point for review — not approved, not built. Follows
> on from the seat/site quota work shipped 2026-08-29/30
> ([[project_tenant_management_page]]).

## Problem

The external pricing deck describes a monthly document-count limit for
lower tiers (e.g. "10 ใบเสนอราคา/เดือน" — 10 quotations/month on Free).
This was explicitly deferred when seat/site quotas shipped, flagged as
"a rolling time-window count, meaningfully harder" than a simple point-in-
time total. Having now built and hardened the seat/site system (including
finding and fixing two real bypasses — a promote-via-UPDATE gap and a
batch-INSERT aggregate-check gap, see [[project_tenant_management_page]]
Phase 3), the actual gap in difficulty turns out to be smaller than
expected: the same enforcement pattern applies, the only real new
question is calendar-month vs. rolling-window semantics.

## Recommendation: calendar month, not a rolling 30-day window

Reset on the 1st of each month (`date_trunc('month', created_at)`), not
"documents in the last 30 days from now." Reasons:
- Matches how people intuitively think about a monthly quota (and how
  `plan_expires_at`/trial concepts already work in this app).
- Simpler SQL: `WHERE tenant_id = X AND created_at >= date_trunc('month', now())`
  vs. a genuinely rolling window needing `created_at >= now() - interval '30 days'`
  — this part is actually *not* much harder either way, but calendar-month
  is the more standard SaaS convention and avoids "why did my count go down
  today" confusion a rolling window can cause.

## Which documents get limited

Recommend **quotations only**, matching the one concrete example in the
external deck, for the first pass. Do NOT extend to invoices/POs without a
real decision — those are downstream of an already-accepted quotation, and
capping them separately raises awkward questions (what happens when an
Ongoing project's site legitimately needs more invoices than the cap in a
busy month?). Quotations are the natural "top of funnel" thing to gate.

## Schema change

```sql
ALTER TABLE packages ADD COLUMN max_quotations_per_month INT; -- NULL = unlimited
UPDATE packages SET max_quotations_per_month = 10 WHERE name = 'Free';
-- Solo/Pro Team/Business/Enterprise: leave NULL (unlimited) unless the
-- pricing owner wants tighter limits on Solo too -- not in the deck excerpt
-- seen so far, needs confirming.
```

## Enforcement (mirrors the seat/site pattern exactly, including the
## lesson learned from the batch-insert bug)

```sql
CREATE OR REPLACE FUNCTION tenant_under_document_limit(p_kind TEXT)
RETURNS BOOLEAN
LANGUAGE plpgsql SECURITY DEFINER STABLE SET search_path = public
AS $$
DECLARE
  v_tenant_id UUID := current_tenant_id();
  v_limit NUMERIC;
  v_count NUMERIC;
BEGIN
  SELECT CASE p_kind
    WHEN 'quotations' THEN p.max_quotations_per_month
  END INTO v_limit
  FROM tenants t LEFT JOIN packages p ON p.id = t.package_id
  WHERE t.id = v_tenant_id;

  IF v_limit IS NULL THEN
    RETURN true;
  END IF;

  CASE p_kind
    WHEN 'quotations' THEN
      SELECT count(*) INTO v_count FROM quotations
      WHERE tenant_id = v_tenant_id AND created_at >= date_trunc('month', now());
  END CASE;

  RETURN v_count < v_limit;
END;
$$;

REVOKE EXECUTE ON FUNCTION tenant_under_document_limit(TEXT) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION tenant_under_document_limit(TEXT) TO authenticated;
```

Gate the existing `quotations` INSERT policy with
`AND tenant_under_document_limit('quotations')`, same as
`tenant_under_seat_limit` was ANDed into `sites`/`workers`/`user_roles`.

**Ship the statement-level trigger from day one this time**, don't
discover the batch-bypass the hard way again:

```sql
CREATE TRIGGER trg_document_limit_quotations AFTER INSERT ON quotations
  FOR EACH STATEMENT EXECUTE FUNCTION check_seat_limit_after_statement('quotations');
```

(Reuses the exact same `check_seat_limit_after_statement()` trigger
function from the seat-limits work — it just calls whichever
`tenant_under_*_limit(kind)` function matches; would need a small
generalization since it currently hardcodes calling
`tenant_under_seat_limit`, not a dispatch across both function names. Easy
fix, not a redesign.)

**Revisions don't count against the quota for free**, and this needs no
special-casing: `quotations.revision` is a counter bumped via UPDATE on
the same row (see `2026-08-22-07-quotation-revision-tracking.sql`), never
a new INSERT. The `count(*) ... WHERE created_at >= ...` filter naturally
only counts genuinely new quotations, not edits to existing ones.

## UI

Same pattern as the seat/site warnings: a `useDocumentQuotaStatus()`-style
hook (or extend `tenant_seat_status()` to also return a `quotations_this_month`
row) powering a pre-submit warning banner in `Quotations.jsx`'s create
flow, plus a friendlier error message than the raw RLS text on the actual
block.

## Open questions — need the user's answer before implementing

1. **Confirm 10/month is still the right Free-tier number** (deck-derived,
   never independently verified against real usage patterns).
2. **Should any other tier have a quotation cap**, or is Free the only one?
3. **What should the UI say when a tenant is blocked** — just "upgrade to
   continue," or something softer like "resets on the 1st"? This is a
   real UX/tone decision, not a technical one.
4. **Does a REJECTED or EXPIRED quotation still count** against the
   month's quota, or only ones that stay active? Recommend: still counts
   (it consumed a real "quotation slot" when created, matching how the
   seat/site limits count usage regardless of later status) — but this is
   a judgment call worth confirming, not something to silently assume.
