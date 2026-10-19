# Task 2 report
Status: DONE (not executed; per hard rule no DB calls).
Files: supabase/migrations/2026-10-20-07-customer-line-accounts.sql, supabase/tests/2026-10-20-07-customer-line-accounts.dryrun.sql
Rulings R1/R3 applied (basic_id last column; REVOKE then explicit GRANTs; (SELECT helper()) policies; extensions.gen_random_bytes).
Errors: not_allowed, site_not_found, site_has_no_client. Claim is service_role only; conditional UPDATE...RETURNING is the atomic claim.
Dry run: splice migration -06 at the `-- @@PREPEND_06@@` line; replace __OWNER_EMAIL__ / __TENANT_ID__. Covers (a)-(g) plus authenticated insufficient_privilege on claim.
Concerns: plpgsql functions use `#variable_conflict use_column` because OUT names clash with column names; code alphabet mapping uses byte % 31 (tiny modulo bias, acceptable for one-time 7-day codes); sites trigger generate_site_number overrides the test site_number (harmless). Dry run unexecuted; the clients INSERT assumes no other NOT NULL columns without defaults beyond schema.sql (client_type nullable). Concurrent different-code claims for the same line user could unique-violate and roll back that claim (fails safe).

## Fix round 1
- Claim UPDATE now requires i.site_id IS NOT NULL and the site (same tenant) still belongs to i.client_id; moved/deleted site => 'invalid'.
- Claim's clients name lookup filters tenant_id = p_tenant.
- Dry run: added (h) site moved to another client => invalid, no account rows; (i) site deleted => invalid. Inlined migration re-spliced from the migration file (identical). Unexecuted.
