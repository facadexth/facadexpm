// Which site label an assign-grid cell shows. Desktop keeps the full name (or site number);
// phone shows the short name. The central site (is_default) always shows its own name.
import { siteShortName } from '../../lib/siteShortName.js'

export function siteCellLabel({ isPhone, siteName, siteNumber, shortName, isDefault }) {
  const full = siteName || siteNumber || '—'
  if (!isPhone) return full
  if (isDefault) return siteName || full
  return siteShortName({ name: siteName, short_name: shortName }) || full
}
