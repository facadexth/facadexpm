# CHANG Secrets Checklist

These 5 secrets exist on Tokyo and must be manually re-entered on CHANG via
the Supabase Dashboard (Project Settings → Edge Functions → Secrets) or your
own authenticated CLI session. Real values are never read, transcribed, or
set by Claude — enter them yourself from your own records or the LINE/Omise/
Anthropic/Resend dashboards where each was originally issued.

- [ ] `ANTHROPIC_API_KEY`
- [ ] `LINE_CHANNEL_ACCESS_TOKEN`
- [ ] `LINE_CHANNEL_SECRET`
- [ ] `OMISE_SECRET_KEY`
- [ ] `RESEND_API_KEY`

The following are platform-managed and need NO action — Supabase
auto-populates these correctly for every project, including CHANG:
`SUPABASE_ANON_KEY`, `SUPABASE_DB_URL`, `SUPABASE_JWKS`,
`SUPABASE_PUBLISHABLE_KEYS`, `SUPABASE_SECRET_KEYS`,
`SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL`.

Verify after entering, via your own terminal (do not ask Claude to run this
with real values in view):
`npx supabase secrets list --project-ref kntspldhvcjeaubtqtkn`
(shows names + digests only, confirms presence without exposing values).
