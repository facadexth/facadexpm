// Labels for a series. The full form is used where a default is picked,
// the short form inside a row where the owner is already clear.
export function seriesLabelFull(series, provider) {
  return provider?.name ? `${series.name} · ${provider.name}` : series.name
}

export function seriesLabelShort(series, provider) {
  return provider?.short_name ? `${series.name} (${provider.short_name})` : series.name
}
