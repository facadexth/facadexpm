import { useEffect, useState } from 'react'

/** Collapsible preview of the document the user just uploaded, so a scan
 *  that could not be read automatically never leaves them without the
 *  source to type the lines from. Folded by default on narrow screens. */
export default function ScanDocPreview({ file }) {
  const [url, setUrl] = useState(null)
  const [open, setOpen] = useState(() => typeof window === 'undefined' || window.innerWidth >= 768)

  useEffect(() => {
    if (!file) { setUrl(null); return undefined }
    const u = URL.createObjectURL(file)
    setUrl(u)
    return () => URL.revokeObjectURL(u)
  }, [file])

  if (!file || !url) return null
  const isPdf = file.type === 'application/pdf'
  return (
    <div style={{ border: '1px solid var(--border)', borderRadius: 8, padding: 8, marginTop: 8 }}>
      <button type="button" className="btn btn-ghost" onClick={() => setOpen(o => !o)}>
        {open ? '🙈 ซ่อนเอกสาร' : '📄 ดูเอกสาร'}
      </button>
      {open && (isPdf ? (
        <object data={url} type="application/pdf" style={{ width: '100%', height: 420, marginTop: 8 }}>
          เปิดไฟล์ PDF ในหน้านี้ไม่ได้ <a href={url} target="_blank" rel="noreferrer">เปิดในแท็บใหม่</a>
        </object>
      ) : (
        <a href={url} target="_blank" rel="noreferrer">
          <img src={url} alt="เอกสารที่อัปโหลด" style={{ width: '100%', maxHeight: 420, objectFit: 'contain', marginTop: 8 }} />
        </a>
      ))}
    </div>
  )
}
