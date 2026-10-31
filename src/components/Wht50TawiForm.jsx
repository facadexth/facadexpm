// The official หนังสือรับรองการหักภาษี ณ ที่จ่าย (50 ทวิ) filled in on the Revenue Department's own
// form: the page background is the form itself (src/assets/forms/wht-50tawi-bg.png, rendered from
// DOC/approve_wh3_081156.pdf) and each value sits in the matching printed box (coordinates in
// src/lib/wht50tawi.js). The element is exactly one A4 page (794 x 1123 px) so it prints 1:1.
import bg from '../assets/forms/wht-50tawi-bg.png'
import { PAGE, ID_GROUPS, ID_ROW_Y, idCellCenters, digits13, splitMoney, fitFontPt } from '../lib/wht50tawi.js'

const PX = 794 / PAGE.w // CSS px per PDF point

const box = (x0, y0, x1, y1) => ({
  position: 'absolute', left: x0 * PX, top: (PAGE.h - y1) * PX, width: (x1 - x0) * PX, height: (y1 - y0) * PX,
  display: 'flex', alignItems: 'center', overflow: 'visible', whiteSpace: 'nowrap', lineHeight: 1,
})

function Text({ x0, y0, x1, y1, children, align = 'left', max = 10, min = 6, style }) {
  if (children == null || children === '') return null
  const size = fitFontPt(String(children), x1 - x0, max, min)
  return (
    <div style={{ ...box(x0, y0, x1, y1), justifyContent: align === 'right' ? 'flex-end' : align === 'center' ? 'center' : 'flex-start', fontSize: size * PX, ...style }}>
      {children}
    </div>
  )
}

// A tick drawn with CSS borders (html2canvas drops inline-SVG strokes when making the PDF).
function Tick({ x0, y0, x1, y1 }) {
  const w = (x1 - x0) * PX, h = (y1 - y0) * PX
  return (
    <div aria-hidden="true" style={{ position: 'absolute', left: x0 * PX, top: (PAGE.h - y1) * PX, width: w, height: h }}>
      <div style={{ position: 'absolute', left: w * 0.36, top: h * 0.02, width: w * 0.3, height: h * 0.72, borderRight: '2.2px solid #111', borderBottom: '2.2px solid #111', transform: 'rotate(42deg)' }} />
    </div>
  )
}

function IdCells({ party, value }) {
  const d = digits13(value)
  if (!d) return null
  const [y0, y1] = ID_ROW_Y[party]
  return idCellCenters(ID_GROUPS[party]).map((cx, i) => d[i] ? (
    <Text key={i} x0={cx - 6} x1={cx + 6} y0={y0} y1={y1} align="center" max={10} min={10}>{d[i]}</Text>
  ) : null)
}

// One money pair: baht right-aligned in the wide column, satang in the narrow one.
function Money({ value, y0, y1, baht, satang }) {
  const m = splitMoney(value)
  if (!m.baht) return null
  return (
    <>
      <Text x0={baht[0]} x1={baht[1] - 2} y0={y0} y1={y1} align="right">{m.baht}</Text>
      <Text x0={satang[0]} x1={satang[1]} y0={y0} y1={y1} align="center">{m.satang}</Text>
    </>
  )
}

const AMOUNT = { baht: [404.6, 474.7], satang: [474.7, 489.6] }
const TAX = { baht: [489.6, 546.0], satang: [546.0, 560.4] }

export default function Wht50TawiForm({ id, data }) {
  const d = data
  return (
    <div id={id} style={{ position: 'relative', width: 794, height: 1122, overflow: 'hidden', background: `#fff url(${bg}) 0 0 / 794px 1122px no-repeat`, color: '#111', fontFamily: 'Sarabun, sans-serif' }}>
      {/* เล่มที่ / เลขที่ */}
      <Text x0={519.4} x1={559.4} y0={781.2} y1={797.2}>{d.bookNo}</Text>
      <Text x0={519.3} x1={560} y0={764.7} y1={780.7}>{d.runNo}</Text>

      {/* ผู้มีหน้าที่หักภาษี ณ ที่จ่าย */}
      <IdCells party="payer" value={d.payerTaxId} />
      <Text x0={60} x1={316} y0={729.1} y1={745.2}>{d.payerName}</Text>
      <Text x0={60.8} x1={550} y0={705.7} y1={721.6} min={7}>{d.payerAddress}</Text>

      {/* ผู้ถูกหักภาษี ณ ที่จ่าย */}
      <IdCells party="payee" value={d.payeeTaxId} />
      <Text x0={53.2} x1={314.9} y0={657.6} y1={671.1}>{d.payeeName}</Text>
      <Text x0={59.2} x1={549.6} y0={627} y1={643.3} min={7}>{d.payeeAddress}</Text>

      {/* ในแบบ ภ.ง.ด.3 */}
      <Tick x0={471.3} y0={601.9} x1={484} y1={614.5} />

      {/* 5. การจ่ายเงินได้ที่ต้องหักภาษี ณ ที่จ่าย ตามคำสั่งกรมสรรพากร (ค่าจ้างทำของ) */}
      <Text x0={327} x1={404} y0={216.3} y1={230.4} align="center" max={9}>{d.payDate}</Text>
      <Money value={d.gross} y0={216.3} y1={230.4} {...AMOUNT} />
      <Money value={d.tax} y0={216.3} y1={230.4} {...TAX} />

      {/* รวมเงินที่จ่ายและภาษีที่หักนำส่ง */}
      <Money value={d.gross} y0={180.1} y1={195.5} {...AMOUNT} />
      <Money value={d.tax} y0={180.1} y1={195.5} {...TAX} />
      <Text x0={187} x1={557} y0={157.6} y1={176.8} min={7} style={{ fontWeight: 600 }}>{d.taxWords}</Text>

      {/* ผู้จ่ายเงิน (1) หัก ณ ที่จ่าย */}
      <Tick x0={82.5} y0={119.1} x1={94} y1={130.8} />

      {/* ลายเซ็น + วันที่ออกหนังสือรับรอง */}
      {d.signatureUrl && (
        <img src={d.signatureUrl} alt="" crossOrigin="anonymous"
          style={{ position: 'absolute', left: 372 * PX, top: (PAGE.h - 104) * PX, height: 20 * PX, maxWidth: 100 * PX, objectFit: 'contain' }} />
      )}
      <Text x0={360} x1={450} y0={86} y1={98} align="center" max={8}>{d.signerName ? `(${d.signerName})` : ''}</Text>
      <Text x0={341.8} x1={366} y0={72.1} y1={87.3} align="center">{d.signDay}</Text>
      <Text x0={363.6} x1={428.4} y0={70.6} y1={87.3} align="center" max={9}>{d.signMonth}</Text>
      <Text x0={429.3} x1={470.1} y0={72.3} y1={86.7} align="center">{d.signYear}</Text>
    </div>
  )
}
