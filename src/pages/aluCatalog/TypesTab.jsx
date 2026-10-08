// src/pages/aluCatalog/TypesTab.jsx
// Door/window types shared by every extruder (บานเลื่อน บานเปิด …) and our own labour rate.
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'

export const TYPE_FIELDS = [
  { key: 'name', label: 'ชื่อประเภท', type: 'text', required: true, placeholder: 'เช่น บานเลื่อน' },
  { key: 'category', label: 'ประเภทหลัก', type: 'select', required: true, default: 'window',
    options: [{ value: 'door', label: 'ประตู' }, { value: 'window', label: 'หน้าต่าง' }] },
  { key: 'default_labour_per_sqm', label: 'เรทค่าแรง (บาท/ตร.ม.) · ค่าแรง = เรท × พื้นที่', type: 'number', min: 0,
    hint: 'เรทค่าแรงของเราเอง ไม่ได้นำเข้าจากโรงรีด' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

export default function TypesTab({ canEdit }) {
  const types = useCatalogTable('door_window_types')
  if (types.error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {types.error}</div>
  return (
    <CatalogCrud
      title="🚪 ประเภทบาน" table="door_window_types" fields={TYPE_FIELDS} rows={types.data}
      onChanged={types.refetch} canEdit={canEdit} deleteWarning="ลบแล้วจะลบการผูกประเภทนี้กับซีรีส์ และการจำกัดประเภทของอุปกรณ์ในซีรีส์ทั้งหมดด้วย (ย้อนกลับไม่ได้) ถ้าแค่เลิกใช้ ให้ปิด “ใช้งานอยู่” แทน"
      addLabel="+ เพิ่มประเภท" emptyText="ยังไม่มีประเภทบาน"
      columns={[
        { key: 'name', label: 'ชื่อ', render: r => <strong>{r.name}</strong> },
        { key: 'category', label: 'ประเภทหลัก', render: r => (r.category === 'door' ? 'ประตู' : 'หน้าต่าง') },
        { key: 'default_labour_per_sqm', label: 'เรทค่าแรง บาท/ตร.ม.' },
        { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
      ]}
    />
  )
}
