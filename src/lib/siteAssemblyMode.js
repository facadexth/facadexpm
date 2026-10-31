// sites.assembly_mode (2026-10-21): per-site override of the tenant's "where does the crew's
// day start". '' in the form = ตามบริษัท = NULL in the table.
export const ASSEMBLY_MODE_OPTIONS = [
  { value: '', label: 'ตามบริษัท' },
  { value: 'none', label: 'ไปไซท์เลย' },
  { value: 'assembly', label: 'รวมพลที่บริษัท/โรงงานก่อน' },
]

// The payload part for sites insert/update. A form that never loaded the value (undefined)
// writes nothing, so an existing override is never cleared by accident.
export function assemblyModeField(form) {
  if (form?.assembly_mode === undefined) return {}
  return { assembly_mode: form.assembly_mode === 'none' || form.assembly_mode === 'assembly' ? form.assembly_mode : null }
}
