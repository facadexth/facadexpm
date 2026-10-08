// src/lib/catalogData.js
// Reads every row of a catalog table. PostgREST caps one response at 1000
// rows and price history only grows, so page through with a stable order.
import { fetchAllRows } from './fetchAllRows.js'

export function fetchCatalogRows(client, table, orderBy = 'name', ascending = true) {
  return fetchAllRows(() => client.from(table).select('*').order(orderBy, { ascending }).order('id'))
}
