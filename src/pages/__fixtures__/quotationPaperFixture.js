// Representative quotation used by the QuotationPaper characterization and isolation tests (Task 11).
export const FIXTURE = {
  elementId: 'qt-doc-fixture',
  tenant: { company_name: 'บริษัท ทดสอบ จำกัด', address: '1 ถนนทดสอบ กรุงเทพฯ', tax_id: '0105555555555', phone: '02-000-0000', email: 'a@b.co', document_style: null },
  quotationNumber: 'QT26-00001', tag: 'ต้นฉบับ', date: '2026-10-09', validUntil: '2026-11-08', revision: 2,
  siteName: 'โครงการทดสอบ', clientName: 'คุณลูกค้า', clientAddress: '99 ถนนลูกค้า', clientTaxId: '0100000000001',
  items: [
    { id: 'r1', item_type: 'item', description: 'หน้าต่างบานเลื่อน W-01', quantity: 2, unit: 'ชุด', unit_price: 12500, line_total: 25000 },
    { id: 'r2', item_type: 'item_description', description: 'ขนาด 1200 × 1500 มม. · ซีรีส์ 40 · สีขาว · กระจก TP6', quantity: 0, unit: '', unit_price: 0, line_total: 0 },
    { id: 'r3', item_type: 'item', description: 'ประตูบานสวิง D-01', quantity: 1, unit: 'ชุด', unit_price: 30000, line_total: 30000 },
    { id: 'r4', item_type: 'note', description: 'ราคานี้รวมค่าติดตั้ง', quantity: 0, unit: '', unit_price: 0, line_total: 0 },
    { id: 'r5', item_type: 'item', description: 'ช่องแสงติดตาย F-01', quantity: 3, unit: 'ชุด', unit_price: 4000, line_total: 12000 },
  ],
  hasVat: true, priceIncludesVat: false, discountAmount: 0, discountPct: 0, pricingMode: 'combined',
  paymentTerms: 'มัดจำ 50% ก่อนเริ่มงาน', notes: 'ยืนราคา 30 วัน',
  bankAccount: { bank_name: 'ธนาคารทดสอบ', account_name: 'บริษัท ทดสอบ จำกัด', account_no: '123-4-56789-0' },
  clientSignature: null,
}
