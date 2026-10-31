// Site overview quotation table. Run: node scripts/tax-invoice-harness/buildOverview.mjs && node scripts/tax-invoice-harness/runOverview.mjs [shot.png]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'overview-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const item = (n) => ({ line_total: n, item_type: 'item' })
const qt = (id, no, date, amount) => ({ id, quotation_number: no, date, has_vat: true, price_includes_vat: false, discount_amount: 0, discount_pct: 0, quotation_items: [item(amount)] })
const data = {
  site: { id: 'S', status: 'Ongoing', contract_value: 444103.5, total_income: 81338.4, total_expense: 0, gross_profit: 81338.4, worker_labor_cost: 0, billing_pct: 0, end_date: null,
    deposit: { total_deposit: 78210, deducted: 0, remaining_balance: 78210 }, retention: {} },
  quotations: [qt('q2', 'QT-2026-071', '2026-10-05', 154350), qt('q1', 'QT-2026-053', '2026-09-01', 260700)],
  invoices: [
    { quotation_id: 'q1', subtotal: '78210', status: 'paid', is_deposit: true },
    { quotation_id: 'q1', subtotal: '150000', status: 'paid', is_deposit: false },
    { quotation_id: 'q1', subtotal: '260700', status: 'void', is_deposit: false },
    { quotation_id: 'q2', subtotal: '77175', status: 'issued', is_deposit: false },
  ],
}
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 700, height: 900 } })
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(d => { window.__ov = d }, data)
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
await page.evaluate(() => window.__render())
await page.waitForTimeout(600)
const rows = await page.locator('table tbody tr').allInnerTexts()
const body = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
ok('two quotations listed oldest first', rows.length === 2 && rows[0].includes('QT-2026-053') && rows[1].includes('QT-2026-071'), JSON.stringify(rows))
ok('QT-053: 278,949.00 value, 160,500.00 billed, 118,449.00 left, 57.5%', /278,949\.00\s+160,500\.00\s+118,449\.00\s+57\.5%/.test(rows[0].replace(/\s+/g, ' ')), rows[0])
ok('QT-071: half billed', /165,154\.50\s+82,577\.25\s+82,577\.25\s+50\.0%/.test(rows[1].replace(/\s+/g, ' ')), rows[1])
ok('total row sums both', /รวม\s*444,103\.50\s+243,077\.25\s+201,026\.25\s+54\.7%/.test((await page.locator('tfoot').innerText()).replace(/\s+/g, ' ')), await page.locator('tfoot').innerText())
ok('deposit receipt and void invoice are not counted as billing', !rows[0].includes('100.0%'))
await page.screenshot({ path: process.argv[2] || path.join(tmpdir(), 'overview.png'), fullPage: true })
console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await browser.close()
process.exit(fails ? 1 : 0)
