#!/bin/bash
# ปิดงานสต๊อกค้าง 16 ต.ค. 2569: ลงการ์ดที่รอใบกำกับ 11 ใบ, แก้ชาญสินทวี 1569011619, แก้ต้นทุน บี.เอส. ม.ค. เป็นก่อน VAT, แล้วซิงก์ยอดคงเหลือ
# หยุดทันทีถ้าไฟล์ใดผิดพลาด (แต่ละไฟล์มี guard ไม่ลงซ้ำ)
cd "$(dirname "$0")/../.." || exit 1
n=0
for f in 2026-10-16-waiting-cards-import 2026-10-16-chan-1569011619-fix 2026-10-16-bsal-jan-vat-fix 2026-10-13-sync-stock-balances; do
  n=$((n+1))
  echo "=== [$n/4] $f ==="
  npx supabase db query --linked -f "supabase/datafix/$f.sql" || { echo "!!! หยุดที่ไฟล์ $f (ลำดับ $n)"; exit 1; }
done
echo "=== เสร็จครบ 4 ไฟล์ ==="
