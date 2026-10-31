import { describe, it, expect } from 'vitest'
import { pdfOptions } from './pdf.js'

describe('pdfOptions page size', () => {
  it('defaults to A4 portrait and accepts A5 landscape', () => {
    expect(pdfOptions().jsPDF).toMatchObject({ format: 'a4', orientation: 'portrait' })
    expect(pdfOptions({ format: 'a5', orientation: 'landscape' }).jsPDF).toMatchObject({ format: 'a5', orientation: 'landscape' })
  })
})
