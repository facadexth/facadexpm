// src/pages/estimation/ItemFields.jsx
// Left column of the item popup (mockup screen 2): number / name, type cascade + BOM template, size, series,
// thicknesses, colour, infill, hardware set, labour / profit and extra lines. No quantity (Ruling 16).
// Every field the project can supply shows "ใช้ค่าโปรเจกต์" (empty = inherit) and the inherited value as a hint.
// A layout_kind template adds its layout inputs under the size (ItemLayoutInputs, Task 10).
import ItemLayoutInputs from './ItemLayoutInputs.jsx'

export const Field = ({ label, hint, warn, children }) => (
  <div style={{ minWidth: 0 }}>
    <label className="label">{label}</label>
    {children}
    {hint && <div style={{ fontSize: 11, color: 'var(--text3)', marginTop: 3 }}>{hint}</div>}
    {warn && <div style={{ fontSize: 12, color: 'var(--red)', marginTop: 3 }}>⚠ {warn}</div>}
  </div>
)

export const Check = ({ checked, disabled, onChange, children }) => (
  <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: disabled ? 'default' : 'pointer', fontSize: 12, marginTop: 4 }}>
    <input type="checkbox" checked={checked} disabled={disabled} onChange={e => onChange(e.target.checked)} />
    {children}
  </label>
)

const grid = cols => ({ display: 'grid', gridTemplateColumns: `repeat(auto-fit, minmax(${cols}px, 1fr))`, gap: 10 })
export const Options = ({ list }) => list.map(o => <option key={o.value} value={o.value}>{o.label}</option>)

export default function ItemFields({ form, m, update, dis }) {
  const setLine = (i, k, v) => update({ extra_lines: form.extra_lines.map((l, j) => (j === i ? { ...l, [k]: v } : l)) })
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={grid(140)}>
        <Field label="เลขช่อง ★"><input className="input" disabled={dis} value={form.opening_no} onChange={e => update({ opening_no: e.target.value })} placeholder="เช่น W-03" /></Field>
        <Field label="ชื่อรายการ" hint="ชื่อสั้นสำหรับเรียกในโปรเจกต์"><input className="input" disabled={dis} value={form.item_name} onChange={e => update({ item_name: e.target.value })} /></Field>
      </div>

      <Field label="ประเภท ★" hint="เลือกทีละชั้น ช่องถัดไปขึ้นเมื่อประเภทนั้นมีประเภทย่อย" warn={m.typeWarn}>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {m.levels.map((lv, i) => (
            <select key={i} className="input" style={{ flex: 1, minWidth: 110 }} disabled={dis} value={lv.value} onChange={e => m.pickType(i, e.target.value)}>
              <option value="">— เลือก —</option>
              <Options list={lv.options} />
            </select>
          ))}
        </div>
      </Field>
      <Field label="เทมเพลต BOM ★" hint={m.templateHint}>
        <select className="input" disabled={dis || !m.templateOptions.length} value={form.template_id} onChange={e => update({ template_id: e.target.value })}>
          {!form.template_id && <option value="">— เลือก —</option>}
          <Options list={m.templateOptions} />
        </select>
      </Field>

      <div style={grid(110)}>
        <Field label="กว้าง (มม.) ★"><input className="input" type="number" min="0" step="1" disabled={dis} value={form.width_m} onChange={e => update({ width_m: e.target.value })} /></Field>
        <Field label="สูง (มม.) ★"><input className="input" type="number" min="0" step="1" disabled={dis} value={form.height_m} onChange={e => update({ height_m: e.target.value })} /></Field>
        <Field label="จำนวนช่อง (บาน)"><input className="input" type="number" min="1" step="1" disabled={dis} value={form.panel_count} onChange={e => update({ panel_count: e.target.value })} /></Field>
      </div>
      <ItemLayoutInputs li={m.layoutInputs} form={form} update={update} dis={dis} />

      <div style={grid(180)}>
        <Field label="ซีรีส์">
          <select className="input" disabled={dis} value={form.series_id} onChange={e => update({ series_id: e.target.value })}>
            <option value="">ใช้ค่าโปรเจกต์ · {m.inherit.series || 'ไม่กำหนด'}</option>
            <Options list={m.seriesOpts} />
          </select>
        </Field>
        <Field label="ความหนา วงกบ (มม.)" hint={m.thicknessHint} warn={m.thicknessOpts.some(o => o.missing) ? 'ความหนาเดิมไม่มีในซีรีส์นี้ เลือกใหม่' : null}>
          <select className="input" disabled={dis || m.thicknessOpts.length === 0 || (m.thicknesses.length === 1 && m.thicknessOpts.length === 1)} value={form.thickness_mm} onChange={e => update({ thickness_mm: e.target.value })}>
            <option value="">ใช้ค่าโปรเจกต์ · {m.inherit.thickness || 'ไม่กำหนด'}</option>
            <Options list={m.thicknessOpts} />
          </select>
        </Field>
        {m.showSash && (
          <Field label="ความหนากรอบบาน (มม.)" hint="แสดงเมื่อประเภทนี้อนุญาตความหนาต่างกัน">
            <select className="input" disabled={dis} value={form.sash_thickness_mm} onChange={e => update({ sash_thickness_mm: e.target.value })}>
              {!form.sash_thickness_mm && <option value="">— เลือก —</option>}
              <Options list={m.sashOpts} />
            </select>
          </Field>
        )}
        <Field label="สี" hint={!m.own.finish ? `ใช้ค่าโปรเจกต์: ${m.inherit.finish || 'ไม่กำหนด'}` : null}>
          <select className="input" disabled={dis || !m.own.finish} value={m.own.finish ? form.alu_finish_id : ''} onChange={e => update({ alu_finish_id: e.target.value })}>
            <option value="">{m.own.finish ? '— เลือก —' : m.inherit.finish || 'ไม่กำหนด'}</option>
            {m.own.finish && <Options list={m.finishOpts} />}
          </select>
          <Check checked={!m.own.finish} disabled={dis} onChange={v => m.setOwn('finish', !v)}>ใช้ค่าโปรเจกต์</Check>
        </Field>
        <Field label="วัสดุอุดช่อง" hint={!m.own.infill && !form.no_infill ? `ใช้ค่าโปรเจกต์: ${m.inherit.infill || 'ไม่กำหนด'}` : null}>
          <select className="input" disabled={dis || !m.own.infill || form.no_infill} value={m.own.infill && !form.no_infill ? form.infill_type_id : ''} onChange={e => update({ infill_type_id: e.target.value })}>
            <option value="">{form.no_infill ? 'ไม่มีวัสดุอุดช่อง' : m.own.infill ? '— เลือก —' : m.inherit.infill || 'ไม่กำหนด'}</option>
            {m.own.infill && !form.no_infill && <Options list={m.infillOpts} />}
          </select>
          <Check checked={!m.own.infill} disabled={dis || form.no_infill} onChange={v => m.setOwn('infill', !v)}>ใช้ค่าโปรเจกต์</Check>
          <Check checked={form.no_infill} disabled={dis} onChange={v => update({ no_infill: v, infill_type_id: v ? '' : form.infill_type_id })}>ไม่มีวัสดุอุดช่อง</Check>
        </Field>
        <Field label="ชุดอุปกรณ์" hint={form.no_hardware_set ? null : m.own.hw ? m.hwOwnHint : m.hwInherit.hint} warn={!form.no_hardware_set && !m.own.hw ? m.hwInherit.warning : null}>
          <select className="input" disabled={dis || !m.own.hw || form.no_hardware_set} value={m.own.hw && !form.no_hardware_set ? form.hardware_set_id : ''} onChange={e => update({ hardware_set_id: e.target.value })}>
            <option value="">{form.no_hardware_set ? 'ไม่มีชุดอุปกรณ์' : m.own.hw ? '— เลือก —' : m.hwInherit.label}</option>
            {m.own.hw && !form.no_hardware_set && <Options list={m.hwOpts} />}
          </select>
          <Check checked={!m.own.hw} disabled={dis || form.no_hardware_set} onChange={v => m.setOwn('hw', !v)}>ใช้ค่าโปรเจกต์</Check>
          <Check checked={form.no_hardware_set} disabled={dis} onChange={v => update({ no_hardware_set: v, hardware_set_id: v ? '' : form.hardware_set_id })}>ไม่มีชุดอุปกรณ์</Check>
        </Field>
      </div>

      <div style={grid(140)}>
        <Field label="ค่าแรง (฿/ตร.ม.)"><input className="input" type="number" min="0" disabled={dis} value={form.labour_per_sqm} onChange={e => update({ labour_per_sqm: e.target.value })} placeholder={m.inherit.labour} /></Field>
        <Field label="กำไร (%)"><input className="input" type="number" min="0" disabled={dis} value={form.profit_pct} onChange={e => update({ profit_pct: e.target.value })} placeholder={m.inherit.profit} /></Field>
      </div>

      <div style={grid(140)}>
        <Field label="Fire Barrier (บาท/ชุด)"><input className="input" type="number" min="0" disabled={dis} value={form.fire_barrier_cost ?? ''} onChange={e => update({ fire_barrier_cost: e.target.value })} /></Field>
        <Field label="Bracket (บาท/ชุด)"><input className="input" type="number" min="0" disabled={dis} value={form.bracket_cost ?? ''} onChange={e => update({ bracket_cost: e.target.value })} /></Field>
        <Field label="ดัดอลูมิเนียม (บาท/ชุด)"><input className="input" type="number" min="0" disabled={dis} value={form.bend_alu_cost ?? ''} onChange={e => update({ bend_alu_cost: e.target.value })} /></Field>
        <Field label="ดัดกระจก (บาท/ชุด)"><input className="input" type="number" min="0" disabled={dis} value={form.bend_glass_cost ?? ''} onChange={e => update({ bend_glass_cost: e.target.value })} /></Field>
      </div>

      <div>
        <div style={{ fontWeight: 700, marginBottom: 6, fontSize: 13 }}>รายการเพิ่มเติมอื่นๆ (ไม่รวม Fire Barrier / Bracket / ดัดโค้ง ซึ่งมีช่องแยกด้านบน)</div>
        <div style={{ display: 'grid', gap: 6 }}>
          {form.extra_lines.map((l, i) => (
            <div key={i} style={{ display: 'grid', gridTemplateColumns: '1fr 120px 32px', gap: 6 }}>
              <input className="input input-sm" disabled={dis} placeholder="รายละเอียด" value={l.description} onChange={e => setLine(i, 'description', e.target.value)} />
              <input className="input input-sm" disabled={dis} type="number" placeholder="จำนวนเงิน" value={l.amount} onChange={e => setLine(i, 'amount', e.target.value)} />
              {!dis && <button type="button" className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => update({ extra_lines: form.extra_lines.filter((_, j) => j !== i) })}>✕</button>}
            </div>
          ))}
          {!dis && <button type="button" className="btn btn-sm btn-ghost" style={{ justifySelf: 'start' }} onClick={() => update({ extra_lines: [...form.extra_lines, { description: '', amount: '' }] })}>+ เพิ่มรายการ</button>}
        </div>
      </div>
    </div>
  )
}
