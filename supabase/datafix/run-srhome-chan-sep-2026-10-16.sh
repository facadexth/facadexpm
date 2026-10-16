#!/bin/bash
# ลงสต๊อก เอส อาร์ โฮม 2 ใบ + ชาญสินทวี IS69091410 (FT 10 / FT 20 ที่ขาด) แล้วซิงก์ยอดคงเหลือ หยุดทันทีถ้าผิดพลาด
cd "$(dirname "$0")/../.." || exit 1
n=0
for f in 2026-10-16-srhome-chan-sep-import 2026-10-13-sync-stock-balances; do
  n=$((n+1))
  echo "=== [$n/2] $f ==="
  npx supabase db query --linked -f "supabase/datafix/$f.sql" || { echo "!!! หยุดที่ไฟล์ $f (ลำดับ $n)"; exit 1; }
done
echo "=== เสร็จครบ 2 ไฟล์ ==="
