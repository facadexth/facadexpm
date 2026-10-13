// Screenshot of the platform-admin document-templates page with mocked tables.
// Run: node scripts/tax-invoice-harness/buildTplAdmin.mjs && node scripts/tax-invoice-harness/runTplAdmin.mjs <imgDir> <outDir>
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const imgDir = process.argv[2]
const outDir = process.argv[3] || path.join(tmpdir(), 'tpl-admin-shots')
mkdirSync(outDir, { recursive: true })
const js = readFileSync(path.join(tmpdir(), 'tpladmin-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8').replace(/@import[^;]*;/g, '')
const url = n => `data:image/jpeg;base64,${readFileSync(path.join(imgDir, `img${n}.jpg`)).toString('base64')}`

const tables = {
  document_templates: [
    { key: 'classic', layout: 'classic', name_th: 'คลาสสิก', status: 'published', style: {}, style_prev: null },
    { key: 'modern', layout: 'modern', name_th: 'โมเดิร์นมีภาพ', status: 'draft', style: { accent: '#1e3a5f' }, style_prev: { accent: '#222222' } },
    { key: 'premium', layout: 'premium', name_th: 'พรีเมียมหรูหรา', status: 'draft', style: { accent: '#7a4b2a' }, style_prev: null },
  ],
  document_image_packs: [
    { id: 'p1', name_th: 'งานประตูหน้าต่างอลูมิเนียม', status: 'published', hero_path: url(1), gallery: [2, 3, 4, 5].map(n => ({ path: url(n), caption_th: 'ตัวอย่างผลงาน ' + n })), features_th: ['รับประกัน 1 ปี', 'ติดตั้งโดยช่าง', 'ส่งมอบตรงเวลา'], tagline_th: 'งานเนี้ยบ ส่งมอบตรงเวลา' },
    { id: 'p2', name_th: 'งานตกแต่งภายใน', status: 'draft', hero_path: url(6), gallery: [], features_th: [], tagline_th: '' },
  ],
}
const rpc = { platform_document_template_usage: [{ template_key: 'classic', tenant_count: 12 }] }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1400, height: 1000 }, deviceScaleFactor: 1 })
page.on('pageerror', e => console.log('PAGEERROR', e.message))
page.on('console', m => { if (m.type() === 'error') console.log('CONSOLE', m.text()) })
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(([t, r]) => { window.__tables = t; window.__rpc = r }, [tables, rpc])
await page.evaluate(c => { const st = document.createElement('style'); st.textContent = c; document.head.appendChild(st) }, css)
await page.addScriptTag({ content: js })
await page.evaluate(() => window.__render())
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(outDir, 'admin-modern.png'), fullPage: true })
console.log('log', await page.evaluate(() => JSON.stringify(window.__log || [])))
// click save on the (unchanged -> disabled) button is a no-op; change accent then save
await page.locator('input[type=color]').first().evaluate((el, v) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; set.call(el, v); el.dispatchEvent(new Event('input', { bubbles: true })) }, '#aa0000')
await page.waitForTimeout(500)
await page.getByText('💾 บันทึก').first().click()
await page.waitForTimeout(500)
console.log('log2', await page.evaluate(() => JSON.stringify(window.__log || [])))
await page.screenshot({ path: path.join(outDir, 'admin-modern-edited.png'), fullPage: false })
await browser.close()
