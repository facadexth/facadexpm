// src/pages/aluCatalog/PartsTab.jsx
// Hardware and consumables (rubber, silicone, screws ...), which series (optionally which type) uses which part, and
// the hardware set page (HardwareSetsPanel: what each set holds, from stock, and its series).
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import HardwareSetsPanel from './HardwareSetsPanel.jsx'

const KIND_LABEL = { hardware: 'อุปกรณ์', hardware_set: 'ชุดอุปกรณ์', accessory: 'วัสดุสิ้นเปลือง' }
// sets are managed on their own page (no unit, contents from stock), so the general list offers the other two kinds
const SINGLE_KINDS = Object.entries(KIND_LABEL).filter(([v]) => v !== 'hardware_set')

// management selectors list every row, inactive ones tagged, so nothing becomes unreachable
const withInactiveTag = (rows, labelFn) => (rows || []).map(r => ({ value: r.id, label: labelFn(r) + (r.active === false ? ' (ปิดใช้งาน)' : '') }))

export default function PartsTab({ canEdit }) {
  const [view, setView] = useState('parts')   // 'parts' | 'sets'
  const providers = useCatalogTable('alu_providers')
  const parts = useCatalogTable('alu_parts')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [seriesId, setSeriesId] = useState('')
  const [kindFilter, setKindFilter] = useState('')

  const switcher = (
    <div style={{ display: 'flex', gap: 8, marginBottom: 12, flexWrap: 'wrap' }}>
      <button type="button" className={`btn btn-sm ${view === 'parts' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('parts')}>อุปกรณ์ · วัสดุสิ้นเปลือง</button>
      <button type="button" className={`btn btn-sm ${view === 'sets' ? 'btn-primary' : 'btn-ghost'}`} onClick={() => setView('sets')}>ชุดอุปกรณ์</button>
    </div>
  )
  if (view === 'sets') return <div>{switcher}<HardwareSetsPanel canEdit={canEdit} /></div>

  const error = providers.error || parts.error || series.error || types.error || seriesParts.error
  if (error) return <div>{switcher}<div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div></div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  // a selection whose row vanished must not linger
  if (seriesId && series.data && !series.data.some(s => s.id === seriesId)) setSeriesId('')
  const linkedToSeries = new Set((seriesParts.data || []).filter(l => l.series_id === seriesId).map(l => l.part_id))
  const seriesPartChoices = (parts.data || []).filter(p => p.active !== false || linkedToSeries.has(p.id))
  const shownParts = (parts.data || []).filter(p => p.kind !== 'hardware_set' && (!kindFilter || p.kind === kindFilter))
  // tree order, full path labels; inactive types stay listed so existing links remain editable
  const typeOptions = typePickerOptions(types.data || [], new Set((types.data || []).map(t => t.id))).map(o => ({ value: o.id, label: o.label }))
  const partLabel = p => (p.code ? `${p.code} · ${p.name}` : p.name)
  const inactiveTag = p => (p.active === false ? ' (ปิดใช้งาน)' : '')

  const PART_FIELDS = [
    { key: 'name', label: 'ชื่อ', type: 'text', required: true },
    { key: 'kind', label: 'ชนิด', type: 'select', required: true, default: 'hardware',
      options: SINGLE_KINDS.map(([value, label]) => ({ value, label })) },
    { key: 'unit', label: 'หน่วย', type: 'text', required: true, default: 'ชิ้น' },
    { key: 'provider_id', label: 'โรงรีด/ผู้ผลิต (ไม่บังคับ)', type: 'select', options: form => optionList(providers.data, p => p.name, form.provider_id) },
    { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
  ]

  return (
    <div>
      {switcher}
      <div style={{ marginBottom: 12 }}>
        <label className="label">แสดงเฉพาะชนิด</label>
        <select className="input" style={{ maxWidth: 240 }} value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
          <option value="">ทั้งหมด</option>
          {SINGLE_KINDS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <CatalogCrud
        title="🔩 ชิ้นส่วนอื่น · อุปกรณ์ / วัสดุสิ้นเปลือง" table="alu_parts" fields={PART_FIELDS} rows={shownParts}
        onChanged={parts.refetch} canEdit={canEdit} addLabel="+ เพิ่มรายการ" emptyText={(parts.data || []).length && kindFilter ? 'ไม่มีรายการในชนิดนี้' : 'ยังไม่มีอุปกรณ์'}
        deleteWarning='ลบไม่ได้ถ้ารายการนี้อยู่ในชุดอุปกรณ์ใด ต้องเอาออกจากชุดก่อน (ลบได้แล้วจะลบการผูกกับซีรีส์และราคาทั้งหมดของรายการนี้ด้วย) ถ้าแค่เลิกใช้ ให้ปิด "ใช้งานอยู่" แทน'
        columns={[
          { key: 'code', label: 'รหัส', render: r => <span style={{ fontFamily: 'monospace' }}>{r.code}</span> },
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'kind', label: 'ชนิด', render: r => KIND_LABEL[r.kind] },
          { key: 'unit', label: 'หน่วย' },
          { key: 'provider_id', label: 'ผู้ผลิต', render: r => providerById[r.provider_id]?.name || '—' },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
      />

      <div style={{ margin: '16px 0 12px' }}>
        <label className="label">เลือกซีรีส์เพื่อกำหนดอุปกรณ์ที่ใช้</label>
        <select className="input" style={{ maxWidth: 380 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
          <option value="">— เลือกซีรีส์ —</option>
          {withInactiveTag(series.data, s => seriesLabelFull(s, providerById[s.provider_id])).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {seriesId && (
        <LinkEditor
          title="อุปกรณ์/ชุดอุปกรณ์ที่ซีรีส์นี้ใช้" hint="เลือกประเภทบานเพื่อจำกัดให้ใช้กับประเภทนั้นเท่านั้น เว้นว่างคือใช้กับทุกประเภท (ชุดอุปกรณ์ 'ใช้กับชุด') · ถ้าเลือกประเภทที่มีประเภทย่อย จะใช้กับประเภทย่อยทั้งหมดของประเภทนี้ · ผูกจากหน้าชุดอุปกรณ์ได้ด้วย (ข้อมูลเดียวกัน)"
          linkTable="alu_series_parts" parentKey="series_id" parentId={seriesId} childKey="part_id"
          childOptions={seriesPartChoices.map(p => ({ id: p.id, label: `${partLabel(p)} · ${KIND_LABEL[p.kind]}${inactiveTag(p)}` }))}
          links={seriesParts.data} onChanged={seriesParts.refetch} canEdit={canEdit}
          extra={{ key: 'type_id', label: 'ประเภท', type: 'select', emptyLabel: 'ทุกประเภท', options: typeOptions }}
        />
      )}
    </div>
  )
}
