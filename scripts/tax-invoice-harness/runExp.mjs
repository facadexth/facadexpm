// Expenses page scenarios. Run alone: node scripts/tax-invoice-harness/buildExp.mjs && node scripts/tax-invoice-harness/runExp.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'exp-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const today = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
const mk = (id, o = {}) => ({ id, date: today, description: 'จากใบสั่งซื้อ PO-1 ' + id, site_name: 'Site A', category_name: 'วัสดุ', supplier: 'Sup', amount: 44940, amount_no_vat: 42000, vat: 2940, payment_method: 'transfer', status: 'pending', po_id: 'P1', cheque_id: null, invoice_no: null, ...o })
const rows = [
  mk('B1'),                                            // PO bill, pending -> split offered
  mk('B2', { status: 'awaiting_billing' }),            // awaiting billing -> shown disabled
  mk('B3', { po_id: null, description: 'ค่าน้ำ' }),     // not a PO bill -> not offered
  mk('B4', { cheque_id: 'c1', status: 'pending' }),   // cheque-linked -> not offered
  mk('B5', { status: 'paid' }),                        // paid -> not offered
  mk('B6'),                                            // credit-note expense (in __cnIds) -> not offered
]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1280, height: 800 } })
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(d => { window.__exp = d; window.__cnIds = ['B6'] }, rows)
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
const wait = ms => page.waitForTimeout(ms)
const render = async () => { await page.evaluate(() => { window.__log = []; window.__render() }); await wait(600) }
const log = () => page.evaluate(() => window.__log)
const splitBtns = () => page.getByRole('button', { name: '💸 จ่ายบางส่วน' })
const go = () => page.getByRole('button', { name: '✅ บันทึกการจ่ายบางส่วน' })
const rowOf = id => page.getByRole('row').filter({ hasText: id })

console.log('=== 1 who gets จ่ายบางส่วน')
await render()
ok('two buttons: pending PO bill (enabled) and awaiting billing (disabled)', (await splitBtns().count()) === 2, String(await splitBtns().count()))
ok('pending PO bill offers it enabled', await rowOf('PO-1 B1').getByRole('button', { name: '💸 จ่ายบางส่วน' }).isEnabled())
const dis = rowOf('PO-1 B2').getByRole('button', { name: '💸 จ่ายบางส่วน' })
ok('awaiting_billing bill: disabled with Thai title', (await dis.isDisabled()) && (await dis.getAttribute('title')) === 'เปลี่ยนสถานะเป็นค้างจ่ายก่อน')
for (const id of ['ค่าน้ำ', 'PO-1 B4', 'PO-1 B5', 'PO-1 B6']) ok('no action on ' + id, (await rowOf(id).getByRole('button', { name: '💸 จ่ายบางส่วน' }).count()) === 0)

console.log('=== 2 split dialog maths, guards, call, refetch')
await rowOf('PO-1 B1').getByRole('button', { name: '💸 จ่ายบางส่วน' }).click(); await wait(300)
const m = page.locator('.modal')
ok('dialog shows bill 44,940.00', (await m.innerText()).includes('44,940.00'))
ok('disabled while empty', await go().isDisabled())
await m.getByLabel('ยอดที่จ่ายครั้งนี้').fill('44940')
ok('whole bill refused', (await m.innerText()).includes('น้อยกว่ายอดบิล') && (await go().isDisabled()))
await m.getByLabel('ยอดที่จ่ายครั้งนี้').fill('20000')
const t = await m.innerText()
ok('preview paid 20,000.00 (VAT 1,308.41) and remaining 24,940.00 (VAT 1,631.59)', t.includes('1,308.41') && t.includes('24,940.00') && t.includes('1,631.59'), t)
await m.getByLabel('วันที่จ่าย').fill('2099-01-01')
ok('future paid date disables', await go().isDisabled())
await m.getByLabel('วันที่จ่าย').fill(today)
await page.evaluate(() => { window.__wrapperDelay = 300 })
await go().dblclick({ force: true }); await wait(50)
ok('busy: disabled during the call', await m.locator('.btn-primary').isDisabled())
await wait(600); await page.evaluate(() => { window.__wrapperDelay = 0 })
const c = (await log()).filter(x => x[1] === 'split_payment')
ok('double click = ONE call with amount and date', c.length === 1 && JSON.parse(c[0][2]).amount === '20000' && JSON.parse(c[0][2]).paidDate === today, JSON.stringify(await log()))
ok('closed with toast', (await page.locator('.modal').count()) === 0 && (await page.locator('body').innerText()).includes('แยกบิลแล้ว'))
await wait(300)
ok('list refetched: remainder row appears', (await page.locator('body').innerText()).includes('ยอดคงเหลือ NEW'))
ok('paid bill no longer offers split', (await rowOf('PO-1 B1').getByRole('button', { name: '💸 จ่ายบางส่วน' }).count()) === 0)

console.log('=== 3 server error stays in the dialog, in Thai')
await page.evaluate(() => { window.__exp = window.__exp.filter(e => e.id !== 'enew').map(e => e.id === 'B1' ? { ...e, status: 'pending', amount: 44940 } : e) })
await render()
await page.evaluate(() => { window.__wrapperError = { message: 'bill_not_pending' } })
await splitBtns().first().click(); await wait(300)
await page.locator('.modal').getByLabel('ยอดที่จ่ายครั้งนี้').fill('100')
await go().click(); await wait(300)
const et = await page.locator('.modal').innerText()
ok('Thai error, dialog open, no raw code', et.includes('ค้างจ่าย') && !et.includes('bill_not_pending'), et)
ok('button usable again after the error', await go().isEnabled())
await page.evaluate(() => { window.__wrapperError = null })
await page.getByRole('button', { name: 'ยกเลิก', exact: true }).click(); await wait(200)

console.log('=== 4 pre-migration: action hidden, page still works')
await page.evaluate(() => { window.__splitReady = false })
await render()
ok('schema not ready: no จ่ายบางส่วน anywhere, rows still listed', (await splitBtns().count()) === 0 && (await page.locator('body').innerText()).includes('ค่าน้ำ'))
await page.evaluate(() => { window.__splitReady = true })

console.log('=== 5 mobile')
await page.setViewportSize({ width: 375, height: 740 }); await render()
await splitBtns().first().click(); await wait(300)
const bb = await go().boundingBox()
ok('confirm reachable at 375px', !!bb && bb.x >= 0 && bb.x + bb.width <= 376, JSON.stringify(bb))

const errs = await page.evaluate(() => window.__errors)
ok('no React errors', errs.length === 0, errs.join('\n'))
await browser.close()
console.log(fails ? `FAILED ${fails}` : 'ALL PASS')
process.exit(fails ? 1 : 0)
