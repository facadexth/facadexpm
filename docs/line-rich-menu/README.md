# LINE Rich Menu (2 rows x 3)

`rich-menu.png` is 2500 x 1686 px, the large 6-area template in LINE Official Account Manager
(Rich menus -> create -> large -> the 2 x 3 layout). Re-render after changing the buttons with
`node scripts/render-rich-menu.mjs`.

Set every area's action to **Text** and type exactly the text below. The bot reads it like typed text.

| Position | Button | Text to set | What the bot does |
|---|---|---|---|
| row 1, col 1 | เช็คอิน/เช็คเอาท์ | `เช็คอิน/เช็คเอาท์` | one button for both: sends the check-in link until the worker has checked in, then the check-out link, then a "done" note |
| row 1, col 2 | ตารางงาน | `ตารางงาน` | replies with 4 tappable chips: งานวันนี้ / งานวันพรุ่งนี้ / งานอาทิตย์นี้ / งานอาทิตย์หน้า |
| row 1, col 3 | งานเสร็จ | `งานเสร็จ` | asks which task (if several), then a one-tap "เสร็จแล้ว" chip; photos optional |
| row 2, col 1 | แจ้งปัญหา | `แจ้งปัญหา` | asks for the details, then records the report |
| row 2, col 2 | ขอเบิกของ | `ขอเบิกของ` | sends the one-time request form link |
| row 2, col 3 | ขอลา | `ขอลา` | sends the one-time leave form link |

Photos need no button: a photo sent to the bot is filed to the worker's site for today automatically.

If a company renames or turns off a schedule command, the "ตารางงาน" chips follow that setting.

## ยกเลิก (Cancel)
Every menu and prompt the bot shows (the งานวันนี้ sub-menu, the ตารางงาน chips, งานเสร็จ, แจ้งปัญหา) ends with a
"ยกเลิก" chip. Tapping it (or sending the word `ยกเลิก` alone) clears whatever the bot was waiting for from that
worker and replies "ยกเลิกแล้วครับ", which also makes LINE remove the chips. This is not a Rich Menu button.
