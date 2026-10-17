// Generic supplier-catalogue import (SMART PLUS, Alumet, SMS ...): pure model building + SQL/report rendering.
// Each supplier is a config in scripts/catalogue-import-configs.mjs; scripts/gen-catalogue-import.mjs writes the files.
// Same guards as the MN import (scripts/mn-import-lib.mjs), minus prices (none of these catalogues prints one).
// Natural key of a profile = provider + die no. + wall thickness: one die printed at several thicknesses is one item per
// thickness (owner C4 "แยก item"). A die printed in several series is one profile linked to each series.
import { q } from './mn-import-lib.mjs'

export const TENANT_ID = '1b9affc4-2136-4ed1-b168-a36e6624e743' // FacadeX tenant (the NOTICE prints its company_name)
export const DEFAULT_LENGTH_M = 6.4

const clean1 = (s) => String(s ?? '').replace(/\s+/g, ' ').trim()
const byStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
const num = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v))
const r3 = (x) => Math.round(x * 1000) / 1000

// "3.9-4.2" / [3.9, 4.2] / 4.0 -> midpoint (owner C3: ค่ากลาง); anything else -> null
export function midpoint(v) {
  if (Array.isArray(v)) { const a = v.map(num); return a.length === 2 && a[0] !== null && a[1] !== null ? (a[0] + a[1]) / 2 : null }
  if (typeof v === 'number') return v
  const m = /^\s*(\d+(?:\.\d+)?)\s*(?:-\s*(\d+(?:\.\d+)?))?\s*$/.exec(String(v ?? ''))
  if (!m) return null
  return m[2] ? (Number(m[1]) + Number(m[2])) / 2 : Number(m[1])
}

// One catalogue row -> the items it yields ({ thickness_mm, kg, kgNote }) or a reason it yields none.
// - kg/m printed and read: as printed.
// - "estimated" kg/m whose basis is a midpoint of a printed kg/bar range: accepted (owner C3), noted.
// - weights_by_thickness (Alumet Mini: kg/bar range per wall): one item per plain-number thickness,
//   kg/m = midpoint of the anodize range / the bar length printed on that row.
export function expandRow(p) {
  const wall = num(p.wall_mm)
  if (Array.isArray(p.weights_by_thickness) && p.weights_by_thickness.length) {
    const L = num(p.std_length_m)
    const items = [], skipped = []
    for (const w of p.weights_by_thickness) {
      const t = String(w.thickness_mm ?? '').trim()
      if (!/^\d+(\.\d+)?$/.test(t)) { skipped.push(`ความหนา "${t}" ไม่ใช่ตัวเลข`); continue }
      const mid = midpoint(w.anodize_kg_per_bar)
      if (mid === null) { skipped.push(`${t} มม.: ไม่มีน้ำหนักสีชุบ`); continue }
      if (!L) { skipped.push(`${t} มม.: ไม่ได้พิมพ์ความยาวเส้น`); continue }
      items.push({ thickness_mm: Number(t), kg: r3(mid / L), kgNote: `กลางช่วง ${w.anodize_kg_per_bar} กก./เส้น ÷ ${L} ม.` })
    }
    return { items, skipped }
  }
  const kg = num(p.kg_per_m)
  if (kg === null || kg < 0) {
    if (p.kg_per_piece_range) return { items: [], skipped: [`พิมพ์เป็น กก./เส้น ${p.kg_per_piece_range.join('-')} แต่ไม่บอกความยาวเส้น`] }
    return { items: [], skipped: ['ไม่มี กก./ม.'] }
  }
  if (p.confidence === 'read') return { items: [{ thickness_mm: wall, kg, kgNote: null }], skipped: [] }
  if (/^midpoint/i.test(p.kg_per_m_basis || '')) return { items: [{ thickness_mm: wall, kg, kgNote: clean1(p.kg_per_m_basis) }], skipped: [] }
  return { items: [], skipped: [`confidence "${p.confidence}"`] }
}

const SAME_FIELDS = ['kg', 'width_mm', 'depth_mm', 'family']

// The shop's per-kg rate by colour class lives on provider RATE_PROVIDER (owner chat 2026-10-15). cfg.kgRates maps a
// finish of this supplier to one of those classes; the SQL copies the class's current provider-wide rate.
export const RATE_PROVIDER = 'ไฟล์ Aluminium calculation'
function kgRatesOf(cfg) {
  const list = (cfg.kgRates || []).map(([finish, rateClass]) => ({ finish, rateClass }))
  for (const r of list) if (!(cfg.finishes || []).includes(r.finish)) throw new Error(`${cfg.id}: kg rate for unknown finish ${r.finish}`)
  return list
}

export function buildImport(cfg, inputs) {
  const excluded = [], reprints = [], kgDerived = []
  const occ = new Map() // key -> rows
  const noKg = []       // printings without kg/m (resolved after all sources are read)
  const seriesDefs = []
  for (const src of cfg.sources) {
    const cat = inputs[src.file]
    if (!cat) throw new Error('missing input ' + src.file)
    if (cat.series.length !== src.series.length) throw new Error(`${src.file}: catalogue has ${cat.series.length} series, mapping has ${src.series.length}`)
    cat.series.forEach((s, si) => {
      const def = src.series[si]
      if (def.idx !== si) throw new Error(`${src.file}: mapping row ${si} has idx ${def.idx}`)
      if (!def.skip) seriesDefs.push({ name: def.name, types: def.types || [], src: `${src.label} series ${si}: ${clean1(s.name)}` })
      for (const p of s.profiles || []) {
        const die = clean1(p.die_no).toUpperCase() || null
        const base = { die, name: clean1(p.name), page: p.page, src: src.label, series: def.skip ? null : def.name }
        if (def.skip) { excluded.push({ ...base, reason: `กลุ่มนี้ไม่นำเข้า: ${def.skip}` }); continue }
        if (!die) { excluded.push({ ...base, reason: 'no die no.' }); continue }
        const { items, skipped } = expandRow(p)
        // no weight on this printing, but the same die + wall may be printed with one elsewhere: link to that later
        if (!items.length && skipped.length === 1 && skipped[0] === 'ไม่มี กก./ม.') { noKg.push({ ...base, key: `${die}|${num(p.wall_mm) ?? ''}`, series: def.name, family: clean1(p.role_family) || null }); continue }
        for (const why of skipped) excluded.push({ ...base, reason: why })
        for (const it of items) {
          const key = `${die}|${it.thickness_mm ?? ''}`
          const row = {
            ...base, key, series: def.name, thickness_mm: it.thickness_mm, kg: it.kg, kgNote: it.kgNote,
            family: clean1(p.role_family) || null, also: (p.also_roles || []).map(clean1),
            width_mm: num(p.width_mm) > 0 ? num(p.width_mm) : null, depth_mm: num(p.depth_mm) > 0 ? num(p.depth_mm) : null,
            length_m: num(p.std_length_m) > 0 ? num(p.std_length_m) : null,
          }
          if (!occ.has(key)) occ.set(key, [])
          occ.get(key).push(row)
        }
      }
    })
  }
  for (const r of noKg) {
    if (occ.has(r.key)) { const k = occ.get(r.key)[0]; reprints.push({ die: r.die, thickness_mm: k.thickness_mm, field: 'kg', kept: k.kg, keptAt: `${k.src} p.${k.page}`, other: 'ไม่ได้พิมพ์', at: `${r.src} p.${r.page}` }); occ.get(r.key).push({ ...k, ...r, kg: k.kg, kgNote: k.kgNote, width_mm: null, depth_mm: null, length_m: null, also: [] }) }
    else excluded.push({ ...r, reason: 'ไม่มี กก./ม.' })
  }
  const names = new Set()
  for (const s of seriesDefs) { if (names.has(s.name)) throw new Error('duplicate series name ' + s.name); names.add(s.name) }

  const profiles = [], links = []
  let assumedLength = 0
  for (const [key, rs] of occ) {
    const keep = rs[0]
    for (const r of rs.slice(1)) for (const f of SAME_FIELDS) if (r[f] !== null && keep[f] !== null && r[f] !== keep[f]) reprints.push({ die: keep.die, thickness_mm: keep.thickness_mm, field: f, kept: keep[f], keptAt: `${keep.src} p.${keep.page}`, other: r[f], at: `${r.src} p.${r.page}` })
    const length = rs.map(r => r.length_m).find(x => x) ?? null
    if (!length) assumedLength++
    profiles.push({ key, die: keep.die, name: keep.name, family: keep.family, thickness_mm: keep.thickness_mm, kg: keep.kg, width_mm: keep.width_mm, depth_mm: keep.depth_mm, default_length_m: length ?? DEFAULT_LENGTH_M, page: keep.page, src: keep.src, also: keep.also })
    if (keep.kgNote) kgDerived.push({ die: keep.die, thickness_mm: keep.thickness_mm, kg: keep.kg, note: keep.kgNote })
    const seen = new Set()
    for (const r of rs) { if (seen.has(r.series)) continue; seen.add(r.series); links.push({ series: r.series, key, family: r.family ?? keep.family }) }
  }
  profiles.sort((a, b) => byStr(a.key, b.key))
  links.sort((a, b) => byStr(a.series, b.series) || byStr(a.key, b.key))
  const series = seriesDefs.filter(s => links.some(l => l.series === s.name))
  const seriesNotCreated = seriesDefs.filter(s => !series.includes(s)).map(s => s.name)
  // a type is linked only when every printed profile of the series was imported (as the MN import does)
  // (a thickness grade skipped while the same die is imported at another thickness does not count as missing)
  const importedDies = new Set(profiles.map(p => p.die))
  const missingIn = (name) => [...new Set(excluded.filter(x => x.series === name && !importedDies.has(x.die)).map(x => x.die))]
  const incomplete = series.filter(s => s.types.length && missingIn(s.name).length).map(s => ({ name: s.name, types: s.types, missing: missingIn(s.name).length }))
  const typeLinks = series.filter(s => !incomplete.some(i => i.name === s.name)).flatMap(s => s.types.map(t => ({ series: s.name, type_name: t })))

  const ambiguous = []
  const pByKey = new Map(profiles.map(p => [p.key, p]))
  for (const s of series) {
    const g = new Map()
    for (const l of links.filter(x => x.series === s.name && x.family)) {
      const p = pByKey.get(l.key), k = `${l.family}|${p.thickness_mm ?? ''}`
      if (!g.has(k)) g.set(k, [])
      g.get(k).push(p.die)
    }
    for (const [k, dies] of g) if (dies.length > 1) { const [family, th] = k.split('|'); ambiguous.push({ series: s.name, family, thickness_mm: th === '' ? null : Number(th), dies: dies.sort(byStr) }) }
  }

  // cut formulas printed in the catalogues or separate cut sheets: report only (the BOM-template step uses them)
  const dies = new Set(profiles.map(p => p.die))
  const cutSheets = []
  for (const f of [...cfg.sources.map(s => s.file), ...(cfg.cutFiles || [])]) {
    for (const s of inputs[f].series || []) for (const a of s.assembly || []) {
      if (!(a.cut_formulas || []).length) continue
      cutSheets.push({
        file: f, series: clean1(s.name), type: clean1(a.type), page: a.page, joints: clean1(a.joints || ''),
        formulas: a.cut_formulas.map(x => ({ die: clean1(x.die_no ?? '').toUpperCase() || null, member: clean1(x.member), printed: clean1(x.formula_as_printed), qty: x.qty_per_unit ?? null, cut: clean1(x.cut || '') })),
      })
    }
  }
  const cutMissingDies = [...new Set(cutSheets.flatMap(c => c.formulas.map(x => x.die)).filter(d => d && !dies.has(d)))].sort(byStr)
  const questions = []
  for (const f of [...cfg.sources.map(s => s.file), ...(cfg.cutFiles || [])]) for (const x of inputs[f].open_questions || []) questions.push(x)
  return {
    cfg, profiles, links, series, seriesNotCreated, typeLinks, incomplete, finishes: cfg.finishes || [], kgRates: kgRatesOf(cfg), excluded, reprints, kgDerived, ambiguous, assumedLength,
    cutSheets, cutMissingDies, questions,
    totals: { rows: cfg.sources.reduce((n, s) => n + inputs[s.file].series.reduce((m, x) => m + (x.profiles || []).length, 0), 0), formulas: cutSheets.reduce((n, c) => n + c.formulas.length, 0) },
  }
}

export function expectedCounts(m) {
  return { providers: 1, series: m.series.length, profiles: m.profiles.length, series_profiles: m.links.length, finishes: m.finishes.length, series_types: m.typeLinks.length, kg_prices: m.kgRates.length }
}

// ---------- SQL ----------

const rows = (list, f) => list.length ? list.map(x => '  (' + f(x).map(q).join(', ') + ')').join(',\n') : null
const insert = (t, list, f) => { const r = rows(list, f); return r ? `INSERT INTO ${t} VALUES\n${r};\n` : `-- (no rows for ${t})\n` }

export function renderSql(m) {
  const { cfg } = m, e = expectedCounts(m), T = cfg.prefix, P = cfg.provider
  return `-- ============================================================
-- ONE-OFF DATA IMPORT — ${P.name} aluminium catalogue(s). GENERATED by scripts/gen-catalogue-import.mjs (${cfg.id}); do not edit by hand.
-- NOT part of the code release. ${cfg.decision}
-- Report: ${cfg.reportFile}.
-- Sources: ${cfg.sources.map(s => `${s.label} (${s.file})`).join('; ')}.
-- Adds under the FacadeX tenant: provider '${P.name}' (short_name ${P.short_name}, price_basis ${P.price_basis});
--   ${e.series} series; ${e.profiles} profiles (drawing_no = die no.; one item per die x wall thickness, owner C4);
--   ${e.series_profiles} series-profile links (family = role); ${e.finishes} finishes; ${e.series_types} series-type links.
-- Price per kg: ${e.kg_prices} finishes get the shop's rate of their colour class (copied from provider '${RATE_PROVIDER}').
-- NOT set: per-piece prices (none printed), profile variants, butt_distance_mm, hardware, cut formulas (listed in the report).
-- default_length_m = the bar length printed, else ${DEFAULT_LENGTH_M} (assumed, ${m.assumedLength} profiles).
-- No profile is "general": every row belongs to this provider only.
-- Guarded: aborts unless the tenant is the one holding provider 'ไฟล์ Aluminium calculation', the 2026-10-12-01 and 2026-10-15-01
--   migrations are applied, every door/window type named below exists, and the final row counts equal the generator's numbers.
-- Idempotent: natural keys (provider+name, provider+die+thickness, series+profile, provider+finish, series+type) are skipped when present.
-- Run: dry run first with ${cfg.dryrun} (COMMIT -> ROLLBACK), then
--   npx supabase db query --project-ref kntspldhvcjeaubtqtkn --linked=false -f <absolute path of this file>
--   (CHANG only. NEVER the retired Tokyo project yyzbgdmgyvvypfcjuhtr.)
-- ============================================================
BEGIN;
SET LOCAL lock_timeout = '5s';

CREATE TEMP TABLE ${T}series (name TEXT PRIMARY KEY, src TEXT NOT NULL) ON COMMIT DROP;
${insert(T + 'series', m.series, s => [s.name, s.src])}
CREATE TEMP TABLE ${T}profiles (pkey TEXT PRIMARY KEY, die TEXT NOT NULL, name TEXT NOT NULL, family TEXT, thickness_mm NUMERIC, kg_per_m NUMERIC NOT NULL, width_mm NUMERIC, depth_mm NUMERIC, length_m NUMERIC NOT NULL, page INT) ON COMMIT DROP;
${insert(T + 'profiles', m.profiles, p => [p.key, p.die, p.name, p.family, p.thickness_mm, p.kg, p.width_mm, p.depth_mm, p.default_length_m, p.page])}
CREATE TEMP TABLE ${T}links (series TEXT NOT NULL, pkey TEXT NOT NULL, family TEXT, PRIMARY KEY (series, pkey)) ON COMMIT DROP;
${insert(T + 'links', m.links, l => [l.series, l.key, l.family])}
CREATE TEMP TABLE ${T}finishes (name TEXT PRIMARY KEY, sort INT NOT NULL) ON COMMIT DROP;
${insert(T + 'finishes', m.finishes.map((f, i) => [f, i + 1]), x => x)}
CREATE TEMP TABLE ${T}kgrates (finish TEXT PRIMARY KEY, rate_class TEXT NOT NULL) ON COMMIT DROP;
${insert(T + 'kgrates', m.kgRates, r => [r.finish, r.rateClass])}
CREATE TEMP TABLE ${T}types (series TEXT NOT NULL, type_name TEXT NOT NULL, PRIMARY KEY (series, type_name)) ON COMMIT DROP;
${insert(T + 'types', m.typeLinks, t => [t.series, t.type_name])}
DO $$
DECLARE
  c_tenant        CONSTANT UUID := '${TENANT_ID}';   -- FacadeX tenant (NOTICE prints its company_name)
  c_provider_name CONSTANT TEXT := ${q(P.name)};
  c_short_name    CONSTANT TEXT := ${q(P.short_name)};
  e_series        CONSTANT INT := ${e.series};
  e_profiles      CONSTANT INT := ${e.profiles};
  e_links         CONSTANT INT := ${e.series_profiles};
  e_finishes      CONSTANT INT := ${e.finishes};
  e_types         CONSTANT INT := ${e.series_types};
  e_kgprices      CONSTANT INT := ${e.kg_prices};
  v_rate_provider UUID;
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
     OR (SELECT count(*) FROM ${T}types) <> e_types OR (SELECT count(*) FROM ${T}kgrates) <> e_kgprices THEN
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
    INSERT INTO alu_providers (tenant_id, name, short_name, price_basis) VALUES (c_tenant, c_provider_name, c_short_name, ${q(P.price_basis)}) RETURNING id INTO v_provider;
    RAISE NOTICE 'provider created: % (%)', c_provider_name, v_provider;
  ELSE
    RAISE NOTICE 'provider exists: % (%), price_basis %', c_provider_name, v_provider, (SELECT price_basis FROM alu_providers WHERE id = v_provider);
  END IF;
  IF EXISTS (SELECT 1 FROM alu_profiles WHERE provider_id = v_provider AND drawing_no IS NOT NULL GROUP BY drawing_no, thickness_mm HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'ABORT: provider % already has two profiles with one die no. and thickness — clean that up first', c_provider_name;
  END IF;

  -- 2. series
  INSERT INTO alu_series (tenant_id, provider_id, name, is_base)
    SELECT c_tenant, v_provider, s.name, false FROM ${T}series s ORDER BY s.name
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series inserted: % of %', v_n, e_series;

  -- 3. profiles (natural key: provider + die + thickness)
  INSERT INTO alu_profiles (tenant_id, provider_id, name, drawing_no, family, thickness_mm, linear_weight_kg_per_m, default_length_m, width_mm, depth_mm)
    SELECT c_tenant, v_provider, t.name, t.die, t.family, t.thickness_mm, t.kg_per_m, t.length_m, t.width_mm, t.depth_mm
      FROM ${T}profiles t
     WHERE NOT EXISTS (SELECT 1 FROM alu_profiles p WHERE p.provider_id = v_provider AND p.drawing_no = t.die AND p.thickness_mm IS NOT DISTINCT FROM t.thickness_mm)
     ORDER BY t.pkey;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'profiles inserted: % of %', v_n, e_profiles;
  CREATE TEMP TABLE ${T}pid ON COMMIT DROP AS
    SELECT t.pkey, (SELECT p.id FROM alu_profiles p WHERE p.provider_id = v_provider AND p.drawing_no = t.die AND p.thickness_mm IS NOT DISTINCT FROM t.thickness_mm
             ORDER BY p.created_at, p.id LIMIT 1) AS profile_id
      FROM ${T}profiles t;
  SELECT count(profile_id) INTO v_n FROM ${T}pid;
  IF v_n <> e_profiles THEN RAISE EXCEPTION 'ABORT: % of % profiles resolved', v_n, e_profiles; END IF;

  -- 4. series <-> profile links
  INSERT INTO alu_series_profiles (tenant_id, series_id, profile_id, family)
    SELECT c_tenant, s.id, m.profile_id, l.family FROM ${T}links l
      JOIN alu_series s ON s.provider_id = v_provider AND s.name = l.series
      JOIN ${T}pid m ON m.pkey = l.pkey
     ORDER BY l.series, l.pkey
    ON CONFLICT (series_id, profile_id) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'series-profile links inserted: % of %', v_n, e_links;

  -- 5. finishes
  INSERT INTO alu_finishes (tenant_id, provider_id, name)
    SELECT c_tenant, v_provider, f.name FROM ${T}finishes f ORDER BY f.sort
    ON CONFLICT (provider_id, name) DO NOTHING;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'finishes inserted: % of %', v_n, e_finishes;

  -- 5b. price per kg: the shop's rate for the colour class (provider ${RATE_PROVIDER}, provider-wide row, latest date)
  SELECT id INTO v_rate_provider FROM alu_providers WHERE tenant_id = c_tenant AND name = ${q(RATE_PROVIDER)};
  CREATE TEMP TABLE ${T}rate ON COMMIT DROP AS
    SELECT r.finish, r.rate_class, k.price_per_kg, k.effective_from
      FROM ${T}kgrates r
      LEFT JOIN alu_finishes rf ON rf.provider_id = v_rate_provider AND rf.name = r.rate_class
      LEFT JOIN LATERAL (SELECT kp.price_per_kg, kp.effective_from FROM alu_kg_prices kp
                          WHERE kp.provider_id = v_rate_provider AND kp.finish_id = rf.id AND kp.series_id IS NULL AND kp.profile_id IS NULL
                          ORDER BY kp.effective_from DESC LIMIT 1) k ON true;
  SELECT string_agg(rate_class, ', ') INTO v_txt FROM ${T}rate WHERE price_per_kg IS NULL;
  IF v_txt IS NOT NULL THEN RAISE EXCEPTION 'ABORT: no per-kg rate on % for colour class %', ${q(RATE_PROVIDER)}, v_txt; END IF;
  INSERT INTO alu_kg_prices (tenant_id, provider_id, finish_id, price_per_kg, effective_from, source)
    SELECT c_tenant, v_provider, f.id, r.price_per_kg, r.effective_from, 'shop rate ' || r.rate_class || ' (owner 2026-10-17)'
      FROM ${T}rate r JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = r.finish
     WHERE NOT EXISTS (SELECT 1 FROM alu_kg_prices k WHERE k.provider_id = v_provider AND k.finish_id = f.id
                         AND k.series_id IS NULL AND k.profile_id IS NULL AND k.effective_from = r.effective_from)
     ORDER BY r.finish;
  GET DIAGNOSTICS v_n = ROW_COUNT; RAISE NOTICE 'kg prices inserted: % of %', v_n, e_kgprices;

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
    JOIN ${T}pid m ON m.pkey = l.pkey JOIN alu_series_profiles sp ON sp.series_id = s.id AND sp.profile_id = m.profile_id;
  IF v_n <> e_links THEN RAISE EXCEPTION 'ABORT: series-profile links present % <> expected %', v_n, e_links; END IF;
  SELECT count(*) INTO v_n FROM ${T}finishes t JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = t.name;
  IF v_n <> e_finishes THEN RAISE EXCEPTION 'ABORT: finishes present % <> expected %', v_n, e_finishes; END IF;
  SELECT count(*) INTO v_n FROM ${T}types t JOIN alu_series s ON s.provider_id = v_provider AND s.name = t.series
    JOIN door_window_types d ON d.tenant_id = c_tenant AND d.name = t.type_name
    JOIN alu_series_types st ON st.series_id = s.id AND st.type_id = d.id;
  IF v_n <> e_types THEN RAISE EXCEPTION 'ABORT: series-type links present % <> expected %', v_n, e_types; END IF;
  SELECT count(*) INTO v_n FROM ${T}rate r JOIN alu_finishes f ON f.provider_id = v_provider AND f.name = r.finish
    JOIN alu_kg_prices k ON k.provider_id = v_provider AND k.finish_id = f.id AND k.series_id IS NULL AND k.profile_id IS NULL
     AND k.effective_from = r.effective_from AND k.price_per_kg = r.price_per_kg;
  IF v_n <> e_kgprices THEN RAISE EXCEPTION 'ABORT: kg prices present (same rate) % <> expected % — an existing row has another price', v_n, e_kgprices; END IF;
  RAISE NOTICE '${cfg.id.toUpperCase()} IMPORT OK: series %, profiles %, links %, finishes %, type links %', e_series, e_profiles, e_links, e_finishes, e_types;
END $$;

-- Dry run: replace COMMIT with ROLLBACK (the wrapper script does that), read the NOTICE / result lines.
COMMIT;
`
}

// ---------- report ----------

const md = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')

export function renderReport(m) {
  const { cfg } = m, e = expectedCounts(m), P = cfg.provider
  const L = [], p = (s = '') => L.push(s)
  p(`# ${P.name} catalogue import report (generated)`)
  p()
  p(`Generated by \`scripts/gen-catalogue-import.mjs\` (config \`${cfg.id}\`) — do not edit by hand. SQL: \`${cfg.sqlFile}\`. Dry run: \`${cfg.dryrun}\`.`)
  p()
  p(`Provider **${P.name}** (short_name \`${P.short_name}\`, price_basis \`${P.price_basis}\`). ${cfg.decision} Price per kg = the shop's rate for the colour class; no per-piece prices, no butt distances. No profile is general.`)
  p()
  p(`Sources: ${cfg.sources.map(s => `${s.label} (\`${s.file}\`)`).join('; ')}.`)
  p()
  for (const n of cfg.notes || []) p(`- ${n}`)
  if ((cfg.notes || []).length) p()
  p('## Row counts (what the SQL guarantees after it runs)')
  p()
  p('| table | rows |')
  p('|---|---|')
  for (const [k, v] of Object.entries(e)) p(`| ${k} | ${v} |`)
  p()
  p(`- Input: ${m.totals.rows} catalogue rows -> ${m.profiles.length} profiles (one per die x thickness; a die printed in several series is linked to each). ${m.assumedLength} profiles have no printed bar length and take ${DEFAULT_LENGTH_M} m (assumed).`)
  p(`- Rows or thicknesses not imported: ${m.excluded.length} (listed below).`)
  if (m.finishes.length) p(`- Finishes: ${m.finishes.join(', ')}.`)
  p()
  p(`## Price per kg (the shop's rate by colour, provider "${RATE_PROVIDER}")`)
  p()
  p('| finish | rate class |')
  p('|---|---|')
  for (const f of m.finishes) { const r = m.kgRates.find(x => x.finish === f); p(`| ${md(f)} | ${r ? md(r.rateClass) : '**ยังไม่กำหนด** (owner question)'} |`) }
  p()
  p('## Series and types')
  p()
  p('| series | profiles | types linked |')
  p('|---|---|---|')
  for (const s of m.series) p(`| ${md(s.name)} | ${m.links.filter(l => l.series === s.name).length} | ${md(m.typeLinks.filter(t => t.series === s.name).map(t => t.type_name).join(', ')) || '-'} |`)
  p()
  if (m.incomplete.length) {
    p('Types NOT linked because some printed profiles of the series are not imported yet:')
    p()
    for (const i of m.incomplete) p(`- ${md(i.name)} -> ${md(i.types.join(', '))} (${i.missing} dies not imported)`)
    p()
  }
  if (m.seriesNotCreated.length) { p(`Series not created (no importable profile): ${m.seriesNotCreated.map(md).join('; ')}.`); p() }
  p('## Not imported')
  p()
  const byReason = new Map()
  for (const x of m.excluded) { const k = x.reason.replace(/\d+(\.\d+)?(-\d+(\.\d+)?)?/g, 'n'); byReason.set(k, (byReason.get(k) || 0) + 1) }
  p('| reason (numbers shown as n) | rows |')
  p('|---|---|')
  for (const [k, v] of [...byReason].sort((a, b) => b[1] - a[1])) p(`| ${md(k)} | ${v} |`)
  p()
  p('<details><summary>every row</summary>')
  p()
  p('| die | name | source | page | reason |')
  p('|---|---|---|---|---|')
  for (const x of m.excluded) p(`| ${md(x.die || '-')} | ${md(x.name)} | ${md(x.src)} | ${x.page ?? ''} | ${md(x.reason)} |`)
  p()
  p('</details>')
  p()
  p('## kg/m worked out from a printed kg-per-bar range (owner C3: midpoint)')
  p()
  if (!m.kgDerived.length) p('None.')
  else {
    p('<details><summary>' + m.kgDerived.length + ' items</summary>')
    p()
    p('| die | thickness | kg/m | how |')
    p('|---|---|---|---|')
    for (const x of m.kgDerived) p(`| ${x.die} | ${x.thickness_mm ?? '-'} | ${x.kg} | ${md(x.note)} |`)
    p()
    p('</details>')
  }
  p()
  p('## One die + thickness printed twice with different values (first printing kept)')
  p()
  p('| die | thickness | field | kept | other |')
  p('|---|---|---|---|---|')
  for (const r of m.reprints) p(`| ${r.die} | ${r.thickness_mm ?? '-'} | ${r.field} | ${md(r.kept)} (${md(r.keptAt)}) | ${md(r.other)} (${md(r.at)}) |`)
  if (!m.reprints.length) p('| - | | none | | |')
  p()
  const also = m.profiles.filter(x => x.also?.length)
  if (also.length) {
    p('## One die, several roles (family = the first role; the others are only listed here)')
    p()
    p('| die | family | also used as |')
    p('|---|---|---|')
    for (const x of also) p(`| ${x.die} | ${md(x.family)} | ${md(x.also.join(', '))} |`)
    p()
  }
  p('## Same family and thickness twice in one series (the estimator has to pick one die)')
  p()
  p(`${m.ambiguous.length} groups.`)
  p()
  p('<details><summary>list</summary>')
  p()
  p('| series | family | thickness mm | dies |')
  p('|---|---|---|---|')
  for (const a of m.ambiguous) p(`| ${md(a.series)} | ${md(a.family)} | ${a.thickness_mm ?? '-'} | ${a.dies.join(', ')} |`)
  p()
  p('</details>')
  p()
  p(`## Cut formulas printed — not imported (${m.cutSheets.length} sheets, ${m.totals.formulas} formulas)`)
  p()
  p('The app has no formula table: these become BOM templates (positions + butt distances) in a later step. W / H = overall frame width / height.')
  p()
  p(`- Dies on the cut sheets that are not imported: ${m.cutMissingDies.join(', ') || 'none'}.`)
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
