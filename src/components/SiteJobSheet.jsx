// ใบงานประจำวัน — A4 crew daily job sheet for one site. Renders the JobSheet view model built by
// buildJobSheet (supabase/functions/_shared/site-jobsheet.ts). Staff capture it with
// downloadPDF(id, …) (which adds a 10mm margin). Internal document: no customer signature.
// Colours are fixed so the paper stays white in dark mode. Tick boxes, day dots and lines are CSS
// borders/backgrounds because html2canvas drops SVG strokes.
import { useEffect, useState } from 'react'
import QRCode from 'qrcode'
import { A4_CONTENT_WIDTH_PX } from '../lib/pdf.js'
import { companyInitial } from '../lib/companyInitial.js'

const GREY = '#666666'
const NO_BREAK = { pageBreakInside: 'avoid', breakInside: 'avoid' }

const S = {
  root: {
    width: A4_CONTENT_WIDTH_PX, boxSizing: 'border-box', background: '#fff', color: '#111',
    padding: '4px 6px', fontFamily: 'Sarabun,sans-serif', fontSize: 12.5, lineHeight: 1.45,
    display: 'flex', flexDirection: 'column', gap: 11, overflowWrap: 'anywhere', wordBreak: 'break-word',
  },
  hd: { display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 12, borderBottom: '2px solid #111', paddingBottom: 8 },
  logoBox: { width: 40, height: 40, flex: '0 0 40px', borderRadius: 8, background: '#1f5f78', color: '#fff', display: 'flex', alignItems: 'center', justifyContent: 'center', fontWeight: 700, fontSize: 17 },
  logoImg: { width: 40, height: 40, flex: '0 0 40px', objectFit: 'contain', borderRadius: 8 },
  grid2: { display: 'grid', gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', gap: 9 },
  card: { border: '1px solid #bbb', borderRadius: 6, padding: '7px 9px', display: 'grid', gap: 2, alignContent: 'start', minWidth: 0 },
  k: { fontSize: 11, color: GREY },
  v: { fontWeight: 700, fontSize: 14 },
  kv: { display: 'grid', gridTemplateColumns: '70px minmax(0,1fr)', gap: '1px 8px' },
  kvKey: { color: GREY },
  dots: { display: 'flex', gap: 3, marginTop: 3, flexWrap: 'wrap' },
  dot: { width: 26, height: 6, borderRadius: 3, background: '#d5dcdf' },
  safety: { background: '#fff8e6', border: '1px solid #e3c27a', borderRadius: 6, padding: '5px 9px', fontSize: 11.5, whiteSpace: 'pre-wrap' },
  sec: { fontWeight: 700, fontSize: 13.5 },
  table: { borderCollapse: 'collapse', width: '100%', tableLayout: 'fixed' },
  th: { border: '1px solid #999', padding: 5, verticalAlign: 'top', textAlign: 'left', background: '#f0f0f0', fontSize: 11 },
  td: { border: '1px solid #999', padding: 5, verticalAlign: 'top', textAlign: 'left', fontSize: 12 },
  zone: { border: '1px solid #999', padding: 5, background: '#eef4f6', fontWeight: 700, color: '#1f5f78', fontSize: 12 },
  num: { fontVariantNumeric: 'tabular-nums' },
  no: { textAlign: 'center', whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums', paddingLeft: 2, paddingRight: 2 },
  tickBox: { display: 'inline-block', width: 11, height: 11, flex: '0 0 11px', boxSizing: 'border-box', border: '1.5px solid #111', marginRight: 5, marginTop: 3 },
  blank: { borderBottom: '1px dotted #777', height: 22 },
  sigs: { display: 'grid', gridTemplateColumns: 'repeat(2,minmax(0,1fr))', gap: 40, marginTop: 6, ...NO_BREAK },
  sig: { textAlign: 'center', fontSize: 11.5 },
  sigLine: { borderBottom: '1px solid #111', height: 44, marginBottom: 4 },
  foot: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#777', borderTop: '1px solid #ccc', paddingTop: 5 },
}

function Logo({ company }) {
  if (company.logoUrl) return <img crossOrigin="anonymous" src={company.logoUrl} alt="" style={S.logoImg} />
  return <div style={S.logoBox}>{companyInitial(company.name)}</div>
}

// One bar per day of the run: done days green, today blue, days still to come grey.
function RunDots({ run }) {
  const total = Number(run?.total), index = Number(run?.index)
  if (!(total > 0 && index >= 1 && index <= total)) return null
  return (
    <div style={S.dots} data-run-dots="">
      {Array.from({ length: total }, (_, i) => {
        const kind = i + 1 < index ? 'done' : i + 1 === index ? 'today' : 'todo'
        const background = kind === 'done' ? '#2f7d4f' : kind === 'today' ? '#1f5f78' : '#d5dcdf'
        return <i key={i} data-dot={kind} style={{ ...S.dot, background }} />
      })}
    </div>
  )
}

function Tick({ children }) {
  return <div style={{ display: 'flex', alignItems: 'flex-start' }}><span style={S.tickBox} /><span>{children}</span></div>
}

function Signature({ label }) {
  return (
    <div style={S.sig}>
      <div style={S.sigLine} />
      <div>{label}</div>
      <div>วันที่ ____/____/______</div>
    </div>
  )
}

export default function SiteJobSheet({ sheet, id }) {
  const [qr, setQr] = useState(null)

  useEffect(() => {
    let alive = true
    setQr(null)
    if (!sheet.mapUrl) return undefined
    QRCode.toDataURL(sheet.mapUrl, { margin: 0, width: 160 })
      .then((url) => { if (alive) setQr(url) })
      .catch(() => { if (alive) setQr(null) })
    return () => { alive = false }
  }, [sheet.mapUrl])

  const company = sheet.company || {}
  const groups = sheet.groups || []
  const problems = sheet.problems || []
  const drawings = (sheet.drawings || []).filter((d) => d?.title)
  // Zone rows name the phase too when the sheet spans more than one phase.
  const manyPhases = new Set(groups.map((g) => g.phaseId)).size > 1
  const contact = [company.address, company.phone].filter(Boolean).join(' · ')
  let no = 0

  return (
    <div id={id} style={S.root}>
      <div style={S.hd}>
        <div style={{ display: 'flex', gap: 10, alignItems: 'center', minWidth: 0 }}>
          <Logo company={company} />
          <div style={{ minWidth: 0 }}>
            <b style={{ fontSize: 15, display: 'block' }}>{company.name}</b>
            {contact && <div style={{ fontSize: 11, color: '#555' }}>{contact}</div>}
          </div>
        </div>
        <div style={{ textAlign: 'right', flex: '0 0 auto', maxWidth: 260 }}>
          <div style={{ fontSize: 20, fontWeight: 700 }}>ใบงานประจำวัน</div>
          <div style={{ fontWeight: 700 }}>{sheet.dateText}</div>
        </div>
      </div>

      <div style={S.grid2}>
        <div style={S.card}>
          <span style={S.k}>หน้างาน</span>
          <span style={S.v}>{sheet.siteName}</span>
          <div style={{ display: 'flex', gap: 8, marginTop: 3 }}>
            <div style={{ ...S.kv, flex: 1, minWidth: 0 }}>
              <span style={S.kvKey}>ที่อยู่</span><span>{sheet.address}</span>
            </div>
            {sheet.mapUrl && qr && (
              <div style={{ textAlign: 'center', fontSize: 10, color: '#555', flex: '0 0 auto' }}>
                <img src={qr} alt="แผนที่" style={{ width: 66, height: 66, display: 'block' }} />
                แผนที่
              </div>
            )}
          </div>
        </div>
        <div style={S.card}>
          <span style={S.k}>รอบนี้</span>
          <span style={S.v}>{sheet.runText || 'ไม่มีข้อมูลรอบ'}</span>
          <RunDots run={sheet.run} />
          <div style={{ ...S.kv, marginTop: 4 }}>
            <span style={S.kvKey}>หัวหน้าทีม</span><span>{sheet.leaderText}</span>
            <span style={S.kvKey}>ทีม</span><span>{sheet.crewText}</span>
            <span style={S.kvKey}>เฟส</span><span>{sheet.progressText || '-'}</span>
          </div>
        </div>
      </div>

      <div style={S.safety}>{`⚠️ ${sheet.safetyNote}`}</div>

      <div style={S.sec}>{`การ์ดงานวันนี้ (${sheet.cardCount} ใบ)`}</div>
      <table style={S.table}>
        <colgroup>
          {/* # fits 3 digits on one line; the notes column gave up the 6px the # column gained. */}
          <col style={{ width: 30 }} /><col /><col style={{ width: 110 }} />
          <col style={{ width: 78 }} /><col style={{ width: 118 }} /><col style={{ width: 144 }} />
        </colgroup>
        <thead>
          <tr>
            <th style={S.th}>#</th><th style={S.th}>การ์ด</th><th style={S.th}>ผู้รับผิดชอบ</th>
            <th style={S.th}>จำนวน (PM)</th><th style={S.th}>วันนี้</th><th style={S.th}>หมายเหตุ</th>
          </tr>
        </thead>
        {/* Each zone header is rendered in one unbreakable <tbody> together with the zone's first
            card, so html2pdf (css mode honours break-inside: avoid) pushes the pair to the next
            page instead of leaving the header alone at the bottom. The rest of the zone follows
            in a plain <tbody>; every card row stays unbreakable on its own. */}
        {groups.map((g) => {
          const rows = g.cards.map((c) => {
            no += 1
            return (
              <tr key={c.id} data-card-row="" style={NO_BREAK}>
                <td style={{ ...S.td, ...S.no }} data-card-no="">{no}</td>
                <td style={S.td}>
                  <div>{c.name}</div>
                  <div style={{ color: GREY }}>{c.statusText}</div>
                </td>
                <td style={S.td}>{c.ownersText}</td>
                <td style={{ ...S.td, ...S.num }}>{c.qtyText}</td>
                <td style={S.td}>
                  <div style={{ display: 'grid', gap: 4, fontSize: 11.5 }}>
                    <Tick>เสร็จทั้งการ์ด</Tick><Tick>ทำต่อพรุ่งนี้</Tick>
                  </div>
                </td>
                <td style={S.td}><div style={S.blank} /><div style={S.blank} /></td>
              </tr>
            )
          })
          const key = `${g.phaseId}:${g.zone}`
          return [
            <tbody key={`zs:${key}`} data-zone-start="" style={NO_BREAK}>
              <tr data-zone-row="" style={NO_BREAK}>
                <td colSpan={6} style={S.zone}>{manyPhases ? `${g.phase} · ${g.zone}` : g.zone}</td>
              </tr>
              {rows[0]}
            </tbody>,
            rows.length > 1 ? <tbody key={`zr:${key}`} data-zone-rest="">{rows.slice(1)}</tbody> : null,
          ]
        })}
      </table>

      <div style={{ ...S.grid2, ...NO_BREAK }}>
        <div style={{ display: 'grid', gap: 4, alignContent: 'start', minWidth: 0 }}>
          {problems.length > 0 && (
            <div data-problems="" style={{ display: 'grid', gap: 4 }}>
              <div style={S.sec}>ปัญหาที่ต้องแก้ (ภายใน)</div>
              <table style={S.table}>
                <tbody>
                  {problems.map((p) => (
                    <tr key={p.id} style={NO_BREAK}><td style={S.td}>{`${p.name} · ${p.zone}`}</td></tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          {drawings.length > 0 && (
            <div data-drawings="" style={{ display: 'grid', gap: 4, marginTop: problems.length ? 6 : 0 }}>
              <div style={S.sec}>แบบที่เกี่ยวข้อง</div>
              <div style={{ fontSize: 12 }}>
                {drawings.map((d) => d.title).join(' · ')}{' '}
                <span style={{ color: GREY }}>(เปิดดูในลิงก์ของช่าง)</span>
              </div>
            </div>
          )}
        </div>
        <div style={{ display: 'grid', gap: 4, alignContent: 'start', minWidth: 0 }}>
          <div style={S.sec}>บันทึกหัวหน้าทีม</div>
          <div style={S.blank} /><div style={S.blank} /><div style={S.blank} />
          <div style={{ ...S.kv, marginTop: 4, gridTemplateColumns: '60px minmax(0,1fr)' }}>
            <span style={S.kvKey}>เริ่มงาน</span><span style={{ ...S.blank, height: 16 }} />
            <span style={S.kvKey}>เลิกงาน</span><span style={{ ...S.blank, height: 16 }} />
          </div>
        </div>
      </div>

      <div style={S.sigs}>
        <Signature label="หัวหน้าทีม" />
        <Signature label="ผู้ตรวจ (PM)" />
      </div>
      <div style={S.foot}><span>{`ใบงานประจำวัน ${sheet.dateText} · ${sheet.siteName} · เอกสารภายใน`}</span></div>
    </div>
  )
}
