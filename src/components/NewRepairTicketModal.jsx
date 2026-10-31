// Staff-created repair ticket (+ เปิดงานซ่อมเอง), opened from the board (src/pages/Repairs.jsx).
//   onClose()          -- close without creating
//   onCreated(ticket)  -- a ticket was created ({ id, ticket_number }); the board reloads
// Creates status 'received' (received_at = now), source 'staff', client = the site's client.
// ticket_number is set by the database trigger. Optional photos are stored as role 'before'.
import { useEffect, useMemo, useState } from 'react'
import { supabase } from '../lib/supabase.js'
import { Modal } from './Modal.jsx'
import SearchableSelect from './SearchableSelect.jsx'
import { useTenant } from '../hooks/useTenant.js'
import { useUserRole } from '../hooks/useUserRole.js'
import { uploadRepairPhotos } from '../lib/repairUpload.js'

export default function NewRepairTicketModal({ onClose, onCreated }) {
  const { tenant } = useTenant()
  const { user } = useUserRole()
  const [sites, setSites] = useState([])
  const [loadError, setLoadError] = useState('')
  const [siteId, setSiteId] = useState('')
  const [description, setDescription] = useState('')
  const [files, setFiles] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const [created, setCreated] = useState(null) // ticket created, but some photos failed

  useEffect(() => {
    let alive = true
    supabase.from('sites').select('id, site_number, name, status, client_id')
      .neq('status', 'Cancelled').eq('is_default', false).order('site_number')
      .then(({ data, error: e }) => {
        if (!alive) return
        if (e) setLoadError(`โหลดรายชื่อไซท์ไม่สำเร็จ: ${e.message}`)
        else setSites(data || [])
      })
    return () => { alive = false }
  }, [])

  const options = useMemo(() => sites.map((s) => ({
    value: s.id,
    label: `${s.site_number ? `${s.site_number} · ` : ''}${s.name}${s.status && s.status !== 'Completed' ? ` (${s.status})` : ''}`,
    keywords: `${s.site_number || ''} ${s.name || ''}`,
  })), [sites])

  const handleClose = () => {
    if (saving) return false
    if (created) onCreated(created)
    else onClose()
  }

  const submit = async () => {
    setError('')
    const site = sites.find((s) => s.id === siteId)
    if (!site) { setError('กรุณาเลือกไซท์'); return }
    if (!description.trim()) { setError('กรุณากรอกรายละเอียดงานซ่อม'); return }
    if (!tenant?.id) { setError('ไม่พบข้อมูลบริษัท ลองรีเฟรชหน้า'); return }
    setSaving(true)
    try {
      const { data: ticket, error: e } = await supabase.from('repair_tickets').insert({
        tenant_id: tenant.id,
        site_id: site.id,
        client_id: site.client_id || null,
        source: 'staff',
        status: 'received',
        received_at: new Date().toISOString(),
        description: description.trim(),
        created_by: user?.email || null,
      }).select('id, ticket_number').single()
      if (e) throw e
      if (files.length) {
        const { failed } = await uploadRepairPhotos(files, { tenantId: tenant.id, ticketId: ticket.id, role: 'before' })
        if (failed.length) {
          setCreated(ticket)
          setError(`เปิดงานซ่อม ${ticket.ticket_number} แล้ว แต่อัปโหลดรูปไม่สำเร็จ ${failed.length} จาก ${files.length} รูป (${failed[0].error?.message || failed[0].error}) เพิ่มรูปได้ในหน้ารายละเอียดงาน`)
          return
        }
      }
      onCreated(ticket)
    } catch (e) {
      setError(`เปิดงานซ่อมไม่สำเร็จ: ${e.message}`)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal title="+ เปิดงานซ่อมเอง" onClose={handleClose} maxWidth={520}>
      <div className="modal-body" style={{ display: 'grid', gap: 12 }}>
        {loadError && <div className="alert alert-error">{loadError}</div>}
        <fieldset disabled={saving || !!created} style={{ border: 0, padding: 0, margin: 0, display: 'grid', gap: 12, minWidth: 0 }}>
          <div className="form-group">
            <label className="label">ไซท์</label>
            <SearchableSelect required value={siteId} onChange={setSiteId} options={options}
              placeholder="— เลือกไซท์ —" disabled={saving || !!created} />
          </div>
          <div className="form-group">
            <label className="label">รายละเอียดงานซ่อม</label>
            <textarea className="textarea" rows={4} value={description} onChange={(e) => setDescription(e.target.value)}
              placeholder="เช่น ประตูบานเลื่อนชั้น 2 ฝืด ล็อกไม่ลง" />
            <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>ลูกค้าจะเห็นข้อความนี้ในรายงานซ่อมทางไลน์</div>
          </div>
          <div className="form-group">
            <label className="label">รูปก่อนซ่อม (ไม่บังคับ)</label>
            <input type="file" accept="image/*" multiple className="input"
              onChange={(e) => setFiles(Array.from(e.target.files || []))} />
            {files.length > 0 && <div style={{ fontSize: 12, color: 'var(--text3)', marginTop: 4 }}>เลือกแล้ว {files.length} รูป</div>}
          </div>
        </fieldset>
        <div style={{ fontSize: 12, color: 'var(--text3)' }}>งานซ่อมที่เปิดเองเริ่มที่สถานะ "รับเรื่อง" ไซท์ยังเป็นสถานะเดิม</div>
        {error && <div className="alert alert-error">{error}</div>}
      </div>
      <div className="modal-footer">
        {created ? (
          <button type="button" className="btn btn-primary" onClick={() => onCreated(created)}>ตกลง</button>
        ) : (
          <>
            <button type="button" className="btn btn-ghost" disabled={saving} onClick={onClose}>ยกเลิก</button>
            <button type="button" className="btn btn-primary" disabled={saving || !siteId} onClick={submit}>
              {saving ? 'กำลังบันทึก...' : 'เปิดงานซ่อม'}
            </button>
          </>
        )}
      </div>
    </Modal>
  )
}
