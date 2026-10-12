import { describe, it, expect } from 'vitest'
import { expandTeamSelection, moveWorkerPlan, applyTeamToSelection } from './teamAssign.js'

const members = [
  { worker_id: 'w1', team_id: 'A' }, { worker_id: 'w2', team_id: 'A' },
  { worker_id: 'w3', team_id: 'B' }, { worker_id: 'w4', team_id: 'B' },
]
const active = new Set(['w1', 'w2', 'w3'])

describe('expandTeamSelection', () => {
  it('returns members of the chosen teams, skipping inactive/hidden workers', () => {
    expect(expandTeamSelection(['A', 'B'], members, active)).toEqual(['w1', 'w2', 'w3'])
  })
  it('returns [] for an empty or unknown team', () => {
    expect(expandTeamSelection(['Z'], members, active)).toEqual([])
    expect(expandTeamSelection([], members, active)).toEqual([])
  })
  it('never duplicates a worker', () => {
    const dup = [...members, { worker_id: 'w1', team_id: 'B' }]
    expect(expandTeamSelection(['A', 'B'], dup, active)).toEqual(['w1', 'w2', 'w3'])
  })
})

describe('moveWorkerPlan', () => {
  it('adds a worker with no team', () => {
    expect(moveWorkerPlan('w9', 'A', members)).toEqual({ action: 'add', fromTeamId: null })
  })
  it('moves a worker from another team', () => {
    expect(moveWorkerPlan('w3', 'A', members)).toEqual({ action: 'move', fromTeamId: 'B' })
  })
  it('is a noop when already in that team', () => {
    expect(moveWorkerPlan('w1', 'A', members)).toEqual({ action: 'noop', fromTeamId: 'A' })
  })
})

describe('applyTeamToSelection', () => {
  it('adds missing workers as am+pm and keeps existing choices', () => {
    const sel = { w1: { am: true, pm: false } }
    expect(applyTeamToSelection(sel, ['w1', 'w2'])).toEqual({
      w1: { am: true, pm: false }, w2: { am: true, pm: true },
    })
  })
  it('does not mutate its input and handles an empty list', () => {
    const sel = { w1: { am: true, pm: true } }
    applyTeamToSelection(sel, [])
    expect(sel).toEqual({ w1: { am: true, pm: true } })
  })
})
