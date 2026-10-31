import { describe, it, expect, vi } from 'vitest'

// A fake html2pdf worker: a thenable chain like the real one (Promise subclass whose
// callbacks are bound to the worker). Guards the one bug that would stop every PDF
// download: `await` on a bare worker returned from an async function unwraps it.
function fakeHtml2pdf(log) {
  const pdf = {
    getNumberOfPages: () => 1, setFont() {}, setPage() {}, setFontSize() {}, getTextWidth: () => 10,
    text: (t, x, y, o) => log.push(['text', t, o?.renderingMode]), addFileToVFS: () => log.push(['vfs']), addFont: () => log.push(['font']),
  }
  class Worker extends Promise {
    constructor(exec) { super(exec); this.prop = { container: null, canvas: { width: 1436 }, pageSize: { inner: { width: 190, height: 277 } }, pdf }; this.opt = { margin: [10, 10, 10, 10], html2canvas: { scale: 2 } } }
    static get [Symbol.species]() { return Promise }
    _step(fn) { const w = this; const p = Promise.prototype.then.call(this, v => fn.call(w, v)); return Worker.convert(p, w) }
    static convert(p, w) { Object.setPrototypeOf(p, Worker.prototype); p.prop = w.prop; p.opt = w.opt; return p }
    set() { return this._step(() => {}) }
    from() { return this._step(() => {}) }
    toContainer() { return this._step(function () { this.prop.container = { getBoundingClientRect: () => ({ left: 0, top: 0, width: 718 }), ownerDocument: null } }) }
    toPdf() { return this._step(() => {}) }
    get(k) { return this._step(function () { return this.prop[k] }) }
    then(f, r) { const w = this; return Worker.convert(Promise.prototype.then.call(this, f && (v => f.call(w, v)), r), w) }
    save() { return this._step(() => log.push(['save'])) }
  }
  return () => Worker.convert(Promise.resolve(), { prop: null, opt: null }) && new Worker(res => res())
}

vi.mock('./pdfTextLayer.js', async (orig) => ({
  ...(await orig()),
  loadTextLayerFont: async () => 'QUJD',
  collectTextLines: () => [{ text: 'ใบเสนอราคา', left: 0, top: 0, right: 100, bottom: 16, fontPx: 14 }],
}))
const { buildPDF, pdfOptions } = await import('./pdf.js')

describe('buildPDF', () => {
  it('resolves to an object holding the worker, so .save() can run after await', async () => {
    const log = []
    const result = await buildPDF(fakeHtml2pdf(log), {}, pdfOptions({ filename: 'x.pdf' }))
    expect(result).toBeTypeOf('object')
    expect(typeof result.worker.save).toBe('function')
    await result.worker.save()
    expect(log.map(l => l[0])).toEqual(['vfs', 'font', 'text', 'save'])
    expect(log.find(l => l[0] === 'text')[2]).toBe('invisible')
  })
})
