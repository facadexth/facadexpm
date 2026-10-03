// Renders the LINE rich menu images (docs/line-rich-menu/*.png) in a real browser, so Thai
// text is shaped correctly. Re-run after changing the buttons: node scripts/render-rich-menu.mjs
// Size is the large rich-menu canvas LINE expects: 2500 x 1686 px, PNG, under 1 MB.
import { chromium } from '@playwright/test'
import { mkdirSync, statSync } from 'node:fs'

const ACCENT = { blue: '#0a84ff', green: '#34c759', orange: '#ff9f0a', purple: '#6c63ff', red: '#ff453a', teal: '#30b0c7', amber: '#ffcc00', pink: '#ff69b4' }
const STRIP = 'ส่งรูปงานเข้าแชทนี้ได้เลย ระบบบันทึกเข้าไซท์ให้อัตโนมัติ'

const MENUS = {
  'rich-menu-8-buttons': { cols: 4, buttons: [
    ['📋', 'งานวันนี้', 'ดูงาน / เมนูลัด', 'blue'], ['✅', 'เช็คอิน', 'เริ่มงาน', 'green'],
    ['🏁', 'เช็คเอาท์', 'เลิกงาน', 'orange'], ['🎯', 'งานเสร็จ', 'กดปิดงาน', 'purple'],
    ['🚧', 'แจ้งปัญหา', 'รายงานหน้างาน', 'red'], ['📦', 'ขอเบิกของ', 'เบิกวัสดุ', 'teal'],
    ['🏖️', 'ขอลา', 'ลากิจ / ลาป่วย', 'amber'], ['📅', 'งานพรุ่งนี้', 'ดูล่วงหน้า', 'pink'],
  ] },
  'rich-menu-6-buttons': { cols: 3, buttons: [
    ['📋', 'งานวันนี้', 'ดูงาน / เมนูลัด', 'blue'], ['✅', 'เช็คอิน', 'เริ่มงาน', 'green'], ['🏁', 'เช็คเอาท์', 'เลิกงาน', 'orange'],
    ['🚧', 'แจ้งปัญหา', 'รายงานหน้างาน', 'red'], ['📦', 'ขอเบิกของ', 'เบิกวัสดุ', 'teal'], ['🏖️', 'ขอลา', 'ลากิจ / ลาป่วย', 'amber'],
  ] },
}

function html({ cols, buttons }) {
  const rows = Math.ceil(buttons.length / cols)
  const cell = buttons.map(([icon, label, sub, acc]) => `
    <div class="card"><i style="background:${ACCENT[acc]}"></i><div class="ic">${icon}</div><div class="lb">${label}</div><div class="sb">${sub}</div></div>`).join('')
  const labelPx = cols === 4 ? 112 : 140
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:2500px;height:1686px;background:#0f1117;font-family:'Thonburi','Sukhumvit Set','Noto Sans Thai',sans-serif;color:#fff;display:flex;flex-direction:column;padding:22px;gap:22px}
    .grid{flex:1;display:grid;grid-template-columns:repeat(${cols},1fr);grid-template-rows:repeat(${rows},1fr);gap:22px}
    .card{position:relative;background:#1a1d2e;border-radius:48px;overflow:hidden;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px}
    .card i{position:absolute;top:0;left:0;right:0;height:26px}
    .ic{font-size:${cols === 4 ? 200 : 230}px;line-height:1.1}
    .lb{font-size:${labelPx}px;font-weight:700;line-height:1.25;white-space:nowrap}
    .sb{font-size:${Math.round(labelPx * 0.43)}px;color:#a0a6be;line-height:1.3;white-space:nowrap}
    .strip{height:264px;background:#202440;border-radius:48px;display:flex;align-items:center;justify-content:center;font-size:92px;font-weight:700;white-space:nowrap}
  </style></head><body><div class="grid">${cell}</div><div class="strip">${STRIP}</div></body></html>`
}

mkdirSync('docs/line-rich-menu', { recursive: true })
const browser = await chromium.launch()
try {
  for (const [name, menu] of Object.entries(MENUS)) {
    const page = await browser.newPage({ viewport: { width: 2500, height: 1686 }, deviceScaleFactor: 1 })
    await page.setContent(html(menu))
    await page.waitForTimeout(400)
    const out = `docs/line-rich-menu/${name}.png`
    await page.screenshot({ path: out })
    console.log(out, Math.round(statSync(out).size / 1024) + ' KB')
    await page.close()
  }
} finally {
  await browser.close()
}
