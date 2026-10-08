// src/pages/aluCatalog/HierarchyTab.jsx
// Extruders (โรงรีด) | their series (ซีรีส์) | which door/window types the series offers.
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge, CrudForm } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { Modal } from '../../components/Modal.jsx'
import { emptyForm, buildPayload, missingRequired, friendlyDbError } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { TYPE_FIELDS } from './TypesTab.jsx'

const BASIS_LABEL = { per_kg: 'ต่อกก.', per_piece: 'ต่อเส้น', both: 'ทั้งสองแบบ' }

const PROVIDER_FIELDS = [
  { key: 'name', label: 'ชื่อโรงรีด', type: 'text', required: true },
  { key: 'short_name', label: 'ชื่อย่อ (ใช้ต่อท้ายชื่อซีรีส์ในรายการ)', type: 'text', required: true },
  { key: 'price_basis', label: 'คิดราคาแบบ', type: 'select', required: true, default: 'per_kg',
    options: [{ value: 'per_kg', label: 'ต่อกก.' }, { value: 'per_piece', label: 'ต่อเส้น' }, { value: 'both', label: 'ทั้งสองแบบ' }] },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

const SERIES_FIELDS = [
  { key: 'name', label: 'ชื่อซีรีส์', type: 'text', required: true, placeholder: 'เช่น ซีรีส์ 40' },
  { key: 'is_base', label: 'ซีรีส์พื้นฐานของโรงรีด (ใช้แสดงเท่านั้น)', type: 'checkbox', default: false },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export default function HierarchyTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesTypes = useCatalogTable('alu_series_types', 'id')
  const [providerId, setProviderId] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const [addingType, setAddingType] = useState(false)
  const [savingType, setSavingType] = useState(false)

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const seriesOfProvider = (series.data || []).filter(s => s.provider_id === providerId)
  const pickedSeries = seriesOfProvider.find(s => s.id === seriesId)

  const error = providers.error || series.error || types.error || seriesTypes.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const pickBtn = (selected, onClick) => (
    <button className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}`} onClick={onClick}>{selected ? 'เลือกอยู่' : 'เลือก'}</button>
  )

  // Types offered: active ones, plus any inactive type this series is already linked to.
  const linkedTypeIds = new Set((seriesTypes.data || []).filter(l => l.series_id === seriesId).map(l => l.type_id))
  const typeOptions = (types.data || [])
    .filter(t => t.active !== false || linkedTypeIds.has(t.id))
    .map(t => ({ id: t.id, label: t.active === false ? `${t.name} (ปิดใช้งาน)` : t.name }))

  const saveNewType = async (form) => {
    if (!canEdit || savingType) return
    const missing = missingRequired(TYPE_FIELDS, form)
    if (missing.length) { alert('กรุณากรอก: ' + missing.join(', ')); return }
    setSavingType(true)
    try {
      const { data, error: err } = await supabase.from('door_window_types').insert(buildPayload(TYPE_FIELDS, form)).select('id').single()
      if (err) throw err
      // Tick it for the selected series (non-fatal if this part fails).
      if (pickedSeries && data?.id) {
        const { error: linkErr } = await supabase.from('alu_series_types').insert({ series_id: pickedSeries.id, type_id: data.id })
        if (linkErr) alert('เพิ่มประเภทแล้ว แต่ติ๊กให้ซีรีส์ไม่สำเร็จ: ' + friendlyDbError(linkErr))
      }
      setAddingType(false)
      types.refetch(); seriesTypes.refetch()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(e)) }
    finally { setSavingType(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
      <CatalogCrud
        title="🏭 โรงรีด" table="alu_providers" fields={PROVIDER_FIELDS} rows={providers.data}
        onChanged={providers.refetch} canEdit={canEdit} deleteWarning="ลบไม่ได้ถ้ายังมีซีรีส์ หน้าตัด สี อุปกรณ์ หรือราคาของโรงรีดนี้อยู่ ให้ปิด “ใช้งานอยู่” แทน"
        addLabel="+ เพิ่มโรงรีด" emptyText="ยังไม่มีโรงรีด"
        columns={[
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'short_name', label: 'ชื่อย่อ' },
          { key: 'price_basis', label: 'คิดราคา', render: r => BASIS_LABEL[r.price_basis] },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
        rowActions={r => pickBtn(r.id === providerId, () => { setProviderId(r.id); setSeriesId('') })}
      />

      <div>
        {providerId && providerById[providerId] ? (
          <>
            <CatalogCrud
              title={`📚 ซีรีส์ของ ${providerById[providerId].name}`} table="alu_series" fields={SERIES_FIELDS} rows={seriesOfProvider}
              scope={{ provider_id: providerId }} onChanged={series.refetch} canEdit={canEdit}
              deleteWarning="ลบแล้วจะลบการผูกประเภท หน้าตัด อุปกรณ์ และราคาต่อกก.ที่ทับเฉพาะซีรีส์นี้ทั้งหมดด้วย (ย้อนกลับไม่ได้) ถ้าแค่เลิกใช้ ให้ปิด “ใช้งานอยู่” แทน"
              addLabel="+ เพิ่มซีรีส์" emptyText="โรงรีดนี้ยังไม่มีซีรีส์"
              columns={[
                { key: 'name', label: 'ซีรีส์', render: r => <strong>{seriesLabelFull(r, providerById[r.provider_id])}</strong> },
                { key: 'is_base', label: 'พื้นฐาน', render: r => (r.is_base ? '✓' : '') },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
              rowActions={r => pickBtn(r.id === seriesId, () => setSeriesId(r.id))}
            />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: -12 }}>
              ชื่อซีรีส์คือชื่อกลุ่มสินค้าของโรงรีด (เช่น ซีรีส์ 40) ไม่ใช่ชื่อหน้าตัด ชื่อหน้าตัดและ family อยู่ในแท็บหน้าตัด · ป้าย "พื้นฐาน" ใช้ทำเครื่องหมายซีรีส์หลักของโรงรีด ใช้แสดงเท่านั้น ยังไม่กระทบการคิดราคา
            </div>
          </>
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>เลือกโรงรีดทางซ้ายเพื่อดูและจัดการซีรีส์</div>
        )}
      </div>

      <div>
        {pickedSeries ? (
          <LinkEditor
            title={
              <span style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                <span>ประเภทที่ซีรีส์นี้ทำได้ · {seriesLabelFull(pickedSeries, providerById[pickedSeries.provider_id])}</span>
                {canEdit && <button className="btn btn-sm btn-primary" onClick={() => setAddingType(true)}>+ เพิ่มประเภท</button>}
              </span>
            }
            hint="ซีรีส์ที่ไม่มีประเภทใด (เช่น ไม่มีประตูพับ) ให้ไม่ติ๊ก ระบบจะเตือนเมื่อเลือกประเภทที่ซีรีส์ไม่มี"
            linkTable="alu_series_types" parentKey="series_id" parentId={pickedSeries.id} childKey="type_id"
            childOptions={typeOptions}
            links={seriesTypes.data} onChanged={seriesTypes.refetch} canEdit={canEdit}
          />
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>
            เลือกซีรีส์เพื่อดูประเภทที่ทำได้
            {canEdit && <div style={{ marginTop: 10 }}><button className="btn btn-sm btn-primary" onClick={() => setAddingType(true)}>+ เพิ่มประเภท</button></div>}
          </div>
        )}
      </div>

      {addingType && canEdit && (
        <Modal title="เพิ่มประเภท" onClose={() => setAddingType(false)} maxWidth={480}>
          <CrudForm fields={TYPE_FIELDS} initial={emptyForm(TYPE_FIELDS)} loading={savingType} onSave={saveNewType} onCancel={() => setAddingType(false)} />
        </Modal>
      )}
    </div>
  )
}
