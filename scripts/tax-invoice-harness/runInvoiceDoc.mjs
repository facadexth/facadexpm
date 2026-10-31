// Invoice document totals. Run: node scripts/tax-invoice-harness/buildInvoiceDoc.mjs && node scripts/tax-invoice-harness/runInvoiceDoc.mjs [shot.png]
import { chromium } from 'playwright'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const js = readFileSync(path.join(tmpdir(), 'invoicedoc-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8').replace(/@import[^;]*;/g, '')
const browser = await chromium.launch()
let fails = 0
const ok = (name, cond, extra = '') => { if (!cond) fails++; console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : '  ' + extra)) }

async function render(doc, shot) {
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 } })
  page.on('pageerror', e => { fails++; console.log('PAGEERROR', e.message) })
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
  await page.setContent('<div id="root"></div>')
  await page.evaluate(d => { window.__doc = d }, doc)
  await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c; document.head.appendChild(st) }, css)
  await page.addScriptTag({ content: js })
  await page.evaluate(() => window.__render())
  await page.waitForTimeout(700)
  const text = (await page.locator('body').innerText()).replace(/\s+/g, ' ')
  if (shot) await page.screenshot({ path: shot, fullPage: true })
  await page.close()
  return text
}

// invoice IN2610-002: 208,560 before VAT, deposit 78,210 taken before VAT, VAT 7% of 130,350, withholding 3% of 130,350
const newStyle = { totalsLabel: 'รวมทั้งสิ้น', totalsAmount: 139474.5, subtotal: 208560, vat: 9124.5, hasVat: true,
  withholdingTaxPct: 3, withholdingTaxAmount: 3910.5, isWithholdingEstimate: true,
  depositDeductionPct: 37.5, depositDeductionAmount: 78210, isDepositEstimate: false, depositBeforeVat: true }
let t = await render(newStyle, process.argv[2])
console.log('=== deposit taken off BEFORE VAT')
ok('before-VAT lines present in order', (() => { let at = 0; for (const l of ['รวมงวดนี้ (ก่อน VAT) 208,560.00', 'หักเงินมัดจำ (37.5%) (78,210.00)', 'รวมเบิก หลังหักมัดจำ 130,350.00', 'ภาษีมูลค่าเพิ่ม 7% 9,124.50']) { const i = t.indexOf(l, at); if (i < 0) return false; at = i + 1 } return true })(), t)
ok('invoice amount 139,474.50 (= 130,350 + 9,124.50)', /รวมทั้งสิ้น 139,474\.50 บาท/.test(t), t)
ok('withholding deducted once, deposit NOT deducted again: pays 135,564.00', /จำนวนเงินที่ถูกหัก ณ ที่จ่าย \(3%\) \(ประมาณการ\) \(3,910\.50\)/.test(t) && /จำนวนเงินที่ชำระ 135,564\.00 บาท/.test(t) && !/หักเงินมัดจำ \(37\.5%\) \(ประมาณการ\)/.test(t), t)
ok('the old "มูลค่าที่คำนวณภาษี" line is gone for this layout', !/มูลค่าที่คำนวณภาษี 7%/.test(t), t)

console.log('=== older invoice keeps the previous layout')
const legacy = { totalsLabel: 'รวมทั้งสิ้น', totalsAmount: 273474.3, subtotal: 260700, vat: 12774.3, hasVat: true,
  withholdingTaxPct: 3, withholdingTaxAmount: 5474.7, isWithholdingEstimate: true,
  depositDeductionPct: 30, depositDeductionAmount: 78210, isDepositEstimate: true }
t = await render(legacy)
ok('legacy: tax base line, VAT, total, deposit below', /มูลค่าที่คำนวณภาษี 7% 260,700\.00/.test(t) && /หักเงินมัดจำ \(30%\) \(ประมาณการ\) \(78,210\.00\)/.test(t) && !/รวมเบิก หลังหักมัดจำ/.test(t), t)
ok('legacy pays 273,474.30 - 5,474.70 - 78,210 = 189,789.60', /จำนวนเงินที่ชำระ 189,789\.60 บาท/.test(t), t)

console.log(fails ? `${fails} FAILED` : 'ALL PASSED')
await browser.close()
process.exit(fails ? 1 : 0)
