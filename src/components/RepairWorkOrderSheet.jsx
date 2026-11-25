// ใบงานซ่อม — A4 sheet for one repair ticket. Renders the WorkOrder view model built by
// buildWorkOrder (supabase/functions/_shared/repair-workorder.ts). Staff capture it with
// downloadPDF(id, …) (which adds a 10mm margin); crew see the same sheet on a phone.
// Colours are fixed so the paper stays white in dark mode. Ticks and boxes are CSS borders
// because html2canvas drops SVG strokes.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { A4_CONTENT_WIDTH_PX } from '../lib/pdf.js'
import { formatThaiDate } from '../lib/thaiDate.js'

const MAX_PHOTOS = 3
const SAFETY = '⚠️ ก่อนเริ่มงาน: ถ่ายรูปจุดซ่อมก่อนแตะงานทุกจุด · ปูผ้ากันเปื้อนพื้น · เก็บเศษวัสดุและทำความสะอาดก่อนกลับ'
const BKK_OFFSET_MS = 7 * 60 * 60 * 1000

const WARRANTY_COLOR = { active: '#1e8a4c', expired: '#c26500' }
const GREY = '#666666'

// ISO timestamp -> 'dd/mm/yyyy(พ.ศ.) HH:MM' in Bangkok time; '' when unparseable.
function signedText(iso) {
  const t = Date.parse(String(iso ?? ''))
  if (!Number.isFinite(t)) return ''
  const s = new Date(t + BKK_OFFSET_MS).toISOString()
  return `${formatThaiDate(s.slice(0, 10))} ${s.slice(11, 16)}`
}

const S = {
  root: {
    width: A4_CONTENT_WIDTH_PX, boxSizing: 'border-box', background: '#fff', color: '#111',
    padding: '4px 6px', fontFamily: 'Sarabun,sans-serif', fontSize: 12.5, lineHeight: 1.45,
    display: 'flex', flexDirection: 'column', gap: 10, overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  hd: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, borderBottom: '2px solid #111', paddingBottom: 8 },
  logoBox: { width: 40, height: 40, flex: '0 0 40px', borderRadius: 8, background: '#1f5f78', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17 },
  logoImg: { width: 40, height: 40, flex: '0 0 40px', objectFit: 'contain', borderRadius: 8 },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 9 },
  card: { border: '1px solid #bbb', borderRadius: 6, padding: '7px 9px', display: 'grid', gap: 2, alignContent: 'start', minWidth: 0 },
  k: { fontSize: 11, color: GREY },
  v: { fontWeight: 700, fontSize: 14 },
  kv: { display: 'grid', gridTemplateColumns: '58px minmax(0,1fr)', gap: '1px 8px' },
  kvKey: { color: GREY },
  note: { border: '1px solid #9cc3d3', background: '#eef6f9', borderRadius: 6, padding: '5px 9px', fontSize: 12, whiteSpace: 'pre-wrap' },
  safety: { background: '#fff8e6', border: '1px solid #e3c27a', borderRadius: 6, padding: '5px 9px', fontSize: 11.5 },
  sec: { fontWeight: 700, fontSize: 13.5 },
  table: { borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' },
  th: { border: '1px solid #999', padding: 5, verticalAlign: 'top', textAlign: 'left', background: '#f0f0f0', fontSize: 11 },
  td: { border: '1px solid #999', padding: 5, verticalAlign: 'top', textAlign: 'left' },
  photo: { width: 92, height: 68, objectFit: 'cover', borderRadius: 3, display: 'block', marginBottom: 3 },
  placeholder: { width: 92, height: 68, borderRadius: 3, background: '#e5e5e5', marginBottom: 3 },
  video: { width: 92, height: 68, borderRadius: 3, background: '#333', color: '#fff', fontSize: 11, fontWeight: 700, display: 'flex', alignItems: 'center', justifyContent: 'center', marginBottom: 3 },
  more: { fontSize: 11, color: GREY, fontWeight: 700 },
  after: { width: 92, height: 68, boxSizing: 'border-box', border: '1.5px dashed #999', borderRadius: 3, display: 'flex', alignItems: 'center', justifyContent: 'center', color: '#999', fontSize: 10, textAlign: 'center' },
  tickBox: { display: 'inline-block', width: 11, height: 11, flex: '0 0 11px', boxSizing: 'border-box', border: '1.5px solid #111', marginRight: 5, marginTop: 3 },
  matCell: { border: '1px solid #999', padding: '4px 6px', height: 22, fontSize: 11.5, boxSizing: 'border-box' },
  blank: { borderBottom: '1px dotted #777', height: 22 },
  sigs: { display: 'grid', gridTemplateColumns: 'repeat(3,minmax(0,1fr))', gap: 14, marginTop: 6, pageBreakInside: 'avoid', breakInside: 'avoid' },
  sig: { textAlign: 'center', fontSize: 11.5 },
  sigLine: { borderBottom: '1px solid #111', height: 46, marginBottom: 4, display: 'flex', alignItems: 'flex-end', justifyContent: 'center' },
  foot: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#777', borderTop: '1px solid #ccc', paddingTop: 5 },
}

function Logo({ company }) {
  if (company.logoUrl) return <img crossOrigin="anonymous" src={company.logoUrl} alt="" style={S.logoImg} />
  const initials = Array.from(company.name || '').slice(0, 2).join('')
  return <div style={S.logoBox}>{initials}</div>
}

function Photos({ photos }) {
  const shown = photos.slice(0, MAX_PHOTOS)
  const extra = photos.length - shown.length
  return (
    <>
      {shown.map((p, i) => {
        if (p.video) return <div key={i} style={S.video}>▶ วิดีโอ</div>
        if (!p.url) return <div key={i} data-photo-missing="" style={S.placeholder} />
        return <img key={i} data-photo="" crossOrigin="anonymous" src={p.url} alt="" style={S.photo} />
      })}
      {extra > 0 && <div style={S.more}>+{extra}</div>}
    </>
  )
}

function Tick({ children }) {
  return <div style={{ display: 'flex', alignItems: 'flex-start' }}><span style={S.tickBox} /><span>{children}</span></div>
}

function Signature({ label, receipt }) {
  const signed = receipt ? signedText(receipt.signed_at) : ''
  return (
    <div style={S.sig}>
      <div style={S.sigLine}>
        {receipt?.signature_url && (
          <img crossOrigin="anonymous" src={receipt.signature_url} alt="ลายเซ็นลูกค้า" style={{ maxHeight: 44, maxWidth: '100%', objectFit: 'contain' }} />
        )}
      </div>
      {receipt && <div style={{ fontWeight: 700 }}>{receipt.signer_name}</div>}
      <div>{label}</div>
      {receipt ? <div>{signed}</div> : <div>วันที่ ____/____/______</div>}
    </div>
  )
}

export default function RepairWorkOrderSheet({ wo, id }) {
  const [qr, setQr] = useState(null)

  useEffect(() => {
    let alive = true
    setQr(null)
    if (!wo.mapUrl) return undefined
    QRCode.toDataURL(wo.mapUrl, { margin: 0, width: 160 })
      .then((url) => { if (alive) setQr(url) })
      .catch(() => { if (alive) setQr(null) })
    return () => { alive = false }
  }, [wo.mapUrl])

  const company = wo.company || {}
  const warrantyColor = WARRANTY_COLOR[wo.warranty?.kind] || GREY

  return (
    <div id={id} style={S.root}>
      <div style={S.hd}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          <Logo company={company} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15, display: 'block' }}>{company.name}</b>
            {company.address && <div style={{ fontSize: 11, color: '#555' }}>{company.address}</div>}
            {company.phone && <div style={{ fontSize: 11, color: '#555' }}>{company.phone}</div>}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: '0 0 auto', maxWidth: 260 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>ใบงานซ่อม</div>
          <div style={{ fontSize: 15, fontWeight: 700 }}>{wo.number}</div>
          <div style={{ fontSize: 11, color: '#555' }}>{wo.reportedText}</div>
        </div>
      </div>

      <div style={S.grid2}>
        <div style={S.card}>
          <span style={S.k}>หน้างาน</span>
          <span style={S.v}>{wo.siteName}</span>
          <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
            <div style={{ ...S.kv, flex: 1, minWidth: 0 }}>
              <span style={S.kvKey}>ที่อยู่</span><span>{wo.address}</span>
              <span style={S.kvKey}>ลูกค้า</span><span>{wo.customerText}</span>
            </div>
            {wo.mapUrl && qr && (
              <div style={{ textAlign: 'center', fontSize: 10, color: '#555', flex: '0 0 auto' }}>
                <img src={qr} alt="แผนที่" style={{ width: 66, height: 66, display: 'block' }} />
                แผนที่
              </div>
            )}
          </div>
        </div>
        <div style={S.card}>
          <span style={S.k}>นัดหมาย</span>
          <span style={S.v}>{wo.appointmentText || 'ยังไม่ได้นัด'}</span>
          <div style={{ ...S.kv, marginTop: 3 }}>
            <span style={S.kvKey}>ช่าง</span><span>{wo.crewText}</span>
            <span style={S.kvKey}>ประกัน</span>
            <span>
              <span style={{ border: `1.5px solid ${warrantyColor}`, color: warrantyColor, borderRadius: 4, padding: '0 5px', fontWeight: 700, fontSize: 11.5, display: 'inline-block' }}>
                {wo.warranty?.text}
              </span>
            </span>
          </div>
          {wo.preferredText && <div style={{ fontSize: 11.5, color: '#444', marginTop: 2 }}>{wo.preferredText}</div>}
        </div>
      </div>

      {wo.customerNote && (
        <div style={S.note}><b>หมายเหตุจากลูกค้า:</b> <span>{wo.customerNote}</span></div>
      )}
      <div style={S.safety}>{SAFETY}</div>

      <div style={S.sec}>{`รายการที่ต้องซ่อม (${wo.rows.length} รายการ)`}</div>
      <table style={S.table}>
        <colgroup>
          <col style={{ width: 26 }} /><col style={{ width: 150 }} /><col />
          <col style={{ width: 104 }} /><col style={{ width: 104 }} /><col style={{ width: 112 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={S.th}>#</th><th style={S.th}>ตรงไหน / เป็นอะไร</th><th style={S.th}>ลูกค้าแจ้ง</th>
            <th style={S.th}>รูปจากลูกค้า</th><th style={S.th}>รูปหลังซ่อม</th><th style={S.th}>ผล</th>
          </tr>
        </thead>
        <tbody>
          {wo.rows.map((r) => (
            <tr key={r.no} style={{ pageBreakInside: 'avoid', breakInside: 'avoid' }}>
              <td style={S.td}>{r.no}</td>
              <td style={S.td}>
                {r.where && <b style={{ display: 'block' }}>{r.where}</b>}
                {r.room && <div>{r.room}</div>}
                {r.symptom && <i style={{ display: 'block' }}>{r.symptom}</i>}
              </td>
              <td style={{ ...S.td, whiteSpace: 'pre-wrap' }}>{r.note}</td>
              <td style={S.td}><Photos photos={r.photos || []} /></td>
              <td style={S.td}><div style={S.after}>ถ่ายในแอป<br />หลังซ่อม</div></td>
              <td style={S.td}>
                <div style={{ display: 'grid', gap: 5, fontSize: 11.5 }}>
                  <Tick>เสร็จ</Tick><Tick>ต้องมาอีกครั้ง</Tick><Tick>ไม่ซ่อม (เหตุผล)</Tick>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <div style={{ ...S.grid2, pageBreakInside: 'avoid', breakInside: 'avoid' }}>
        <div style={{ display: 'grid', gap: 5, alignContent: 'start' }}>
          <div style={S.sec}>วัสดุที่ใช้</div>
          <table style={S.table}>
            <thead>
              <tr>
                <th style={{ ...S.matCell, background: '#f0f0f0', textAlign: 'left' }}>รายการ</th>
                <th style={{ ...S.matCell, background: '#f0f0f0', width: 58 }}>จำนวน</th>
                <th style={{ ...S.matCell, background: '#f0f0f0', width: 58 }}>หน่วย</th>
              </tr>
            </thead>
            <tbody>
              {[0, 1, 2, 3].map((i) => (
                <tr key={i}><td style={S.matCell} /><td style={S.matCell} /><td style={S.matCell} /></tr>
              ))}
            </tbody>
          </table>
        </div>
        <div style={{ display: 'grid', gap: 4, alignContent: 'start' }}>
          <div style={S.sec}>บันทึกช่าง</div>
          <div style={S.blank} /><div style={S.blank} /><div style={S.blank} /><div style={S.blank} />
          <div style={{ ...S.kv, marginTop: 4, gridTemplateColumns: '60px minmax(0,1fr)' }}>
            <span style={S.kvKey}>เวลาเข้า</span><span style={{ ...S.blank, height: 18 }} />
            <span style={S.kvKey}>เวลาออก</span><span style={{ ...S.blank, height: 18 }} />
          </div>
        </div>
      </div>

      <div style={S.sigs}>
        <Signature label="หัวหน้าช่าง" />
        <Signature label="ลูกค้ารับงาน" receipt={wo.receipt} />
        <Signature label="ผู้ตรวจ (PM)" />
      </div>
      <div style={S.foot}><span>{`${wo.number} · ${wo.siteName}`}</span></div>
    </div>
  )
}
