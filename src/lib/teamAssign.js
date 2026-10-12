// Pure helpers for the teams feature (spec 2026-10-12). 1 worker = 1 team.
export function expandTeamSelection(teamIds, members, activeWorkerIds) {
  const wanted = new Set(teamIds)
  const out = []
  const seen = new Set()
  for (const m of members) {
    if (!wanted.has(m.team_id) || seen.has(m.worker_id) || !activeWorkerIds.has(m.worker_id)) continue
    seen.add(m.worker_id)
    out.push(m.worker_id)
  }
  return out
}

export function moveWorkerPlan(workerId, toTeamId, members) {
  const cur = members.find(m => m.worker_id === workerId)
  if (!cur) return { action: 'add', fromTeamId: null }
  if (cur.team_id === toTeamId) return { action: 'noop', fromTeamId: cur.team_id }
  return { action: 'move', fromTeamId: cur.team_id }
}
