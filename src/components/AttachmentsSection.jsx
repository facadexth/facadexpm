// ============================================================
// AttachmentsSection — reference-only file attachments for any entity
// (PO quotations, site contracts/drawings) backed by Supabase Storage.
// Never parsed, just stored for viewing/downloading. Parameterized over
// the table/bucket/foreign key so each entity type gets its own private
// bucket + tenant-prefixed path, matching its own migration.
// ============================================================
import { useState, useEffect } from 'react'
import { supabase } from '../lib/supabase.js'
import { sanitizeStorageFileName } from '../lib/storageKey.js'

export default function AttachmentsSection({ table, bucket, foreignKey, entityId, tenantId }) {
  const [attachments, setAttachments] = useState([])
  const [uploading, setUploading] = useState(false)

  const load = async () => {
    const { data } = await supabase.from(table).select('*').eq(foreignKey, entityId).order('uploaded_at')
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

  return (
    <div>
      <label className="label">ไฟล์แนบ</label>
      <div style={{ display: 'grid', gap: 6, marginBottom: 8 }}>
        {attachments.map(att => (
          <div key={att.id} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleDownload(att)}>📎 {att.file_name}</button>
            <button type="button" className="btn btn-sm btn-ghost" onClick={() => handleRemove(att)}>✕</button>
          </div>
        ))}
      </div>
      <input type="file" onChange={handleUpload} disabled={uploading} accept=".pdf,.xlsx,.xls,.jpg,.jpeg,.png" />
    </div>
  )
}
