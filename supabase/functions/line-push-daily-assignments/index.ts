// supabase/functions/line-push-daily-assignments/index.ts
// Scheduled (Supabase Cron -- see
// supabase/migrations/2026-09-19-02-line-push-cron.sql) daily push of
// tomorrow's site assignments to each tenant's LINE crew group -- ONE
// combined message per tenant per day, grouped by site (same shape as
// Assign.jsx's "คัดลอกสำหรับ LINE" button, src/pages/assign/lineExport.js),
// not one message per worker. The original per-worker design burned
// through LINE's monthly free push quota N times faster for zero
// benefit -- flagged live (2026-09-27) after the daily-assignments
// push alone was already ~230 of a 300/month quota with 9-10 workers/day,
// before counting anything else that pushes (cheque/invoice reminders,
// เบิกของ/ขอลา admin notifications). A single combined send says the
// same thing in one call.
//
// "Real site work (not leave/holiday)" filter: this codebase's own
// established definition of that phrase is in
// src/pages/assign/DayView.jsx:43-58 -- "group site/factory/subcontract
// by site; keep others separately" where the "others" bucket is
// literally commented `// leave/office/holiday`. So a row counts as
// real site work here iff `site_id IS NOT NULL AND type IN
// ('site','factory','subcontract')` -- office/leave/leave_sick/
// leave_personal/holiday are excluded, same as that view groups them.
//
// verify_jwt is ON, but that ALONE is not real access control -- it
// only checks that the Authorization bearer is a validly-signed JWT
// for this project, not its role. This project's anon key is such a
// JWT and is intentionally public (ships in the client bundle), so
// verify_jwt alone would let anyone holding it call this function
// directly, on demand, bypassing the cron schedule -- against the real
// tenant's real crew LINE group. The real access control is the
// `x-cron-secret` header check immediately below, verified via
// public.verify_cron_secret() (see
// supabase/migrations/2026-09-19-04-line-push-cron-secret-verify-fn.sql)
// BEFORE any other query or LINE push.
import { createClient } from 'jsr:@supabase/supabase-js@2'
import { sendLinePush } from '../_shared/line.ts'

const SUPABASE_URL = Deno.env.get('SUPABASE_URL')!
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)

async function isAuthorizedCronCall(req: Request): Promise<boolean> {
  const provided = req.headers.get('x-cron-secret')
  if (!provided) return false
  const { data, error } = await admin.rpc('verify_cron_secret', { provided })
  if (error) {
    console.error('verify_cron_secret RPC failed', error)
    return false
  }
  return data === true
}

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// Bangkok has no DST -- a fixed +7h offset from UTC is always correct.
// This runs on Deno Deploy (UTC clock), so "tomorrow" has to mean
// tomorrow in Bangkok, not UTC (same reasoning as line-webhook's
// bangkokToday()).
function bangkokTomorrowISO(): string {
  const bkk = new Date(Date.now() + 7 * 60 * 60 * 1000)
  bkk.setUTCDate(bkk.getUTCDate() + 1)
  return bkk.toISOString().slice(0, 10)
}

const DOW_TH = ['อา', 'จ', 'อ', 'พ', 'พฤ', 'ศ', 'ส']

// Ported line-for-line from src/lib/lineNotifications.js's
// formatDailyAssignmentsPushMessage -- keep in sync with that file.
type SiteGroup = {
  siteName: string; siteNumber?: string; morning: string[]; evening: string[]
  leaderMorning?: string | null; leaderEvening?: string | null
}
function formatDailyAssignmentsPushMessage(dateISO: string, siteGroups: SiteGroup[]): string {
  const dow = DOW_TH[new Date(dateISO).getDay()]
  const lines = [`📋 พรุ่งนี้ (${dow}) ทำงานที่:`]
  siteGroups.forEach((g) => {
    lines.push('')
    lines.push(`🏗️ ${g.siteNumber ? `${g.siteNumber} ` : ''}${g.siteName}`.trim())
    if (g.morning.length) lines.push(`🌅 เช้า: ${g.morning.join(', ')}`)
    if (g.evening.length) lines.push(`🌆 บ่าย: ${g.evening.join(', ')}`)
    if (g.leaderMorning || g.leaderEvening) {
      const parts: string[] = []
      if (g.leaderMorning) parts.push(`เช้า ${g.leaderMorning}`)
      if (g.leaderEvening) parts.push(`บ่าย ${g.leaderEvening}`)
      lines.push(`⛑️ หัวหน้าทีม: ${parts.join(' · ')}`)
    }
  })
  return lines.join('\n')
}

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405)
  if (!(await isAuthorizedCronCall(req))) return json({ error: 'unauthorized' }, 401)

  const tomorrow = bangkokTomorrowISO()

  const { data: settingsRows, error: settingsError } = await admin
    .from('line_settings')
    .select('tenant_id, channel_access_token, crew_group_id')
    .not('crew_group_id', 'is', null)
  if (settingsError) return json({ error: settingsError.message }, 500)

  let tenantsProcessed = 0
  let messagesPushed = 0
  let pushFailures = 0
  let tenantsSkippedEmpty = 0

  for (const settings of settingsRows ?? []) {
    tenantsProcessed++

    const { data: rows, error } = await admin
      .from('worker_assignments')
      .select('site_id, shift, type, is_team_leader, workers(name, nickname), sites(name, site_number)')
      .eq('tenant_id', settings.tenant_id)
      .eq('date', tomorrow)
      .not('site_id', 'is', null)
      .in('type', ['site', 'factory', 'subcontract'])
    if (error) {
      console.error('worker_assignments query failed', settings.tenant_id, error)
      continue
    }
    if (!rows || rows.length === 0) { tenantsSkippedEmpty++; continue }

    // Grouped by site, not by worker -- one combined message per
    // tenant instead of one push per worker (see file header).
    const bySite = new Map<string, SiteGroup>()
    for (const r of rows) {
      const worker = r.workers as { name?: string; nickname?: string } | null
      const site = r.sites as { name?: string; site_number?: string } | null
      const workerName = worker?.nickname || worker?.name || 'ไม่ทราบชื่อ'
      const siteId = r.site_id as string
      const group = bySite.get(siteId) ?? {
        siteName: site?.name || '-', siteNumber: site?.site_number, morning: [], evening: [],
        leaderMorning: null, leaderEvening: null,
      }
      if (r.shift === 'evening') {
        group.evening.push(workerName)
        if (r.is_team_leader) group.leaderEvening = workerName
      } else {
        group.morning.push(workerName)
        if (r.is_team_leader) group.leaderMorning = workerName
      }
      bySite.set(siteId, group)
    }

    const message = formatDailyAssignmentsPushMessage(tomorrow, [...bySite.values()])
    const result = await sendLinePush(settings.channel_access_token, settings.crew_group_id as string, message)
    if (result.ok) messagesPushed++
    else {
      pushFailures++
      console.error('sendLinePush failed', settings.tenant_id, result.status)
    }
  }

  return json({ ok: true, tenantsProcessed, tenantsSkippedEmpty, messagesPushed, pushFailures })
})
