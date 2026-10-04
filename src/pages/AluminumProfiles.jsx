// ============================================================
// AluminumProfiles -- master list of aluminium cross-sections (หน้าตัดอลูมิเนียม).
// Lives inside ประเมินราคา > BOM Templates (FacadeX only). Moved here from the คลังสินค้า page; the table
// (aluminum_profiles) is unchanged and still feeds BOM templates and PO receiving.
// ============================================================
import { useState, useMemo } from 'react'
import { supabase, fmt } from '../lib/supabase.js'
import { useAllAluminumProfiles } from '../hooks/useSupabase.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { canEditPage } from '../lib/permissions.js'
import { Modal, ConfirmDialog } from '../components/Modal.jsx'
import { useDraftForm } from '../hooks/useDraftForm.js'
import ExcelUpload from '../components/ExcelUpload.jsx'

const EMPTY_PROFILE_FORM = { name: '', family: '', series: '', thickness_mm: '', linear_weight_kg_per_m: '', default_length_m: '6.4' }

function ProfileForm({ initial = EMPTY_PROFILE_FORM, onSave, onCancel, loading }) {
  const isAdd = !initial?.id
  const [form, setForm, clearDraft] = useDraftForm('aluminum-profile-form', { ...EMPTY_PROFILE_FORM, ...initial }, isAdd)
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }))

  return (
    <form onSubmit={e => { e.preventDefault(); clearDraft(); onSave(form) }}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        <div>
          <label className="label">ชื่อหน้าตัด ★</label>
          <input className="input" required value={form.name} onChange={e => set('name', e.target.value)} placeholder="เช่น หน้าตัด X" />
        </div>
        <div>
          <label className="label">กลุ่มหน้าตัด (family) — สำหรับผูกกับ BOM Template</label>
          <input className="input" value={form.family} onChange={e => set('family', e.target.value)} placeholder="เช่น กล่องร่อง" />
        </div>
        <div>
          <label className="label">รุ่น/ซีรีส์ (series)</label>
          <input className="input" value={form.series} onChange={e => set('series', e.target.value)} placeholder="เช่น ทั่วไป, ยูโร, วิสดอม" />
        </div>
        <div>
          <label className="label">ความหนา (มม.)</label>
          <input className="input" type="number" min="0" step="0.1" value={form.thickness_mm} onChange={e => set('thickness_mm', e.target.value)} placeholder="เช่น 1.2" />
        </div>
        <div>
          <label className="label">น้ำหนัก (กก./เมตร) ★</label>
          <input className="input" required type="number" min="0" step="0.0001" value={form.linear_weight_kg_per_m}
            onChange={e => set('linear_weight_kg_per_m', e.target.value)} />
        </div>
        <div>
          <label className="label">ความยาวมาตรฐาน (เมตร)</label>
          <input className="input" type="number" min="0" step="0.01" value={form.default_length_m}
            onChange={e => set('default_length_m', e.target.value)} placeholder="ค่าเริ่มต้น 6.4" />
        </div>
        {!isAdd && (
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', fontSize: 13 }}>
            <input type="checkbox" checked={form.active} onChange={e => set('active', e.target.checked)} />
            ใช้งานอยู่
          </label>
        )}
      </div>
      <div className="modal-footer">
        <button type="button" className="btn btn-ghost" onClick={() => { clearDraft(); onCancel() }}>ยกเลิก</button>
        <button type="submit" className="btn btn-primary" disabled={loading}>
          {loading ? '⏳ กำลังบันทึก...' : '✅ บันทึก'}
        </button>
      </div>
    </form>
  )
}

export default function AluminumProfiles() {
  const { isAtLeast, role } = useUserRole()
  const canEdit = isAtLeast('ADMIN') && canEditPage(role, 'estimation')
  const { data: profiles, refetch: refetchProfiles } = useAllAluminumProfiles()
  const [profileSearch, setProfileSearch] = useState('')
  const [profileSortCol, setProfileSortCol] = useState('name')
  const [profileSortDir, setProfileSortDir] = useState('asc')
  const [showProfileForm, setShowProfileForm] = useState(false)
  const [editProfile, setEditProfile] = useState(null)
  const [deleteProfileId, setDeleteProfileId] = useState(null)
  const [savingProfile, setSavingProfile] = useState(false)
  const [showImportProfiles, setShowImportProfiles] = useState(false)

  const profileToggleSort = (col) => {
    if (profileSortCol === col) setProfileSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setProfileSortCol(col); setProfileSortDir('asc') }
  }
  const profileSi = (col) => profileSortCol === col ? (profileSortDir === 'asc' ? ' ↑' : ' ↓') : ' ↕'

  const sortedProfiles = useMemo(() => {
    const q = profileSearch.trim().toLowerCase()
    const rows = (profiles || []).filter(p => !q || p.name?.toLowerCase().includes(q))
    return [...rows].sort((a, b) => {
      const va = a[profileSortCol] ?? ''
      const vb = b[profileSortCol] ?? ''
      if (typeof va === 'number') return profileSortDir === 'asc' ? va - vb : vb - va
      if (typeof va === 'boolean') return profileSortDir === 'asc' ? (va === vb ? 0 : va ? 1 : -1) : (va === vb ? 0 : va ? -1 : 1)
      return profileSortDir === 'asc' ? String(va).localeCompare(String(vb)) : String(vb).localeCompare(String(va))
    })
  }, [profiles, profileSearch, profileSortCol, profileSortDir])

  const handleSaveProfile = async (form) => {
    setSavingProfile(true)
    try {
      const payload = {
        name: form.name,
        family: form.family || null,
        series: form.series || null,
        thickness_mm: form.thickness_mm ? parseFloat(form.thickness_mm) : null,
        linear_weight_kg_per_m: parseFloat(form.linear_weight_kg_per_m) || 0,
        default_length_m: form.default_length_m ? parseFloat(form.default_length_m) : 6.4,
        active: form.active !== false,
      }
      if (editProfile) {
        const { error } = await supabase.from('aluminum_profiles').update(payload).eq('id', editProfile.id)
        if (error) throw error
      } else {
        const { error } = await supabase.from('aluminum_profiles').insert(payload)
        if (error) throw error
      }
      setShowProfileForm(false); setEditProfile(null); refetchProfiles()
    } catch (e) { alert('บันทึกไม่สำเร็จ: ' + e.message) }
    finally { setSavingProfile(false) }
  }

  const handleDeleteProfile = async () => {
    if (!deleteProfileId) return
    const { error } = await supabase.from('aluminum_profiles').delete().eq('id', deleteProfileId)
    if (!error) { setDeleteProfileId(null); refetchProfiles() }
    else alert('ลบไม่สำเร็จ (อาจมีใบสั่งซื้อผูกอยู่): ' + error.message)
  }

  return (
    <div>

        <>
          {canEdit && <button className="btn btn-primary" style={{ marginBottom: 14 }} onClick={() => { setEditProfile(null); setShowProfileForm(true) }}>+ เพิ่มหน้าตัด</button>}
          {canEdit && <button className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} onClick={() => setShowImportProfiles(v => !v)}>📥 Import Excel</button>}
          <a className="btn btn-ghost" style={{ marginBottom: 14, marginLeft: 8 }} href="/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx" download>📄 Template</a>
          {showImportProfiles && (
            <div style={{ marginBottom: 14 }}>
              <ExcelUpload type="aluminum_profile" onSuccess={() => { setShowImportProfiles(false); refetchProfiles() }} />
            </div>
          )}
          <div style={{ marginBottom: 14 }}>
            <input className="input input-sm" style={{ width: 200 }} placeholder="ค้นหาชื่อหน้าตัด..." value={profileSearch} onChange={e => setProfileSearch(e.target.value)} />
          </div>
          <div className="card">
            <div className="table-wrap">
              <table>
                <thead><tr>
                  <th className="sortable" onClick={() => profileToggleSort('name')}>ชื่อหน้าตัด{profileSi('name')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('family')}>กลุ่ม{profileSi('family')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('series')}>รุ่น{profileSi('series')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('thickness_mm')}>หนา (มม.){profileSi('thickness_mm')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('linear_weight_kg_per_m')}>กก./เมตร{profileSi('linear_weight_kg_per_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('default_length_m')}>ความยาวมาตรฐาน{profileSi('default_length_m')}</th>
                  <th className="sortable" onClick={() => profileToggleSort('active')}>สถานะ{profileSi('active')}</th>
                  <th></th>
                </tr></thead>
                <tbody>
                  {sortedProfiles.map(p => (
                    <tr key={p.id}>
                      <td style={{ fontWeight: 600 }}>{p.name}</td>
                      <td>{p.family || '—'}</td>
                      <td>{p.series || '—'}</td>
                      <td className="font-mono">{p.thickness_mm ?? '—'}</td>
                      <td className="font-mono">{fmt(p.linear_weight_kg_per_m)}</td>
                      <td className="font-mono">{fmt(p.default_length_m)} ม.</td>
                      <td>{p.active ? <span className="badge badge-paid">ใช้งานอยู่</span> : <span className="badge badge-finished">ปิดใช้งาน</span>}</td>
                      <td style={{ whiteSpace: 'nowrap' }}>
                        {canEdit && (
                          <>
                            <button className="btn btn-sm btn-ghost" onClick={() => { setEditProfile(p); setShowProfileForm(true) }}>แก้ไข</button>
                            <button className="btn btn-sm btn-ghost" style={{ color: 'var(--red)' }} onClick={() => setDeleteProfileId(p.id)}>ลบ</button>
                          </>
                        )}
                      </td>
                    </tr>
                  ))}
                  {!sortedProfiles.length && <tr><td colSpan={8} style={{ textAlign: 'center', color: 'var(--text3)', padding: 24 }}>{profileSearch ? 'ไม่พบหน้าตัดที่ค้นหา' : 'ยังไม่มีหน้าตัด'}</td></tr>}
                </tbody>
              </table>
            </div>
          </div>
        </>
      

      {showProfileForm && (
        <Modal title={editProfile ? `แก้ไข ${editProfile.name}` : 'เพิ่มหน้าตัดใหม่'} onClose={() => { setShowProfileForm(false); setEditProfile(null) }} maxWidth={480}>
          <ProfileForm initial={editProfile || EMPTY_PROFILE_FORM} onSave={handleSaveProfile} onCancel={() => { setShowProfileForm(false); setEditProfile(null) }} loading={savingProfile} />
        </Modal>
      )}

      {deleteProfileId && (
        <ConfirmDialog title="ลบหน้าตัด" message="ยืนยันการลบ? (ถ้ามีใบสั่งซื้อผูกอยู่ การลบจะไม่สำเร็จ)" onConfirm={handleDeleteProfile} onCancel={() => setDeleteProfileId(null)} />
      )}
    </div>
  )
}
