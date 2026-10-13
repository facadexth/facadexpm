// src/pages/aluCatalog/TypesTab.jsx
// Door/window types shared by every extruder, as a tree of up to three levels (กลุ่มหลัก > แบบ > แบบย่อย)
// and our own labour rate. Only leaf types can be chosen on templates / items (Ruling 18).
import { useMemo } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import { flattenTypeTree, parentOptions, categoryForParent, thaiTypeError, typeLayoutFields, typeLayoutInputs } from '../../lib/catalogTypeForm.js'
import { layoutLabels } from '../../lib/layoutRegistry.js'

const CATEGORY_LABEL = { door: 'ประตู', window: 'หน้าต่าง', curtain_wall: 'ผนังกระจก' }

// `types` = all type rows (the parent picker needs them); Hierarchy's quick-add passes the same.
export const typeFields = (types) => [
  { key: 'name', label: 'ชื่อประเภท', type: 'text', required: true, placeholder: 'เช่น บานเลื่อน',
    hint: 'ชื่อต้องไม่ซ้ำกันทุกระดับ ให้ใช้ชื่อเต็ม เช่น ประตูบานเลื่อนรางล่าง' },
  { key: 'parent_id', label: 'อยู่ใต้ประเภท', type: 'select', emptyLabel: '— ระดับบนสุด —',
    options: (form, row) => parentOptions(types, row ? row.id : null),
    sets: (value) => { const c = categoryForParent(types, value); return c ? { category: c } : {} },
    hint: 'แสดงเฉพาะระดับ 1–2 · มีได้สูงสุด 3 ระดับ' },
  { key: 'category', label: 'ประเภทหลัก', type: 'select', required: true, default: 'window',
    disabled: form => !!form.parent_id,
    options: Object.entries(CATEGORY_LABEL).map(([value, label]) => ({ value, label })) },
  { key: 'default_labour_per_sqm', label: 'เรทค่าแรง (บาท/ตร.ม.) · ค่าแรง = เรท × พื้นที่', type: 'number', min: 0,
    hint: 'เว้นว่าง = ใช้ของประเภทแม่ · เรทค่าแรงของเราเอง ไม่ได้นำเข้าจากโรงรีด' },
  ...typeLayoutFields().map(f => (f.key === 'layout_params' ? { ...f, render: props => <LayoutParamsInputs {...props} /> } : f)),
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

// The kind's fixed_by_type inputs (catalogTypeForm.typeLayoutInputs); values stay form text / booleans until
// typeLayoutParamsPayload serialises them. The template editor and item form show them read-only (Task 10).
export function LayoutParamsInputs({ value, set, form }) {
  const values = value && typeof value === 'object' ? value : {}
  const put = (k, v) => set({ ...values, [k]: v })
  return (
    <fieldset style={{ border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', display: 'grid', gap: 8 }}>
      {typeLayoutInputs(form.layout_kind).map(i => (
        <label key={i.key} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13 }}>
          {i.type === 'boolean'
            ? <><input type="checkbox" checked={values[i.key] === true} onChange={e => put(i.key, e.target.checked)} />{i.label}</>
            : i.type === 'select'
              ? <>{i.label}<select className="input" value={values[i.key] ?? ''} onChange={e => put(i.key, e.target.value)}>
                  <option value="">ค่าเริ่มต้น</option>
                  {(i.options || []).map(o => <option key={String(o.value)} value={String(o.value)}>{o.label}</option>)}
                </select></>
              : <>{i.label}<input className="input" type="number" min={i.min} max={i.max} step={i.integer ? 1 : 'any'} style={{ width: 100 }}
                  placeholder={i.default !== undefined ? String(i.default) : ''} value={values[i.key] ?? ''} onChange={e => put(i.key, e.target.value)} /></>}
        </label>
      ))}
    </fieldset>
  )
}

export const typeErrorText = e => thaiTypeError(e && e.message)

export default function TypesTab({ canEdit }) {
  const types = useCatalogTable('door_window_types')
  const fields = useMemo(() => typeFields(types.data || []), [types.data])
  const flat = useMemo(() => flattenTypeTree(types.data || []), [types.data])
  const meta = Object.fromEntries(flat.map(r => [r.type.id, r]))
  const byId = Object.fromEntries((types.data || []).map(t => [t.id, t]))
  if (types.error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {types.error}</div>
  return (
    <CatalogCrud
      title="🚪 ประเภทบาน" table="door_window_types" fields={fields} rows={types.data ? flat.map(r => r.type) : null}
      onChanged={types.refetch} canEdit={canEdit} mapError={typeErrorText}
      deleteWarning="ลบประเภทนี้แล้ว ซีรีส์ทุกซีรีส์จะไม่มีประเภทนี้อีก และจะลบการผูกอุปกรณ์ที่ผูกไว้กับประเภทนี้โดยเฉพาะในซีรีส์ด้วย (อุปกรณ์เหล่านั้นจะไม่เปลี่ยนเป็น “ทุกประเภท”) ย้อนกลับไม่ได้ ถ้ามีประเภทย่อย ต้องลบประเภทย่อยก่อน ถ้าแค่เลิกใช้ ให้ปิด “ใช้งานอยู่” แทน"
      addLabel="+ เพิ่มประเภท" emptyText="ยังไม่มีประเภทบาน"
      columns={[
        { key: 'name', label: 'ชื่อ', render: r => {
          const m = meta[r.id]
          return (
            <span style={{ paddingLeft: ((m?.level || 1) - 1) * 24 }}>
              {m?.level > 1 ? '└ ' : ''}{m?.level > 1 ? r.name : <strong>{r.name}</strong>}
              {m?.selectable && <span className="badge badge-paid" style={{ marginLeft: 8 }}>ใช้เลือกได้</span>}
            </span>
          )
        } },
        { key: 'category', label: 'กลุ่ม', render: r => CATEGORY_LABEL[r.category] || r.category },
        { key: 'layout_kind', label: 'แบบชิ้นส่วน', render: r => (r.layout_kind ? layoutLabels[r.layout_kind] || r.layout_kind : '—') },
        { key: 'default_labour_per_sqm', label: 'เรทค่าแรง บาท/ตร.ม.', render: r => (
          r.default_labour_per_sqm == null
            ? (r.parent_id ? <span style={{ fontSize: 12, color: 'var(--text3)' }}>ใช้ของประเภทแม่</span> : '—')
            : r.default_labour_per_sqm
        ) },
        { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
      ]}
      rowActions={(r, api) => (canEdit && (meta[r.id]?.level || 1) < 3
        ? <button className="btn btn-sm btn-ghost" onClick={() => api.openNew({ parent_id: r.id, category: byId[r.id]?.category || 'window' })}>+ เพิ่มประเภทย่อย</button>
        : null)}
    />
  )
}
