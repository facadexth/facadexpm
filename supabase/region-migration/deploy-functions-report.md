# Task 4: Edge Function Redeploy to CHANG — Report

Target: CHANG (Singapore, `kntspldhvcjeaubtqtkn`). Source: this repo's
`supabase/functions/`, unmodified — no code changes were made as part of
this task.

## Result summary

**12 of 14 functions deployed successfully.** 2 failed to bundle
(`omise-webhook`, `omise-create-charge`) due to a pre-existing broken
import path in the repo, unrelated to the region migration (details below).
All 12 successful deploys show `status: ACTIVE` with `verify_jwt` matching
the brief's spec exactly.

## Step 1: Confirm CHANG is linked — skipped (per task instructions)

The task's constraint #1 states `functions deploy`/`functions list` use
`--project-ref` standalone and do not depend on the CLI's `--linked` state,
and constraint #4 says not to run any `db query`/`db dump` commands in this
task. The brief's Step 1 (`npx supabase db query --linked "SELECT
version();"`) was therefore skipped as both unnecessary and out of scope —
every command below passed `--project-ref kntspldhvcjeaubtqtkn` explicitly.

## Step 2: Deploy all 14 functions

### `verify_jwt: false` (4 functions)

| Function | Result |
|---|---|
| `omise-webhook` | **FAILED** — see Root Cause below |
| `sign-link` | Success |
| `line-webhook` | Success |
| `field-form` | Success |

### `verify_jwt: true` (10 functions)

| Function | Result |
|---|---|
| `omise-create-charge` | **FAILED** — see Root Cause below |
| `extract-po-document` | Success |
| `line-push-daily-assignments` | Success |
| `line-push-quotation-followups` | Success |
| `line-push-cheque-reminders` | Success |
| `line-push-invoice-due` | Success |
| `line-worker-offboarded` | Success |
| `line-test-group` | Success |
| `leave-notify` | Success |
| `extract-map-coordinates` | Success |

### Root cause of the 2 failures

`supabase/functions/omise-webhook/index.ts` and
`supabase/functions/omise-create-charge/index.ts` both import:

```ts
import { activateTenantFromIntent } from './_shared/activate-tenant.ts'
```

i.e. a **function-local** `_shared/activate-tenant.ts`, one level below
where every other function's shared code lives. All other functions in the
repo correctly import from the project-level shared folder one level
*above* their own directory, e.g.:

```ts
import { sendLinePush, LINE_CHANNEL_ACCESS_TOKEN } from '../_shared/line.ts'
```

`git ls-files supabase/functions/omise-webhook/` and
`git ls-files supabase/functions/omise-create-charge/` each return only
`index.ts` — no `_shared/` subfolder has ever been committed under either
function's directory, for either function's full git history. The deploy
to CHANG failed with:

```
Failed to bundle the function (reason: Module not found
"file:///.../source/supabase/functions/omise-webhook/_shared/activate-tenant.ts"
at .../omise-webhook/index.ts:14:42).
```

(identical shape for `omise-create-charge:26:42`, pointing at its own
missing `_shared/activate-tenant.ts`).

This is a **pre-existing bug in committed source, not a migration
regression**. Supporting evidence from `npx supabase functions list
--project-ref yyzbgdmgyvvypfcjuhtr` (Tokyo, for comparison only — read-only,
no changes made there): Tokyo's current `omise-webhook` and
`omise-create-charge` entries show `entrypoint_path` ending in
`.../source/index.ts`, while every correctly-structured function (e.g.
`line-webhook`) shows `.../source/supabase/functions/line-webhook/index.ts`.
This indicates Tokyo's live versions of these two functions were deployed
at some point via a different invocation (flattened/legacy bundling from
inside the function's own directory) that must have had a local, uncommitted
copy of `_shared/activate-tenant.ts` present on disk at deploy time — it was
never checked into git, so it isn't present in this worktree and can't be
deployed to CHANG via the project-structure method the brief specifies.

**No workaround was attempted.** Per this task's explicit instruction
("If any function deploy fails... stop and report clearly rather than
guessing at a workaround"), and per the "no code changes" scope of this
task, the fix (changing the import to `../_shared/activate-tenant.ts`, or
committing a local copy) was left undone. This needs a human/separate-task
decision: it is a real latent bug equally present in Tokyo's repo state,
independent of which Supabase project the function is deployed to.

## Step 3: Verify deployed — `functions list` output

```bash
npx supabase functions list --project-ref kntspldhvcjeaubtqtkn
```

All 12 successfully-deployed functions returned, `status: ACTIVE`,
`verify_jwt` exactly matching Step 2's spec:

| slug | status | verify_jwt | expected | match |
|---|---|---|---|---|
| sign-link | ACTIVE | false | false | yes |
| line-webhook | ACTIVE | false | false | yes |
| field-form | ACTIVE | false | false | yes |
| extract-po-document | ACTIVE | true | true | yes |
| line-push-daily-assignments | ACTIVE | true | true | yes |
| line-push-quotation-followups | ACTIVE | true | true | yes |
| line-push-cheque-reminders | ACTIVE | true | true | yes |
| line-push-invoice-due | ACTIVE | true | true | yes |
| line-worker-offboarded | ACTIVE | true | true | yes |
| line-test-group | ACTIVE | true | true | yes |
| leave-notify | ACTIVE | true | true | yes |
| extract-map-coordinates | ACTIVE | true | true | yes |

`omise-webhook` and `omise-create-charge` do not appear in the list at
all — they were never created on CHANG since the bundle step failed before
upload.

Raw JSON (abbreviated per-function to the fields that matter; full response
captured during the session):

```
sign-link: {"status":"ACTIVE","verify_jwt":false}
line-webhook: {"status":"ACTIVE","verify_jwt":false}
field-form: {"status":"ACTIVE","verify_jwt":false}
extract-po-document: {"status":"ACTIVE","verify_jwt":true}
line-push-daily-assignments: {"status":"ACTIVE","verify_jwt":true}
line-push-quotation-followups: {"status":"ACTIVE","verify_jwt":true}
line-push-cheque-reminders: {"status":"ACTIVE","verify_jwt":true}
line-push-invoice-due: {"status":"ACTIVE","verify_jwt":true}
line-worker-offboarded: {"status":"ACTIVE","verify_jwt":true}
line-test-group: {"status":"ACTIVE","verify_jwt":true}
leave-notify: {"status":"ACTIVE","verify_jwt":true}
extract-map-coordinates: {"status":"ACTIVE","verify_jwt":true}
```

## Step 4: Secrets checklist

Written to `supabase/region-migration/secrets-checklist.md`. Lists only the
5 secret NAMES (`ANTHROPIC_API_KEY`, `LINE_CHANNEL_ACCESS_TOKEN`,
`LINE_CHANNEL_SECRET`, `OMISE_SECRET_KEY`, `RESEND_API_KEY`) for manual
re-entry by the user. No secret values were read, printed, or set at any
point in this task.

## What still needs to happen (not done by this task, out of scope)

1. Decide how to fix the `omise-webhook` / `omise-create-charge` import bug
   (likely: change `./_shared/activate-tenant.ts` to
   `../_shared/activate-tenant.ts` in both files, matching every other
   function's convention) — this is a source code change and needs its own
   review, since it affects Tokyo too, not just this migration dry run.
2. Once fixed, deploy those 2 functions to CHANG with the same flags used
   here:
   ```bash
   npx supabase functions deploy omise-webhook --project-ref kntspldhvcjeaubtqtkn --no-verify-jwt --use-api
   npx supabase functions deploy omise-create-charge --project-ref kntspldhvcjeaubtqtkn --use-api
   ```
3. The 5 secrets in `secrets-checklist.md` still need manual entry before
   any of the 12 deployed functions are fully functional on CHANG.

## Linked project state

This task's commands did not touch the CLI's `--linked` project state
(every command passed `--project-ref` explicitly). No relink was performed
in either direction. Per Tasks 1-3, the linked project should still be
Tokyo (`yyzbgdmgyvvypfcjuhtr`) going into Task 5 — not verified by this
task per its own scope, but flagged here per the brief's note.
