// ============================================================
// AttachmentsSection — reference-only file attachments for any entity
// (PO quotations, site contracts/drawings) backed by Supabase Storage.
// Never parsed, just stored for viewing/downloading. Parameterized over
// the table/bucket/foreign key so each entity type gets its own private
// bucket + tenant-prefixed path, matching its own migration.
// ============================================================
import { useState, useEffect, useRef } from 'react'
import { supabase } from '../lib/supabase.js'
import { sanitizeStorageFileName } from '../lib/storageKey.js'
import { isCustomerImage } from '../lib/customerVisible.js'

export default function AttachmentsSection({ table, bucket, foreignKey, entityId, tenantId, customerVisibleKind }) {
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)

  const load = async () => {
    // customer_visible only exists on tables that opted in via customerVisibleKind.
    const cols = customerVisibleKind ? '*, customer_visible' : '*'
    const { data } = await supabase.from(table).select(cols).eq(foreignKey, entityId).order('uploaded_at')
    setAttachments(data || [])
  }
  useEffect(() => { load() }, [entityId])

  const handleUpload = async (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    setUploading(true)
    try {
      const filePath = `${tenantId}/${entityId}/${Date.now()}-${sanitizeStorageFileName(file.name)}`
      const { error: upErr } = await supabase.storage.from(bucket).upload(filePath, file)
      if (upErr) throw upErr
      const { error: dbErr } = await supabase.from(table).insert({ [foreignKey]: entityId, file_path: filePath, file_name: file.name })
      if (dbErr) {
        // Uploaded file has no DB row yet — remove it so it doesn't become
        // an orphan invisible to this UI (no other path can find/delete it).
        await supabase.storage.from(bucket).remove([filePath])
        throw dbErr
      }
      await load()
    } catch (err) {
      alert('Error: ' + err.message)
    } finally {
      setUploading(false)
      e.target.value = ''
    }
  }

  const handleDownload = async (att) => {
    const { data, error } = await supabase.storage.from(bucket).createSignedUrl(att.file_path, 60)
    if (error) { alert('Error: ' + error.message); return }
    window.open(data.signedUrl, '_blank')
  }

  const handleRemove = async (att) => {
    try {
      const { error: rmErr } = await supabase.storage.from(bucket).remove([att.file_path])
      if (rmErr) throw rmErr
      const { error: dbErr } = await supabase.from(table).delete().eq('id', att.id)
      if (dbErr) throw dbErr
      await load()
    } catch (err) {
      alert('Error: ' + err.message)
    }
  }

  const inFlight = useRef(new Set())
  const handleToggleVisible = async (att, visible) => {
    if (inFlight.current.has(att.id)) return
    inFlight.current.add(att.id)
    const prev = !!att.customer_visible
    setAttachments(list => list.map(a => a.id === att.id ? { ...a, customer_visible: visible } : a))
    try {
      const { error } = await supabase.rpc('set_customer_visible', { p_kind: customerVisibleKind, p_id: att.id, p_visible: visible })
      if (error) {
        setAttachments(list => list.map(a => a.id === att.id ? { ...a, customer_visible: prev } : a))
        alert('Error: ' + error.message)
      }
    } finally {
      inFlight.current.delete(att.id)
    }
  }

  return (
    <div>
      <label className="label">ไฟล์แนบ</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {attachments.map(att => (
          <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleDownload(att)}>📎 {att.file_name}</button>
            {customerVisibleKind && isCustomerImage(att.file_name) && (
              <label style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                <input type="checkbox" checked={!!att.customer_visible} onChange={e => handleToggleVisible(att, e.target.checked)} />
                ให้ลูกค้าเห็น
              </label>
            )}
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleRemove(att)}>✕</button>
          </div>
        ))}
      </div>
      <input type="file" onChange={handleUpload} disabled={uploading} accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png" />
    </div>
  )
}
