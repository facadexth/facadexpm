// @vitest-environment jsdom
// Owner 2026-11-12: "ทำสำเนา QT2610-022 รายการไม่มา" — the add form restores its localStorage draft OVER `initial`, so
// an earlier unsaved add / duplicate (here QT2611-015's content) replaced the quotation being copied.
import { describe, it, expect, afterEach } from 'vitest'
import { renderHook, cleanup } from '@testing-library/react'
import { readFileSync } from 'node:fs'
import { useDraftForm, saveDraft, clearDraft, readDraft } from '../hooks/useDraftForm.js'

afterEach(() => { cleanup(); localStorage.clear() })

const KEY = 'quotation-form'
const copyOf022 = { site_name: 'พิพิธภัณฑ์ คลอง 5', items: [{ description: 'AD1 ห้องเอนกประสงค์' }] }
const stale015 = { site_name: 'กรุงเทพกรีฑา 8', items: [{ description: 'ประตูบานเฟี้ยม' }] }

describe('quotation duplicate vs the add-form draft', () => {
  it('the bug: a leftover draft wins over the copied quotation', () => {
    saveDraft(KEY, stale015)
    const { result } = renderHook(() => useDraftForm(KEY, copyOf022, true))
    expect(result.current[0].site_name).toBe('กรุงเทพกรีฑา 8')
  })
  it('the fix: clearing the draft before opening the copy shows the copied quotation', () => {
    saveDraft(KEY, stale015)
    clearDraft(KEY)
    const { result } = renderHook(() => useDraftForm(KEY, copyOf022, true))
    expect(result.current[0].site_name).toBe('พิพิธภัณฑ์ คลอง 5')
    expect(result.current[0].items[0].description).toBe('AD1 ห้องเอนกประสงค์')
    expect(readDraft(KEY).site_name).toBe('พิพิธภัณฑ์ คลอง 5')
  })
  it('Quotations.jsx clears the draft on ทำสำเนา and on ยกเลิก / ← กลับ of an add', () => {
    const src = readFileSync('src/pages/Quotations.jsx', 'utf8')
    const dup = src.slice(src.indexOf('const handleDuplicate'), src.indexOf('const handleDuplicate') + 200)
    expect(dup).toMatch(/clearDraft\(QUOTATION_DRAFT_KEY\)/)
    expect(src).toMatch(/const closeForm = \(\) => \{ if \(!editRow\) clearDraft\(QUOTATION_DRAFT_KEY\)/)
    expect(src).toMatch(/onCancel=\{closeForm\}/)
    expect(src).toMatch(/onClick=\{closeForm\}>← กลับ/)
    expect(src).toMatch(/useDraftForm\(QUOTATION_DRAFT_KEY,/)
  })
})
