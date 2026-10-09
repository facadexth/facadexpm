// src/lib/projectBom.js
// The whole-project BOM: every item's computed BOM (x its quantity) rolled up into
//   1) aluminium by profile + colour: cut list, bars to buy at the stock length, offcuts
//   2) hardware / accessories: merged by part
//   3) sealant: one total length rounded up to tubes
// Pure. `entries` come from the caller, one per item: { opening_no, quantity, finish_id, bom, addonBom, extras }
// where bom / addonBom are computeBomForOpening results (profile lines carry profile_id and cut_style) and
// extras is openingExtras()'s result.
import { packBars, summarizePacking } from './cutOptimizer.js'
import { sealantTubes } from './openingExtras.js'

const mm = n => Math.round(Number(n) * 1000) / 1000   // cuts are merged at 1 mm

// Stock length: the owner's per-profile override > the project's > the tenant default (6.4 m unless changed).
export function stockLengthFor(profileId, stock, settings) {
  const p = stock && stock.byProfile ? Number(stock.byProfile[profileId]) : NaN
  if (p > 0) return p
  const pr = stock ? Number(stock.projectM) : NaN
  if (pr > 0) return pr
  return settings.stock_length_m
}

const bomsOf = e => [e.bom, e.addonBom].filter(Boolean)

// Stock lengths that apply to ONE project: the per-profile rows of that project and its own default length.
export function stockForProject(rows, projectId, project) {
  const byProfile = {}
  for (const r of rows || []) if (r.project_id === projectId) byProfile[r.profile_id] = Number(r.length_m)
  const pm = Number(project && project.stock_length_m)
  return { byProfile, projectM: pm > 0 ? pm : null }
}

// costOpening().unresolved entries that never show up as an unresolved profile line
const surfaced = u => u.source === 'joint' || u.reason === 'no_dimension' || u.reason === 'unknown_infill' || u.reason === 'unknown_addon_template'

export function buildProjectBom({ entries, settings, stock, profilesById, finishesById, partsById }) {
  const groups = new Map()
  const unresolved = []
  const hardware = new Map()
  let sealant_m = 0

  for (const e of entries || []) {
    const q = Number(e.quantity) > 0 ? Number(e.quantity) : 1
    const costProblems = (e.unresolved || []).filter(surfaced)
    for (const bom of bomsOf(e)) {
      for (const line of [...bom.profileLines, ...bom.gridLines]) {
        if (!line.resolved || !line.profile_id) { unresolved.push({ opening_no: e.opening_no, name: line.role_name, reason: line.reason || 'no_profile' }); continue }
        const key = `${line.profile_id}|${e.finish_id || ''}`
        const g = groups.get(key) || { key, profile_id: line.profile_id, finish_id: e.finish_id || null, cutMap: new Map(), openings: new Set() }
        const style = line.cut_style || 'square'
        const ck = `${mm(line.length_m)}|${style}`
        const prev = g.cutMap.get(ck) || { length_m: mm(line.length_m), style, quantity: 0 }
        prev.quantity += line.quantity * q
        g.cutMap.set(ck, prev)
        g.openings.add(e.opening_no)
        groups.set(key, g)
      }
      for (const l of bom.hardwareLines) {
        const kind = l.part_id && partsById && partsById[l.part_id] && partsById[l.part_id].kind === 'accessory' ? 'accessory' : 'hardware'
        addPart(hardware, l.part_id || l.name, l.name, null, l.quantity * q, l.cost * q, !l.unresolved, kind)
      }
      for (const l of bom.hardwareSetLines || []) addPart(hardware, l.code || l.name, l.name, l.code, l.quantity * q, l.cost * q, l.resolved, 'hardware')
    }
    for (const u of costProblems) unresolved.push({ opening_no: e.opening_no, name: u.name, reason: u.reason })
    if (e.extras) {
      for (const l of e.extras.lines) addPart(hardware, `extra:${l.key}:${l.part_id}`, l.name, null, l.quantity * q, l.cost * q, l.resolved, 'accessory')
      sealant_m += e.extras.sealant_m * q
    }
  }

  const profiles = [...groups.values()].map(g => {
    const cuts = [...g.cutMap.values()].sort((a, b) => b.length_m - a.length_m)
    const profile = (profilesById || {})[g.profile_id]
    const finish = (finishesById || {})[g.finish_id]
    const stock_length_m = stockLengthFor(g.profile_id, stock, settings)
    const packed = packBars(cuts, stock_length_m, settings)
    return {
      key: g.key, profile_id: g.profile_id, finish_id: g.finish_id,
      name: profile ? profile.name : '?', die_no: profile ? profile.drawing_no || null : null, finish_name: finish ? finish.name : null,
      cuts, cut_total_m: cuts.reduce((s, c) => s + c.length_m * c.quantity, 0), openings: [...g.openings],
      stock_length_m, bars: packed.bars, ...summarizePacking(packed, stock_length_m, settings.min_keep_offcut_m),
    }
  }).sort((a, b) => String(a.name).localeCompare(String(b.name), 'th'))

  return {
    profiles,
    parts: [...hardware.values()].sort((a, b) => a.kind.localeCompare(b.kind) || String(a.name).localeCompare(String(b.name), 'th')),
    sealant: { length_m: sealant_m, tubes: sealantTubes(sealant_m, settings.sealant_m_per_tube), m_per_tube: settings.sealant_m_per_tube },
    unresolved,
  }
}

function addPart(map, key, name, code, quantity, cost, resolved, kind) {
  const p = map.get(key) || { key, name, code: code || null, kind, quantity: 0, cost: 0, resolved: true }
  p.quantity += quantity
  p.cost += cost
  p.resolved = p.resolved && resolved
  map.set(key, p)
}
