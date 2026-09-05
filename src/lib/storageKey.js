// Supabase Storage rejects upload keys containing characters outside its
// safe-key charset with a 400 "InvalidKey" error -- a raw Thai/Unicode
// filename (e.g. "ชั้น2.pdf") in the object path triggers this even though
// the same string is perfectly fine as display text or a DB column value.
// Sanitize only the storage-key copy of a filename; keep the original for
// display (e.g. the DB's file_name column, or a button label).
export function sanitizeStorageFileName(name) {
  return (name || '').replace(/[^a-zA-Z0-9.\-_]/g, '_')
}
