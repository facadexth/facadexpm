// Screenshots of the tenant template picker (mocked data). Run: node buildPicker.mjs && node runPicker.mjs <imgDir> <outDir>
import { chromium } from 'playwright'
import { readFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
const H = path.dirname(fileURLToPath(import.meta.url)) + '/'
const imgDir = process.argv[2]
const outDir = process.argv[3] || path.join(tmpdir(), 'picker-shots')
mkdirSync(outDir, { recursive: true })
const js = readFileSync(path.join(tmpdir(), 'picker-harness-out.js'), 'utf8')
const css = readFileSync(path.resolve(H, '../../src/index.css'), 'utf8').replace(/@import[^;]*;/g, '')
const url = n => `data:image/jpeg;base64,${readFileSync(path.join(imgDir, `img${n}.jpg`)).toString('base64')}`
const fontCss = f => `data:font/woff2;base64,${readFileSync(path.resolve(H, '../../public/fonts/' + f)).toString('base64')}`

const templates = [
  { key: 'classic', layout: 'classic', name_th: 'คลาสสิก', description_th: 'แบบเรียบ อ่านง่าย ใช้ได้กับทุกงาน', status: 'published', style: {} },
  { key: 'modern', layout: 'modern', name_th: 'โมเดิร์นมีภาพ', description_th: 'แถบหัวสีเข้ม ภาพปก แกลเลอรีผลงาน และแถบจุดเด่น', status: 'published', style: { accent: '#1e3a5f' } },
  { key: 'premium', layout: 'premium', name_th: 'พรีเมียมหรูหรา', description_th: 'กระดาษโทนครีม ตัวอักษรมีหัว ภาพปกพร้อมคำโปรย', status: 'published', style: { accent: '#7a4b2a' } },
]
const packs = [{ id: 'p1', name_th: 'งานประตูหน้าต่างอลูมิเนียม', status: 'published', hero_path: url(1), gallery: [2, 3, 4, 5].map(n => ({ path: url(n), caption_th: 'ผลงาน ' + n })), features_th: ['รับประกัน 1 ปี', 'ติดตั้งโดยช่าง', 'ส่งมอบตรงเวลา'], tagline_th: 'งานเนี้ยบ ส่งมอบตรงเวลา' }]
const tenant = { id: 't1', company_name: 'บริษัท ตัวอย่าง อลูมิเนียม จำกัด', address: '99/9 ถนนตัวอย่าง กรุงเทพฯ', tax_id: '0105500000000', phone: '02-000-0000' }

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1200, height: 1000 } })
page.on('pageerror', e => console.log('PAGEERROR', e.message))
await page.route('**/*', r => { const u = r.request().url(); if (u.startsWith('data:') || u === 'about:blank') return r.continue(); return r.abort() })
await page.setContent('<div id="root"></div>')
await page.evaluate(d => { window.__picker = d }, { tenant, templates, packs })
await page.evaluate(([c, a, b]) => {
  const st = document.createElement('style')
  st.textContent = c + `@font-face{font-family:'Noto Serif Thai';font-weight:100 900;src:url(${a}) format('woff2');unicode-range:U+0E01-0E5B,U+200C-200D,U+25CC}@font-face{font-family:'Noto Serif Thai';font-weight:100 900;src:url(${b}) format('woff2');unicode-range:U+0000-00FF,U+2000-206F}`
  document.head.appendChild(st)
}, [css, fontCss('NotoSerifThai-thai.woff2'), fontCss('NotoSerifThai-latin.woff2')])
await page.addScriptTag({ content: js })
await page.evaluate(() => window.__render())
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(outDir, 'picker-1.png'), fullPage: true })
await page.getByText('เลือกแบบนี้').nth(1).click() // modern
await page.waitForTimeout(1500)
await page.screenshot({ path: path.join(outDir, 'picker-2-modern.png'), fullPage: true })
await page.getByText('✅ ใช้แบบนี้').click() // without accepting T&C -> must be blocked
await page.waitForTimeout(400)
console.log('blocked msg:', await page.getByText('ต้องติ๊กยอมรับ').count())
await page.getByLabel('ฉันอ่านและยอมรับข้อกำหนดนี้').check()
await page.getByText('✅ ใช้แบบนี้').click()
await page.waitForTimeout(600)
console.log('log', await page.evaluate(() => JSON.stringify((window.__log || []).filter(l => l[0] === 'update'))))
await browser.close()
