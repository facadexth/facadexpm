const XLSX = require('xlsx')

function buildTemplate(title, headers, hints, outPath) {
  const rows = [
    [title],
    [],
    headers,
    hints,
  ]
  const ws = XLSX.utils.aoa_to_sheet(rows)
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, 'Sheet1')
  XLSX.writeFile(wb, outPath)
  console.log('wrote', outPath)
}

buildTemplate(
  'แบบฟอร์มนำเข้ารายการสินค้าคงคลัง',
  ['ชื่อสินค้าคงคลัง', 'หน่วยหลัก', 'รูปแบบการแปลงหน่วย', 'ขนาดแผ่นอ้างอิง (ตรม.)'],
  ['เช่น อลูมิเนียม สีขาว', 'เช่น กก., ตรม., ชิ้น', 'ปกติ / อลูมิเนียม (ตามหน้าตัด) / กระจก (กว้าง×ยาว)', 'กรอกเฉพาะแบบกระจก เช่น 2.88'],
  'public/templates/TEMPLATE_รายการสินค้าคงคลัง.xlsx'
)

buildTemplate(
  'แบบฟอร์มนำเข้าหน้าตัดอลูมิเนียม',
  ['ชื่อหน้าตัด', 'น้ำหนัก (กก./เมตร)', 'ความยาวมาตรฐาน (เมตร)'],
  ['เช่น หน้าตัด X', 'เช่น 1.0', 'เช่น 6.4 (เว้นว่างได้ ค่าเริ่มต้น 6.4)'],
  'public/templates/TEMPLATE_หน้าตัดอลูมิเนียม.xlsx'
)
