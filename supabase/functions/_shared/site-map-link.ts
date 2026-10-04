// _shared/site-map-link.ts -- the Google Maps link to show under a site in schedule messages.
// Uses the link saved on the site; falls back to its coordinates. Only http(s) links are
// passed on, so odd text typed into the field is never sent to a chat as a "link".
export type SiteMapFields = { map_url?: string | null; lat?: number | string | null; lng?: number | string | null }

export function siteMapLink(site: SiteMapFields | null | undefined): string | null {
  const url = (site?.map_url ?? '').trim()
  if (/^https?:\/\/\S+$/i.test(url)) return url
  const lat = Number(site?.lat)
  const lng = Number(site?.lng)
  if (site?.lat == null || site?.lng == null || !Number.isFinite(lat) || !Number.isFinite(lng)) return null
  return `https://www.google.com/maps?q=${lat},${lng}`
}
