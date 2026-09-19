# FacadeX MCP Server — Design Spec

## Problem

FacadeX has no integration/API surface today — every path into the data
is the React SPA talking directly to Supabase through RLS. The
independent three-expert review (`docs/superpowers/plans/` sibling —
see the published field-review artifact) flagged this explicitly: *"No
API keys, webhooks, or third-party connections found anywhere in
Settings... data is effectively locked in"* (ERP specialist).

This spec adds a **read-only MCP (Model Context Protocol) server**, so a
tenant's own staff can point their own AI tool (Claude Desktop, or any
other MCP client) at their FacadeX data — "what's outstanding on FX-2026-001,"
"list unpaid invoices over 30 days" — without FacadeX having to build
that chat interface itself. Each tenant only ever sees their own data,
scoped by the exact same role/permission rules the web app already
enforces.

**Decided during brainstorming** (recorded here so the plan doesn't
re-litigate it):
- Audience: each tenant's own staff connecting their own AI tools —
  not an internal-only tool, not a cross-tenant admin tool.
- Scope: **read-only** in this version. No tool in v1 can create,
  update, or delete anything. Write actions (e.g. "mark this invoice
  paid") are an explicit, separate future phase — deliberately deferred
  given the review's own "finalized records aren't protected" finding;
  a write-capable MCP surface should not ship before that finding is
  fixed, not alongside it.
- Auth model: a per-user **Personal Access Token** generated in
  Settings, not a full OAuth 2.1 authorization server. Rejected OAuth
  for v1: Supabase Auth is a first-party login system, not an OAuth
  provider for third-party apps — building a real
  authorize/token/consent/PKCE flow is a substantial project on its
  own, and a PAT (the same pattern GitHub/Notion/Linear use for
  "connect your AI tool") gets a tenant's non-technical office staff to
  a working connection in one paste, with far less new attack surface
  to get right the first time.
- Deployment: a **Supabase Edge Function** (HTTP transport), not a
  locally-run script. FacadeX already has four live Edge Functions
  (`omise-create-charge`, `omise-webhook`, `sign-link`,
  `extract-po-document`) — this follows that exact existing pattern
  rather than introducing a new kind of backend component. A
  locally-run MCP server was considered and rejected: the target user
  (SME contractor office staff) is exactly the buyer segment the field
  review already flagged as at onboarding-curve risk; "install and run
  a Node script" is not a reasonable ask of that user.

## Data Model

### New table: `mcp_tokens`

| column | type | notes |
|---|---|---|
| `id` | uuid | PK |
| `tenant_id` | uuid | NOT NULL — flat tenant scoping, matches this schema's existing convention |
| `user_email` | text | NOT NULL — matches `user_roles`' own keying (this schema keys staff by email, not a `user_id` FK to a separate profiles table — confirmed live: `user_roles(id, user_email, role, status, tenant_id, created_at)`) |
| `token_hash` | text | NOT NULL — SHA-256 of the raw token. The raw token is shown to the user exactly once, at creation, and is never stored or retrievable again (same convention as every "API key" feature in the industry) |
| `name` | text | user-given label, e.g. "Claude Desktop — office PC," so a user with multiple tokens can tell them apart when revoking |
| `created_at` | timestamptz | |
| `last_used_at` | timestamptz, nullable | updated on every successful request — lets a user see a token is (or isn't) actually being used, and gives an OWNER a real signal before revoking one they don't recognize |
| `revoked_at` | timestamptz, nullable | soft-revoke, not delete — keeps the row (and its `last_used_at` history) for audit even after revocation |

RLS: a user reads/creates/revokes only their own tokens
(`tenant_id = current_tenant_id() AND user_email = auth.email()`); an
OWNER can additionally *read* (not revoke on someone else's behalf,
v1) every token issued under their tenant, for security review — mirrors
`user_roles`' own existing OWNER-sees-everyone-in-tenant shape.

## Request Flow

1. MCP client sends `Authorization: Bearer <raw_token>` to the
   `mcp-server` Edge Function.
2. The function hashes the raw token (same SHA-256) and looks it up in
   `mcp_tokens` **using the service-role key** — there is no user
   session yet at this point, so this one lookup is necessarily
   RLS-bypassing; everything after it is not.
3. Reject (401) if not found, or `revoked_at` is set.
4. Resolve `tenant_id` + `user_email`, then join `user_roles` for that
   tenant+email to get the current `role` (WORKER/ADMIN/OWNER) and
   `status` (reject if not active — a deactivated staff member's token
   must stop working the moment their access is revoked in Settings,
   not just when someone remembers to separately revoke the MCP token).
5. **Mint a short-lived (e.g. 5-minute) signed session JWT for that
   exact user** — the same shape of JWT Supabase's own client SDK
   produces on a normal login (same `sub`/`email`/`role: authenticated`
   claims the existing RLS policies already key off via `auth.email()`/
   `current_tenant_id()`). Use that JWT to construct a fresh Supabase
   client for the lifetime of this one request.
6. Every tool call this request makes queries through that
   user-scoped client — meaning it runs through the tenant's real,
   existing RLS policies, identically to the web app. A WORKER-role
   token can never see more than a WORKER already sees today; there is
   no second, parallel scoping implementation to keep in sync with RLS
   as the schema evolves.
7. Update `last_used_at` on the token row (service-role, fire-and-forget
   — a failure here must never fail the actual request).

**Fallback if step 5 proves impractical inside the Deno Edge Function
runtime** (verify this early during implementation, before committing
to it as the only path): service-role client + **one** shared, single
```
scopeToTenantAndRole(query, {tenantId, role, userEmail})
```
helper that every tool function calls before returning results — never
each tool re-implementing its own filter. Worse than real RLS reuse
(a second place the rule lives), but bounded to one place instead of
one per tool, so it can't silently drift tool-by-tool the way six
independent hand-written `.eq('tenant_id', ...)` calls could.

## v1 Tools (read-only)

Deliberately limited to what's already visible on the Dashboard / Site
Overview pages today — this version exposes no data through MCP that
the same user's role couldn't already see by logging into the web app:

| Tool | Mirrors | Notes |
|---|---|---|
| `list_sites` | ไซท์งาน (Sites list) | name, status, contract value, % billed, profit — same columns as the table view |
| `get_site_summary` | Site ภาพรวม tab | financials, retention, deposit balance, countdown |
| `list_invoices` | รายรับ → ใบแจ้งหนี้ | filterable by site/status/date range |
| `list_expenses` | รายจ่าย | filterable by site/category/status |
| `get_site_gantt` | Site Gantt tab | phase/subtask tree with status and % complete (recursive — see `docs/superpowers/specs/2026-09-18-gantt-subtask-hierarchy-design.md`) |
| `get_site_kanban` | Site Kanban tab | cards for a given phase/subtask leaf, with assignee/status |

Each tool's input schema takes a `site_id` (or none, for `list_sites`)
and optional filters; every tool's implementation is just a normal
Supabase query against the request's user-scoped client from step 5/6
above — no bespoke authorization logic per tool.

## Settings UI

A new "🔌 MCP / API" card in ตั้งค่า, alongside the existing
account/signature/package cards (visible to any role — a WORKER should
be able to connect their own read-scoped AI tool just as easily as an
OWNER, since the token can never grant more than their own role already
has):

- **+ สร้าง Token ใหม่**: name it, get the raw token shown once in a
  copy-to-clipboard box with an explicit "this won't be shown again"
  warning, plus the exact server URL + a copy-pasteable MCP client
  config snippet.
- A table of the user's own tokens: name, created date, last used
  (or "ยังไม่เคยใช้"), and a ลบ/revoke action per row.
- (OWNER only) a second table below it: every token issued under the
  tenant, by user — read-only, for security review.

## Out of Scope for This Spec

- Write actions of any kind (create/update/delete via MCP) — explicit
  future phase, gated on the "lock finalized records" fix from the
  field review landing first.
- Full OAuth 2.1 / one-click "Connect to Claude" flow — PAT only, this
  version.
- Any tool beyond the six listed above (e.g. worker assignments, PO/
  inventory, quotations) — the six above are the ones already proven
  safe to expose (they're exactly what's on-screen today); expanding
  the tool list is a natural, low-risk follow-up once the auth/scoping
  mechanism itself is live and trusted, not something to bundle into
  the first version.
- Rate limiting / abuse protection beyond what Supabase's own Edge
  Function platform provides by default — worth a dedicated look once
  there's real usage to measure, not a speculative build now.

## Open Question — flagged for the planning stage, not resolved here

Whether JWT-impersonation (step 5) is actually achievable inside a Deno
Edge Function with the credentials an Edge Function has access to (the
project's JWT secret vs. only the service-role key) needs a small,
early spike during implementation — before the rest of the six tools
are built on top of whichever answer it turns out to be. If it's not
achievable, fall back to the single shared scoping-helper approach
above and say so plainly in the plan; don't silently paper over the
difference in tool-call code that assumes real RLS is running underneath
it.
