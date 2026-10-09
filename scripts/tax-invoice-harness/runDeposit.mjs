// Deposit box scenarios. Run: node scripts/tax-invoice-harness/buildDeposit.mjs && node scripts/tax-invoice-harness/runDeposit.mjs
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'deposit-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8')
const browser = await chromium.launch()
const page = await browser.newPage()
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }
page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c.replace(/@import[^;]*;/g, ''); document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
await page.evaluate(() => window.__render())
await page.waitForTimeout(300)
const body = async () => (await page.locator('body').innerText()).replace(/\s+/g, ' ')
const input = page.locator('#inv-deposit-input')
const val = () => input.inputValue()
const btn = n => page.getByRole('button', { name: n, exact: true })

console.log('=== 1 default: site % (30) of 150,000 = 45,000')
ok('input is a plain text field (no spinner)', (await input.getAttribute('type')) === 'text')
ok('default text 30', (await val()) === '30')
let b = await body()
ok('caption: 45,000.00 baht, 30%, left 33,210.00', /45,000\.00 บาท · 30% ของงวดนี้ · มัดจำคงเหลือหลังหักใบนี้ \(ประมาณการ\) 33,210\.00/.test(b), b.slice(0, 400))
ok('no warning yet', (await page.locator('#inv-deposit-warn').count()) === 0)

console.log('=== 2 caret stays where it is (value mode)')
await btn('หักเป็นมูลค่า').click()
await input.fill('200')
await input.press('Home')
await input.pressSequentially('1')
await input.pressSequentially('5')
ok('typed in the middle: 15200 (caret did not jump to the start/end)', (await val()) === '15200', await val())
const caret = await input.evaluate(el => el.selectionStart)
ok('caret after the two typed digits', caret === 2, String(caret))

console.log('=== 3 typing past the limit snaps to the limit and warns')
await btn('หักเป็น %').click()
await input.fill('100')
ok('100% of 150,000 snaps to 52.14', (await val()) === '52.14', await val())
b = await body()
ok('warning stays visible with the capped baht + %', /ใส่เกินที่หักได้.*78,210\.00 บาท \(52\.14%\)/.test(b), b)
ok('resolved amount is the whole balance', (await page.locator('#resolved').innerText()) === '78210')
await input.fill('20')
ok('typing a smaller number clears the warning', (await page.locator('#inv-deposit-warn').count()) === 0)

console.log('=== 4 "deduct all that is left" sits in the same row and fills the value')
await btn('หักมัดจำคงเหลือทั้งหมด').click()
ok('switches to value mode', (await btn('หักเป็นมูลค่า').getAttribute('aria-pressed')) === 'true')
ok('fills 78210', (await val()) === '78210', await val())
b = await body()
ok('caption 78,210.00 baht = 52.14%, left 0.00', /78,210\.00 บาท · 52\.14% ของงวดนี้ · มัดจำคงเหลือหลังหักใบนี้ \(ประมาณการ\) 0\.00/.test(b), b)
ok('net received 74,661.60 (VAT/WHT only on 71,790)', /รับจริง 74,661\.60/.test(b), b)
ok('WHT line is 2,153.70 on base 71,790', /หัก ณ ที่จ่าย \(คิดจาก 71,790\.00\) − 2,153\.70/.test(b), b)
const sameRow = await page.evaluate(() => {
  const all = [...document.querySelectorAll('button')]
  const a = all.find(x => x.textContent === 'หักเป็นมูลค่า'), c = all.find(x => x.textContent === 'หักมัดจำคงเหลือทั้งหมด')
  return a.parentElement === c.parentElement
})
ok('both buttons share one row', sameRow)

console.log('=== 5 invoice smaller than the deposit: never deduct more than the invoice is worth')
await page.locator('#sub').fill('50000')
await page.waitForTimeout(100)
b = await body()
ok('amount capped at 50,000 and warned', (await page.locator('#resolved').innerText()) === '50000' && (await page.locator('#inv-deposit-warn').count()) === 1, b)

console.log('=== 6 "none"')
await btn('ไม่หัก').click()
b = await body()
ok('says no deposit and deducts 0', /ใบนี้จะไม่หักมัดจำ/.test(b) && (await page.locator('#resolved').innerText()) === '0', b)

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await browser.close()
process.exit(fails ? 1 : 0)
