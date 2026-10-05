// Remove a block of `len` rows starting at `start`. If that block is the whole
// list, return a single fresh blank row instead (so the editor is never empty).
// Never mutates `rows`.
export function removeBlockOrClear(rows, start, len, makeEmpty) {
  if (rows.length <= len) return [makeEmpty()]
  return [...rows.slice(0, start), ...rows.slice(start + len)]
}
