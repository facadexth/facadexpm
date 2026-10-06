let pending = null
export const setCreditNotePrefill = p => { pending = p }
export const takeCreditNotePrefill = () => { const p = pending; pending = null; return p }
