// Fake-but-plausible quotation data for previewing a document style (no real tenant data).
export const DOC_STYLE_PREVIEW_SAMPLE = {
  quotationNumber: 'QT-2026-000',
  date: new Date().toISOString().slice(0, 10),
  validUntil: new Date(Date.now() + 30 * 86400000).toISOString().slice(0, 10),
  revision: 1,
  siteName: 'ตัวอย่างโครงการ',
  clientName: 'บริษัท ตัวอย่าง จำกัด',
  clientAddress: '123 ถนนตัวอย่าง แขวงตัวอย่าง เขตตัวอย่าง กรุงเทพมหานคร 10110',
  clientTaxId: '0000000000000',
  items: [
    { id: 'preview-1', description: 'งานติดตั้งระแนงอลูมิเนียม (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 50, unit_price: 850, line_total: 42500 },
    { id: 'preview-2', description: 'งานสีกันสนิมโครงเหล็ก (ตัวอย่าง)', unit: 'ตร.ม.', quantity: 20, unit_price: 320, line_total: 6400 },
  ],
  hasVat: true,
  priceIncludesVat: false,
  paymentTerms: 'มัดจำ 50% ก่อนเริ่มงาน ส่วนที่เหลือชำระเมื่องานเสร็จ',
  // notes/bankAccount are non-null here (unlike quotationNumber/clientName/
  // etc., which are fake-but-plausible) so the footer section -- including
  // the footerTextSize/footerBoxOffset controls -- is actually visible
  // while tuning. Previously both were null, so the customizer's own
  // preview could never show what those controls affect.
  notes: 'ตัวอย่างหมายเหตุ: ไม่รวมค่านั่งร้าน',
  bankAccount: { bank_name: 'ธนาคารตัวอย่าง', account_name: 'บริษัท ตัวอย่าง จำกัด', account_no: '000-0-00000-0' },
  clientSignature: null,
}
