// SMART PLUS (บจก. รัตนดำรงค์ / RD Aluminium) catalogue import: pure model building + SQL/report rendering.
// Used by scripts/gen-sp-import.mjs; tested by scripts/sp-import-lib.test.mjs. Same shape and guards as the MN import
// (scripts/mn-import-lib.mjs), minus prices: the 2024 catalogue prints no price and no bar length.
import { q } from './mn-import-lib.mjs'

export const PROVIDER = { name: 'บจก. รัตนดำรงค์ (SMART PLUS)', short_name: 'SP', price_basis: 'per_kg' } // C5: ราคาต่อ กก. x กก./ม. x ยาว
export const CATALOGUE_SOURCE = 'SMART PLUS catalogue 2024'
export const CUT_SOURCE = 'สูตรตัดลดบาน Smart Plus 2022'
export const DEFAULT_LENGTH_M = 6.4 // not printed anywhere; assumed for every profile (owner question SP1)
export const TENANT_ID = '1b9affc4-2136-4ed1-b168-a36e6624e743' // FacadeX tenant (the NOTICE prints its company_name)
export const TABLE_PREFIX = '_sp_'

const clean1 = (s) => String(s).replace(/\s+/g, ' ').trim()
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const num = (v) => (v === null || v === undefined || v === '' ? null : Number(v))

// Catalogue series (index in smart-plus-2024.json series[]) -> series name in the app + door/window types.
// The types are the ones the catalogue heading itself names (SLIDING WINDOWS & DOOR 2 ราง / 3 ราง; CASEMENT WINDOWS &
// DOOR & FIXED; BI-FOLDING) and that the app has by exact name.
export const CATALOGUE_SERIES = [
  { idx: 0, name: 'SEMI EURO 1.2 ชุดบานเลื่อน 2 ราง / 3 ราง', types: ['บานเลื่อนสวน 2 บาน', 'บานเลื่อน 2 ตาย 2', 'บานเลื่อน 3 บาน', 'บานเลื่อนรางล่าง'] },
  { idx: 1, name: 'SEMI EURO 1.2 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย', types: ['บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน', 'บานเปิดข้าง', 'บานเปิด', 'บานติดตาย'] },
  { idx: 2, name: 'EURO 1.5 ชุดบานเลื่อน 2 ราง / 3 ราง', types: ['บานเลื่อนสวน 2 บาน', 'บานเลื่อน 2 ตาย 2', 'บานเลื่อน 3 บาน', 'บานเลื่อนรางล่าง'] },
  { idx: 3, name: 'EURO 1.5 ชุดบานเปิด / บานกระทุ้ง / บานติดตาย', types: ['บานกระทุ้ง 1 ชั้น x 1 ช่อง = 1 บาน', 'บานเปิดข้าง', 'บานเปิด', 'บานติดตาย'] },
  { idx: 4, name: 'EURO 1.5 ชุดประตูบานเฟี้ยม', types: ['บานเฟี้ยม'] },
]

// Fields that must agree when one die is printed in several series (first printing with a kg/m wins).
const SAME_FIELDS = ['kg', 'width_mm', 'depth_mm', 'thickness_mm', 'family']

export function buildImport({ catalog, cuts }) {
  if (catalog.series.length !== CATALOGUE_SERIES.length) throw new Error(`catalogue has ${catalog.series.length} series, mapping has ${CATALOGUE_SERIES.length}`)
  const excludedProfiles = [] // { die, name, page, reason }
  const reprints = []         // { die, field, kept, other, page }
  const occ = new Map()       // die -> [{ ...row, si }]
  catalog.series.forEach((s, si) => {
    for (const p of s.profiles) {
      const die = clean1(p.die_no ?? '').toUpperCase() || null
      const row = {
        die, name: clean1(p.name), page: p.page, si, confidence: p.confidence,
        family: clean1(p.role_family || '') || null, kg: num(p.kg_per_m),
        width_mm: num(p.width_mm) > 0 ? num(p.width_mm) : null, depth_mm: num(p.depth_mm) > 0 ? num(p.depth_mm) : null,
        thickness_mm: num(p.wall_mm),
      }
      if (!die) { excludedProfiles.push({ ...row, reason: 'no die no.' }); continue }
      if (!occ.has(die)) occ.set(die, [])
      occ.get(die).push(row)
    }
  })
  const profiles = []
  const links = []
  for (const [die, rowsOf] of occ) {
    const usable = rowsOf.filter(r => r.confidence === 'read' && r.kg !== null && r.kg >= 0)
    if (!usable.length) { excludedProfiles.push({ ...rowsOf[0], reason: rowsOf.some(r => r.confidence !== 'read') ? 'not read with confidence' : 'no kg/m' }); continue }
    const keep = usable[0]
    for (const r of rowsOf) {
      if (r === keep) continue
      for (const f of SAME_FIELDS) if (r[f] !== null && keep[f] !== null && r[f] !== keep[f]) reprints.push({ die, field: f, kept: keep[f], keptPage: keep.page, other: r[f], page: r.page })
      if (r.kg === null) reprints.push({ die, field: 'kg', kept: keep.kg, keptPage: keep.page, other: 'ไม่ได้พิมพ์', page: r.page })
    }
    profiles.push({ key: die, die, name: keep.name, family: keep.family, thickness_mm: keep.thickness_mm, kg: keep.kg, width_mm: keep.width_mm, depth_mm: keep.depth_mm, default_length_m: DEFAULT_LENGTH_M, page: keep.page })
    const seen = new Set()
    for (const r of rowsOf) {
      if (seen.has(r.si)) continue
      seen.add(r.si)
      links.push({ series: CATALOGUE_SERIES[r.si].name, key: die, family: r.family ?? keep.family })
    }
  }
  profiles.sort((a, b) => byStr(a.key, b.key))
  links.sort((a, b) => byStr(a.series, b.series) || byStr(a.key, b.key))
  const series = CATALOGUE_SERIES.map(cs => ({ name: cs.name, src: `${CATALOGUE_SOURCE} series ${cs.idx}: ${clean1(catalog.series[cs.idx].name)}` }))
  const typeLinks = CATALOGUE_SERIES.flatMap(cs => cs.types.map(t => ({ series: cs.name, type_name: t })))
  const finishes = catalog.finishes.map(f => clean1(f.name))

  // ambiguous (series, family, thickness): the estimator would have to pick one die (report only)
  const ambiguous = []
  for (const s of series) {
    const g = new Map()
    for (const l of links.filter(x => x.series === s.name && x.family)) {
      const p = profiles.find(x => x.key === l.key)
      const k = `${l.family}|${p.thickness_mm ?? ''}`
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(p.die)
    }
    for (const [k, dies] of g) if (dies.length > 1) { const [family, th] = k.split('|'); ambiguous.push({ series: s.name, family, thickness_mm: th === '' ? null : Number(th), dies: dies.sort(byStr) }) }
  }

  // cut sheets 2022: not imported (no formula table; they feed the BOM-template step), only checked against the dies
  const known = new Set(profiles.map(p => p.die))
  const cutSheets = (cuts?.series || []).flatMap(s => s.assembly.map(a => ({
    series: clean1(s.name), type: clean1(a.type), page: a.page, joints: a.joints || '',
    formulas: a.cut_formulas.map(f => ({ die: clean1(String(f.die_no ?? '')).toUpperCase() || null, member: clean1(f.member || ''), printed: clean1(f.formula_as_printed || ''), formula: clean1(f.formula_normalised || ''), qty: f.qty_per_unit ?? null, cut: f.cut || '', reference: f.reference || '' })),
  })))
  const cutMissingDies = [...new Set(cutSheets.flatMap(c => c.formulas.map(f => f.die)).filter(d => d && !known.has(d)))].sort(byStr)
  return {
    profiles, excludedProfiles, reprints, series, links, typeLinks, finishes, ambiguous, cutSheets, cutMissingDies,
    cutWeightDiffs: cuts?.weights_printed_on_cut_sheets_that_differ_from_2024 || [],
    questions: [...(catalog.open_questions || []), ...(cuts?.open_questions || [])],
    totals: { catalogueRows: catalog.series.reduce((n, s) => n + s.profiles.length, 0), formulas: cutSheets.reduce((n, c) => n + c.formulas.length, 0) },
  }
}

export function expectedCounts(m) {
  return { providers: 1, series: m.series.length, profiles: m.profiles.length, series_profiles: m.links.length, finishes: m.finishes.length, series_types: m.typeLinks.length }
}

// ---------- SQL ----------

const rows = (list, f) => list.map(x => '  (' + f(x).map(q).join(', ') + ')').join(',\n')

export function renderSql(m) {
  const e = expectedCounts(m)
  const T = TABLE_PREFIX
  return `-- ============================================================
-- ONE-OFF DATA IMPORT — ${PROVIDER.name} aluminium catalogue. GENERATED by scripts/gen-sp-import.mjs; do not edit by hand.
-- NOT part of the code release. Owner decision 2026-10-17 "ทำ Smart Plus ต่อเลย ไม่มี profile general".
-- Report: docs/catalogs/smartplus/IMPORT-REPORT.md.
-- Source: ${CATALOGUE_SOURCE} (docs/catalogs/smartplus/smart-plus-2024.json: die, name, role, kg/m, wall, width, depth).
-- Adds under the FacadeX tenant: provider '${PROVIDER.name}' (short_name ${PROVIDER.short_name}, price_basis ${PROVIDER.price_basis});
--   ${e.series} series (the catalogue's 5 systems); ${e.profiles} profiles (drawing_no = die no.; a die printed in several systems is
--   one profile linked to each); ${e.series_profiles} series-profile links (family = role); ${e.finishes} finishes (catalogue page 3);
--   ${e.series_types} series-type links (the types each system heading names).
-- NOT set: prices (the catalogue has none), profile variants, butt_distance_mm, hardware, cut formulas (2022 cut sheets are
--   listed in the report for the BOM-template step). default_length_m = ${DEFAULT_LENGTH_M} for every profile (assumed, not printed).
-- No profile is "general": every row belongs to this provider only (owner, 2026-10-17).
-- Guarded: aborts unless the tenant is the one holding provider 'ไฟล์ Aluminium calculation', the 2026-10-12-01 and 2026-10-15-01
--   migrations are applied, every door/window type named below exists, and the final row counts equal the generator's numbers.
-- Idempotent: natural keys (provider+name, provider+die, series+profile, provider+finish, series+type) are skipped when present.
-- Run: dry run first with .superpowers/sdd/2026-10-17-sp-import/run-sp-import-dryrun.sh (COMMIT -> ROLLBACK), then
--   npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f <absolute path of this file>
--   (CHANG only. NEVER the retired Tokyo project yyzbgdmgyvvypfcjuhtr.)
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE ${T}series (name TEXT PRIMARY KEY, src TEXT NOT NULL) ON COMMIT DROP;
INSERT INTO ${T}series VALUES
${rows(m.series, s => [s.name, s.src])};

CREATE TEMP TABLE ${T}profiles (die TEXT PRIMARY KEY, name TEXT NOT NULL, family TEXT, thickness_mm NUMERIC, kg_per_m NUMERIC NOT NULL, width_mm NUMERIC, depth_mm NUMERIC, length_m NUMERIC NOT NULL, page INT) ON COMMIT DROP;
INSERT INTO ${T}profiles VALUES
${rows(m.profiles, p => [p.die, p.name, p.family, p.thickness_mm, p.kg, p.width_mm, p.depth_mm, p.default_length_m, p.page])};

CREATE TEMP TABLE ${T}links (series TEXT NOT NULL, die TEXT NOT NULL, family TEXT, PRIMARY KEY (series, die)) ON COMMIT DROP;
INSERT INTO ${T}links VALUES
${rows(m.links, l => [l.series, l.key, l.family])};

CREATE TEMP TABLE ${T}finishes (name TEXT PRIMARY KEY, sort INT NOT NULL) ON COMMIT DROP;
INSERT INTO ${T}finishes VALUES
${rows(m.finishes.map((f, i) => [f, i + 1]), x => x)};

CREATE TEMP TABLE ${T}types (series TEXT NOT NULL, type_name TEXT NOT NULL, PRIMARY KEY (series, type_name)) ON COMMIT DROP;
INSERT INTO ${T}types VALUES
${rows(m.typeLinks, t => [t.series, t.type_name])};

DO $$
DECLARE
  c_tenant        CONSTANT UUID := '${TENANT_ID}';   -- FacadeX tenant (NOTICE prints its company_name)
  c_provider_name CONSTANT TEXT := ${q(PROVIDER.name)};
  c_short_name    CONSTANT TEXT := ${q(PROVIDER.short_name)};
  e_series        CONSTANT INT := ${e.series};
  e_profiles      CONSTANT INT := ${e.profiles};
  e_links         CONSTANT INT := ${e.series_profiles};
  e_finishes      CONSTANT INT := ${e.finishes};
  e_types         CONSTANT INT := ${e.series_types};
  v_tenant_name TEXT; v_provider UUID; v_n INT; v_txt TEXT;
BEGIN
  SELECT company_name INTO v_tenant_name FROM tenants WHERE id = c_tenant;
  IF v_tenant_name IS NULL THEN RAISE EXCEPTION 'ABORT: tenant % not found', c_tenant; END IF;
  RAISE NOTICE 'tenant = % (%)', v_tenant_name, c_tenant;
  IF NOT EXISTS (SELECT 1 FROM alu_providers WHERE tenant_id = c_tenant AND name = 'ไฟล์ Aluminium calculation') THEN
    RAISE EXCEPTION 'ABORT: tenant % has no provider ''ไฟล์ Aluminium calculation'' — wrong tenant or wrong database', v_tenant_name;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alu_profiles' AND column_name = 'width_mm')
     OR NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'alu_profiles' AND column_name = 'butt_distance_mm') THEN
    RAISE EXCEPTION 'ABORT: apply migrations 2026-10-12-01 and 2026-10-15-01 first';
  END IF;

  -- the file itself is complete
  IF (SELECT count(*) FROM ${T}series) <> e_series OR (SELECT count(*) FROM ${T}profiles) <> e_profiles
     OR (SELECT count(*) FROM ${T}links) <> e_links OR (SELECT count(*) FROM ${T}finishes) <> e_finishes
     OR (SELECT count(*) FROM ${T}types) <> e_types THEN
    RAISE EXCEPTION 'ABORT: temp table counts differ from the generator''s expected counts (file truncated or edited?)';
  END IF;

  -- every type named must exist (by exact name)
  SELECT string_agg(DISTINCT t.type_name, ', ') INTO v_txt FROM ${T}types t
    WHERE NOT EXISTS (SELECT 1 FROM door_window_types d WHERE d.tenant_id = c_tenant AND d.name = t.type_name);
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'ABORT: door_window_types not found: %', v_txt; END IF;

  -- 1. provider
  SELECT string_agg(name, ', ') INTO v_txt FROM alu_providers WHERE tenant_id = c_tenant AND short_name = c_short_name AND name <> c_provider_name;
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'ABORT: another provider already uses short_name %: % (set c_provider_name to it, or rename)', c_short_name, v_txt; END IF;
  SELECT id INTO v_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = c_provider_name;
  IF v_provider IS NULL THEN
    INSERT INTO alu_providers (tenant_id, name, short_name, price_basis) VALUES (c_tenant, c_provider_name, c_short_name, ${q(PROVIDER.price_basis)}) RETURNING id INTO v_provider;
    RAISE NOTICE 'provider created: % (%)', c_provider_name, v_provider;
  ELSE
    RAISE NOTICE 'provider exists: % (%), price_basis %', c_provider_name, v_provider, (SELECT price_basis FROM alu_providers WHERE id = v_provider);
  END IF;
  IF EXISTS (SELECT 1 FROM alu_profiles WHERE provider_id = v_provider AND drawing_no IS NOT NULL GROUP BY drawing_no HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT: provider % already has two profiles with one die no. — clean that up first', c_provider_name;
  END IF;

  -- 2. series
  INSERT INTO alu_series (tenant_id, provider_id, name, is_base)
    SELECT c_tenant, v_provider, s.name, false FROM ${T}series s ORDER BY s.name
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series inserted: % of %', v_n, e_series;

  -- 3. profiles (natural key: provider + die)
  INSERT INTO alu_profiles (tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm, depth_mm)
    SELECT c_tenant, v_provider, t.name, t.die, t.family, t.thickness_mm, t.kg_per_m, t.length_m, t.width_mm, t.depth_mm
      FROM ${T}profiles t
     WHERE NOT EXISTS (SELECT 1 FROM alu_profiles p WHERE p.provider_id = v_provider AND p.drawing_no = t.die)
     ORDER BY t.die;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'profiles inserted: % of %', v_n, e_profiles;
  CREATE TEMP TABLE ${T}pid ON COMMIT DROP AS
    SELECT t.die, (SELECT p.id FROM alu_profiles p WHERE p.provider_id = v_provider AND p.drawing_no = t.die ORDER BY p.created_at, p.id LIMIT 1) AS profile_id
      FROM ${T}profiles t;
  SELECT count(profile_id) INTO v_n FROM ${T}pid;
  IF v_n <> e_profiles THEN RAISE EXCEPTION 'ABORT: % of % profiles resolved', v_n, e_profiles; END IF;

  -- 4. series <-> profile links
  INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family)
    SELECT c_tenant, s.id, m.profile_id, l.family FROM ${T}links l
      JOIN alu_series s ON s.provider_id = v_provider AND s.name = l.series
      JOIN ${T}pid m ON m.die = l.die
     ORDER BY l.series, l.die
    ON CONFLICT (series_id, profile_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-profile links inserted: % of %', v_n, e_links;

  -- 5. finishes
  INSERT INTO alu_finishes (tenant_id, provider_id, name)
    SELECT c_tenant, v_provider, f.name FROM ${T}finishes f ORDER BY f.sort
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'finishes inserted: % of %', v_n, e_finishes;

  -- 6. series <-> door/window type links
  INSERT INTO alu_series_types (tenant_id, series_id, type_id)
    SELECT c_tenant, s.id, d.id FROM ${T}types t
      JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.series
      JOIN door_window_types d ON d.tenant_id = c_tenant AND d.name = t.type_name
     ORDER BY t.series, t.type_name
    ON CONFLICT (series_id, type_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-type links inserted: % of %', v_n, e_types;

  -- 7. final guard: what is now in the DB for these natural keys equals the generator's numbers
  SELECT count(*) INTO v_n FROM ${T}series t JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.name;
  IF v_n <> e_series THEN RAISE EXCEPTION 'ABORT: series present % <> expected %', v_n, e_series; END IF;
  SELECT count(*) INTO v_n FROM ${T}links l JOIN alu_series s ON s.provider_id = v_provider AND s.name = l.series
    JOIN ${T}pid m ON m.die = l.die JOIN alu_series_profiles sp ON sp.series_id = s.id AND sp.profile_id = m.profile_id;
  IF v_n <> e_links THEN RAISE EXCEPTION 'ABORT: series-profile links present % <> expected %', v_n, e_links; END IF;
  SELECT count(*) INTO v_n FROM ${T}finishes t JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = t.name;
  IF v_n <> e_finishes THEN RAISE EXCEPTION 'ABORT: finishes present % <> expected %', v_n, e_finishes; END IF;
  SELECT count(*) INTO v_n FROM ${T}types t JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.series
    JOIN door_window_types d ON d.tenant_id = c_tenant AND d.name = t.type_name
    JOIN alu_series_types st ON st.series_id = s.id AND st.type_id = d.id;
  IF v_n <> e_types THEN RAISE EXCEPTION 'ABORT: series-type links present % <> expected %', v_n, e_types; END IF;
  RAISE NOTICE 'SP IMPORT OK: series %, profiles %, links %, finishes %, type links %', e_series, e_profiles, e_links, e_finishes, e_types;
END $$;

-- Dry run: replace COMMIT with ROLLBACK (the wrapper script does that), read the NOTICE / result lines.
COMMIT;
`
}

// ---------- report ----------

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderReport(m) {
  const e = expectedCounts(m)
  const L = []
  const p = (s = '') => L.push(s)
  p('# SMART PLUS catalogue import report (generated)')
  p()
  p('Generated by `scripts/gen-sp-import.mjs` — do not edit by hand; re-run the generator. SQL: `supabase/datafix/2026-10-17-import-smartplus-catalogue.sql`. Dry run: `.superpowers/sdd/2026-10-17-sp-import/run-sp-import-dryrun.sh`.')
  p()
  p(`Provider **${PROVIDER.name}** (short_name \`${PROVIDER.short_name}\`, price_basis \`${PROVIDER.price_basis}\`: owner C5 "ราคาต่อ กก. x เส้น x ยาว"). Source ${CATALOGUE_SOURCE}. No prices, no bar lengths (default_length_m ${DEFAULT_LENGTH_M} assumed for all), no butt distances. No profile is general (owner 2026-10-17).`)
  p()
  p('## Row counts (what the SQL guarantees after it runs)')
  p()
  p('| table | rows |')
  p('|---|---|')
  for (const [k, v] of Object.entries(e)) p(`| ${k} | ${v} |`)
  p()
  p(`- Input: ${m.totals.catalogueRows} catalogue rows; a die printed in several systems is one profile linked to each, so ${m.profiles.length} profiles and ${m.links.length} links.`)
  p(`- Finishes: ${m.finishes.join(', ')}.`)
  p()
  p('## Series and types')
  p()
  p('| series | profiles | types linked |')
  p('|---|---|---|')
  for (const s of m.series) p(`| ${md(s.name)} | ${m.links.filter(l => l.series === s.name).length} | ${md(m.typeLinks.filter(t => t.series === s.name).map(t => t.type_name).join(', '))} |`)
  p()
  p('## Profiles not imported')
  p()
  p('| die | name | page | reason |')
  p('|---|---|---|---|')
  for (const x of m.excludedProfiles) p(`| ${md(x.die || '-')} | ${md(x.name)} | ${x.page} | ${md(x.reason)} |`)
  if (!m.excludedProfiles.length) p('| - | none | | |')
  p()
  p('## One die printed twice with different values (first printing kept)')
  p()
  p('| die | field | kept (page) | other printing (page) |')
  p('|---|---|---|---|')
  for (const r of m.reprints) p(`| ${r.die} | ${r.field} | ${md(r.kept)} (p.${r.keptPage}) | ${md(r.other)} (p.${r.page}) |`)
  if (!m.reprints.length) p('| - | none | | |')
  p()
  p('## Same family and thickness twice in one series (the estimator has to pick one die)')
  p()
  p('| series | family | thickness mm | dies |')
  p('|---|---|---|---|')
  for (const a of m.ambiguous) p(`| ${md(a.series)} | ${md(a.family)} | ${a.thickness_mm ?? '-'} | ${a.dies.join(', ')} |`)
  p()
  p(`## Cut sheets 2022 (${CUT_SOURCE}) — not imported`)
  p()
  p(`${m.cutSheets.length} sheets, ${m.totals.formulas} cut formulas. The app has no formula table: these become BOM templates (positions + butt distances) in a later step. W / H = overall frame width / height; "หาร n" divides the whole expression.`)
  p()
  p(`- Dies on the cut sheets that are not in the 2024 catalogue (no kg/m, not imported): ${m.cutMissingDies.join(', ') || 'none'}.`)
  p(`- kg/m printed on the cut sheets that differ from the 2024 catalogue (2024 used): ${m.cutWeightDiffs.map(w => `${w.die_no} ${w.cut_sheet} vs ${w.catalogue_2024 ?? '-'} (p.${w.page})`).join('; ') || 'none'}.`)
  p()
  for (const c of m.cutSheets) {
    p(`### p.${c.page} ${md(c.type)}`)
    p()
    p(`${md(c.series)}${c.joints ? ' — ' + md(c.joints) : ''}`)
    p()
    p('| die | member | formula (printed) | qty | cut |')
    p('|---|---|---|---|---|')
    for (const f of c.formulas) p(`| ${md(f.die || '-')} | ${md(f.member)} | ${md(f.printed)} | ${f.qty ?? '-'} | ${md(f.cut)} |`)
    p()
  }
  p('## Questions for the owner (from the extraction)')
  p()
  m.questions.forEach((x, i) => p(`${i + 1}. ${x}`))
  p()
  return L.join('\n')
}
