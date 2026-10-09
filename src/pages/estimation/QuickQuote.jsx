// src/pages/estimation/QuickQuote.jsx
// "ลองคิดราคา": a calculator popup. Picks template / series / colour / thickness / size and shows the cost of one
// set. WRITES NOTHING: no Supabase import at all, the item is a throw-away object (quickQuote.js).
import { useState, useMemo } from 'react'
import { Modal } from '../../components/Modal.jsx'
import { unresolvedText } from '../../lib/reasonText.js'
import { Field, Options } from './ItemFields.jsx'
import {
  emptyQuick, quickTemplateGroups, quickSeriesOptions, quickFinishOptions, quickThicknessOptions,
  reconcileQuick, quickView, quickOk, quickMoney,
} from './quickQuote.js'

function Result({ r }) {
  const unresolved = r.cost ? r.cost.unresolved || [] : []
  const ok = quickOk(r.cost)
  return (
    <div className="card" style={{ padding: 10, display: 'grid', gap: 3, background: 'var(--bg2)' }}>
      <div style={{ fontSize: 12, color: 'var(--text3)' }}>{r.label} (ณ {r.asOf})</div>
      <div style={{ fontWeight: 700, fontSize: 16 }}>{ok ? `฿${quickMoney(r.cost.total)} ต่อชุด` : 'ราคายังไม่ครบ'}</div>
      {!r.cost && <div style={{ fontSize: 12, color: 'var(--red)' }}>คิดราคาไม่ได้</div>}
      {unresolved.map((u, i) => <div key={i} style={{ fontSize: 12, color: 'var(--red)' }}>• {u.name || '?'}{u.source === 'addon' ? ' (ของเพิ่มเติม)' : ''}: {unresolvedText(u)}</div>)}
    </div>
  )
}

export default function QuickQuote({ project, ctx, templates, seriesTypes, today, onClose }) {
  const { index, templatesById } = ctx
  const [q, setQ] = useState(emptyQuick)
  const template = templatesById[q.template_id] || null
  const groups = useMemo(() => quickTemplateGroups(index, (templates || []).filter(t => t.active !== false)), [index, templates])
  const set = patch => setQ(prev => {
    const next = { ...prev, ...patch }
    return reconcileQuick(prev, next, { index, template: templatesById[next.template_id] || null })
  })
  const v = useMemo(() => quickView({ q, template, project, ctx, today, seriesTypes }), [q, template, project, ctx, today, seriesTypes])
  const { showSash, missing, results } = v
  const input = (k, label, extra) => (
    <Field label={label}><input className="input" type="number" min="0" step="1" value={q[k]} onChange={e => set({ [k]: e.target.value })} {...extra} /></Field>
  )
  return (
    <Modal title="ลองคิดราคา" onClose={onClose} maxWidth={560}>
      <div className="modal-body" style={{ display: 'grid', gap: 10 }}>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>คิดราคาต่อ 1 ชุดเท่านั้น ไม่บันทึกอะไรลงโปรเจกต์ ชุดอุปกรณ์ วัสดุอุดช่อง ค่าแรง และกำไร ใช้ค่าของโปรเจกต์นี้</div>
        <Field label="เทมเพลต ★">
          <select className="input" value={q.template_id} onChange={e => set({ template_id: e.target.value })}>
            <option value="">— เลือก —</option>
            {groups.map(g => <optgroup key={g.label} label={g.label}><Options list={g.options} /></optgroup>)}
          </select>
        </Field>
        <Field label="ซีรีส์ ★">
          <select className="input" value={q.series_id} onChange={e => set({ series_id: e.target.value })}>
            <option value="">— เลือก —</option>
            <Options list={quickSeriesOptions(index)} />
          </select>
        </Field>
        <Field label="สี ★">
          <select className="input" disabled={!q.series_id} value={q.alu_finish_id} onChange={e => set({ alu_finish_id: e.target.value })}>
            <option value="">— เลือก —</option>
            <Options list={quickFinishOptions(index, q.series_id)} />
          </select>
        </Field>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 10 }}>
          <Field label="ความหนา วงกบ (มม.) ★">
            <select className="input" disabled={!q.series_id} value={q.thickness_mm} onChange={e => set({ thickness_mm: e.target.value })}>
              <option value="">— เลือก —</option>
              <Options list={quickThicknessOptions(index, q.series_id)} />
            </select>
          </Field>
          {showSash && (
            <Field label="ความหนากรอบบาน (มม.) ★">
              <select className="input" value={q.sash_thickness_mm} onChange={e => set({ sash_thickness_mm: e.target.value })}>
                {!q.sash_thickness_mm && <option value="">— เลือก —</option>}
                <Options list={quickThicknessOptions(index, q.series_id)} />
              </select>
            </Field>
          )}
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(110px, 1fr))', gap: 10 }}>
          {input('width_m', 'กว้าง (มม.) ★')}
          {input('height_m', 'สูง (มม.) ★')}
          {input('panel_count', 'จำนวนช่อง (บาน)', { min: '1' })}
        </div>
        {v.availability === 'not_offered' && (
          <div style={{ fontSize: 13, color: 'var(--red)' }}>⚠ ซีรีส์นี้ไม่ผลิตประเภทนี้{v.offeredBy.length ? ` · ซีรีส์ที่ผลิต: ${v.offeredBy.join(', ')}` : ' · ยังไม่มีซีรีส์ที่ผลิตประเภทนี้'}</div>
        )}
        {v.hardware && <div style={{ fontSize: 12, color: 'var(--text3)' }}>ชุดอุปกรณ์: {v.hardware.label}{v.hardware.hint ? ` · ${v.hardware.hint}` : ''}</div>}
        {v.hardwareWarning && <div style={{ fontSize: 12, color: 'var(--red)' }}>⚠ {v.hardwareWarning}</div>}
        {missing && <div style={{ fontSize: 13, color: 'var(--text3)' }}>{missing} เพื่อดูราคา</div>}
        {results.map(r => <Result key={r.key} r={r} />)}
      </div>
      <div className="modal-footer"><button className="btn btn-ghost" onClick={onClose}>ปิด</button></div>
    </Modal>
  )
}
