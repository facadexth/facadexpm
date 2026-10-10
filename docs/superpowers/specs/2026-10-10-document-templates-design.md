# Document templates (3 selectable styles) — design

Status: draft for owner review (2026-10-10). Mockup: https://claude.ai/artifact/Je3WJCPBMFfhqyss1LfzZh (v8).

## 1. Goal and decisions already made by the owner

Tenants can choose how their printed documents look from 3 templates. A platform admin tunes and publishes the templates; tenants only choose.

Owner decisions (quoted intent):
1. The existing "รูปแบบเอกสาร" customizer in Settings is removed for normal tenants; only platform admins keep it (done, commit c18a173c).
2. 3 templates: **คลาสสิก** (today's look, unchanged), **โมเดิร์นมีภาพ** (reference 02: dark band, cover image, product gallery, benefit strip), **พรีเมียมหรูหรา** (reference 03: cream paper, serif type, cover image with tagline, brown table header).
3. Tenants can still pick their own **accent colour** on every template.
4. If a tenant has no images, **our sample images are used as the default** once the tenant confirms using the template.
5. The platform admin does the **final polish before release**: a template is invisible to tenants until the admin publishes it.
6. Quantity and unit are separate columns (done, commit 06843b0e). Signature block has no seal box and has date lines (done, c18a173c).

**Scope decision (owner, 2026-10-10): templates apply to the QUOTATION only.** Invoice, receipt and tax invoice keep the default classic design (leftmost card); there is no tenant choice for them. This removes the invoice/receipt layout work from phases 2-4 and keeps `DocumentPaper` untouched.

Out of scope: invoice/receipt/tax invoice templates, the customer signing page (`src/PublicSignPage.jsx` has its own simple paper), the delivery note, the withholding certificate (statutory form), emails/LINE texts.

## 2. Where templates apply

`QuotationPaper` only (`src/pages/Quotations.jsx`). It already takes `tenant`, calls `resolveDocumentStyle(tenant.document_style)` and renders through `usePaginatedDocument`. PDFs are made by html2canvas of the same element, so a layout that renders correctly on screen is what is printed. `DocumentPaper` (invoice, receipt, tax invoice) is not changed.

## 3. Data model (new migration, applied only after owner review)

### `document_templates` (platform-owned, 3 rows seeded)
| column | type | meaning |
|---|---|---|
| `key` | text PK | `classic`, `modern`, `premium` |
| `layout` | text | which code layout renders it (`classic`/`modern`/`premium`); fixed in code, not editable |
| `name_th`, `description_th` | text | shown to tenants |
| `style` | jsonb | same shape as `document_style` (sizes, spacing, colours); merged over `DEFAULT_DOCUMENT_STYLE` |
| `style_prev` | jsonb | one-step rollback |
| `status` | text | `draft` or `published`; `classic` seeded as `published` |
| `updated_by`, `updated_at` | | audit |

RLS: authenticated users read rows with `status = 'published'`; platform admins (`platform_admins`) read all. No direct write grants; writes go through `platform_save_document_template(key, style, status)` (SECURITY DEFINER, checks `platform_admins`, `REVOKE ALL FROM PUBLIC, anon`, grant to `authenticated` only).

### `document_image_packs` (platform-owned default images)
One row per trade pack: `id`, `name_th`, `hero_path`, `gallery` jsonb (4 × `{path, caption_th}`), `features_th` text[3], `tagline_th`, `status`. Files in public bucket `document-defaults`. Initial 5 packs from the owner's uploaded images (aluminium doors/windows, building construction, road and bridge, interior fit-out, laminate flooring). Same RPC pattern for writes.

### Tenant columns (`tenants`)
- `document_template_key text NULL` (NULL = classic)
- `document_accent text NULL` (hex; NULL = template default)
- `document_content jsonb NULL`: `{ pack_id | null, hero_path | null, gallery: [{path, caption}] (max 4), features: [text] (max 3), tagline, thanks }`
- Existing `document_style` stays. Resolution rule: if `document_template_key` is NULL and `document_style` is not NULL, the tenant keeps its own legacy style on the classic layout (the 1 tenant that saved a style today; shown as card "แบบเดิมของคุณ").

### Tenant images
New public bucket `tenant-doc-images` (public for the same reason as `tenant-logos`: html2canvas loads it directly; images are therefore publicly readable by URL). Policies mirror `tenant_logos_owner_access`: owner writes only inside `<tenant_id>/`. Client resizes to max 1600 px wide, JPEG, max ~400 KB each; 1 hero + 4 gallery per tenant.

## 4. Resolution logic (pure, unit-tested) — `src/lib/documentTemplates.js`

`resolveDocumentTemplate({tenant, templates, packs})` returns `{ layout, style, accent, content, usingDefaultImages }`:
1. No `document_template_key` → classic with the tenant's legacy `document_style` (unchanged behaviour).
2. Key points at a template that is not published (or missing) → classic fallback (never a broken page).
3. Modern/premium need a cover image. Own `hero_path` wins; else the selected pack's hero; else **classic fallback** (owner decision 4 is satisfied because choosing the template in Settings makes the tenant confirm a pack; a tenant with neither image nor pack is never switched).
4. Accent = tenant accent if set else template accent. Tints (light backgrounds) are computed in JS as hex (no `color-mix`, html2canvas does not support it reliably).
5. Empty gallery/features/tagline are simply not rendered (no empty frames).

## 5. Rendering

Classic path stays byte-for-byte the code that exists today (no regression for current tenants). New code:
- `src/components/documentLayouts/ModernBlocks.jsx` and `PremiumBlocks.jsx`: header band/hero, gallery strip, benefit strip, footer (corner/contact) as render functions receiving `{style, accent, content, tenant}`.
- `QuotationPaper` and `DocumentPaper` choose blocks by `layout` and pass them to `usePaginatedDocument` (`renderHeader`, extra `renderAfterHeader` for hero+gallery on page 1 only, `renderFooter` for last page). The measuring pass must include hero/gallery heights; images get fixed heights so pagination does not depend on image load; `remeasureKey` includes the image URLs.
- Premium needs a serif Thai font (Noto Serif Thai). It must be loaded before html2canvas runs, otherwise the PDF falls back silently. Decision needed: self-host the font file in `public/fonts` (no external dependency, recommended) vs Google Fonts.
- Only `QuotationPaper` gets the modern/premium blocks. Invoices, receipts and tax invoices always render the classic design.

## 6. UI

### Tenant (Settings › รูปแบบเอกสาร, OWNER only)
- Cards for published templates only, each a **live thumbnail** rendered by the real components with sample document data plus the tenant's own logo and company name. "ใช้แบบนี้" opens a confirm step showing the chosen template with the default image pack (or own images), then saves.
- Accent colour picker; image section (cover, up to 4 gallery images with captions, 3 benefit lines, tagline, thanks) with "ใช้รูปตัวอย่างชุดนี้" pack picker.
- A tenant's switch applies to all documents when opened again (documents are rendered from live data, not stored as images).

### Platform admin (new section in platform admin area, next to TenantManagement)
- List of 3 templates with status badge, number of tenants using each.
- Editor = today's customizer (sliders, colours, live preview) plus: sample-trade switcher (the 5 packs), preview of quotation and invoice, **Save draft**, **Publish** (confirm dialog shows how many tenants are affected), **Roll back** (one step).
- Image packs: view, replace images/captions, set status.
- Final polish step before release happens here; nothing is visible to tenants until Publish.

## 7. Security and ops
- Every new SECURITY DEFINER function: `REVOKE ALL ... FROM PUBLIC, anon` then grant only what is needed (restore once lost all REVOKEs).
- Admin check inside the function (`platform_admins`), never in the client only; the Settings gate added in c18a173c is UI-only, the new RPCs are the real boundary.
- Public buckets: no private data; image size and type limits in the client and storage policy.
- Migration applied with `npx supabase db query --linked -f`; each release confirmed with the owner.

## 8. Testing
- Vitest: `resolveDocumentTemplate` (all fallbacks, accent tinting), content limits.
- DB: transactional tests ending with `RAISE EXCEPTION 'RESULT ...'`: non-admin cannot write/see drafts, admin can, publish/rollback.
- Harness screenshots (existing `scripts/tax-invoice-harness`) of both layouts × the 5 trades × multi-page document, checked by eye; PDF export test for html2canvas (cross-origin images, serif font).
- Live: platform admin publishes in the real app; a test tenant switches template and opens a real quotation/invoice.

## 9. Phases (each ends in a reviewable state; nothing released until the admin publishes)
1. Migration + RPCs + `documentTemplates.js` + tests (no UI).
2. Modern and premium layouts (draft status, platform admin only).
3. Platform admin section (editor, packs, publish/rollback).
4. Tenant Settings UI (cards, accent, images, confirm).
5. Platform admin polishes and publishes; owner checks real documents.

## 10. Open points for the owner
1. ~~Image packs: licence of the Canva AI images.~~ **Decided (owner, 2026-10-10): use the Canva-generated images as the default sample packs, with a T&C.** At the confirm step ("ใช้แบบนี้") a tenant who picks a default pack must accept a short T&C before saving. Draft points (to be reviewed by the owner, not legal advice): the pictures are AI-generated samples; the platform gives no exclusivity and no guarantee that other tenants or third parties do not use similar images; the tenant is responsible for the final document content and may replace them with its own photos at any time; the platform may change or remove sample packs. Store acceptance (tenant id, pack id, time) in `document_content.pack_terms_accepted_at`. Canva's own terms (checked via web search only, not read in full): AI output may be used commercially, no exclusivity, not for sale as stand-alone merchandise.
2. ~~Premium serif font~~ **Decided: self-host Noto Serif Thai in the app (`public/fonts`).**
3. ~~Do invoices/receipts/tax invoices use the same 3 templates?~~ Decided: no, quotation only; the others stay classic.
4. ~~Limit of 1 cover + 4 gallery images~~ **Decided: enough.**
