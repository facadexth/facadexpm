// src/pages/aluCatalog/HierarchyTab.jsx
// Extruders (โรงรีด) | their series (ซีรีส์) | which door/window types the series offers.
import { useState } from 'react'
import { supabase } from '../../lib/supabase.js'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge, CrudForm } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { Modal } from '../../components/Modal.jsx'
import { emptyForm, buildPayload, missingRequired, friendlyDbError, optionList } from '../../lib/catalogForm.js'
import { parseThicknessOptions, formatThicknessOptions } from '../../lib/seriesFamily.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { typeFields, typeErrorText } from './TypesTab.jsx'
import { typePickerOptions } from '../../lib/catalogTypeForm.js'
import { useTenant } from '../../hooks/useTenant.js'
import { useImageUrls } from '../../lib/profileImages.js'
import ProviderLogo from '../../components/ProviderLogo.jsx'
import ProviderLogoCard from './ProviderLogoCard.jsx'

const BASIS_LABEL = { per_kg: 'ต่อกก.', per_piece: 'ต่อเส้น', both: 'ทั้งสองแบบ' }

const PROVIDER_FIELDS = [
  { key: 'name', label: 'ชื่อโรงรีด', type: 'text', required: true },
  { key: 'short_name', label: 'ชื่อย่อ (ใช้ต่อท้ายชื่อซีรีส์ในรายการ)', type: 'text', required: true },
  { key: 'price_basis', label: 'คิดราคาแบบ', type: 'select', required: true, default: 'per_kg',
    options: [{ value: 'per_kg', label: 'ต่อกก.' }, { value: 'per_piece', label: 'ต่อเส้น' }, { value: 'both', label: 'ทั้งสองแบบ' }] },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

// families = the selected extruder's ซีรีส์หลัก rows. A series joins at most one family of its own extruder.
export const seriesFields = families => [
  { key: 'name', label: 'ชื่อซีรีส์', type: 'text', required: true, placeholder: 'เช่น ซีรีส์ 40' },
  { key: 'series_family_id', label: 'ซีรีส์หลัก', type: 'select', emptyLabel: 'ไม่มี (เป็นซีรีส์หลักของตัวเอง)',
    options: (form, row) => optionList(families, f => f.name, row ? row.series_family_id : null),
    hint: 'โปรเจกต์ที่เลือกซีรีส์หลักนี้ จะได้ชุดนี้กับรายการที่เป็นประเภทที่ชุดนี้ทำ' },
  { key: 'is_base', label: 'ซีรีส์พื้นฐานของโรงรีด (ใช้แสดงเท่านั้น)', type: 'checkbox', default: false },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export const FAMILY_FIELDS = [
  { key: 'name', label: 'ชื่อซีรีส์หลัก', type: 'text', required: true, placeholder: 'เช่น ICONIQ EURO' },
  { key: 'thickness_options', label: 'ความหนาที่ให้เลือกในค่าเริ่มต้นโปรเจกต์ (มม.)', type: 'text',
    render: ({ value, set }) => (
      <input className="input" value={Array.isArray(value) ? formatThicknessOptions(value) : (value ?? '')}
        onChange={e => set(e.target.value)} placeholder="เช่น 1.0, 1.2, 1.5, 1.8, 2.0" />
    ),
    serialize: v => parseThicknessOptions(v).value,
    hint: 'เว้นว่าง = ใช้ทุกความหนาของชุดในกลุ่ม · ในรายการยังเลือกความหนาอื่นของชุดได้' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]
export const familyThicknessError = form => parseThicknessOptions(form.thickness_options).error

export default function HierarchyTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const series = useCatalogTable('alu_series')
  const types = useCatalogTable('door_window_types')
  const seriesTypes = useCatalogTable('alu_series_types', 'id')
  const families = useCatalogTable('alu_series_families')
  const [providerId, setProviderId] = useState('')
  const [seriesId, setSeriesId] = useState('')
  const [addingType, setAddingType] = useState(false)
  const [savingType, setSavingType] = useState(false)
  const { tenant } = useTenant()
  const logoUrls = useImageUrls((providers.data || []).map(p => p.logo_path))

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const seriesOfProvider = (series.data || []).filter(s => s.provider_id === providerId)
  const pickedSeries = seriesOfProvider.find(s => s.id === seriesId)
  const familiesOfProvider = (families.data || []).filter(f => f.provider_id === providerId)
  const familyById = Object.fromEntries((families.data || []).map(f => [f.id, f]))

  const error = providers.error || series.error || types.error || seriesTypes.error || families.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const pickBtn = (selected, onClick) => (
    <button className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}`} onClick={onClick}>{selected ? 'เลือกอยู่' : 'เลือก'}</button>
  )

  // Types offered: active ones, plus any inactive type this series is already linked to.
  const linkedTypeIds = new Set((seriesTypes.data || []).filter(l => l.series_id === seriesId).map(l => l.type_id))
  const typeOptions = typePickerOptions(types.data || [], linkedTypeIds)
    .map(o => ({ id: o.id, label: o.label, note: o.hasChildren ? 'ซีรีส์จะผลิตประเภทย่อยทั้งหมดของประเภทนี้' : null }))
  const TYPE_FIELDS = typeFields(types.data || [])
  const typeLabelById = Object.fromEntries(typeOptions.map(o => [o.id, o.label]))
  const myLinks = pickedSeries ? (seriesTypes.data || []).filter(l => l.series_id === pickedSeries.id && typeLabelById[l.type_id]) : []

  const setMixed = async (link, checked) => {
    if (!canEdit) return
    const { error: err } = await supabase.from('alu_series_types').update({ allow_mixed_thickness: checked }).eq('id', link.id)
    if (err) { alert('บันทึกไม่สำเร็จ: ' + friendlyDbError(err)); return }
    seriesTypes.refetch()
  }

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
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + (typeErrorText(e) || friendlyDbError(e))) }
    finally { setSavingType(false) }
  }

  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
      <div>
      <CatalogCrud
        title="🏭 โรงรีด" table="alu_providers" fields={PROVIDER_FIELDS} rows={providers.data}
        onChanged={providers.refetch} canEdit={canEdit} deleteWarning="ลบไม่ได้ถ้ายังมีซีรีส์ หน้าตัด สี อุปกรณ์ หรือราคาของโรงรีดนี้อยู่ ให้ปิด “ใช้งานอยู่” แทน"
        addLabel="+ เพิ่มโรงรีด" emptyText="ยังไม่มีโรงรีด"
        columns={[
          { key: 'logo_path', label: 'โลโก้', render: r => <ProviderLogo url={logoUrls[r.logo_path]} name={r.name} /> },
          { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
          { key: 'short_name', label: 'ชื่อย่อ' },
          { key: 'price_basis', label: 'คิดราคา', render: r => BASIS_LABEL[r.price_basis] },
          { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
        ]}
        rowActions={r => pickBtn(r.id === providerId, () => { setProviderId(r.id); setSeriesId('') })}
      />
      {providerById[providerId] && (
        <ProviderLogoCard key={providerId} provider={providerById[providerId]} url={logoUrls[providerById[providerId].logo_path]}
          tenantId={tenant?.id} canEdit={canEdit} onChanged={providers.refetch} />
      )}
      </div>

      <div>
        {providerId && providerById[providerId] ? (
          <>
            <CatalogCrud
              title={`📚 ซีรีส์ของ ${providerById[providerId].name}`} table="alu_series" fields={seriesFields(familiesOfProvider)} rows={seriesOfProvider}
              scope={{ provider_id: providerId }} onChanged={series.refetch} canEdit={canEdit}
              deleteWarning="ลบแล้วจะลบการผูกประเภท หน้าตัด อุปกรณ์ และราคาต่อกก.ที่ทับเฉพาะซีรีส์นี้ทั้งหมดด้วย (ย้อนกลับไม่ได้) ถ้าแค่เลิกใช้ ให้ปิด “ใช้งานอยู่” แทน"
              addLabel="+ เพิ่มซีรีส์" emptyText="โรงรีดนี้ยังไม่มีซีรีส์"
              columns={[
                { key: 'name', label: 'ซีรีส์', render: r => <strong>{seriesLabelFull(r, providerById[r.provider_id])}</strong> },
                { key: 'series_family_id', label: 'ซีรีส์หลัก', render: r => familyById[r.series_family_id]?.name || '—' },
                { key: 'is_base', label: 'พื้นฐาน', render: r => (r.is_base ? '✓' : '') },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
              rowActions={r => pickBtn(r.id === seriesId, () => setSeriesId(r.id))}
            />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: -12 }}>
              ชื่อซีรีส์คือชื่อกลุ่มสินค้าของโรงรีด (เช่น ซีรีส์ 40) ไม่ใช่ชื่อหน้าตัด ชื่อหน้าตัดและ family อยู่ในแท็บหน้าตัด · ป้าย "พื้นฐาน" ใช้ทำเครื่องหมายซีรีส์หลักของโรงรีด ใช้แสดงเท่านั้น ยังไม่กระทบการคิดราคา
            </div>
            <CatalogCrud
              title={`🧩 ซีรีส์หลักของ ${providerById[providerId].name}`} table="alu_series_families" fields={FAMILY_FIELDS}
              rows={familiesOfProvider} scope={{ provider_id: providerId }} onChanged={families.refetch} canEdit={canEdit}
              validate={familyThicknessError}
              deleteWarning="ลบไม่ได้ถ้ายังมีซีรีส์อยู่ในกลุ่ม หรือมีโปรเจกต์ใช้เป็นค่าเริ่มต้น ให้ปิด “ใช้งานอยู่” แทน"
              duplicateMessage="โรงรีดนี้มีซีรีส์หลักชื่อนี้อยู่แล้ว"
              addLabel="+ เพิ่มซีรีส์หลัก" emptyText="ยังไม่มีซีรีส์หลัก (แต่ละซีรีส์เป็นซีรีส์หลักของตัวเอง)"
              columns={[
                { key: 'name', label: 'ซีรีส์หลัก', render: r => <strong>{r.name}</strong> },
                { key: 'thickness_options', label: 'ความหนาที่ให้เลือก', render: r => formatThicknessOptions(r.thickness_options) || 'ทุกความหนาของชุด' },
                { key: 'count', label: 'จำนวนชุด', render: r => seriesOfProvider.filter(s => s.series_family_id === r.id).length },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
            />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: -12 }}>
              ซีรีส์หลักคือกลุ่มของชุดที่ขายด้วยกัน (เช่น ICONIQ EURO = บานติดตาย บานเปิด บานเลื่อน) · ค่าเริ่มต้นโปรเจกต์เลือกแค่ซีรีส์หลัก แต่ละรายการได้ชุดที่ตรงประเภทเอง · ใส่ซีรีส์เข้ากลุ่มที่ปุ่ม "แก้ไข" ของซีรีส์
            </div>
          </>
        ) : (
          <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>เลือกโรงรีดทางซ้ายเพื่อดูและจัดการซีรีส์</div>
        )}
      </div>

      <div>
        {pickedSeries ? (
          <>
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
          {myLinks.length > 0 && (
            <div className="card" style={{ padding: 14, marginBottom: 16 }}>
              <div style={{ fontWeight: 600, marginBottom: 8 }}>ความหนาวงกบกับบาน</div>
              <div style={{ display: 'grid', gap: 8 }}>
                {myLinks.map(l => (
                  <div key={l.id}>
                    <div style={{ fontSize: 12, color: 'var(--text3)' }}>{typeLabelById[l.type_id]}</div>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: canEdit ? 'pointer' : 'default', fontSize: 13 }}>
                      <input type="checkbox" disabled={!canEdit} checked={!!l.allow_mixed_thickness} onChange={e => setMixed(l, e.target.checked)} />
                      อนุญาตให้วงกบกับบานใช้ความหนาต่างกัน (งานราชการ เช่น วงกบ 2.0 / บาน 1.5)
                    </label>
                  </div>
                ))}
              </div>
            </div>
          )}
          </>
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
