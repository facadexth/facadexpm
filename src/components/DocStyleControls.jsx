// Slider/colour controls for a document style (shared by Settings' platform-admin
// customizer and the document-templates admin page). Pure: reads `docStyle`, calls
// `setDocStyleField(key, value)`.
export default function DocStyleControls({ docStyle, setDocStyleField }) {
  return (
    <>
            <div>
              <label className="label">สีหลัก (Accent)</label>
              <input type="color" value={docStyle.accent} onChange={e => setDocStyleField('accent', e.target.value)} style={{ width: '100%', height: 32 }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>หน้ากระดาษ</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบบน-ล่าง</span><span>{docStyle.pagePaddingV}px</span></label>
              <input type="range" min="16" max="64" value={docStyle.pagePaddingV} onChange={e => setDocStyleField('pagePaddingV', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบซ้าย-ขวา</span><span>{docStyle.pagePaddingH}px</span></label>
              <input type="range" min="16" max="64" value={docStyle.pagePaddingH} onChange={e => setDocStyleField('pagePaddingH', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>โลโก้</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความกว้าง</span><span>{docStyle.logoWidth}px</span></label>
              <input type="range" min="40" max="160" value={docStyle.logoWidth} onChange={e => setDocStyleField('logoWidth', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ความสูงสูงสุด</span><span>{docStyle.logoMaxHeight}px</span></label>
              <input type="range" min="24" max="140" value={docStyle.logoMaxHeight} onChange={e => setDocStyleField('logoMaxHeight', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะห่างจากข้อความ</span><span>{docStyle.logoGap}px</span></label>
              <input type="range" min="0" max="30" value={docStyle.logoGap} onChange={e => setDocStyleField('logoGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>ขนาดตัวอักษร</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ชื่อบริษัท</span><span>{docStyle.nameSize}px</span></label>
              <input type="range" min="12" max="30" value={docStyle.nameSize} onChange={e => setDocStyleField('nameSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่/เลขผู้เสียภาษี</span><span>{docStyle.addressSize}px</span></label>
              <input type="range" min="8" max="16" value={docStyle.addressSize} onChange={e => setDocStyleField('addressSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ข้อมูลติดต่อ (โทร/อีเมล/เว็บไซต์)</span><span>{docStyle.contactSize}px</span></label>
              <input type="range" min="8" max="16" value={docStyle.contactSize} onChange={e => setDocStyleField('contactSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร (เช่น "ใบเสนอราคา")</span><span>{docStyle.titleSize}px</span></label>
              <input type="range" min="14" max="40" value={docStyle.titleSize} onChange={e => setDocStyleField('titleSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>กล่องข้อมูลเอกสาร (เลขที่/วันที่/โครงการ)</span><span>{docStyle.infoSize}px</span></label>
              <input type="range" min="9" max="16" value={docStyle.infoSize} onChange={e => setDocStyleField('infoSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>ระยะห่าง</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>แถวหัวเอกสาร</span><span>{docStyle.headerRowGap}px</span></label>
              <input type="range" min="6" max="48" value={docStyle.headerRowGap} onChange={e => setDocStyleField('headerRowGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ที่อยู่ → ติดต่อ</span><span>{docStyle.contactLineGap}px</span></label>
              <input type="range" min="0" max="24" value={docStyle.contactLineGap} onChange={e => setDocStyleField('contactLineGap', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>กล่องข้อมูลลูกค้า → เอกสาร</span><span>{docStyle.clientInfoOffset}px / {docStyle.docInfoBoxOffset}px</span></label>
              <input type="range" min="0" max="48" value={docStyle.clientInfoOffset} onChange={e => setDocStyleField('clientInfoOffset', Number(e.target.value))} style={{ width: '100%' }} />
              <input type="range" min="0" max="48" value={docStyle.docInfoBoxOffset} onChange={e => setDocStyleField('docInfoBoxOffset', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>หัวเอกสาร → ตารางรายการ</span><span>{docStyle.tableMarginTop}px</span></label>
              <input type="range" min="6" max="48" value={docStyle.tableMarginTop} onChange={e => setDocStyleField('tableMarginTop', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>สัดส่วนคอลัมน์ (ลูกค้า)</span><span>{docStyle.splitRatioClient}%</span></label>
              <input type="range" min="40" max="80" value={docStyle.splitRatioClient} onChange={e => setDocStyleField('splitRatioClient', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <div className="label" style={{ marginTop: 8 }}>หัวตารางรายการ</div>
            <div>
              <label className="label">สีพื้นหลัง</label>
              <input type="color" value={docStyle.tableHeaderBg} onChange={e => setDocStyleField('tableHeaderBg', e.target.value)} style={{ width: '100%', height: 28 }} />
            </div>
            <div>
              <label className="label">สีตัวอักษร</label>
              <input type="color" value={docStyle.tableHeaderColor} onChange={e => setDocStyleField('tableHeaderColor', e.target.value)} style={{ width: '100%', height: 28 }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ขนาดตัวอักษร</span><span>{docStyle.tableHeaderSize}px</span></label>
              <input type="range" min="8" max="16" value={docStyle.tableHeaderSize} onChange={e => setDocStyleField('tableHeaderSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะขอบใน</span><span>{docStyle.tableHeaderPadding}px</span></label>
              <input type="range" min="2" max="20" value={docStyle.tableHeaderPadding} onChange={e => setDocStyleField('tableHeaderPadding', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>เส้นขอบล่าง</span><span>{docStyle.tableHeaderBorder}px</span></label>
              <input type="range" min="0" max="6" value={docStyle.tableHeaderBorder} onChange={e => setDocStyleField('tableHeaderBorder', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={docStyle.tableHeaderBold} onChange={e => setDocStyleField('tableHeaderBold', e.target.checked)} />
              ตัวหนา
            </label>

            <div className="label" style={{ marginTop: 8 }}>ท้ายเอกสาร (หมายเหตุ/เงื่อนไขการชำระเงิน/บัญชีธนาคาร)</div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ระยะห่างจากเส้นลายเซ็น</span><span>{docStyle.footerBoxOffset}px</span></label>
              <input type="range" min="16" max="120" value={docStyle.footerBoxOffset} onChange={e => setDocStyleField('footerBoxOffset', Number(e.target.value))} style={{ width: '100%' }} />
            </div>
            <div>
              <label style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5 }}><span>ขนาดตัวอักษร</span><span>{docStyle.footerTextSize}px</span></label>
              <input type="range" min="9" max="16" step="0.5" value={docStyle.footerTextSize} onChange={e => setDocStyleField('footerTextSize', Number(e.target.value))} style={{ width: '100%' }} />
            </div>

            <label style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 8 }}>
              <input type="checkbox" checked={docStyle.showContactIcons} onChange={e => setDocStyleField('showContactIcons', e.target.checked)} />
              แสดงข้อมูลติดต่อ (โทร/อีเมล/เว็บไซต์)
            </label>
            <label style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <input type="checkbox" checked={docStyle.showRevisionSuffix} onChange={e => setDocStyleField('showRevisionSuffix', e.target.checked)} />
              แสดงเลขแก้ไข (-R2) ที่เลขที่เอกสาร
            </label>

    </>
  )
}
