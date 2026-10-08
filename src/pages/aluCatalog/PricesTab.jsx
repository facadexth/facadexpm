// src/pages/aluCatalog/PricesTab.jsx
// Price history. Rows are added, never overwritten: a new price is a new row with a later
// effective date, and the newest row on or before a date is the price for that date.
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud from '../../components/CatalogCrud.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import { priceStatuses, STATUS_CURRENT, STATUS_PENDING } from '../../lib/aluPriceStatus.js'

// local calendar date (en-CA formats as YYYY-MM-DD); toISOString would give yesterday's date before 07:00 in Thailand
const todayStr = () => new Date().toLocaleDateString('en-CA')

function StatusPill({ status }) {
  if (status === STATUS_CURRENT) return <span className="badge badge-paid">ใช้อยู่</span>
  if (status === STATUS_PENDING) return <span className="badge badge-onhold">รอมีผล</span>
  return <span className="badge badge-finished">เก่า</span>
}

export default function PricesTab({ canEdit }) {
  const [asOf, setAsOf] = useState(todayStr)
  const providers = useCatalogTable('alu_providers')
  const finishes = useCatalogTable('alu_finishes')
  const series = useCatalogTable('alu_series')
  const profiles = useCatalogTable('alu_profiles')
  const variants = useCatalogTable('alu_profile_variants', 'id')
  const parts = useCatalogTable('alu_parts')
  const kgPrices = useCatalogTable('alu_kg_prices', 'effective_from', false)
  const piecePrices = useCatalogTable('alu_piece_prices', 'effective_from', false)
  const partPrices = useCatalogTable('alu_part_prices', 'effective_from', false)

  const all = [providers, finishes, series, profiles, variants, parts, kgPrices, piecePrices, partPrices]
  const error = all.map(q => q.error).find(Boolean)
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const providerById = Object.fromEntries((providers.data || []).map(p => [p.id, p]))
  const finishById = Object.fromEntries((finishes.data || []).map(f => [f.id, f]))
  const seriesById = Object.fromEntries((series.data || []).map(s => [s.id, s]))
  const profileById = Object.fromEntries((profiles.data || []).map(p => [p.id, p]))
  const variantById = Object.fromEntries((variants.data || []).map(v => [v.id, v]))
  const partById = Object.fromEntries((parts.data || []).map(p => [p.id, p]))
  const money = n => (n == null ? '—' : Number(n).toLocaleString('th-TH', { maximumFractionDigits: 4 }))
  const profileLabel = p => (p ? `${p.name}${p.thickness_mm ? ' ' + p.thickness_mm : ''}` : '—')
  const variantLabel = v => (v ? `${profileLabel(profileById[v.profile_id])} · ${finishById[v.finish_id]?.name || '—'} · ${v.length_m} ม.` : '—')

  const kgStatus = priceStatuses(kgPrices.data, r => [r.provider_id, r.finish_id, r.series_id, r.profile_id].join('|'), asOf)
  const pieceStatus = priceStatuses(piecePrices.data, r => r.variant_id, asOf)
  const partStatus = priceStatuses(partPrices.data, r => r.part_id, asOf)
  const statusCol = map => ({ key: 'status', label: 'สถานะ', render: r => <StatusPill status={map.get(r.id)} /> })

  const KG_FIELDS = [
    { key: 'provider_id', label: 'โรงรีด', type: 'select', required: true, clears: ['finish_id', 'series_id', 'profile_id'], options: form => optionList(providers.data, p => p.name, form.provider_id) },
    { key: 'finish_id', label: 'สี', type: 'select', required: true,
      options: form => optionList((finishes.data || []).filter(f => f.provider_id === form.provider_id), f => f.name, form.finish_id) },
    { key: 'series_id', label: 'ทับเฉพาะซีรีส์ (ไม่บังคับ)', type: 'select',
      options: form => optionList((series.data || []).filter(s => s.provider_id === form.provider_id), s => seriesLabelFull(s, providerById[s.provider_id]), form.series_id) },
    { key: 'profile_id', label: 'ทับเฉพาะหน้าตัด (ไม่บังคับ)', type: 'select',
      options: form => optionList((profiles.data || []).filter(p => p.provider_id === form.provider_id), profileLabel, form.profile_id) },
    { key: 'price_per_kg', label: 'ราคา (บาท/กก.)', type: 'number', required: true, min: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const PIECE_FIELDS = [
    { key: 'variant_id', label: 'หน้าตัด · สี · ความยาว', type: 'select', required: true,
      options: () => (variants.data || []).map(v => ({ value: v.id, label: variantLabel(v) })) },
    { key: 'price_per_piece', label: 'ราคา (บาท/เส้น)', type: 'number', required: true, min: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const PART_FIELDS = [
    { key: 'part_id', label: 'อุปกรณ์', type: 'select', required: true, options: form => optionList(parts.data, p => p.name, form.part_id) },
    { key: 'list_price', label: 'ราคาป้าย', type: 'number', required: true, min: 0 },
    { key: 'discount_pct', label: 'ส่วนลด (%)', type: 'number', min: 0, default: 0, blankAs: 0 },
    { key: 'effective_from', label: 'มีผลตั้งแต่วันที่', type: 'date', required: true, default: todayStr() },
  ]
  const validateKg = form => {
    if (form.series_id && form.profile_id) return 'เลือกทับได้อย่างใดอย่างหนึ่ง: ซีรีส์ หรือ หน้าตัด'
    const wrong = (id, byId) => id && byId[id]?.provider_id !== form.provider_id
    if (wrong(form.finish_id, finishById) || wrong(form.series_id, seriesById) || wrong(form.profile_id, profileById)) {
      return 'สี/ซีรีส์/หน้าตัดที่เลือกไม่ใช่ของโรงรีดนี้ กรุณาเลือกใหม่'
    }
    return null
  }
  const validateDiscount = form => (Number(form.discount_pct) > 100 ? 'ส่วนลดต้องไม่เกิน 100%' : null)

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        <label className="label" style={{ margin: 0 }}>ดูราคา ณ วันที่</label>
        <input className="input" type="date" style={{ width: 170 }} value={asOf} onChange={e => setAsOf(e.target.value || todayStr())} />
        <span style={{ fontSize: 12, color: 'var(--text3)' }}>ราคาใหม่ = เพิ่มแถวใหม่ที่มีวันที่มีผลใหม่ ระบบเก็บประวัติเดิมไว้</span>
        <div style={{ width: '100%', fontSize: 12, color: 'var(--text3)' }}>ราคาเก่าแก้ไม่ได้ ถ้าราคาเปลี่ยนให้เพิ่มแถวใหม่พร้อมวันที่เริ่มใช้ (ลบได้เฉพาะกรณีกรอกผิด)</div>
      </div>
      <CatalogCrud
        title="⚖️ ราคาต่อกก. (โรงรีด × สี)" table="alu_kg_prices" fields={KG_FIELDS} rows={kgPrices.data}
        onChanged={kgPrices.refetch} canEdit={canEdit} allowEdit={false} addLabel="+ เพิ่มราคา" validate={validateKg}
        deleteWarning="ลบแถวราคานี้แถวเดียว (ไม่กระทบแถวอื่นหรือข้อมูลอื่น) ลบเฉพาะกรณีกรอกผิด ถ้าราคาเปลี่ยนให้เพิ่มแถวใหม่แทน (ย้อนกลับไม่ได้)"
        duplicateMessage="มีราคาของโรงรีด สี และขอบเขตนี้ในวันที่มีผลเดียวกันอยู่แล้ว"
        emptyText="ยังไม่มีราคา เพิ่มราคาใหม่โดยใช้วันที่มีผลใหม่ ระบบเก็บประวัติให้"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'provider_id', label: 'โรงรีด', render: r => providerById[r.provider_id]?.name },
          { key: 'finish_id', label: 'สี', render: r => finishById[r.finish_id]?.name },
          { key: 'scope', label: 'ทับเฉพาะ', render: r => (r.profile_id ? `หน้าตัด ${profileLabel(profileById[r.profile_id])}` : r.series_id ? `ซีรีส์ ${seriesLabelFull(seriesById[r.series_id] || { name: '—' }, providerById[r.provider_id])}` : 'ทั้งโรงรีด') },
          { key: 'price_per_kg', label: 'บาท/กก.', render: r => money(r.price_per_kg) },
          statusCol(kgStatus),
        ]}
      />
      <CatalogCrud
        title="📏 ราคาต่อเส้น" table="alu_piece_prices" fields={PIECE_FIELDS} rows={piecePrices.data}
        onChanged={piecePrices.refetch} canEdit={canEdit} allowEdit={false} addLabel="+ เพิ่มราคา"
        deleteWarning="ลบแถวราคานี้แถวเดียว (ไม่กระทบแถวอื่นหรือข้อมูลอื่น) ลบเฉพาะกรณีกรอกผิด ถ้าราคาเปลี่ยนให้เพิ่มแถวใหม่แทน (ย้อนกลับไม่ได้)"
        duplicateMessage="มีราคาของหน้าตัด สี และความยาวนี้ในวันที่มีผลเดียวกันอยู่แล้ว"
        emptyText="ยังไม่มีราคาต่อเส้น (ต้องเพิ่มความยาวเส้นที่แท็บ 'หน้าตัด · สี · ความยาว' ก่อน)"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'variant_id', label: 'หน้าตัด · สี · ความยาว', render: r => variantLabel(variantById[r.variant_id]) },
          { key: 'price_per_piece', label: 'บาท/เส้น', render: r => money(r.price_per_piece) },
          statusCol(pieceStatus),
        ]}
      />
      <CatalogCrud
        title="🔩 ราคาอุปกรณ์" table="alu_part_prices" fields={PART_FIELDS} rows={partPrices.data}
        onChanged={partPrices.refetch} canEdit={canEdit} allowEdit={false} addLabel="+ เพิ่มราคา" validate={validateDiscount}
        deleteWarning="ลบแถวราคานี้แถวเดียว (ไม่กระทบแถวอื่นหรือข้อมูลอื่น) ลบเฉพาะกรณีกรอกผิด ถ้าราคาเปลี่ยนให้เพิ่มแถวใหม่แทน (ย้อนกลับไม่ได้)"
        duplicateMessage="มีราคาของอุปกรณ์นี้ในวันที่มีผลเดียวกันอยู่แล้ว"
        emptyText="ยังไม่มีราคาอุปกรณ์"
        columns={[
          { key: 'effective_from', label: 'มีผลตั้งแต่' },
          { key: 'part_id', label: 'อุปกรณ์', render: r => partById[r.part_id]?.name },
          { key: 'list_price', label: 'ราคาป้าย', render: r => money(r.list_price) },
          { key: 'discount_pct', label: 'ลด %' },
          { key: 'net', label: 'ราคาสุทธิ', render: r => money(Number(r.list_price) * (1 - Number(r.discount_pct) / 100)) },
          statusCol(partStatus),
        ]}
      />
    </div>
  )
}
