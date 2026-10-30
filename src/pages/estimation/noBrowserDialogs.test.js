// Guard: the cut-sheet screens show errors inline (InlineError), never with the browser's alert() / confirm().
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const FILES = ['CutModeField.jsx', 'CustomLengthSummary.jsx', 'BomProfilesTable.jsx', 'CutOptimizerPanel.jsx', 'StickerSheet.jsx', 'OffcutStockPanel.jsx']
const source = f => readFileSync(fileURLToPath(new URL(`./${f}`, import.meta.url)), 'utf8')

describe('no browser dialogs in the cut-sheet screens', () => {
  for (const f of FILES) it(f, () => { expect(source(f)).not.toMatch(/\b(alert|confirm)\(/) })
})
