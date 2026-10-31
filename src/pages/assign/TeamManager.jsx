// ============================================================
// TeamManager — owner-only modal: create / rename / delete teams and
// manage their members (1 worker = 1 team). Deleting a team removes its
// memberships (cascade) but never touches assignments.
// Props: workers, teams, members, onChanged(), onClose
// ============================================================
import { useState } from 'react'
import { Modal, ConfirmDialog } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import { supabase } from '../../lib/supabase.js'
import { useTenant } from '../../hooks/useTenant.js'
import { moveWorkerPlan } from '../../lib/teamAssign.js'

const nameOf = (w) => w ? (w.nickname || w.name) : '—'

export default function TeamManager({ workers = [], teams = [], members = [], onChanged, onClose }) {
  const { tenant } = useTenant()
  const [newName, setNewName] = useState('')
  const [selectedId, setSelectedId] = useState(null)
  const [renameVal, setRenameVal] = useState('')
  const [pendingMove, setPendingMove] = useState(null) // { workerId, fromTeamId }
  const [confirmDel, setConfirmDel] = useState(null)
  const [busy, setBusy] = useState(false)

  const workerById = new Map(workers.map(w => [w.id, w]))
  const selected = teams.find(t => t.id === selectedId) || null
  const countOf = (teamId) => members.filter(m => m.team_id === teamId).length
  const teamMembers = selected ? members.filter(m => m.team_id === selected.id) : []
  const addable = workers
    .filter(w => w.status !== 'inactive')
    .filter(w => !teamMembers.some(m => m.worker_id === w.id))
    .map(w => ({ value: w.id, label: nameOf(w), keywords: w.name }))

  const run = async (fn) => {
    if (busy) return
    setBusy(true)
    try { await fn(); await onChanged?.() }
    catch (e) { alert('Error: ' + e.message) }
    finally { setBusy(false) }
  }

  const createTeam = () => {
    const name = newName.trim()
    if (!name) return
    if (!tenant?.id) return alert('Error: ไม่พบข้อมูลบริษัท')
    run(async () => {
      const { data, error } = await supabase.from('worker_teams').insert({ name, tenant_id: tenant.id }).select('id').single()
      if (error) throw error
      setNewName('')
      if (data?.id) { setSelectedId(data.id); setRenameVal(name) }
    })
  }

  const selectTeam = (t) => { setSelectedId(t.id); setRenameVal(t.name); setPendingMove(null) }

  const renameTeam = () => {
    const name = renameVal.trim()
    if (!selected || !name || name === selected.name) return
    run(async () => {
      const { error } = await supabase.from('worker_teams').update({ name }).eq('id', selected.id)
      if (error) throw error
    })
  }

  const deleteTeam = () => {
    const id = confirmDel.id
    setConfirmDel(null)
    run(async () => {
      const { error } = await supabase.from('worker_teams').delete().eq('id', id)
      if (error) throw error
      if (selectedId === id) setSelectedId(null)
    })
  }

  const addMember = (workerId) => {
    if (!workerId || !selected) return
    const plan = moveWorkerPlan(workerId, selected.id, members)
    if (plan.action === 'noop') return
    if (plan.action === 'move') { setPendingMove({ workerId, fromTeamId: plan.fromTeamId }); return }
    run(async () => {
      const { error } = await supabase.from('worker_team_members').insert({ worker_id: workerId, team_id: selected.id, tenant_id: tenant.id })
      if (error) throw error
    })
  }

  const confirmMove = () => {
    const { workerId } = pendingMove
    setPendingMove(null)
    run(async () => {
      const { error } = await supabase.from('worker_team_members')
        .upsert({ worker_id: workerId, team_id: selected.id, tenant_id: tenant.id }, { onConflict: 'worker_id' })
      if (error) throw error
    })
  }

  const removeMember = (workerId) => run(async () => {
    const { error } = await supabase.from('worker_team_members').delete().eq('worker_id', workerId)
    if (error) throw error
  })

  return (
    <Modal title="จัดการทีม" onClose={onClose} maxWidth={520}>
      <div className="modal-body">
        <label className="label">สร้างทีมใหม่</label>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          <input value={newName} onChange={e => setNewName(e.target.value)} placeholder="ชื่อทีม"
            onKeyDown={e => { if (e.key === 'Enter') createTeam() }} style={{ flex: 1 }} />
          <button className="btn btn-sm" onClick={createTeam} disabled={busy || !newName.trim()}>+ สร้างทีม</button>
        </div>

        {teams.length === 0 && <div style={{ color: 'var(--text2)' }}>ยังไม่มีทีม</div>}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 14 }}>
          {teams.map(t => (
            <button key={t.id} className={`btn btn-sm ${t.id === selectedId ? '' : 'btn-ghost'}`} onClick={() => selectTeam(t)}>
              {t.name} ({countOf(t.id)})
            </button>
          ))}
        </div>

        {selected && (
          <div className="card" style={{ padding: 12 }}>
            <label className="label">ชื่อทีม</label>
            <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
              <input value={renameVal} onChange={e => setRenameVal(e.target.value)} style={{ flex: 1 }} />
              <button className="btn btn-ghost btn-sm" onClick={renameTeam} disabled={busy || !renameVal.trim() || renameVal.trim() === selected.name}>เปลี่ยนชื่อ</button>
              <button className="btn btn-ghost btn-sm" onClick={() => setConfirmDel(selected)} disabled={busy}>ลบทีม</button>
            </div>

            <label className="label">สมาชิก ({teamMembers.length})</label>
            {teamMembers.length === 0 && <div style={{ color: 'var(--text2)', marginBottom: 8 }}>ยังไม่มีสมาชิก</div>}
            {teamMembers.map(m => (
              <div key={m.worker_id} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
                <span>{nameOf(workerById.get(m.worker_id))}</span>
                <button className="btn btn-ghost btn-sm" onClick={() => removeMember(m.worker_id)} disabled={busy}>เอาออก</button>
              </div>
            ))}

            <label className="label" style={{ marginTop: 10 }}>เพิ่มสมาชิก</label>
            <SearchableSelect value="" onChange={addMember} options={addable} placeholder="— เลือกคนงาน —" disabled={busy} />

            {pendingMove && (
              <div style={{ marginTop: 10, padding: 10, border: '1px solid var(--border)', borderRadius: 6 }}>
                <div style={{ marginBottom: 8 }}>
                  {nameOf(workerById.get(pendingMove.workerId))} อยู่ทีม {teams.find(t => t.id === pendingMove.fromTeamId)?.name || '—'} แล้ว ย้ายมาทีมนี้ไหม?
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button className="btn btn-sm" onClick={confirmMove} disabled={busy}>ย้ายมาทีมนี้</button>
                  <button className="btn btn-ghost btn-sm" onClick={() => setPendingMove(null)}>ไม่ย้าย</button>
                </div>
              </div>
            )}
          </div>
        )}
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ปิด</button>
      </div>
      {confirmDel && (
        <ConfirmDialog danger title="ลบทีม"
          message={`ลบทีม "${confirmDel.name}" ? สมาชิกจะถูกเอาออกจากทีม แต่การจัดงานที่มีอยู่จะไม่ถูกลบ`}
          onConfirm={deleteTeam} onCancel={() => setConfirmDel(null)} />
      )}
    </Modal>
  )
}
