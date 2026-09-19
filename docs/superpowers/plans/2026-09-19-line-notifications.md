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
-- existing app_settings table instead -- see Task 7.

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
setting) and its `cheque_reminder_line_enabled` app_setting (Task 7);
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
- Consumes: `useAppSetting('quotation_followup_default_days', '7')` (Task 7 must land first, or this task stubs the same default inline as `'7'` and Task 7 wires the real setting in — either order works since `useAppSetting` degrades to its fallback value when the key doesn't exist yet).

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
default (or `7` if Task 7 hasn't landed yet) pre-filled, confirm
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

### Task 6: Settings → ทั่วไป — personal LINE account linking

**Revised scope (mid-plan restructure — see the "Nav restructure" note
at the end of this task):** originally this task also carried the
OWNER-only channel-config card and the cheque/quotation reminder
toggles. Those moved to Task 7's new dedicated OWNER/ADMIN page instead,
so a WORKER opening this page never sees OWNER-only channel secrets
anywhere near their own "connect my LINE" action. This task is now
small: one any-role card.

**Files:**
- Modify: `src/pages/Settings.jsx`

**Interfaces:**
- Consumes: nothing new from other tasks.
- Produces: nothing other tasks consume (Task 7's page is fully
  independent of this one).

**Design notes:** `Settings.jsx` already mixes tenant-wide OWNER-only
cards with role-agnostic personal cards on one page, split entirely by
inline `isAtLeast()` checks — not by file separation (confirmed live:
the `settings` tab has `minRole: 'WORKER'` in `src/App.jsx`, reachable
by every role, with a comment at `Settings.jsx` lines 49-59 explicitly
documenting this: "WORKER sees only the password card, ADMIN
additionally sees the signature card, OWNER sees the rest of the page
unchanged"). The existing "👤 บัญชีผู้ใช้" card (lines 391-398) is the
established precedent for a card with **no role gate at all** — any
role sees it:

```jsx
<div className="card" ...>
  <h2>👤 บัญชีผู้ใช้</h2>
  <p>จัดการรหัสผ่านสำหรับเข้าสู่ระบบของคุณ</p>
  <button className="btn btn-ghost" onClick={onOpenChangePassword}>🔑 เปลี่ยนรหัสผ่าน</button>
</div>
```

Add the new LINE-linking card immediately alongside this one, with the
same "no gate" treatment.

- [ ] **Step 1: Add the "🔗 เชื่อมต่อ LINE ของฉัน" card**

Add a new `<div className="card">` block right next to the "👤
บัญชีผู้ใช้" card found above (same section of the file, same visual
weight, no `isAtLeast` gate — every role from WORKER up sees it).

State: on mount, read the current user's own `user_roles` row (however
this file already resolves "my own user_roles row" elsewhere — check
the existing pattern used by the personal cards already in this file,
e.g. how the "👤 บัญชีผู้ใช้"/signature cards identify "me" via
`session.user.email` joined against `user_roles.user_email`; reuse that
exact lookup, don't introduce a second way to find "my own row").

- If `line_user_id` is not set: show a "🔗 สร้างรหัสเชื่อมต่อ" button.
  Clicking it generates a random 6-character alphanumeric code (collisions
  are already prevented by Task 1's unique index on `line_link_code`, so
  a generate-and-retry-on-conflict loop is enough — no need for a
  cryptographically exotic generator), saves it to that user's own
  `user_roles.line_link_code` via a plain `update(...).eq('id', myRoleId)`,
  and displays the code with the instruction "ส่งข้อความนี้หาบัญชี LINE
  ของบริษัทเพื่อเชื่อมต่อ" (send this message to the company's LINE
  account to connect).
- If `line_user_id` IS set: show "✅ เชื่อมต่อแล้ว" with a
  "ยกเลิกการเชื่อมต่อ" (unlink) button that clears `line_user_id` (and
  `line_link_code`, in case one was left over) via `update(...)`.

- [ ] **Step 2: Build, test, live-verify**

`npm run build && npm test -- --run`. Live-verify: as a WORKER-role test
account (or by temporarily checking the rendered page against a WORKER
session), confirm the card is visible and generates/displays a code;
confirm clicking again after linking shows the "เชื่อมต่อแล้ว" state
instead. A full round-trip test (actually DMing the code to a real LINE
OA) is optional here since Tasks 1-3 already proved this exact DM-linking
mechanism live against a real, connected LINE Official Account — this
step only needs to confirm the UI reads/writes the right `user_roles`
fields, not re-prove the webhook side.

- [ ] **Step 3: Commit**

```bash
git add src/pages/Settings.jsx
git commit -m "feat: personal LINE account linking in Settings"
```

---

### Task 7: การสื่อสาร — new OWNER/ADMIN-only Communication tab

**Why a new top-level tab, not a Settings card (mid-plan restructure):**
originally this content was split between a Settings card (channel
config + reminder toggles) and a Workers-page addition (unresolved
senders). Live review of a UI mockup surfaced that bundling OWNER-only
channel secrets into the same page WORKERs already need to visit (for
their own "connect my LINE" card, Task 6) was confusing and felt
insecure even though the fields were correctly role-gated. Resolution:
everything OWNER/ADMIN-facing about LINE moves to its own dedicated,
OWNER-gated top-level tab; the only thing that stays in Settings is
Task 6's any-role personal-linking card.

**Files:**
- Create: `src/pages/LineComms.jsx`
- Modify: `src/App.jsx` (nav entry + lazy import + `renderPage` switch)
- Modify: `src/lib/permissions.js` (label + default permission entry)

**Interfaces:**
- Consumes: `line_settings`, `line_unlinked_senders`, `workers` (Task
  1), `app_settings` via `useAppSetting`/`saveAppSetting` (existing
  hook).
- Produces: `app_settings` keys `quotation_followup_default_days`
  (default `'7'`, consumed by Task 5's popup) and
  `cheque_reminder_line_enabled` (`'true'`/`'false'` string — check
  `Settings.jsx`'s existing `cheque_reminder_days` neighbor setting for
  this schema's exact boolean-as-string convention before writing a new
  one).

**Design notes — nav wiring (confirmed live against the real files):**
`src/App.jsx` defines top-level navigation as a config array, `TABS`
(lines 50-90) — either a plain `{id, label, minRole, module}` entry or a
group `{label, children: [...]}`. Visibility is driven entirely by
`minRole` (`'WORKER'|'ADMIN'|'OWNER'`) through `passesGates()` (lines
253-257) and `visibleTabs` (lines 380-382) — an entry whose gate fails
simply never renders, no per-page redirect logic needed. There's already
a working precedent for an OWNER-only top-level entry:
`{ id: 'user_management', label: '👤 ผู้ใช้งาน', minRole: 'OWNER', module: null }`
inside the `⚙️ ตั้งค่า` group. Follow that exact shape.

- [ ] **Step 1: Register the new tab in `src/App.jsx`**

Add a new standalone top-level entry to `TABS` (not nested under the
`⚙️ ตั้งค่า` group — this is deliberately a peer of ตั้งค่า, not a child
of it, since it's a distinct destination for a distinct audience):

```js
{ id: 'line_comms', label: '📱 การสื่อสาร', minRole: 'OWNER', module: null },
```

Place it near the other standalone top-level entries (not inside any
`children: [...]` group).

Register the lazy import alongside the file's other page imports (in
the lazy-import block, ~lines 25-48 — match the exact `React.lazy(() =>
import('./pages/XYZ.jsx'))` shape already used there):

```js
const LineComms = lazy(() => import('./pages/LineComms.jsx'))
```

Add a `case` to `renderPage()`'s switch (lines 337-364, matching the
existing cases' shape — check what props neighboring cases pass, e.g.
`session`, and pass the same ones this new page needs):

```js
case 'line_comms': return <LineComms session={session} />
```

- [ ] **Step 2: Register the page in `src/lib/permissions.js`**

Add a `PAGE_LABELS` entry and a `DEFAULT_PERMISSIONS` entry for
`line_comms` (lines 14-118 — match the exact shape of the
`user_management` entry already there, since both are OWNER-only
top-level pages with the same visibility model) so this new page shows
up correctly in the OWNER's role-permission matrix UI (the same one
Settings already exposes for every other page).

- [ ] **Step 3: Write `src/pages/LineComms.jsx`**

A single page, three cards, reusing this codebase's existing `card`
class and save-button conventions (match `Settings.jsx`'s own card
markup shape exactly — same classNames, same button styles — since this
page is visually a sibling of Settings, just relocated):

**Card 1 — "🔌 LINE"** (channel connection):
Fields: `channel_id`, `channel_access_token` (masked, `type="password"`
with a show/hide toggle button — match whatever masked-field pattern
already exists elsewhere in this codebase, e.g. `Settings.jsx`'s own
password-related fields if any exist, otherwise a plain toggle), `channel_secret`
(masked, same treatment), `crew_group_id`. On save: upsert into
`line_settings` keyed by `tenant_id` (`onConflict: 'tenant_id'`). This
whole page is already OWNER-gated at the nav level (Step 1), so no
additional inline role check is needed inside the component itself —
unlike `Settings.jsx`'s pattern of one page with mixed inline gates,
this page is 100% single-audience.

Also on this same card (or immediately below it, your call on visual
grouping — keep it in the same card if it fits without crowding): a
`quotation_followup_default_days` number input (default `7`), saved via
`saveAppSetting('quotation_followup_default_days', value)`.

**Card 2 — "🏦 เช็คใกล้ครบกำหนด → LINE"**:
A single toggle bound to the new `cheque_reminder_line_enabled`
app_setting, saved via `saveAppSetting(...)`. Read (but do NOT
duplicate-edit) the existing `cheque_reminder_days` value from
`app_settings` (via `useAppSetting('cheque_reminder_days', '3')`) and
show it as plain read-only text: "อ้างอิงเกณฑ์ X วันจากตั้งค่า → ทั่วไป"
(the threshold field itself stays owned by `Settings.jsx`, unrelated to
LINE and pre-existing — this card only adds the LINE-push toggle, not a
second copy of the threshold input).

**Card 3 — "📱 ผู้ส่งข้อความ LINE ที่ยังไม่เชื่อมต่อ"** (moved from the
plan's original Task 7): when `line_unlinked_senders` has any
unresolved rows (`linked_worker_id IS NULL`) for the current tenant,
show each one — `display_name` (fall back to "ไม่ทราบชื่อ" if null,
matching the mockup) — with a worker-picker `<select>` (reuse this
codebase's existing worker-list-fetching pattern, e.g. however
`Settings.jsx` or `HR.jsx` already fetches a plain list of `workers` for
a dropdown — don't introduce a new fetch pattern) and a "เชื่อมต่อ"
button. Selecting a worker and confirming sets `workers.line_user_id =
line_unlinked_senders.line_user_id` and
`line_unlinked_senders.linked_worker_id` (mark resolved, keep the row
for history — don't delete it). If there are zero unresolved rows,
don't render this card at all (not even an empty-state — Card 1/2 are
always-relevant configuration, Card 3 is conditional).

- [ ] **Step 4: Build, test, live-verify**

`npm run build && npm test -- --run`. Live-verify as an OWNER session:
the new "📱 การสื่อสาร" tab appears in the nav, Card 1 saves and persists
real `line_settings` fields correctly (there is already a REAL row for
this exact tenant from the live proof done earlier in this plan's
execution — be careful not to corrupt `channel_access_token`/
`channel_secret`/`bot_user_id`/`crew_group_id` on that real row; read it
first, confirm the form round-trips it correctly, and if you must write
test values, use a different tenant, never overwrite the real
production row's real credentials), Card 2's toggle saves and its
read-only reference text shows the right threshold value, Card 3 (insert
one throwaway `line_unlinked_senders` test row via `execute_sql` against
a disposable/different tenant or with a clearly fake `line_user_id` you
clean up immediately after) resolves correctly and disappears from the
list. Also confirm as a WORKER or ADMIN session that the tab itself does
not appear in the nav at all.

- [ ] **Step 5: Commit**

```bash
git add src/pages/LineComms.jsx src/App.jsx src/lib/permissions.js
git commit -m "feat: dedicated OWNER Communication tab for LINE channel config, office reminders, unresolved senders"
```

---

### Task 8: Crew Rich Menu — button-driven actions via 1:1 DM

**Added mid-plan, after Tasks 1-4 shipped and were live-proven against a
real LINE OA.** The user asked for crew actions (แจ้งปัญหา/ขอเบิกของ/ขอลา)
to be button-driven instead of typed. **Real LINE platform constraint,
confirmed before this task was written:** Rich Menus only render in a
1:1 chat between a user and the bot — they never appear inside a group
chat. Resolution (explicit user decision, not a plan default): the crew
group stays exactly as-is for typed keywords (Tasks 1-4's existing
behavior, unchanged); this task ADDS a second, parallel path — a worker
can also DM the bot directly and use Rich Menu buttons there. Both paths
lead to the same three outcomes (`line_issue_reports` /
`line_issue_reports` tagged / `worker_assignments` leave row); neither
replaces the other.

**Design — two-step buttons (explicit user choice over one-tap):**
tapping any of the three buttons doesn't submit anything by itself — it
sets a short-lived "pending action" for that worker and asks them to
type the detail; their very next DM is then treated as that action's
body (issue description, material list, or leave note), exactly the way
today's group-typed messages already carry a description. This applies
uniformly to all three actions, including ลา (the user picked the
uniform two-step design over a leave-is-one-tap-only hybrid, since
that's simpler to build as one mechanism).

**Files:**
- Create: `supabase/migrations/2026-09-19-07-line-pending-actions.sql`
- Create: `scripts/generate-line-richmenu.py`
- Modify: `supabase/functions/line-webhook/index.ts` (this is the file
  Task 3 built and two fix rounds already touched — re-read it fresh
  before starting; the version reproduced below matches its state as of
  commit `4cef7c8`, but confirm nothing has changed since)
- Modify: `supabase/functions/_shared/line.ts` (add one function,
  `linkRichMenuToUser` — this file is also used unchanged by the four
  `line-push-*` functions from Task 4; only ADD to it, don't restructure
  anything those functions rely on)

**Scoping constraint (added after Task 8 was first drafted):** the
user confirmed live this tenant's real LINE OA is also used for
sales/customer info (a Google-Script-driven outbound automation already
runs on it) — not internal-only. The crew Rich Menu must therefore
NEVER be set as this bot's default menu for all users (that would put
crew buttons in front of real customers). LINE supports linking a Rich
Menu to one specific user id instead of setting a bot-wide default —
this task uses that per-user mechanism exclusively; the "set as default
for all users" endpoint is never called anywhere in this task.

**Interfaces:**
- Consumes: `sendLineReply` from `_shared/line.ts` (unchanged); the real
  channel_access_token on the real, live-connected tenant's
  `line_settings` row (needed only for the one-time Rich Menu
  creation/upload — NOT touched by any redeploy of the webhook itself).
- Produces: `line_pending_actions` table, consumed only by this same
  function (no other task reads it).

**Global constraint reminder specific to this task:** the real tenant
(`1b9affc4-2136-4ed1-b168-a36e6624e743`) has a real, live LINE OA with
real crew members already capable of messaging it. Creating/uploading a
Rich Menu and setting it as the default menu for all users of this bot
is a REAL, user-visible change the moment it's done — every real friend
of this real bot will see the new menu immediately. This is intended
(the user asked for this feature), but test the webhook logic (postback
handling, pending-action consumption) via hand-signed test requests
FIRST, the same way Task 3 did, before doing the one-time live Rich Menu
upload — don't upload the real menu until the code behind it is already
proven correct.

- [ ] **Step 1: Migration — `line_pending_actions`**

```sql
-- supabase/migrations/2026-09-19-07-line-pending-actions.sql
--
-- Tracks a crew member's in-progress two-step Rich Menu action (tap a
-- button -> we ask for detail -> their next DM is the detail). One row
-- per worker at a time (a second tap before finishing the first just
-- overwrites it, upsert-style) with a short expiry so a stray unrelated
-- DM days later can never get misread as an old action's detail.

CREATE TABLE line_pending_actions (
  id          UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  tenant_id   UUID NOT NULL,
  worker_id   UUID NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  action      TEXT NOT NULL CHECK (action IN ('issue_report','material_request','leave')),
  created_at  TIMESTAMPTZ DEFAULT NOW(),
  expires_at  TIMESTAMPTZ NOT NULL
);
CREATE UNIQUE INDEX idx_line_pending_actions_worker ON line_pending_actions(worker_id);

ALTER TABLE line_pending_actions ENABLE ROW LEVEL SECURITY;
CREATE POLICY admin_reads ON line_pending_actions FOR SELECT TO authenticated
  USING (is_admin_or_owner() AND tenant_id = current_tenant_id());
-- No client insert/update/delete policy -- only ever written by
-- line-webhook via its service-role client, same as line_issue_reports.

-- This tenant's real LINE OA is ALSO used for sales/customer info (user
-- confirmed live) -- the crew Rich Menu must NOT become this bot's
-- default menu for every friend, or real customers would see "แจ้ง
-- ปัญหา/ขอเบิกของ/ขอลา" buttons. LINE supports linking a Rich Menu to a
-- SPECIFIC user id instead of setting a bot-wide default -- this column
-- holds the one crew menu's id (set once, in Step 6) so the webhook can
-- link it to individual workers as they're recognized, rather than
-- ever calling the "set as default for all users" endpoint.
ALTER TABLE line_settings ADD COLUMN crew_rich_menu_id TEXT;

-- Tracks whether a given worker has already had the crew Rich Menu
-- linked to their personal LINE account, so the webhook doesn't
-- re-call LINE's per-user-link API on every single message (idempotent
-- either way, but no reason to pay the extra HTTP round-trip
-- repeatedly).
ALTER TABLE workers ADD COLUMN line_rich_menu_linked_at TIMESTAMPTZ;
```

Apply via `mcp__plugin_supabase_supabase__apply_migration`, project_id
`yyzbgdmgyvvypfcjuhtr`. Verify the table, index, RLS policy, and both
new columns exist.

- [ ] **Step 2: Add `linkRichMenuToUser` to `_shared/line.ts`**

Add this one function to the existing file (alongside
`verifyLineSignature`/`sendLinePush`/`sendLineReply` — don't change
those three at all):

```ts
export async function linkRichMenuToUser(accessToken: string, lineUserId: string, richMenuId: string): Promise<{ ok: boolean; status: number }> {
  const res = await fetch(`https://api.line.me/v2/bot/user/${lineUserId}/richmenu/${richMenuId}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}` },
  })
  return { ok: res.ok, status: res.status }
}
```

This links a Rich Menu to ONE specific user — deliberately not
`/v2/bot/user/all/richmenu/{id}` (the "set as default for everyone"
endpoint), which this task never calls anywhere, since this tenant's
real LINE OA is also used for sales/customer info and must never show
crew buttons to a customer.

- [ ] **Step 3: Rewrite `line-webhook/index.ts`**

Re-read the file fresh first (it may have drifted from what's shown
here if another task touched it since). Apply this restructuring:
extract the three existing action bodies (issue report / material
request / leave) into one shared `handleAction` function so both the
existing group-keyword path and the new DM-pending-action path call the
identical logic instead of duplicating it; add postback handling; add
DM-side pending-action consumption ahead of the existing linking-code
check reuse.

```ts
// supabase/functions/line-webhook/index.ts
// Inbound LINE webhook -- receives every event for every tenant's LINE
// OA on one shared URL, routes by the webhook payload's own
// `destination` field (the bot's own internal LINE userId, from LINE's
// GET /v2/bot/info -- NOT the numeric Channel ID shown in LINE's
// console) against line_settings.bot_user_id. verify_jwt is OFF for
// this function (LINE itself calls it, unauthenticated by Supabase's
// own JWT check) -- this function's signature verification against
// line_settings.channel_secret IS the access control, same pattern
// sign-link already established for its own public/unauthenticated
// endpoint.
//
// Two parallel paths into the same three crew actions (see
// docs/superpowers/specs/2026-09-19-line-notifications-design.md and
// this plan's Task 8): typed keywords in the shared crew group
// (original design), and Rich Menu buttons in a 1:1 DM with the bot
// (Task 8 addition -- LINE Rich Menus cannot render inside a group
// chat, so this had to be a second path, not a replacement). Both
// funnel into the same handleAction() below.
//
// Keyword sets are tuned to avoid real collisions found in review (bare
// "ปัญหา" matches "ไม่มีปัญหา" = "no problem"; bare "ลา" matches ตลาด/
// ปลา/ฉลาด):
//   "ปัญหา" minus negations -> line_issue_reports row
//   "อยากเบิก"/"ขอเบิก"      -> see note below, NOT a purchase_orders
//                                 row -- the schema can't support that
//                                 yet (see comment at that branch)
//   "ลากิจ"/"ลาป่วย"/"ขอลา"/"อยากลา" -> worker_assignments row (leave_personal)
// plus a bare linking code sent as a DM, Track B's one-time OWNER/ADMIN
// account-linking flow (Settings -> ทั่วไป issues the code).
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { verifyLineSignature, sendLineReply, linkRichMenuToUser } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
}
function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } })
}

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
function bangkokToday(): string {
  return new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
}

// This tenant's real LINE OA is ALSO used for sales/customer info -- the
// crew Rich Menu is NEVER set as the bot's default for everyone (that
// would put crew buttons in front of real customers). Instead it's
// linked per-user, lazily, the first time a recognized worker is seen
// in a 1:1 DM (the only context Rich Menus render in at all). Idempotent
// on LINE's side either way, but line_rich_menu_linked_at avoids the
// repeat API call on every subsequent message from an already-linked worker.
async function ensureCrewRichMenuLinked(
  worker: { id: string; line_user_id: string | null; line_rich_menu_linked_at: string | null },
  settings: { channel_access_token: string; crew_rich_menu_id: string | null },
) {
  if (!settings.crew_rich_menu_id || worker.line_rich_menu_linked_at || !worker.line_user_id) return
  const { ok } = await linkRichMenuToUser(settings.channel_access_token, worker.line_user_id, settings.crew_rich_menu_id)
  if (ok) {
    const { error } = await admin.from('workers').update({ line_rich_menu_linked_at: new Date().toISOString() }).eq('id', worker.id)
    if (error) console.error('workers.line_rich_menu_linked_at update failed', error)
  } else {
    console.error('linkRichMenuToUser failed for worker', worker.id)
  }
}

type ActionType = 'issue_report' | 'material_request' | 'leave'

function promptForAction(action: ActionType): string {
  if (action === 'issue_report') return '🚧 บอกรายละเอียดปัญหาได้เลยครับ'
  if (action === 'material_request') return '📦 บอกรายการของที่ต้องการเบิกได้เลยครับ'
  return '🏖️ บอกรายละเอียดวันที่ลาได้เลยครับ'
}

// Shared by both the group-keyword path and the DM Rich-Menu path --
// exactly the three action bodies Task 3 originally wrote inline,
// unchanged in behavior, just callable from two call sites now.
async function handleAction(
  action: ActionType,
  worker: { id: string; name: string },
  text: string,
  settings: { tenant_id: string; channel_access_token: string },
  replyToken: string,
) {
  if (action === 'issue_report') {
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: text })
    if (error) {
      console.error('line_issue_reports insert failed', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '📩 รับแจ้งปัญหาแล้ว แอดมินจะติดตามให้')
    }
  } else if (action === 'material_request') {
    // NOT a purchase_orders insert -- confirmed against the live schema
    // (2026-09-19): purchase_orders_status_check only allows
    // ('ordered','received','cancelled'), there is no 'draft' value, and
    // site_id/supplier_id/category_id are all NOT NULL FKs (RESTRICT)
    // that a bare crew text message has no way to supply. See Task 3's
    // original comment for the full rationale -- unchanged here.
    const { error } = await admin.from('line_issue_reports').insert({ tenant_id: settings.tenant_id, worker_id: worker.id, message: `[ขอเบิกของ] ${text}` })
    if (error) {
      console.error('line_issue_reports insert failed (material request)', error)
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ ระบบขัดข้อง กรุณาแจ้งแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '📦 รับคำขอเบิกของแล้ว แอดมินจะตรวจสอบและออกใบสั่งซื้อให้')
    }
  } else {
    const { error } = await admin.from('worker_assignments').insert({
      tenant_id: settings.tenant_id,
      worker_id: worker.id,
      date: bangkokToday(),
      shift: 'morning',
      type: 'leave_personal',
      site_id: null,
      notes: text,
    })
    if (error) {
      await sendLineReply(settings.channel_access_token, replyToken, '⚠️ วันนี้มีคิวงานอยู่แล้ว กรุณาติดต่อแอดมินโดยตรง')
    } else {
      await sendLineReply(settings.channel_access_token, replyToken, '🏖️ รับคำขอลาแล้ว แอดมินจะตรวจสอบให้')
    }
  }
}

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders })
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)

  const rawBody = await req.text()
  let payload: Record<string, unknown>
  try {
    payload = JSON.parse(rawBody)
  } catch {
    return json({ error: 'Invalid JSON body' }, 400)
  }
  const destination = payload.destination as string | undefined
  if (!destination) return json({ error: 'destination required' }, 400)

  const { data: settings } = await admin.from('line_settings').select('*').eq('bot_user_id', destination).maybeSingle()
  if (!settings) return json({ error: 'unknown channel' }, 404)

  const signatureOk = await verifyLineSignature(settings.channel_secret, rawBody, req.headers.get('x-line-signature'))
  if (!signatureOk) return json({ error: 'invalid signature' }, 401)

  const events = (payload.events as Array<Record<string, any>>) ?? []
  for (const event of events) {
    const lineUserId: string | undefined = event.source?.userId
    const sourceGroupId: string | undefined = event.source?.groupId
    if (!lineUserId) continue

    // Rich Menu button tap -- only ever fires from a 1:1 DM (LINE
    // doesn't render Rich Menus inside groups, so this branch can't be
    // reached from a group event in practice, but the code doesn't need
    // to assume that -- it just resolves the worker and proceeds).
    if (event.type === 'postback') {
      const action = new URLSearchParams(event.postback?.data ?? '').get('action') as ActionType | null
      if (action !== 'issue_report' && action !== 'material_request' && action !== 'leave') continue
      const { data: worker } = await admin.from('workers').select('id, name, line_user_id, line_rich_menu_linked_at').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
      if (!worker) continue // a Rich Menu tap from someone not a recognized worker -- nothing useful to do without a group context to capture them the way line_unlinked_senders does
      await ensureCrewRichMenuLinked(worker, settings)
      const expiresAt = new Date(Date.now() + 30 * 60 * 1000).toISOString()
      const { error } = await admin.from('line_pending_actions').upsert(
        { tenant_id: settings.tenant_id, worker_id: worker.id, action, expires_at: expiresAt },
        { onConflict: 'worker_id' }
      )
      if (error) console.error('line_pending_actions upsert failed', error)
      await sendLineReply(settings.channel_access_token, event.replyToken, promptForAction(action))
      continue
    }

    if (event.type !== 'message' || event.message?.type !== 'text') continue
    const text: string = event.message.text

    if (!sourceGroupId) {
      // DM -- either (a) an OWNER/ADMIN's bare linking code (existing
      // Track B flow, unchanged), or (b) a worker's reply to a pending
      // Rich Menu action (Task 8 addition). Linking-code match is
      // checked first since it's a narrower, more specific match.
      const { data: pendingCode } = await admin.from('user_roles').select('id').eq('tenant_id', settings.tenant_id).eq('line_link_code', text.trim()).maybeSingle()
      if (pendingCode) {
        const { error } = await admin.from('user_roles').update({ line_user_id: lineUserId, line_link_code: null }).eq('id', pendingCode.id)
        if (error) {
          console.error('user_roles line-link update failed', error)
          await sendLineReply(settings.channel_access_token, event.replyToken, '⚠️ เชื่อมต่อไม่สำเร็จ กรุณาลองใหม่หรือแจ้งแอดมิน')
        } else {
          await sendLineReply(settings.channel_access_token, event.replyToken, '✅ เชื่อมต่อ LINE เรียบร้อยแล้ว')
        }
        continue
      }

      const { data: worker } = await admin.from('workers').select('id, name, line_user_id, line_rich_menu_linked_at').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
      if (worker) {
        await ensureCrewRichMenuLinked(worker, settings)
        const { data: pending } = await admin.from('line_pending_actions').select('*').eq('worker_id', worker.id).gt('expires_at', new Date().toISOString()).maybeSingle()
        if (pending) {
          const { error: deleteError } = await admin.from('line_pending_actions').delete().eq('id', pending.id)
          if (deleteError) console.error('line_pending_actions delete failed', deleteError)
          await handleAction(pending.action as ActionType, worker, text, settings, event.replyToken)
        }
        // A linked worker DMing the bot with no pending action (e.g. they
        // never tapped a Rich Menu button first) is out of scope for v1 --
        // silently ignored. Free typing of keywords only works in the
        // crew group, matching the original design; DM-only keyword
        // typing was not asked for and is not built here.
      }
      continue
    }

    // A message from the crew group -- only act on it if it's actually
    // that tenant's configured crew group.
    if (sourceGroupId !== settings.crew_group_id) continue

    const { data: worker } = await admin.from('workers').select('id, name').eq('line_user_id', lineUserId).eq('tenant_id', settings.tenant_id).maybeSingle()
    if (!worker) {
      const { error: unlinkedError } = await admin.from('line_unlinked_senders').upsert(
        { tenant_id: settings.tenant_id, line_user_id: lineUserId, display_name: event.source?.userId ?? null },
        { onConflict: 'tenant_id,line_user_id', ignoreDuplicates: true }
      )
      if (unlinkedError) console.error('line_unlinked_senders upsert failed', unlinkedError)
      continue
    }

    // Keyword-based triggers -- simple substring match, not NLP, tuned
    // against real collisions found in review: a bare "ปัญหา" also
    // matches "ไม่มีปัญหา"/"ไม่ปัญหา" ("no problem"), and a bare "ลา"
    // matches ordinary words like ตลาด/ปลา/ฉลาด with zero relation to
    // leave. Each set is chosen so no phrase is a substring of another
    // branch's phrase, keeping the ปัญหา -> เบิก -> ลา routing order
    // unambiguous.
    const isIssueReport = text.includes('ปัญหา') && !text.includes('ไม่มีปัญหา') && !text.includes('ไม่ปัญหา')
    const isMaterialRequest = ['อยากเบิก', 'ขอเบิก'].some((kw) => text.includes(kw))
    const isLeaveRequest = ['ลากิจ', 'ลาป่วย', 'ขอลา', 'อยากลา'].some((kw) => text.includes(kw))

    if (isIssueReport) await handleAction('issue_report', worker, text, settings, event.replyToken)
    else if (isMaterialRequest) await handleAction('material_request', worker, text, settings, event.replyToken)
    else if (isLeaveRequest) await handleAction('leave', worker, text, settings, event.replyToken)
  }

  return json({ ok: true })
})
```

Deploy via `mcp__plugin_supabase_supabase__deploy_edge_function`,
`verify_jwt: false` (unchanged from Task 3), including the unchanged
`_shared/line.ts` file alongside it exactly as prior deploys did.

- [ ] **Step 4: Test the code path BEFORE touching the real Rich Menu**

Using the same hand-signed-HMAC-test-POST technique Task 3 used
throughout, against a disposable test tenant + fake `line_settings`
row (never the real tenant for this step):
1. A postback event (`event.type: 'postback'`, `postback.data:
   'action=issue_report'`) from a linked test worker's fake `userId` ->
   confirm a `line_pending_actions` row appears with the right
   `worker_id`/`action`/a future `expires_at`, and the reply matches
   `promptForAction('issue_report')`.
2. A follow-up text-message event (DM, no groupId) from that same fake
   `userId` -> confirm the pending row is deleted AND a real
   `line_issue_reports` row appears with the message text, matching what
   `handleAction` would produce.
3. An expired pending row (insert one directly via `execute_sql` with
   `expires_at` in the past) followed by a DM text message -> confirm
   NOTHING is created (the `gt('expires_at', now)` filter correctly
   excludes it) and the message is silently ignored, matching the
   documented "no pending action -> ignored" behavior.
4. Confirm the original group-keyword path (Task 3's original tests)
   still passes unchanged -- this refactor must not alter that behavior,
   only add to it.
Clean up all test rows afterward.

- [ ] **Step 5: Generate the Rich Menu image**

```python
# scripts/generate-line-richmenu.py
#
# Produces a LINE Rich Menu image: 2500x1686px, 3 equal horizontal
# tappable zones (LINE's minimum/maximum Rich Menu image size is well
# documented and fixed -- this is the "full" 2500x1686 layout). Each
# zone is a distinct flat color block with a large emoji + Thai label,
# legible at LINE's in-app menu thumbnail size. Run once locally:
#   python3 scripts/generate-line-richmenu.py
# writes richmenu.png to the current directory.

from PIL import Image, ImageDraw, ImageFont

W, H = 2500, 1686
ZONE_H = H // 3
zones = [
    ("🚧", "แจ้งปัญหา", (196, 90, 60)),
    ("📦", "ขอเบิกของ", (60, 130, 170)),
    ("🏖️", "ขอลา", (70, 150, 100)),
]

img = Image.new("RGB", (W, H), (245, 245, 240))
draw = ImageDraw.Draw(img)

try:
    label_font = ImageFont.truetype("/System/Library/Fonts/Supplemental/Tahoma.ttf", 110)
    emoji_font = ImageFont.truetype("/System/Library/Fonts/Apple Color Emoji.ttc", 160)
except OSError:
    # Fallback for non-macOS environments -- any installed TTF with Thai
    # coverage works; adjust the path for the actual build environment.
    label_font = ImageFont.load_default()
    emoji_font = label_font

for i, (emoji, label, color) in enumerate(zones):
    y0 = i * ZONE_H
    draw.rectangle([0, y0, W, y0 + ZONE_H], fill=color)
    text_y = y0 + ZONE_H // 2
    draw.text((200, text_y - 90), emoji, font=emoji_font, fill=(255, 255, 255), anchor="lm")
    draw.text((520, text_y), label, font=label_font, fill=(255, 255, 255), anchor="lm")
    if i < 2:
        draw.line([0, y0 + ZONE_H, W, y0 + ZONE_H], fill=(255, 255, 255), width=6)

img.save("richmenu.png")
print("wrote richmenu.png", img.size)
```

Run it, confirm `richmenu.png` is produced at exactly 2500x1686 and
looks legible (open it, don't just trust the script ran without error —
if the emoji font path doesn't exist in this environment, the fallback
default font will look poor; find and use whatever TTF with Thai +
emoji-adjacent glyph coverage is actually available, adjusting the
script's font paths for the real build environment rather than shipping
visibly broken text).

- [ ] **Step 6: Create and upload the Rich Menu — REAL tenant, real bot (but NOT set as anyone's default)**

Only after Step 4's tests pass. Using the real tenant's real
`channel_access_token` (read it from the real `line_settings` row —
never log or echo the raw token value in your report):

1. `POST https://api.line.me/v2/bot/richmenu` with `Authorization:
   Bearer <real token>`, body:
```json
{
  "size": { "width": 2500, "height": 1686 },
  "selected": true,
  "name": "FacadeX Crew Menu",
  "chatBarText": "เมนู",
  "areas": [
    { "bounds": { "x": 0, "y": 0, "width": 2500, "height": 562 }, "action": { "type": "postback", "data": "action=issue_report" } },
    { "bounds": { "x": 0, "y": 562, "width": 2500, "height": 562 }, "action": { "type": "postback", "data": "action=material_request" } },
    { "bounds": { "x": 0, "y": 1124, "width": 2500, "height": 562 }, "action": { "type": "postback", "data": "action=leave" } }
  ]
}
```
Capture the returned `richMenuId`.
2. `POST https://api.line.me/v2/bot/richmenu/{richMenuId}/content` with
   `Content-Type: image/png`, body = the raw bytes of `richmenu.png`
   from Step 5.
3. **Do NOT call `POST /v2/bot/user/all/richmenu/{richMenuId}`** (the
   "set as default for everyone" endpoint) — this tenant's real OA is
   also used for sales/customer info, and that call would show crew
   buttons to every real customer. Instead, store the id: `UPDATE
   line_settings SET crew_rich_menu_id = '<richMenuId>' WHERE tenant_id
   = '1b9affc4-2136-4ed1-b168-a36e6624e743'` (via `execute_sql`). From
   this point on, `ensureCrewRichMenuLinked` (Step 3) links it to each
   worker individually, lazily, the first time they're seen in a 1:1 DM
   — nothing is visible to anyone until that happens naturally through
   real use.
4. Verify via `GET https://api.line.me/v2/bot/richmenu/list` that the
   menu exists with the right `richMenuId`, and confirm via
   `execute_sql` that `line_settings.crew_rich_menu_id` was set
   correctly on the real row.

- [ ] **Step 7: Live-verify against the real bot**

Ask the user (this step needs a real phone, same as Task 3's live
proof) to open a 1:1 DM with the real bot (not the test group, and not
via a customer-facing conversation) as a worker whose `workers.line_user_id`
is already set (reuse the same disposable test-worker-linked-to-a-real-
personal-LINE-account technique from the earlier live proof if the
person testing this isn't already a linked `workers` row). Send any
message first (to trigger `ensureCrewRichMenuLinked`), confirm the Rich
Menu now appears at the bottom of that chat, then tap each of the three
buttons in turn, confirm the prompt reply appears, type a detail message
for each, and confirm — via `execute_sql` — that the expected row landed
each time (`line_issue_reports` x2, `worker_assignments` x1) with the
correct `worker_id`. Also confirm `workers.line_rich_menu_linked_at` is
now set on that worker's row. Separately, confirm (by checking with the
user, or via a second real/test LINE account with no `workers` row at
all) that a completely unrelated LINE user — standing in for a real
customer — DMing the bot sees no Rich Menu and gets no reply of any
kind, exactly as before this task. Clean up test rows afterward, same
discipline as every other live-verify step in this plan.

- [ ] **Step 8: Commit**

```bash
git add supabase/migrations/2026-09-19-07-line-pending-actions.sql scripts/generate-line-richmenu.py supabase/functions/line-webhook/index.ts supabase/functions/_shared/line.ts
git commit -m "feat: crew Rich Menu (1:1 DM) as a second path alongside group-typed keywords"
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
