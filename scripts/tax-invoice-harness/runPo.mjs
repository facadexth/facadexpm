// PO page scenarios (see README.md). Run alone: node scripts/tax-invoice-harness/buildPo.mjs && node scripts/tax-invoice-harness/runPo.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'po-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const S1 = '11111111-1111-1111-1111-111111111111'
const SITE = 'aaaaaaaa-0000-0000-0000-000000000001'
const mkItem = (o = {}) => ({ id: 'pi' + Math.random(), description: 'เหล็ก', quantity: 10, unit: 'kg', unit_price: 100, discount_pct: 0, line_total: 1000, inventory_item_id: 'I1', aluminum_profile_id: null, ...o })
const mkPo = (id, no, status, o = {}) => ({ id, po_number: no, date: '2026-10-02', supplier_id: S1, status, site_id: SITE, category_id: null, sites: { name: 'Site A' }, suppliers: { name: 'Supplier One' }, has_vat: true, price_includes_vat: false, purchase_order_items: [mkItem()], purchase_order_attachments: [], expense_id: status === 'received' ? 'e' + id : null, ...o })
const data = {
  suppliers: [{ id: S1, name: 'Supplier One' }], sites: [{ id: SITE, name: 'Site A' }], categories: [],
  items: [{ id: 'I1', name: 'เหล็ก', base_unit: 'kg', unit_conversion_mode: 'plain', active: true }],
  pos: [
    mkPo('A', 'PO-A', 'received', { stock_from_invoice: false }),                 // linked, posted invoice
    mkPo('B', 'PO-B', 'received', { stock_from_invoice: true }),                  // flagged, awaiting
    mkPo('C', 'PO-C', 'ordered', { stock_from_invoice: false }),                  // plain, can receive
    mkPo('D', 'PO-D', 'ordered', { stock_from_invoice: true }),                   // flagged, can receive
    mkPo('E', 'PO-E', 'ordered', { stock_from_invoice: false }),                  // ordered but (artificially) linked: edit disabled
  ],
}
const browser = await chromium.launch()
const page = await browser.newPage()
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(d => { window.__data = d }, data)
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
const alerts = []
page.on('dialog', d => { alerts.push(d.message()); d.accept() })
const wait = ms => page.waitForTimeout(ms)
const text = async () => (await page.locator('body').innerText()).replace(/\n+/g, ' | ')
const set = (k, v) => page.evaluate(([k2, v2]) => { window[k2] = v2 }, [k, v])
const render = async () => { await page.evaluate(() => { window.__log = []; window.__render() }); await wait(500) }
const log = () => page.evaluate(() => window.__log)
const row = re => page.getByRole('row', { name: re })

console.log('=== 1 not ready (links null): page works exactly as before')
await set('__links', null); await render()
let t = await text()
ok('list renders all POs', ['PO-A', 'PO-B', 'PO-C', 'PO-D', 'PO-E'].every(n => t.includes(n)), t.slice(0, 300))
ok('no tax invoice badges', !t.includes('ใบกำกับ') && !t.includes('รอใบกำกับ'), t)
ok('no crash', !t.includes('CRASH'))
ok('edit enabled on an ordered PO', !(await row(/PO-E/).locator('button.btn-edit').isDisabled()))
await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
t = await text()
ok('add form open, flag checkbox hidden', t.includes('เพิ่มใบสั่งซื้อ') && !t.includes('สต็อกเข้าตอนบันทึกใบกำกับภาษี'), t.slice(0, 200))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)

console.log('=== 2 live links: badges, locked edit, hidden swap')
await set('__links', [['A', { invoice_id: 'i1', invoice_no: 'INV-1', status: 'posted' }], ['E', { invoice_id: 'i2', invoice_no: 'INV-2', status: 'draft' }]]); await render()
t = await text()
ok('linked badge with invoice no', (await row(/PO-A/).innerText()).includes('ใบกำกับ INV-1'))
ok('draft link says (ร่าง)', (await row(/PO-E/).innerText()).includes('ใบกำกับ INV-2 (ร่าง)'))
ok('flagged received PO without invoice: awaiting badge', (await row(/PO-B/).innerText()).includes('รอใบกำกับ (สต็อกยังไม่เข้า)'))
ok('plain PO has no badge', !(await row(/PO-C/).innerText()).includes('ใบกำกับ'))
const editE = row(/PO-E/).locator('button.btn-edit')
ok('linked ordered PO: edit disabled with explanation', await editE.isDisabled() && (await editE.getAttribute('title')) === 'ใบสั่งซื้อนี้ผูกกับใบกำกับภาษี INV-2 แก้ไขไม่ได้', await editE.getAttribute('title'))
ok('unlinked ordered PO: edit enabled', !(await row(/PO-C/).locator('button.btn-edit').isDisabled()))
await row(/PO-A/).getByRole('button').last().click(); await wait(150)
t = await text()
ok('swap action hidden for linked PO, credit note action still there', !t.includes('สลับใบกำกับภาษี') && t.includes('สร้างใบลดหนี้'), t.slice(-300))
await render()
await row(/PO-B/).getByRole('button').last().click(); await wait(150)
ok('swap action still there for an unlinked received PO', (await text()).includes('สลับใบกำกับภาษี'))
await render()
await row(/PO-A/).getByRole('button', { name: '👁️' }).click(); await wait(300)
ok('detail header shows the linked badge', (await page.locator('.modal').innerText()).includes('ใบกำกับ INV-1'))
await page.getByRole('button', { name: 'ปิด' }).click(); await wait(200)
await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
ok('add form shows the flag checkbox + hint', (await text()).includes('สต็อกเข้าตอนบันทึกใบกำกับภาษี (รับของแล้วไม่ลงสต็อก)') && (await text()).includes('ใช้กับซัพพลายเออร์ที่ออกใบกำกับรวมรายเดือน'))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)

console.log('=== 3 receive: unflagged PO posts stock as before')
await row(/PO-C/).getByRole('button', { name: '✅ รับของแล้ว' }).click(); await wait(500)
t = await page.locator('.modal').innerText()
ok('stock plan shown, no flag note', t.includes('จะบันทึกเข้าสต็อก') && !t.includes('ไม่ลงสต็อกตอนรับของ'), t)
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(600)
let L = await log()
ok('deposit RPC happens BEFORE record_stock_movement (once each)', L.filter(x => x[1] === 'receive_po_with_deposits').length === 1 && L.filter(x => x[1] === 'record_stock_movement').length === 1 && L.findIndex(x => x[1] === 'receive_po_with_deposits') < L.findIndex(x => x[1] === 'record_stock_movement'), JSON.stringify(L))

console.log('=== 4 receive: flagged PO shows the note and skips stock, keeps expense/audit')
await render()
await row(/PO-D/).getByRole('button', { name: '✅ รับของแล้ว' }).click(); await wait(500)
t = await page.locator('.modal').innerText()
ok('note shown once, stock plan hidden', t.includes('ไม่ลงสต็อกตอนรับของ — สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษีผู้ขาย') && (t.match(/ไม่ลงสต็อกตอนรับของ/g) || []).length === 1 && !t.includes('จะบันทึกเข้าสต็อก'), t)
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(600)
L = await log()
ok('deposit RPC called, NO record_stock_movement', L.filter(x => x[1] === 'receive_po_with_deposits').length === 1 && L.filter(x => x[1] === 'record_stock_movement').length === 0, JSON.stringify(L))
ok('audit logging kept (audit_log insert)', L.some(x => x[0] === 'insert' && x[1] === 'audit_logs'), JSON.stringify(L))
ok('toast mentions stock comes with the invoice', (await text()).includes('สต็อกจะเข้าเมื่อบันทึกใบกำกับภาษี'))

console.log('=== 5 receive errors map to Thai')
await render()
await set('__rpcError', { message: 'po_tax_invoiced — PO is on a posted tax invoice' })
alerts.length = 0
await row(/PO-C/).getByRole('button', { name: '✅ รับของแล้ว' }).click(); await wait(500)
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(600)
ok('po_tax_invoiced shown in Thai, raw text hidden', alerts.length === 1 && alerts[0].includes('ใบกำกับภาษี') && !alerts[0].includes('po_tax_invoiced'), JSON.stringify(alerts))
await set('__rpcError', { code: '40P01', message: 'deadlock detected' })
alerts.length = 0
await render()
await row(/PO-C/).getByRole('button', { name: '✅ รับของแล้ว' }).click(); await wait(500)
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(600)
ok('deadlock shown in Thai', alerts.length === 1 && alerts[0].includes('ลองใหม่') && !alerts[0].includes('deadlock'), JSON.stringify(alerts))
await set('__rpcError', { message: 'some other failure' })
alerts.length = 0
await render()
await row(/PO-C/).getByRole('button', { name: '✅ รับของแล้ว' }).click(); await wait(500)
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(600)
ok('other errors keep the raw message', alerts.length === 1 && alerts[0].includes('Error: some other failure'), JSON.stringify(alerts))

console.log('=== 6 scan: date guard + stock auto-link')
await page.evaluate(() => { const m = new Map(); Object.defineProperty(window, 'localStorage', { configurable: true, value: { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: k => m.delete(k) } }) })
const isoDaysAgo = n => new Date(Date.now() + 7 * 3600e3 - n * 86400e3).toISOString().slice(0, 10)
const scanLines = [{ description: ' เหล็ก ', quantity: 3, unit: 'kg', unit_price: 50, discount_pct: 0 }, { description: 'ของไม่มีในสต็อก', quantity: 1, unit: 'ชิ้น', unit_price: 10, discount_pct: 0 }]
const scanOnce = async (draftDate, guess) => {
  await render()
  await page.evaluate(([d]) => { try { localStorage.setItem('draft:purchase-order-form', JSON.stringify({ supplier_id: '11111111-1111-1111-1111-111111111111', date: d })) } catch (e) { window.__lsErr = String(e) } }, [draftDate])
  await set('__extract', { ok: true, data: { document_date_guess: guess, reference_no_guess: 'R-1', line_items: scanLines, deposit_deductions: [] } })
  await page.getByRole('button', { name: '+ เพิ่มใบสั่งซื้อ' }).click(); await wait(400)
  await page.locator('input[type=file]').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4 x') }); await wait(900)
}
await scanOnce('2026-09-19', '2018-09-19')
ok('draft restored (localStorage works in harness)', (await page.locator('input[type=date]').first().inputValue()) === '2026-09-19', await page.evaluate(() => window.__lsErr || ''))
ok('implausible scan date: form date kept', (await page.locator('input[type=date]').first().inputValue()) === '2026-09-19')
t = await text()
ok('amber note shows the scanned date dd/mm/yyyy', t.includes('เอกสารอ่านวันที่ได้ 19/09/2018 ไม่ตรงกับที่คาด (ใช้วันที่ในฟอร์มแทน) กรุณาตรวจวันที่'), t.slice(0, 400))
ok('exact-name line auto-linked: chip once', (t.match(/เชื่อมอัตโนมัติ — ตรวจสอบ/g) || []).length === 1, t)
ok('reference note unchanged', (await page.evaluate(() => [...document.querySelectorAll('textarea,input')].map(e => e.value).join('|'))).includes('อ้างอิง: R-1'))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)
await page.evaluate(() => localStorage.removeItem('draft:purchase-order-form'))
const good = isoDaysAgo(10)
await scanOnce('', good)
ok('empty form date + plausible guess: applied, no note', (await page.locator('input[type=date]').first().inputValue()) === good && !(await text()).includes('ไม่ตรงกับที่คาด'))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)
await page.evaluate(() => localStorage.removeItem('draft:purchase-order-form'))
await scanOnce('', '2018-09-19')
ok('empty form date + implausible guess: stays empty, note shown', (await page.locator('input[type=date]').first().inputValue()) === '' && (await text()).includes('19/09/2018 ไม่ตรงกับที่คาด'))
await page.getByRole('button', { name: '← กลับ' }).click(); await wait(200)
await page.evaluate(() => localStorage.removeItem('draft:purchase-order-form'))

const errs = await page.evaluate(() => window.__errors)
ok('no React errors', errs.length === 0, errs.join('\n'))
await browser.close()
console.log(fails ? `FAILED ${fails}` : 'ALL PASS')
process.exit(fails ? 1 : 0)
