# Row-Count Verification Report: Tokyo → CHANG

Date: 2026-10-01. Tokyo = `yyzbgdmgyvvypfcjuhtr` (ap-northeast-1, live production,
read-only throughout). CHANG = `kntspldhvcjeaubtqtkn` (ap-southeast-1, disposable
dry-run target).

## Table count match: PASS

109 tables total in `public`+`auth` on both sides (82 `public` + 27 `auth`). Zero
tables present on one side only (`comm -3`-equivalent set diff on the two
`pg_stat_user_tables` snapshots: `only_tokyo = []`, `only_chang = []`).

## Row-count match: PASS (2 discrepancies, both explained, not migration defects)

Ran `verify-row-counts.sql` against CHANG then against Tokyo (full
`pg_stat_user_tables` snapshot, `schemaname IN ('public','auth')`), compared
table-by-table:

- **107 / 109 tables: exact match** on `n_live_tup`.
- **2 tables differed**, both cross-checked with an exact `SELECT COUNT(*)` per the
  brief's caveat about `n_live_tup` being a live estimate — in both cases the
  estimate was already exact, and the live/dump-snapshot gap was a real but
  *expected* difference, not an estimation artifact or a restore defect:

  | table | Tokyo (now) | CHANG (dump snapshot) | diff | cause |
  |---|---|---|---|---|
  | `auth.refresh_tokens` | 294 | 293 | 1 | 1 new session token issued on live Tokyo after the dump was taken |
  | `public.line_site_photos` | 40 | 34 | 6 | 6 new photos uploaded via LINE bot on live Tokyo after the dump was taken |

  Verified this directly rather than assuming: CHANG's `max(created_at)` for each
  table (`auth.refresh_tokens`: `2026-10-01 14:11:41.704479+00`;
  `public.line_site_photos`: `2026-10-01 11:42:26.498039+00`) marks the effective
  dump snapshot time. Counting Tokyo rows with `created_at` *after* that exact
  timestamp returns **exactly 1** and **exactly 6** respectively — matching the
  diffs precisely. This confirms both are organic writes to live production that
  happened during this session's work, after the one-time dump snapshot was taken,
  not rows the migration failed to carry over. Since Tokyo is explicitly a live,
  actively-used production system and this is a one-time dry-run snapshot (not an
  ongoing sync), this is the expected behavior, not a defect.

## `auth.users` count: 14 / 14 — PASS

```
Tokyo: SELECT count(*) FROM auth.users;  -> 14
CHANG: SELECT count(*) FROM auth.users;  -> 14
```
Matches the plan's stated expectation exactly.

## 3-row spot-check: PASS, 100% column match

Picked 3 real rows from Tokyo (one each from `sites`, `workers`, `invoices`), pulled
the identical row by `id` from both Tokyo and CHANG, and diffed every column:

| table | id | columns compared | differences |
|---|---|---|---|
| `public.sites` | `16b50c81-d9fb-417b-970e-24055177725c` (MFPK) | 35 | 0 |
| `public.workers` | `ebfb0aba-7d61-4227-8f3e-8c7d4ae027d7` (นาย จุมพล ศรีเมือง) | 21 | 0 |
| `public.invoices` | `564b1203-ffb4-4b63-a362-7d467a34c9a4` (IN2609-020) | 21 | 0 |

Zero differences on any column, including timestamps, JSON/jsonb fields, numeric
fields, and foreign-key columns.

Raw evidence (added in Fix Round 3, since the original pass didn't save any):
the 6 raw `SELECT *` JSON results (`supabase/region-migration/tmp/spotcheck-{tokyo,chang}-{site,worker,invoice}.json`)
and the generated column-by-column diff
(`supabase/region-migration/tmp/spotcheck-diff-report.txt`) — gitignored (under
`supabase/region-migration/tmp/`) but present on disk for audit.

## Restore methodology (summary — full detail in task-2-report.md)

The brief's literal single-file "schema + data combined" dump/restore did not work
as-is on this Supabase platform and required three adaptations, each verified with
an independent integrity check before trusting it:

1. **Schema vs. data are separate dumps.** `supabase db dump` without `--data-only`
   is schema-only (no CLI flag produces a true combined dump); a second
   `--data-only` dump (plain `INSERT` format, not `--use-copy`, since `db query
   --file` cannot run `COPY FROM stdin`) was required to get the 14021 real data rows.
2. **`auth`-schema DDL cannot be replayed** — the `postgres` role is structurally
   denied `CREATE` on the `auth` schema platform-wide (confirmed via
   `has_schema_privilege`); CHANG's `auth` schema is already correctly
   platform-provisioned (27 tables, matching Tokyo's count) at project creation, so
   only `auth`-schema *data* needed restoring, not DDL. `INSERT` into the existing
   `auth` tables is permitted for `postgres` (tested, confirmed with `auth-data-only.sql`).
3. **Management API payload-size limit (HTTP 413) above ~5.6MB.** Restored
   `public-data-only.sql` as six ~1MB chunks instead of one file. Integrity verified
   two ways: (a) summed row-tuple counts across all 6 chunk files before restoring
   (13609, matching the unchunked file's count exactly) and (b) summed actual
   `n_live_tup` across all `public` tables on CHANG after all 6 chunks were applied
   (13609, exact match again).

A statement-aware SQL tokenizer (handling `'...'` strings, `"..."` identifiers,
`$$...$$`/`$_$..._$` dollar-quoted function bodies, and `--` line comments) was
written to perform the public/auth split and the size-based chunking without ever
splitting a statement mid-way — verified by re-parsing each output and confirming
zero cross-schema leakage and exact row-tuple-count conservation at every step.

## Files produced (gitignored, not committed — regenerable from Tokyo via the dump commands in task-2-report.md)

- `full-dump.sql`, `full-dump-cleaned.sql` — Tokyo schema dump (OWNER TO stripped)
- `full-data-dump.sql` — Tokyo data dump, INSERT format
- `public-schema-only.sql` — public-only DDL, restored to CHANG
- `public-data-only.sql` — public-only data (unchunked reference copy)
- `public-data-chunk-01.sql` … `public-data-chunk-06.sql` — the actual restored chunks
- `auth-data-only.sql` — auth-only data, restored to CHANG

## Conclusion

CHANG's `public` and `auth` schemas are schema-identical to Tokyo (109/109 tables)
and data-identical as of the dump snapshot (13609 public rows + 412 auth rows,
matching exactly; the 2 live-production rows Tokyo gained afterward are expected
drift on a live system, not a gap). 3/3 spot-checked rows match on every column.
Ready for Task 6's final verification pass.
