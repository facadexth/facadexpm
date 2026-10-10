// src/pages/bomTemplates/PartEditor.jsx
// BOM template part editor (tab "ส่วนประกอบและอุปกรณ์" of a template with layout_kind). Layout, wording and behaviour
// follow the owner-approved mockup v24 (docs/superpowers/mockups/2026-10-10-bom-part-editor-mockup.html): preview card
// (test size, outside/inside, overview + zoom) left, "แก้ชิ้นที่เลือก" panel right, components table below; the
// selection is shared by the three. Test size / view / series / thickness are UI-only and never saved (Ruling PE-3).
import { useState } from 'react'
import { clampSelection, setEndMode } from '../../lib/partModel.js'
import { catalogFamilies } from './helpers.js'
import { editorView, testOptions, posName, partOfKey } from './partEditorView.js'
import NumInput from './NumInput.jsx'
import PartPreview from './PartPreview.jsx'
import PartSidePanel from './PartSidePanel.jsx'
import PartTable from './PartTable.jsx'
import './partEditor.css'

const CORNER_WHY = { both_through: 'วิ่งสุดทั้งสองชิ้น', both_butt: 'วิ่งชนทั้งสองชิ้น' }

export default function PartEditor({ model, onChange, index, canEdit, testSeriesId, testThicknessMm, onTestChange, templateName, initialSelection }) {
  const [size, setSize] = useState({ w: 1800, h: 1200 })
  const [view, setView] = useState('out')
  const [rawSel, setSel] = useState(initialSelection || { key: 'frame_bottom', line: 0 })   // mockup starts on เฟรมล่าง
  const sel = clampSelection(model, rawSel)
  const families = catalogFamilies(index)
  const data = editorView({ model, index, seriesId: testSeriesId, thicknessMm: testThicknessMm, widthMm: size.w, heightMm: size.h })
  const { series, thicknesses } = testOptions(index, testSeriesId)
  const pk = partOfKey(model, sel.key)
  const partKeys = data.parts.find(p => p.key === pk)?.keys || []
  const pick = (key) => setSel({ key, line: 0 })
  const edit = (m) => { if (canEdit) onChange(m) }

  return (
    <div className="pe">
      {data.corners.length > 0 && (
        <div className="note" role="alert">
          <b>มุมที่สองชิ้นมาพบกันต้องมีชิ้นหนึ่งวิ่งสุด อีกชิ้นวิ่งชน</b> (บันทึกไม่ได้จนกว่าจะแก้):{' '}
          {data.corners.map(c => `${posName(model, c.key)} ชิ้นที่ ${c.piece + 1} ปลายที่ ${c.end + 1} ${CORNER_WHY[c.reason] || ''}`).join(' · ')}
        </div>
      )}
      <div className="top">
        <section className="card2">
          <h2>{templateName ? `Template: ${templateName} · ` : ''}ภาพตัวอย่าง</h2>
          <div className="bar">
            <label>กว้าง (มม.) <NumInput min={300} step={50} value={size.w} onChange={v => setSize(s => ({ ...s, w: v ?? 0 }))} /></label>
            <label>สูง (มม.) <NumInput min={300} step={50} value={size.h} onChange={v => setSize(s => ({ ...s, h: v ?? 0 }))} /></label>
            <span className="seg" role="group" aria-label="มุมมอง">
              <button type="button" aria-pressed={view === 'out'} onClick={() => setView('out')}>ด้านนอก</button>
              <button type="button" aria-pressed={view === 'in'} onClick={() => setView('in')}>ด้านใน</button>
            </span>
          </div>
          <div className="bar">
            <label>ซีรีส์ที่ใช้ทดสอบ{' '}
              <select value={testSeriesId || ''} onChange={e => onTestChange({ seriesId: e.target.value, thicknessMm: null })}>
                <option value="">— เลือกซีรีส์ —</option>
                {series.map(s => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select>
            </label>
            <label>ความหนาที่ใช้ทดสอบ{' '}
              <select value={testThicknessMm ?? ''} onChange={e => onTestChange({ seriesId: testSeriesId, thicknessMm: e.target.value === '' ? null : Number(e.target.value) })}>
                <option value="">—</option>
                {thicknesses.map(t => <option key={t} value={t}>{t} มม.</option>)}
              </select>
            </label>
          </div>
          <PartPreview model={model} sel={sel} partKeys={partKeys} view={view} widthMm={size.w} heightMm={size.h}
            widthOf={data.widthOf} buttOf={data.buttOf} canEdit={canEdit} onPick={pick}
            onToggle={(key, piece, end, mode) => edit(setEndModeAt(model, key, sel.line, piece, end, mode))} />
        </section>
        <section className="card2" aria-live="polite">
          <h2>แก้ชิ้นที่เลือก</h2>
          {sel.key
            ? <PartSidePanel model={model} view={data} sel={sel} families={families} canEdit={canEdit} onChange={edit} onSelect={setSel} />
            : <div className="empty">คลิกชิ้นในภาพ หรือคลิกแถวในตาราง</div>}
        </section>
      </div>
      <section className="card2">
        <h2>ส่วนประกอบ (แต่ละตำแหน่งมีได้หลายโปรไฟล์)</h2>
        <PartTable model={model} view={data} sel={sel} onSelect={setSel} />
        <p className="hint" style={{ marginTop: 10 }}><span className="tag">ข้อจำกัด</span> ความยาวที่คิดในหน้านี้เป็นระยะรวมต่อชุดตามสูตร ไม่ใช่การจัดตัดทั้งโปรเจกต์ · ขนาด ซีรีส์ และความหนาด้านบนใช้ทดสอบเท่านั้น ไม่ถูกบันทึก</p>
      </section>
    </div>
  )
}

// Marker toggle on the line whose ends the zoom shows (the selected line, mockup toggle()).
function setEndModeAt(model, key, line, piece, end, mode) {
  const n = model.lines[key]?.length || 1
  return setEndMode(model, key, Math.min(line, n - 1), piece, end, mode)
}
