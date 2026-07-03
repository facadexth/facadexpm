# FXPM ↔ Google Calendar + LINE Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the FXPM Assign module the single source of truth, syncing site/day assignment rosters one-way into a Google Calendar ("workworkwork" under `contact@facadex.co.th`), with a pull-first LINE bot (free, unlimited replies) and a narrow same-day-reassignment push exception (quota-capped).

**Architecture:** A Supabase Database Webhook on `worker_assignments` fires on every INSERT/UPDATE/DELETE and POSTs to a Google Apps Script (GAS) Web App. GAS recomputes the full roster for the affected `{site_id, date}` from Supabase and overwrites the matching Calendar event (idempotent — safe against retries/out-of-order delivery). The same GAS Web App also receives LINE's webhook: on a keyword match it reads today's events straight from the Calendar and replies once (free). A same-day `UPDATE` additionally triggers one capped LINE push. All business logic is written as pure, dependency-injected functions so it can run under Jest in Node and be pushed unmodified to GAS via `clasp` (GAS auto-concatenates all pushed files into one global scope, so no bundler is needed).

**Tech Stack:** Google Apps Script (V8 runtime), clasp (deploy tooling), Jest (Node-side unit tests using a dual Node/GAS compatibility pattern), Supabase (Postgres + Database Webhooks + REST), LINE Messaging API.

## Global Constraints

- Timezone: `Asia/Bangkok` everywhere (Calendar events, "today" comparisons, quota month rollover).
- Sync direction is one-way only: FXPM → Calendar. Never write back to `worker_assignments` from Calendar or LINE.
- 1 Calendar event per `{site_id, date}`, aggregating every worker assigned there that day. Only rows with a non-null `site_id` (`type` in `site`/`factory`/`subcontract`) are synced — `leave`/`office`/`holiday` rows are skipped.
- Every Calendar write recomputes the full roster from Supabase and overwrites the event (recompute-and-overwrite) — never apply an incremental diff from the webhook payload.
- LINE push is used **only** for `UPDATE` events where `record.date == today()` (same-day reassignment). Same-day `DELETE` does not push (documented gap — covered by pull). New assignments created in advance never push.
- **`doPost(e)` in Google Apps Script cannot read HTTP request headers** (Google removed this capability; confirmed via Apps Script community/issue tracker). Two consequences baked into this plan:
  - The Supabase webhook shared secret is passed as a **URL query parameter** (`?secret=...`), read via `e.parameter.secret` — not a header.
  - LINE's `X-Line-Signature` HMAC verification is **not implementable** in a pure GAS Web App. The accepted mitigation is relying on the GAS Web App URL itself being an unpublished, unguessable token. This is a known, deliberate trade-off — do not attempt to add header-based LINE signature checks.
- All external I/O (Supabase REST calls, Calendar API calls, LINE API calls) must go through small dependency-injected client modules so business logic stays unit-testable without live network/Google credentials.

---

### Task 1: Supabase migration — `calendar_sync` tracking table

**Files:**
- Create: `supabase/migrations/2026-07-03-01-calendar-sync-table.sql`

**Interfaces:**
- Produces: table `calendar_sync(site_id UUID, assignment_date DATE, google_event_id TEXT, updated_at TIMESTAMPTZ)`, primary key `(site_id, assignment_date)` — consumed by the GAS Supabase REST client in Task 7.

- [ ] **Step 1: Write the migration**

```sql
-- calendar_sync: maps {site_id, date} -> Google Calendar event id
-- Applied to project yyzbgdmgyvvypfcjuhtr on 2026-07-03
-- Used by the GAS calendar sync script (docs/superpowers/plans/2026-07-03-calendar-line-sync.md)

CREATE TABLE IF NOT EXISTS calendar_sync (
  site_id         UUID NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  assignment_date DATE NOT NULL,
  google_event_id TEXT NOT NULL,
  updated_at      TIMESTAMPTZ DEFAULT NOW(),
  PRIMARY KEY (site_id, assignment_date)
);
```

- [ ] **Step 2: Apply the migration**

Apply via the Supabase MCP `apply_migration` tool (name: `calendar_sync_table`, pass the SQL above), or paste it into the Supabase SQL Editor for project `yyzbgdmgyvvypfcjuhtr`.

- [ ] **Step 3: Verify**

Run via Supabase MCP `execute_sql` or SQL Editor:

```sql
SELECT column_name, data_type FROM information_schema.columns
WHERE table_name = 'calendar_sync' ORDER BY ordinal_position;
```

Expected: 4 rows — `site_id` (uuid), `assignment_date` (date), `google_event_id` (text), `updated_at` (timestamp with time zone).

- [ ] **Step 4: Commit**

```bash
git add supabase/migrations/2026-07-03-01-calendar-sync-table.sql
git commit -m "Add calendar_sync tracking table for Calendar sync"
```

---

### Task 2: GAS project scaffold + roster formatting module

**Files:**
- Create: `gas/package.json`
- Create: `gas/.gitignore`
- Create: `gas/.clasp.json.example`
- Create: `gas/src/appsscript.json`
- Create: `gas/src/roster.js`
- Test: `gas/test/roster.test.js`

**Interfaces:**
- Produces: `formatWorkerLine(worker: {name, shift}) -> string`, `formatEventDescription(siteName: string, workers: Array<{name, shift}>) -> string`, `formatEventTitle(siteName: string, siteNumber: string) -> string` — consumed by Task 8 (calendar client) and Task 10 (`Code.js`).

- [ ] **Step 1: Scaffold the GAS project**

```bash
mkdir -p gas/src gas/test
```

Create `gas/package.json`:

```json
{
  "name": "fxpm-calendar-line-sync",
  "private": true,
  "scripts": {
    "test": "jest"
  },
  "devDependencies": {
    "jest": "^29.7.0"
  }
}
```

Create `gas/.gitignore`:

```
node_modules/
.clasp.json
```

Create `gas/.clasp.json.example`:

```json
{
  "scriptId": "REPLACE_WITH_YOUR_SCRIPT_ID",
  "rootDir": "./src"
}
```

Create `gas/src/appsscript.json`:

```json
{
  "timeZone": "Asia/Bangkok",
  "dependencies": {},
  "exceptionLogging": "STACKDRIVER",
  "runtimeVersion": "V8",
  "webapp": {
    "executeAs": "USER_DEPLOYING",
    "access": "ANYONE_ANONYMOUS"
  }
}
```

```bash
cd gas && npm install
```

- [ ] **Step 2: Write the failing test**

`gas/test/roster.test.js`:

```js
const { formatWorkerLine, formatEventDescription, formatEventTitle } = require('../src/roster');

describe('formatWorkerLine', () => {
  test('morning shift', () => {
    expect(formatWorkerLine({ name: 'สมชาย', shift: 'morning' })).toBe('- สมชาย (เช้า)');
  });

  test('evening shift', () => {
    expect(formatWorkerLine({ name: 'สมหญิง', shift: 'evening' })).toBe('- สมหญิง (เย็น)');
  });
});

describe('formatEventDescription', () => {
  test('lists all workers', () => {
    const workers = [
      { name: 'สมชาย', shift: 'morning' },
      { name: 'สมหญิง', shift: 'evening' },
    ];
    expect(formatEventDescription('ไซท์ A', workers)).toBe(
      'ไซท์ A\n- สมชาย (เช้า)\n- สมหญิง (เย็น)'
    );
  });

  test('empty roster', () => {
    expect(formatEventDescription('ไซท์ A', [])).toBe('ไซท์ A\n(ไม่มีช่างที่ไซท์นี้)');
  });
});

describe('formatEventTitle', () => {
  test('combines site number and name', () => {
    expect(formatEventTitle('ไซท์ A', 'FX-2026-014')).toBe('🏗️ FX-2026-014 ไซท์ A');
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gas && npx jest roster.test.js`
Expected: FAIL — `Cannot find module '../src/roster'`

- [ ] **Step 4: Write minimal implementation**

`gas/src/roster.js`:

```js
function formatWorkerLine(worker) {
  const shiftLabel = worker.shift === 'morning' ? 'เช้า' : 'เย็น';
  return `- ${worker.name} (${shiftLabel})`;
}

function formatEventDescription(siteName, workers) {
  if (workers.length === 0) {
    return `${siteName}\n(ไม่มีช่างที่ไซท์นี้)`;
  }
  const lines = workers.map(formatWorkerLine);
  return `${siteName}\n${lines.join('\n')}`;
}

function formatEventTitle(siteName, siteNumber) {
  return `🏗️ ${siteNumber} ${siteName}`;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { formatWorkerLine, formatEventDescription, formatEventTitle };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gas && npx jest roster.test.js`
Expected: PASS (4 tests)

- [ ] **Step 6: Commit**

```bash
git add gas/package.json gas/.gitignore gas/.clasp.json.example gas/src/appsscript.json gas/src/roster.js gas/test/roster.test.js
git commit -m "Scaffold GAS project and add roster formatting module"
```

---

### Task 3: Calendar sync decision logic

**Files:**
- Create: `gas/src/calendarSyncPlan.js`
- Test: `gas/test/calendarSyncPlan.test.js`

**Interfaces:**
- Produces: `planCalendarSync({existingEventId: string|null, workers: Array}) -> {action: 'create'|'update'|'delete'|'noop', eventId?: string}` — consumed by Task 8/Task 10.

- [ ] **Step 1: Write the failing test**

`gas/test/calendarSyncPlan.test.js`:

```js
const { planCalendarSync } = require('../src/calendarSyncPlan');

test('no existing event, no workers -> noop', () => {
  expect(planCalendarSync({ existingEventId: null, workers: [] })).toEqual({ action: 'noop' });
});

test('existing event, no workers -> delete', () => {
  expect(planCalendarSync({ existingEventId: 'evt1', workers: [] })).toEqual({
    action: 'delete',
    eventId: 'evt1',
  });
});

test('no existing event, has workers -> create', () => {
  expect(planCalendarSync({ existingEventId: null, workers: [{ name: 'A', shift: 'morning' }] })).toEqual({
    action: 'create',
  });
});

test('existing event, has workers -> update', () => {
  expect(
    planCalendarSync({ existingEventId: 'evt1', workers: [{ name: 'A', shift: 'morning' }] })
  ).toEqual({ action: 'update', eventId: 'evt1' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest calendarSyncPlan.test.js`
Expected: FAIL — `Cannot find module '../src/calendarSyncPlan'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/calendarSyncPlan.js`:

```js
function planCalendarSync({ existingEventId, workers }) {
  if (workers.length === 0) {
    if (existingEventId) {
      return { action: 'delete', eventId: existingEventId };
    }
    return { action: 'noop' };
  }
  if (existingEventId) {
    return { action: 'update', eventId: existingEventId };
  }
  return { action: 'create' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { planCalendarSync };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest calendarSyncPlan.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/calendarSyncPlan.js gas/test/calendarSyncPlan.test.js
git commit -m "Add calendar sync decision logic"
```

---

### Task 4: Push-exception + quota logic

**Files:**
- Create: `gas/src/pushException.js`
- Test: `gas/test/pushException.test.js`

**Interfaces:**
- Produces: `shouldPushException({webhookType, recordDate, todayISO}) -> boolean`, `canSendPush({currentCount, cap}) -> boolean` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/pushException.test.js`:

```js
const { shouldPushException, canSendPush } = require('../src/pushException');

describe('shouldPushException', () => {
  test('UPDATE on today -> true', () => {
    expect(
      shouldPushException({ webhookType: 'UPDATE', recordDate: '2026-07-03', todayISO: '2026-07-03' })
    ).toBe(true);
  });

  test('UPDATE on a future date -> false', () => {
    expect(
      shouldPushException({ webhookType: 'UPDATE', recordDate: '2026-07-10', todayISO: '2026-07-03' })
    ).toBe(false);
  });

  test('INSERT on today -> false (new assignment, not a reassignment)', () => {
    expect(
      shouldPushException({ webhookType: 'INSERT', recordDate: '2026-07-03', todayISO: '2026-07-03' })
    ).toBe(false);
  });

  test('DELETE on today -> false (out of scope per design)', () => {
    expect(
      shouldPushException({ webhookType: 'DELETE', recordDate: '2026-07-03', todayISO: '2026-07-03' })
    ).toBe(false);
  });
});

describe('canSendPush', () => {
  test('under cap -> true', () => {
    expect(canSendPush({ currentCount: 5, cap: 25 })).toBe(true);
  });

  test('at cap -> false', () => {
    expect(canSendPush({ currentCount: 25, cap: 25 })).toBe(false);
  });

  test('over cap -> false', () => {
    expect(canSendPush({ currentCount: 30, cap: 25 })).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest pushException.test.js`
Expected: FAIL — `Cannot find module '../src/pushException'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/pushException.js`:

```js
function shouldPushException({ webhookType, recordDate, todayISO }) {
  return webhookType === 'UPDATE' && recordDate === todayISO;
}

function canSendPush({ currentCount, cap }) {
  return currentCount < cap;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { shouldPushException, canSendPush };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest pushException.test.js`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/pushException.js gas/test/pushException.test.js
git commit -m "Add push-exception and quota-cap decision logic"
```

---

### Task 5: LINE keyword matching + summary formatting

**Files:**
- Create: `gas/src/lineKeyword.js`
- Test: `gas/test/lineKeyword.test.js`

**Interfaces:**
- Produces: `KEYWORD: string`, `matchesKeyword(text: string) -> boolean`, `formatDailySummary(eventDescriptions: string[]) -> string` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/lineKeyword.test.js`:

```js
const { matchesKeyword, formatDailySummary } = require('../src/lineKeyword');

describe('matchesKeyword', () => {
  test('exact keyword matches', () => {
    expect(matchesKeyword('@บอท ตารางงานวันนี้')).toBe(true);
  });

  test('keyword with surrounding text matches', () => {
    expect(matchesKeyword('สวัสดีครับ @บอท ตารางงานวันนี้ ด้วยครับ')).toBe(true);
  });

  test('unrelated text does not match', () => {
    expect(matchesKeyword('สวัสดีครับ')).toBe(false);
  });

  test('non-string input does not match', () => {
    expect(matchesKeyword(undefined)).toBe(false);
  });
});

describe('formatDailySummary', () => {
  test('joins multiple site descriptions', () => {
    expect(formatDailySummary(['ไซท์ A\n- สมชาย (เช้า)', 'ไซท์ B\n- สมหญิง (เย็น)'])).toBe(
      'ไซท์ A\n- สมชาย (เช้า)\n\nไซท์ B\n- สมหญิง (เย็น)'
    );
  });

  test('no events today', () => {
    expect(formatDailySummary([])).toBe('วันนี้ไม่มีตารางงาน');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest lineKeyword.test.js`
Expected: FAIL — `Cannot find module '../src/lineKeyword'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/lineKeyword.js`:

```js
const KEYWORD = '@บอท ตารางงานวันนี้';

function matchesKeyword(text) {
  return typeof text === 'string' && text.includes(KEYWORD);
}

function formatDailySummary(eventDescriptions) {
  if (eventDescriptions.length === 0) {
    return 'วันนี้ไม่มีตารางงาน';
  }
  return eventDescriptions.join('\n\n');
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { KEYWORD, matchesKeyword, formatDailySummary };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest lineKeyword.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/lineKeyword.js gas/test/lineKeyword.test.js
git commit -m "Add LINE keyword matching and daily summary formatting"
```

---

### Task 6: Webhook payload router

**Files:**
- Create: `gas/src/router.js`
- Test: `gas/test/router.test.js`

**Interfaces:**
- Produces: `routePayload(body: object) -> {source: 'supabase', type, record, oldRecord} | {source: 'line', events} | {source: 'unknown'}` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/router.test.js`:

```js
const { routePayload } = require('../src/router');

test('routes a Supabase Database Webhook payload', () => {
  const body = {
    type: 'UPDATE',
    table: 'worker_assignments',
    schema: 'public',
    record: { id: '1', site_id: 'site-1', date: '2026-07-03' },
    old_record: { id: '1', site_id: 'site-1', date: '2026-07-03' },
  };
  expect(routePayload(body)).toEqual({
    source: 'supabase',
    type: 'UPDATE',
    record: body.record,
    oldRecord: body.old_record,
  });
});

test('routes a LINE webhook payload', () => {
  const body = { destination: 'xxx', events: [{ type: 'message' }] };
  expect(routePayload(body)).toEqual({ source: 'line', events: body.events });
});

test('unknown payload shape', () => {
  expect(routePayload({ foo: 'bar' })).toEqual({ source: 'unknown' });
});

test('null body', () => {
  expect(routePayload(null)).toEqual({ source: 'unknown' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest router.test.js`
Expected: FAIL — `Cannot find module '../src/router'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/router.js`:

```js
function routePayload(body) {
  if (body && Array.isArray(body.events)) {
    return { source: 'line', events: body.events };
  }
  if (body && body.table === 'worker_assignments') {
    return { source: 'supabase', type: body.type, record: body.record, oldRecord: body.old_record };
  }
  return { source: 'unknown' };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { routePayload };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest router.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/router.js gas/test/router.test.js
git commit -m "Add webhook payload router"
```

---

### Task 7: Supabase REST client module

**Files:**
- Create: `gas/src/supabaseClient.js`
- Test: `gas/test/supabaseClient.test.js`

**Interfaces:**
- Consumes: an injected `fetchFn(url, options) -> {getContentText(): string}` matching GAS's real `UrlFetchApp.fetch` return shape.
- Produces: `fetchRosterForSiteDate({fetchFn, supabaseUrl, serviceRoleKey, siteId, date}) -> Array<{name, shift}>`, `fetchSite({fetchFn, supabaseUrl, serviceRoleKey, siteId}) -> {name, site_number}`, `findCalendarSyncRow({fetchFn, supabaseUrl, serviceRoleKey, siteId, date}) -> {google_event_id}|null`, `upsertCalendarSyncRow({fetchFn, supabaseUrl, serviceRoleKey, siteId, date, eventId}) -> void`, `deleteCalendarSyncRow({fetchFn, supabaseUrl, serviceRoleKey, siteId, date}) -> void` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/supabaseClient.test.js`:

```js
const {
  fetchRosterForSiteDate,
  fetchSite,
  findCalendarSyncRow,
  upsertCalendarSyncRow,
  deleteCalendarSyncRow,
} = require('../src/supabaseClient');

function fakeResponse(body) {
  return { getContentText: () => JSON.stringify(body) };
}

describe('fetchRosterForSiteDate', () => {
  test('maps joined rows to {name, shift}', () => {
    const fetchFn = jest.fn().mockReturnValue(
      fakeResponse([
        { shift: 'morning', workers: { name: 'สมชาย' } },
        { shift: 'evening', workers: { name: 'สมหญิง' } },
      ])
    );
    const result = fetchRosterForSiteDate({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
      date: '2026-07-03',
    });
    expect(result).toEqual([
      { name: 'สมชาย', shift: 'morning' },
      { name: 'สมหญิง', shift: 'evening' },
    ]);
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toContain('site_id=eq.site-1');
    expect(url).toContain('date=eq.2026-07-03');
    expect(opts.headers.apikey).toBe('key123');
  });
});

describe('fetchSite', () => {
  test('returns first matching row', () => {
    const fetchFn = jest.fn().mockReturnValue(fakeResponse([{ name: 'ไซท์ A', site_number: 'FX-2026-014' }]));
    const result = fetchSite({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
    });
    expect(result).toEqual({ name: 'ไซท์ A', site_number: 'FX-2026-014' });
  });
});

describe('findCalendarSyncRow', () => {
  test('returns row when found', () => {
    const fetchFn = jest.fn().mockReturnValue(fakeResponse([{ google_event_id: 'evt1' }]));
    const result = findCalendarSyncRow({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
      date: '2026-07-03',
    });
    expect(result).toEqual({ google_event_id: 'evt1' });
  });

  test('returns null when not found', () => {
    const fetchFn = jest.fn().mockReturnValue(fakeResponse([]));
    const result = findCalendarSyncRow({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
      date: '2026-07-03',
    });
    expect(result).toBeNull();
  });
});

describe('upsertCalendarSyncRow', () => {
  test('POSTs with merge-duplicates header', () => {
    const fetchFn = jest.fn().mockReturnValue(fakeResponse({}));
    upsertCalendarSyncRow({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
      date: '2026-07-03',
      eventId: 'evt1',
    });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://x.supabase.co/rest/v1/calendar_sync');
    expect(opts.method).toBe('post');
    expect(opts.headers.Prefer).toBe('resolution=merge-duplicates');
    expect(JSON.parse(opts.payload)).toEqual({
      site_id: 'site-1',
      assignment_date: '2026-07-03',
      google_event_id: 'evt1',
    });
  });
});

describe('deleteCalendarSyncRow', () => {
  test('DELETEs the matching row', () => {
    const fetchFn = jest.fn().mockReturnValue(fakeResponse({}));
    deleteCalendarSyncRow({
      fetchFn,
      supabaseUrl: 'https://x.supabase.co',
      serviceRoleKey: 'key123',
      siteId: 'site-1',
      date: '2026-07-03',
    });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toContain('site_id=eq.site-1');
    expect(url).toContain('assignment_date=eq.2026-07-03');
    expect(opts.method).toBe('delete');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest supabaseClient.test.js`
Expected: FAIL — `Cannot find module '../src/supabaseClient'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/supabaseClient.js`:

```js
function authHeaders(serviceRoleKey) {
  return { apikey: serviceRoleKey, Authorization: `Bearer ${serviceRoleKey}` };
}

function fetchRosterForSiteDate({ fetchFn, supabaseUrl, serviceRoleKey, siteId, date }) {
  const url = `${supabaseUrl}/rest/v1/worker_assignments?site_id=eq.${siteId}&date=eq.${date}&select=shift,workers(name)`;
  const response = fetchFn(url, { headers: authHeaders(serviceRoleKey) });
  const rows = JSON.parse(response.getContentText());
  return rows.map((row) => ({ name: row.workers.name, shift: row.shift }));
}

function fetchSite({ fetchFn, supabaseUrl, serviceRoleKey, siteId }) {
  const url = `${supabaseUrl}/rest/v1/sites?id=eq.${siteId}&select=name,site_number`;
  const response = fetchFn(url, { headers: authHeaders(serviceRoleKey) });
  const rows = JSON.parse(response.getContentText());
  return rows[0];
}

function findCalendarSyncRow({ fetchFn, supabaseUrl, serviceRoleKey, siteId, date }) {
  const url = `${supabaseUrl}/rest/v1/calendar_sync?site_id=eq.${siteId}&assignment_date=eq.${date}&select=google_event_id`;
  const response = fetchFn(url, { headers: authHeaders(serviceRoleKey) });
  const rows = JSON.parse(response.getContentText());
  return rows[0] || null;
}

function upsertCalendarSyncRow({ fetchFn, supabaseUrl, serviceRoleKey, siteId, date, eventId }) {
  const url = `${supabaseUrl}/rest/v1/calendar_sync`;
  fetchFn(url, {
    method: 'post',
    contentType: 'application/json',
    headers: Object.assign({ Prefer: 'resolution=merge-duplicates' }, authHeaders(serviceRoleKey)),
    payload: JSON.stringify({ site_id: siteId, assignment_date: date, google_event_id: eventId }),
  });
}

function deleteCalendarSyncRow({ fetchFn, supabaseUrl, serviceRoleKey, siteId, date }) {
  const url = `${supabaseUrl}/rest/v1/calendar_sync?site_id=eq.${siteId}&assignment_date=eq.${date}`;
  fetchFn(url, { method: 'delete', headers: authHeaders(serviceRoleKey) });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    fetchRosterForSiteDate,
    fetchSite,
    findCalendarSyncRow,
    upsertCalendarSyncRow,
    deleteCalendarSyncRow,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest supabaseClient.test.js`
Expected: PASS (6 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/supabaseClient.js gas/test/supabaseClient.test.js
git commit -m "Add Supabase REST client module"
```

---

### Task 8: Google Calendar client module

**Files:**
- Create: `gas/src/calendarClient.js`
- Test: `gas/test/calendarClient.test.js`

**Interfaces:**
- Consumes: an injected `calendar` object matching GAS's real `Calendar` service (`createAllDayEvent`, `getEventById`, `getEventsForDay`), `plan` from Task 3.
- Produces: `upsertSiteDayEvent({calendar, plan, siteName, description, dateISO}) -> string|null` (event id), `getTodayEventDescriptions({calendar, todayDate}) -> string[]` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/calendarClient.test.js`:

```js
const { upsertSiteDayEvent, getTodayEventDescriptions } = require('../src/calendarClient');

describe('upsertSiteDayEvent', () => {
  test('create action creates an all-day event and returns its id', () => {
    const fakeEvent = { getId: () => 'evt-new' };
    const calendar = { createAllDayEvent: jest.fn().mockReturnValue(fakeEvent) };
    const result = upsertSiteDayEvent({
      calendar,
      plan: { action: 'create' },
      siteName: '🏗️ FX-2026-014 ไซท์ A',
      description: 'ไซท์ A\n- สมชาย (เช้า)',
      dateISO: '2026-07-03',
    });
    expect(result).toBe('evt-new');
    expect(calendar.createAllDayEvent).toHaveBeenCalledWith(
      '🏗️ FX-2026-014 ไซท์ A',
      new Date('2026-07-03'),
      { description: 'ไซท์ A\n- สมชาย (เช้า)' }
    );
  });

  test('update action updates title and description on the existing event', () => {
    const fakeEvent = { setTitle: jest.fn(), setDescription: jest.fn() };
    const calendar = { getEventById: jest.fn().mockReturnValue(fakeEvent) };
    const result = upsertSiteDayEvent({
      calendar,
      plan: { action: 'update', eventId: 'evt1' },
      siteName: 'title',
      description: 'desc',
      dateISO: '2026-07-03',
    });
    expect(result).toBe('evt1');
    expect(calendar.getEventById).toHaveBeenCalledWith('evt1');
    expect(fakeEvent.setTitle).toHaveBeenCalledWith('title');
    expect(fakeEvent.setDescription).toHaveBeenCalledWith('desc');
  });

  test('delete action deletes the existing event and returns null', () => {
    const fakeEvent = { deleteEvent: jest.fn() };
    const calendar = { getEventById: jest.fn().mockReturnValue(fakeEvent) };
    const result = upsertSiteDayEvent({
      calendar,
      plan: { action: 'delete', eventId: 'evt1' },
      siteName: 'title',
      description: 'desc',
      dateISO: '2026-07-03',
    });
    expect(result).toBeNull();
    expect(fakeEvent.deleteEvent).toHaveBeenCalled();
  });
});

describe('getTodayEventDescriptions', () => {
  test('returns descriptions for every event that day', () => {
    const events = [{ getDescription: () => 'ไซท์ A\n- สมชาย' }, { getDescription: () => 'ไซท์ B\n- สมหญิง' }];
    const calendar = { getEventsForDay: jest.fn().mockReturnValue(events) };
    const today = new Date('2026-07-03');
    const result = getTodayEventDescriptions({ calendar, todayDate: today });
    expect(result).toEqual(['ไซท์ A\n- สมชาย', 'ไซท์ B\n- สมหญิง']);
    expect(calendar.getEventsForDay).toHaveBeenCalledWith(today);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest calendarClient.test.js`
Expected: FAIL — `Cannot find module '../src/calendarClient'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/calendarClient.js`:

```js
function upsertSiteDayEvent({ calendar, plan, siteName, description, dateISO }) {
  if (plan.action === 'create') {
    const event = calendar.createAllDayEvent(siteName, new Date(dateISO), { description });
    return event.getId();
  }
  if (plan.action === 'update') {
    const event = calendar.getEventById(plan.eventId);
    event.setTitle(siteName);
    event.setDescription(description);
    return plan.eventId;
  }
  if (plan.action === 'delete') {
    const event = calendar.getEventById(plan.eventId);
    event.deleteEvent();
    return null;
  }
  return plan.eventId || null;
}

function getTodayEventDescriptions({ calendar, todayDate }) {
  const events = calendar.getEventsForDay(todayDate);
  return events.map((event) => event.getDescription());
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { upsertSiteDayEvent, getTodayEventDescriptions };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest calendarClient.test.js`
Expected: PASS (4 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/calendarClient.js gas/test/calendarClient.test.js
git commit -m "Add Google Calendar client module"
```

---

### Task 9: LINE client module

**Files:**
- Create: `gas/src/lineClient.js`
- Test: `gas/test/lineClient.test.js`

**Interfaces:**
- Consumes: an injected `fetchFn(url, options)` matching `UrlFetchApp.fetch`.
- Produces: `pushMessage({fetchFn, channelAccessToken, to, text}) -> void`, `replyMessage({fetchFn, channelAccessToken, replyToken, text}) -> void` — consumed by Task 10 (`Code.js`).

- [ ] **Step 1: Write the failing test**

`gas/test/lineClient.test.js`:

```js
const { pushMessage, replyMessage } = require('../src/lineClient');

describe('pushMessage', () => {
  test('POSTs to the push endpoint with the group id and text', () => {
    const fetchFn = jest.fn();
    pushMessage({ fetchFn, channelAccessToken: 'tok', to: 'group-1', text: 'hello' });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/push');
    expect(opts.method).toBe('post');
    expect(opts.headers.Authorization).toBe('Bearer tok');
    expect(JSON.parse(opts.payload)).toEqual({ to: 'group-1', messages: [{ type: 'text', text: 'hello' }] });
  });
});

describe('replyMessage', () => {
  test('POSTs to the reply endpoint with the reply token and text', () => {
    const fetchFn = jest.fn();
    replyMessage({ fetchFn, channelAccessToken: 'tok', replyToken: 'rt-1', text: 'hello' });
    const [url, opts] = fetchFn.mock.calls[0];
    expect(url).toBe('https://api.line.me/v2/bot/message/reply');
    expect(JSON.parse(opts.payload)).toEqual({
      replyToken: 'rt-1',
      messages: [{ type: 'text', text: 'hello' }],
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd gas && npx jest lineClient.test.js`
Expected: FAIL — `Cannot find module '../src/lineClient'`

- [ ] **Step 3: Write minimal implementation**

`gas/src/lineClient.js`:

```js
function callLineApi({ fetchFn, channelAccessToken, endpoint, body }) {
  fetchFn(`https://api.line.me/v2/bot/message/${endpoint}`, {
    method: 'post',
    contentType: 'application/json',
    headers: { Authorization: `Bearer ${channelAccessToken}` },
    payload: JSON.stringify(body),
  });
}

function pushMessage({ fetchFn, channelAccessToken, to, text }) {
  callLineApi({ fetchFn, channelAccessToken, endpoint: 'push', body: { to, messages: [{ type: 'text', text }] } });
}

function replyMessage({ fetchFn, channelAccessToken, replyToken, text }) {
  callLineApi({
    fetchFn,
    channelAccessToken,
    endpoint: 'reply',
    body: { replyToken, messages: [{ type: 'text', text }] },
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { pushMessage, replyMessage };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd gas && npx jest lineClient.test.js`
Expected: PASS (2 tests)

- [ ] **Step 5: Commit**

```bash
git add gas/src/lineClient.js gas/test/lineClient.test.js
git commit -m "Add LINE client module"
```

---

### Task 10: `doPost` entrypoint — wire everything together

**Files:**
- Create: `gas/src/Code.js`
- Create: `gas/src/config.js`
- Test: `gas/test/Code.test.js`

**Interfaces:**
- Consumes: every function produced by Tasks 2–9, plus real GAS globals `CalendarApp`, `UrlFetchApp`, `PropertiesService`, `ContentService`, `Utilities` (referenced as bare identifiers — GAS auto-concatenates all pushed files into one global scope, so **no `require` is used in `Code.js` or `config.js`**; the test file bridges Node's module system to globals instead).
- Produces: `doPost(e)` — the GAS Web App entrypoint.

- [ ] **Step 1: Write `config.js` (no test — thin PropertiesService wrapper, exercised indirectly via Code.test.js mocks)**

`gas/src/config.js`:

```js
function getConfig() {
  const props = PropertiesService.getScriptProperties();
  return {
    supabaseUrl: props.getProperty('SUPABASE_URL'),
    serviceRoleKey: props.getProperty('SUPABASE_SERVICE_ROLE_KEY'),
    lineChannelAccessToken: props.getProperty('LINE_CHANNEL_ACCESS_TOKEN'),
    lineGroupId: props.getProperty('LINE_GROUP_ID'),
    webhookSecret: props.getProperty('WEBHOOK_SHARED_SECRET'),
    calendarId: props.getProperty('CALENDAR_ID'),
    pushQuotaCap: Number(props.getProperty('PUSH_QUOTA_CAP') || '25'),
  };
}

function incrementAndCheckPushQuota(cap) {
  const props = PropertiesService.getScriptProperties();
  const monthKey = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM');
  const storedMonth = props.getProperty('PUSH_QUOTA_MONTH');
  let count = Number(props.getProperty('PUSH_QUOTA_COUNT') || '0');
  if (storedMonth !== monthKey) {
    count = 0;
    props.setProperty('PUSH_QUOTA_MONTH', monthKey);
  }
  if (!canSendPush({ currentCount: count, cap })) {
    return false;
  }
  props.setProperty('PUSH_QUOTA_COUNT', String(count + 1));
  return true;
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { getConfig, incrementAndCheckPushQuota };
}
```

- [ ] **Step 2: Write the failing test for `Code.js`**

`gas/test/Code.test.js`:

```js
// Bridge Node's CommonJS modules into globals, mimicking how GAS concatenates
// every pushed file into one shared global scope. Code.js and config.js use
// zero `require` calls so the exact same source runs unmodified in GAS.
global.formatEventDescription = require('../src/roster').formatEventDescription;
global.formatEventTitle = require('../src/roster').formatEventTitle;
global.planCalendarSync = require('../src/calendarSyncPlan').planCalendarSync;
global.shouldPushException = require('../src/pushException').shouldPushException;
global.canSendPush = require('../src/pushException').canSendPush;
global.matchesKeyword = require('../src/lineKeyword').matchesKeyword;
global.formatDailySummary = require('../src/lineKeyword').formatDailySummary;
global.routePayload = require('../src/router').routePayload;
global.fetchRosterForSiteDate = require('../src/supabaseClient').fetchRosterForSiteDate;
global.fetchSite = require('../src/supabaseClient').fetchSite;
global.findCalendarSyncRow = require('../src/supabaseClient').findCalendarSyncRow;
global.upsertCalendarSyncRow = require('../src/supabaseClient').upsertCalendarSyncRow;
global.deleteCalendarSyncRow = require('../src/supabaseClient').deleteCalendarSyncRow;
global.upsertSiteDayEvent = require('../src/calendarClient').upsertSiteDayEvent;
global.getTodayEventDescriptions = require('../src/calendarClient').getTodayEventDescriptions;
global.pushMessage = require('../src/lineClient').pushMessage;
global.replyMessage = require('../src/lineClient').replyMessage;
global.getConfig = require('../src/config').getConfig;
global.incrementAndCheckPushQuota = require('../src/config').incrementAndCheckPushQuota;

function fakeHttpResponse(body) {
  return { getContentText: () => JSON.stringify(body) };
}

function baseConfig() {
  return {
    SUPABASE_URL: 'https://x.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'srk',
    LINE_CHANNEL_ACCESS_TOKEN: 'linetok',
    LINE_GROUP_ID: 'group-1',
    WEBHOOK_SHARED_SECRET: 'shh',
    CALENDAR_ID: 'cal-1',
    PUSH_QUOTA_CAP: '25',
  };
}

describe('doPost', () => {
  let props;
  let fakeEvent;
  let fakeCalendar;

  beforeEach(() => {
    jest.resetModules();
    const store = baseConfig();
    props = {
      getProperty: (key) => (store[key] !== undefined ? store[key] : null),
      setProperty: (key, value) => {
        store[key] = value;
      },
    };
    global.PropertiesService = { getScriptProperties: () => props };
    global.Utilities = {
      formatDate: (date, tz, fmt) => {
        const iso = date.toISOString().slice(0, 10);
        return fmt === 'yyyy-MM' ? iso.slice(0, 7) : iso;
      },
    };
    global.ContentService = { createTextOutput: (text) => ({ text }) };
    global.Logger = { log: jest.fn() };
    fakeEvent = { getId: () => 'evt-1' };
    fakeCalendar = {
      createAllDayEvent: jest.fn().mockReturnValue(fakeEvent),
      getEventById: jest.fn().mockReturnValue(Object.assign(fakeEvent, { setTitle: jest.fn(), setDescription: jest.fn() })),
      getEventsForDay: jest.fn().mockReturnValue([{ getDescription: () => 'ไซท์ A\n- สมชาย (เช้า)' }]),
    };
    global.CalendarApp = { getCalendarById: jest.fn().mockReturnValue(fakeCalendar) };

    global.UrlFetchApp = {
      fetch: jest.fn((url) => {
        if (url.includes('/worker_assignments')) {
          return fakeHttpResponse([{ shift: 'morning', workers: { name: 'สมชาย' } }]);
        }
        if (url.includes('/sites')) {
          return fakeHttpResponse([{ name: 'ไซท์ A', site_number: 'FX-2026-014' }]);
        }
        if (url.includes('/calendar_sync')) {
          return fakeHttpResponse([]);
        }
        return fakeHttpResponse({});
      }),
    };

    require('../src/Code');
  });

  test('Supabase webhook with wrong secret is rejected before touching Calendar', () => {
    const e = {
      parameter: { secret: 'nope' },
      postData: {
        contents: JSON.stringify({
          type: 'UPDATE',
          table: 'worker_assignments',
          record: { site_id: 'site-1', date: '2026-07-10' },
          old_record: { site_id: 'site-1', date: '2026-07-10' },
        }),
      },
    };
    global.doPost(e);
    expect(global.CalendarApp.getCalendarById).not.toHaveBeenCalled();
  });

  test('Supabase webhook, future date UPDATE syncs Calendar but does not push', () => {
    const e = {
      parameter: { secret: 'shh' },
      postData: {
        contents: JSON.stringify({
          type: 'UPDATE',
          table: 'worker_assignments',
          record: { site_id: 'site-1', date: '2026-07-10' },
          old_record: { site_id: 'site-1', date: '2026-07-10' },
        }),
      },
    };
    global.doPost(e);
    expect(fakeCalendar.createAllDayEvent).toHaveBeenCalled();
    const pushCalls = global.UrlFetchApp.fetch.mock.calls.filter((c) => c[0].includes('/message/push'));
    expect(pushCalls).toHaveLength(0);
  });

  test('Supabase webhook, same-day UPDATE syncs Calendar and pushes once', () => {
    const todayISO = new Date().toISOString().slice(0, 10);
    const e = {
      parameter: { secret: 'shh' },
      postData: {
        contents: JSON.stringify({
          type: 'UPDATE',
          table: 'worker_assignments',
          record: { site_id: 'site-1', date: todayISO },
          old_record: { site_id: 'site-1', date: todayISO },
        }),
      },
    };
    global.doPost(e);
    const pushCalls = global.UrlFetchApp.fetch.mock.calls.filter((c) => c[0].includes('/message/push'));
    expect(pushCalls).toHaveLength(1);
  });

  test('LINE webhook with matching keyword replies once with today summary', () => {
    const e = {
      parameter: {},
      postData: {
        contents: JSON.stringify({
          destination: 'xxx',
          events: [
            {
              type: 'message',
              message: { type: 'text', text: '@บอท ตารางงานวันนี้' },
              replyToken: 'rt-1',
            },
          ],
        }),
      },
    };
    global.doPost(e);
    const replyCalls = global.UrlFetchApp.fetch.mock.calls.filter((c) => c[0].includes('/message/reply'));
    expect(replyCalls).toHaveLength(1);
    expect(JSON.parse(replyCalls[0][1].payload).replyToken).toBe('rt-1');
  });

  test('Calendar failure on sync does not block the same-day push, and is logged', () => {
    fakeCalendar.createAllDayEvent.mockImplementation(() => {
      throw new Error('rate limited');
    });
    const todayISO = new Date().toISOString().slice(0, 10);
    const e = {
      parameter: { secret: 'shh' },
      postData: {
        contents: JSON.stringify({
          type: 'UPDATE',
          table: 'worker_assignments',
          record: { site_id: 'site-1', date: todayISO },
          old_record: { site_id: 'site-1', date: todayISO },
        }),
      },
    };
    global.doPost(e);
    const pushCalls = global.UrlFetchApp.fetch.mock.calls.filter((c) => c[0].includes('/message/push'));
    expect(pushCalls).toHaveLength(1);
    expect(global.Logger.log).toHaveBeenCalled();
  });

  test('LINE webhook without keyword does not reply', () => {
    const e = {
      parameter: {},
      postData: {
        contents: JSON.stringify({
          destination: 'xxx',
          events: [{ type: 'message', message: { type: 'text', text: 'สวัสดี' }, replyToken: 'rt-1' }],
        }),
      },
    };
    global.doPost(e);
    const replyCalls = global.UrlFetchApp.fetch.mock.calls.filter((c) => c[0].includes('/message/reply'));
    expect(replyCalls).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `cd gas && npx jest Code.test.js`
Expected: FAIL — `Cannot find module '../src/Code'`

- [ ] **Step 4: Write minimal implementation**

`gas/src/Code.js`:

```js
// GAS concatenates every file pushed via clasp into one shared global scope,
// so every identifier below (formatEventDescription, CalendarApp, etc.) is
// resolved as a global — no require() here by design. See Task 10 test file
// for how Node/Jest bridges the equivalent globals for local testing.

function doPost(e) {
  const body = JSON.parse(e.postData.contents);
  const routed = routePayload(body);
  const config = getConfig();

  if (routed.source === 'supabase') {
    if (e.parameter.secret !== config.webhookSecret) {
      return ContentService.createTextOutput('forbidden');
    }
    handleSupabaseWebhook(routed, config);
  } else if (routed.source === 'line') {
    handleLineWebhook(routed, config);
  }

  return ContentService.createTextOutput('ok');
}

function handleSupabaseWebhook(routed, config) {
  const record = routed.record;
  const oldRecord = routed.oldRecord;

  if (routed.type === 'DELETE') {
    if (oldRecord && oldRecord.site_id) {
      syncCalendarEvent(oldRecord.site_id, oldRecord.date, config);
    }
    return;
  }

  // Reassigned to a different site/date: resync the slot the worker left too.
  // Each step is caught independently so a failure in one (e.g. Calendar API
  // rate limit) doesn't stop the others from running.
  if (
    routed.type === 'UPDATE' &&
    oldRecord &&
    oldRecord.site_id &&
    (oldRecord.site_id !== record.site_id || oldRecord.date !== record.date)
  ) {
    safely('syncCalendarEvent(old slot)', function () {
      syncCalendarEvent(oldRecord.site_id, oldRecord.date, config);
    });
  }

  if (record.site_id) {
    safely('syncCalendarEvent(new slot)', function () {
      syncCalendarEvent(record.site_id, record.date, config);
    });
  }

  const todayISO = Utilities.formatDate(new Date(), 'Asia/Bangkok', 'yyyy-MM-dd');
  if (record.site_id && shouldPushException({ webhookType: routed.type, recordDate: record.date, todayISO })) {
    safely('pushExceptionAlert', function () {
      pushExceptionAlert(record.site_id, record.date, config);
    });
  }
}

function safely(label, fn) {
  try {
    fn();
  } catch (err) {
    Logger.log('%s failed: %s', label, err && err.stack ? err.stack : err);
  }
}

function syncCalendarEvent(siteId, date, config) {
  if (!siteId) return;
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const fetchFn = function (url, opts) {
    return UrlFetchApp.fetch(url, opts);
  };
  const restArgs = { fetchFn, supabaseUrl: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey };

  const workers = fetchRosterForSiteDate(Object.assign({}, restArgs, { siteId, date }));
  const site = fetchSite(Object.assign({}, restArgs, { siteId }));
  const existing = findCalendarSyncRow(Object.assign({}, restArgs, { siteId, date }));

  const plan = planCalendarSync({ existingEventId: existing ? existing.google_event_id : null, workers });
  if (plan.action === 'noop') return;

  const title = formatEventTitle(site.name, site.site_number);
  const description = formatEventDescription(site.name, workers);
  const eventId = upsertSiteDayEvent({ calendar, plan, siteName: title, description, dateISO: date });

  if (plan.action === 'delete') {
    deleteCalendarSyncRow(Object.assign({}, restArgs, { siteId, date }));
  } else {
    upsertCalendarSyncRow(Object.assign({}, restArgs, { siteId, date, eventId }));
  }
}

function pushExceptionAlert(siteId, date, config) {
  if (!incrementAndCheckPushQuota(config.pushQuotaCap)) return;
  const fetchFn = function (url, opts) {
    return UrlFetchApp.fetch(url, opts);
  };
  const restArgs = { fetchFn, supabaseUrl: config.supabaseUrl, serviceRoleKey: config.serviceRoleKey };

  const site = fetchSite(Object.assign({}, restArgs, { siteId }));
  const workers = fetchRosterForSiteDate(Object.assign({}, restArgs, { siteId, date }));
  const text = `📢 มีการแก้ไขตารางงานวันนี้\n${formatEventDescription(site.name, workers)}`;
  pushMessage({ fetchFn, channelAccessToken: config.lineChannelAccessToken, to: config.lineGroupId, text });
}

function handleLineWebhook(routed, config) {
  const calendar = CalendarApp.getCalendarById(config.calendarId);
  const fetchFn = function (url, opts) {
    return UrlFetchApp.fetch(url, opts);
  };
  routed.events.forEach(function (event) {
    if (event.type !== 'message' || !event.message || event.message.type !== 'text') return;
    if (!matchesKeyword(event.message.text)) return;
    safely('handleLineWebhook reply', function () {
      const descriptions = getTodayEventDescriptions({ calendar, todayDate: new Date() });
      const text = formatDailySummary(descriptions);
      replyMessage({ fetchFn, channelAccessToken: config.lineChannelAccessToken, replyToken: event.replyToken, text });
    });
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = { doPost, handleSupabaseWebhook, syncCalendarEvent, pushExceptionAlert, handleLineWebhook, safely };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `cd gas && npx jest Code.test.js`
Expected: PASS (6 tests)

- [ ] **Step 6: Run the full GAS test suite**

Run: `cd gas && npx jest`
Expected: PASS — all suites (roster, calendarSyncPlan, pushException, lineKeyword, router, supabaseClient, calendarClient, lineClient, Code) green.

- [ ] **Step 7: Commit**

```bash
git add gas/src/Code.js gas/src/config.js gas/test/Code.test.js
git commit -m "Wire doPost entrypoint: Calendar sync, push exception, LINE pull"
```

---

### Task 11: Provision Google Calendar + deploy the GAS Web App (manual)

**Files:** none (external configuration + `gas/.clasp.json`, which is gitignored)

- [ ] **Step 1: Create the target calendar**

In `contact@facadex.co.th`'s Google Calendar, create a new secondary calendar named exactly `workworkwork`. Open its Settings → "Integrate calendar" → copy the **Calendar ID** (looks like `xxxxxxxxxxxx@group.calendar.google.com`). Save this value — it goes into `CALENDAR_ID` in Step 5.

- [ ] **Step 2: Install clasp and log in**

```bash
npm install -g @google/clasp
clasp login
```

This opens a browser OAuth flow — log in as `contact@facadex.co.th`.

- [ ] **Step 3: Create the Apps Script project**

```bash
cd gas
cp .clasp.json.example .clasp.json
clasp create --type webapp --title "FXPM Calendar LINE Sync" --rootDir ./src
```

`clasp create` overwrites `.clasp.json` with the real `scriptId` it generates — this is expected; `.clasp.json` is gitignored so the real id never gets committed.

- [ ] **Step 4: Push the code and deploy**

```bash
clasp push
clasp deploy --description "initial deploy"
```

Note the Web App URL printed by `clasp deploy` (or run `clasp deployments` to list it) — it looks like `https://script.google.com/macros/s/AKfycb.../exec`. Save this; it's needed in Tasks 12 and 13.

- [ ] **Step 5: Set Script Properties**

In the Apps Script editor (`clasp open`) → Project Settings → Script Properties, add:

| Property | Value |
|---|---|
| `SUPABASE_URL` | `https://yyzbgdmgyvvypfcjuhtr.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | (service role key from Supabase Project Settings → API) |
| `LINE_CHANNEL_ACCESS_TOKEN` | (from the existing LINE Official Account's Messaging API settings) |
| `LINE_GROUP_ID` | (the existing LINE group's id — see Task 13 Step 1 for how to obtain it) |
| `WEBHOOK_SHARED_SECRET` | (generate a random 32+ char string, e.g. `openssl rand -hex 16`) |
| `CALENDAR_ID` | (from Step 1) |
| `PUSH_QUOTA_CAP` | `25` |

- [ ] **Step 6: Verify the deployment responds**

```bash
curl -i "<web app url>?secret=wrong" -X POST -d '{}'
```

Expected: HTTP 200 with body `forbidden` (proves the secret check runs and the deployment is reachable — a `403`/redirect-to-login response instead means the Web App's `access` setting isn't `ANYONE_ANONYMOUS`; re-check `gas/src/appsscript.json` and redeploy).

---

### Task 12: Configure the Supabase Database Webhook (manual)

**Files:** none (Supabase Dashboard configuration)

- [ ] **Step 1: Create the webhook**

In the Supabase Dashboard for project `yyzbgdmgyvvypfcjuhtr` → Database → Webhooks → Create a new webhook:
- Table: `worker_assignments`
- Events: `INSERT`, `UPDATE`, `DELETE`
- Type: HTTP Request
- URL: `<web app url from Task 11>?secret=<WEBHOOK_SHARED_SECRET from Task 11 Step 5>`
- Method: `POST`

- [ ] **Step 2: Verify end-to-end**

Insert a test row directly in the Supabase SQL Editor:

```sql
INSERT INTO worker_assignments (worker_id, site_id, date, type, shift)
SELECT id, (SELECT id FROM sites LIMIT 1), CURRENT_DATE + 7, 'site', 'morning'
FROM workers LIMIT 1;
```

Then check the `workworkwork` calendar for a new all-day event on that date, 7 days out, titled with the site's number/name and listing the worker. Clean up:

```sql
DELETE FROM worker_assignments
WHERE date = CURRENT_DATE + 7 AND type = 'site';
```

Confirm the Calendar event disappears too.

---

### Task 13: Configure the LINE webhook (manual)

**Files:** none (LINE Developers Console configuration)

- [ ] **Step 1: Get the existing group's id**

The group already exists with the LINE OA in it. Temporarily enable webhook logging (or use the LINE Developers Console's "Verify" tool after Step 2) and send any message in the group — inspect the delivered event's `source.groupId` field. Set this as `LINE_GROUP_ID` in Task 11 Step 5's Script Properties (redeploy is not required — Script Properties are read live).

- [ ] **Step 2: Register the webhook URL**

In the LINE Developers Console → the existing Official Account's channel → Messaging API tab:
- Webhook URL: `<web app url from Task 11>` (no query string needed here — the secret param is only for the Supabase webhook; LINE has no equivalent since GAS can't read its signature header, per the Global Constraints note)
- Enable "Use webhook"
- Click "Verify" — expect success (the deployment already returns `200 ok` for any well-formed LINE payload)

- [ ] **Step 3: Verify pull works**

In the LINE group, type `@บอท ตารางงานวันนี้`. Expect one reply message listing today's Calendar events (or "วันนี้ไม่มีตารางงาน" if none).

---

### Task 14: End-to-end verification checklist (manual)

**Files:** none

- [ ] **Step 1: New assignment (advance planning) does not push**

In FXPM's Assign page, assign a worker to a site for a date next week. Confirm a Calendar event appears on `workworkwork`. Confirm no LINE message was sent to the group.

- [ ] **Step 2: Same-day reassignment pushes once**

In FXPM, edit an existing assignment whose date is today (move the worker to a different site, or change the shift). Confirm: the Calendar event(s) for today update correctly (old site's event loses the worker if the site changed; new site's event gains them), and exactly one LINE push arrives in the group.

- [ ] **Step 3: Pull reflects the same-day change**

In the LINE group, type `@บอท ตารางงานวันนี้`. Confirm the reply matches what Step 2 changed.

- [ ] **Step 4: Deleting the last assignment for a site+day removes the event**

Delete all of today's assignments for one site. Confirm its Calendar event is deleted (not left empty) and the corresponding `calendar_sync` row is gone (`SELECT * FROM calendar_sync WHERE site_id = '<id>' AND assignment_date = CURRENT_DATE;` returns no rows).

- [ ] **Step 5: Quota cap fallback**

Temporarily set `PUSH_QUOTA_CAP` to `0` in Script Properties. Make a same-day reassignment. Confirm no push is sent (check GAS execution log — `incrementAndCheckPushQuota` should return `false`) but the Calendar still syncs correctly, and pulling via keyword still works. Restore `PUSH_QUOTA_CAP` to `25` afterward.
