// src/pages/aluCatalog/ProfilesTab.jsx
// Per extruder: profiles (cross-section + thickness + weight, one row = one thickness),
// colours, the stock lengths sold per profile x colour, and which series use which
// profile (with its role/family).
import { useState } from 'react'
import { useCatalogTable } from '../../hooks/useAluCatalog.js'
import CatalogCrud, { ActiveBadge } from '../../components/CatalogCrud.jsx'
import LinkEditor from '../../components/LinkEditor.jsx'
import { optionList } from '../../lib/catalogForm.js'
import { seriesLabelFull } from '../../lib/aluCatalog.js'
import AttachmentsSection from '../../components/AttachmentsSection.jsx'
import { useTenant } from '../../hooks/useTenant.js'
import { supabase } from '../../lib/supabase.js'
import { jointDeductionMm } from '../../lib/assembly.js'
import { profileSketchSvg } from '../../lib/profileSketch.js'
import { sketchShapeFor, sameShapeProfiles } from '../../lib/catalogTypeForm.js'

const PROFILE_FIELDS = [
  { key: 'name', label: 'ชื่อหน้าตัด', type: 'text', required: true, placeholder: 'เช่น กล่องร่อง' },
  { key: 'drawing_no', label: 'DIE NO. (รหัสแม่พิมพ์ของโรงรีด)', type: 'text' },
  { key: 'shape_group', label: 'กลุ่มรูปร่าง เช่น กล่องเรียบ', type: 'text', placeholder: 'เช่น กล่องเรียบ' },
  { key: 'family', label: 'กลุ่ม (family) สำหรับผูก BOM template', type: 'text', placeholder: 'เช่น กล่องร่อง' },
  { key: 'thickness_mm', label: 'ความหนา (มม.)', type: 'number', min: 0 },
  { key: 'linear_weight_kg_per_m', label: 'น้ำหนัก (กก./เมตร)', type: 'number', required: true, min: 0, step: '0.0001' },
  { key: 'width_mm', label: 'ความกว้างรวมหน้าตัด (มม.)', type: 'number', min: 0, step: '0.01' },
  { key: 'depth_mm', label: 'ความสูง/ลึกรวมหน้าตัด (มม.)', type: 'number', min: 0, step: '0.01' },
  { key: 'primary_contact', label: 'พื้นผิวสัมผัสหลัก (หน้าที่เส้นรองมาชน)', type: 'select', required: true, default: 'width',
    options: [
      { value: 'width', label: 'หน้ากว้าง เช่น 101.6 (ปกติ) — เส้นรองหักตามความสูง/ลึก' },
      { value: 'depth', label: 'หน้าแคบ — เส้นรองหักตามความกว้าง' },
    ],
    hint: form => {
      const r = jointDeductionMm({}, { width_mm: form.width_mm, depth_mm: form.depth_mm, primary_contact: form.primary_contact })
      return r.mm ? `เส้นรองจะหักข้างละ ${r.mm} มม.` : 'กรอกความกว้างและความสูง/ลึก เพื่อดูค่าหักที่จุดชน'
    } },
  { key: 'default_length_m', label: 'ความยาวมาตรฐาน (เมตร)', type: 'number', default: 6.4, min: 0 },
  { key: 'image_url', label: 'ลิงก์รูปหน้าตัด', type: 'text' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

const FINISH_FIELDS = [
  { key: 'name', label: 'ชื่อสี', type: 'text', required: true, placeholder: 'เช่น ขาว, อโนไดซ์ดำ' },
  { key: 'code', label: 'รหัสสีของโรงรีด', type: 'text' },
  { key: 'active', label: 'ใช้งานอยู่', type: 'checkbox', default: true },
]

// management selectors list every row, inactive ones tagged, so nothing becomes unreachable
const withInactiveTag = (rows, labelFn) => (rows || []).map(r => ({ value: r.id, label: labelFn(r) + (r.active === false ? ' (ปิดใช้งาน)' : '') }))

const noWeight = p => !(Number(p.linear_weight_kg_per_m) > 0)

export default function ProfilesTab({ canEdit }) {
  const providers = useCatalogTable('alu_providers')
  const profiles = useCatalogTable('alu_profiles')
  const finishes = useCatalogTable('alu_finishes')
  const variants = useCatalogTable('alu_profile_variants', 'id')
  const series = useCatalogTable('alu_series')
  const seriesProfiles = useCatalogTable('alu_series_profiles', 'id')
  const { tenant } = useTenant()
  const [providerId, setProviderId] = useState('')
  const [profileId, setProfileId] = useState('')
  const [seriesId, setSeriesId] = useState('')

  const error = providers.error || profiles.error || finishes.error || variants.error || series.error || seriesProfiles.error
  if (error) return <div style={{ color: 'var(--red)' }}>โหลดข้อมูลไม่สำเร็จ: {error}</div>

  const provider = (providers.data || []).find(p => p.id === providerId)
  const myProfiles = (profiles.data || []).filter(p => p.provider_id === providerId)
  const myFinishes = (finishes.data || []).filter(f => f.provider_id === providerId)
  const mySeries = (series.data || []).filter(s => s.provider_id === providerId)
  const pickedProfile = myProfiles.find(p => p.id === profileId)
  // a selection whose row vanished (deleted, or other provider) must not linger
  if (profileId && profiles.data && !pickedProfile) setProfileId('')
  if (seriesId && series.data && !mySeries.some(s => s.id === seriesId)) setSeriesId('')
  const profileName = Object.fromEntries(myProfiles.map(p => [p.id, p.name + (p.thickness_mm ? ` ${p.thickness_mm} มม.` : '')]))
  const finishName = Object.fromEntries(myFinishes.map(f => [f.id, f.name]))
  const profileVariants = (variants.data || []).filter(v => v.profile_id === profileId)
  const usedBy = (seriesProfiles.data || [])
    .filter(l => l.profile_id === profileId)
    .map(l => ({ link: l, s: mySeries.find(s => s.id === l.series_id) }))
    .filter(x => x.s)

  const sketch = pickedProfile ? profileSketchSvg({
    width_mm: pickedProfile.width_mm, depth_mm: pickedProfile.depth_mm, wall_mm: pickedProfile.thickness_mm,
    shape: sketchShapeFor(pickedProfile.shape_group),
  }) : ''
  const sameShape = pickedProfile ? sameShapeProfiles(profiles.data, pickedProfile) : []

  // Deleting a profile cascades its file rows but not the stored objects: remove those first.
  const removeProfileFiles = async (row) => {
    const { data, error: e1 } = await supabase.from('alu_profile_files').select('file_path').eq('profile_id', row.id)
    if (e1) throw e1
    const paths = (data || []).map(f => f.file_path)
    if (!paths.length) return
    const { error: e2 } = await supabase.storage.from('alu-profile-files').remove(paths)
    if (e2) throw e2
  }

  const VARIANT_FIELDS = [
    { key: 'finish_id', label: 'สี', type: 'select', required: true, options: form => optionList(myFinishes, f => f.name, form.finish_id) },
    { key: 'length_m', label: 'ความยาวเส้น (เมตร)', type: 'number', required: true, min: 0 },
  ]

  const linkedProfileIds = new Set((seriesProfiles.data || []).filter(l => l.series_id === seriesId).map(l => l.profile_id))
  const linkOptions = myProfiles
    .filter(p => p.active !== false || linkedProfileIds.has(p.id))
    .map(p => ({ id: p.id, label: p.active === false ? `${profileName[p.id]} (ปิดใช้งาน)` : profileName[p.id] }))

  const pickBtn = (selected, onClick) => (
    <button className={`btn btn-sm ${selected ? 'btn-primary' : 'btn-ghost'}`} onClick={onClick}>{selected ? 'เลือกอยู่' : 'เลือก'}</button>
  )
  const emptyCard = text => <div className="card" style={{ padding: 24, textAlign: 'center', color: 'var(--text3)' }}>{text}</div>

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <label className="label">เลือกโรงรีด</label>
        <select className="input" style={{ maxWidth: 320 }} value={providerId}
          onChange={e => { setProviderId(e.target.value); setProfileId(''); setSeriesId('') }}>
          <option value="">— เลือกโรงรีด —</option>
          {withInactiveTag(providers.data, p => p.name).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
        </select>
        <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6, maxWidth: 560 }}>
          สีเป็นของแต่ละโรงรีด ไม่ใช้ร่วมกัน · หน้าตัด 1 แถว = 1 ความหนา (ความหนาและน้ำหนักอยู่แถวเดียวกัน) · ราคาต่อกก. กรอกที่แท็บ "ราคา"
        </div>
      </div>
      {!providerId && <div style={{ color: 'var(--text3)' }}>เลือกโรงรีดก่อน แล้วจึงเพิ่มหน้าตัด สี และความยาว</div>}

      {providerId && (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(320px, 1fr))', gap: 16, alignItems: 'start' }}>
          <div>
            <CatalogCrud
              title="📏 หน้าตัดอลูมิเนียม" table="alu_profiles" fields={PROFILE_FIELDS} rows={myProfiles}
              scope={{ provider_id: providerId }} onChanged={profiles.refetch} canEdit={canEdit}
              deleteWarning="ลบแล้วจะลบความยาว/สี การผูกกับซีรีส์ และราคาของหน้าตัดนี้ทั้งหมดด้วย (ย้อนกลับไม่ได้) ถ้าแค่เลิกใช้ ให้ปิด “ใช้งานอยู่” แทน"
              addLabel="+ เพิ่มหน้าตัด" emptyText="โรงรีดนี้ยังไม่มีหน้าตัด" beforeDelete={removeProfileFiles}
              columns={[
                { key: 'name', label: 'ชื่อ', render: r => (
                  <span><strong>{r.name}</strong>{r.family ? <div style={{ fontSize: 11, color: 'var(--text3)' }}>กลุ่ม: {r.family}</div> : null}</span>
                ) },
                { key: 'drawing_no', label: 'DIE NO.' },
                { key: 'thickness_mm', label: 'หนา (มม.)' },
                { key: 'linear_weight_kg_per_m', label: 'กก./ม.', render: r => (
                  noWeight(r)
                    ? <span className="badge badge-rejected">ไม่มีน้ำหนัก</span>
                    : r.linear_weight_kg_per_m
                ) },
                { key: 'default_length_m', label: 'ยาวมาตรฐาน (ม.)' },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
              rowActions={r => pickBtn(r.id === profileId, () => setProfileId(r.id))}
            />
            <CatalogCrud
              title={`🎨 สีของ ${provider ? provider.name : 'โรงรีด'}`} table="alu_finishes" fields={FINISH_FIELDS} rows={myFinishes}
              scope={{ provider_id: providerId }} onChanged={finishes.refetch} canEdit={canEdit}
              deleteWarning="ลบไม่ได้ถ้ายังมีความยาวเส้นหรือราคาต่อกก.ที่ใช้สีนี้อยู่ ให้ปิด “ใช้งานอยู่” แทน"
              addLabel="+ เพิ่มสี" emptyText="โรงรีดนี้ยังไม่มีสี"
              columns={[
                { key: 'name', label: 'ชื่อสี', render: r => <strong>{r.name}</strong> },
                { key: 'code', label: 'รหัส' },
                { key: 'active', label: 'สถานะ', render: r => <ActiveBadge active={r.active} /> },
              ]}
            />
          </div>

          <div>
            {pickedProfile ? (
              <>
                <div style={{ fontSize: 12, color: 'var(--text3)', marginBottom: 6 }}>สี/ความยาวแก้ไม่ได้ ถ้าผิดให้ลบแล้วเพิ่มใหม่ (ราคาต่อเส้นของแถวที่ลบจะถูกลบด้วย)</div>
                <CatalogCrud
                  title={`📐 สี × ความยาวเส้น · ${profileName[pickedProfile.id]}`} table="alu_profile_variants" fields={VARIANT_FIELDS} rows={profileVariants}
                  scope={{ profile_id: profileId }} onChanged={variants.refetch} canEdit={canEdit} allowEdit={false}
                  deleteWarning="ลบแล้วจะลบราคาต่อเส้นของสีและความยาวนี้ทั้งหมดด้วย (ย้อนกลับไม่ได้)"
                  duplicateMessage="หน้าตัดนี้มีสีและความยาวนี้อยู่แล้ว"
                  addLabel="+ เพิ่มความยาว" emptyText="ยังไม่มีความยาวเส้น (จำเป็นเมื่อโรงรีดคิดราคาต่อเส้น)"
                  columns={[
                    { key: 'finish_id', label: 'สี', render: r => finishName[r.finish_id] || '—' },
                    { key: 'length_m', label: 'ยาว (ม.)' },
                  ]}
                />
                <div className="card" style={{ padding: 14, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>ภาพหน้าตัดคร่าวๆ จากมิติ · {profileName[pickedProfile.id]}</div>
                  {sketch
                    ? <div style={{ maxWidth: 240 }} dangerouslySetInnerHTML={{ __html: sketch }} />
                    : <div style={{ color: 'var(--text3)', fontSize: 13 }}>กรอกความกว้างและความสูง/ลึกของหน้าตัดเพื่อดูภาพ</div>}
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>ภาพที่ระบบวาดจากมิติเป็นแบบคร่าวๆ ใช้ดูสัดส่วน ส่วนรายละเอียดจริงดูจากไฟล์แบบที่แนบ</div>
                  {pickedProfile.shape_group && (
                    <div style={{ marginTop: 10 }}>
                      <div style={{ fontWeight: 600, fontSize: 13, marginBottom: 4 }}>{pickedProfile.shape_group}: หน้าตัดอื่นในกลุ่มรูปร่างเดียวกัน (1 DIE NO. = 1 รายการ)</div>
                      {sameShape.length ? (
                        <div className="table-wrap"><table>
                          <thead><tr><th>DIE NO.</th><th>T (มม.)</th><th>น้ำหนัก (กก./ม.)</th></tr></thead>
                          <tbody>{sameShape.map(p => (
                            <tr key={p.id}><td>{p.drawing_no || '—'}</td><td>{p.thickness_mm ?? '—'}</td><td>{p.linear_weight_kg_per_m ?? '—'}</td></tr>
                          ))}</tbody>
                        </table></div>
                      ) : <div style={{ color: 'var(--text3)', fontSize: 12 }}>ยังไม่มีหน้าตัดอื่นในกลุ่มนี้</div>}
                    </div>
                  )}
                </div>
                <div className="card" style={{ padding: 14, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>แนบไฟล์แบบ · {profileName[pickedProfile.id]}</div>
                  {tenant?.id && canEdit ? (
                    <AttachmentsSection key={pickedProfile.id} table="alu_profile_files" bucket="alu-profile-files" foreignKey="profile_id" entityId={pickedProfile.id}
                      tenantId={tenant.id} accept=".pdf,.dwg,.dxf,.svg,.png,.jpg,.jpeg" />
                  ) : <div style={{ color: 'var(--text3)', fontSize: 12 }}>เฉพาะผู้มีสิทธิ์แก้ไขแคตตาล็อกเท่านั้นที่แนบไฟล์ได้</div>}
                  <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 6 }}>1 ไฟล์ = 1 หน้าตัด แยกไฟล์ catalog/DWG ก่อนอัปโหลด · เก็บและดาวน์โหลดเท่านั้น ไม่มีภาพตัวอย่างของไฟล์ DWG</div>
                </div>
                <div className="card" style={{ padding: 14, marginBottom: 16 }}>
                  <div style={{ fontWeight: 600, marginBottom: 8 }}>ซีรีส์ที่ใช้หน้าตัดนี้</div>
                  {usedBy.length ? usedBy.map(({ link, s }) => (
                    <div key={link.id} style={{ fontSize: 13, marginBottom: 4 }}>
                      {seriesLabelFull(s, provider)}
                      <span style={{ color: 'var(--text3)' }}> · บทบาท: {link.family || '—'}</span>
                    </div>
                  )) : <div style={{ color: 'var(--text3)' }}>ยังไม่มีซีรีส์ใช้หน้าตัดนี้</div>}
                </div>
              </>
            ) : emptyCard('เลือกหน้าตัดทางซ้ายเพื่อดูสีและความยาวเส้น')}

            <div style={{ margin: '8px 0' }}>
              <label className="label">เลือกซีรีส์เพื่อกำหนดหน้าตัดที่ใช้</label>
              <select className="input" style={{ maxWidth: 320 }} value={seriesId} onChange={e => setSeriesId(e.target.value)}>
                <option value="">— เลือกซีรีส์ —</option>
                {withInactiveTag(mySeries, s => seriesLabelFull(s, provider)).map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            {seriesId && (
              <LinkEditor
                title="หน้าตัดที่ซีรีส์นี้ใช้" hint="ช่อง 'บทบาท' คือ family ที่ BOM template ใช้ค้นหา (หน้าตัดเดียวกันใช้คนละบทบาทในต่างซีรีส์ได้)"
                linkTable="alu_series_profiles" parentKey="series_id" parentId={seriesId} childKey="profile_id"
                childOptions={linkOptions}
                links={seriesProfiles.data} onChanged={seriesProfiles.refetch} canEdit={canEdit}
                duplicateMessage="ซีรีส์นี้ใช้หน้าตัดนี้อยู่แล้ว"
                extra={{ key: 'family', label: 'บทบาท (family)', type: 'text', defaultFor: child => (myProfiles.find(p => p.id === child.id)?.family || null) }}
              />
            )}
          </div>
        </div>
      )}
    </div>
  )
}
