// M8: PartPreview markup with addons={[]} is identical to no addons prop (the overview is untouched without add-ons).
import { describe, it, expect } from 'vitest'
import { renderToString } from 'react-dom/server'
import { startModel } from '../../lib/partModel.js'
import PartPreview from './PartPreview.jsx'

const base = { model: startModel('sliding_2'), sel: { key: 'frame_bottom', line: 0 }, partKeys: [], view: 'out', widthMm: 1800, heightMm: 1200,
  widthOf: () => null, buttOf: () => null, canEdit: true, onPick() {}, onToggle() {}, onCell() {} }

describe('PartPreview without add-ons', () => {
  for (const view of ['out', 'in']) {
    it(`addons={[]} renders exactly as no prop (${view})`, () => {
      const plain = renderToString(<PartPreview {...base} view={view} />)
      expect(renderToString(<PartPreview {...base} view={view} addons={[]} addonSel={null} onAddonPick={() => {}} />)).toBe(plain)
      expect(plain).not.toContain('data-addon')
    })
  }
})
