# Bank payroll upload file formats (KBank, SCB)

Reference for generating bank bulk-salary upload files straight from CHANG payroll,
without the user filling the bank's Excel template.

Source: static inspection only (no Excel, no macros run) of

| Bank | File in `DOC/` | Template version | VBA modules |
|---|---|---|---|
| KASIKORNBANK (KBank) | `KBank_Excel Template_V2.6.2.xlsm` | "Version 2.6.2", 25-Dec-2024, build 4.10 (sheet `Admin`) | 70+ modules, ~32k lines |
| SCB (Business Anywhere, "CPX Toolkit") | `CPX_Toolkit_Template.xlsm` | Toolkit 1.3.9 (sheet `File_Info`) | `Sheet1` (Payment), `Export`, `Util`, `Validation` (~5k lines) |

VBA was extracted with `olevba`; sheets, dropdowns and comments with `openpyxl`.

**Legend.** **[READ]** = taken straight from macro code or cell content. **[INFERRED]** = my reading of
how the bank uses it, not stated in the file. Check every [INFERRED] item with the bank before go-live.

Both templates hold only demo data (`บริษัท ทดสอบ จำกัด`, account `0000000000`, tax ID `1234567890123`,
client code `7777777999`). Nothing real needed masking, but this doc still uses `X` placeholders throughout.

---

## 0. Summary for implementers

| | KBank | SCB |
|---|---|---|
| Same-bank payroll product | **PCT** "KBank Payroll" | **PAY** / PA2 / PA3 "SCB Payroll1/2/3" |
| Cross-bank payroll product | **PCL** "SMART Payroll" | **SPN** (next day) / **SPS** (same day), plus SPN2/SPS2/SPN3/SPS3 |
| Both in one upload | **PCTPCL** (only in "Single Payment Format", see §1.7) | No. One product per file. |
| File type | Fixed-width text `.txt` | Pipe-delimited (`\|`) text `.txt` |
| Encoding | ANSI from VBA `Print #`, so **Windows-874 / TIS-620** on a Thai-locale PC [INFERRED from VBA behaviour] | **UTF-8, no BOM** [READ] |
| Line ending | CRLF after **every** line, last line included [READ: `Print #` semantics] | CRLF **between** lines, **no** newline after the last line [READ: `Join(..., vbNewLine)`] |
| Records | H (header) + D (detail) lines. No trailer. | HEADER, BCHDET (batch), TXNDET (each credit), TRAILR |
| Amount | PCT: 15 digits in satang (implied 2 decimals). PCL: `0000000000.00` with a dot. | `1234.50` (always 2 decimals with a dot, no thousands separator, no padding) |
| File name | `PCT` / `PCL` / `SPFPCTPCL` + `YYMMDDhhmmss` + `.txt` | `SCB_file_reference_` + first 12 chars of Customer File Ref + `.txt` |

---

## 1. KBank (KASIKORNBANK Excel Template 2.6.2)

### 1.1 Products [READ: sheet `Detail` K/L/M, `Admin`, module dispatch around VBA line 17990–18180]

Product dropdown `Transaction!F2` (internal name) maps to a 3-letter code through `ProductAbv()`:

| Internal name | Code | Group | Meaning |
|---|---|---|---|
| `KBankPayroll` | **PCT** | G1 (KBank fund transfer) | Payroll into **KBank accounts only** |
| `SmartPayroll` | **PCL** | G2 (inter-bank) | Payroll into **other banks' accounts** (SMART / ITMX bulk) |
| `KBankPayrollSmartPayroll` | **PCTPCL** | G4 (two services) | One upload, split: bank 004 rows go to PCT, the rest to PCL. **Generated only when Single Format = Y.** |

Other products in the same template (not payroll): DCT, FTR, FTL, MCL, MCS, BNL, IPP, COC, COE and combos (DCTMCL, FTLIPP …).

Per-item limits from the `F7` cell comment [READ]: KBank Payroll **3,000,000** baht/item, SMART Payroll **2,000,000** baht/item.
The macro itself only enforces the 2,000,000 cap (for PCL, and for non-004 rows of PCTPCL). It has **no** 3,000,000 check for PCT [READ].

Fees for the template's fee report (sheet `Fee`, veryHidden) [READ]: KBank Payroll 10 baht/item. SMART Payroll 12 (≤100k) / 40 (≤500k) / 100 (≤2M) baht/item.
Whether these match the company's real contract is [INFERRED/unknown].

### 1.2 What the user fills (sheet `Transaction`) [READ: cell labels, comments, data validations, VBA]

Header area:

| Cell | Field | Rule |
|---|---|---|
| C1 | Export path & file name | Optional. Blank means the macro proposes `<CODE><YYMMDDhhmmss>.txt`. The base name may use only `A–Z a–z 0–9 - / _` (`ValidChar`). |
| C2 | Company Name (payer name) | **Required**, ≤ 50 chars, Thai/English. Goes into the PCT header. |
| C3 | Batch Ref# | Optional, ≤ 16 chars (≤ 20 in Single Format). Only `A–Z a–z 0–9 - / _` (`ValidChar`). The macro does **not** auto-generate it: blank means spaces in the file [READ]. |
| C4 | Debit Account | **Required**. KBank account, exactly **10 digits**, numeric. Cell formatted as text. |
| C5 | Effective Date | **Required**. Typed as `DDMMYYYY` (7–8 digits, **AD year only**, year < 2565). Cell number format `00-00-0000`, so `.Text` reads `DD-MM-YYYY`. Must be **≥ today** and **≤ today + 1 year**. |
| E4/E5 | Bank Fee Charge | Radio: `1` = Payer (company), `2` = Beneficiary. Maps to `BenCharge` = `N` (payer) / `Y` (beneficiary). Default `N`. |
| F2 | Selected product (internal name) | e.g. `KBankPayroll`, `SmartPayroll`. |
| G4 / G5 | Total items / total amount | Formulas `=COUNT(F:F)` / `=SUM(F:F)`. |

Detail rows (start at row 8):

| Col | Field | Required | Rule |
|---|---|---|---|
| A | Vendor ID | opt | ≤ 10. Only used to look up the `Vendor Profile` sheet (address, tax ID, fax, email, SMS, SMS lang). It is **not written** into PCT/PCL standard records. |
| B | Bank | **req** | Dropdown `BANKC` = `Bank_Code!F2:F30`, e.g. `004 ธนาคารกสิกรไทย [KBANK]`. The macro uses `Left(...,3)`. For PCT it auto-fills `004` and must be `004`. |
| C | Branch No. | PCL: see §1.6 | 4 digits, numeric. Not needed for KBank or GSB. When blank, the macro derives it from the account number (§1.6). |
| D | Account Number | **req** | Digits only, no spaces. Bank 004 needs exactly 10 digits. Other banks: length must match the `Bank_Code` V–Y lengths. |
| E | Vendor Name | **req** | PCT ≤ **50**, PCL ≤ **80**, Single Format ≤ 120. Thai or English. |
| F | Amount | **req** | > 0, at most 10 integer digits + 2 decimals ("10.2"). PCL ≤ 2,000,000. |
| G | Bene Ref | **req** (since V4.2.37: "KBankPayroll, SmartPayroll … require Bene Reference") | ≤ 16 (≤ 20 SPF). `ValidChar` charset. (Vendor ID + Bene Ref) must be unique in the file. |
| H | WHT | opt | `N`, `Y1`, `Y2`, `Y3`. Number of WHT certificates attached. For payroll use `N`. |
| I | Payment Detail | — | Formula `=IF(LEN(N8)>1,N8,"")`, a mirror of N. Used by PCL and SPF. |
| J | #Invoice | — | Cheque products only. |
| K | Advice Fax | opt | Digits. ≤ 50 in the file. |
| L | Advice Email | opt | ≤ 50. Several addresses are separated by `,` or `;`. |
| M | SMS Tel. No | opt | ≤ 54. Several numbers are separated by `,`. |
| N | Payment Detail | opt | ≤ 255, Thai or English. Written at the end of the PCT D-record. |

### 1.3 File naming, encoding, line endings

- **Name** [READ `GetExpFileName`]: `<CODE><YY><MM><DD><hhmmss>.txt`, for example `PCT261017143005.txt`, `PCL261017143005.txt`, `SPFPCTPCL261017143005.txt`.
  The year is AD (if the clock reads BE > 2500, it subtracts 543). The base name must pass `ValidChar` (`A–Z a–z 0–9 - / _`).
- **Write method** [READ]: `Open … For Output` + `Print #FNum, line`. VBA appends CRLF after every `Print #`, so every line,
  the last one included, ends in `\r\n`.
- **Encoding** [INFERRED]: VBA `Print #` converts Unicode strings to the system ANSI code page. On a Thai-locale Windows PC
  that is **Windows-874**, a superset of TIS-620, with 1 byte per Thai character. All widths below are counted with VBA
  `Len()` and `Space()`, which count characters, so with CP874 **chars = bytes**. Thai combining vowels and tone marks
  each count as one character and one byte. **Generate in CP874/TIS-620 and pad by code points.**
  On a non-Thai locale, VBA would turn Thai into `?`. KBank users are evidently expected to run Thai Windows.
- **No trailer record** in the PCT, PCL or SPF formats [READ].
- Amounts are rounded with VBA `Format()` on doubles. Generate from integer satang to avoid float drift.

### 1.4 PCT (KBank Payroll), standard format [READ: `Generate_DirectCredit(…, "PCT", False)`, VBA ~L21990–22560]

Used when `Company Profile!J2` (Single Format) = `N` (the default). All rows must be bank 004.

**Header record (178 chars)**

| Pos | Len | Content | Format / source |
|---|---|---|---|
| 1 | 1 | `H` | literal |
| 2–4 | 3 | `PCT` | product code |
| 5–20 | 16 | Batch Ref | `C3`, left-justified, space-padded |
| 21–26 | 6 | `000000` | literal |
| 27 | 1 | space | |
| 28–31 | 4 | spaces | |
| 32 | 1 | space | |
| 33–39 | 7 | spaces | |
| 40 | 1 | space | |
| 41–50 | 10 | Debit account | `C4` (10 digits) |
| 51 | 1 | space | |
| 52–66 | 15 | Total amount | sum × 100, zero-padded (`000000000000000`), implied 2 decimals |
| 67 | 1 | space | |
| 68–73 | 6 | Transaction (creation) date | `YYMMDD` of **now** (AD; `if YYMMDD ≥ 500000 then −430000` fixes BE clocks) |
| 74–98 | 25 | spaces | |
| 99–148 | 50 | Company (payer) name | `C2`, left-justified, space-padded, truncated to 50 |
| 149–154 | 6 | Effective date | `YYMMDD` (AD) from `C5` |
| 155–172 | 18 | Total item count | zero-padded |
| 173 | 1 | Charge flag | `N` = payer pays fee, `Y` = beneficiary pays |
| 174–178 | 5 | spaces | |

**Detail record `D` (742 chars)**

| Pos | Len | Content | Format / source |
|---|---|---|---|
| 1 | 1 | `D` | |
| 2–7 | 6 | Sequence | 000001… |
| 8–21 | 14 | spaces | |
| 22–31 | 10 | Credit account | col D as typed (KBank 10 digits, **not** padded) |
| 32 | 1 | space | |
| 33–47 | 15 | Amount | × 100, zero-padded, implied 2 decimals |
| 48 | 1 | space | |
| 49–54 | 6 | Transaction date | same as header 68–73 |
| 55–79 | 25 | spaces | |
| 80–129 | 50 | Payee name | col E, left-justified, space-padded, truncated |
| 130–135 | 6 | Effective date | `YYMMDD` |
| 136–138 | 3 | WHT count | `000` / `001` / `002` / `003` (payroll: `000`) |
| 139–154 | 16 | Bene Ref | col G, space-padded to 16 |
| 155–204 | 50 | spaces | |
| 205 | 1 | Advice flag | `E` if an email exists, else `F` if a fax exists, else space |
| 206–255 | 50 | Fax | col K, else from Vendor Profile, else spaces |
| 256–305 | 50 | Email | col L, else from Vendor Profile, else spaces |
| 306–318 | 13 | Total amount before VAT (WHT) | `0000000000.00` (payroll: `0000000000.00`) |
| 319–331 | 13 | Total tax deducted (WHT) | `0000000000.00` |
| 332–344 | 13 | Total amount after VAT (e-WHT) | `0000000000.00` |
| 345–354 | 10 | Tax ID (old 10-digit) | Vendor Profile col G, else spaces |
| 355–367 | 13 | Personal / Tax ID (13) | Vendor Profile col H, else spaces |
| 368–397 | 30 | Address 1 | Vendor Profile, else spaces |
| 398–427 | 30 | Address 2 | |
| 428–457 | 30 | Address 3 | |
| 458–487 | 30 | Address 4 | |
| 488–742 | 255 | Payment details | col N, space-padded (added V4.2.41, 2023-09) |

Optional lines after each D (only when there is WHT): `T` lines (WHT detail, up to 3).
For PCT and PCL the `M` (SMS) line is printed **only if the row also has WHT** (`If ProductType = "PCT" Then If tax1<>"T" And TaxCount>"000" …`) [READ].
So **a plain payroll file has no SMS lines**, even when col M is filled.
SMS line layout, for reference: `M` + mobile numbers (54, space-padded) + SMS lang (2, from Vendor Profile col M).

### 1.5 PCL (SMART Payroll), standard format [READ: `Generate_SmartCredit(…, "PCL", False)`, VBA ~L23151–23760]

**Header record (82 chars)**

| Pos | Len | Content | Format / source |
|---|---|---|---|
| 1 | 1 | `H` | |
| 2–4 | 3 | `PCL` | |
| 5–14 | 10 | Debit account | `C4` |
| 15–30 | 16 | Batch Ref | `C3`, space-padded |
| 31–40 | 10 | Effective date | `DD-MM-YYYY` (AD) |
| 41–45 | 5 | spaces | |
| 46–63 | 18 | Total item count | zero-padded |
| 64–81 | 18 | Total amount | `000000000000000.00` (decimal point **included**) |
| 82 | 1 | Charge flag | `N` payer / `Y` beneficiary |

Note: the PCL header carries **no company name and no creation date** [READ].

**Detail record `D` (738 chars)**

| Pos | Len | Content | Format / source |
|---|---|---|---|
| 1 | 1 | `D` | |
| 2–7 | 6 | Sequence | 000001… |
| 8–11 | 4 | spaces | |
| 12–24 | 13 | Amount | `0000000000.00` (decimal point included) |
| 25–104 | 80 | Payee name | col E, space-padded, truncated to 80 |
| 105–134 | 30 | Address 1 | Vendor Profile, else spaces |
| 135–164 | 30 | Address 2 | |
| 165–194 | 30 | Address 3 | |
| 195–224 | 30 | Address 4 | |
| 225–244 | 20 | Credit account | **right-justified, zero-padded** to 20 (`Right("000…0" & acct, 20)`). Bank 039: first 12 chars, zero-padded to 20. |
| 245–260 | 16 | Bene Ref | col G, space-padded |
| 261–273 | 13 | Personal / Tax ID | Vendor Profile col H, else spaces |
| 274–277 | 4 | Receiving branch | col C if given (padded to 4 with spaces), else derived (§1.6). GSB (030) 12-digit accounts: forced `9990`. |
| 278–280 | 3 | Receiving bank code | `Left(colB, 3)`, e.g. `002` |
| 281–535 | 255 | Payment detail | col I (= col N), space-padded |
| 536–545 | 10 | Tax ID (10) | Vendor Profile col G, else spaces |
| 546–595 | 50 | spaces | |
| 596 | 1 | Advice flag | `E` / `F` / space (same rule as PCT) |
| 597–646 | 50 | Fax | |
| 647–696 | 50 | Email | |
| 697–709 | 13 | WHT total before VAT | `0000000000.00` |
| 710–722 | 13 | WHT tax deducted | `0000000000.00` |
| 723–735 | 13 | e-WHT total after VAT | `0000000000.00` |
| 736–738 | 3 | WHT count | `000` for payroll |

### 1.6 Receiving bank list, account lengths and branch derivation [READ: sheet `Bank_Code` (codename `Sheet8`), `SCheckBankBranch`]

If col C (branch) is blank, the macro picks the "branch formula" whose account length matches (V→AA, W→AB, X→AC, Y→AD):
`F3` = first 3 digits of the account + one space. `F4` = first 4 digits. `999F` = `999` + first digit. `M3,3` = `Mid(acct,3,3)` + space.
Any other value is a literal branch code. If the account length matches none of V–Y, the branch becomes `*Err*` (validation stops this first).

| Code | Bank | Valid acct lengths | Branch rule (per length) | BNL / MCS / MCL / IPP / PromptPay flags |
|---|---|---|---|---|
| 004 | KBANK | 10 | F3 | Y/Y/Y/-/Y |
| 002 | BBL | 10 | F3 | Y/Y/Y/Y/Y |
| 006 | KTB | 10 | F3 | Y/Y/Y/Y/Y |
| 008 | JPMC | 10 | 0001 | Y/Y/Y/-/- |
| 011 | TTB | 10 | F3 | Y/Y/Y/Y/Y |
| 014 | SCB | 10 | F3 | Y/Y/Y/Y/Y |
| 017 | CITI | 10 | 0001 | Y/Y/Y/Y/Y |
| 018 | SMBC | 10 | 0001 | Y/Y/Y/Y/Y |
| 020 | SCBT | 10, 11 | F3, F3 | Y/Y/Y/Y/Y |
| 022 | CIMBT | 10 | F3 | Y/Y/Y/Y/- |
| 024 | UOBT | 10 | F3 | Y/Y/Y/Y/Y |
| 025 | BAY | 10 | F3 | Y/Y/Y/Y/Y |
| 026 | MEGA ICBC | 10 | 0001 | Y/Y/Y/-/- |
| 027 | BOFA | 11, 10, 9, 8 | 0001 | Y/Y/Y/-/- |
| 030 | GSB | 12, 15 | 999F, F4 (PCL 12-digit: `9990`) | Y/Y/Y/Y/Y |
| 031 | HSBC | 11, 12 | 0001 | Y/Y/Y/Y/Y |
| 032 | DB | 10 | 0001 | Y/Y/Y/Y/- |
| 033 | GHB | 12 | F3 | Y/Y/Y/Y/Y |
| 034 | BAAC | 10, 12 | 0000 | Y/Y/Y/Y/Y |
| 039 | MHBC (Mizuho) | 11, 12 | 0001 | Y/Y/Y/Y/Y |
| 045 | BNPP | 11, 19, 16 | 0010 | Y/Y/Y/Y/Y |
| 052 | BOC | 15 | 0001 | Y/Y/Y/Y/- |
| 066 | ISBT | 10, 12 | F3, M3,3 | Y/Y/Y/Y/Y |
| 067 | TISCO | 14 | F4 | Y/Y/Y/Y/Y |
| 069 | KK | 10, 14 | F4 | Y/Y/Y/Y/Y |
| 070 | ICBC | 10, 14, 16 | F3 | Y/Y/Y/Y/Y |
| 071 | TCRB | 10 | F3 | Y/Y/Y/Y/Y |
| 073 | LHBANK | 10 | F4 | Y/Y/Y/Y/Y |
| 080 | SMTB | 10 | 0001 | Y/Y/Y/-/- |

There is no PCL column. The macro never checks bank-vs-product, because `IsValidB2PRD` is always False.
That PCL reaches every bank above is [INFERRED] from PCL running on the SMART network, the same as MCL, where every bank is `Y`.

### 1.7 Single Payment Format (SPF), needed for the combined PCTPCL [READ: `Generate_SinglePaymentFormat`, VBA ~L24794–25750]

Switched on by `Company Profile!J2 = "Y"` (and `Admin!D22`). In this mode **every** product, PCT and PCL alone included, uses this layout.
For `KBankPayrollSmartPayroll` it writes **one file** `SPFPCTPCL<YYMMDDhhmmss>.txt` with up to two batches:
first `HED` + `DET`s for bank-004 rows (product `PCT`), then a second `HED` + `DET`s for non-004 rows (product `PCL`), appended.
If a group is empty, its batch is skipped. No trailer.

Charge in SPF: `CLI` (payer) / `BEN` (beneficiary).

**HED (83 chars)**: 1–3 `HED` · 4–23 Batch Ref (20, space-padded) · 24–33 **Client Code** (10, `Company Profile!I2`) ·
34–43 product type (10, e.g. `PCT       `) · 44–53 debit account (10) · 54–63 item count (10, zero-padded) ·
64–83 batch amount (20, `00000000000000000.00`).

**DET (1444 chars)**:

| Pos | Len | Content |
|---|---|---|
| 1–3 | 3 | `DET` |
| 4–23 | 20 | Sequence, zero-padded |
| 24–33 | 10 | spaces |
| 34–43 | 10 | "Beneficiary Code" (Vendor ID): **always spaces** since V4.1.23 |
| 44–63 | 20 | Bene Ref, space-padded |
| 64–183 | 120 | Payee name |
| 184–303 | 120 | Address 1–4 (4 × 30) |
| 304–313 | 10 | Effective date `DD/MM/YYYY` |
| 314–327 | 14 | Amount `00000000000.00` |
| 328–347 | 20 | Credit account, **left-justified, space-padded** (all banks) |
| 348–350 | 3 | Bank code |
| 351–357 | 7 | Bank code (3) + branch (4, trimmed then zero-left-padded) |
| 358–359 | 2 | Delivery method (cheques only, else spaces) |
| 360–369 | 10 | Pickup location (cheques only, else spaces) |
| 370–429 | 60 | Documents for pickup (cheques only, else spaces) |
| 430–432 | 3 | Charge `CLI` / `BEN` |
| 433–687 | 255 | Payment detail (col I) |
| 688–737 | 50 | Fax |
| 738–937 | 200 | Email |
| 938–987 | 50 | SMS mobile(s) |
| 988–989 | 2 | SMS language |
| 990–1002 | 13 | Personal / Tax ID |
| 1003–1122 | 120 | WHT beneficiary name |
| 1123–1402 | 280 | WHT beneficiary address 1–4 (4 × 70) |
| 1403–1416 | 14 | WHT total before VAT `00000000000.00` |
| 1417–1430 | 14 | WHT tax deducted |
| 1431–1444 | 14 | e-WHT total after VAT |

Optional `WHT…` and `ENR…` (invoice) lines can follow, but they do not apply to payroll.

### 1.8 One-time company setup (store per tenant)

| Setting | Where in template | Used by |
|---|---|---|
| Company name for the bank (≤ 50) | `Transaction!C2` | PCT header |
| Debit account (10-digit KBank) | `C4` / sheet `Debit Account` | all |
| Fee charged to payer or beneficiary | `E5` radio → `N`/`Y` (SPF: `CLI`/`BEN`) | all headers |
| Contracted products: PCT, PCL or both | `F2` | file choice |
| Single Payment Format flag (Y/N) | `Company Profile!J2` | layout choice. **Ask KBank which format the company is set up for.** [INFERRED: set by the bank or onboarding] |
| Client Code (10) | `Company Profile!I2` | SPF `HED` only |
| Per-employee: bank code, account no., branch (non-KBank, when not derivable), Bene Ref | rows | D records |

Portal: the K-Cash Connect Plus / KBank corporate bulk upload [INFERRED: the template never names the portal].

---

## 2. SCB (Business Anywhere, "CPX Excel Toolkit" 1.3.9)

### 2.1 Products [READ: `Master_data` tables `TBProductCode`, `TBPPPayroll`]

The radio button "Payroll" loads `TBPPPayroll`:

| Product (dropdown text) | Code |
|---|---|
| SCB Payroll1 | **PAY** |
| SCB Payroll2 | PA2 |
| SCB Payroll3 | PA3 |
| SCB Payroll1 – SMART Credit (Next Day) | **SPN** |
| SCB Payroll1 – SMART Credit (Same Day) | **SPS** |
| SCB Payroll2 – SMART Credit (Next Day / Same Day) | SPN2 / SPS2 |
| SCB Payroll3 – SMART Credit (Next Day / Same Day) | SPN3 / SPS3 |

Non-payroll codes in the same toolkit: OAT, 3PT, BNT, RFT, SCN, SCS, PPY.

- **PAY/PA2/PA3 are SCB-to-SCB only** [READ]: their bank list `TBBankPAY` = `014` alone, and the credit account must pass the SCB check digit.
- **SPN/SPS (and the 2/3 variants) are cross-bank payroll over SMART** [READ: bank list `TBBankWithout014`, which despite its name **includes 014**, so SCB accounts are allowed and get check-digit validation].
- **Payroll1/2/3** [INFERRED]: separate payroll service registrations (e.g. separate payroll groups or confidentiality tiers) set up with SCB. The file format is identical apart from the product code. Ask SCB which code the company is registered for.
- The toolkit refuses Invoice/WHT attachments for any payroll product ("The system does not yet support … for Payroll") [READ].
- Only **one product per file** (one `BCHDET`) [READ].

### 2.2 What the user fills (sheet `Payment`) [READ: `Util` constants, labels, DV prompts, `Sheet1` validation]

Header area:

| Cell | Field | Rule |
|---|---|---|
| C2 | Customer File Ref | Auto: `DDMMYYhhmmss` + product code (e.g. `171026143005PAY`), regenerated whenever a product is picked. |
| E2 | Customer Batch Ref | Optional, 1–12 chars, must not contain `\|`, `#` or `^`. Blank means it is auto-set to `DDMMYYhhmmss` at export. |
| C3 | Debit Account | **Required**. 10-digit SCB account, must pass the **SCB check digit**. |
| C4 | Debit Fee Account | **Required**. 10-digit SCB account, check digit. Usually the same as C3 [INFERRED]. |
| C5 | Value Date | **Required**. `DD/MM/YYYY`, BE or AD year (a year > now+400 has 543 subtracted). Must be ≥ today. For SPN/SPN2/SPN3/SCN (next day) it must be **> today**. Business day (DV prompt; no holiday calendar in the macro). |
| E4 | Product dropdown | **Required**. Writes the code into M1. |
| E6 | System Reference ID | Optional, ≤ 18, no spaces, none of `! " # $ % & * + ; < = > ? @ [ \ ] ^ _ \` { \| } ~`. DV prompt: "เลขที่อ้างอิงระบบ หรือรหัสบริษัท" (system reference no. or company code). |

Credit rows (header row 8, data from row 9; the first blank col A ends the list):

| Col | Field | PAY/PA2/PA3 | SPN/SPS… | Rule |
|---|---|---|---|---|
| A | Credit Seq. No. | auto | auto | 1, 2, 3… Rows must be contiguous with no duplicates. **Not exported.** |
| B | Bank | must be ไทยพาณิชย์ (014) | `TBBankWithout014` list | Hidden col N gets the 3-digit code |
| C | Credit Account | **10 digits + SCB check digit** | 1–25 digits, and the check digit if bank 014 | numeric, not 0 |
| D | Recipient Name | req | req | 1–140, Thai/English, none of `! " # $ % & * + ; < = > ? @ [ \ ] ^ _ \` { \| } ~`, no leading space |
| E | Amount | req, 0.01 – 9,999,999,999,999.99 | req, 0.01 – **2,000,000** (014: up to 9,999,999,999,999.99) | numeric, ≤ 2 decimals, no comma |
| F | Customer Transaction Ref | opt | opt | 1–20, `[A-Za-z0-9 -():/',.\|^\#]`. **Avoid `\|`**: the macro allows it, but it breaks the pipe format. |
| G | Fee Charge | **req** | **req** | `TBFeePayroll`: Recipient (**BEN**) / Payer (**OUR**) |
| H | Branch Code | hidden, not used | **req**, exactly 4 digits | receiving branch |
| I | Service Type | hidden | opt. Default `01` "Salaries wages or pensions" (`TBServiceTypeSmart`) | |
| J | SMS Notification | opt | opt | 10-digit mobiles, comma-separated, max 3 (≤ 32 chars). Dashes stripped on export. |
| K | Email Notification | opt | opt | 5–100 chars, comma-separated, each checked by `IsEmailValid` |
| L | Payment Advice Remark | opt | opt | ≤ 200, same special-char ban as D |

### 2.3 File naming, encoding, line endings [READ: `Export.Export`, `generateCustomerFileReferanceName`]

- Name: `SCB_file_reference_` + `Left(CustomerFileRef, 12)`, chosen in a Save-As dialog filtered to `*.txt`.
  For example `SCB_file_reference_171026143005.txt`. The `.txt` extension comes from the dialog filter [INFERRED]; the bank most likely does not depend on the name [INFERRED].
- Encoding: built in an `ADODB.Stream` with `Charset = "UTF-8"`, then copied from position 3 to drop the BOM.
  Result: **UTF-8 without BOM**.
- Separator: `|`. Lines joined with `vbNewLine` (**CRLF**). The trailer is appended with **no** final newline.
- Empty fields are kept as empty strings between pipes. Field counts are fixed per record type.

### 2.4 Record layouts (pipe-delimited)

**HEADER**: 3 fields

| # | Field | Value |
|---|---|---|
| 1 | Record type | `HEADER` |
| 2 | Customer File Ref | C2, e.g. `171026143005PAY` |
| 3 | System Reference ID | E6 (may be empty) |

**BCHDET (batch / debit)**: 10 fields, one per file

| # | Field | Value |
|---|---|---|
| 1 | Record type | `BCHDET` |
| 2 | Customer Batch Ref | E2 (≤ 12) |
| 3 | Product code | `PAY` / `PA2` / `PA3` / `SPN` / `SPS` / … |
| 4 | Value date | `YYYYMMDD`, **AD** |
| 5 | Debit account | C3 (10) |
| 6 | Fee debit account | C4 (10) |
| 7 | Total debit amount | sum of col E, `0.00` style (e.g. `153250.00`) |
| 8 | Total no. of credits | count of rows |
| 9 | Internal debit note | empty |
| 10 | Payment advice remark (batch) | empty |

**TXNDET (credit)**: 28 fields, one per employee

| # | Field | PAY / PA2 / PA3 | SPN / SPS / … |
|---|---|---|---|
| 1 | Record type | `TXNDET` | `TXNDET` |
| 2 | Customer Transaction Ref | col F (may be empty) | col F |
| 3 | Credit account | col C (10) | col C |
| 4 | PromptPay proxy type | empty | empty |
| 5 | Receiving bank code (3) | `014` | col N, formatted `000` |
| 6 | Receiving branch (4) | **`0111` (hard-coded)** | col H (4 digits) |
| 7 | Amount | `1234.50` | `1234.50` |
| 8 | Service type | **empty** | col P, default **`01`** |
| 9 | Fee charge | `BEN` / `OUR` | `BEN` / `OUR` |
| 10 | SMS flag | `Y` if col J filled, else `N` | same |
| 11 | SMS mobile(s) | col J without `-` | same |
| 12 | Email flag | `Y` / `N` | same |
| 13 | Email | col K | same |
| 14 | Recipient name | col D | same |
| 15 | Recipient address 1 (WHT) | empty | empty |
| 16 | Recipient address 2 | empty | empty |
| 17 | Recipient address 3 | empty | empty |
| 18 | WHT required flag | `N` | `N` |
| 19 | Total WHT cert count | empty | empty |
| 20 | Total WHT amount | empty | empty |
| 21 | Payment advice flag | `Y` if email filled, else `N` | same |
| 22 | Invoice required flag | `N` | `N` |
| 23 | Total invoice count | empty | empty |
| 24 | Total invoice amount | empty | empty |
| 25 | Total VAT amount | empty | empty |
| 26 | WHT delivery method | `E` if email filled, else `N` | same |
| 27 | WHT / advice recipient email | col K (again) | same |
| 28 | Payment advice remark (txn) | col L | same |

**TRAILR**: 4 fields: `TRAILR` | `1` (total debit records) | total credit count | total amount (`0.00` style).

Example, a SCB-only payroll with 2 employees (values made up, `X` = digits):

```
HEADER|171026143005PAY|
BCHDET|171026143005|PAY|20261025|XXXXXXXXXX|XXXXXXXXXX|30500.00|2||
TXNDET|EMP001|XXXXXXXXXX||014|0111|15000.00||OUR|N||Y|a@b.co|นาย ก ข||||N|||Y|N||||E|a@b.co|
TXNDET|EMP002|XXXXXXXXXX||014|0111|15500.00||OUR|N||N||นาง ค ง||||N|||N|N||||N||
TRAILR|1|2|30500.00
```

### 2.5 Amount and date conversion details [READ]

- `convertAmountFormat` = `FormatNumber(v, 2)` with commas removed, e.g. `1234.5` → `1234.50`, `0.5` → `0.50`. No padding, no sign.
  It uses the PC's regional decimal separator. Always emit `.`.
- `convertDateFormat` = `Format(DateSerial(...), "yyyymmdd")` with a BE→AD fix, then `Trim`.

### 2.6 SCB check digit (`CheckScbDigit`) [READ]

For a 10-digit account (dashes removed): weights `4 3 2 7 6 5 4 3 2` on digits 1–9.
Take the **last digit** of each product and sum them. `k` = last digit of the sum. Check = last digit of `(10 − k)`.
It must equal digit 10. This applies to the debit account, the fee account, and every 014 credit account.

```ts
function scbCheckDigitOk(acct: string): boolean {
  const s = acct.replace(/-/g, '').trim();
  if (!/^\d{10}$/.test(s)) return false;
  const w = [4,3,2,7,6,5,4,3,2];
  const sum = w.reduce((t, wi, i) => t + ((Number(s[i]) * wi) % 10), 0);
  return (10 - (sum % 10)) % 10 === Number(s[9]);
}
```

### 2.7 Receiving bank codes [READ: `Master_data`]

`TBBankWithout014` (used by SPN/SPS…), 37 entries: 001 BOT, 002 BBL, 004 KBANK, 006 KTB, 008 JPMC, 009 OCBC, 011 TTB, **014 SCB**, 017 CITI, 018 SMBC, 020 SCBT,
022 CIMBT, 023 RHB, 024 UOBT, 025 BAY, 026 MEGA ICBC, 027 BOFA, 029 IOB, 030 GSB, 031 HSBC, 032 DB, 033 GHB, 034 BAAC, 035 EXIM,
039 Mizuho, 045 BNPP, 052 BOC, 065 Thanachart, 066 ISBT, 067 TISCO, 069 KK, 070 ICBC, 071 TCRB, 073 LH, 079 ANZ, 088 CLICKS (คลิกซ์), 098 SME D.
The dropdown shows the Thai short name (e.g. `กสิกรไทย`), and the macro writes the 3-digit code.
`TBBankPAY` = 014 only. `TBBankSmartCredit` (SCN/SCS) = the same list without 014.

Service types for SMART (`TBServiceTypeSmart`): 01 Salaries wages or pensions · 02 Dividends · 03 Interests · 04 Goods and Services ·
05 Securities Trading · 06 Tax Refunds · 07 Loans · 08 Senior Citizen Allowances · 09 Government Bond · 10 Government Welfare/Pensions · 59 Others.

### 2.8 One-time company setup (store per tenant)

| Setting | Notes |
|---|---|
| Product code | PAY/PA2/PA3 (SCB-only) and/or SPN/SPS(/2/3) (cross-bank). Mixed SCB + other-bank payroll needs two files, or SPN/SPS for everyone (it accepts 014) [READ]. |
| Debit account (10, SCB, check digit) | C3 |
| Fee debit account (10, SCB, check digit) | C4 |
| Default fee charge | `OUR` (payer) or `BEN` (recipient) |
| System Reference ID / company code (≤ 18) | optional; whether SCB assigns it is [INFERRED/unknown] |
| Per-employee | bank code, account, branch code (4 digits, **required for SPN/SPS**), optional SMS/email |

Portal: SCB Business Anywhere (CPX), bulk payment file upload [INFERRED from template name].

---

## 3. Validation checklist for CHANG's generator

**KBank (PCT / PCL / SPF)**
- Debit account: 10 digits. Company name ≤ 50 (PCT). Batch ref ≤ 16 (SPF ≤ 20), charset `[A-Za-z0-9\-/_]`.
- Effective date: today … today + 1 year. Write it AD.
- PCT: every row bank 004, account exactly 10 digits. Name ≤ 50.
- PCL: account length must match the §1.6 table for its bank. Name ≤ 80. Amount ≤ 2,000,000.00.
  Branch: given, or derivable per §1.6.
- Bene Ref required, ≤ 16 (SPF 20), charset `[A-Za-z0-9\-/_]` [READ: the pre-validator calls `ValidChar` on col G],
  and unique per (vendor ID, ref). Use something like the employee code plus the period.
- Amount > 0, ≤ 9,999,999,999.99 by width. Make sure the header totals equal the sum of the D lines.
- Pad by characters, encode CP874. Reject characters CP874 cannot encode.

**SCB (PAY / SPN / SPS)**
- Debit account and fee account: 10 digits plus the SCB check digit.
- Value date ≥ today (SPN: > today). Output `YYYYMMDD` AD.
- PAY: credit account = 014 + check digit, branch field `0111`, service type empty.
- SPN/SPS: bank from §2.7, branch 4 digits (required), service type `01`, amount ≤ 2,000,000 unless bank 014.
- Name 1–140 with no banned special characters (`|` is banned, which keeps the pipe format safe).
  Ref ≤ 20 with no `|` (enforce this ourselves). Remark ≤ 200. Email ≤ 100. Mobiles: 10 digits each, ≤ 3.
- Batch ref ≤ 12 with no `| # ^`. System ref ≤ 18 with no spaces or specials.
- Exactly 28 fields per TXNDET, 10 per BCHDET, 3 per HEADER, 4 per TRAILR. UTF-8 without BOM. CRLF between lines, none at the end.

## 4. Open questions / uncertainties

1. **KBank encoding** comes from VBA `Print #` behaviour (system ANSI = CP874 on Thai Windows), not from an explicit charset. Confirm that KBank accepts TIS-620/CP874, and whether it also accepts UTF-8 (likely not, since fixed widths are in bytes).
2. **KBank standard vs Single Payment Format**: which one the company's KBank profile expects (default in the template is `N` = standard). The combined PCT+PCL file exists only in SPF.
3. **KBank PCT SMS** lines are dropped unless the row has WHT, a macro quirk. Unknown whether the bank would accept an `M` line anyway.
4. **KBank PCL branch** for `F3` banks is written as 3 digits plus a space (e.g. `123 `), but SPF zero-pads to `0123`. Both come straight from the code. Unknown which form the bank really keys on.
5. **SCB PAY branch `0111`** is hard-coded for PAY/OAT/3PT, meaning unknown (probably an "any SCB branch" placeholder) [INFERRED].
6. **SCB PA2/PA3 and SPN2/SPS2/SPN3/SPS3** meaning (payroll groups) is [INFERRED]. Ask SCB which code the account is on.
7. Neither template enforces holidays or bank cut-off times. Same-day (SPS) cut-off times are not in the files.
8. SCB file-name and `.txt` handling are probably not checked by the portal [INFERRED]. KBank's naming is only a default proposal.
