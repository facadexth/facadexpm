# LINE Crew Comms + Office Reminders Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give FacadeX real two-way LINE integration: crew get their next-day assignment pushed the evening before and can report a problem / request material / request leave by texting the group; office staff (OWNER + the record's own creator) get pushed reminders for quotations gone quiet, cheques coming due, and sites due their next progress invoice.

**Architecture:** One per-tenant LINE OA connection (`line_settings`, directly queryable by `channel_id` so an inbound webhook can find its tenant in one lookup) plus a shared `_shared/line.ts` helper (signature verification + push) reused by one inbound Edge Function (`line-webhook`) and four scheduled ones. Every scheduled function is a thin loop over tenants around a pure, fully-tested calc module — no business logic lives inside an Edge Function that isn't first a tested pure function.

**Tech Stack:** Supabase Edge Functions (Deno + TypeScript), Supabase Cron (`pg_cron`/`pg_net`), React 18, Vitest.

**Spec:** `docs/superpowers/specs/2026-09-19-line-notifications-design.md`

## Global Constraints

- `created_by` (not `created_by_email`) is this schema's existing convention for "who did this" (confirmed live: `stock_movements.created_by`, `document_receipt_links.created_by`, both `text`, populated client-side as `session?.user?.email || 'system'` — see `src/components/SignLinkModal.jsx:24`). Use that exact name and pattern everywhere this plan needs a creator column — never `created_by_email` or a uuid FK.
- Reuse `app_settings` (`src/hooks/useSupabase.js`'s `useAppSetting`/`saveAppSetting`, key/value, tenant-scoped) for every simple per-tenant preference (quotation follow-up default days, the cheque-reminder LINE toggle) — do not invent a new table for these. `line_settings` is the one exception, because its rows must be directly queryable by `channel_id` from an unauthenticated webhook request, which a generic key/value store can't do efficiently.
- Edge Functions in this repo follow one house style — mirror `supabase/functions/sign-link/index.ts` exactly: `Deno.serve`, `createClient` from `jsr:@supabase/supabase-js@2`, a module-level `admin` client built from `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` env vars, a shared `corsHeaders` object, a `json(body, status)` helper, `action`-string dispatch via `if` blocks reading `await req.json()` — not a router library, not REST-path routing.
- Every new table gets RLS before anything else touches it. Match the existing shape for the sensitivity level: `line_settings` (holds a channel secret + access token) is OWNER-only, same as this app's other sensitive-credential settings cards; `line_issue_reports`/`line_unlinked_senders` are ADMIN+ tenant-scoped, same as every other operational table.
- `npm run build` and `npm test -- --run` (197 existing tests + this plan's new ones) must stay green after every task.
- Never hardcode a LINE API shape you haven't grounded: the push endpoint is `POST https://api.line.me/v2/bot/message/push` with `Authorization: Bearer <channel access token>` and body `{"to": "<userId or groupId>", "messages": [{"type": "text", "text": "..."}]}`; webhook signature verification is HMAC-SHA256 of the raw request body using the channel secret as key, base64-encoded, compared against the `x-line-signature` request header. Both are stable, documented LINE Messaging API surface — implement them exactly as stated, don't guess at a different shape.

---

### Task 1: Schema — all new tables and columns

**Files:**
- Create: `supabase/migrations/2026-09-19-01-line-integration.sql`

**Interfaces:**
- Produces: `line_settings(tenant_id, channel_id, channel_access_token, channel_secret, crew_group_id, created_at, updated_at)`; `line_issue_reports(id, tenant_id, site_id, worker_id, message, status, created_at)`; `line_unlinked_senders(id, tenant_id, line_user_id, display_name, first_seen_at, linked_worker_id)`; new columns `quotations.created_by`, `quotations.sent_at`, `quotations.follow_up_after_days`, `quotations.follow_up_sent_at`; `cheques.created_by`; `workers.line_user_id`; `user_roles.line_user_id`, `user_roles.line_link_code`.

- [ ] **Step 1: Write the migration file**

```sql
-- supabase/migrations/2026-09-19-01-line-integration.sql
--
-- LINE crew comms + office reminders -- spec:
-- docs/superpowers/specs/2026-09-19-line-notifications-design.md
--
-- line_settings is a real table (not app_settings) specifically because
-- the inbound webhook has to find "which tenant does this LINE channel
-- belong to" from an unauthenticated request in one indexed lookup --
-- a generic key/value store can't do that without scanning every
-- tenant's blob. Everything else this feature needs that's just a
-- per-tenant preference (not looked up from a webhook) lives in the
-- existing app_settings table instead -- see Task 6.

CREATE TABLE line_settings (
  tenant_id             UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  channel_id            TEXT NOT NULL,
  channel_access_token  TEXT NOT NULL,
  channel_secret        TEXT NOT NULL,
  crew_group_id         TEXT,
  created_at            TIMESTAMPTZ DEFAULT NOW(),
  updated_at            TIMESTAMPTZ DEFAULT NOW()
);
CREATE UNIQUE INDEX idx_line_settings_channel_id ON line_settings(channel_id);

ALTER TABLE line_settings ENABLE ROW LEVEL SECURITY;
-- OWNER-only, both ways -- this table holds a channel secret + access
-- token, same sensitivity tier as this app's other credential-holding
-- settings (bank accounts, e-sign config).
CREATE POLICY owner_reads ON line_settings FOR SELECT TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id());
CREATE POLICY owner_writes ON line_settings FOR ALL TO authenticated
  USING (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- Track A: "งานมีปัญหา" structured capture (not a full Knowledge
-- Management system yet -- see spec's Out of Scope).
CREATE TABLE line_issue_reports (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  site_id     UUID REFERENCES sites(id),
  worker_id   UUID REFERENCES workers(id),
  message     TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved')),
  created_at  TIMESTAMPTZ DEFAULT NOW()
);
CREATE INDEX idx_line_issue_reports_tenant_id ON line_issue_reports(tenant_id);

ALTER TABLE line_issue_reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_issue_reports FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_updates ON line_issue_reports FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
-- No admin_inserts: these rows are only ever created by line-webhook
-- using the service-role key, never directly by a client.

-- Bootstrap for Track A: the first time an unrecognized LINE user posts
-- in the crew group, line-webhook records them here instead of
-- silently dropping the message, so an admin has something to resolve
-- (Task 7) rather than a worker's first message just vanishing.
CREATE TABLE line_unlinked_senders (
  id                UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id         UUID NOT NULL,
  line_user_id      TEXT NOT NULL,
  display_name      TEXT,
  first_seen_at     TIMESTAMPTZ DEFAULT NOW(),
  linked_worker_id  UUID REFERENCES workers(id)
);
CREATE UNIQUE INDEX idx_line_unlinked_senders_tenant_user ON line_unlinked_senders(tenant_id, line_user_id);

ALTER TABLE line_unlinked_senders ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_unlinked_senders FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
CREATE POLICY admin_updates ON line_unlinked_senders FOR UPDATE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write())
  WITH CHECK (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());
CREATE POLICY admin_deletes ON line_unlinked_senders FOR DELETE TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id() AND tenant_can_write());

-- Track A: map a worker to their own LINE account, so an inbound
-- message's sender can be resolved to a real workers row.
ALTER TABLE workers ADD COLUMN line_user_id TEXT;
CREATE UNIQUE INDEX idx_workers_line_user_id ON workers(line_user_id) WHERE line_user_id IS NOT NULL;

-- Track B: individual OWNER/ADMIN LINE linking, via a one-time code
-- (see Task 6) rather than a full OAuth flow -- line_link_code is
-- generated and shown once in that user's own Settings, consumed by
-- line-webhook the moment they DM it to the tenant's LINE OA.
ALTER TABLE user_roles ADD COLUMN line_user_id TEXT;
ALTER TABLE user_roles ADD COLUMN line_link_code TEXT;
CREATE UNIQUE INDEX idx_user_roles_line_user_id ON user_roles(line_user_id) WHERE line_user_id IS NOT NULL;
CREATE UNIQUE INDEX idx_user_roles_line_link_code ON user_roles(line_link_code) WHERE line_link_code IS NOT NULL;

-- Track B: per-quotation follow-up, set at send time (Task 5) --
-- created_by/sent_at didn't exist before this (confirmed live: only
-- created_at existed) and are both needed so the daily scan (Task 4)
-- has a real anchor date and a real recipient.
ALTER TABLE quotations ADD COLUMN created_by TEXT;
ALTER TABLE quotations ADD COLUMN sent_at TIMESTAMPTZ;
ALTER TABLE quotations ADD COLUMN follow_up_after_days INT;
ALTER TABLE quotations ADD COLUMN follow_up_sent_at TIMESTAMPTZ;

-- Track B: cheque reminders can't target an individual creator without
-- this -- cheques had no creator-tracking column at all (confirmed
-- live), same gap quotations had.
ALTER TABLE cheques ADD COLUMN created_by TEXT;
```

- [ ] **Step 2: Verify `is_owner()` exists as a helper function**

This migration assumes an `is_owner()` SQL function exists alongside the
already-used `is_admin_or_owner()` (used throughout this schema's other
RLS policies). Check via
`select proname from pg_proc where proname like 'is_%';` before writing
the `line_settings` policies. If only `is_admin_or_owner()` exists (no
separate OWNER-only check), write the OWNER-only policies as
`is_admin_or_owner() AND EXISTS (SELECT 1 FROM user_roles ur WHERE ur.user_email = auth.email() AND ur.tenant_id = current_tenant_id() AND ur.role = 'OWNER')`
instead — don't invent a differently-named helper function without
checking what's already there first.

- [ ] **Step 3: Apply the migration and verify live**

Apply via `mcp__plugin_supabase_supabase__apply_migration`
(`project_id: yyzbgdmgyvvypfcjuhtr`). Verify: all 3 new tables exist
with RLS enabled and the expected policies
(`select tablename, policyname, cmd from pg_policies where tablename in ('line_settings','line_issue_reports','line_unlinked_senders')`),
and all 7 new columns exist on their respective tables.

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-09-19-01-line-integration.sql
git commit -m "feat: schema for LINE crew comms + office reminders"
```

---

### Task 2: Pure calc module — `lineNotifications.js`

**Files:**
- Create: `src/lib/lineNotifications.js`
- Test: `src/lib/lineNotifications.test.js`

**Interfaces:**
- Produces (used by Task 4's scheduled functions — written in TypeScript
  for Deno, so Task 4 re-implements this same logic in TS rather than
  importing this file directly; this module is what Task 4's TS is
  ported from and what pins the exact date-math/formatting rules under
  test):
  - `isQuotationFollowupDue(quotation, todayISO) => boolean`
  - `isChequeReminderDue(cheque, thresholdDays, todayISO) => boolean`
  - `isSiteInvoiceDueThisMonth(site, todayISO) => boolean`
  - `formatAssignmentPushMessage(workerName, assignments) => string`
  - `formatQuotationFollowupMessage(quotation) => string`
  - `formatChequeReminderMessage(cheque) => string`
  - `formatInvoiceDueMessage(site) => string`

- [ ] **Step 1: Write the failing tests**

```js
// src/lib/lineNotifications.test.js
import { describe, it, expect } from 'vitest'
import {
  isQuotationFollowupDue, isChequeReminderDue, isSiteInvoiceDueThisMonth,
  formatAssignmentPushMessage, formatQuotationFollowupMessage,
  formatChequeReminderMessage, formatInvoiceDueMessage,
} from './lineNotifications.js'

describe('isQuotationFollowupDue', () => {
  it('is due when sent_at + follow_up_after_days has passed and no follow-up sent yet', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-08')).toBe(true)
  })

  it('is not due yet the day before the threshold', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-07')).toBe(false)
  })

  it('is not due once already sent, even if the date condition still holds', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: '2026-09-08T00:00:00Z' }
    expect(isQuotationFollowupDue(qt, '2026-09-10')).toBe(false)
  })

  it('is not due when the quotation was never given a follow-up window (skipped at send time)', () => {
    const qt = { status: 'sent', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: null, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-12-01')).toBe(false)
  })

  it('is not due once the quotation has moved past "sent" (accepted/rejected/expired)', () => {
    const qt = { status: 'accepted', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7, follow_up_sent_at: null }
    expect(isQuotationFollowupDue(qt, '2026-09-08')).toBe(false)
  })
})

describe('isChequeReminderDue', () => {
  it('is due when check_date is within the threshold and not yet cleared', () => {
    const cheque = { check_date: '2026-09-10', status: 'issued' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(true)
  })

  it('is not due when check_date is further out than the threshold', () => {
    const cheque = { check_date: '2026-09-20', status: 'issued' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(false)
  })

  it('is not due once the cheque has already cleared', () => {
    const cheque = { check_date: '2026-09-10', status: 'cashed' }
    expect(isChequeReminderDue(cheque, 3, '2026-09-08')).toBe(false)
  })
})

describe('isSiteInvoiceDueThisMonth', () => {
  it('is due for an ongoing, not-fully-billed site with no invoice issued this month', () => {
    const site = { status: 'Ongoing', billing_pct: 60, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(true)
  })

  it('is not due if an invoice was already issued this month', () => {
    const site = { status: 'Ongoing', billing_pct: 60, last_invoice_date: '2026-09-05' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })

  it('is not due once the site is fully billed', () => {
    const site = { status: 'Ongoing', billing_pct: 100, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })

  it('is not due for a non-Ongoing site', () => {
    const site = { status: 'Completed', billing_pct: 60, last_invoice_date: '2026-08-15' }
    expect(isSiteInvoiceDueThisMonth(site, '2026-09-10')).toBe(false)
  })
})

describe('message formatters', () => {
  it('formats a daily assignment push listing every site for that worker', () => {
    const msg = formatAssignmentPushMessage('ลิด', [{ siteName: 'SOAP OPERA', zone: null }, { siteName: 'FX-2026-001', zone: 'ชั้น 3' }])
    expect(msg).toContain('ลิด')
    expect(msg).toContain('SOAP OPERA')
    expect(msg).toContain('FX-2026-001')
    expect(msg).toContain('ชั้น 3')
  })

  it('formats a quotation follow-up reminder with the quotation number and days elapsed', () => {
    const msg = formatQuotationFollowupMessage({ quotation_number: 'QT2609-017', sent_at: '2026-09-01T00:00:00Z', follow_up_after_days: 7 })
    expect(msg).toContain('QT2609-017')
    expect(msg).toContain('7')
  })

  it('formats a cheque reminder with the cheque number and check date', () => {
    const msg = formatChequeReminderMessage({ cheque_no: '00579873', check_date: '2026-09-10', bank: 'กสิกรไทย' })
    expect(msg).toContain('00579873')
    expect(msg).toContain('2026-09-10')
  })

  it('formats an invoice-due reminder with the site name and billing %', () => {
    const msg = formatInvoiceDueMessage({ name: 'SOAP OPERA', site_number: 'FX-2026-138', billing_pct: 60 })
    expect(msg).toContain('SOAP OPERA')
    expect(msg).toContain('60')
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test -- --run lineNotifications`
Expected: FAIL — `lineNotifications.js` doesn't exist yet.

- [ ] **Step 3: Write the implementation**

```js
// src/lib/lineNotifications.js
// ============================================================
// Pure date-math and message-formatting for LINE crew comms + office
// reminders -- no Supabase/React dependency. This is the module Task
// 4's scheduled Edge Functions port their logic from (Deno can't
// import a Vite-bundled file directly) -- keep this file the single
// source of truth for the RULES; Task 4's TS re-expresses the same
// rules, not different ones.
// ============================================================

const DAY_MS = 86400000

function daysBetween(fromISO, toISO) {
  return Math.floor((new Date(toISO) - new Date(fromISO)) / DAY_MS)
}

/** A sent quotation is due a follow-up once `follow_up_after_days` have
 *  elapsed since it was sent -- only once (guarded by follow_up_sent_at),
 *  only if a window was actually set (skipped at send time -> null,
 *  never due), and only while the quotation is still sitting at 'sent'
 *  (moved to accepted/rejected/expired -> no longer relevant). */
export function isQuotationFollowupDue(quotation, todayISO) {
  if (quotation.status !== 'sent') return false
  if (quotation.follow_up_after_days == null) return false
  if (quotation.follow_up_sent_at) return false
  if (!quotation.sent_at) return false
  return daysBetween(quotation.sent_at, todayISO) >= quotation.follow_up_after_days
}

/** A cheque is due a reminder once its check_date is within
 *  `thresholdDays` of today, as long as it hasn't already cleared. */
export function isChequeReminderDue(cheque, thresholdDays, todayISO) {
  if (cheque.status === 'cashed') return false
  return daysBetween(todayISO, cheque.check_date) <= thresholdDays
}

/** An Ongoing, not-fully-billed site is due its next progress invoice
 *  once a full calendar month has passed without a new one -- "due this
 *  month" means no invoice has been issued in the current calendar
 *  month yet, not a fixed day-of-month. */
export function isSiteInvoiceDueThisMonth(site, todayISO) {
  if (site.status !== 'Ongoing') return false
  if ((site.billing_pct ?? 0) >= 100) return false
  if (!site.last_invoice_date) return true
  const today = new Date(todayISO)
  const last = new Date(site.last_invoice_date)
  return !(last.getFullYear() === today.getFullYear() && last.getMonth() === today.getMonth())
}

export function formatAssignmentPushMessage(workerName, assignments) {
  const lines = assignments.map((a) => a.zone ? `• ${a.siteName} (${a.zone})` : `• ${a.siteName}`)
  return `📋 พรุ่งนี้ ${workerName} ทำงานที่:\n${lines.join('\n')}`
}

export function formatQuotationFollowupMessage(quotation) {
  return `📤 ติดตามใบเสนอราคา ${quotation.quotation_number} — ส่งไปแล้ว ${quotation.follow_up_after_days} วัน ยังไม่มีการตอบรับ`
}

export function formatChequeReminderMessage(cheque) {
  return `🏦 เช็ค ${cheque.cheque_no} (${cheque.bank}) ครบกำหนด ${cheque.check_date}`
}

export function formatInvoiceDueMessage(site) {
  return `🧾 ${site.name} (${site.site_number}) เบิกไปแล้ว ${site.billing_pct}% — ถึงกำหนดออกใบแจ้งหนี้งวดถัดไปเดือนนี้`
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test -- --run lineNotifications`
Expected: PASS, all cases.

- [ ] **Step 5: Commit**

```bash
git add src/lib/lineNotifications.js src/lib/lineNotifications.test.js
git commit -m "feat: pure date-math and message formatting for LINE notifications"
```

---

### Task 3: `_shared/line.ts` helper + `line-webhook` Edge Function (Track A, inbound)

**Files:**
- Create: `supabase/functions/_shared/line.ts`
- Create: `supabase/functions/line-webhook/index.ts`

**Interfaces:**
- Produces: `verifyLineSignature(channelSecret, rawBody, signatureHeader) => Promise<boolean>`, `sendLinePush(accessToken, to, text) => Promise<{ok, status}>`, `sendLineReply(accessToken, replyToken, text) => Promise<{ok, status}>` — all three used again by Task 4.
- Consumes: `line_settings`, `workers`, `line_unlinked_senders`, `line_issue_reports`, `user_roles`, `purchase_orders`, HR leave-request table (find its actual name/shape during this task — read `src/pages/HR.jsx` for the leave-request insert shape before writing this function; don't assume a table name without checking).

**Design notes:** this task is inbound-only (Track A). Do not build any
of the four scheduled push functions here — that's Task 4, deliberately
separated because it depends on this task's `_shared/line.ts` existing
first.

- [ ] **Step 1: Write `_shared/line.ts`**

```ts
// supabase/functions/_shared/line.ts
// Shared LINE Messaging API primitives -- every function that talks to
// LINE (line-webhook, and Task 4's four scheduled push functions) goes
// through these three, so there is exactly one implementation of
// signature verification and exactly one of "send a message" to keep
// in sync with LINE's API, not five copies.

const LINE_API = 'https://api.line.me/v2/bot/message'

export async function verifyLineSignature(channelSecret: string, rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(channelSecret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(rawBody))
  const expected = btoa(String.fromCharCode(...new Uint8Array(sig)))
  return expected === signatureHeader
}

export async function sendLinePush(accessToken: string, to: string, text: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${LINE_API}/push`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ to, messages: [{ type: 'text', text }] }),
  })
  return { ok: res.ok, status: res.status }
}

export async function sendLineReply(accessToken: string, replyToken: string, text: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`${LINE_API}/reply`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ replyToken, messages: [{ type: 'text', text }] }),
  })
  return { ok: res.ok, status: res.status }
}
```

- [ ] **Step 2: Read `src/pages/HR.jsx` and `src/pages/PurchaseOrders.jsx` for the exact insert shapes**

Before writing `line-webhook`, find: (a) the real table name and required
columns for a leave request (the spec assumed "existing HR/Assign leave
types," `TYPE_COLOR`/`TYPE_LEGEND` in `src/lib/constants.js` — confirm
the actual table this writes to, e.g. `worker_assignments` with a
`type: 'leave_personal'` row, or a dedicated leave-requests table — grep
for `leave_sick`/`leave_personal` to find every write site and copy the
minimal-required-fields shape from an existing one); (b) the
`purchase_orders` table's minimal insert shape for a **draft** PO (status
field and its draft value, required fields, how `site_id`/`tenant_id`
are set). Use exactly what you find — do not guess field names.

- [ ] **Step 3: Write `line-webhook/index.ts`**

Structure (mirror `supabase/functions/sign-link/index.ts`'s house style
exactly — `Deno.serve`, `admin` client, `corsHeaders`, `json()` helper):

```ts
// supabase/functions/line-webhook/index.ts
// Inbound LINE webhook -- receives every event for every tenant's LINE
// OA on one shared URL, routes by the webhook payload's own
// `destination` field (LINE's channel id for that event) against
// line_settings.channel_id. verify_jwt is OFF for this function (LINE
// itself calls it, unauthenticated by Supabase's own JWT check) --
// this function's signature verification against line_settings.
// channel_secret IS the access control, same pattern sign-link already
// established for its own public/unauthenticated endpoint.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyLineSignature, sendLineReply } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const rawBody = await req.text()
  const payload = JSON.parse(rawBody)
  const destination: string = payload.destination

  const { data: settings } = await admin.from('line_settings').select('*').eq('channel_id', destination).maybeSingle()
  if (!settings) return json({ error: 'unknown channel' }, 404)

  const signatureOk = await verifyLineSignature(settings.channel_secret, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  for (const event of payload.events ?? []) {
    if (event.type !== 'message' || event.message?.type !== 'text') continue
    const text: string = event.message.text
    const lineUserId: string = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue

    // A bare linking code, sent as a DM (no groupId) -- Track B's
    // one-time OWNER/ADMIN linking flow (see Task 6).
    if (!sourceGroupId) {
      const { data: pending } = await admin.from('user_roles').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', text.trim()).maybeSingle()
      if (pending) {
        await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pending.id)
        await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้ว')
      }
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group.
    if (sourceGroupId !== settings.crew_group_id) continue

    const { data: worker } = await admin.from('workers').select('id, name').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
    if (!worker) {
      // First message from someone we don't recognize -- capture, don't
      // silently drop (Task 7 gives an admin a way to resolve this).
      await admin.from('line_unlinked_senders').upsert(
        { tenant_id: settings.tenant_id, line_user_id: lineUserId, display_name: event.source?.userId ?? null },
        { onConflict: 'tenant_id,line_user_id', ignoreDuplicates: true }
      )
      continue
    }

    // Keyword-based triggers -- simple substring match, not NLP. Order
    // matters only in that a message shouldn't match more than one; the
    // three Thai phrases share no substrings so this is unambiguous.
    if (text.includes('ปัญหา')) {
      await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: text })
      await sendLineReply(settings.channel_access_token, event.replyToken, '📩 รับแจ้งปัญหาแล้ว แอดมินจะติดตามให้')
    } else if (text.includes('เบิก')) {
      // Insert a DRAFT purchase_orders row -- use the exact shape found
      // in Step 2. Needs admin review before it's a real PO, same as
      // any other draft.
    } else if (text.includes('ลา')) {
      // Insert a leave request -- use the exact shape found in Step 2.
    }
  }

  return json({ ok: true })
})
```

(The two `// Insert a DRAFT...` / `// Insert a leave request...` comments
are placeholders for the implementer to fill in using the real shapes
found in Step 2 — this is the one deliberate exception to "no
placeholders" in this plan, because the correct shape genuinely can't
be known until Step 2's file reads happen; every other line in this
function is real, complete code.)

- [ ] **Step 4: Deploy and verify**

Deploy via `mcp__plugin_supabase_supabase__deploy_edge_function` with
`verify_jwt: false` (matches `sign-link`'s own setting, for the same
reason — LINE calls this directly, unauthenticated by Supabase's JWT
layer). Verify by sending a manually-constructed test POST (with a
correctly-computed HMAC signature using a test `channel_secret`) and
confirming a 200 response and the expected row appears in whichever
table the test message's keyword should have hit. Clean up test rows
afterward.

- [ ] **Step 5: Commit**

```bash
git add supabase/functions/_shared/line.ts supabase/functions/line-webhook/index.ts
git commit -m "feat: LINE webhook -- crew inbound triggers + OWNER/ADMIN account linking"
```

---

### Task 4: Four scheduled push functions + Supabase Cron

**Files:**
- Create: `supabase/functions/line-push-daily-assignments/index.ts`
- Create: `supabase/functions/line-push-quotation-followups/index.ts`
- Create: `supabase/functions/line-push-cheque-reminders/index.ts`
- Create: `supabase/functions/line-push-invoice-due/index.ts`
- Create: `supabase/migrations/2026-09-19-02-line-push-cron.sql`

**Interfaces:**
- Consumes: `sendLinePush` from `_shared/line.ts` (Task 3); the four
  `is*Due`/`format*Message` pairs from `src/lib/lineNotifications.js`
  (Task 2) — **re-expressed in TypeScript inline in each function**
  (Deno can't import the Vite-side `.js` file directly across the
  build boundary); keep the TS version's logic identical to the tested
  JS version line-for-line, don't improvise a variant while porting.

**Design notes:** each function is a thin loop: fetch every tenant with
a `line_settings` row, run that tenant's relevant data through the
ported due-check, push a message for every match, then mark whatever
"already notified" field applies so the same thing never pushes twice.

- [ ] **Step 1: `line-push-daily-assignments/index.ts`**

Loop every tenant with `line_settings.crew_group_id` set. For each,
query tomorrow's `worker_assignments` (group by worker), build the
message via a ported `formatAssignmentPushMessage`, and push **one
message per worker to the crew group** (not one giant combined message —
matches the spec's "each worker's next-day assignment," and keeps a
single worker's message findable in a busy group). Use the exact
`worker_assignments` schema/columns already used elsewhere in this
codebase (`src/pages/assign/` — read before writing, don't assume
column names).

- [ ] **Step 2: `line-push-quotation-followups/index.ts`**

Loop every tenant with `line_settings`. For each, fetch `quotations`
where `status = 'sent'` and `follow_up_after_days IS NOT NULL` and
`follow_up_sent_at IS NULL`, run the ported `isQuotationFollowupDue`
per row, and for each due one: push to the tenant's OWNER(s) (via
`user_roles` where `role = 'OWNER'` and `line_user_id IS NOT NULL`) AND
to the specific `quotations.created_by` user's own `line_user_id` (join
`user_roles` on `user_email = quotations.created_by`) if that person has
one linked — **skip silently, don't error,** for anyone without a
linked `line_user_id` (linking is opt-in per Task 6; a user who hasn't
linked yet simply doesn't get pushed to, same as any other
not-yet-configured integration). After pushing, set
`follow_up_sent_at = now()` on that quotation row so it's never sent
twice.

- [ ] **Step 3: `line-push-cheque-reminders/index.ts`**

Loop every tenant with `line_settings`. Read that tenant's
`cheque_reminder_days` app_setting (same key the existing in-app
Dashboard alert already uses — reuse it, don't add a second threshold
setting) and its `cheque_reminder_line_enabled` app_setting (Task 6);
skip tenants where that's not explicitly enabled. For enabled tenants,
fetch `cheques` where `status != 'cashed'`, run the ported
`isChequeReminderDue`, and push to every OWNER with a linked
`line_user_id` (cheques' new `created_by` column exists per Task 1, but
note in the report whether resolving it to an individual the same way
quotations does turned out to be straightforward or not — if the
implementer running this task finds it isn't, falling back to
OWNER-only for cheques specifically is an acceptable, plan-anticipated
deviation, not a defect). No "already sent" guard needed here — the
existing in-app alert already re-shows every day the cheque is within
the threshold, so the LINE push should behave the same way (a daily
nudge until it clears), not a one-time send.

- [ ] **Step 4: `line-push-invoice-due/index.ts`**

Loop every tenant with `line_settings`. Fetch `sites` where
`status = 'Ongoing'`, compute `billing_pct` and `last_invoice_date` the
same way the existing Sites/Dashboard pages already do (read
`src/pages/Sites.jsx`'s `billing_pct` source and whatever query
produces a site's most recent invoice date — reuse those, don't
re-derive a different calculation), run the ported
`isSiteInvoiceDueThisMonth`, and push to every OWNER with a linked
`line_user_id`. Run this one as a monthly schedule (see Step 5), not
daily.

- [ ] **Step 5: Wire Supabase Cron**

```sql
-- supabase/migrations/2026-09-19-02-line-push-cron.sql
--
-- Requires pg_cron and pg_net extensions -- verify both are enabled
-- (`select * from pg_extension where extname in ('pg_cron','pg_net');`)
-- and enable them first if not (Database > Extensions in the Supabase
-- dashboard, or `create extension if not exists pg_cron;` /
-- `create extension if not exists pg_net;` run once via
-- mcp__plugin_supabase_supabase__apply_migration) before this file's
-- own statements will succeed.
--
-- Each cron job POSTs to its Edge Function's own URL with the
-- service-role key as a bearer token (the standard pattern for a
-- scheduled Edge Function invocation) -- the project ref and Edge
-- Function base URL come from mcp__plugin_supabase_supabase__get_project_url.

select cron.schedule(
  'line-push-daily-assignments', '0 11 * * *',  -- 18:00 Asia/Bangkok = 11:00 UTC
  $$ select net.http_post(url := '<EDGE_FUNCTIONS_BASE_URL>/line-push-daily-assignments', headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')) $$
);
select cron.schedule(
  'line-push-quotation-followups', '0 2 * * *',  -- 09:00 Asia/Bangkok
  $$ select net.http_post(url := '<EDGE_FUNCTIONS_BASE_URL>/line-push-quotation-followups', headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')) $$
);
select cron.schedule(
  'line-push-cheque-reminders', '0 2 * * *',
  $$ select net.http_post(url := '<EDGE_FUNCTIONS_BASE_URL>/line-push-cheque-reminders', headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')) $$
);
select cron.schedule(
  'line-push-invoice-due', '0 2 1 * *',  -- 1st of each month, 09:00 Asia/Bangkok
  $$ select net.http_post(url := '<EDGE_FUNCTIONS_BASE_URL>/line-push-invoice-due', headers := jsonb_build_object('Authorization', 'Bearer <SERVICE_ROLE_KEY>')) $$
);
```

Replace `<EDGE_FUNCTIONS_BASE_URL>` and `<SERVICE_ROLE_KEY>` with the
real values before applying (fetch the project URL via
`mcp__plugin_supabase_supabase__get_project_url`; the service role key
is already available to you as the same credential every other task in
this plan uses to apply migrations — never commit the literal key value
into the migration file itself if this repo's convention is to keep
secrets out of committed SQL; check how `omise-create-charge`/other
existing functions' secrets are handled and follow the same convention,
e.g. a Postgres Vault secret referenced by name instead of the literal
key inline, if that's what's already established).

- [ ] **Step 6: Build, deploy, verify**

Each function needs `verify_jwt: true` (these are called by your own
cron job with the service-role key, not by an outside unauthenticated
caller like `line-webhook` is). Deploy all four, then verify each one
manually by invoking it once directly and confirming it processes
without error against real (or a small piece of test) data, before
trusting the cron schedule to run it unattended. Clean up any test
pushes/data afterward.

- [ ] **Step 7: Commit**

```bash
git add supabase/functions/line-push-* supabase/migrations/2026-09-19-02-line-push-cron.sql
git commit -m "feat: scheduled LINE pushes for assignments, quotation follow-ups, cheques, invoice-due"
```

---

### Task 5: Quotations.jsx — send-time follow-up popup

**Files:**
- Modify: `src/pages/Quotations.jsx` (around line 1348's `handleSetStatus` and line 1572's "📤 ส่ง" button — re-read both before editing, this plan's line numbers may have drifted)

**Interfaces:**
- Consumes: `useAppSetting('quotation_followup_default_days', '7')` (Task 6 must land first, or this task stubs the same default inline as `'7'` and Task 6 wires the real setting in — either order works since `useAppSetting` degrades to its fallback value when the key doesn't exist yet).

**Design notes:** the existing "📤 ส่ง" button calls
`handleSetStatus(qt.id, 'sent')` directly. This task inserts a small
confirm step in front of that exact call — it does not change what
`handleSetStatus` itself does for any OTHER status transition.

- [ ] **Step 1: Add popup state and the popup component**

Near the file's other modal-target state (`signTarget`, etc.), add:
```js
const [followupTarget, setFollowupTarget] = useState(null) // quotation row pending the "ส่ง" confirm
```

- [ ] **Step 2: Change the "📤 ส่ง" button to open the popup instead of sending directly**

Replace:
```jsx
<button className="btn btn-sm btn-primary" onClick={() => handleSetStatus(qt.id, 'sent')}>📤 ส่ง</button>
```
with:
```jsx
<button className="btn btn-sm btn-primary" onClick={() => setFollowupTarget(qt)}>📤 ส่ง</button>
```

- [ ] **Step 3: Add the popup, rendered alongside this file's other modals**

```jsx
{followupTarget && (
  <FollowupReminderModal
    quotation={followupTarget}
    onCancel={() => setFollowupTarget(null)}
    onConfirm={async (days) => {
      const target = followupTarget
      setFollowupTarget(null)
      const payload = {
        status: 'sent', ever_sent: true,
        created_by: session?.user?.email || 'system',
        sent_at: new Date().toISOString(),
        follow_up_after_days: days, // null when the user picked "ไม่ต้องเตือน"
      }
      const { error } = await supabase.from('quotations').update(payload).eq('id', target.id)
      if (!error) { await auditLog('quotations', target.id, 'UPDATE', null, payload); refetch(); showToast('ส่งใบเสนอราคาแล้ว') }
      else alert('Error: ' + error.message)
    }}
  />
)}
```

(`session` here must be whatever this file already uses elsewhere to
read the current user's email — check the existing pattern in this same
file, e.g. how `SignLinkModal.jsx` gets `session?.user?.email`, and use
the identical source rather than introducing a second way to read it.)

- [ ] **Step 4: Write the `FollowupReminderModal` component**

```jsx
function FollowupReminderModal({ quotation, onCancel, onConfirm }) {
  const { data: defaultDaysStr } = useAppSetting('quotation_followup_default_days', '7')
  const [days, setDays] = useState(null)
  const [skip, setSkip] = useState(false)
  const effectiveDefault = days ?? parseInt(defaultDaysStr, 10) || 7

  return (
    <Modal title={`ส่งใบเสนอราคา ${quotation.quotation_number}`} onClose={onCancel} maxWidth={420}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        <label className="label">ตั้งเตือนติดตามหลังจากกี่วัน?</label>
        <input type="number" className="input" min="1" disabled={skip}
          value={skip ? '' : effectiveDefault}
          onChange={(e) => setDays(parseInt(e.target.value, 10) || 1)} />
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 13 }}>
          <input type="checkbox" checked={skip} onChange={(e) => setSkip(e.target.checked)} />
          ไม่ต้องเตือน
        </label>
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={onCancel}>ยกเลิก</button>
        <button type="button" className="btn btn-primary" onClick={() => onConfirm(skip ? null : effectiveDefault)}>✅ ส่ง</button>
      </div>
    </Modal>
  )
}
```

Import `useAppSetting` from `../hooks/useSupabase.js` at the top of the
file alongside this file's other existing hook imports.

- [ ] **Step 5: Build and test**

Run: `npm run build && npm test -- --run` (197+ existing tests, no new
ones required for this task — it's a UI wiring change over already-
tested pure logic from Task 2).

- [ ] **Step 6: Live-verify**

Send a test quotation, confirm the popup appears with the tenant
default (or `7` if Task 6 hasn't landed yet) pre-filled, confirm
changing the number and confirming saves `follow_up_after_days`
correctly (check via `execute_sql`), confirm "ไม่ต้องเตือน" saves it as
`null`, confirm `created_by`/`sent_at` are populated correctly either
way. Clean up test data afterward.

- [ ] **Step 7: Commit**

```bash
git add src/pages/Quotations.jsx
git commit -m "feat: follow-up reminder popup on quotation send"
```

---

### Task 6: Settings — LINE connection, per-user linking, preferences

**Files:**
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Produces: `app_settings` keys `quotation_followup_default_days`
  (default `'7'`) and `cheque_reminder_line_enabled` (`'true'`/`'false'`
  string, matching this file's existing boolean-as-string convention —
  check `cheque_reminder_days`'s own neighbor settings for the exact
  existing convention before inventing a different one).

**Design notes:** three additions to this one file — an OWNER-only card
for the tenant's LINE OA connection, an any-role card for a user's own
LINE linking, and two small fields folded into the existing cheque-
reminder card. Read the file's existing card structure (the
`แจ้งเตือนเช็คใกล้ครบกำหนด` card around line 438 the plan already found)
before adding — match its exact layout/save-button pattern, don't
introduce a new settings-card pattern for these three additions.

- [ ] **Step 1: OWNER-only "🔌 LINE" card**

Fields: `channel_id`, `channel_access_token`, `channel_secret` (mask
this one, e.g. `type="password"`, same as any other secret field
elsewhere in this file), `crew_group_id`. On save: upsert into
`line_settings` keyed by `tenant_id` (the table's own PK, per Task 1 —
`onConflict: 'tenant_id'`). Gate the whole card on OWNER role, matching
this file's existing pattern for other OWNER-only cards (check how an
existing OWNER-only card in this file checks the role before rendering,
and use the identical check).

- [ ] **Step 2: Any-role "เชื่อมต่อ LINE ของฉัน" card**

On mount, if the current user's own `user_roles` row has no
`line_user_id` yet, show a "🔗 สร้างรหัสเชื่อมต่อ" button; clicking it
generates a random code (e.g. 6 alphanumeric characters — collisions are
already prevented by Task 1's unique index on `line_link_code`, so a
generate-and-retry-on-conflict loop is enough, no need for a
cryptographically exotic generator), saves it to that user's own
`user_roles.line_link_code` row, and displays it with the instruction
"ส่งข้อความนี้หาบัญชี LINE ของบริษัทเพื่อเชื่อมต่อ" (send this message
to the company's LINE account to connect). If already linked, show
"✅ เชื่อมต่อแล้ว" with an "ยกเลิกการเชื่อมต่อ" (unlink) option that
clears `line_user_id`.

- [ ] **Step 3: Extend the existing cheque-reminder card**

Add a toggle next to the existing `cheque_reminder_days` input:
"ส่งแจ้งเตือนไป LINE ด้วย" bound to the new
`cheque_reminder_line_enabled` app_setting, saved the same way the
existing `chequeReminderDays` value already saves in this same card
(reuse the exact save handler pattern, just add the one new field to
its payload).

- [ ] **Step 4: Build, test, live-verify**

`npm run build && npm test -- --run`. Live-verify: an OWNER can save
LINE settings and see them persist on reload; any role can generate a
linking code, see it displayed, and (paired with Task 3's `line-webhook`
already being live) actually complete the link by DMing the code to a
real test LINE OA if one is available for testing — if no real LINE OA
is available to test against at this point in implementation, verify
the code-generation/storage half only and note in the report that the
full round-trip needs a real LINE OA credential to verify end-to-end.

- [ ] **Step 5: Commit**

```bash
git add src/pages/Settings.jsx
git commit -m "feat: LINE connection settings + per-user account linking"
```

---

### Task 7: Admin UI — resolve unrecognized crew senders

**Files:**
- Modify: `src/pages/HR.jsx` (or wherever this codebase's existing
  Workers management UI lives — confirm the exact file before starting;
  this plan's earlier tasks reference `src/pages/HR.jsx` for leave-type
  constants but the actual Workers list/edit UI may live in a different
  file under `src/pages/` — find it first, don't assume)

**Interfaces:**
- Consumes: `line_unlinked_senders` (Task 1), `workers` (existing).

**Design notes:** a small addition, not a new page. When
`line_unlinked_senders` has any unresolved rows (`linked_worker_id IS
NULL`) for the current tenant, show a compact "📱 พบผู้ส่งข้อความ LINE
ที่ยังไม่เชื่อมต่อ (N)" banner or section wherever the Workers list
already renders, listing each unresolved sender's `display_name`
(or a fallback like "ไม่ทราบชื่อ" if LINE didn't supply one) with a
worker picker (reuse this codebase's existing worker-select component —
find and reuse it, e.g. if `QuickAddSelect`/`SearchableSelect` already
used elsewhere in this file for a similar "pick an existing worker"
input). Selecting a worker sets `workers.line_user_id =
line_unlinked_senders.line_user_id` and
`line_unlinked_senders.linked_worker_id` (mark it resolved, keep the
row for history rather than deleting it).

- [ ] **Step 1: Find the real Workers management file and its existing worker-picker component**

- [ ] **Step 2: Add the unresolved-senders section and resolve action**

- [ ] **Step 3: Build, test, live-verify**

`npm run build && npm test -- --run`. Live-verify by inserting a test
`line_unlinked_senders` row directly via `execute_sql`, confirming it
appears in the UI, resolving it to a real test worker, confirming
`workers.line_user_id` updates correctly. Clean up test data afterward.

- [ ] **Step 4: Commit**

```bash
git add <the real file found in Step 1>
git commit -m "feat: admin UI to link unrecognized LINE senders to workers"
```

---

## Final Integration Notes (for the controller, not a task)

- After all 7 tasks: a real end-to-end smoke test needs an actual LINE
  Official Account and channel credentials to be genuinely meaningful —
  earlier tasks can verify their own pieces in isolation (webhook logic
  with a hand-constructed signed request, scheduled functions invoked
  directly, UI wiring against the database) but nobody in this plan can
  fully verify "a real LINE message arrives / gets sent" without a real
  LINE OA. Flag this explicitly to the user before considering the
  feature "done" — provisioning a test LINE OA (or using the real one,
  carefully) is a step outside this plan's own scope.
- Per this project's "Update Manual On Push" standing rule, both manual
  copies need a new entry for this feature once it's live — not part of
  any task above, raise it explicitly when this plan completes.
- This plan does not build the "Knowledge Management system" the spec
  explicitly deferred — `line_issue_reports` is capture-only. If a
  reviewer judges that too thin to be useful without at least a list
  view, that's a legitimate finding to raise during review, not
  something to silently expand scope to fix.
