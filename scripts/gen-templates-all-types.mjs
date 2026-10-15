// One-off generator (2026-10-15, owner: "ทำของทุก type ที่เหลือเลย ทั้งหมด"): one BOM template per catalogue type,
// built with the app's own model code (startModel / validateModel / modelToRows / hardwareDefaultRows) so the rows are
// exactly what the template editor would save. Writes supabase/datafix/2026-10-15-templates-all-types.sql.
// Inputs (fetched from CHANG, read-only): scratchpad types.json, families.json, series_fams.json (paths as argv 2..4).
import fs from 'node:fs'
import { randomUUID } from 'node:crypto'
import { startModel, setParams } from '../src/lib/partModel.js'
import { defaultParams, fixedKeysOf, LAYOUTS } from '../src/lib/layoutRegistry.js'
import { validateModel, modelToRows, templateParamsPayload } from '../src/lib/partSave.js'
import { hardwareDefaultRows } from '../src/lib/hardwareDefaults.js'

const [typesPath, famsPath, seriesPath] = process.argv.slice(2)
const types = JSON.parse(fs.readFileSync(typesPath, 'utf8'))
const families = new Set(JSON.parse(fs.readFileSync(famsPath, 'utf8')))
const seriesFams = JSON.parse(fs.readFileSync(seriesPath, 'utf8'))
const inSeries = (s, f) => seriesFams.some(r => r.s === s && r.f === f)
const TENANT = '1b9affc4-2136-4ed1-b168-a36e6624e743'

const SLIDE_GEN = { frame_top: 'เฟรมบน', frame_bottom: 'เฟรมล่าง', frame_side: 'เฟรมข้าง' }
const sashFam = (k) => /_top$/.test(k) ? 'บานเลื่อนบน' : /_bottom$/.test(k) ? 'บานเลื่อนล่าง' : /key/.test(k) ? 'เสากุญแจ' : 'เสาเกี่ยว'
// type name -> { kind, typeParams (pinned on the type), series (the series the families come from), families override, hardware part links }
const PLAN = {
  'บานเลื่อน 2 ตาย 2': { kind: 'sliding_2_fixed_2', p: {}, series: 'ทั่วไป', fam: { ...SLIDE_GEN, sash_top: 'บานเลื่อนบน', sash_bottom: 'บานเลื่อนล่าง', stile_a: 'เสาเกี่ยว', stile_b: 'เสาเกี่ยว', sill_cover: 'ตบธรณี' }, hw: { 'ลูกล้อ': 'ลูกล้อบานเลื่อน', 'กุญแจ': 'มือจับฝัง(ล็อค)' } },
  'บานเลื่อน 3 บาน': { kind: 'sliding_3track', p: {}, series: 'Big Frame', fam: { frame_bottom: 'รางล่างบิ๊กเฟรม2ราง', frame_side: 'รางข้างบานเลื่อน', '*top': 'ขวางบนบานเลื่อน', '*bottom': 'ขวางล่างบานเลื่อน', '*key': 'เสากุญแจบานเลื่อน', '*hook': 'เสาเกี่ยวบานเลื่อน' }, hw: { 'ลูกล้อ': 'ลูกล้อคู่ Big Frame' } },
  'บานเลื่อนรางล่าง': { kind: 'sliding_n', p: { door: true }, series: 'ทั่วไป', fam: 'sliding', hw: { 'ลูกล้อ': 'ลูกล้อบานเลื่อน', 'กุญแจ/มือจับ': 'มือจับฝัง(ล็อค)' } },
  'บานเลื่อนรางแขวน': { kind: 'hanging_door', p: {}, series: 'ทั่วไป', fam: { track_cover: 'กล่อง 1-3/4 x 1- 1-3/4' }, hw: { 'ลูกล้อรางแขวน': 'ลูกล้อรางแขวน' } },
  'บานติดตาย': { kind: 'fixed_grid', p: {}, series: 'ทั่วไป', fam: { mullion: 'กล่องร่อง', transom: 'กล่องร่อง' }, hw: {} },
  'บานเปิดข้าง': { kind: 'casement_n', p: {}, series: 'ทั่วไป', fam: { mullion: 'กล่องร่อง' }, hw: {} },
  'บานเปิด': { kind: 'swing_door', p: { pivot: false }, series: 'ทั่วไป', fam: {}, hw: { 'มือจับ': 'มือจับสวิง HD-117' } },
  'บานสวิงเดี่ยว': { kind: 'swing_door', p: { pivot: true, leaves: 1 }, series: 'ทั่วไป', fam: {}, hw: { 'มือจับ': 'มือจับสวิง HD-117', 'door closer ฝังวงกบบน': 'โช้คอัพ vvp' } },
  'บานสวิงคู่': { kind: 'swing_door', p: { pivot: true, leaves: 2 }, series: 'ทั่วไป', fam: {}, hw: { 'มือจับ': 'มือจับสวิง HD-117', 'door closer ฝังวงกบบน': 'โช้คอัพ vvp' } },
  'บานสวิงเปลือยเดี่ยว': { kind: 'frameless_door', p: { leaves: 1 }, series: 'ทั่วไป', fam: {}, hw: {} },
  'บานสวิงเปลือยคู่': { kind: 'frameless_door', p: { leaves: 2 }, series: 'ทั่วไป', fam: {}, hw: {} },
  'บานเฟี้ยม': { kind: 'folding_door', p: {}, series: 'บานเฟี้ยม', fam: { track_bottom: 'รางล่าง', leaf_top: 'กรอบบาน 3"', leaf_bottom: 'กรอบบาน 3"', leaf_side: 'กรอบบาน 3"', leaf_cover_v: 'บังใบนอก 3"', leaf_cover_h: 'คิ้วบาน 3"' }, hw: {} },
  'STICK WALL': { kind: 'curtain_wall', p: { unitized: false }, series: 'Curtain Wall NO.9xxx', fam: {}, hw: { 'มือจับ': 'มือจับกระทุ้ง' } },
  'UNITIZED CURTAIN WALL': { kind: 'curtain_wall', p: { unitized: true }, series: 'Unitized', fam: { mullion: 'Ma-Mullion 13-0595a', plate_h: 'Fe-Mullion 13-0594a', transom: 'Int-Tran 13-0596a', plate_w: 'Int-Tran-W 13-0596a', cover_w: { f: 'Ma-Mullion 13-0595a', qty: 0 }, cover_h: { f: 'Ma-Mullion 13-0595a', qty: 0 }, sash_top: 'casement 13-0599a', sash_bottom: 'casement 13-0599a', sash_side: 'casem-base 13-0598a' }, hw: { 'มือจับ': 'มือจับกระทุ้ง' } },
  'ผนังกระจกบานเปลือย': { kind: 'frameless_wall', p: {}, series: 'ทั่วไป', fam: {}, hw: {} },
}
for (const t of types) {
  const m = /^บานกระทุ้ง (\d) ชั้น x (\d) ช่อง/.exec(t.name)
  if (m) PLAN[t.name] = { kind: 'awning_grid', p: { rows: Number(m[1]), cols: Number(m[2]) }, series: 'ทั่วไป', fam: { mullion: 'กล่องร่อง', transom: 'กล่องร่อง' }, hw: { 'มือจับ': 'มือจับกระทุ้ง' } }
}
const PREVIEW = { sliding_2_fixed_2: 'slide', sliding_3track: 'slide', sliding_n: 'slide', hanging_door: 'slide', folding_door: 'slide', swing_door: 'swing', frameless_door: 'swing', casement_n: 'swing' }

const q = (v) => v === null || v === undefined ? 'NULL' : typeof v === 'number' ? String(v) : typeof v === 'boolean' ? String(v) : `'${String(v).replace(/'/g, "''")}'`
const jq = (o) => `'${JSON.stringify(o).replace(/'/g, "''")}'::jsonb`
const insert = (table, rows) => rows.length ? `INSERT INTO ${table} (${Object.keys(rows[0]).join(', ')}) VALUES\n` + rows.map(r => '  (' + Object.values(r).map(v => (v && typeof v === 'object') ? jq(v) : q(v)).join(', ') + ')').join(',\n') + ';\n' : ''

const out = []
const report = []
const typeUpdates = [['บานเลื่อนสวน 2 บาน', 'sliding_2', {}]]
for (const [name, plan] of Object.entries(PLAN)) {
  const type = types.find(t => t.name === name)
  if (!type) { report.push(`SKIP ${name}: type not found`); continue }
  typeUpdates.push([name, plan.kind, plan.p])
  let model = startModel(plan.kind, defaultParams(plan.kind, plan.p))
  const fixedKeys = fixedKeysOf(plan.kind, plan.p)
  if (fixedKeys.length) model = { ...model, fixedKeys }
  const L = LAYOUTS[plan.kind]
  const notes = []
  for (const key of Object.keys(model.lines)) {
    let want = null, qty = null
    if (plan.fam === 'sliding') want = SLIDE_GEN[key] || sashFam(key)
    else if (plan.fam[key] !== undefined) { const v = plan.fam[key]; want = typeof v === 'object' ? v.f : v; qty = typeof v === 'object' ? v.qty : null }
    else if (L.positions[key].part !== 'frame' && plan.kind.startsWith('sliding')) {
      const w = Object.entries(plan.fam).find(([k]) => k.startsWith('*') && key.includes(k.slice(1)))
      if (w) want = w[1]
    }
    if (plan.kind.startsWith('sliding') && !want && !model.lines[key][0].profile_family) want = SLIDE_GEN[key] || sashFam(key)
    model.lines[key] = model.lines[key].map((l, i) => i === 0 && want ? { ...l, profile_family: want, ...(qty !== null ? { quantity_value: qty } : {}) } : l)
    for (const l of model.lines[key]) {
      if (!families.has(l.profile_family)) notes.push(`${key}: '${l.profile_family}' NOT IN CATALOGUE`)
      else if (!inSeries(plan.series, l.profile_family)) notes.push(`${key}: '${l.profile_family}' not in series ${plan.series}`)
    }
  }
  const bad = validateModel(model)
  if (bad) { report.push(`FAIL ${name}: ${bad}`); continue }
  const tid = randomUUID()
  const tname = `${name} ${plan.series}`
  const rows = modelToRows(model, tid, randomUUID)
  const add = (rs) => rs.map(r => ({ tenant_id: TENANT, ...r }))
  const hw = hardwareDefaultRows(plan.kind, model.params, 0).map(r => ({ tenant_id: TENANT, template_id: tid, ...r }))
  const tpl = { id: tid, tenant_id: TENANT, name: tname, category: type.category === 'door' ? 'door' : 'window', waste_pct: 10, type_id: type.id,
    preview_kind: PREVIEW[plan.kind] || 'fixed', main_axis: 'vertical', layout_kind: plan.kind, layout_params: templateParamsPayload(model).layout_params || {} }
  out.push(`-- ${tname}  (${plan.kind} ${JSON.stringify(plan.p)})${notes.length ? '\n--   check: ' + notes.join('; ') : ''}`)
  out.push(`DO $$ BEGIN IF EXISTS (SELECT 1 FROM bom_templates WHERE tenant_id = '${TENANT}' AND name = ${q(tname)}) THEN RAISE EXCEPTION 'ABORT: template % already exists', ${q(tname)}; END IF; END $$;`)
  out.push(insert('bom_templates', [tpl]) + insert('bom_template_parts', add(rows.parts)) + insert('bom_template_positions', add(rows.positions))
    + insert('bom_template_position_profiles', add(rows.lines)) + insert('bom_template_piece_ends', add(rows.ends)) + insert('bom_template_hardware', hw))
  const links = Object.entries(plan.hw).filter(([h]) => hw.some(r => r.name === h))
  for (const [h, part] of links) out.push(`UPDATE bom_template_hardware SET part_id = (SELECT id FROM alu_parts WHERE tenant_id = '${TENANT}' AND name = ${q(part)}) WHERE template_id = '${tid}' AND name = ${q(h)};`)
  report.push(`OK ${tname}: ${rows.parts.length} parts, ${rows.positions.length} positions, ${rows.lines.length} lines, ${hw.length} hw (${links.length} priced)${notes.length ? ' | ' + notes.length + ' family notes' : ''}`)
}
const head = `-- ============================================================
-- ONE-OFF DATA (2026-10-15, owner: "ทำของทุก type ที่เหลือเลย ทั้งหมด"): layout_kind on every catalogue type + one BOM template
-- per remaining type, generated by scripts/gen-templates-all-types.mjs with the app's own model code (startModel /
-- validateModel / modelToRows / hardwareDefaultRows), so the rows are what the template editor saves. Families come from
-- the layouts' Excel defaults, fixed where the imported catalogue spells them differently; widths / butt distances are
-- NOT set (owner enters them later). Each template aborts if one with the same name exists. Dry run: COMMIT -> ROLLBACK.
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';
` + typeUpdates.map(([n, k, p]) => `UPDATE door_window_types SET layout_kind = ${q(k)}, layout_params = ${jq(p)} WHERE tenant_id = '${TENANT}' AND name = ${q(n)};`).join('\n') + '\n\n'
fs.writeFileSync('supabase/datafix/2026-10-15-templates-all-types.sql', head + out.join('\n') + '\nCOMMIT;\n')
console.log(report.join('\n'))
