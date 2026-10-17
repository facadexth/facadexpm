// Per-supplier configs for scripts/gen-catalogue-import.mjs (see scripts/catalogue-import-lib.mjs).
// series[i] maps the i-th series of that catalogue JSON: { idx, name, types } or { idx, skip: reason }.
// types = door_window_types names (exact) the series heading names; the SQL aborts if one does not exist.
// price_basis is per_kg for all of them: owner 2026-10-17 "ราคาให้ใช้เป็นราคาต่อ กก. ทั้งหมด เพราะส่วนใหญ่ไม่มี pricelist".
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const loadInputs = (cfg) => Object.fromEntries([...cfg.sources.map(s => s.file), ...(cfg.cutFiles || [])].map(f => [f, JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'))]))

const SLIDE = ['บานเลื่อนสวน 2 บาน', 'บานเลื่อน 2 ตาย 2', 'บานเลื่อน 3 บาน', 'บานเลื่อนรางล่าง']
const CASE = ['บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน', 'บานเปิดข้าง', 'บานเปิด', 'บานติดตาย']

export const CONFIGS = [
  {
    id: 'sp',
    provider: { name: 'บจก. รัตนดำรงค์ (SMART PLUS)', short_name: 'SP', price_basis: 'per_kg' },
    prefix: '_sp_',
    decision: 'Owner 2026-10-17 "ทำ Smart Plus ต่อเลย ไม่มี profile general".',
    sqlFile: 'supabase/datafix/2026-10-17-import-smartplus-catalogue.sql',
    reportFile: 'docs/catalogs/smartplus/IMPORT-REPORT.md',
    dryrun: '.superpowers/sdd/2026-10-17-catalogue-import/run-dryrun.sh sp',
    sources: [{
      label: 'SMART PLUS catalogue 2024', file: 'docs/catalogs/smartplus/smart-plus-2024.json',
      series: [
        { idx: 0, name: 'SEMI EURO 1.2 ชุดบานเลื่อน 2 ราง / 3 ราง', types: SLIDE },
        { idx: 1, name: 'SEMI EURO 1.2 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย', types: CASE },
        { idx: 2, name: 'EURO 1.5 ชุดบานเลื่อน 2 ราง / 3 ราง', types: SLIDE },
        { idx: 3, name: 'EURO 1.5 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย', types: CASE },
        { idx: 4, name: 'EURO 1.5 ชุดประตูบานเฟี้ยม', types: ['บานเฟี้ยม'] },
      ],
    }],
    cutFiles: ['docs/catalogs/smartplus/smart-plus-cut-formulas-2022.json'],
    finishes: ['Standard White', 'Standard Black', 'Black Sahara', 'Grey Sahara', 'Champagne'],
    notes: ['15148 on p.47 prints no kg/m; the p.34 value 0.148 is used (owner question SP9).'],
  },
  {
    id: 'alumet',
    provider: { name: 'บจก. อลูเม็ท (Alumet)', short_name: 'ALM', price_basis: 'per_kg' },
    prefix: '_alm_',
    decision: 'Owner 2026-10-17 "ขอ alumet กับ sms ด้วยเลย"; price per kg for all.',
    sqlFile: 'supabase/datafix/2026-10-17-import-alumet-catalogue.sql',
    reportFile: 'docs/catalogs/alumet/IMPORT-REPORT.md',
    dryrun: '.superpowers/sdd/2026-10-17-catalogue-import/run-dryrun.sh alumet',
    sources: [
      { label: 'Alumet ICONIQ EURO 2024', file: 'docs/catalogs/alumet/alumet-iconiq-euro-2024.json', series: [
        { idx: 0, name: 'ICONIQ EURO บานเลื่อน', types: ['บานเลื่อน', 'บานเลื่อนรางล่าง'] },
        { idx: 1, name: 'ICONIQ EURO บานเปิด / บานกระทุ้ง', types: ['บานกระทุ้ง', 'บานเปิด', 'บานเปิดข้าง', 'บานสวิง'] },
        { idx: 2, name: 'ICONIQ EURO บานติดตาย', types: ['บานติดตาย'] },
      ] },
      { label: 'Alumet PRO SMART 2021', file: 'docs/catalogs/alumet/alumet-pro-smart-2021.json', series: [
        { idx: 0, name: 'PRO SMART บานเลื่อน', types: ['บานเลื่อน', 'บานเลื่อนรางล่าง'] },
        { idx: 1, name: 'PRO SMART บานติดตาย', types: ['บานติดตาย'] },
        { idx: 2, name: 'PRO SMART หน้าต่างบานเปิด / บานกระทุ้ง', types: ['บานกระทุ้ง', 'บานเปิดข้าง'] },
        { idx: 3, name: 'PRO SMART บานเฟี้ยม', types: ['บานเฟี้ยม'] },
      ] },
      { label: 'Alumet PRO SMART X', file: 'docs/catalogs/alumet/alumet-pro-smart-x.json', series: [
        { idx: 0, name: 'PRO SMART X บานเลื่อน', types: ['บานเลื่อน', 'บานเลื่อนรางล่าง'] },
        { idx: 1, name: 'PRO SMART X บานเปิด / บานกระทุ้ง', types: ['บานกระทุ้ง', 'บานเปิดข้าง'] },
        { idx: 2, name: 'PRO SMART X บานติดตาย', types: ['บานติดตาย'] },
      ] },
      { label: 'Alumet PRO Mini catalogue', file: 'docs/catalogs/alumet/alumet-mini-catalogue.json', series: [
        { idx: 0, name: 'MINI SL บานเลื่อนมาตรฐาน', types: ['บานเลื่อน', 'บานเลื่อนรางล่าง'] },
        { idx: 1, name: 'MINI CAS บานกระทุ้ง', types: ['บานกระทุ้ง'] },
        { idx: 2, name: 'MINI SH ช่องแสง / บานสวิง', types: ['บานสวิง', 'บานติดตาย'] },
        { idx: 3, name: 'MINI OP บานเปิด', types: ['บานเปิด', 'บานเปิดข้าง'] },
        { idx: 4, name: 'MINI CUR ผนังกระจก', types: ['STICK WALL'] },
        { idx: 5, name: 'MINI MC ท่อกลม / กล่องสี่เหลี่ยม', types: [] },
      ] },
    ],
    finishes: [
      'E&A Moonlight Silver', '502 Platinum', '504 Champagne', '506 Neo Copper', '510 Golden Sand', '512 Sukhothai Gold', '514 Burgundy Brown', '518 Onyx Black',
      '8515 Jewel Sand', '8802 Shadow Grey', '8809 Choco Brown', '8815 Charcoal Black', '8816 Midnight Black', '8819 Black Pearl', '8820 Sapphire Grey', '8823 Choco Fudge', '8825 Truffle Brown', '8859 Shadow Grey', '8911 Milky White',
      '15622 Fresh Pine', '15624 Honey Birch', '15636 Rich Teak', '15656 Tropical Teak', '15659 Classic Walnut', '15664 Heritage Oak',
    ],
    notes: [
      'Finishes: one list for all Alumet books (anodize, powder, wood grain), by colour code as printed. Mini prints E&A-M / E&A-B; both are taken as E&A Moonlight Silver.',
      'PRO SMART 2021 and Mini print kg per bar (min-max); kg/m = midpoint / printed bar length (owner C3). Mini prints one weight per wall thickness -> one item per thickness (owner C4).',
      'PRO SMART X prints no kg/m at all, so none of its profiles are imported until a weight table arrives.',
    ],
  },
  {
    id: 'sms',
    provider: { name: 'Schimmer Metal Standard (SMS)', short_name: 'SMS', price_basis: 'per_kg' },
    prefix: '_sms_',
    decision: 'Owner 2026-10-17 "ขอ alumet กับ sms ด้วยเลย"; price per kg for all.',
    sqlFile: 'supabase/datafix/2026-10-17-import-sms-catalogue.sql',
    reportFile: 'docs/catalogs/sms/IMPORT-REPORT.md',
    dryrun: '.superpowers/sdd/2026-10-17-catalogue-import/run-dryrun.sh sms',
    sources: [
      { label: 'SMS Building Profile (HOMELIFE / PROLINE)', file: 'docs/catalogs/sms/sms-building-profile.json', series: [
        { idx: 0, name: 'PROLINE 1000 (100) ช่องแสง', types: ['บานติดตาย'] },
        { idx: 1, name: 'PROLINE 1000 (110) ช่องแสงร่องใหญ่', types: ['บานติดตาย'] },
        { idx: 2, name: 'PROLINE 130 / 131 ประตูบานสวิง', types: ['บานสวิงเดี่ยว', 'บานสวิงคู่'] },
        { idx: 3, name: 'HOMELIFE 2000 (200) บานเลื่อน', types: ['บานเลื่อนสวน 2 บาน', 'บานเลื่อน 3 บาน'] },
        { idx: 4, name: 'HOMELIFE 3000 (220) บานเลื่อนเฟรม 45', types: ['บานเลื่อนสวน 2 บาน'] },
        { idx: 5, name: 'SMS 230 ประตูบานเลื่อน (เฟรม 55)', types: [] },
        { idx: 6, name: 'HOMELIFE 4000 (240) บานเฟี้ยม', types: ['บานเฟี้ยม'] },
        { idx: 7, name: 'HOMELIFE 5000 (250) ประตูบานเปิดคู่', types: ['บานเปิด'] },
        { idx: 8, name: 'HOMELIFE 6000 / 7000 (260) บานกระทุ้ง / บานเปิด', types: ['บานกระทุ้ง', 'บานเปิดข้าง'] },
        { idx: 9, name: 'HOMELIFE 268 หน้าต่างบานเลื่อน 68.36', types: ['บานเลื่อนสวน 2 บาน'] },
        { idx: 10, name: 'SMS 300 มุ้งนิรภัย', types: [] },
      ] },
      { label: 'SMS001 Retail 5', file: 'docs/catalogs/sms/sms001-retail-5.json', series: [
        { idx: 0, name: 'SMS001 บานสวิง / ช่องแสง', types: ['บานสวิงเดี่ยว', 'บานสวิงคู่', 'บานติดตาย'] },
        { idx: 1, name: 'SMS001 บานเลื่อน', types: ['บานเลื่อนสวน 2 บาน', 'บานเลื่อน 3 บาน'] },
        { idx: 2, name: 'SMS001 บานกระทุ้ง', types: ['บานกระทุ้ง'] },
        { idx: 3, name: 'SMS001 ระแนง / บังแดด', types: [] },
        { idx: 4, name: 'SMS001 ผนังกระจก', types: ['STICK WALL'] },
        { idx: 5, skip: 'หน้าสีอบ: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 6, skip: 'หน้าสีอบ: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 7, skip: 'หน้าสีอบ: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 8, skip: 'หน้าสีอบ: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 9, skip: 'หน้าลายไม้สักทอง: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 10, skip: 'หน้าลายไม้สักทอง: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 11, skip: 'หน้าลายไม้สักทอง: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 12, skip: 'หน้าลายไม้สักทอง: รหัสซ้ำกับหน้าสีชุบ พิมพ์แค่ กก./เส้น' },
        { idx: 13, name: 'SMS001 หน้าตัดมาตรฐาน (ท่อ / ฉาก / แบน / ราง)', types: [] },
      ] },
    ],
    finishes: ['สีชุบ (อโนไดซ์)', 'อบขาว', 'อบดำ', 'ลายไม้สักทอง'],
    notes: [
      'Finishes: the retail book has mill (สีชุบ) pages and repeats the same dies in อบขาว / อบดำ and ลายไม้สักทอง; the building book prints no colours. Price per kg is entered per finish in the app.',
      'Retail sliding / swing / casement profiles printed only as kg per bar (no bar length) are not imported until the bar length is known (owner question SM1); then kg/m = midpoint / length.',
      'The existing provider "บริษัท เค ซี อินเตอร์เฟรม จำกัด" (short_name SMS-KC, 2 series, 0 profiles) is not touched.',
    ],
  },
]
