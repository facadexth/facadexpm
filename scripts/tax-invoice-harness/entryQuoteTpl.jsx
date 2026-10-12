import React from 'react'
import { createRoot } from 'react-dom/client'
import { QuotationPaper } from 'SRC/pages/Quotations.jsx'

// window.__q = extra props for QuotationPaper (template etc.), set by runQuoteTpl.mjs
window.__render = () => {
  const d = window.__q
  createRoot(document.getElementById('root')).render(
    <div style={{ width: 794 }}>
      <QuotationPaper
        elementId="doc" tag="ต้นฉบับ" quotationNumber="QT2610-014" date="2026-10-10" validUntil="2026-11-10"
        siteName="บ้านคุณสมชาย" clientName="บริษัท ตัวอย่างก่อสร้าง จำกัด" clientAddress="12 ถนนตัวอย่าง แขวงตัวอย่าง กรุงเทพฯ 10110" clientTaxId="0105511111111"
        hasVat priceIncludesVat={false} discountAmount={0} discountPct={0} pricingMode="single"
        paymentTerms={'มัดจำ 50% ก่อนเริ่มงาน\nส่วนที่เหลือชำระเมื่อส่งมอบงาน'} notes="ราคานี้รวมค่าขนส่งในเขต กทม. และปริมณฑล"
        bankAccount={{ bank_name: 'กสิกรไทย', account_name: 'บริษัท ตัวอย่าง อลูมิเนียม จำกัด', account_no: '123-4-56789-0' }}
        onPageCountChange={() => {}} {...d}
      />
    </div>,
  )
}
