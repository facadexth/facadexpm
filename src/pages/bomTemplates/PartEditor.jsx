// src/pages/bomTemplates/PartEditor.jsx
// BOM template part editor (tab "ส่วนประกอบและอุปกรณ์" of a template with layout_kind). Layout, wording and behaviour
// follow the owner-approved mockup v24 (docs/superpowers/mockups/2026-10-10-bom-part-editor-mockup.html): preview card
// (test size, outside/inside, overview + zoom) left, "แก้ชิ้นที่เลือก" panel right, components table below; the
// selection is shared by the three. Test size / view / series / thickness are UI-only and never saved (Ruling PE-3).
// Every other layout kind (Task 10, mockup v5 / spec §6): the inputs panel (PartInputs: template defaults, fixed_by_type
// read-only, refused params -> PARAMS_HINT and no drawing), the D14 line style, part tabs with "เสร็จแล้ว" (PartTabs,
// model.done), one millimetre drawing with the other parts faded, curtain-wall cell cycling, and the assigned badge.
// sliding_2 renders exactly as before (no inputs, tabs or style select).
// Add-ons ช่องแสง (Task 6, mockup v12, sliding_2 only, only when onPreviewAddonsChange is passed): the add-on box under the
// size bar, preview add-ons around the overview, the effects card and the zoom card of the selected add-on. previewAddons
// are UI-only; addonSets ({ [setKey]: { rows, dirty } }) are the template's piece sets, saved by BomTemplates.
import { useState, useEffect } from 'react'
import { clampSelection, setEndMode, setParams, cycleCellKind } from '../../lib/partModel.js'
import { coerceParams } from '../../lib/layoutRegistry.js'
import { catalogFamilies } from './helpers.js'
import { editorView, testOptions, posName, partOfKey, partTabs, toggleDone, assignedCount, PARAMS_HINT } from './partEditorView.js'
import NumInput from './NumInput.jsx'
import PartPreview from './PartPreview.jsx'
import PartInputs from './PartInputs.jsx'
import PartTabs from './PartTabs.jsx'
import PartSidePanel from './PartSidePanel.jsx'
import PartTable from './PartTable.jsx'
import AddonBox from './addon/AddonBox.jsx'
import AddonZoom from './addon/AddonZoom.jsx'
import AddonEffects from './addon/AddonEffects.jsx'
import { setRowsFor, editSetRow, followMainSize } from './addon/addonView.js'
import './partEditor.css'

const CORNER_WHY = { both_through: 'วิ่งสุดทั้งสองชิ้น', both_butt: 'วิ่งชนทั้งสองชิ้น' }
// D14 line styles (mockup v5 "แบบเส้น")
const STYLES = [['double', 'เส้นคู่ (ตามที่ใช้ในใบเสนอราคา)'], ['lengths', 'เส้นคู่ + ความยาวชิ้น'], ['solid', 'ทึบตามสี'], ['cad', 'CAD (เส้นอย่างเดียว)']]

export default function PartEditor({ model, onChange, index, canEdit, testSeriesId, testThicknessMm, onTestChange, templateName, initialSelection, onParamsInvalid,
  addonSets, onAddonSetsChange, previewAddons, onPreviewAddonsChange, addonError = null, initialAddonSel = null }) {
  const [size, setSize] = useState({ w: 1800, h: 1200 })
  const [view, setView] = useState('out')
  const [style, setStyle] = useState('double')
  const [tabId, setTabId] = useState('all')
  const [draft, setDraft] = useState(null)   // params the layout refused (folding 0 + 0): shown in the inputs, never in the model
  const [rawSel, setSel] = useState(initialSelection || { key: 'frame_bottom', line: 0 })   // mockup starts on เฟรมล่าง
  const mm = model.layout_kind !== 'sliding_2'
  const [aoSel, setAoSel] = useState(initialAddonSel)   // preview add-on whose zoom card is open (UI only)
  const [aoPiece, setAoPiece] = useState(0)             // selected row of its piece set
  const aoList = !mm && onPreviewAddonsChange ? (previewAddons || []) : []
  const aoIdx = aoSel != null && aoSel < aoList.length ? aoSel : null
  const aoMain = { widthMm: size.w, heightMm: size.h }
  const pickAddon = (i) => { setAoSel(i); setAoPiece(0) }
  // test size; preview add-ons still at the old edge length follow it (mockup __peSize)
  const resize = (patch) => {
    const next = { ...size, ...patch }
    const moved = followMainSize(aoList, size, next)
    if (moved !== aoList) onPreviewAddonsChange(moved)
    setSize(next)
  }
  useEffect(() => { if (onParamsInvalid) onParamsInvalid(!!draft) }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  const sel = clampSelection(model, rawSel)
  const families = catalogFamilies(index)
  const data = editorView({ model, index, seriesId: testSeriesId, thicknessMm: testThicknessMm, widthMm: size.w, heightMm: size.h })
  const { series, thicknesses } = testOptions(index, testSeriesId)
  const pk = partOfKey(model, sel.key)
  const partKeys = data.parts.find(p => p.key === pk)?.keys || []
  const pick = (key, line = 0) => setSel({ key, line })
  const edit = (m) => { if (canEdit) onChange(m) }
  const tab = mm ? (partTabs(model).find(t => t.id === tabId) || null) : null
  const badge = mm ? assignedCount(model) : null
  // inputs panel -> setParams (coerced: clamped to min / max, whole numbers); a refusal keeps the model and shows the hint
  const changeParams = (patch) => {
    if (!canEdit) return
    const next = { ...(draft || model.params), ...coerceParams(model.layout_kind, patch) }
    try {
      const m = setParams(model, next)
      setDraft(null)
      onChange(m)
    } catch (e) {
      if (e && e.message === 'layout_params_invalid') setDraft(next)
      else throw e
    }
  }

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
            <label>กว้าง (มม.) <NumInput min={300} step={50} value={size.w} onChange={v => resize({ w: v ?? 0 })} /></label>
            <label>สูง (มม.) <NumInput min={300} step={50} value={size.h} onChange={v => resize({ h: v ?? 0 })} /></label>
            <span className="seg" role="group" aria-label="มุมมอง">
              <button type="button" aria-pressed={view === 'out'} onClick={() => setView('out')}>ด้านนอก</button>
              <button type="button" aria-pressed={view === 'in'} onClick={() => setView('in')}>ด้านใน</button>
            </span>
            {mm && (
              <label>แบบเส้น{' '}
                <select aria-label="แบบเส้น" value={style} onChange={e => setStyle(e.target.value)}>
                  {STYLES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                </select>
              </label>
            )}
          </div>
          {!mm && onPreviewAddonsChange && <AddonBox addons={aoList} onChange={onPreviewAddonsChange} main={aoMain} sel={aoIdx} onSelect={pickAddon} error={addonError} />}
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
          {mm && <PartInputs model={model} params={draft || model.params || {}} invalid={!!draft} canEdit={canEdit} onChange={changeParams} />}
          {mm && !draft && (
            <>
              <PartTabs model={model} tab={tab ? tab.id : 'all'} canEdit={canEdit} onTab={setTabId} onToggleDone={(k) => edit(toggleDone(model, k))} />
              <p className="hint" style={{ margin: '0 0 4px' }}>กำหนดโปรไฟล์แล้ว {badge.done}/{badge.total} ตำแหน่ง</p>
            </>
          )}
          {draft
            ? <div className="empty" role="status">{PARAMS_HINT}</div>
            : <PartPreview model={model} sel={sel} partKeys={partKeys} view={view} widthMm={size.w} heightMm={size.h}
                widthOf={data.widthOf} buttOf={data.buttOf} canEdit={canEdit} onPick={pick} style={style} tab={tab} lengths={data.lengthsByPiece}
                addons={aoList} addonSel={aoIdx} onAddonPick={pickAddon}
                onCell={(r, c) => edit(cycleCellKind(model, r, c))}
                onToggle={(key, piece, end, mode) => edit(setEndModeAt(model, key, sel.line, piece, end, mode))} />}
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
      {aoList.length > 0 && (
        <section className="card2">
          <h2>ภาพรวมทั้งชุด (รวมช่องแสง): ผลต่อชิ้นงาน (ตัวเลขตัวอย่าง)</h2>
          <AddonEffects addons={aoList} addonSets={addonSets} main={aoMain} buttOf={data.buttOf} layoutKind={model.layout_kind} model={model} />
        </section>
      )}
      {aoIdx != null && (() => {
        const a = aoList[aoIdx]
        const set = setRowsFor(addonSets, a, model.layout_kind)
        return <AddonZoom addon={a} ai={aoIdx} rows={set.rows} isDefault={set.isDefault} dirty={set.dirty} families={families}
          canEdit={canEdit && !!onAddonSetsChange} pieceIdx={aoPiece} onPick={setAoPiece} main={aoMain} buttOf={data.buttOf}
          layoutKind={model.layout_kind} model={model} error={addonError} onEditRow={(i, patch) => onAddonSetsChange(editSetRow(addonSets, a, model.layout_kind, i, patch, data.buttOf))} />
      })()}
    </div>
  )
}

// Marker toggle on the line whose ends the zoom shows (the selected line, mockup toggle()).
function setEndModeAt(model, key, line, piece, end, mode) {
  const n = model.lines[key]?.length || 1
  return setEndMode(model, key, Math.min(line, n - 1), piece, end, mode)
}
