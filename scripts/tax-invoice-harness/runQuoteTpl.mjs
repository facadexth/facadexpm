// Screenshots of the quotation in classic / modern / premium (sample data, sample images).
// Run: node scripts/tax-invoice-harness/buildQuoteTpl.mjs && node scripts/tax-invoice-harness/runQuoteTpl.mjs <imgDir> <outDir> [itemCount]
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveDocumentTemplate } from '../../src/lib/documentTemplates.js'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const imgDir = process.argv[2]
const outDir = process.argv[3] || path.join(tmpdir(), 'quote-tpl-shots')
const count = Number(process.argv[4] || 4)
mkdirSync(outDir, { recursive: true })
const js = readFileSync(path.join(tmpdir(), 'quotetpl-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8').replace(/@import[^;]*;/g, '')
const fontCss = (f) => `data:font/woff2;base64,${readFileSync(path.resolve(H, '../../public/fonts/' + f)).toString('base64')}`
const url = (n) => `data:image/jpeg;base64,${readFileSync(path.join(imgDir, `img${n}.jpg`)).toString('base64')}`

const TENANT = { id: 't1', company_name: 'บริษัท ตัวอย่าง อลูมิเนียม จำกัด', address: '99/9 ถนนตัวอย่าง แขวงตัวอย่าง กรุงเทพฯ 10000', tax_id: '0105500000000', phone: '02-000-0000', email: 'hello@example.com' }
const ITEMS = Array.from({ length: count }, (_, i) => ({ id: 'i' + i, item_type: 'item', description: ['ประตูบานเลื่อนอลูมิเนียม 2 บาน กระจกเขียว 6 มม.', 'หน้าต่างบานเปิดคู่ พร้อมมุ้งลวด', 'ผนังกระจกอลูมิเนียม (curtain wall)', 'ค่าติดตั้งและอุปกรณ์'][i % 4], quantity: 2 + (i % 3), unit: 'ชุด', unit_price: 12500, line_total: (2 + (i % 3)) * 12500 }))
const templates = [
  { key: 'classic', layout: 'classic', status: 'published', style: {} },
  { key: 'modern', layout: 'modern', status: 'published', style: { accent: '#1e3a5f' } },
  { key: 'premium', layout: 'premium', status: 'published', style: { accent: '#7a4b2a' } },
]
const content = { hero_path: url(1), gallery: [2, 3, 4, 5].map((n, i) => ({ path: url(n), caption: ['ประตูบานเลื่อน', 'หน้าต่างบานเปิด', 'ผนังกระจก', 'งานติดตั้ง'][i] })), features: ['รับประกันงาน 1 ปี', 'ติดตั้งโดยช่างมืออาชีพ', 'ส่งมอบตรงเวลา'], tagline: 'งานเนี้ยบ ส่งมอบตรงเวลา', thanks: 'ขอบคุณที่ไว้วางใจเรา' }

const browser = await chromium.launch()
for (const key of ['classic', 'modern', 'premium']) {
  const tenant = { ...TENANT, document_template_key: key === 'classic' ? null : key, document_content: content }
  const tpl = resolveDocumentTemplate({ tenant, templates, packs: [] })
  const page = await browser.newPage({ viewport: { width: 900, height: 1200 }, deviceScaleFactor: 2 })
  page.on('pageerror', e => console.log('PAGEERROR', key, e.message))
  await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
  await page.setContent('<div id="root"></div>')
  await page.evaluate(d => { window.__q = d }, { tenant, items: ITEMS, template: tpl })
  await page.evaluate(([c, a, b]) => {
    const st = document.createElement('style')
    st.textContent = c + `@font-face{font-family:'Noto Serif Thai';font-weight:100 900;src:url(${a}) format('woff2');unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}@font-face{font-family:'Noto Serif Thai';font-weight:100 900;src:url(${b}) format('woff2');unicode-range:U+0000-00FF,U+2000-206F}`
    document.head.appendChild(st)
  }, [css, fontCss('NotoSerifThai-thai.woff2'), fontCss('NotoSerifThai-latin.woff2')])
  await page.addScriptTag({ content: js })
  await page.evaluate(() => window.__render())
  await page.waitForTimeout(1500)
  const file = path.join(outDir, `quote-${key}-${count}.png`)
  await page.locator('#doc').first().screenshot({ path: file })
  console.log('shot', file)
  await page.close()
}
await browser.close()
