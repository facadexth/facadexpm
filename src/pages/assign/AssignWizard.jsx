// ============================================================
// AssignWizard — single-panel: days → type → site → workers(+shift)
// onSubmit(rows, taskIds) with rows = { worker_id, date, shift, site_id,
// type, is_team_leader }, taskIds = phase_tasks.id[] the crew is linked
// to (see step 4.5 below)
// ============================================================
import { useMemo, useEffect, useState } from 'react'
import { Modal } from '../../components/Modal.jsx'
import SearchableSelect from '../../components/SearchableSelect.jsx'
import MultiDayPicker from './MultiDayPicker.jsx'
import { useDraftForm } from '../../hooks/useDraftForm.js'
import { supabase } from '../../lib/supabase.js'
import { SITE_TYPES } from './constants.js'
import teamLeaderBadge from '../../assets/team-leader-badge.png'

const EMPTY_FORM = { days: [], type: 'site', siteId: '', sel: {}, notes: '', leaderShift: {}, taskIds: [] }

export default function AssignWizard({ workers = [], sites = [], initialSiteId = '', onSubmit, onClose, saving }) {
  // days persists as a plain array (localStorage-safe) and is only a Set
  // at the edges, where MultiDayPicker requires one.
  const [form, setForm, clearFormDraft] = useDraftForm('assign-wizard', { ...EMPTY_FORM, siteId: initialSiteId })
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  const days = useMemo(() => new Set(form.days), [form.days])
  const setDays = (nextSet) => set('days', Array.from(nextSet))

  const toggleWorker = (id) => setForm(f => {
    const n = { ...f.sel }
    if (n[id]) delete n[id]
    else n[id] = { am: true, pm: true }
    // Un-assigning a worker also drops any leader tick they held.
    const leaderShift = { ...f.leaderShift }
    if (leaderShift.am === id) delete leaderShift.am
    if (leaderShift.pm === id) delete leaderShift.pm
    return { ...f, sel: n, leaderShift }
  })
  const toggleShift = (id, k) => setForm(f => {
    if (!f.sel[id]) return f
    const turningOff = f.sel[id][k]
    const leaderShift = { ...f.leaderShift }
    if (turningOff && leaderShift[k] === id) delete leaderShift[k] // leader's own shift got turned off
    return { ...f, sel: { ...f.sel, [id]: { ...f.sel[id], [k]: !f.sel[id][k] } }, leaderShift }
  })
  // 🅒 team leader -- radio-style per shift key (am/pm): ticking one
  // worker for a shift silently un-ticks whoever held it before. Applies
  // to every day selected in this submission (confirmed with the user --
  // one leader per shift for the whole batch, not per individual day).
  const toggleLeader = (id, k) => setForm(f => ({
    ...f, leaderShift: { ...f.leaderShift, [k]: f.leaderShift[k] === id ? undefined : id },
  }))

  const selCount = Object.keys(form.sel).length
  const needsSite = SITE_TYPES.includes(form.type)

  // 4.5 · in-progress Kanban cards at the selected site, offered as an
  // optional link -- the crew being assigned here can be attached to
  // whichever task(s) they're actually working on today. Empty list ->
  // step doesn't render at all (nothing to pick).
  const [inProgressTasks, setInProgressTasks] = useState([])
  useEffect(() => {
    let cancelled = false
    if (!needsSite || !form.siteId) { setInProgressTasks([]); return }
    supabase.from('phase_tasks').select('id, name').eq('site_id', form.siteId).eq('status', 'in_progress').order('sort_order')
      .then(({ data }) => { if (!cancelled) setInProgressTasks(data || []) })
    return () => { cancelled = true }
  }, [form.siteId, needsSite])
  const toggleTask = (id) => setForm(f => ({
    ...f, taskIds: f.taskIds.includes(id) ? f.taskIds.filter(t => t !== id) : [...f.taskIds, id],
  }))

  const submit = () => {
    if (!days.size)          return alert('เลือกวันอย่างน้อย 1 วัน')
    if (needsSite && !form.siteId) return alert('เลือกไซท์งาน')
    if (!selCount)           return alert('เลือกช่างอย่างน้อย 1 คน')
    const siteId = needsSite ? form.siteId : null
    const rows = []
    for (const date of days) {
      for (const [worker_id, sh] of Object.entries(form.sel)) {
        if (sh.am) rows.push({ worker_id, date, shift: 'morning', site_id: siteId, type: form.type, notes: form.notes || null, is_team_leader: form.leaderShift.am === worker_id })
        if (sh.pm) rows.push({ worker_id, date, shift: 'evening', site_id: siteId, type: form.type, notes: form.notes || null, is_team_leader: form.leaderShift.pm === worker_id })
      }
    }
    if (!rows.length) return alert('ทุกช่างถูกปิดกะทั้งเช้าและบ่าย')
    const taskIds = needsSite ? form.taskIds : []
    clearFormDraft()
    onSubmit(rows, taskIds)
  }

  return (
    <Modal title="Assign งาน" onClose={onClose} maxWidth={620}>
      <div className="modal-body" style={{ display: 'grid', gap: 16 }}>
        {/* 1. days */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>1 · เลือกวันทำงาน</div>
          <MultiDayPicker value={days} onChange={setDays} />
        </div>

        {/* 2. type */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>2 · ประเภทงาน</div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            {[
              { k: 'site', l: '🏗️ งานไซท์' },
              { k: 'factory', l: '🏭 ผลิตที่โรงงาน' },
              { k: 'office', l: '🏢 ออฟฟิศ' },
              { k: 'leave_sick', l: '🤒 ลาป่วย' },
              { k: 'leave_personal', l: '🏖️ ลากิจ' },
            ].map(o => (
              <button key={o.k} type="button" onClick={() => set('type', o.k)}
                className={`btn btn-sm ${form.type === o.k ? 'btn-primary' : 'btn-ghost'}`} style={{ flex: '1 1 45%' }}>{o.l}</button>
            ))}
          </div>
          {form.type === 'factory' && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>ผลิตที่โรงงานให้ไซท์นี้ — ลงค่าแรงให้ไซท์ แต่ไม่มีค่าเดินทาง</div>}
        </div>

        {/* 3. site (leave types don't need one) */}
        {SITE_TYPES.includes(form.type) && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>3 · ไซท์งาน</div>
            <SearchableSelect
              value={form.siteId} onChange={id => set('siteId', id)} placeholder="— เลือกไซท์ —"
              options={sites.map(s => ({ value: s.id, label: `${s.site_number} · ${s.name}`, keywords: `${s.site_number} ${s.name}` }))}
            />
          </div>
        )}

        {/* 4. workers */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{SITE_TYPES.includes(form.type) ? '4' : '3'} · ช่าง (เลือกหลายคน · ค่าเริ่มต้นเช้า+บ่าย)</div>
          <div style={{ maxHeight: 220, overflowY: 'auto', display: 'grid', gap: 4 }}>
            {(workers || []).map(w => {
              const on = !!form.sel[w.id]
              return (
                <div key={w.id} style={{
                  display: 'flex', alignItems: 'center', gap: 8, padding: '6px 10px', borderRadius: 6,
                  background: on ? 'rgba(108,99,255,.15)' : 'rgba(255,255,255,.04)',
                  border: on ? '1px solid var(--accent)' : '1px solid transparent',
                }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', flex: 1 }}>
                    <input type="checkbox" checked={on} onChange={() => toggleWorker(w.id)} style={{ width: 16, height: 16 }} />
                    <span style={{ fontSize: 13 }}>{w.name}{w.nickname ? ` (${w.nickname})` : ''}</span>
                  </label>
                  {on && (
                    <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                      {[{ k: 'am', l: 'เช้า' }, { k: 'pm', l: 'บ่าย' }].map(s => (
                        <div key={s.k} style={{ display: 'flex', alignItems: 'center', gap: 2 }}>
                          <button type="button" onClick={() => toggleShift(w.id, s.k)}
                            className={`btn btn-sm ${form.sel[w.id][s.k] ? 'btn-primary' : 'btn-ghost'}`}
                            style={{ fontSize: 11, padding: '2px 8px' }}>{s.l}</button>
                          {needsSite && form.sel[w.id][s.k] && (
                            <button type="button" onClick={() => toggleLeader(w.id, s.k)}
                              title={form.leaderShift[s.k] === w.id ? `หัวหน้าทีมกะ${s.l} — คลิกเพื่อยกเลิก` : `ตั้งเป็นหัวหน้าทีมกะ${s.l}`}
                              style={{
                                width: 22, height: 22, padding: 1, borderRadius: 5, cursor: 'pointer',
                                border: form.leaderShift[s.k] === w.id ? '2px solid var(--yellow)' : '1px solid var(--border)',
                                background: form.leaderShift[s.k] === w.id ? 'rgba(255,193,7,.18)' : 'transparent',
                                opacity: form.leaderShift[s.k] === w.id ? 1 : 0.4,
                              }}>
                              <img src={teamLeaderBadge} alt="หัวหน้าทีม" style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              )
            })}
            {!(workers || []).length && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ยังไม่มีช่าง</div>}
          </div>
          {needsSite && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 4 }}>คลิกไอคอนหมวก 🪖 ข้างกะเพื่อตั้งหัวหน้าทีม (ได้ 1 คนต่อกะ)</div>}
        </div>

        {/* งานที่กำลังทำ (ถ้ามี) -- ผูกลูกทีมที่ assign ครั้งนี้เข้ากับการ์ด
            Kanban ที่กำลังทำอยู่ที่ไซท์นี้ ไม่บังคับเลือก และไม่โชว์เลยถ้า
            ไซท์นี้ไม่มีการ์ดที่ "กำลังทำ" ตอนนี้ */}
        {needsSite && inProgressTasks.length > 0 && (
          <div>
            <div className="label" style={{ marginBottom: 6 }}>🔧 งานที่กำลังทำ (ถ้ามี — เลือกได้หลายงาน ไม่บังคับ)</div>
            <div style={{ display: 'grid', gap: 4 }}>
              {inProgressTasks.map(t => (
                <label key={t.id} style={{ display: 'flex', alignItems: 'center', gap: 8, cursor: 'pointer', fontSize: 13, padding: '4px 6px' }}>
                  <input type="checkbox" checked={form.taskIds.includes(t.id)} onChange={() => toggleTask(t.id)} style={{ width: 16, height: 16 }} />
                  {t.name}
                </label>
              ))}
            </div>
          </div>
        )}

        {/* 5. notes */}
        <div>
          <div className="label" style={{ marginBottom: 6 }}>{SITE_TYPES.includes(form.type) ? '5' : '4'} · รายละเอียดเพิ่มเติม (ถ้ามี — ใช้ร่วมกันทุกวัน/ทุกคนที่เลือก)</div>
          <textarea className="textarea" rows={2} value={form.notes} onChange={e => set('notes', e.target.value)} placeholder="เช่น เอาบันไดมาด้วย" />
        </div>
      </div>
      <div className="modal-footer">
        <button className="btn btn-ghost" onClick={onClose}>ยกเลิก</button>
        <button className="btn btn-primary" onClick={submit} disabled={saving}>
          {saving ? '⏳ กำลังบันทึก...' : `✅ Assign (${days.size} วัน × ${selCount} ช่าง)`}
        </button>
      </div>
    </Modal>
  )
}
