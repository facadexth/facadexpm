import React from 'react'
import { createRoot } from 'react-dom/client'
import { DocumentPaper } from 'SRC/pages/Invoices.jsx'

// window.__doc = props for DocumentPaper (set by runInvoiceDoc.mjs)
window.__render = () => {
  const d = window.__doc
  createRoot(document.getElementById('root')).render(
    <div style={{ width: 794 }}>
      <DocumentPaper
        elementId="doc" tenant={{ id: 't1', company_name: 'Test Co' }} tag="ต้นฉบับ" title="ใบแจ้งหนี้"
        infoFields={[{ label: 'เลขที่เอกสาร', value: 'IN2610-002' }]}
        clientName="บริษัท วาสสเปซ จำกัด" clientAddress="45/1 กรุงเทพ" clientTaxId="0105"
        items={[{ id: 'i1', description: 'งานรื้อถอน', unit: 'ชุด', unit_price: 16000, draw_qty: 1, line_total: 16000, sort_order: 0, item_type: 'item' }]}
        signatures={['ผู้ออกเอกสาร', 'ผู้รับเอกสาร']} notesBlock={null} onPageCountChange={() => {}}
        {...d}
      />
    </div>,
  )
}
