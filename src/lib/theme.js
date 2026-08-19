// ============================================================
// Theme helpers -- shared between the header toggle button and any
// component (e.g. the Dashboard chart) that needs to know the current
// effective theme to pick literal colors recharts can't read from CSS.
// ============================================================

export function getEffectiveTheme() {
  const explicit = document.documentElement.getAttribute('data-theme')
  if (explicit === 'light' || explicit === 'dark') return explicit
  return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
}

export function toggleTheme() {
  const next = getEffectiveTheme() === 'dark' ? 'light' : 'dark'
  document.documentElement.setAttribute('data-theme', next)
  localStorage.setItem('theme', next)
  return next
}
