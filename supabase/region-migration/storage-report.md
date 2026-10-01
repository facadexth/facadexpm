# Storage Migration Report — Tokyo → CHANG

Task 3 of the Supabase region migration dry run. Migrated storage buckets,
`storage.objects` RLS policies, and all real objects from Tokyo
(`yyzbgdmgyvvypfcjuhtr`, ap-northeast-1, production, read-only source) to
CHANG (`kntspldhvcjeaubtqtkn`, ap-southeast-1 Singapore, disposable dry-run
target).

## Buckets

9 buckets recreated on CHANG from `create-buckets-chang.sql`, matching
Tokyo exactly: all 9 have `file_size_limit = NULL` and
`allowed_mime_types = NULL` (no restrictions), only `tenant-logos` is
`public = true`.

| bucket | public | file_size_limit | allowed_mime_types |
|---|---|---|---|
| document-receipts | false | null | null |
| invoice-photos | false | null | null |
| line-site-photos | false | null | null |
| po-attachments | false | null | null |
| site-attachments | false | null | null |
| supplier-doc-examples | false | null | null |
| tenant-logos | **true** | null | null |
| user-signatures | false | null | null |
| worker-id-cards | false | null | null |

## RLS policies on `storage.objects`

Generated from Tokyo's live `pg_policies` catalog (not migration replay),
via `generate-storage-policies.sql`. 11 policies, one per bucket except
`line-site-photos` (3: separate SELECT/INSERT/DELETE policies for
role-gated upload behavior).

**Note on a generation-query bug found and fixed during this task:** the
original generation query did `COALESCE(qual, 'true')` unconditionally,
which manufactures an illegal `USING (true)` clause on `line_site_photos_uploads`
(an INSERT-only policy — Postgres only allows `WITH CHECK` on INSERT
policies, and Tokyo correctly stores `qual IS NULL` for it). The query was
corrected to guard the `USING` clause on `cmd != 'INSERT'`. The corrected
version is what's committed in `generate-storage-policies.sql`.

| | Tokyo | CHANG |
|---|---|---|
| Policy count on `storage.objects` | 11 | 11 |

Parity confirmed. Spot-checked `line_site_photos_uploads` specifically on
both projects: `cmd = INSERT`, `qual IS NULL` (no USING clause), `with_check
IS NOT NULL` — identical semantics on both.

## Objects — count/size parity per bucket

**Note on reference figures:** the plan's original reference numbers (115
objects total) were a point-in-time snapshot taken when the plan was
written. Tokyo is live production and kept accumulating real data in the
interim — specifically `line-site-photos` grew from 19 to 40 objects (the
group-photo auto-filing LINE feature shipped and real workers have been
using it since). Per the controller's ruling, this task migrated Tokyo's
**current live state at time of copy** (149 objects), not the stale 115
figure — "more real data migrated correctly is strictly fine for this dry
run's purpose." Live Tokyo counts were re-verified immediately before
copying and again immediately after, with no further drift observed during
the run.

| bucket | Tokyo (live, at copy) | CHANG (post-copy) | Match |
|---|---|---|---|
| document-receipts | 29 / 376 kB | 29 / 376 kB | ✅ |
| invoice-photos | 48 / 5546 kB | 48 / 5546 kB | ✅ |
| line-site-photos | 40 / 5744 kB | 40 / 5744 kB | ✅ (was 19/2950KB in the plan's stale snapshot — organic growth, not drift to be suspicious of) |
| po-attachments | 15 / 1458 kB | 15 / 1458 kB | ✅ |
| site-attachments | 4 / 1921 kB | 4 / 1921 kB | ✅ |
| supplier-doc-examples | 5 / 896 kB | 5 / 896 kB | ✅ |
| tenant-logos | 2 / 13 kB | 2 / 13 kB | ✅ |
| user-signatures | 6 / 62 kB | 6 / 62 kB | ✅ |
| **Total** | **149 objects** | **149 objects** | ✅ |
| worker-id-cards | 0 (empty, skipped per brief) | 0 | ✅ |

All 8 populated buckets: exact object-count and byte-size parity between
Tokyo's live state at time of copy and CHANG post-copy. `worker-id-cards`
bucket created but intentionally left empty (matches Tokyo).

## Full evidence trail

See `task-3-report.md` in the plan's SDD folder
(`.superpowers/sdd/2026-10-01-supabase-region-migration-dry-run-plan/task-3-report.md`)
for the complete command-by-command transcript, including the original
Step 5 failure, the controller's corrected query, and the live-drift
investigation.
