// src/pages/aluCatalog/PartsTab.jsx
// Hardware, hardware sets and accessories (rubber, plastic bumpers ...), what each set
// contains, and which series (optionally which type) uses which part.
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'

const KIND_LABEL = { hardware: 'อุปกรณ์', hardware_set: 'ชุดอุปกรณ์', accessory: 'อะไหล่/อุปกรณ์เสริม' }

// management selectors list every row, inactive ones tagged, so nothing becomes unreachable
const withInactiveTag = (rows, labelFn) => (rows || []).map(r => ({ value: r.id, label: labelFn(r) + (r.active === false ? ' (ปิดใช้งาน)' : '') }))

export default function PartsTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const parts = useCatalogTable('alu_parts')
  const setItems = useCatalogTable('alu_part_set_items', 'id')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesParts = useCatalogTable('alu_series_parts', 'id')
  const [setId, setSetId] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const [kindFilter, setKindFilter] = useState('')

  const error = providers.error || parts.error || setItems.error || series.error || types.error || seriesParts.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  // a selection whose row vanished must not linger
  if (setId && parts.data && !parts.data.some(p => p.id === setId)) setSetId('')
  if (seriesId && series.data && !series.data.some(s => s.id === seriesId)) setSeriesId('')
  const sets = (parts.data || []).filter(p => p.kind === 'hardware_set')
  const linkedToSet = new Set((setItems.data || []).filter(l => l.set_id === setId).map(l => l.part_id))
  const singles = (parts.data || []).filter(p => p.kind !== 'hardware_set' && (p.active !== false || linkedToSet.has(p.id)))
  const linkedToSeries = new Set((seriesParts.data || []).filter(l => l.series_id === seriesId).map(l => l.part_id))
  const seriesPartChoices = (parts.data || []).filter(p => p.active !== false || linkedToSeries.has(p.id))
  const shownParts = (parts.data || []).filter(p => !kindFilter || p.kind === kindFilter)
  // tree order, full path labels; inactive types stay listed so existing links remain editable
  const typeOptions = typePickerOptions(types.data || [], new Set((types.data || []).map(t => t.id))).map(o => ({ value: o.id, label: o.label }))
  const partLabel = p => (p.code ? `${p.code} · ${p.name}` : p.name)
  const inactiveTag = p => (p.active === false ? ' (ปิดใช้งาน)' : '')

  const PART_FIELDS = [
    { key: 'name', label: 'ชื่อ', type: 'text', required: true },
    { key: 'kind', label: 'ชนิด', type: 'select', required: true, default: 'hardware',
      options: Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label })) },
    { key: 'unit', label: 'หน่วย', type: 'text', required: true, default: 'ชิ้น' },
    { key: 'provider_id', label: 'โรงรีด/ผู้ผลิต (ไม่บังคับ)', type: 'select', options: form => optionList(providers.data, p => p.name, form.provider_id) },
    { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label className="label">แสดงเฉพาะชนิด</label>
        <select className="input" style={{ maxWidth: 240 }} value={kindFilter} onChange={e => setKindFilter(e.target.value)}>
          <option value="">ทั้งหมด</option>
          {Object.entries(KIND_LABEL).map(([v, l]) => <option key={v} value={v}>{l}</option>)}
        </select>
      </div>
      <CatalogCrud
        title="🔩 ชิ้นส่วนอื่น · อุปกรณ์ / ชุดอุปกรณ์ / อะไหล่" table="alu_parts" fields={PART_FIELDS} rows={shownParts}
        onChanged={parts.refetch} canEdit={canEdit} addLabel="+ เพิ่มรายการ" emptyText={(parts.data || []).length && kindFilter ? 'ไม่มีรายการในชนิดนี้' : 'ยังไม่มีอุปกรณ์'}
        deleteWarning={r => (r?.kind === 'hardware_set'
          ? 'ลบแล้วจะลบรายการในชุด การผูกกับซีรีส์ และราคาของชุดนี้ทั้งหมดด้วย (ย้อนกลับไม่ได้)'
          : 'ลบไม่ได้ถ้ารายการนี้อยู่ในชุดอุปกรณ์ใด ต้องเอาออกจากชุดก่อน (ลบได้แล้วจะลบการผูกกับซีรีส์และราคาทั้งหมดของรายการนี้ด้วย) ถ้าแค่เลิกใช้ ให้ปิด "ใช้งานอยู่" แทน')}
        columns={[
          { key: 'code', label: 'รหัส', render: r => <span style={{ fontFamily: 'monospace' }}>{r.code}</span> },
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'kind', label: 'ชนิด', render: r => KIND_LABEL[r.kind] },
          { key: 'unit', label: 'หน่วย' },
          { key: 'provider_id', label: 'ผู้ผลิต', render: r => providerById[r.provider_id]?.name || '—' },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
      />

      <div style={{ marginBottom: 12 }}>
        <label className="label">เลือกชุดอุปกรณ์เพื่อกำหนดสิ่งที่อยู่ในชุด</label>
        <select className="input" style={{ maxWidth: 320 }} value={setId} onChange={e => setSetId(e.target.value)}>
          <option value="">— เลือกชุดอุปกรณ์ —</option>
          {optionList(sets, partLabel, setId).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {setId && (
        <LinkEditor
          title="สิ่งที่อยู่ในชุดนี้" hint="ติ๊กเพื่อเพิ่มเข้าชุด แล้วใส่จำนวน"
          linkTable="alu_part_set_items" parentKey="set_id" parentId={setId} childKey="part_id"
          childOptions={singles.map(p => ({ id: p.id, label: `${partLabel(p)} (${p.unit})${inactiveTag(p)}` }))}
          links={setItems.data} onChanged={setItems.refetch} canEdit={canEdit}
          extra={{ key: 'quantity', label: 'จำนวน', type: 'number', defaultFor: () => 1 }}
        />
      )}

      <div style={{ margin: '16px 0 12px' }}>
        <label className="label">เลือกซีรีส์เพื่อกำหนดอุปกรณ์ที่ใช้</label>
        <select className="input" style={{ maxWidth: 380 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
          <option value="">— เลือกซีรีส์ —</option>
          {withInactiveTag(series.data, s => seriesLabelFull(s, providerById[s.provider_id])).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
      </div>
      {seriesId && (
        <LinkEditor
          title="อุปกรณ์/ชุดอุปกรณ์ที่ซีรีส์นี้ใช้" hint="เลือกประเภทบานเพื่อจำกัดให้ใช้กับประเภทนั้นเท่านั้น เว้นว่างคือใช้กับทุกประเภท (ชุดอุปกรณ์ 'ใช้กับชุด') · ถ้าเลือกประเภทที่มีประเภทย่อย จะใช้กับประเภทย่อยทั้งหมดของประเภทนี้"
          linkTable="alu_series_parts" parentKey="series_id" parentId={seriesId} childKey="part_id"
          childOptions={seriesPartChoices.map(p => ({ id: p.id, label: `${partLabel(p)} · ${KIND_LABEL[p.kind]}${inactiveTag(p)}` }))}
          links={seriesParts.data} onChanged={seriesParts.refetch} canEdit={canEdit}
          extra={{ key: 'type_id', label: 'ประเภท', type: 'select', emptyLabel: 'ทุกประเภท', options: typeOptions }}
        />
      )}
    </div>
  )
}
