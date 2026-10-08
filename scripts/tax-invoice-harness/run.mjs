import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'tax-invoice-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const S1 = '11111111-1111-1111-1111-111111111111'
const SITE = 'aaaaaaaa-0000-0000-0000-000000000001'
const poItem = { id: 'pi1', description: 'd', quantity: 10, unit: 'kg', unit_price: 100, discount_pct: 0, line_total: null, inventory_item_id: null }
const PO = { id: 'P1', po_number: 'PO-001', date: '2026-10-02', supplier_id: S1, status: 'received', site_id: SITE, sites: { name: 'Site A' }, has_vat: true, price_includes_vat: false, purchase_order_items: [poItem], expense_id: 'eP1', expenses: { amount_no_vat: 1000 }, stock_from_invoice: false }
const link = (id, o = {}) => ({ id: 'L' + id, po_id: 'P1', active: true, po_subtotal: 1000, expense_id: 'eP1', prev_invoice_no: 'OLD-1', stamped_invoice_no: 'INV-' + id, purchase_orders: { id: 'P1', po_number: 'PO-001' }, ...o })
const item = { id: 'it1', sort_order: 0, description: 'Steel', qty: 10, unit: 'kg', unit_price: 100, discount_pct: 0, amount: 1000, inventory_item_id: 'I1', site_id: SITE, base_qty: 10 }
const inv = (id, status, o = {}) => ({ id, supplier_id: S1, invoice_no: 'INV-' + id, invoice_date: '2026-10-05', net_before_vat: 1000, vat: 70, grand_total: 1070, match_diff: status === 'draft' ? null : 0, match_note: '', status, post_result: null,
  suppliers: { name: 'Supplier One' }, supplier_tax_invoice_items: [item], supplier_tax_invoice_pos: [link(id)], ...o })
const inv8 = id => inv(id, 'draft', { supplier_tax_invoice_items: Array.from({ length: 8 }, (_, k) => ({ ...item, id: 'it8' + k, sort_order: k, description: 'Steel ' + k, qty: 1, unit_price: 125, amount: 125, base_qty: 1 })) })
const S2 = '22222222-2222-2222-2222-222222222222'
const rcpt = (id, seq, date, sub, vat, o = {}, po = {}) => ({ id, po_id: 'PD', seq, received_date: date, goods_subtotal: sub, goods_vat: vat, expense_id: 'e' + id,
  purchase_orders: { id: 'PD', po_number: 'PO-1', supplier_id: S1, site_id: SITE, tax_invoice_mode: 'delivery', stock_from_invoice: false, has_vat: true, price_includes_vat: false, ...po }, po_receipt_items: [], ...o })
const data = {
  suppliers: [{ id: S1, name: 'Supplier One' }], sites: [{ id: SITE, name: 'Site A' }], categories: [],
  items: [{ id: 'I1', name: 'Steel', base_unit: 'kg', unit_conversion_mode: 'plain', active: true }],
  factors: [], links: [], pos: [PO, { ...PO, id: 'PD', po_number: 'PO-DEL', tax_invoice_mode: 'delivery' }], deposits: [],
  deliveryReceipts: [
    rcpt('rA', 1, '2026-10-04', 600, 42, { po_receipt_items: [{ quantity: 2, base_qty: 2, purchase_order_items: { description: 'Steel', unit: 'kg', quantity: 2, unit_price: 300, discount_pct: 0, inventory_item_id: 'I1' } }] }),
    rcpt('rB', 2, '2026-10-02', 400, 28),
    rcpt('rC', 3, '2026-10-03', 300, 21),
    rcpt('rX', 1, '2026-10-01', 500, 35, {}, { supplier_id: S2, po_number: 'PO-9' }),
  ],
  receiptLinks: [['rC', { invoice_id: 'X', invoice_no: 'INV-X', status: 'posted' }]],
}
const browser = await chromium.launch()
const page = await browser.newPage()
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text().slice(0, 200)) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
// boot() = a fresh document + a fresh bundle (Modal keeps a module-level popstate counter, so the history
// scenarios need a clean module state)
const boot = async () => {
  await page.setContent('<div id="root"></div>')
  await page.evaluate(d => { window.__data = d; window.__deliveryReady = false }, data)
  await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)  // the REAL app css
  await page.addScriptTag({ content: js })
}
await boot()
const alerts = []
page.on('dialog', d => { alerts.push(d.message()); d.accept() })
const wait = ms => page.waitForTimeout(ms)
const text = async () => (await page.locator('body').innerText()).replace(/\n+/g, ' | ')
const set = (k, v) => page.evaluate(([k2, v2]) => { window[k2] = v2 }, [k, v])
const rpcLog = () => page.evaluate(() => window.__log.filter(x => x[0] === 'rpc').map(x => x[1]))
const render = async () => { await page.evaluate(() => { window.__log = []; window.__render() }); await wait(300) }
const setRpc = src => page.evaluate(s => { window.__rpc = eval('(' + s + ')') }, src)
const btn = n => page.getByRole('button', { name: n })
const dis = async n => (await btn(n).first().isDisabled())
const rowMenu = async (re, label) => { await page.getByRole('row', { name: re }).getByRole('button').last().click(); await page.getByText(label).click() }

console.log('=== 1 notReady')
await set('__notReady', true); await set('__invoices', []); await render()
ok('calm not-live state', (await text()).includes('ฟีเจอร์นี้ยังไม่เปิดใช้'))
ok('no crash / no error banner', !(await text()).includes('โหลดข้อมูลไม่สำเร็จ') && !(await text()).includes('CRASH'))

console.log('=== 2 empty list')
await set('__notReady', false); await render()
ok('empty text', (await text()).includes('ยังไม่มีใบกำกับภาษีผู้ขาย'))
ok('add button for OWNER', (await text()).includes('+ เพิ่มใบกำกับภาษีผู้ขาย'))

console.log('=== 3 list with posted/draft/void')
await set('__invoices', [inv('D1', 'draft'), inv('P9', 'posted', { match_diff: 40 }), inv('V1', 'void', { void_reason: 'wrong', voided_at: '2026-10-06T03:00:00Z', voided_by: 'a@b.c', supplier_tax_invoice_pos: [link('V1', { active: false })] })])
await render()
let t = await text()
ok('three rows', t.includes('INV-D1') && t.includes('INV-P9') && t.includes('INV-V1'), t)
ok('badges', t.includes('📝 ร่าง') && t.includes('✅ บันทึกแล้ว') && t.includes('🚫 ยกเลิก'))
const redDiff = await page.evaluate(() => [...document.querySelectorAll('td')].filter(td => td.style.color.includes('danger')).map(td => td.innerText))
ok('out-of-tolerance diff (40 vs 1000) shown red', redDiff.length === 1 && redDiff[0].includes('40'), JSON.stringify(redDiff))
await set('__role', 'WORKER'); await render()
ok('no add button for WORKER', !(await text()).includes('+ เพิ่มใบกำกับภาษีผู้ขาย'))
await set('__role', 'OWNER'); await render()

console.log('=== 4 open draft, preview with blocking checks')
const blocking = { checks: [{ code: 'po_linked_elsewhere', blocking: true, po_id: 'P1' }], rows: [], po_sum: 1000, diff: 0, tolerance: 5 }
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(blocking)}), post: () => { throw new Error('should not post') } })`)
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
t = await text()
ok('edit form opened with draft values', await page.locator('input[value="INV-D1"]').count() === 1 && t.includes('แก้ไขใบกำกับภาษีผู้ขาย'), t.slice(0, 300))
ok('no preview yet / no post button', !t.includes('✅ บันทึกใบกำกับ (ลงสต็อก)'))
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
t = await text()
ok('save then preview RPCs called in order', JSON.stringify(await rpcLog()) === '["save","preview"]', JSON.stringify(await rpcLog()))
ok('blocking check shown with PO number', t.includes('⛔') && t.includes('ใบสั่งซื้อนี้ผูกกับใบกำกับอื่นอยู่แล้ว (PO-001)'), t)
ok('post button disabled when blocking', await dis('✅ บันทึกใบกำกับ (ลงสต็อก)'))

console.log('=== 5 preview with warnings, stale guard, confirm dialog')
const warn = { revision: 7, checks: [{ code: 'po_outside_month', blocking: false, po_id: 'P1' }, { code: 'po_outside_month', blocking: false, po_id: 'P1' }], po_sum: 1000, diff: 0, tolerance: 5,
  rows: [{ inventory_item_id: 'I1', site_id: SITE, item_name: 'Steel', base_unit: 'kg', site_name: 'Site A', before_qty: 5, before_wac: 100, add_qty: 10, remove_qty: 20, after_qty: -5, after_wac: 100, negative: true }] }
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(warn)}), post: () => ({ lines_posted: 1, receipts_reversed: 1, expenses_stamped: 1, po_sum: 1000, diff: 0, checks: [{ code: 'po_has_deposit', blocking: false }, { code: 'po_has_deposit', blocking: false }], negative: [{ item_name: 'Steel', site_name: 'Site A', qty: -5 }] }) })`)
await page.evaluate(() => { window.__log = [] })
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
t = await text()
ok('warning amber + negative row shown', t.includes('⚠️ ใบสั่งซื้อนอกเดือนของใบกำกับ (PO-001)') && t.includes('-5 kg'))
ok('post button enabled', !(await dis('✅ บันทึกใบกำกับ (ลงสต็อก)')))
const idx = await page.locator('input').evaluateAll(els => els.findIndex(e => e.value === 'INV-D1'))
await page.locator('input').nth(idx).fill('INV-D1X'); await wait(200)
t = await text()
ok('stale message + disabled after form change', t.includes('ข้อมูลเปลี่ยนแล้ว — กด "ตรวจสอบก่อนบันทึก" อีกครั้ง') && await dis('✅ บันทึกใบกำกับ (ลงสต็อก)'))
await page.locator('input').nth(idx).fill('INV-D1'); await wait(200)
ok('reverting the form makes the preview current again', !(await text()).includes('ข้อมูลเปลี่ยนแล้ว') && !(await dis('✅ บันทึกใบกำกับ (ลงสต็อก)')))
await page.locator('input').nth(idx).fill('INV-D1X'); await wait(100)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
ok('re-preview makes it current', !(await text()).includes('ข้อมูลเปลี่ยนแล้ว'))
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(200)
t = await text()
ok('confirm overlay lists stock, reversal, negative, stamping, undo rule',
  t.includes('ยืนยันบันทึกใบกำกับภาษี — โปรดตรวจสอบ') && t.includes('เพิ่มสต็อกจากใบกำกับ 1 รายการ') && t.includes('กลับรายการรับเข้าสต็อกของใบสั่งซื้อ 1 ใบ')
  && t.includes('⚠️ Steel @ Site A: คงเหลือ 5 → -5 kg · ต้นทุนเฉลี่ย 100.00 → 100.00 · รับเข้าใหม่ +10 · กลับรายการ -20 (สต็อกจะติดลบ)') && t.includes('ประทับเลขที่ใบกำกับ INV-D1X') && t.includes('แก้ไขภายหลังไม่ได้'), t)
ok('duplicate warning: 2 rows in preview (mock sends 2), deduped to 1 in overlay', (t.match(/ใบสั่งซื้อนอกเดือนของใบกำกับ/g) || []).length === 3, String((t.match(/ใบสั่งซื้อนอกเดือนของใบกำกับ/g) || []).length))
ok('nothing posted yet', !(await rpcLog()).includes('post'))
await page.keyboard.press('Escape'); await wait(200)
t = await text()
ok('Escape closes only the overlay; form modal stays', !t.includes('ยืนยันบันทึกใบกำกับภาษี') && t.includes('แก้ไขใบกำกับภาษีผู้ขาย'), t.slice(0, 200))
ok('still nothing posted', !(await rpcLog()).includes('post'))

console.log('=== 6 post success with warnings (double click guard)')
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(200)
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).dblclick(); await wait(500)
ok('post called exactly once', (await rpcLog()).filter(x => x === 'post').length === 1, JSON.stringify(await rpcLog()))
const postArgs = await page.evaluate(() => window.__log.filter(x => x[0] === 'rpc' && x[1] === 'post').map(x => x[2]))
ok('post passes the previewed revision (id, 7)', postArgs.length === 1 && postArgs[0] === '["D1",7]', JSON.stringify(postArgs))
let a = alerts.at(-1) || ''
ok('success alert has counts, deduped warning, negative', a.includes('เพิ่มสต็อก 1 รายการ') && a.includes('กลับรายการ 1 รายการ') && a.includes('ประทับเลขที่ในรายจ่าย 1 รายการ')
  && (a.match(/ใบสั่งซื้อนี้หักมัดจำ/g) || []).length === 1 && a.includes('Steel @ Site A = -5'), a)
ok('modal closed after post', !(await text()).includes('แก้ไขใบกำกับภาษีผู้ขาย'))

console.log('=== 7 post failure')
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(warn)}), post: () => { const e = new Error('po_linked_elsewhere'); e.code = 'P0001'; throw e } })`)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(200)
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).click(); await wait(500)
a = alerts.at(-1) || ''
ok('mapped Thai error', a === 'ใบสั่งซื้อนี้ผูกกับใบกำกับอื่นอยู่แล้ว', a)
t = await text()
ok('overlay closed, form still open, preview dropped (not trusted)', !t.includes('ยืนยันบันทึกใบกำกับภาษี') && t.includes('แก้ไขใบกำกับภาษีผู้ขาย') && !t.includes('ผลตรวจสอบก่อนบันทึก'))
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(300)

console.log('=== 8 view + void with void_inexact warning')
await rowMenu(/INV-V1/, '👁️ ดูรายละเอียด'); await wait(400)
t = await text()
ok('view modal: void reason, voided by, PO + stamped expense no, site', t.includes('wrong') && t.includes('a@b.c') && t.includes('PO-001') && t.includes('INV-V1') && t.includes('Site A'), t)
await btn('ปิด').click(); await wait(200)
await setRpc(`({ void: (id, reason) => ({ warnings: [{ code: 'void_inexact', blocking: false }, { code: 'expense_changed', blocking: false, po_id: 'P1' }], negative: [{ item_name: 'Steel', site_name: 'Site A', qty: -1 }] }) })`)
await rowMenu(/INV-P9/, '🚫 ยกเลิกใบกำกับ'); await wait(300)
t = await text()
ok('void dialog text', t.includes('สต็อกจะกลับเป็นเหมือนก่อนบันทึก') && t.includes('🚫 ยืนยันยกเลิกใบกำกับ'))
await page.evaluate(() => { window.__log = [] })
await btn('🚫 ยืนยันยกเลิกใบกำกับ').click(); await wait(200)
ok('reason required, no RPC', (alerts.at(-1) || '').includes('กรุณากรอกเหตุผล') && !(await rpcLog()).includes('void'))
await page.locator('textarea').fill('typo'); await btn('🚫 ยืนยันยกเลิกใบกำกับ').dblclick(); await wait(500)
a = alerts.at(-1) || ''
ok('void once; alert has inexact + expense_changed + negative', (await rpcLog()).filter(x => x === 'void').length === 1 && a.includes('ต้นทุนเฉลี่ยอาจไม่เท่าเดิม') && a.includes('เลขที่ใบกำกับในรายจ่ายถูกแก้') && a.includes('Steel @ Site A = -1'), a)

console.log('=== 9 new invoice default date (Bangkok) + delete draft')
await page.getByRole('button', { name: '+ เพิ่มใบกำกับภาษีผู้ขาย' }).click(); await wait(400)
const expectDate = new Date(Date.now() + 7 * 3600e3).toISOString().slice(0, 10)
ok('default invoice date = Bangkok today', await page.locator(`input[value="${expectDate}"]`).count() >= 1, expectDate)
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(300)
await setRpc(`({ delete: () => null })`)
await rowMenu(/INV-D1/, '🗑️ ลบ'); await wait(300)
ok('delete confirm', (await text()).includes('ลบใบกำกับฉบับร่าง'))
await page.getByRole('button', { name: 'ยืนยัน', exact: true }).click(); await wait(400)
ok('delete RPC called', (await rpcLog()).includes('delete'))

console.log('=== 10 real-CSS layout: preview + post button reachable (1 line / 8 lines, desktop + phone)')
const warn2 = { checks: [{ code: 'po_has_deposit', blocking: false, po_id: 'P1' }], po_sum: 1000, diff: 0, tolerance: 5,
  rows: Array.from({ length: 8 }, (_, k) => ({ item_name: 'Steel ' + k, base_unit: 'kg', site_name: 'Site A', before_qty: 5, before_wac: 100, add_qty: 1, remove_qty: 3, after_qty: 3, after_wac: 101.5, negative: false })) }
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(warn2)}), post: () => ({ lines_posted: 1, receipts_reversed: 1, expenses_stamped: 1, checks: [], negative: [] }) })`)
await set('__invoices', [inv('D1', 'draft'), inv8('D8')])
for (const [w, h, id] of [[1280, 800, 'INV-D1'], [1280, 800, 'INV-D8'], [375, 740, 'INV-D1'], [375, 740, 'INV-D8']]) {
  await page.setViewportSize({ width: w, height: h }); await render()
  await rowMenu(new RegExp(id), '✏️ แก้ไข'); await wait(600)
  await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
  const modalBox = await page.locator('.modal').first().boundingBox()
  ok(`${w}x${h} ${id}: modal fits the viewport`, modalBox.y >= 0 && modalBox.y + modalBox.height <= h + 1, JSON.stringify(modalBox))
  const body = page.locator('.modal > .modal-body, .modal > form > .modal-body, .modal > form > fieldset > .modal-body').first()
  const bb0 = await body.boundingBox()
  await page.mouse.move(bb0.x + bb0.width / 2, bb0.y + Math.min(bb0.height / 2, 120))
  for (let i = 0; i < 12; i++) { await page.mouse.wheel(0, 500); await wait(30) }
  await wait(150)
  const postBtn = btn('✅ บันทึกใบกำกับ (ลงสต็อก)')
  const hit = async loc => {
    const b = await loc.boundingBox()
    if (!b) return { inView: false, hit: false }
    const cx = b.x + b.width / 2, cy = b.y + b.height / 2
    const inView = b.y >= 0 && b.y + b.height <= h && b.x >= 0 && b.x + b.width <= w
    const hitOk = await loc.evaluate((el, [x, y]) => { const e = document.elementFromPoint(x, y); return !!e && (e === el || el.contains(e)) }, [cx, cy])
    return { inView, hit: hitOk, b }
  }
  const pb = await hit(postBtn)
  ok(`${w}x${h} ${id}: post button inside viewport after wheel + clickable`, pb.inView && pb.hit, JSON.stringify(pb))
  const rowLast = await page.locator('[data-tick]').getByRole('cell', { name: id === 'INV-D8' ? 'Steel 7' : 'Steel 0', exact: true }).first().boundingBox()
  ok(`${w}x${h} ${id}: preview table row reachable (scrollable) not clipped below the modal`, !!rowLast && rowLast.y + rowLast.height <= modalBox.y + modalBox.height + 1, JSON.stringify(rowLast) + JSON.stringify(modalBox))
  ok(`${w}x${h} ${id}: footer buttons still visible`, (await hit(btn('👁️ ตรวจสอบก่อนบันทึก'))).inView)
  await postBtn.click(); await wait(200)
  const ob = await hit(page.getByRole('button', { name: '✅ ยืนยันบันทึก' }))
  ok(`${w}x${h} ${id}: confirm overlay buttons reachable`, ob.inView && ob.hit, JSON.stringify(ob))
  await page.keyboard.press('Escape'); await wait(150)
  await btn('ยกเลิก').first().click(); await wait(300)
}
await page.setViewportSize({ width: 1280, height: 800 })

console.log('=== 11 back button: overlay / busy (history entries)')
await boot()
await set('__invoices', [inv('D1', 'draft')]); await render()
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(warn)}), post: () => ({ lines_posted: 1, receipts_reversed: 1, expenses_stamped: 1, checks: [], negative: [] }) })`)
const hstate = () => page.evaluate(() => ({ modalOpen: !!(history.state && history.state.modalOpen), len: history.length }))
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(200)
ok('overlay open, history entry present', (await text()).includes('ยืนยันบันทึกใบกำกับภาษี') && (await hstate()).modalOpen)
await page.evaluate(() => history.back()); await wait(300)
t = await text()
ok('back closes ONLY the overlay; form modal stays open', !t.includes('ยืนยันบันทึกใบกำกับภาษี') && t.includes('แก้ไขใบกำกับภาษีผู้ขาย'), t.slice(0, 120))
ok('history entry restored (next back will not leave the page)', (await hstate()).modalOpen, JSON.stringify(await hstate()))
await page.evaluate(() => { window.__log = [] })
await set('__rpcDelay', 600)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(100)
await page.evaluate(() => history.back()); await wait(200)
ok('back while busy: form modal stays open and entry restored', (await text()).includes('แก้ไขใบกำกับภาษีผู้ขาย') && (await hstate()).modalOpen, JSON.stringify(await hstate()))
await wait(1500)
await set('__rpcDelay', 60)
await page.evaluate(() => history.back()); await wait(300)
ok('back when idle closes the form modal as usual', !(await text()).includes('แก้ไขใบกำกับภาษีผู้ขาย'))
await page.evaluate(() => { window.__log = [] })
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(200)
await set('__rpcDelay', 600)
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).click(); await wait(100)
await page.evaluate(() => history.back()); await wait(200)
ok('back while posting: overlay stays (cannot be dismissed mid-post)', (await text()).includes('ยืนยันบันทึกใบกำกับภาษี'))
await wait(1500)
ok('post still completed exactly once', (await rpcLog()).filter(x => x === 'post').length === 1, JSON.stringify(await rpcLog()))
await set('__rpcDelay', 60)

console.log('=== 12 double-count alert (PO without receipt movements): acknowledgement required; save invalidates the preview')
await boot()
await set('__invoices', [inv('D1', 'draft')]); await render()
const dbl = { revision: 4, checks: [{ code: 'po_no_receipt_movements', blocking: false, po_id: 'P1' }, { code: 'po_no_receipt_movements', blocking: false, po_id: 'P2' }, { code: 'po_has_deposit', blocking: false, po_id: 'P1' }], po_sum: 1000, diff: 0, tolerance: 5,
  rows: [{ inventory_item_id: 'I1', site_id: SITE, item_name: 'Steel', base_unit: 'kg', site_name: 'Site A', before_qty: 5, before_wac: 100, add_qty: 10, remove_qty: 0, after_qty: 15, after_wac: 100, negative: false }] }
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(dbl)}), post: () => ({ lines_posted: 1, receipts_reversed: 0, expenses_stamped: 1, checks: [], negative: [] }) })`)
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await btn('💾 บันทึกร่าง').click(); await wait(400)
t = await text()
ok('saving after a preview drops the preview (its revision is stale)', !t.includes('ผลตรวจสอบก่อนบันทึก') && !(await text()).includes('✅ บันทึกใบกำกับ (ลงสต็อก)'))
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await page.evaluate(() => { window.__log = [] })
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(250)
t = await text()
const box = await page.locator('[data-testid="confirm-alerts"]').innerText().catch(() => '')
ok('alert box at the top lists each PO (known number and unknown), not de-duplicated', box.includes('PO-001') && (box.match(/นับซ้ำ/g) || []).length >= 3 && (box.match(/สต็อกจะถูกเพิ่มจากใบกำกับทั้งหมด/g) || []).length >= 3, box)
const boxTop = await page.evaluate(() => { const b = document.querySelector('[data-testid="confirm-alerts"]').getBoundingClientRect(); const li = document.querySelector('.modal-body ul:last-of-type'); return { boxTop: b.top, firstSummary: li ? li.getBoundingClientRect().top : null } })
ok('alert box is above the summary list', boxTop.firstSummary != null && boxTop.boxTop < boxTop.firstSummary, JSON.stringify(boxTop))
// the app's terracotta alert token is --red (#E0806A dark / #D0624F light); compare with what the CSS resolves it to
const boxColors = await page.locator('[data-testid="confirm-alerts"]').evaluate(el => {
  const probe = document.createElement('span'); probe.style.color = 'var(--red)'; document.body.appendChild(probe)
  const token = getComputedStyle(probe).color; probe.remove()
  const title = el.firstElementChild
  return { border: getComputedStyle(el).borderTopColor, title: getComputedStyle(title).color, token }
})
ok('alert box border and title use the CSS --red token', boxColors.token !== '' && boxColors.token !== 'rgb(0, 0, 0)' && boxColors.border === boxColors.token && boxColors.title === boxColors.token, JSON.stringify(boxColors))
ok('summary states the dating rule (invoice date; void is dated today)', t.includes('ลงวันที่ตามวันที่ใบกำกับ (2026-10-05)') && t.includes('ยกเลิกใบกำกับภาษีภายหลัง') === false && t.includes('ยกเลิกใบกำกับภายหลัง') && t.includes('วันนี้'), t.slice(0, 900))
ok('confirm disabled until acknowledged', await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).isDisabled())
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).click({ force: true }).catch(() => {}); await wait(200)
ok('forced click on the disabled button posts nothing', !(await rpcLog()).includes('post'))
await page.getByRole('checkbox', { name: /ฉันรับทราบ/ }).check(); await wait(100)
ok('confirm enabled after the checkbox', !(await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).isDisabled()))
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).click(); await wait(500)
const pArgs = await page.evaluate(() => window.__log.filter(x => x[0] === 'rpc' && x[1] === 'post').map(x => x[2]))
ok('post sent with the previewed revision 4', pArgs.length === 1 && pArgs[0] === '[\"D1\",4]', JSON.stringify(pArgs))
// stale_preview from the server: Thai text, overlay closed, preview dropped
await set('__invoices', [inv('D1', 'draft')]); await render()
await setRpc(`({ save: (id) => id || 'NEW', preview: () => (${JSON.stringify(dbl)}), post: () => { throw new Error('stale_preview') } })`)
await rowMenu(/INV-D1/, '✏️ แก้ไข'); await wait(600)
await btn('👁️ ตรวจสอบก่อนบันทึก').click(); await wait(500)
await btn('✅ บันทึกใบกำกับ (ลงสต็อก)').click(); await wait(250)
await page.getByRole('checkbox', { name: /ฉันรับทราบ/ }).check()
await page.getByRole('button', { name: '✅ ยืนยันบันทึก' }).click(); await wait(500)
ok('stale_preview shows the Thai text', (alerts.at(-1) || '') === 'ใบกำกับถูกแก้ไขหลังจากดูตัวอย่าง กรุณาดูตัวอย่างใหม่', alerts.at(-1))

console.log('=== D1 form: link kind switch and receipt picker')
await boot()
await set('__invoices', []); await render()
await page.getByRole('button', { name: '+ เพิ่มใบกำกับภาษีผู้ขาย' }).click(); await wait(300)
ok('not ready: no switch', !(await text()).includes('ผูกกับ:'))
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(200)
await page.evaluate(() => { window.__deliveryReady = true; window.__log = [] }); await render()
await page.getByRole('button', { name: '+ เพิ่มใบกำกับภาษีผู้ขาย' }).click(); await wait(300)
const pickSupplier = async () => {
  await page.getByRole('button', { name: '— เลือก Supplier —' }).click(); await wait(100)
  await page.locator('div[style*="z-index: 9999"]').getByText('Supplier One', { exact: true }).click(); await wait(400)
}
const fillHead = async (net, vat) => {
  await page.locator('label:has-text("เลขที่ใบกำกับภาษี") + input').fill('INV-NEW')
  await page.locator('input[type=number]').nth(0).fill(String(net))
  await page.locator('input[type=number]').nth(1).fill(String(vat))
  await wait(150)
}
const boxText = () => page.locator('.modal-body').innerText()
await pickSupplier()
ok('ready: switch shown, default ใบสั่งซื้อ', (await text()).includes('ผูกกับ:') && await page.getByRole('radio', { name: 'ใบสั่งซื้อ' }).isChecked())
ok('PO kind: delivery PO PO-DEL is not listed', !(await text()).includes('PO-DEL') && (await text()).includes('PO-001'), await text())
await page.getByRole('radio', { name: 'การส่งของ' }).check(); await wait(300)
t = await text()
const iB = t.indexOf('PO-1-R2'), iA = t.indexOf('PO-1-R1')
ok('picker lists receipts oldest first (rB before rA)', iB > 0 && iA > iB, t)
ok('rC disabled with link text, other supplier absent', await page.getByRole('checkbox', { name: /PO-1-R3/ }).isDisabled() && t.includes('ผูกกับใบกำกับ INV-X') && !t.includes('PO-9'))
ok('PO picker hidden in delivery kind', !t.includes('ใบสั่งซื้อที่รวมอยู่ในใบกำกับนี้'))
await page.getByRole('checkbox', { name: /PO-1-R2/ }).check()
await page.getByRole('checkbox', { name: /PO-1-R1/ }).check()
ok('running sum shown before any amount is typed', (await page.getByTestId('receipt-sum').innerText()).includes('เลือก 2 ใบรับของ รวม 1,000.00 (รวม VAT 1,070.00)'), await boxText())
ok('invalid-match text mentions deliveries, not POs', (await boxText()).includes('เทียบกับการส่งของ') && !(await boxText()).includes('เทียบกับใบสั่งซื้อ'))
await fillHead(1000, 70)
ok('matched on goods value 1,000.00', (await boxText()).includes('มูลค่าสินค้าที่รับ 1,000.00'), await boxText())
await fillHead(990, 80)
ok('incl basis shown', (await boxText()).includes('ตรงเมื่อเทียบรวม VAT'), await boxText())
await page.evaluate(() => { window.__log = [] })
await btn('💾 บันทึกร่าง').click(); await wait(500)
let calls = await page.evaluate(() => window.__log.filter(x => x[0] === 'rpc'))
// Task 9: the page still saves through the po-level RPC until Task 9 wires saveReceipts
ok('delivery draft calls saveReceipts with ids in tick order (Task 9)', calls.some(c => c[1] === 'saveReceipts' && JSON.stringify(JSON.parse(c[2])[3]) === '["rB","rA"]'), JSON.stringify(calls))
ok('delivery draft does not call save (Task 9)', !calls.some(c => c[1] === 'save'), JSON.stringify(calls))
await page.getByRole('radio', { name: 'ใบสั่งซื้อ' }).check(); await wait(200)
ok('delivery -> po: receipt ticks gone, running sum hidden', (await page.getByTestId('receipt-sum').count()) === 0)
await page.getByRole('checkbox', { name: /PO-001/ }).check()
await page.getByRole('radio', { name: 'การส่งของ' }).check(); await wait(200)
await page.getByRole('radio', { name: 'ใบสั่งซื้อ' }).check(); await wait(200)
ok('po -> delivery -> po: PO ticks cleared on switch', !(await page.getByRole('checkbox', { name: /PO-001/ }).isChecked()))
await page.getByRole('radio', { name: 'การส่งของ' }).check(); await wait(200)
ok('switching kind clears the ticks', !(await page.getByRole('checkbox', { name: /PO-1-R2/ }).isChecked()) && !(await page.getByRole('checkbox', { name: /PO-1-R1/ }).isChecked()))
await page.evaluate(() => { window.__log = [] })
const nAl = alerts.length
await btn('💾 บันทึกร่าง').click(); await wait(300)
ok('empty delivery selection: NO_RECEIPTS_TEXT alert, no RPC', alerts.length === nAl + 1 && alerts.at(-1) === 'ยังไม่ได้เลือกการส่งของ (ล็อต) — เลือกอย่างน้อย 1 ล็อต' && (await rpcLog()).length === 0, alerts.at(-1) + JSON.stringify(await rpcLog()))
await page.getByRole('checkbox', { name: /PO-1-R1/ }).check()
await page.evaluate(() => { window.__extract = () => ({ ok: true, data: { reference_no_guess: 'SCAN-1', document_date_guess: null, prices_include_vat: true,
  line_items: [{ description: 'Steel', quantity: 1, unit: 'kg', unit_price: 107, discount_pct: 0 }, { description: 'Bolt', quantity: 1, unit: 'ea', unit_price: 107, discount_pct: 0 }] } }) })
await page.locator('input[type=file]').setInputFiles({ name: 'a.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4\n%%EOF') }); await wait(600)
t = await text()
ok('scan keeps delivery kind, ticks only rA, no proposal list', await page.getByRole('radio', { name: 'การส่งของ' }).isChecked()
  && await page.getByRole('checkbox', { name: /PO-1-R1/ }).isChecked() && !(await page.getByRole('checkbox', { name: /PO-1-R2/ }).isChecked())
  && !t.includes('ยังไม่ได้รวม') && !t.includes('PO-001'), t)
ok('scan lines ex-VAT 100', await page.locator('input[type=number][step="0.01"][min="0"]').evaluateAll(els => els.filter(e => e.value === '100').length) >= 2)
ok('scan fills net only if blank (kept 990)', await page.locator('input[type=number]').nth(0).inputValue() === '990')
await page.setViewportSize({ width: 375, height: 740 }); await wait(200)
ok('375px: no horizontal page scroll with the picker', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1 && document.body.scrollWidth <= window.innerWidth + 1), JSON.stringify(await page.evaluate(() => [document.documentElement.scrollWidth, window.innerWidth])))
ok('375px: running sum inside the viewport', await page.getByTestId('receipt-sum').evaluate(el => el.getBoundingClientRect().right <= window.innerWidth + 1))
ok('375px: picker row inside the viewport', await page.getByRole('checkbox', { name: /PO-1-R1/ }).evaluate(el => el.closest('label').getBoundingClientRect().right <= window.innerWidth + 1))
await page.setViewportSize({ width: 1280, height: 800 })
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(300)

console.log('=== D1 stale draft holding a delivery PO')
const staleInv = inv('DS', 'draft', { supplier_tax_invoice_pos: [link('DS', { po_id: 'PD', purchase_orders: { id: 'PD', po_number: 'PO-DEL' } })] })
await set('__invoices', [staleInv]); await render()
await setRpc(`({ save: (id) => id || 'NEW' })`)
await rowMenu(/INV-DS/, '✏️ แก้ไข'); await wait(700)
t = await text()
const DEL_TXT = 'ใบสั่งซื้อนี้ตั้งเป็นใบกำกับต่อการส่งของ จึงผูกทั้งใบไม่ได้ — เอาออก แล้วเลือก "ผูกกับ: การส่งของ"'
ok('stale delivery PO: not in picker, amber notice with remove button', t.includes('PO-DEL — ' + DEL_TXT) && !(await page.getByRole('checkbox', { name: /PO-DEL/ }).count()) && await page.getByRole('button', { name: 'เอาออก', exact: true }).count() === 1, t)
ok('stale delivery PO excluded from the match sum', !(await boxText()).includes('มูลค่าสินค้าใบสั่งซื้อ 1,000.00'), await boxText())
const nAl2 = alerts.length
await page.evaluate(() => { window.__log = [] })
await btn('💾 บันทึกร่าง').click(); await wait(300)
ok('save blocked with the delivery-PO text, no save call', alerts.length === nAl2 + 1 && alerts.at(-1) === DEL_TXT && !(await rpcLog()).includes('save'), alerts.at(-1) + JSON.stringify(await rpcLog()))
await page.getByRole('button', { name: 'เอาออก', exact: true }).click(); await wait(200)
await btn('💾 บันทึกร่าง').click(); await wait(400)
calls = await page.evaluate(() => window.__log.filter(x => x[0] === 'rpc'))
ok('after เอาออก save calls save without PD', calls.some(c => c[1] === 'save' && !JSON.parse(c[2])[3].includes('PD')), JSON.stringify(calls))
await page.getByRole('button', { name: 'ยกเลิก' }).first().click(); await wait(300)

ok('no React errors', (await page.evaluate(() => window.__errors)).length === 0, JSON.stringify(await page.evaluate(() => window.__errors)))
await browser.close()
console.log(fails ? `${fails} FAILED` : 'ALL PASS')
process.exit(fails ? 1 : 0)
